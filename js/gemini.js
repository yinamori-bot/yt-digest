// Gemini API (free tier from Google AI Studio). Gemini can watch a public YouTube URL directly,
// so no transcript download is needed.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/';

async function call({ key, model, contents, system, schema, lowCost = true }) {
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
    e.status = r.status; e.raw = msg; throw e;
  }
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).filter(p => !p.thought && p.text).map(p => p.text).join('');
  if (!text) throw new Error('Geminiから回答がありませんでした（' + (cand?.finishReason || j.promptFeedback?.blockReason || '不明') + '）');
  return text;
}

/** Retries once without the cost-saving options if the model rejects them. */
async function callSafe(opts, videoPart) {
  try { return await call(opts); }
  catch (e) {
    if (e.status !== 400 || !/media|resolution|fps|video_?metadata/i.test(e.raw || '')) throw e;
    if (videoPart) delete videoPart.videoMetadata;
    return call({ ...opts, lowCost: false });
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
    headline: { type: 'STRING', description: 'この動画で新しく分かることを一文で。新情報が無ければその旨' },
    points: {
      type: 'ARRAY',
      description: 'ユーザーにとって新しい情報・独自の視点だけ。重要な順',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: '10〜20字の見出し' },
          text: { type: 'STRING', description: '1〜3文の説明（読み上げ用）' },
          time: { type: 'STRING', description: '動画内の位置 例 12:34' },
        },
        required: ['title', 'text'],
      },
    },
    skipped: { type: 'ARRAY', description: '既知リストと重複したため省いた内容（各15字程度）', items: { type: 'STRING' } },
    facts: { type: 'ARRAY', description: '今回の新しい情報を、後で重複判定に使う短い1文ずつに（固有名詞・数字を含める）', items: { type: 'STRING' } },
    notes: { type: 'STRING', description: '後で深掘りに使う、動画全体の詳しいノート。章ごとにタイムスタンプ付き。既知の内容も含めて4000字程度まで' },
  },
  required: ['headline', 'points', 'skipped', 'facts', 'notes'],
};

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
・動画の中から「新しい情報」と「この動画ならではの視点・意見・具体例」だけを points に入れる。
・既知リストと同じ内容は points に入れず、skipped に短く書く。既知の話題でも新しい数字・事実・切り口があれば、その新しい部分だけを書く。
・あいさつ、自己紹介、チャンネル登録のお願い、スポンサー紹介、雑談は無視する。
・points は多くても8つ。新しい情報が無ければ空の配列にする。
・notes には、後で質問に答えられるよう動画全体を詳しく記録する（これは読み上げない）。`;
  const text = await callSafe({ key, model, system: SYSTEM, schema: SUMMARY_SCHEMA, contents: [{ role: 'user', parts: [vp, { text: prompt }] }] }, vp);
  const out = JSON.parse(text);
  out.points ||= []; out.skipped ||= []; out.facts ||= []; out.notes ||= '';
  return out;
}

/** Detailed explanation of one point or a free question. withVideo = re-watch the video (slower, more tokens). */
export async function explain({ key, model, fps, video, summary, history, question, withVideo }) {
  const ctx = `動画「${video.title}」（チャンネル：${video.channelTitle || '不明'}）について、ユーザーが詳しく知りたがっています。

【要約】
${summary.headline}
${summary.points.map((p, i) => `${i + 1}. ${p.title}：${p.text}`).join('\n')}

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

/** Models usable with generateContent (to pick a newer free model). */
export async function listModels(key) {
  const r = await fetch(`${BASE}models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const j = await r.json();
  if (!r.ok) throw new Error('Gemini: ' + (j.error?.message || r.status));
  return (j.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name) && !/embedding|tts|image|live|audio/.test(m.name))
    .map(m => m.name.replace(/^models\//, ''));
}
