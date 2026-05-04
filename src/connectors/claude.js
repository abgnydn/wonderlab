// =============================================================
// connectors/claude.js — browser → Anthropic API directly.
// Requires the user's own API key (paste into settings).
// We rely on the documented `anthropic-dangerous-direct-browser-access`
// header, which the Anthropic API expects for browser-side calls
// (CORS is allowed when this header is set).
// =============================================================

import { makeReplyExtractor, parseFinalJson } from './extract.js';
import { getSystemPrompt, NO_IMAGE_DIRECTIVE, JSON_ONLY_DIRECTIVE } from './system-prompt.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';   // good balance for SVG quality + speed

export const claudeConnector = {
  id: 'claude',
  label: 'Claude (Anthropic)',
  description: 'best at drawing — bring your own API key',
  needsKey: true,
  needsLocalServer: false,
  defaultDrawIllustrations: true,
  models: [
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — recommended' },
    { id: 'claude-haiku-4-5',  label: 'Haiku 4.5 — faster + cheaper' },
    { id: 'claude-opus-4-7',   label: 'Opus 4.7 — most capable' },
  ],

  async testConnection({ key, model }) {
    if (!key) return { ok: false, error: 'add your key first' };
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: headersFor(key),
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Say ok' }],
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

  async ask(question, { withImage, key, model, onReply, onDone, onError }) {
    if (!key) return onError(new Error('add your Anthropic API key in settings'));
    const t0 = Date.now();
    let system;
    try { system = await getSystemPrompt(); }
    catch (e) { return onError(e); }

    const userMsg = (question || '')
      + JSON_ONLY_DIRECTIVE
      + (withImage === false ? NO_IMAGE_DIRECTIVE : '');

    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: headersFor(key),
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          max_tokens: withImage === false ? 2048 : 8192,
          stream: true,
          system,
          messages: [{ role: 'user', content: userMsg }],
        }),
      });
    } catch (e) {
      return onError(new Error(`couldn't reach Anthropic: ${e.message}`));
    }
    if (!response.ok) {
      const t = await response.text().catch(() => '');
      return onError(new Error(`Anthropic HTTP ${response.status}${t ? ': ' + truncate(t, 240) : ''}`));
    }

    const extract = makeReplyExtractor(onReply);
    let fullText = '';
    try {
      for await (const evt of readSSE(response)) {
        // Anthropic streaming events: content_block_delta with delta.type === 'text_delta'
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const t = evt.delta.text || '';
          if (t) { fullText += t; extract(t); }
        }
        // tool_use streaming uses input_json_delta — pass it through too in case the
        // model decides to use a tool block (we don't define one, but be defensive)
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
          const t = evt.delta.partial_json || '';
          if (t) { fullText += t; extract(t); }
        }
        if (evt.type === 'error') {
          return onError(new Error(evt.error?.message || 'Anthropic stream error'));
        }
      }
    } catch (e) {
      return onError(new Error(`Anthropic stream broke: ${e.message}`));
    }

    const inner = parseFinalJson(fullText);
    if (!inner) {
      return onError(new Error('Anthropic output was not valid JSON\n— first 400 chars —\n' + fullText.slice(0, 400)));
    }
    onDone({
      spec: inner,
      meta: { duration_ms: Date.now() - t0, model: model || DEFAULT_MODEL, backend: 'claude' },
    });
  },
};

function headersFor(key) {
  return {
    'content-type':                              'application/json',
    'x-api-key':                                 key,
    'anthropic-version':                         '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

// Simple SSE iterator — yields parsed JSON event objects from a Response body.
async function* readSSE(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      // each block has "event: foo" / "data: {...}" lines
      let dataLine = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) dataLine += line.slice(6);
      }
      if (!dataLine) continue;
      try { yield JSON.parse(dataLine); }
      catch { /* ignore non-json data line */ }
    }
  }
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
