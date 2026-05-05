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
import { getSystemPrompt, NO_IMAGE_DIRECTIVE, JSON_ONLY_DIRECTIVE } from './system-prompt.js';
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

// (Re)create the engine for the requested model. If the same model is already
// loaded we skip the work. progressCb receives { progress: 0..1, text } updates.
//
// Critical: we pass `useIndexedDBCache: true` so WebLLM stores model shards
// in IndexedDB instead of the browser Cache API. The Cache API rejects
// redirected and opaque responses (which HF's CDN chain produces), surfacing
// as "Cache.add() encountered a network error" no matter how aggressively
// we cleanse responses in the service worker. IndexedDB has no such
// restriction — opaque-response bytes serialise fine into IDB.
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
  // appConfig with IndexedDB caching — clones the bundled prebuilt list
  // so we don't accidentally narrow available models.
  const appConfig = {
    ...(wm.prebuiltAppConfig || {}),
    useIndexedDBCache: true,
  };
  const opts = { initProgressCallback, appConfig };
  if (engine && typeof engine.reload === 'function') {
    await engine.reload(modelId, opts);
  } else {
    engine = await wm.CreateMLCEngine(modelId, opts);
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
    withImage, model,
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
