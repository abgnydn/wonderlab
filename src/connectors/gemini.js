// =============================================================
// connectors/gemini.js — browser → Google Generative Language API
// (OpenAI-compatible endpoint). Free tier with no card; user pastes
// their AI Studio key. Same key never leaves their browser.
// =============================================================

import { makeReplyExtractor, parseFinalJson } from './extract.js';
import { getSystemPrompt, NO_IMAGE_DIRECTIVE, JSON_ONLY_DIRECTIVE, languageDirective } from './system-prompt.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export const geminiConnector = {
  id: 'gemini',
  label: 'Gemini (Google AI Studio)',
  description: 'free tier, no card — bring your AI Studio key',
  needsKey: true,
  needsLocalServer: false,
  defaultDrawIllustrations: true,
  models: [
    { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash — recommended' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite — fastest' },
    { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro — most capable' },
  ],

  async testConnection({ key, model }) {
    if (!key) return { ok: false, error: 'add your Gemini key first' };
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'Say ok' }],
          max_tokens: 8,
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}${t ? ': ' + truncate(t, 160) : ''}` };
      }
      return { ok: true, info: 'auth ok — ready to draw' };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  },

  async ask(question, { withImage, key, model, language, onReply, onDone, onError }) {
    if (!key) return onError(new Error('add your Gemini key in settings'));
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
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
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
      return onError(new Error(`couldn't reach Gemini: ${e.message}`));
    }
    if (!response.ok) {
      const t = await response.text().catch(() => '');
      return onError(new Error(`Gemini HTTP ${response.status}${t ? ': ' + truncate(t, 240) : ''}`));
    }

    const extract = makeReplyExtractor(onReply);
    let fullText = '';
    try {
      for await (const delta of readOpenAISSE(response)) {
        if (delta) { fullText += delta; extract(delta); }
      }
    } catch (e) {
      return onError(new Error(`Gemini stream broke: ${e.message}`));
    }

    const inner = parseFinalJson(fullText);
    if (!inner) {
      return onError(new Error('Gemini output was not valid JSON\n— first 400 chars —\n' + fullText.slice(0, 400)));
    }
    onDone({
      spec: inner,
      meta: { duration_ms: Date.now() - t0, model: model || DEFAULT_MODEL, backend: 'gemini' },
    });
  },
};

// OpenAI-compatible SSE: lines like "data: { choices: [{ delta: { content }}]}".
export async function* readOpenAISSE(response) {
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
      if (payload === '[DONE]') return;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      const d = evt.choices?.[0]?.delta;
      const delta = typeof d?.content === 'string' ? d.content : '';
      if (delta) yield delta;
    }
  }
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
