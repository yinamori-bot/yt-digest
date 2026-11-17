// Player. Each item is played from a saved audio file (made with Gemini TTS) when one exists —
// that plays like music: it works in silent mode and keeps going with the screen off.
// Otherwise it falls back to the iPhone's built-in voice (muted in silent mode).
// iOS stops long utterances midway, so built-in speech is split into sentences and spoken one by one.
const synth = window.speechSynthesis;
let queue = [];       // [{ label, chunks: [string], audio?: () => Promise<Blob|null>, onDone }]
let current = null;   // { item, index, mode: 'speech' | 'audio' }
let paused = false;
let opts = { rate: 1.1, voiceURI: '' };
let listener = () => {};
let problem = () => {};
let keep = null; // iOS: an utterance with no reference can be garbage-collected, and its onend never fires
let started = false, watchdog;

export const supported = !!synth;
export function onChange(fn) { listener = fn; }
/** Called with a message when playback does not start (silent mode, blocked, etc.). */
export function onProblem(fn) { problem = fn; }
export function configure(o) { Object.assign(opts, o); }

export function jaVoices() {
  if (!synth) return [];
  return synth.getVoices().filter(v => /^ja/i.test(v.lang));
}
if (synth) synth.addEventListener?.('voiceschanged', () => listener(state()));

// ---- audio element (one, reused: iOS lets it keep playing in the background) ----
const el = new Audio();
el.setAttribute('playsinline', '');
el.preservesPitch = true;
let elUrl = '';
let silentUrl = '';
function silentWavUrl() {
  if (silentUrl) return silentUrl;
  const rate = 8000, n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return (silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
}
/** Call inside a tap before any await: lets later el.play() calls work without a tap. */
export function unlock() {
  if (current?.mode === 'audio') return;
  try { el.src = silentWavUrl(); el.play().catch(() => {}); } catch {}
}

export function clean(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[#*_`>|~\[\]]/g, '')
    .replace(/^\s*[-・•]\s*/gm, '')
    .replace(/\s+\n/g, '\n').trim();
}

function split(text) {
  const out = [];
  for (const s of clean(text).split(/(?<=[。！？!?\n])/)) {
    const t = s.trim(); if (!t) continue;
    for (let i = 0; i < t.length; i += 180) out.push(t.slice(i, i + 180));
  }
  return out;
}

export function state() {
  return { speaking: !!current, paused, label: current?.item.label || '', left: queue.length, mode: current?.mode || '' };
}

/** play([{label, text, audio, onDone}], {append}) */
export function play(items, { append = false } = {}) {
  const mapped = items.map(i => ({ label: i.label, chunks: split(i.text), audio: i.audio, onDone: i.onDone }))
    .filter(i => i.chunks.length || i.audio);
  if (append && current) { queue.push(...mapped); listener(state()); return; }
  const wasSpeaking = synth && (synth.speaking || synth.pending);
  stop(false);
  unlock(); // inside the tap
  queue = mapped;
  if (!queue.length) { listener(state()); return; }
  started = false;
  // After cancel(), give iOS a moment before speaking again.
  if (wasSpeaking) setTimeout(next, 150); else next();
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (!started && current?.mode === 'speech') problem('読み上げが始まりません。iPhoneの声は消音モード（マナーモード）では鳴りません。消音モードをオフにするか、設定で「音声ファイルを作る」をオンにしてください。');
  }, 3500);
}

async function next() {
  const item = queue.shift();
  if (!item) { current = null; paused = false; setMediaSession(null); listener(state()); return; }
  const cur = { item, index: 0, mode: 'speech' };
  current = cur;
  let blob = null;
  if (item.audio) { try { blob = await item.audio(); } catch {} }
  if (current !== cur) return; // stopped meanwhile
  if (blob) { cur.mode = 'audio'; playAudio(cur, blob); }
  else if (!item.chunks.length || !synth) { item.onDone?.(); next(); }
  else { listener(state()); speakChunk(); }
}

function playAudio(cur, blob) {
  if (elUrl) URL.revokeObjectURL(elUrl);
  elUrl = URL.createObjectURL(blob);
  el.src = elUrl;
  el.playbackRate = opts.rate;
  el.onended = () => { if (current !== cur) return; cur.item.onDone?.(); next(); };
  el.onerror = () => { if (current !== cur) return; cur.mode = 'speech'; listener(state()); speakChunk(); };
  setMediaSession(cur.item.label);
  listener(state());
  el.play().then(() => { started = true; }).catch(() => {
    if (current !== cur) return;
    problem('音声を再生できませんでした。もう一度ボタンを押してください。');
    stop();
  });
}

function speakChunk() {
  const cur = current; if (!cur) return;
  if (cur.index >= cur.item.chunks.length) { cur.item.onDone?.(); next(); return; }
  const u = new SpeechSynthesisUtterance(cur.item.chunks[cur.index]);
  u.lang = 'ja-JP'; u.rate = opts.rate;
  const v = synth.getVoices().find(v => v.voiceURI === opts.voiceURI);
  if (v) u.voice = v;
  u.onstart = () => { started = true; };
  u.onend = () => { if (current !== cur) return; cur.index++; speakChunk(); };
  u.onerror = e => {
    if (current !== cur || e.error === 'interrupted' || e.error === 'canceled') return;
    if (e.error === 'not-allowed') { problem('読み上げが許可されませんでした。もう一度ボタンを押してください。'); stop(); return; }
    cur.index++; speakChunk();
  };
  keep = u;
  if (synth.paused) synth.resume(); // iOS can get stuck in a paused state
  synth.speak(u);
}

// Lock screen / Control Center controls while an audio file plays.
function setMediaSession(title) {
  const ms = navigator.mediaSession; if (!ms) return;
  try {
    ms.metadata = title ? new MediaMetadata({ title, artist: 'YouTube新着ダイジェスト' }) : null;
    ms.setActionHandler('play', () => { if (paused) togglePause(); });
    ms.setActionHandler('pause', () => { if (!paused) togglePause(); });
    ms.setActionHandler('nexttrack', () => skip());
    ms.setActionHandler('stop', () => stop());
  } catch {}
}

export function togglePause() {
  if (!current) return;
  if (current.mode === 'audio') { paused ? el.play().catch(() => {}) : el.pause(); }
  else if (paused) synth.resume(); else synth.pause();
  paused = !paused;
  listener(state());
}
export function skip() {
  if (!current) return;
  const wasSpeech = current.mode === 'speech';
  current = null; paused = false;
  el.pause();
  if (wasSpeech && synth) { synth.cancel(); setTimeout(next, 150); } else next();
}
export function stop(notify = true) {
  queue = []; current = null; paused = false;
  el.pause();
  // iOS: cancel() right before speak() can make the next speak() silently do nothing, so cancel only when needed.
  if (synth && (synth.speaking || synth.pending)) synth.cancel();
  if (notify) { setMediaSession(null); listener(state()); }
}
