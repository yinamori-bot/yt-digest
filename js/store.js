// All data lives only in this browser (localStorage). Nothing is sent anywhere except the API calls.
const P = 'ytd:';

export function load(name, def) {
  try { const v = localStorage.getItem(P + name); return v ? JSON.parse(v) : def; } catch { return def; }
}
export function save(name, val) {
  try { localStorage.setItem(P + name, JSON.stringify(val)); return true; }
  catch (e) { console.warn('save failed', e); return false; }
}

export const DEFAULT_SETTINGS = {
  geminiKey: '',
  ytKey: '',          // empty = use geminiKey
  clientId: '',       // optional OAuth client ID for importing subscriptions
  model: 'gemini-3.8-flash',
  days: 3,            // look back this many days for new uploads
  perChannel: 5,      // newest N uploads per channel
  skipShorts: true,   // skip videos of 3 minutes or less
  fps: 0.2,           // frames per second sent to Gemini (lower = cheaper)
  rate: 1.1,
  voiceURI: '',
  knownLimit: 600,    // newest N known facts sent with each request
};

export function exportAll() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith(P)) out[k.slice(P.length)] = JSON.parse(localStorage.getItem(k));
  }
  delete out.settings; // never put API keys into a backup file
  return out;
}
export function importAll(obj) {
  for (const [k, v] of Object.entries(obj)) if (k !== 'settings') save(k, v);
}
