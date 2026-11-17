// Generated speech clips, kept on the iPhone (IndexedDB) so listening needs no data connection.
// Keys: "<videoId>:sum" (summary), "<videoId>:t<n>" (topic detail), "<videoId>:d<id>" (deep-dive answer).
const DB = 'ytd-audio', STORE = 'clips';
let dbp;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function run(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}

// Stored as {type, buf} (ArrayBuffer) rather than Blob: more reliable in iOS IndexedDB.
export async function putBuffer(key, type, buf) { await run('readwrite', s => s.put({ type, buf }, key)); }
export async function get(key) {
  const v = await run('readonly', s => s.get(key)).catch(() => null);
  return v ? new Blob([v.buf], { type: v.type }) : null;
}
export const keys = () => run('readonly', s => s.getAllKeys()).catch(() => []);
export async function removeVideo(videoId) {
  const ks = (await keys()).filter(k => String(k).startsWith(videoId + ':'));
  if (ks.length) await run('readwrite', s => { ks.forEach(k => s.delete(k)); });
  return ks;
}
export async function removeKeys(ks) { if (ks.length) await run('readwrite', s => { ks.forEach(k => s.delete(k)); }); }
export const clear = () => run('readwrite', s => s.clear());
export async function totalBytes() {
  const all = await run('readonly', s => s.getAll()).catch(() => []);
  return all.reduce((n, v) => n + (v?.buf?.byteLength || 0), 0);
}

/**
 * Gemini returns raw 16-bit PCM (base64, usually 24 kHz). Speech sounds fine at 16 kHz,
 * so resample to 16 kHz to make the stored file a third smaller, and wrap it as WAV.
 */
export function pcmToWav(chunksBase64, mime) {
  const rateIn = +(/rate=(\d+)/.exec(mime || '')?.[1] || 24000);
  const parts = chunksBase64.map(b64 => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  });
  const gap = new Int16Array(Math.round(rateIn * 0.4)); // short pause between joined parts
  const total = parts.reduce((n, p) => n + p.length, 0) + gap.length * (parts.length - 1);
  const src = new Int16Array(total); let o = 0;
  parts.forEach((p, i) => { if (i) { src.set(gap, o); o += gap.length; } src.set(p, o); o += p.length; });

  const rateOut = rateIn > 16000 ? 16000 : rateIn;
  const ratio = rateIn / rateOut, n = Math.floor(src.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    out[i] = (src[i0] * (1 - f) + (src[i0 + 1] ?? src[i0]) * f) | 0;
  }
  const buf = new ArrayBuffer(44 + out.byteLength), v = new DataView(buf);
  const str = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + out.byteLength, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rateOut, true); v.setUint32(28, rateOut * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, out.byteLength, true);
  new Int16Array(buf, 44).set(out);
  return { type: 'audio/wav', buf, seconds: n / rateOut };
}
