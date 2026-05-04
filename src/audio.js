// =============================================================
// audio.js — soundscape, generated procedurally so we don't ship
// any audio files. Three things:
//   • click()   — soft ping when iris reacts to a click
//   • ambient() — quiet pink-noise lab hum that loops forever
//   • speak()   — iris's voice via the browser's TTS
//
// Audio contexts can't start until the user interacts with the
// page (autoplay policy), so the first call to any function
// implicitly creates / resumes the context.
// =============================================================

let _ctx = null;
function ctx() {
  if (!_ctx) {
    const Klass = window.AudioContext || window.webkitAudioContext;
    if (!Klass) return null;
    _ctx = new Klass();
  }
  if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
  return _ctx;
}

// Soft chime — used for clicks on objects (iris's body, mug, papers, etc.)
export function click() {
  const c = ctx(); if (!c) return;
  const osc  = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, c.currentTime);
  osc.frequency.exponentialRampToValueAtTime(440, c.currentTime + 0.08);
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(0.07, c.currentTime + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.13);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.14);
}

// Warm thunk — used for the lamp toggle
export function thunk() {
  const c = ctx(); if (!c) return;
  const osc  = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(220, c.currentTime);
  osc.frequency.exponentialRampToValueAtTime(110, c.currentTime + 0.10);
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(0.10, c.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.20);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.21);
}

// Pen/marker squeak — used when a new scene paints to the whiteboard
export function squeak() {
  const c = ctx(); if (!c) return;
  const osc  = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(2200, c.currentTime);
  osc.frequency.exponentialRampToValueAtTime(900, c.currentTime + 0.20);
  const lp = c.createBiquadFilter();
  lp.type = 'bandpass';
  lp.frequency.value = 1500;
  lp.Q.value = 4;
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(0.025, c.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.22);
  osc.connect(lp).connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.23);
}

// Cozy lab hum — pink-ish noise, low-passed so it sits behind everything.
// Call ambient(true) once after the user's first interaction.
let _ambient = null;
export function ambient(on) {
  const c = ctx(); if (!c) return;
  if (on && !_ambient) {
    const bufSize = 2 * c.sampleRate;
    const buffer  = c.createBuffer(1, bufSize, c.sampleRate);
    const out     = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < bufSize; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99 * b0 + 0.0555 * w;
      b1 = 0.96 * b1 + 0.2965 * w;
      b2 = 0.57 * b2 + 0.97 * w;
      out[i] = (b0 + b1 + b2) * 0.045;
    }
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.loop   = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;     // dark, cozy
    const g = c.createGain();
    g.gain.value = 0.0;            // start silent, fade in
    src.connect(lp).connect(g).connect(c.destination);
    src.start();
    g.gain.linearRampToValueAtTime(0.05, c.currentTime + 1.5);
    _ambient = { src, gain: g };
  } else if (!on && _ambient) {
    const { src, gain } = _ambient;
    gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.4);
    setTimeout(() => { try { src.stop(); } catch {} }, 500);
    _ambient = null;
  }
}

// Pick the cutest English voice the browser offers.
// Modern browsers ship neural voices that sound human, but they're not
// the default. We rank candidates explicitly:
//   1. neural / "natural" / "online" (Edge Aria/Jenny, Google network voices)
//   2. high-quality Apple Siri voices on macOS 13+ ("Karen", "Kate", "Samantha enhanced")
//   3. any non-local-service voice (network-based, usually higher quality)
//   4. friendly female English names
//   5. anything English
let _voice = null;
function pickVoice() {
  if (_voice) return _voice;
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const isEnglish = v => /^en/i.test(v.lang);
  const isNeural  = v => /natural|neural|online|premium|enhanced|google us english/i.test(v.name);
  const isCute    = v => /aria|jenny|libby|zira|samantha|karen|kate|tessa|moira|fiona|allison|ava|nova|emily|sonia|emma|nora/i.test(v.name);

  const eng = voices.filter(isEnglish);
  const ranked = [
    eng.find(v => isNeural(v) && isCute(v)),
    eng.find(v => isNeural(v)),
    eng.find(v => !v.localService && isCute(v)),
    eng.find(v => !v.localService),
    eng.find(isCute),
    eng[0],
    voices[0],
  ].filter(Boolean);

  _voice = ranked[0] || null;
  if (_voice) console.log('[wonderlab] iris voice →', _voice.name, _voice.lang, 'localService:', _voice.localService);
  return _voice;
}

// =============================================================
// Two-tier voice pipeline:
//
//   1. KOKORO neural TTS (Hugging Face, runs in a Web Worker so the
//      main thread stays responsive while audio generates). WebGPU
//      preferred, WASM fallback. ~80MB one-time download to IndexedDB.
//      Voice: af_bella (warm young woman).
//
//   2. BROWSER speechSynthesis (last-resort while Kokoro warms up,
//      and on browsers where the worker / WebGPU isn't available).
// =============================================================

