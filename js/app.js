import * as store from './store.js';
import * as YT from './youtube.js';
import * as AI from './gemini.js';
import * as TTS from './speech.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let settings = { ...store.DEFAULT_SETTINGS, ...store.load('settings', {}) };
let channels = store.load('channels', []);   // [{id, title, thumb, selected}]
let videos = store.load('videos', {});       // {videoId: {...}}
let known = store.load('known', []);         // [{id, text, src, at}]
let deleted = store.load('deleted', {});     // {videoId: deletedAt} so deleted videos are not fetched again

const saveChannels = () => store.save('channels', channels);
const saveVideos = () => { if (!store.save('videos', videos)) toast('保存できませんでした（容量不足）。古い動画を削除してください'); };
const saveKnown = () => store.save('known', known);
const saveDeleted = () => store.save('deleted', deleted);

const ytKey = () => settings.ytKey || settings.geminiKey;
const working = new Set();   // video IDs being summarised / explained right now
let busy = false;            // a batch is running
let stopBatch = false;

function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
const progress = msg => { $('#progress').textContent = msg || ''; };
const fmtDur = s => s ? (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}分`) : '';
const fmtDate = iso => { if (!iso) return ''; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ---- tabs ---------------------------------------------------------------
function showView(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== `view-${name}`; });
  if (name === 'channels') renderChannels();
  if (name === 'known') renderKnown();
  if (name === 'feed') renderFeed();
  try { localStorage.setItem('ytd-view', name); } catch {}
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ---- channels -------------------------------------------------------------
function addChannels(list, selected) {
  let added = 0;
  for (const c of list) {
    const cur = channels.find(x => x.id === c.id);
    if (cur) { if (c.thumb) cur.thumb = c.thumb; if (c.title && c.title !== c.id) cur.title = c.title; continue; }
    channels.push({ id: c.id, title: c.title, thumb: c.thumb || '', selected });
    added++;
  }
  channels.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  saveChannels(); renderChannels(); renderChannelFilter();
  return added;
}

function renderChannels() {
  const q = $('#ch-q').value.trim().toLowerCase();
  const list = channels.filter(c => !q || c.title.toLowerCase().includes(q));
  const sel = channels.filter(c => c.selected).length;
  $('#ch-count').textContent = `${sel} / ${channels.length} 件を要約対象に選択中`;
  $('#channels').innerHTML = list.map(c => `
    <li class="ch ${c.selected ? 'on' : ''}" data-id="${esc(c.id)}">
      <label class="ch-main">
        <input type="checkbox" data-act="ch-toggle" ${c.selected ? 'checked' : ''}>
        ${c.thumb ? `<img src="${esc(c.thumb)}" alt="" loading="lazy">` : '<span class="noimg"></span>'}
        <span class="ch-title">${esc(c.title)}</span>
      </label>
      <button class="icon" data-act="ch-del" aria-label="削除">✕</button>
    </li>`).join('') || '<li class="muted empty">チャンネルがありません。上から追加してください。</li>';
}

$('#channels').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  const c = channels.find(x => x.id === li.dataset.id); if (!c) return;
  const act = e.target.dataset.act;
  if (act === 'ch-toggle') { c.selected = e.target.checked; li.classList.toggle('on', c.selected); }
  else if (act === 'ch-del') { if (!confirm(`「${c.title}」を一覧から外しますか？`)) return; channels = channels.filter(x => x !== c); }
  else return;
  saveChannels(); renderChannelFilter();
  if (act === 'ch-del') renderChannels();
  else $('#ch-count').textContent = `${channels.filter(c => c.selected).length} / ${channels.length} 件を要約対象に選択中`;
});
$('#ch-q').addEventListener('input', renderChannels);
function selectAll(v) {
  const q = $('#ch-q').value.trim().toLowerCase();
  channels.forEach(c => { if (!q || c.title.toLowerCase().includes(q)) c.selected = v; });
  saveChannels(); renderChannels(); renderChannelFilter();
}
$('#btn-ch-all').addEventListener('click', () => selectAll(true));
$('#btn-ch-none').addEventListener('click', () => selectAll(false));

function needKey(kind = 'gemini') {
  if (kind === 'yt' ? ytKey() : settings.geminiKey) return false;
  toast('先に「設定」でAPIキーを入れてください'); showView('settings'); return true;
}

$('#btn-ch-add').addEventListener('click', async () => {
  const v = $('#ch-input').value.trim(); if (!v || needKey('yt')) return;
  try {
    const c = await YT.resolveChannel(v, ytKey());
    if (!c) return toast('チャンネルが見つかりませんでした');
    addChannels([c], true); $('#ch-input').value = ''; toast(`「${c.title}」を追加しました`);
  } catch (e) { toast(e.message, 5000); }
});
$('#ch-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-ch-add').click(); });

function afterImport(list) {
  const n = addChannels(list, false);
  toast(`${list.length} 件中 ${n} 件を追加しました。要約したいチャンネルにチェックを入れてください`, 5000);
}
$('#btn-signin').addEventListener('click', async () => {
  if (!settings.clientId) { toast('設定にOAuthクライアントIDを入れてください（READMEを参照）', 4000); return; }
  try { afterImport(await YT.mySubscriptions(await YT.signIn(settings.clientId))); }
  catch (e) { toast(e.message, 5000); }
});
$('#takeout-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  let list = YT.parseTakeoutCsv(await f.text());
  if (!list.length) return toast('CSVにチャンネルが見つかりませんでした');
  if (ytKey()) { try { const info = await YT.channelInfo(list.map(c => c.id), ytKey()); const m = new Map(info.map(c => [c.id, c])); list = list.map(c => m.get(c.id) || c); } catch {} }
  afterImport(list);
});
$('#btn-public-subs').addEventListener('click', async () => {
  const v = $('#my-channel').value.trim(); if (!v || needKey('yt')) return;
  try {
    const me = await YT.resolveChannel(v, ytKey());
    if (!me) return toast('チャンネルが見つかりませんでした');
    afterImport(await YT.publicSubscriptions(me.id, ytKey()));
  } catch (e) {
    toast(e.status === 403 ? '登録チャンネルが非公開のため読めません。YouTubeの設定で公開にするか、別の方法を使ってください' : e.message, 6000);
  }
});

// ---- new uploads -----------------------------------------------------------
function renderChannelFilter() {
  const cur = $('#f-channel').value;
  const opts = channels.filter(c => c.selected).map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
  $('#f-channel').innerHTML = `<option value="">選択中のチャンネルすべて</option>${opts}<option value="_manual">URLで追加した動画</option>`;
  $('#f-channel').value = [...$('#f-channel').options].some(o => o.value === cur) ? cur : '';
}

async function checkNew() {
  if (needKey('yt')) return 0;
  const sel = channels.filter(c => c.selected);
  if (!sel.length) { toast('「チャンネル」で要約したいチャンネルを選んでください'); showView('channels'); return 0; }
  const since = Date.now() - settings.days * 86400e3;
  const found = []; let failed = 0, done = 0;
  for (let i = 0; i < sel.length; i += 6) {
    await Promise.all(sel.slice(i, i + 6).map(async c => {
      try {
        const ups = await YT.latestUploads(c.id, settings.perChannel, ytKey());
        for (const u of ups) if (new Date(u.publishedAt) >= since && !videos[u.id] && !deleted[u.id]) found.push({ ...u, channelId: c.id, channelTitle: c.title });
      } catch (e) { if (e.status === 403) throw e; failed++; }
      progress(`新着を確認中… ${++done} / ${sel.length}`);
    }));
  }
  let added = 0;
  if (found.length) {
    const det = await YT.videoDetails(found.map(v => v.id), ytKey());
    for (const v of found) {
      const d = det[v.id];
      if (!d || d.live !== 'none') continue; // live / upcoming: pick up later when it becomes a normal video
      const short = settings.skipShorts && d.seconds <= 180;
      videos[v.id] = { ...v, seconds: d.seconds, status: short ? 'skipped' : 'new', reason: short ? 'ショート' : '', added: Date.now(), deep: [] };
      if (!short) added++;
    }
  }
  prune(); saveVideos();
  progress(`新着 ${added} 件${failed ? `（${failed} チャンネルは読めませんでした）` : ''}`);
  renderFeed();
  return added;
}

/** Keep storage small: drop skipped / unsummarised entries older than 60 days, keep at most 400 videos. */
function prune() {
  const old = Date.now() - 60 * 86400e3;
  let list = Object.values(videos).filter(v => v.status === 'done' || new Date(v.publishedAt) > old);
  list.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  list = list.slice(0, 400);
  videos = Object.fromEntries(list.map(v => [v.id, v]));
  for (const [id, t] of Object.entries(deleted)) if (t < old) delete deleted[id];
  saveDeleted();
}

// ---- summarise -----------------------------------------------------------
function knownTexts() { return known.slice(-settings.knownLimit).map(k => k.text); }

async function summarizeOne(id) {
  const v = videos[id]; if (!v || working.has(id)) return;
  working.add(id); renderCard(id);
  try {
    const s = await AI.summarize({ key: settings.geminiKey, model: settings.model, fps: +settings.fps, video: v, known: knownTexts() });
    v.summary = s; v.status = 'done'; v.heard = false; v.error = ''; v.deep = v.deep || [];
    const at = Date.now();
    for (const t of s.facts) if (t && t.trim()) known.push({ id: uid(), text: t.trim(), src: id, at });
    saveKnown();
  } catch (e) {
    v.status = 'error'; v.error = e.message;
    throw e;
  } finally {
    working.delete(id); saveVideos(); renderCard(id);
  }
}

async function summarizeMany(ids) {
  if (busy) { stopBatch = true; return toast('止めています…'); }
  if (needKey()) return;
  if (!ids.length) { progress('要約する動画はありません'); return; }
  busy = true; stopBatch = false; setBusyUI();
  let ok = 0;
  try {
    for (const [i, id] of ids.entries()) {
      if (stopBatch) break;
      progress(`要約中… ${i + 1} / ${ids.length}「${videos[id]?.title || ''}」`);
      try { await summarizeOne(id); ok++; }
      catch (e) { if (e.status === 429 || e.status === 400 && /API key/i.test(e.message)) { toast(e.message, 7000); break; } }
    }
  } finally {
    busy = false; setBusyUI();
    renderFeed(); // re-enable the buttons that were disabled while the batch ran
    progress(`${ok} 件を要約しました${stopBatch ? '（途中で止めました）' : ''}`);
  }
}
function setBusyUI() {
  $('#btn-sum-all').textContent = busy ? '要約を止める' : '未要約をすべて要約';
  $('#btn-check').disabled = busy;
  updateWakeLock();
}

const pendingIds = () => visibleVideos(true).filter(v => v.status === 'new' || v.status === 'error').map(v => v.id).reverse(); // oldest first

async function checkAndSummarize() {
  try { await checkNew(); await summarizeMany(pendingIds()); }
  catch (e) { toast(e.message, 6000); progress(''); }
}
$('#btn-check').addEventListener('click', checkAndSummarize);

// ---- scheduled runs (only while the app is open and visible) ----
const pad2 = n => String(n).padStart(2, '0');
const schedTimes = () => [settings.sched1, settings.sched2, settings.sched3].filter(t => /^\d{1,2}:\d{2}$/.test(t || ''));
function slotAt(t, dayOffset) {
  const [h, m] = t.split(':').map(Number);
  const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d;
}
function lastDueSlot(now = new Date()) {
  let best = null;
  for (const t of schedTimes()) for (const off of [0, -1]) { const d = slotAt(t, off); if (d <= now && (!best || d > best)) best = d; }
  return best;
}
function nextSlot(now = new Date()) {
  let best = null;
  for (const t of schedTimes()) for (const off of [0, 1]) { const d = slotAt(t, off); if (d > now && (!best || d < best)) best = d; }
  return best;
}
let lastAutoRun = store.load('lastAutoRun', 0);
function renderSchedInfo() {
  const n = nextSlot(), el = $('#sched-info');
  el.hidden = !n;
  if (n) el.textContent = `⏰ 次の予約：${n.toDateString() === new Date().toDateString() ? '今日' : '明日'} ${n.getHours()}:${pad2(n.getMinutes())}（アプリを開いたまま、画面をつけておいてください）`;
}
async function checkSchedule() {
  renderSchedInfo();
  if (busy || document.hidden || !settings.geminiKey) return;
  const due = lastDueSlot();
  if (!due || due.getTime() <= lastAutoRun) return;
  lastAutoRun = Date.now(); store.save('lastAutoRun', lastAutoRun);
  showView('feed');
  toast('予約の時刻になったので、新着の要約を始めます', 4000);
  await checkAndSummarize();
  renderSchedInfo();
}

// Screen Wake Lock: keep the screen on while waiting for a schedule or summarising.
let wakeLock = null;
async function updateWakeLock() {
  const want = !document.hidden && settings.keepAwake && (busy || schedTimes().length > 0);
  try {
    if (want && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { updateWakeLock(); if (!document.hidden) checkSchedule(); });
setInterval(checkSchedule, 20000);
$('#btn-check-only').addEventListener('click', async () => { try { await checkNew(); } catch (e) { toast(e.message, 6000); progress(''); } });
$('#btn-sum-all').addEventListener('click', () => summarizeMany(pendingIds()));
$('#btn-manual').addEventListener('click', async () => {
  const id = YT.videoIdFromUrl($('#manual-url').value);
  if (!id) return toast('YouTubeのURLを入れてください');
  if (needKey('yt')) return;
  try {
    if (deleted[id]) { delete deleted[id]; saveDeleted(); }
    if (!videos[id]) {
      const d = (await YT.videoDetails([id], ytKey()))[id];
      if (!d) return toast('動画が見つかりませんでした');
      videos[id] = { id, title: d.title, channelId: d.channelId, channelTitle: d.channelTitle, publishedAt: d.publishedAt, thumb: d.thumb, seconds: d.seconds, status: 'new', manual: true, added: Date.now(), deep: [] };
      saveVideos();
    }
    $('#manual-url').value = '';
    $('#f-status').value = 'all'; renderFeed();
    await summarizeMany([id]);
  } catch (e) { toast(e.message, 6000); }
});

// ---- feed rendering ----------------------------------------------------------
function visibleVideos(anyStatus = false) {
  const ch = $('#f-channel').value, st = anyStatus ? 'any' : $('#f-status').value;
  const sel = new Set(channels.filter(c => c.selected).map(c => c.id));
  return Object.values(videos)
    .filter(v => ch === '_manual' ? v.manual : ch ? v.channelId === ch : (v.manual || sel.has(v.channelId)))
    .filter(v => st === 'skipped' ? v.status === 'skipped'
      : st === 'unheard' ? v.status !== 'skipped' && !v.heard
      : st === 'heard' ? v.heard
      : st === 'any' || v.status !== 'skipped')
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

// ---- grouping by posting day ----
const pad = n => String(n).padStart(2, '0');
const dayKey = iso => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function dayLabel(key) {
  const d = new Date(key + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400e3);
  const base = `${d.getMonth() + 1}月${d.getDate()}日（${'日月火水木金土'[d.getDay()]}）`;
  return diff === 0 ? `今日 ${base}` : diff === 1 ? `昨日 ${base}` : base;
}
function groupByDay(list) {
  const m = new Map();
  for (const v of list) { const k = dayKey(v.publishedAt); if (!m.has(k)) m.set(k, []); m.get(k).push(v); }
  return m; // insertion order = newest day first (list is sorted newest first)
}
/** All videos of a day in the current channel scope, whatever their status. */
const dayVideos = key => visibleVideos(true).filter(v => dayKey(v.publishedAt) === key);
function dayCounts(key) {
  const vs = visibleVideos().filter(v => dayKey(v.publishedAt) === key);
  const unheard = vs.filter(v => v.status === 'done' && !v.heard).length;
  const pending = vs.filter(v => v.status === 'new' || v.status === 'error').length;
  return `${vs.length}本` + (unheard ? `・未聴${unheard}` : '') + (pending ? `・未要約${pending}` : '');
}
const dayOpen = new Map(); // day key → open?

function renderFeed() {
  $('#setup-hint').hidden = !!(settings.geminiKey && channels.some(c => c.selected));
  const groups = groupByDay(visibleVideos());
  $('#videos').innerHTML = [...groups].map(([key, vs]) => {
    const open = dayOpen.has(key) ? dayOpen.get(key) : vs.some(v => !v.heard);
    return `
    <section class="day" data-day="${key}">
      <details class="day-box" ${open ? 'open' : ''}>
        <summary class="day-head"><b>${dayLabel(key)}</b> <span class="day-count muted small">${dayCounts(key)}</span></summary>
        <div class="row-btns day-btns">
          <button class="small primary" data-act="day-play">▶ この日をまとめて聞く</button>
          <button class="small" data-act="day-sum">この日を要約</button>
          <button class="small danger" data-act="day-del">この日を削除</button>
        </div>
        ${vs.map(cardHtml).join('')}
      </details>
    </section>`;
  }).join('') || '<p class="muted empty">表示する動画はありません。「新着を要約」を押してください。</p>';
}
function renderCard(id) {
  const el = document.querySelector(`.video[data-id="${CSS.escape(id)}"]`);
  if (el && videos[id]) el.outerHTML = cardHtml(videos[id]);
  const day = videos[id] && dayKey(videos[id].publishedAt);
  const c = day && document.querySelector(`.day[data-day="${day}"] .day-count`);
  if (c) c.textContent = dayCounts(day);
}

function playVideos(list, intro) {
  TTS.play([
    { label: '案内', text: intro },
    ...list.map(v => ({ label: v.title, text: videoSpeech(v), onDone: () => markHeard(v.id) })),
  ]);
}
function dayAction(act, key) {
  const vs = dayVideos(key).filter(v => v.status !== 'skipped');
  const label = dayLabel(key).replace(/^(今日|昨日) /, '');
  if (act === 'day-play') {
    const done = vs.filter(v => v.status === 'done').reverse(); // oldest first
    if (!done.length) return toast('この日の要約はまだありません');
    const unheard = done.filter(v => !v.heard);
    const list = unheard.length ? unheard : done;
    playVideos(list, `${label}に投稿された動画、${list.length}本の要約です。`);
  } else if (act === 'day-sum') {
    const ids = vs.filter(v => v.status === 'new' || v.status === 'error').map(v => v.id).reverse();
    if (!ids.length) return toast('この日に未要約の動画はありません');
    summarizeMany(ids);
  } else if (act === 'day-del') {
    const all = dayVideos(key).filter(v => !working.has(v.id));
    if (!all.length) return;
    if (!confirm(`${label}の動画 ${all.length} 本の要約を削除しますか？\n（「既知」の記録は残るので、同じ内容は今後も省かれます）`)) return;
    const now = Date.now();
    for (const v of all) { deleted[v.id] = now; delete videos[v.id]; openState.delete(v.id); }
    dayOpen.delete(key);
    saveVideos(); saveDeleted(); renderFeed();
    toast(`${label}の要約を削除しました`);
  }
}

const openState = new Map(); // video id → details open?
const detailOpen = new Set(); // "videoId:topicIndex" whose detailed text is shown
function cardHtml(v) {
  const s = v.summary, w = working.has(v.id);
  const badge = w ? '<span class="badge busy">処理中…</span>'
    : v.status === 'done' ? (v.heard ? '<span class="badge">聞いた</span>' : '<span class="badge new">未聴</span>')
    : v.status === 'error' ? '<span class="badge err">エラー</span>'
    : v.status === 'skipped' ? `<span class="badge">スキップ${v.reason ? '・' + esc(v.reason) : ''}</span>`
    : '<span class="badge">未要約</span>';
  const open = openState.has(v.id) ? openState.get(v.id) : !v.heard;
  let body = '';
  if (s) {
    AI.normalize(s);
    const tps = s.topics.map((t, i) => `
      <li class="topic">
        <div class="pt-head"><b>${esc(t.title)}</b>${t.time ? ` <a class="time" href="https://www.youtube.com/watch?v=${esc(v.id)}&t=${tsec(t.time)}" target="_blank" rel="noopener">${esc(t.time)}</a>` : ''}</div>
        <p>${esc(t.summary)}</p>
        <div class="row-btns">
          <button class="small" data-act="read-topic" data-i="${i}">▶ 聞く</button>
          <button class="small primary-ghost" data-act="detail" data-i="${i}" ${!t.detail && w ? 'disabled' : ''}>▶ 詳しく聞く</button>
        </div>
        ${t.detail ? `<details class="topic-detail" data-i="${i}" ${detailOpen.has(v.id + ':' + i) ? 'open' : ''}><summary>詳しい内容</summary>
          <p>${esc(t.detail).replace(/\n/g, '<br>')}</p>
          <div class="row-btns"><button class="small" data-act="deeper-topic" data-i="${i}" ${w ? 'disabled' : ''}>さらに詳しく</button></div>
        </details>` : ''}
        ${deepHtml(v, i, w)}
      </li>`).join('');
    body = `
      <div class="overview"><div class="muted small">全体の要約</div><p>${esc(s.overview)}</p></div>
      ${s.topics.length ? `<div class="muted small">話題（${s.topics.length}）</div><ol class="topics">${tps}</ol>` : '<p class="muted">新しい情報はありませんでした。</p>'}
      ${s.skipped.length ? `<details class="skipped"><summary>既知のため省いた内容 ${s.skipped.length} 件</summary><ul>${s.skipped.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}
      ${deepHtml(v, -1, w)}
      <div class="ask row"><input placeholder="この動画について質問（音声入力も可）" data-ask><button class="small" data-act="ask" ${w ? 'disabled' : ''}>質問</button></div>`;
  } else if (v.status === 'error') {
    body = `<p class="error">${esc(v.error)}</p>`;
  }
  return `
  <article class="video card ${v.heard ? 'heard' : ''}" data-id="${esc(v.id)}">
    <div class="v-head">
      ${v.thumb ? `<img src="${esc(v.thumb)}" alt="" loading="lazy">` : ''}
      <div class="v-meta">
        <div class="v-title">${esc(v.title)}</div>
        <div class="muted small">${esc(v.channelTitle)} · ${fmtDate(v.publishedAt)}${v.seconds ? ' · ' + fmtDur(v.seconds) : ''} ${badge}</div>
      </div>
    </div>
    <div class="row-btns">
      ${s ? `<button class="primary small" data-act="read">▶ 要約を聞く</button>` : `<button class="primary small" data-act="sum" ${w || busy ? 'disabled' : ''}>要約する</button>`}
      ${v.status === 'skipped' ? '<button class="small" data-act="unskip">戻す</button>' : s ? `<button class="small" data-act="heard">${v.heard ? '未聴に戻す' : '聞いた'}</button>` : '<button class="small" data-act="skip">スキップ</button>'}
      ${s ? `<button class="small" data-act="resum" ${w ? 'disabled' : ''}>再要約</button>` : ''}
      <a class="button small" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">YouTube</a>
    </div>
    ${body ? `<details class="v-body" ${open ? 'open' : ''}><summary>要約</summary>${body}</details>` : ''}
  </article>`;
}
function deepHtml(v, i, w) {
  const items = (v.deep || []).filter(d => d.pi === i);
  if (!items.length) return '';
  return `<div class="deep">${items.map(d => `
    <div class="deep-item" data-did="${esc(d.id)}">
      <div class="muted small">${i < 0 ? 'Q：' + esc(d.q) : esc(d.label || '詳しく')}${d.withVideo ? '（動画で確認）' : ''}</div>
      <p>${esc(d.a).replace(/\n/g, '<br>')}</p>
      <div class="row-btns">
        <button class="small" data-act="read-deep">▶ 聞く</button>
        <button class="small" data-act="deeper" ${w ? 'disabled' : ''}>さらに詳しく</button>
        ${d.withVideo ? '' : `<button class="small" data-act="deep-video" ${w ? 'disabled' : ''}>動画で確認</button>`}
      </div>
    </div>`).join('')}</div>`;
}
const tsec = t => String(t).split(':').reduce((a, b) => a * 60 + (+b || 0), 0);

