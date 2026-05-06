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

import { makeReplyExtractor, parseFinalJson } from './extract.js';
import { readOpenAISSE } from './gemini.js';
import { getSystemPrompt, NO_IMAGE_DIRECTIVE, JSON_ONLY_DIRECTIVE, languageDirective } from './system-prompt.js';

const DEFAULT_URL   = 'http://localhost:1234/v1/chat/completions';
const DEFAULT_MODEL = 'qwen3-14b-mlx';

export const lmstudioConnector = {
  id: 'lmstudio',
  label: 'LM Studio (local)',
  description: 'your own GPU, your own model — runs from localhost',
  needsKey: false,
  needsLocalServer: false,
  defaultDrawIllustrations: false,    // local models tend to be small → text-only safer
  models: [],                          // filled at testConnection time

  async testConnection({ url, model }) {
    const u = (url || DEFAULT_URL).replace(/\/+$/, '');
    if (location.protocol === 'https:' && /^http:\/\//i.test(u)) {
      return {
        ok: false,
        error: 'browsers block http→https; see the help card under the URL field for three fixes',
      };
    }
    // probe /v1/models
    const modelsUrl = u.replace(/\/chat\/completions$/, '/models');
    try {
      const res = await fetch(modelsUrl, { method: 'GET' });
      if (!res.ok) return { ok: false, error: `LM Studio HTTP ${res.status} at ${modelsUrl}` };
      const data = await res.json().catch(() => null);
      const ids = (data?.data || []).map(m => m.id).filter(Boolean);
      if (!ids.length) return { ok: true, info: 'connected, but no models loaded yet — load one in LM Studio' };
      return {
        ok: true,
        info: `connected · ${ids.length} model${ids.length === 1 ? '' : 's'} loaded`,
        modelsAvailable: ids,
      };
    } catch (e) {
      return { ok: false, error: `couldn't reach LM Studio: ${e.message}` };
    }
  },

  async ask(question, { withImage, url, model, language, onReply, onDone, onError }) {
    const u = (url || DEFAULT_URL);
    const t0 = Date.now();
    let system;
    try { system = await getSystemPrompt(); }
    catch (e) { return onError(e); }

    const userMsg = (question || '')
      + JSON_ONLY_DIRECTIVE
      + languageDirective(language)
      + (withImage === false ? NO_IMAGE_DIRECTIVE : '');

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
            { role: 'user',   content: userMsg },
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
