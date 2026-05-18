// =============================================================
// connectors/gemma.js — browser → Google AI Studio, Gemma 4 only.
//
// Uses the *native* Gemini endpoint (generateContent /
// streamGenerateContent), not the OpenAI-compatible shim. The
// OpenAI shim only routes Gemini-family models; Gemma model IDs
// return 500 INTERNAL from it.
//
// SceneSpec is emitted as plain JSON via instruction following. As of
// 2026-05-15, Gemma 4 on AI Studio returns HTTP 500 for any request
// that includes `responseMimeType: 'application/json'`, `responseSchema`,
// or function-calling `tools` — even with minimal valid schemas
// (verified via curl). The plain text path works fine, and the system
// prompt enforces the JSON contract via the JSON_ONLY_DIRECTIVE.
//
// When Google stabilizes structured-output / function-calling for Gemma
// 4 on AI Studio, swap back — the schema lives in scene-schema.js and
// is ready to plug in.
//
// Gemma 4 is Apache-2.0, multimodal, free on AI Studio (no card).
// User pastes their AI Studio key once; it stays in their browser.
// =============================================================

import { makeReplyExtractor, parseFinalJson, buildMessageHistory } from './extract.js';
import { getSystemPrompt, NO_IMAGE_DIRECTIVE, JSON_ONLY_DIRECTIVE, languageDirective, levelDirective } from './system-prompt.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemma-4-31b-it';

function streamUrl(model) { return `${BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`; }
function singleUrl(model) { return `${BASE}/${encodeURIComponent(model)}:generateContent`; }

// Map OpenAI-shape history ({ role: 'user'|'assistant', content }) onto
// Gemini's `contents` array ({ role: 'user'|'model', parts: [{ text }] }).
function toGeminiContents(history, userMsg) {
  const messages = buildMessageHistory(history, userMsg);
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content ?? '') }],
  }));
}

// Gemini's streamGenerateContent with `?alt=sse` emits standard
// `data: { … }\n\n` lines whose payload is a partial candidate. We
// yield text deltas. Gemma 4 31B has chain-of-thought enabled by
// default — those parts have `thought: true` and must be skipped so
// they don't leak into the bubble.
async function* readGeminiSSE(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const payload = t.slice(6);
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      const parts = evt.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const p of parts) {
        if (p?.thought === true) continue;          // skip CoT scratchpad
        if (typeof p?.text === 'string' && p.text) yield p.text;
      }
    }
  }
}

export const gemmaConnector = {
  id: 'gemma',
  label: 'Gemma 4 (Google AI Studio)',
  description: 'open-weight, free tier, no card — bring your AI Studio key',
  needsKey: true,
  needsLocalServer: false,
  defaultDrawIllustrations: true,
  models: [
    { id: 'gemma-4-31b-it',     label: 'Gemma 4 31B — best quality (recommended)' },
    { id: 'gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B — MoE, faster reasoning' },
    { id: 'gemma-4-E4B-it',     label: 'Gemma 4 E4B — small, runs on phones' },
    { id: 'gemma-4-E2B-it',     label: 'Gemma 4 E2B — smallest, fastest' },
  ],

  async testConnection({ key, model }) {
    if (!key) return { ok: false, error: 'add your AI Studio key first' };
    // GET the model metadata instead of running inference. A
    // `:generateContent` test call with maxOutputTokens=8 trips Gemma
    // 4's chain-of-thought (it burns its budget on hidden thinking
    // tokens before emitting anything) and intermittently returns 500.
    // The metadata route validates the API key + that the model is
    // reachable for this account, without a billable / flaky call.
    const modelId = model || DEFAULT_MODEL;
    try {
      const res = await fetch(`${BASE}/${encodeURIComponent(modelId)}`, {
        method: 'GET',
        headers: { 'x-goog-api-key': key },
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}${t ? ': ' + truncate(t, 160) : ''}` };
      }
      return { ok: true, info: `auth ok — ${modelId} is reachable` };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  },

  async ask(question, { withImage, key, model, language, level, history, onReply, onDone, onError }) {
    if (!key) return onError(new Error('add your AI Studio key in settings'));
    const t0 = Date.now();
    let system;
    try { system = await getSystemPrompt(); }
    catch (e) { return onError(e); }

    const userMsg = (question || '')
      + JSON_ONLY_DIRECTIVE
      + languageDirective(language)
      + levelDirective(level)
      + (withImage === false ? NO_IMAGE_DIRECTIVE : '');

    const modelId = model || DEFAULT_MODEL;
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: toGeminiContents(history, userMsg),
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: withImage === false ? 2048 : 16000,
      },
    });

    // Gemma 4 31B's inference endpoint on AI Studio intermittently
    // returns HTTP 500 INTERNAL even for well-formed requests. We
    // retry up to 3× with exponential backoff (1s, 2s, 4s) before
    // surfacing the error to the user with a hint about other models.
    let response;
    let lastErrorText = '';
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await fetch(streamUrl(modelId), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body,
        });
      } catch (e) {
        return onError(new Error(`couldn't reach Gemma: ${e.message}`));
      }
      if (response.ok) break;
      lastErrorText = await response.text().catch(() => '');
      // 4xx is the caller's problem (auth, schema, quota) — no point retrying.
      if (response.status < 500 || attempt === maxAttempts) break;
      await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    if (!response.ok) {
      const hint = response.status >= 500
        ? ` — Gemma 4 ${modelId} is flaky on AI Studio right now; try again in a moment, or switch to Gemini in settings.`
        : '';
      return onError(new Error(
        `Gemma HTTP ${response.status}${lastErrorText ? ': ' + truncate(lastErrorText, 240) : ''}${hint}`
      ));
    }

    const extract = makeReplyExtractor(onReply);
    let fullText = '';
    try {
      for await (const delta of readGeminiSSE(response)) {
        if (delta) { fullText += delta; extract(delta); }
      }
    } catch (e) {
      return onError(new Error(`Gemma stream broke: ${e.message}`));
    }

    const inner = parseFinalJson(fullText);
    if (!inner) {
      return onError(new Error('Gemma 4 output was not valid JSON\n— first 400 chars —\n' + fullText.slice(0, 400)));
    }
    onDone({
      spec: inner,
      meta: {
        duration_ms: Date.now() - t0,
        model: modelId,
        backend: 'gemma',
      },
    });
  },
};

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
