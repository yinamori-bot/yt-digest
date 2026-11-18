// Gemini API (free tier from Google AI Studio). Gemini can watch a public YouTube URL directly,
// so no transcript download is needed.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/';

// Busy servers (503 "high demand" etc.) and short per-minute limits are retried automatically.
const WAITS = globalThis.__ytdWaits || [15, 30, 60]; // seconds (overridable for tests)
let onWait = () => {};
export function onRetryWait(fn) { onWait = fn; }
const sleep = s => new Promise(r => setTimeout(r, s * 1000));

async function call(opts) {
  for (let attempt = 0; ; attempt++) {
    try { return await callOnce(opts); }
    catch (e) {
      const busy = [500, 502, 503, 504].includes(e.status) || /high demand|overloaded|unavailable|try again later/i.test(e.raw || '');
      const network = e.name === 'TypeError'; // connection dropped
      const quotaDelay = e.status === 429 ? e.retryDelay : 0; // per-minute limit: Google says how long to wait
      let wait = 0;
      const waits = opts.isFallback ? WAITS.slice(0, 1) : WAITS; // fallback model: one retry only
      if ((busy || network) && attempt < waits.length) wait = waits[attempt];
      else if (quotaDelay && quotaDelay <= 90 && attempt < 2) wait = quotaDelay + 2;
      if (!wait) {
        if (busy) throw Object.assign(new Error('Geminiが混雑していて要約できませんでした。数分〜数十分おいてから、もう一度「要約する」を押してください。'), { status: e.status, raw: e.raw, busy: true });
        throw e;
      }
      onWait({ seconds: wait, attempt: attempt + 1, reason: (quotaDelay && !busy ? '無料枠の1分あたりの上限' : 'Geminiが混雑中') + (opts.isFallback ? `（${opts.model}）` : '') });
      await sleep(wait);
    }
  }
}

async function callOnce({ key, model, contents, system, schema, lowCost = true }) {
  const generationConfig = { temperature: 0.4 };
  if (schema) Object.assign(generationConfig, { responseMimeType: 'application/json', responseSchema: schema });
  if (lowCost) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  const body = { contents, generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const r = await fetch(`${BASE}models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || String(r.status);
    const e = new Error(r.status === 429
      ? '無料枠の回数・量の上限に達しました。少し（または翌日まで）待ってから再実行してください。' + `（${msg.slice(0, 120)}）`
      : 'Gemini: ' + msg);
    e.status = r.status; e.raw = msg;
    const delay = (j.error?.details || []).find(d => d.retryDelay)?.retryDelay; // e.g. "37s"
    if (delay) e.retryDelay = parseFloat(delay) || 0;
    throw e;
  }
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).filter(p => !p.thought && p.text).map(p => p.text).join('');
  if (!text) throw new Error('Geminiから回答がありませんでした（' + (cand?.finishReason || j.promptFeedback?.blockReason || '不明') + '）');
  return text;
}

/** Retries once without the cost-saving options if the model rejects them. */
async function callMedia(opts, videoPart) {
  try { return await call(opts); }
  catch (e) {
    if (e.status !== 400 || !/media|resolution|fps|video_?metadata/i.test(e.raw || '')) throw e;
    if (videoPart) delete videoPart.videoMetadata;
    return call({ ...opts, lowCost: false });
  }
}

// Google retires models over time. When the error names a replacement model, switch to it and retry.
let onSwitch = () => {};
export function onModelSwitch(fn) { onSwitch = fn; }
async function callSafe(opts, videoPart) {
  try { return await callMedia(opts, videoPart); }
  catch (e) {
    const raw = e.raw || '';
    if (e.busy && !opts.isFallback) {
      // Still busy after waiting: try another flash model once (each model has its own capacity).
      const alt = await pickAlternative(opts.key, opts.model).catch(() => null);
      if (!alt) throw e;
      onWait({ seconds: 0, attempt: 0, reason: '', fallback: alt });
      try { return await callMedia({ ...opts, model: alt, isFallback: true }, videoPart); }
      catch { throw e; }
    }
    const retired = /no longer available|deprecated|retired|is not found|not supported for generateContent/i.test(raw);
    if (!retired) throw e;
    const next = (raw.match(/models\/(gemini[\w.\-]*)/g) || []).map(m => m.slice(7)).find(m => m !== opts.model);
    if (!next) throw new Error(`モデル「${opts.model}」は使えなくなりました。設定の「モデル」の「一覧」から新しいモデル（名前にflashが入ったもの）を選んで保存してください。`);
    onSwitch(next);
    return callMedia({ ...opts, model: next }, videoPart);
  }
}

const videoPart = (videoId, fps) => ({
  fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` },
  ...(fps ? { videoMetadata: { fps } } : {}),
});

const SYSTEM = `あなたは、ユーザーが音声で聞くためのYouTube動画ダイジェストを作るアシスタントです。
出力は日本語。読み上げられるので、記号・箇条書き記号・マークダウン・絵文字・URLは使わず、自然な話し言葉に近い文章にします。
数字・固有名詞・具体例は正確に残します。推測で内容を補いません。`;