function videoSpeech(v) {
  const s = AI.normalize(v.summary);
  let t = `${v.channelTitle}の動画、${v.title}。\n`;
  if (!s.topics.length) return t + (s.overview ? s.overview + '\n' : '新しい情報はありませんでした。') + (s.skipped.length ? `すでに知っている内容が${s.skipped.length}件ありました。` : '');
  t += `全体の要約です。${s.overview}\n話題は${s.topics.length}つです。\n`;
  s.topics.forEach((p, i) => { t += `${i + 1}つ目、${p.title}。${p.summary}\n`; });
  return t;
}
function markHeard(id) {
  const v = videos[id]; if (!v || v.heard) return;
  v.heard = true;
  if (!openState.has(id)) openState.set(id, true); // keep it open so "詳しく聞く" stays at hand
  saveVideos(); renderCard(id);
}

async function deepDive(v, { pi, q, label, withVideo }) {
  if (needKey() || working.has(v.id)) return;
  working.add(v.id); renderCard(v.id);
  try {
    const t = pi >= 0 ? AI.normalize(v.summary).topics[pi] : null;
    const history = [
      ...(t?.detail ? [{ q: `「${t.title}」を詳しく`, a: t.detail }] : []),
      ...(v.deep || []).filter(d => d.pi === pi),
    ];
    const a = await AI.explain({ key: settings.geminiKey, model: settings.model, fps: +settings.fps, video: v, summary: v.summary, history, question: q, withVideo });
    const d = { id: uid(), pi, q, label, a, withVideo: !!withVideo, at: Date.now() };
    (v.deep ||= []).push(d); saveVideos();
    TTS.play([{ label: `${label || '回答'}：${v.title}`, text: a }]);
  } catch (e) { toast(e.message, 6000); }
  finally { working.delete(v.id); openState.set(v.id, true); renderCard(v.id); }
}