// ---- Kokoro Web Worker ---------------------------------------
let _worker     = null;
let _msgId      = 0;
const _pending  = new Map();
let _kokoroLoading = false;
let _kokoroReady   = false;
let _currentSrc    = null;        // currently-playing AudioBufferSourceNode

function ensureWorker() {
  if (_worker) return _worker;
  if (typeof Worker === 'undefined') return null;
  try {
    _worker = new Worker(new URL('./kokoro-worker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (e) => {
      const { type, id, audio, sampling_rate, error, msg } = e.data || {};
      if (type === 'log') {
        console.log('[wonderlab][kokoro]', msg);
        return;
      }
      const handler = _pending.get(id);
      if (!handler) return;
      // streaming: chunk arrives while still pending — fire onChunk, keep handler open
      if (type === 'audio-chunk') {
        handler.onChunk?.({ audio, sampling_rate });
        return;
      }
      _pending.delete(id);
      if (type === 'audio-end') handler.resolve(true);
      else if (type === 'loaded') handler.resolve(true);
      else handler.reject(new Error(error || type));
    };
    _worker.onerror = (e) => console.warn('[wonderlab] kokoro worker error', e);
    return _worker;
  } catch (e) {
    console.warn('[wonderlab] could not create kokoro worker:', e?.message || e);
    return null;
  }
}

function callWorker(type, payload, onChunk) {
  const w = ensureWorker();
  if (!w) return Promise.reject(new Error('no worker'));
  const id = ++_msgId;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject, onChunk });
    w.postMessage({ type, payload, id });
  });
}

async function loadKokoro() {
  if (_kokoroReady) return true;
  if (_kokoroLoading) return false;
  _kokoroLoading = true;
  try {
    await callWorker('load');
    _kokoroReady = true;
    console.log('[wonderlab] Kokoro neural TTS ready ✦');
    return true;
  } catch (e) {
    console.warn('[wonderlab] Kokoro load failed (using browser TTS instead):', e?.message || e);
    return false;
  }
}

// Streaming Kokoro playback: each chunk is scheduled on the AudioContext
// timeline so back-to-back chunks play seamlessly with no gap.
let _streamingSources = [];
let _voicePref = null;          // cached, read from localStorage on first use
function getVoice() {
  if (_voicePref) return _voicePref;
  try {
    _voicePref = localStorage.getItem('wonderlab.voice') || 'af_heart';
  } catch { _voicePref = 'af_heart'; }
  return _voicePref;
}
export function setVoice(name) {
  _voicePref = name;
  try { localStorage.setItem('wonderlab.voice', name); } catch {}
}

async function speakViaKokoro(text) {
  if (!_kokoroReady) return false;
  const c = ctx();
  if (!c) return false;
  try {
    let nextStartTime = c.currentTime + 0.05;
    let gotAny = false;
    _streamingSources = [];

    const onChunk = ({ audio, sampling_rate }) => {
      if (!audio || !audio.length) return;
      const buf = c.createBuffer(1, audio.length, sampling_rate);
      buf.copyToChannel(audio, 0);
      const src  = c.createBufferSource();
      const gain = c.createGain();
      src.buffer = buf;
      gain.gain.value = 0.95;
      src.connect(gain).connect(c.destination);
      const startAt = Math.max(c.currentTime, nextStartTime);
      src.start(startAt);
      nextStartTime = startAt + buf.duration;
      _streamingSources.push(src);
      gotAny = true;
    };

    await callWorker('speak', { text, voice: getVoice() }, onChunk);
    return gotAny;
  } catch (e) {
    console.warn('[wonderlab] Kokoro speak failed:', e?.message || e);
    return false;
  }
}

function speakViaBrowser(text) {
  if (!('speechSynthesis' in window)) return;
  try { window.speechSynthesis.cancel(); } catch {}
  const u = new SpeechSynthesisUtterance(String(text));
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate   = 0.96;
  u.pitch  = 1.18;
  u.volume = 0.92;
  window.speechSynthesis.speak(u);
}

// Speak a string in iris's voice. Kokoro (high quality, in worker) is
// preferred — it runs off-main-thread so the UI stays responsive.
// While Kokoro is still downloading on first visit we use the
// browser's built-in TTS so iris isn't silent.
export async function speak(text) {
  if (!text) return;
  shutUp();
  if (!_kokoroReady && !_kokoroLoading) loadKokoro();
  if (_kokoroReady && await speakViaKokoro(String(text))) return;
  speakViaBrowser(String(text));
}

export function shutUp() {
  try { window.speechSynthesis?.cancel(); } catch {}
  for (const s of _streamingSources) {
    try { s.stop(); } catch {}
  }
  _streamingSources = [];
}

// Voices load asynchronously on some browsers — re-pick once they arrive.
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => { _voice = null; pickVoice(); };
}