const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    overview: { type: 'STRING', description: '動画全体の要約。新しい情報を中心に2〜4文。新情報が無ければその旨を1文で' },
    topics: {
      type: 'ARRAY',
      description: '動画の新しい情報を、内容の方向ごとに3〜5個の話題に分けたもの。動画の流れの順',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: '話題の見出し（10〜20字）' },
          summary: { type: 'STRING', description: 'その話題の要約（2〜3文、読み上げ用）' },
          detail: { type: 'STRING', description: 'その話題の詳しい解説（400〜700字、読み上げ用）。理由・具体例・数字・話し手の意見を含める' },
          time: { type: 'STRING', description: '動画内で話題が始まる位置 例 12:34' },
        },
        required: ['title', 'summary', 'detail'],
      },
    },
    skipped: { type: 'ARRAY', description: '既知リストと重複したため省いた内容（各15字程度）', items: { type: 'STRING' } },
    facts: { type: 'ARRAY', description: '今回の新しい情報を、後で重複判定に使う短い1文ずつに（固有名詞・数字を含める）', items: { type: 'STRING' } },
    notes: { type: 'STRING', description: '後で深掘りに使う、動画全体の詳しいノート。章ごとにタイムスタンプ付き。既知の内容も含めて4000字程度まで' },
  },
  required: ['overview', 'topics', 'skipped', 'facts', 'notes'],
};

/** Older saved summaries used {headline, points}; convert them to {overview, topics}. */
export function normalize(s) {
  if (!s) return s;
  if (!s.topics) s.topics = (s.points || []).map(p => ({ title: p.title, summary: p.text, detail: '', time: p.time }));
  if (s.overview == null) s.overview = s.headline || '';
  s.skipped ||= []; s.facts ||= []; s.notes ||= '';
  return s;
}

function knownBlock(known) {
  if (!known.length) return '（まだありません）';
  return known.map(k => '・' + k).join('\n');
}

/** Summarise only what is new compared with the known facts. */
export async function summarize({ key, model, fps, video, known }) {
  const vp = videoPart(video.id, fps);
  const prompt = `動画「${video.title}」（チャンネル：${video.channelTitle || '不明'}）を要約してください。

【ユーザーがすでに知っていること（既知リスト）】
${knownBlock(known)}

【ルール】
・扱うのは「新しい情報」と「この動画ならではの視点・意見・具体例」だけ。
・既知リストと同じ内容は入れず、skipped に短く書く。既知の話題でも新しい数字・事実・切り口があれば、その新しい部分だけを書く。
・あいさつ、自己紹介、チャンネル登録のお願い、スポンサー紹介、雑談は無視する。
・overview は動画全体の要約。
・topics は、新しい情報を内容の方向（論点・テーマ）ごとに3〜5個に分ける。話題同士は重ならないようにする。新しい情報が少ない短い動画なら1〜2個でもよく、新しい情報が無ければ空の配列にする。
・各話題の summary は要点だけ、detail はその話題を詳しく知りたい人向けの解説にする。summary と同じ文を detail で繰り返さない。
・notes には、後で質問に答えられるよう動画全体を詳しく記録する（これは読み上げない）。`;
  const text = await callSafe({ key, model, system: SYSTEM, schema: SUMMARY_SCHEMA, contents: [{ role: 'user', parts: [vp, { text: prompt }] }] }, vp);
  return normalize(JSON.parse(text));
}

/** Detailed explanation of one point or a free question. withVideo = re-watch the video (slower, more tokens). */
export async function explain({ key, model, fps, video, summary, history, question, withVideo }) {
  const ctx = `動画「${video.title}」（チャンネル：${video.channelTitle || '不明'}）について、ユーザーが詳しく知りたがっています。

【要約】
${summary.overview}
${summary.topics.map((t, i) => `話題${i + 1}. ${t.title}：${t.summary}`).join('\n')}

【動画の詳細ノート】
${summary.notes || '（なし）'}

${history.length ? '【これまでの深掘り】\n' + history.map(h => `質問：${h.q}\n回答：${h.a}`).join('\n\n') + '\n\n' : ''}【今回知りたいこと】
${question}

【回答のしかた】
・${withVideo ? '動画そのものを確認して' : '詳細ノートをもとに'}、500〜900字で詳しく解説する。話の流れ・理由・具体例・数字を中心に。
・これまでの深掘りと同じ説明は繰り返さない。
・動画で触れられていない部分を一般知識で補うときは「動画では触れられていませんが」と前置きする。
・読み上げ用の文章で書く（箇条書き・記号なし）。`;
  const parts = withVideo ? [videoPart(video.id, fps), { text: ctx }] : [{ text: ctx }];
  return (await callSafe({ key, model, system: SYSTEM, contents: [{ role: 'user', parts }], lowCost: withVideo }, withVideo ? parts[0] : null)).trim();
}

/** Another stable flash model, newest first; full flash before flash-lite. */
async function pickAlternative(key, current) {
  const ver = m => parseFloat((m.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const list = (await listModels(key))
    .filter(m => /flash/.test(m) && m !== current && !/preview|exp|thinking|latest/.test(m))
    .sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || ver(b) - ver(a));
  return list[0] || null;
}

/** Models usable with generateContent (to pick a newer free model). */
export async function listModels(key) {
  const r = await fetch(`${BASE}models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const j = await r.json();
  if (!r.ok) throw new Error('Gemini: ' + (j.error?.message || r.status));
  return (j.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name) && !/embedding|tts|image|live|audio/.test(m.name))
    .map(m => m.name.replace(/^models\//, ''));
}
