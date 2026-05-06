// =============================================================
// connectors/webllm.js — runs the LLM directly in the browser via
// @mlc-ai/web-llm (WebGPU). First use downloads ~900MB-2.5GB of
// MLC-compiled model weights from HuggingFace to the browser cache;
// subsequent runs are instant.
//
// We lazy-load the package from esm.run so wonderlab's first paint
// isn't held back by a multi-MB JS bundle the user might not need.
// =============================================================

import { makeReplyExtractor, parseFinalJson } from './extract.js';
import { getSystemPrompt, NO_IMAGE_DIRECTIVE, JSON_ONLY_DIRECTIVE, languageDirective } from './system-prompt.js';
import { WEBLLM_MODELS } from '../device-detect.js';

const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm';

let webllmMod = null;       // cached module reference
let engine    = null;       // active engine
let engineModelId = null;   // model id the engine is loaded with

// Load the @mlc-ai/web-llm module on demand. The first call kicks off the
// fetch from esm.run; subsequent calls reuse the cached module.
async function loadModule() {
  if (webllmMod) return webllmMod;
  webllmMod = await import(/* @vite-ignore */ WEBLLM_CDN);
  return webllmMod;
}

// Pattern that flags a recoverable WebLLM cache failure — typically the
// Cache.add() rejection on a redirected/opaque HF response. When we see
// this we wipe the local WebLLM storage and retry once, so the visitor
// never has to manually clear site data.
const RECOVERABLE_CACHE_RE =
  /Cache\.add|encountered a network error|opaqueredirect|redirected|Failed to fetch/i;

// Wipe everything WebLLM might be storing on disk: browser Cache API
// entries with "webllm"/"mlc" in the name, plus IndexedDB databases used
// by the MLC runtime. Used on auto-recovery from a poisoned cache.
async function clearWebllmStorage() {
  if (typeof caches !== 'undefined') {
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(n => /webllm|mlc/i.test(n))
          .map(n => caches.delete(n).catch(() => {}))
      );
    } catch {}
  }
  if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
    try {
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map((db) => new Promise((resolve) => {
        if (!db?.name || !/webllm|mlc|tvm|model/i.test(db.name)) return resolve();
        const req = indexedDB.deleteDatabase(db.name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      })));
    } catch {}
  }
  // also drop any in-memory engine reference so the next attempt rebuilds
  engine = null;
  engineModelId = null;
}

// (Re)create the engine for the requested model. If the same model is already
// loaded we skip the work. progressCb receives { progress: 0..1, text } updates.
//
// We pass `useIndexedDBCache: true` so WebLLM stores model shards in IDB
// instead of the browser Cache API — IDB doesn't have the redirect/opaque
// response rejection rules that surface as "Cache.add() encountered a
// network error". On the rare occasion that path still fails (e.g., legacy
// Cache API entries from a previous version of this site), we auto-detect,
// wipe the storage, and retry once invisibly.
async function ensureEngine(modelId, progressCb) {
  if (engine && engineModelId === modelId) return engine;
  const wm = await loadModule();
  const initProgressCallback = (p) => {
    if (typeof progressCb === 'function') {
      progressCb({
        progress: typeof p.progress === 'number' ? p.progress : 0,
        text:     p.text || '',
      });
    }
  };
  // appConfig with IndexedDB caching. The actual option name is
  // `cacheBackend: "indexeddb"` (NOT `useIndexedDBCache` — that name
  // was silently ignored by current WebLLM, so the Cache API path
  // ran the whole time and HF's redirect chain kept tripping
  // Cache.add). Clones the bundled prebuilt list so we don't narrow
  // the available models.
  const appConfig = {
    ...(wm.prebuiltAppConfig || {}),
    cacheBackend: 'indexeddb',
  };
  const opts = { initProgressCallback, appConfig };

  const tryLoad = async () => {
    if (engine && typeof engine.reload === 'function') {
      await engine.reload(modelId, opts);
    } else {
      engine = await wm.CreateMLCEngine(modelId, opts);
    }
  };

  try {
    await tryLoad();
  } catch (err) {
    const msg = String(err?.message || err);
    if (!RECOVERABLE_CACHE_RE.test(msg)) throw err;
    // poisoned local storage from a previous session — auto-recover
    console.warn('[wonderlab] WebLLM cache poisoned, auto-recovering:', msg);
    if (typeof progressCb === 'function') {
      progressCb({ progress: 0, text: 'recovering — rebuilding model cache…' });
    }
    await clearWebllmStorage();
    await tryLoad();    // one retry with clean storage; let any second failure surface
  }

  engineModelId = modelId;
  return engine;
}

export const webllmConnector = {
  id: 'webllm',
  label: 'WebLLM (in-browser)',
  description: 'no key, no server — runs on your GPU. first run downloads the model (~1-2GB).',
  needsKey: false,
  needsLocalServer: false,
  defaultDrawIllustrations: false,    // small browser models can't draw SVG reliably
  models: WEBLLM_MODELS.map(m => ({
    id: m.id,
    label: `${m.label} · ~${(m.sizeMB / 1024).toFixed(1)}GB`,
  })),

  async testConnection({ model }) {
    if (!navigator.gpu) {
      return { ok: false, error: 'WebGPU isn\'t available in this browser' };
    }
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { ok: false, error: 'no WebGPU adapter — try Chrome / Edge' };
      // we don't actually pre-load the model on test; just confirm the runtime + WebGPU.
      await loadModule();
      return {
        ok: true,
        info: model
          ? `WebGPU ready — ${model} will download on first use`
          : 'WebGPU ready — pick a model to download on first use',
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  },

  async ask(question, {
    withImage, model, language,
    onReply, onDone, onError,
    onProgress,                         // optional: { progress, text } during model download
  }) {
    if (!navigator.gpu) {
      return onError(new Error('WebGPU isn\'t available in this browser — switch to Claude or Gemini in settings'));
    }
    const t0 = Date.now();
    const modelId = model || 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
    let system;
    try { system = await getSystemPrompt(); }
    catch (e) { return onError(e); }

    let eng;
    try {
      eng = await ensureEngine(modelId, onProgress);
    } catch (e) {
      return onError(new Error(`couldn't load WebLLM model: ${e.message || e}`));
    }

    const userMsg = (question || '')
      + JSON_ONLY_DIRECTIVE
      + languageDirective(language)
      + (withImage === false ? NO_IMAGE_DIRECTIVE : '');

    const extract = makeReplyExtractor(onReply);
    let fullText = '';
    try {
      const stream = await eng.chat.completions.create({
        stream: true,
        temperature: 0.5,
        max_tokens: withImage === false ? 2048 : 8192,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: userMsg },
        ],
      });
      for await (const chunk of stream) {
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length) {
          fullText += delta;
          extract(delta);
        }
      }
    } catch (e) {
      return onError(new Error(`WebLLM generation failed: ${e.message || e}`));
    }

    const inner = parseFinalJson(fullText);
    if (!inner) {
      return onError(new Error('WebLLM output was not valid JSON\n— first 400 chars —\n' + fullText.slice(0, 400)));
    }
    onDone({
      spec: inner,
      meta: { duration_ms: Date.now() - t0, model: modelId, backend: 'webllm' },
    });
  },
};
