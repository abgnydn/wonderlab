// =============================================================
// connectors/transformers.js — runs Gemma 4 directly in the browser
// via @huggingface/transformers (Transformers.js) on WebGPU.
//
// This is the *fully local* path for wonderlab: no key, no cloud,
// no server, no proxy. The trade-off is a heavy first-use download.
//
// Model IDs come from onnx-community/, which publishes the official
// ONNX conversions Google/HF ship alongside the Gemma 4 launch:
//   • onnx-community/gemma-4-E2B-it-ONNX  (~3.6 GB ONNX external-weight blobs)
//   • onnx-community/gemma-4-E4B-it-ONNX  (larger)
// The "_q4" in the filename names the export, not on-disk size —
// the `.onnx_data` external-weight files dominate. Chrome's default
// per-origin quota is 2 GB, so we run a navigator.storage.estimate()
// preflight in testConnection and ask() and bail with a clear error
// before the download fails halfway through.
//
// We lazy-load the library from esm.run so wonderlab's first paint
// isn't held back by ~3 MB of ONNX runtime JS that the visitor might
// not need.
// =============================================================

import { makeReplyExtractor, parseFinalJson, buildMessageHistory } from './extract.js';
import { getSystemPrompt, NO_IMAGE_DIRECTIVE, JSON_ONLY_DIRECTIVE, languageDirective, levelDirective } from './system-prompt.js';
import { makeProgressAggregator } from './transformers-progress.js';

const TRANSFORMERS_CDN = 'https://esm.run/@huggingface/transformers';

let mod = null;             // cached library module
let pipe = null;            // cached pipeline instance
let pipeModelId = null;     // model id the pipeline is loaded with

async function loadModule() {
  if (mod) return mod;
  mod = await import(/* @vite-ignore */ TRANSFORMERS_CDN);
  return mod;
}

// (Re)create the text-generation pipeline for the requested model.
// If the same model is already loaded we skip the work. Progress
// aggregation (per-shard → whole-download, monotonic) lives in
// transformers-progress.js so it's unit-testable without pulling
// the multi-GB ONNX blobs.
async function ensurePipeline(modelId, dtype, progressCb) {
  if (pipe && pipeModelId === modelId) return pipe;
  const m = await loadModule();

  const agg = makeProgressAggregator();
  const normProgress = (p) => {
    if (typeof progressCb !== 'function') return;
    progressCb(agg.onEvent(p));
  };

  pipe = await m.pipeline('text-generation', modelId, {
    dtype: dtype || 'q4',
    device: 'webgpu',
    progress_callback: normProgress,
  });
  pipeModelId = modelId;
  return pipe;
}

// Minimum browser quota we need for the Gemma 4 ONNX blobs + working
// space. Chrome's default origin quota is 2 GB, which is NOT enough —
// E2B alone is ~3.6 GB on disk. We use 4.5 GB as a guard so we fail
// fast with a clear message instead of dying mid-download.
const MIN_QUOTA_BYTES = 4.5 * 1024 * 1024 * 1024;

async function checkBrowserQuota() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { ok: true, reason: 'no Storage API — skipping preflight' };
  }
  try {
    const { quota } = await navigator.storage.estimate();
    if (typeof quota !== 'number') return { ok: true, reason: 'quota unknown' };
    if (quota >= MIN_QUOTA_BYTES) {
      return { ok: true, quota };
    }
    const gb = (quota / 1024 / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      quota,
      reason: `browser storage quota is ~${gb} GB — not enough for Gemma 4 in-browser (needs ~4 GB). Switch to "Gemma 4 (Google AI Studio)" in settings, or use LM Studio for a fully-offline option.`,
    };
  } catch {
    return { ok: true, reason: 'quota check threw — proceeding' };
  }
}

export const transformersConnector = {
  id: 'transformers',
  label: 'Gemma 4 (in-browser, Transformers.js)',
  description: 'experimental · no key, no server — runs Gemma 4 on your GPU. heavy first-use download (multi-GB ONNX blobs).',
  needsKey: false,
  needsLocalServer: false,
  defaultDrawIllustrations: false,   // E2B/E4B can produce JSON but SVG quality varies
  models: [
    { id: 'onnx-community/gemma-4-E2B-it-ONNX', label: 'Gemma 4 E2B (in-browser, experimental)' },
    { id: 'onnx-community/gemma-4-E4B-it-ONNX', label: 'Gemma 4 E4B (in-browser, experimental — even larger)' },
  ],

  async testConnection({ model }) {
    if (!navigator.gpu) {
      return { ok: false, error: 'WebGPU isn\'t available in this browser' };
    }
    const q = await checkBrowserQuota();
    if (!q.ok) return { ok: false, error: q.reason };
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { ok: false, error: 'no WebGPU adapter — try Chrome / Edge' };
      // Don't pre-load the model on test; just confirm runtime + WebGPU.
      await loadModule();
      return {
        ok: true,
        info: 'WebGPU ready — model will download on first use (multi-GB)',
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  },

  async ask(question, {
    withImage, model, language, level, history,
    onReply, onDone, onError,
    onProgress,                       // optional: { progress, text } during model download
  }) {
    if (!navigator.gpu) {
      return onError(new Error('WebGPU isn\'t available — switch to Gemma 4 cloud or Gemini in settings'));
    }
    const q = await checkBrowserQuota();
    if (!q.ok) return onError(new Error(q.reason));
    const t0 = Date.now();
    const modelId = model || 'onnx-community/gemma-4-E2B-it-ONNX';

    let system;
    try { system = await getSystemPrompt(); }
    catch (e) { return onError(e); }

    let generator;
    try {
      generator = await ensurePipeline(modelId, 'q4', onProgress);
    } catch (e) {
      return onError(new Error(`couldn't load Gemma 4 in-browser: ${e.message || e}`));
    }

    const userMsg = (question || '')
      + JSON_ONLY_DIRECTIVE
      + languageDirective(language)
      + levelDirective(level)
      + (withImage === false ? NO_IMAGE_DIRECTIVE : '');

    const messages = [
      { role: 'system', content: system },
      ...buildMessageHistory(history, userMsg),
    ];

    const extract = makeReplyExtractor(onReply);
    let fullText = '';
    const m = await loadModule();
    const streamer = new m.TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      callback_function: (delta) => {
        if (typeof delta === 'string' && delta.length) {
          fullText += delta;
          extract(delta);
        }
      },
    });

    try {
      await generator(messages, {
        max_new_tokens: withImage === false ? 2048 : 4096,
        temperature: 0.5,
        do_sample: true,
        streamer,
      });
    } catch (e) {
      return onError(new Error(`Gemma 4 generation failed: ${e.message || e}`));
    }

    const inner = parseFinalJson(fullText);
    if (!inner) {
      return onError(new Error('Gemma 4 output was not valid JSON\n— first 400 chars —\n' + fullText.slice(0, 400)));
    }
    onDone({
      spec: inner,
      meta: { duration_ms: Date.now() - t0, model: modelId, backend: 'transformers' },
    });
  },
};
