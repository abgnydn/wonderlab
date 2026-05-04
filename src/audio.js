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
    lp.frequency.value = 380;     // darker — the music sits on top now
    const g = c.createGain();
    g.gain.value = 0.0;            // start silent, fade in
    src.connect(lp).connect(g).connect(c.destination);
    src.start();
    g.gain.linearRampToValueAtTime(0.025, c.currentTime + 1.5);   // half as loud as before
    _ambient = { src, gain: g };
  } else if (!on && _ambient) {
    const { src, gain } = _ambient;
    gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.4);
    setTimeout(() => { try { src.stop(); } catch {} }, 500);
    _ambient = null;
  }
}

// =============================================================
// Procedural ambient music — three layers, all generated at runtime,
// no audio assets. Goal: gentle, pleasant, infinite, kid-safe.
//
//   • drone  — long sustained low note, slowly drifting (the "room")
//   • melody — sparse single notes from C major pentatonic
//              (always sounds pleasant, can't pick a "wrong" note)
//   • chime  — every ~10s, a soft music-box ping high up
//
// All layers feed a master gain → a gentle 4th-order lowpass → output,
// so nothing ever sounds harsh or piercing.
// =============================================================

// C major pentatonic across two and a bit octaves — the safest "always
// sounds nice" scale. Children's-music staple for a reason.
const PENTATONIC_HZ = [
  261.63, 293.66, 329.63, 392.00, 440.00,         // C4 D4 E4 G4 A4
  523.25, 587.33, 659.25, 783.99, 880.00,         // C5 D5 E5 G5 A5
  1046.50,                                          // C6
];
const DRONE_HZ = 130.81;   // C3 — a quiet floor under everything

let _music = null;

function _scheduleMelodyNote() {
  if (!_music) return;
  const c = ctx(); if (!c) return;
  const freq = PENTATONIC_HZ[Math.floor(Math.random() * PENTATONIC_HZ.length)];
  const osc = c.createOscillator();
  osc.type = Math.random() < 0.55 ? 'triangle' : 'sine';
  osc.frequency.value = freq;

  const g = c.createGain();
  const pan = c.createStereoPanner();
  pan.pan.value = (Math.random() - 0.5) * 0.7;

  const now = c.currentTime;
  const peak = 0.04 + Math.random() * 0.025;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(peak,    now + 0.18);   // slow attack
  g.gain.exponentialRampToValueAtTime(0.0001,  now + 3.6);    // long decay

  osc.connect(g).connect(pan).connect(_music.bus);
  osc.start(now);
  osc.stop(now + 3.8);

  // 30% chance of a soft companion a perfect-5th up — never harsh
  if (Math.random() < 0.3) {
    const o2 = c.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq * 1.5;
    const g2 = c.createGain();
    g2.gain.setValueAtTime(0.0001, now);
    g2.gain.exponentialRampToValueAtTime(peak * 0.55, now + 0.28);
    g2.gain.exponentialRampToValueAtTime(0.0001,      now + 3.4);
    o2.connect(g2).connect(pan).connect(_music.bus);
    o2.start(now + 0.04);
    o2.stop(now + 3.5);
  }

  // schedule next melody note: 1.8–5s gap → never crowded
  const next = 1800 + Math.random() * 3200;
  _music.melodyTimer = setTimeout(_scheduleMelodyNote, next);
}

function _scheduleChimePing() {
  if (!_music) return;
  const c = ctx(); if (!c) return;
  // pick a sparkly note in the upper register
  const freq = PENTATONIC_HZ[6 + Math.floor(Math.random() * 5)];
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const g = c.createGain();
  const now = c.currentTime;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.05,   now + 0.02);   // fast attack
  g.gain.exponentialRampToValueAtTime(0.0001, now + 5.0);    // very long decay
  osc.connect(g).connect(_music.bus);
  osc.start(now);
  osc.stop(now + 5.2);

  const next = 9000 + Math.random() * 7000;       // every 9–16s
  _music.chimeTimer = setTimeout(_scheduleChimePing, next);
}

export function music(on) {
  const c = ctx(); if (!c) return;
  if (on && !_music) {
    // master bus → gentle lowpass → main out
    const bus = c.createGain();
    bus.gain.value = 0.0;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4500;
    bus.connect(lp).connect(c.destination);

    // drone: two slightly-detuned sines on C3 with very slow LFO on the
    // gain so it breathes
    const d1 = c.createOscillator(); d1.type = 'sine'; d1.frequency.value = DRONE_HZ;
    const d2 = c.createOscillator(); d2.type = 'sine'; d2.frequency.value = DRONE_HZ * 1.005;
    const dg = c.createGain(); dg.gain.value = 0.018;
    const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.07;
    const lfoGain = c.createGain(); lfoGain.gain.value = 0.012;
    lfo.connect(lfoGain).connect(dg.gain);
    d1.connect(dg); d2.connect(dg); dg.connect(bus);
    d1.start(); d2.start(); lfo.start();

    _music = { bus, drone: [d1, d2, lfo], melodyTimer: null, chimeTimer: null };
    bus.gain.linearRampToValueAtTime(1.0, c.currentTime + 2.0);

    // start the two timed layers (slight initial delay so the drone
    // settles in before notes start landing)
    setTimeout(_scheduleMelodyNote, 2000 + Math.random() * 1500);
    setTimeout(_scheduleChimePing,  6000 + Math.random() * 3000);
  } else if (!on && _music) {
    if (_music.melodyTimer) clearTimeout(_music.melodyTimer);
    if (_music.chimeTimer)  clearTimeout(_music.chimeTimer);
    _music.bus.gain.linearRampToValueAtTime(0, c.currentTime + 1.0);
    const drone = _music.drone;
    setTimeout(() => {
      try { for (const o of drone) o.stop(); } catch {}
      try { _music.bus.disconnect(); } catch {}
    }, 1100);
    _music = null;
  }
}

export function isMusicOn() { return !!_music; }

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