$('#videos').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  if (btn.dataset.act.startsWith('day-')) return dayAction(btn.dataset.act, btn.closest('.day').dataset.day);
  const card = btn.closest('.video'); const v = videos[card?.dataset.id]; if (!v) return;
  const act = btn.dataset.act, i = +btn.dataset.i;
  const p = v.summary ? AI.normalize(v.summary).topics[i] : null;
  const d = (v.deep || []).find(x => x.id === btn.closest('.deep-item')?.dataset.did);
  switch (act) {
    case 'sum': case 'resum': summarizeMany([v.id]); break;
    case 'skip': v.status = 'skipped'; v.reason = ''; saveVideos(); renderFeed(); break;
    case 'unskip': v.status = v.summary ? 'done' : 'new'; saveVideos(); renderFeed(); break;
    case 'heard': v.heard = !v.heard; openState.delete(v.id); saveVideos(); renderCard(v.id); break;
    case 'read': TTS.play([{ label: v.title, text: videoSpeech(v), onDone: () => markHeard(v.id) }]); break;
    case 'read-topic': TTS.play([{ label: p.title, text: `${p.title}。${p.summary}` }]); break;
    case 'detail':
      if (p.detail) {
        detailOpen.add(v.id + ':' + i);
        card.querySelector(`.topic-detail[data-i="${i}"]`)?.setAttribute('open', '');
        TTS.play([{ label: `詳しく：${p.title}`, text: `${p.title}について、詳しく説明します。\n${p.detail}` }]);
      } else deepDive(v, { pi: i, label: `「${p.title}」を詳しく`, q: `「${p.title}」について、もっと詳しく知りたい。要約では「${p.summary}」と説明されている。` });
      break;
    case 'deeper-topic': deepDive(v, { pi: i, label: 'さらに詳しく', q: `「${p.title}」について、すでに説明した内容よりさらに掘り下げて、詳しく説明してほしい。` }); break;
    case 'read-deep': TTS.play([{ label: d.label || d.q, text: d.a }]); break;
    case 'deeper': deepDive(v, { pi: d.pi, label: 'さらに詳しく', q: `直前の説明「${d.a.slice(0, 200)}…」の内容を、さらに掘り下げて詳しく説明してほしい。` }); break;
    case 'deep-video': deepDive(v, { pi: d.pi, label: (d.label || '回答') + '（動画で確認）', q: d.q, withVideo: true }); break;
    case 'ask': {
      const inp = card.querySelector('[data-ask]'); const q = inp.value.trim();
      if (!q) return inp.focus();
      deepDive(v, { pi: -1, label: '質問', q });
      break;
    }
  }
});
$('#videos').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('[data-ask]') && !e.isComposing) e.target.closest('.ask').querySelector('button').click();
});
$('#videos').addEventListener('toggle', e => {
  const card = e.target.closest?.('.video'); if (card && e.target.matches('.v-body')) openState.set(card.dataset.id, e.target.open);
  if (e.target.matches?.('.topic-detail') && card) {
    const k = card.dataset.id + ':' + e.target.dataset.i;
    e.target.open ? detailOpen.add(k) : detailOpen.delete(k);
  }
  if (e.target.matches?.('.day-box')) dayOpen.set(e.target.closest('.day').dataset.day, e.target.open);
}, true);
$('#f-channel').addEventListener('change', renderFeed);
$('#f-status').addEventListener('change', renderFeed);

