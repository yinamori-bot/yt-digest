// Text-to-speech with the iPhone's built-in voices (free, offline).
// iOS stops long utterances midway, so text is split into sentences and spoken one by one.
const synth = window.speechSynthesis;
let queue = [];       // [{ label, chunks: [string], onDone }]
let current = null;   // { item, index }
let paused = false;
let opts = { rate: 1.1, voiceURI: '' };
let listener = () => {};

export const supported = !!synth;
export function onChange(fn) { listener = fn; }
export function configure(o) { Object.assign(opts, o); }

export function jaVoices() {
  if (!synth) return [];
  return synth.getVoices().filter(v => /^ja/i.test(v.lang));
}
if (synth) synth.addEventListener?.('voiceschanged', () => listener(state()));

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
  return { speaking: !!current, paused, label: current?.item.label || '', left: queue.length };
}

/** play([{label, text, onDone}], {append}) */
export function play(items, { append = false } = {}) {
  if (!synth) { alert('この端末では読み上げを使えません'); return; }
  const mapped = items.map(i => ({ label: i.label, chunks: split(i.text), onDone: i.onDone })).filter(i => i.chunks.length);
  if (append && current) { queue.push(...mapped); listener(state()); return; }
  stop(false);
  queue = mapped;
  next();
}

function next() {
  const item = queue.shift();
  if (!item) { current = null; paused = false; listener(state()); return; }
  current = { item, index: 0 };
  listener(state());
  speakChunk();
}

function speakChunk() {
  const cur = current; if (!cur) return;
  if (cur.index >= cur.item.chunks.length) { cur.item.onDone?.(); next(); return; }
  const u = new SpeechSynthesisUtterance(cur.item.chunks[cur.index]);
  u.lang = 'ja-JP'; u.rate = opts.rate;
  const v = synth.getVoices().find(v => v.voiceURI === opts.voiceURI);
  if (v) u.voice = v;
  u.onend = () => { if (current !== cur) return; cur.index++; speakChunk(); };
  u.onerror = e => { if (current !== cur || e.error === 'interrupted' || e.error === 'canceled') return; cur.index++; speakChunk(); };
  synth.speak(u);
}

export function togglePause() {
  if (!current) return;
  if (paused) { synth.resume(); paused = false; }
  else { synth.pause(); paused = true; }
  listener(state());
}
export function skip() {
  if (!current) return;
  current = null; synth.cancel(); paused = false;
  next();
}
export function stop(notify = true) {
  queue = []; current = null; paused = false;
  if (synth) synth.cancel();
  if (notify) listener(state());
}
