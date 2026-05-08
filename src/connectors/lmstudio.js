// =============================================================
// connectors/lmstudio.js — browser → user's local LM Studio
// (OpenAI-compatible HTTP at http://localhost:1234 by default).
//
// Caveat: when wonderlab itself is served over HTTPS (Cloudflare
// production), most browsers will block plain-HTTP localhost calls
// from a secure context. The settings UI surfaces this as a
// "browsers block https → http; run wonderlab locally to use this"
// hint in testConnection().
// =============================================================

import { makeReplyExtractor, parseFinalJson, buildMessageHistory } from './extract.js';
import { readOpenAISSE } from './gemini.js';
import { getSystemPrompt, NO_IMAGE_DIRECTIVE, JSON_ONLY_DIRECTIVE, languageDirective, levelDirective } from './system-prompt.js';

const DEFAULT_URL   = 'http://localhost:1234/v1/chat/completions';
const DEFAULT_MODEL = 'qwen3-14b-mlx';

// Strip the path off the configured chat URL so we can hit sibling
// endpoints (/v1/models, /api/v0/models). Returns "http://host:port".
function originOf(url) {
  const u = (url || DEFAULT_URL).replace(/\/+$/, '');
  // chop off everything from /v1 or /api onward
  return u.replace(/\/(v1|api)\/.*$/, '');
}

// Discover models known to LM Studio. Tries the richer REST endpoint
// (LM Studio 0.3.6+ — returns loaded + downloaded with a `state` field)
// and falls back to the OpenAI-compat /v1/models (loaded only).
//
// Resolves to:
//   { ok: true,  models: [{id, state, type?, ctx?}], canListDownloaded: bool }
//   { ok: false, error }
export async function discoverModels({ url } = {}) {
  const origin = originOf(url);
  if (location.protocol === 'https:' && /^http:\/\//i.test(origin)) {
    return { ok: false, error: 'browsers block http→https; see the help under the URL field' };
  }

  // 1) Try /api/v0/models — gives us state ('loaded' | 'not-loaded') for
  //    every downloaded model, so we can offer JIT-loadable picks.
  try {
    const res = await fetch(`${origin}/api/v0/models`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      // Keep llm + vlm (text + vision-language). Drop embeddings, vision
      // encoders, and anything else that can't answer a chat completion.
      const CHAT_TYPES = new Set(['llm', 'vlm']);
      const list = (data?.data || [])
        .filter(m => m && m.id && (m.type ? CHAT_TYPES.has(m.type) : true))
        .map(m => ({
          id:    m.id,
          state: m.state === 'loaded' ? 'loaded' : 'downloaded',
          type:  m.type || 'llm',
          ctx:   m.max_context_length || m.loaded_context_length || null,
        }));
      if (list.length) return { ok: true, models: list, canListDownloaded: true };
    }
  } catch { /* fall through */ }

  // 2) Fall back to /v1/models (only loaded models).
  try {
    const res = await fetch(`${origin}/v1/models`, { method: 'GET' });
    if (!res.ok) return { ok: false, error: `LM Studio HTTP ${res.status} at /v1/models` };
    const data = await res.json().catch(() => null);
    const list = (data?.data || [])
      .map(m => m?.id).filter(Boolean)
      .map(id => ({ id, state: 'loaded', type: 'llm', ctx: null }));
    return { ok: true, models: list, canListDownloaded: false };
  } catch (e) {
    return { ok: false, error: `couldn't reach LM Studio: ${e.message}` };
  }
}

export const lmstudioConnector = {
  id: 'lmstudio',
  label: 'LM Studio (local)',
  description: 'your own GPU, your own model — runs from localhost',
  needsKey: false,
  needsLocalServer: false,
  defaultDrawIllustrations: false,    // local models tend to be small → text-only safer
  models: [],                          // filled at testConnection time

  async testConnection({ url } = {}) {
    const r = await discoverModels({ url });
    if (!r.ok) return { ok: false, error: r.error };
    const loaded     = r.models.filter(m => m.state === 'loaded');
    const downloaded = r.models.filter(m => m.state !== 'loaded');
    if (!loaded.length && !downloaded.length) {
      return {
        ok: true,
        info: 'connected, but no models found — download one in LM Studio',
        models: [],
        canListDownloaded: r.canListDownloaded,
      };
    }
    if (!loaded.length) {
      return {
        ok: true,
        info: `connected · 0 loaded · ${downloaded.length} downloaded — pick one below to load on first ask`,
        models: r.models,
        canListDownloaded: r.canListDownloaded,
      };
    }
    const extra = downloaded.length ? ` · ${downloaded.length} more downloaded` : '';
    return {
      ok: true,
      info: `connected · ${loaded.length} loaded${extra}`,
      models: r.models,
      modelsAvailable: loaded.map(m => m.id),     // back-compat
      canListDownloaded: r.canListDownloaded,
    };
  },

  async ask(question, { withImage, url, model, language, level, history, onReply, onDone, onError }) {
    const u = (url || DEFAULT_URL);
    const t0 = Date.now();
    let system;
    try { system = await getSystemPrompt(); }
    catch (e) { return onError(e); }

    // /no_think — Qwen3 (and other reasoning-mode models) default to
    // emitting a <think>…</think> block before the answer. That doubles
    // prompt-processing time on LM Studio (you can see it as two
    // consecutive "Prompt processing progress: 100.0%" lines in the
    // server log) and eats the max_tokens budget. We don't want hidden
    // reasoning here — the JSON contract is the answer. The directive is
    // a no-op on models that don't recognize it.
    const userMsg = (question || '')
      + JSON_ONLY_DIRECTIVE
      + languageDirective(language)
      + levelDirective(level)
      + (withImage === false ? NO_IMAGE_DIRECTIVE : '')
      + '\n\n/no_think';

    let response;
    try {
      response = await fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          stream: true,
          temperature: 0.5,
          max_tokens: withImage === false ? 2048 : 16000,
          messages: [
            { role: 'system', content: system },
            ...buildMessageHistory(history, userMsg),
          ],
        }),
      });
    } catch (e) {
      return onError(new Error(`couldn't reach LM Studio at ${u}: ${e.message}`));
    }
    if (!response.ok) {
      const t = await response.text().catch(() => '');
      return onError(new Error(`LM Studio HTTP ${response.status}${t ? ': ' + truncate(t, 240) : ''}`));
    }

    const extract = makeReplyExtractor(onReply);
    let fullText = '';
    try {
      for await (const delta of readOpenAISSE(response)) {
        if (delta) { fullText += delta; extract(delta); }
      }
    } catch (e) {
      return onError(new Error(`LM Studio stream broke: ${e.message}`));
    }

    const inner = parseFinalJson(fullText);
    if (!inner) {
      return onError(new Error('LM Studio output was not valid JSON\n— first 400 chars —\n' + fullText.slice(0, 400)));
    }
    onDone({
      spec: inner,
      meta: { duration_ms: Date.now() - t0, model: model || DEFAULT_MODEL, backend: 'lmstudio' },
    });
  },
};

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
