// YouTube Data API v3 (free quota: 10,000 units/day; this app uses ~1 unit per channel per check).
const API = 'https://www.googleapis.com/youtube/v3/';

async function yt(path, params, { key, token } = {}) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  if (!token) u.searchParams.set('key', key);
  const r = await fetch(u, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const raw = j.error?.message || String(r.status);
    const hint = /API keys are not supported|API_KEY_SERVICE_BLOCKED|blocked|not been used|disabled|API key not valid|PERMISSION_DENIED/i.test(raw) && !token
      ? (/not been used|disabled/i.test(raw)
        ? 'このキーのプロジェクトで「YouTube Data API v3」が有効になっていません。Google Cloudで有効にしてください。'
        : 'このAPIキーはYouTubeでは使えません。Google Cloudの「認証情報」でYouTube用のAPIキーを作り、設定の「YouTube Data APIキー」に入れてください。')
      : '';
    const e = new Error(hint ? `${hint}（${raw.slice(0, 80)}）` : 'YouTube API: ' + raw);
    e.status = r.status; throw e;
  }
  return j;
}

const thumb = sn => sn?.thumbnails?.default?.url || sn?.thumbnails?.medium?.url || '';

/** Subscriptions of the signed-in user (OAuth token). */
export async function mySubscriptions(token) {
  const out = []; let pageToken;
  do {
    const j = await yt('subscriptions', { part: 'snippet', mine: 'true', maxResults: 50, pageToken, order: 'alphabetical' }, { token });
    for (const it of j.items || []) out.push({ id: it.snippet.resourceId.channelId, title: it.snippet.title, thumb: thumb(it.snippet) });
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

/** Public subscriptions of any channel (works without sign-in if the user's subscriptions are public). */
export async function publicSubscriptions(channelId, key) {
  const out = []; let pageToken;
  do {
    const j = await yt('subscriptions', { part: 'snippet', channelId, maxResults: 50, pageToken }, { key });
    for (const it of j.items || []) out.push({ id: it.snippet.resourceId.channelId, title: it.snippet.title, thumb: thumb(it.snippet) });
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

/** Accepts a channel URL, @handle, channel ID (UC...) or a search word. */
export async function resolveChannel(input, key) {
  const s = input.trim();
  const id = s.match(/(UC[\w-]{22})/)?.[1];
  const handle = s.match(/@([^\s/?#]+)/)?.[1];
  let j;
  if (id) j = await yt('channels', { part: 'snippet', id }, { key });
  else if (handle) j = await yt('channels', { part: 'snippet', forHandle: '@' + decodeURIComponent(handle) }, { key });
  else {
    const sr = await yt('search', { part: 'snippet', type: 'channel', q: s, maxResults: 1 }, { key }); // 100 units
    const cid = sr.items?.[0]?.snippet?.channelId;
    if (!cid) return null;
    j = await yt('channels', { part: 'snippet', id: cid }, { key });
  }
  const c = j.items?.[0];
  return c ? { id: c.id, title: c.snippet.title, thumb: thumb(c.snippet) } : null;
}

/** Titles and icons for channel IDs (e.g. from a Google Takeout CSV). */
export async function channelInfo(ids, key) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await yt('channels', { part: 'snippet', id: ids.slice(i, i + 50).join(','), maxResults: 50 }, { key });
    for (const c of j.items || []) out.push({ id: c.id, title: c.snippet.title, thumb: thumb(c.snippet) });
  }
  return out;
}

/** Newest uploads of a channel. The uploads playlist ID is "UU" + channel ID without "UC". */
export async function latestUploads(channelId, max, key) {
  const j = await yt('playlistItems', { part: 'snippet,contentDetails', playlistId: 'UU' + channelId.slice(2), maxResults: max }, { key });
  return (j.items || []).map(it => ({
    id: it.contentDetails.videoId,
    title: it.snippet.title,
    publishedAt: it.contentDetails.videoPublishedAt || it.snippet.publishedAt,
    thumb: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || '',
  }));
}

/** Duration (seconds) and live status for video IDs. */
export async function videoDetails(ids, key) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const j = await yt('videos', { part: 'contentDetails,snippet', id: ids.slice(i, i + 50).join(',') }, { key });
    for (const v of j.items || []) out[v.id] = {
      seconds: isoSeconds(v.contentDetails.duration),
      live: v.snippet.liveBroadcastContent, // 'none' | 'live' | 'upcoming'
      channelId: v.snippet.channelId, channelTitle: v.snippet.channelTitle,
      title: v.snippet.title, publishedAt: v.snippet.publishedAt,
      thumb: v.snippet.thumbnails?.medium?.url || '',
    };
  }
  return out;
}

export function isoSeconds(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

export function videoIdFromUrl(s) {
  return s.match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/)?.[1] || (/^[\w-]{11}$/.test(s.trim()) ? s.trim() : null);
}

/** Google Takeout "subscriptions.csv" → [{id, title}] (header names differ by language, so match the UC... ID). */
export function parseTakeoutCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/(UC[\w-]{22})/)?.[1];
    if (!id) continue;
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push({ id, title: cells[cells.length - 1].trim() || id, thumb: '' });
  }
  return rows;
}

// ---- Google sign-in (optional; only for importing your subscriptions) ----
let gisLoading;
function loadGis() {
  gisLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error('Googleログインを読み込めませんでした'));
    document.head.appendChild(s);
  });
  return gisLoading;
}
export function preloadSignIn() { loadGis().catch(() => {}); }
export async function signIn(clientId) {
  await loadGis();
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      callback: r => r.error ? rej(new Error(r.error_description || r.error)) : res(r.access_token),
      error_callback: e => rej(new Error(e.message || e.type || 'ログインできませんでした')),
    });
    client.requestAccessToken();
  });
}