$('#btn-play-all').addEventListener('click', () => {
  const list = visibleVideos().filter(v => v.status === 'done' && !v.heard).reverse(); // oldest first
  if (!list.length) return toast('未聴の要約はありません');
  playVideos(list, `未聴の要約が${list.length}件あります。`);
});

// ---- player bar ---------------------------------------------------------------
TTS.onProblem(msg => toast(msg, 7000));
TTS.onChange(st => {
  $('#player').hidden = !st.speaking;
  $('#player-label').textContent = st.label + (st.left ? `（あと${st.left}件）` : '');
  $('#pl-pause').textContent = st.paused ? '▶' : '⏸';
  document.body.classList.toggle('playing', st.speaking);
  if (!$('#view-settings').hidden) fillVoices();
});
$('#pl-pause').addEventListener('click', TTS.togglePause);
$('#pl-skip').addEventListener('click', TTS.skip);
$('#pl-stop').addEventListener('click', () => TTS.stop());

// ---- known facts -----------------------------------------------------------------
let knownShown = 200;
function renderKnown() {
  const q = $('#known-q').value.trim().toLowerCase();
  const list = known.filter(k => !q || k.text.toLowerCase().includes(q)).reverse();
  $('#known-count').textContent = `${known.length} 件`;
  $('#known').innerHTML = list.slice(0, knownShown).map(k => `
    <li class="known-item" data-id="${esc(k.id)}">
      <div><div>${esc(k.text)}</div><div class="muted small">${esc(videos[k.src]?.title || (k.src ? '' : '手動で追加'))}</div></div>
      <button class="icon" data-act="k-del" aria-label="削除">✕</button>
    </li>`).join('') + (list.length > knownShown ? `<li><button data-act="k-more">もっと見る（残り ${list.length - knownShown} 件）</button></li>` : '')
    || '<li class="muted empty">まだありません。</li>';
}
$('#known').addEventListener('click', e => {
  const act = e.target.dataset.act;
  if (act === 'k-more') { knownShown += 200; renderKnown(); }
  if (act === 'k-del') { const id = e.target.closest('li').dataset.id; known = known.filter(k => k.id !== id); saveKnown(); renderKnown(); }
});
$('#known-q').addEventListener('input', () => { knownShown = 200; renderKnown(); });
$('#btn-known-add').addEventListener('click', () => {
  const t = $('#known-input').value.trim(); if (!t) return;
  known.push({ id: uid(), text: t, src: '', at: Date.now() }); saveKnown();
  $('#known-input').value = ''; renderKnown();
});
$('#known-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) $('#btn-known-add').click(); });

// ---- settings ------------------------------------------------------------------
const form = $('#settings');
function fillSettings() {
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name]; else el.value = settings[el.name];
  }
  $('#rate-val').textContent = settings.rate + '倍';
  fillVoices();
}
function fillVoices() {
  const vs = TTS.jaVoices();
  const sel = $('#voice'); const cur = sel.value || settings.voiceURI;
  sel.innerHTML = '<option value="">標準</option>' + vs.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)}${v.localService ? '' : '（オンライン）'}</option>`).join('');
  sel.value = vs.some(v => v.voiceURI === cur) ? cur : '';
}
form.rate.addEventListener('input', () => { $('#rate-val').textContent = form.rate.value + '倍'; });
form.addEventListener('submit', e => {
  e.preventDefault();
  const n = (name, min, max) => Math.min(max, Math.max(min, +form[name].value || store.DEFAULT_SETTINGS[name]));
  const oldSched = schedTimes().join();
  Object.assign(settings, {
    geminiKey: form.geminiKey.value.trim(), ytKey: form.ytKey.value.trim(), clientId: form.clientId.value.trim(),
    model: form.model.value.trim() || store.DEFAULT_SETTINGS.model,
    days: n('days', 1, 30), perChannel: n('perChannel', 1, 20), skipShorts: form.skipShorts.checked,
    fps: +form.fps.value, knownLimit: n('knownLimit', 50, 5000), rate: +form.rate.value, voiceURI: form.voiceURI.value,
    sched1: form.sched1.value, sched2: form.sched2.value, sched3: form.sched3.value, keepAwake: form.keepAwake.checked,
    ignoreSilent: form.ignoreSilent.checked,
  });
  // New schedule: start counting from now, so a time that already passed today does not fire at once.
  if (schedTimes().join() !== oldSched) { lastAutoRun = Date.now(); store.save('lastAutoRun', lastAutoRun); }
  renderSchedInfo(); updateWakeLock();
  store.save('settings', settings); TTS.configure(settings);
  if (settings.clientId) YT.preloadSignIn();
  fillSettings(); toast('保存しました');
});
$('#btn-voice-test').addEventListener('click', () => {
  TTS.configure({ rate: +form.rate.value, voiceURI: form.voiceURI.value, ignoreSilent: form.ignoreSilent.checked });
  TTS.play([{ label: 'テスト', text: 'この速さと声で、動画の要約を読み上げます。' }]);
});
$('#btn-models').addEventListener('click', async () => {
  const key = form.geminiKey.value.trim(); if (!key) return toast('先にGemini APIキーを入れてください');
  try {
    const ms = await AI.listModels(key);
    $('#models').innerHTML = ms.map(m => `<option value="${esc(m)}">`).join('');
    toast(`使えるモデル：${ms.filter(m => /flash/.test(m)).slice(0, 6).join('、') || ms.slice(0, 6).join('、')}`, 7000);
    form.model.focus();
  } catch (e) { toast(e.message, 5000); }
});

$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(store.exportAll())], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `yt-digest-data-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('#import-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try {
    const obj = JSON.parse(await f.text());
    if (!confirm('今のデータ（チャンネル・要約・既知）を、バックアップの内容で置き換えますか？')) return;
    store.importAll(obj);
    channels = store.load('channels', []); videos = store.load('videos', {}); known = store.load('known', []);
    renderChannelFilter(); renderFeed(); toast('復元しました');
  } catch { toast('読み込めませんでした'); }
});

AI.onRetryWait(({ seconds, attempt, reason, fallback }) => {
  if (fallback) return progress(`混雑が続いているため、別のモデル（${fallback}）で試しています…`);
  progress(`${reason}のため、${seconds}秒待ってから自動で再試行します（${attempt}回目）…`);
});
AI.onModelSwitch(m => {
  settings.model = m; store.save('settings', settings);
  form.model.value = m;
  toast(`使っていたモデルが終了したため、「${m}」に切り替えました`, 5000);
});

// ---- start ----------------------------------------------------------------------
TTS.configure(settings);
fillSettings();
renderChannelFilter();
let startView = 'feed';
try { startView = localStorage.getItem('ytd-view') || 'feed'; } catch {}
showView(settings.geminiKey ? startView : 'settings');
if (settings.clientId) YT.preloadSignIn();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
updateWakeLock();
checkSchedule(); // a time that passed while the app was closed runs now
