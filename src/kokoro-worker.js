// =============================================================
// kokoro-worker.js — Kokoro TTS in a Web Worker.
// Defensive: validates the voice exists before generating, logs the
// available voice list, pre-warms the model with a tiny dummy
// generation so the first real call doesn't pay graph-compile cost.
// =============================================================

// Configure transformers.js cache BEFORE importing kokoro-js so the
// settings are picked up by the underlying onnxruntime + HF caching layer.
import { env } from 'https://esm.sh/@huggingface/transformers@3';
env.useBrowserCache = true;          // cache via browser Cache Storage API
env.useFSCache      = false;
env.useCustomCache  = false;
env.allowRemoteModels = true;
env.allowLocalModels  = false;

import { KokoroTTS } from 'https://esm.sh/kokoro-js@1.2';

let tts = null;
let loadPromise = null;
const DEFAULT_VOICE = 'af_heart';

async function ensureLoaded() {
  if (tts) return tts;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    let model = null;
    // fp32: ~300MB but the English voices actually work. q8 produces
    // garbled / non-English audio with this model — known issue with
    // the v1.0-ONNX quantization. We pay the bigger one-time download
    // and rely on the Service Worker (sw.js) to cache it permanently.
    try {
      model = await KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-v1.0-ONNX',
        { dtype: 'fp32', device: 'webgpu' }
      );
      self.postMessage({ type: 'log', msg: 'loaded on webgpu (fp32)' });
    } catch (e1) {
      self.postMessage({ type: 'log', msg: `webgpu fp32 failed: ${e1?.message || e1}, trying wasm fp32` });
      try {
        model = await KokoroTTS.from_pretrained(
          'onnx-community/Kokoro-82M-v1.0-ONNX',
          { dtype: 'fp32' }     // wasm fallback, still fp32
        );
        self.postMessage({ type: 'log', msg: 'loaded on wasm (fp32)' });
      } catch (e2) {
        self.postMessage({ type: 'log', msg: `wasm fp32 failed too: ${e2?.message || e2}` });
        throw e2;
      }
    }
    tts = model;
    // Quick cache health check — see how many model files are cached
    try {
      const cacheNames = await self.caches.keys();
      let cached = 0;
      for (const name of cacheNames) {
        const cache = await self.caches.open(name);
        const keys = await cache.keys();
        cached += keys.length;
      }
      self.postMessage({ type: 'log', msg: `Cache Storage has ${cached} entries across ${cacheNames.length} caches` });
    } catch (e) {
      self.postMessage({ type: 'log', msg: `cache probe failed: ${e?.message}` });
    }
    // Probe what voices the model knows
    let voiceList = [];
    try {
      voiceList = Object.keys(tts.voices || {});
    } catch (e) {
      self.postMessage({ type: 'log', msg: `couldn't list voices: ${e?.message}` });
    }
    self.postMessage({ type: 'log', msg: `voices (${voiceList.length}): ${voiceList.join(', ')}` });
    // Verify our default voice actually exists; if not, fall back to the
    // first American-female voice we can find
    if (!voiceList.includes(DEFAULT_VOICE)) {
      self.postMessage({ type: 'log', msg: `WARNING: default voice "${DEFAULT_VOICE}" not in list` });
    }
    // Pre-warm: tiny dummy generation so the first real call doesn't pay
    // the graph-compilation tax. ~200ms wasted on init, instant after.
    try {
      const v = voiceList.includes(DEFAULT_VOICE) ? DEFAULT_VOICE : voiceList.find(x => x.startsWith('af_')) || voiceList[0];
      await tts.generate('hi', { voice: v });
      self.postMessage({ type: 'log', msg: `pre-warmed with voice: ${v}` });
    } catch (e) {
      self.postMessage({ type: 'log', msg: `pre-warm failed: ${e?.message}` });
    }
    return tts;
  })();
  return loadPromise;
}

self.onmessage = async (e) => {
  const { type, payload, id } = e.data || {};

  if (type === 'load') {
    try {
      await ensureLoaded();
      self.postMessage({ type: 'loaded', id });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err?.message || String(err) });
    }
    return;
  }

  if (type === 'speak') {
    try {
      const tts2 = await ensureLoaded();
      const text  = (payload?.text || '').toString();
      // Validate voice — fall back to a known-good American-female voice
      const voiceList = Object.keys(tts2.voices || {});
      let voice = payload?.voice || DEFAULT_VOICE;
      if (!voiceList.includes(voice)) {
        const fallback = voiceList.find(v => v.startsWith('af_')) || voiceList[0];
        self.postMessage({ type: 'log', msg: `voice "${voice}" missing, using "${fallback}"` });
        voice = fallback;
      }
      const speed = payload?.speed || 1.0;

      // Plain generate (not streaming) — proves the voice path works first.
      const result = await tts2.generate(text, { voice, speed });
      const arr = result?.audio;
      const sr  = result?.sampling_rate || 24000;
      if (!arr) {
        self.postMessage({ type: 'error', id, error: 'no audio returned' });
        return;
      }
      self.postMessage(
        { type: 'audio-chunk', id, chunkIndex: 0, audio: arr, sampling_rate: sr },
        [arr.buffer]
      );
      self.postMessage({ type: 'audio-end', id });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err?.message || String(err) });
    }
    return;
  }
};
