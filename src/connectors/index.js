// =============================================================
// connectors/index.js — registry, persistence, the public ask().
//
// Settings are stored in localStorage (browser-only). The user's API
// keys never leave their machine — wonderlab has no server to ship
// them to.
// =============================================================

import { claudeConnector }      from './claude.js';
import { geminiConnector }      from './gemini.js';
import { webllmConnector }      from './webllm.js';
import { lmstudioConnector }    from './lmstudio.js';
import { localServerConnector } from './local-server.js';

export const CONNECTORS = {
  claude:        claudeConnector,
  gemini:        geminiConnector,
  webllm:        webllmConnector,
  lmstudio:      lmstudioConnector,
  'local-server': localServerConnector,
};

// Settings shape (per-connector). Persisted in localStorage under one key.
//   { backend: 'webllm',
//     keys:     { claude: 'sk-…', gemini: 'AI…' },
//     models:   { claude: '…', gemini: '…', webllm: '…', lmstudio: '…' },
//     lmstudioUrl: 'http://…',
//     drawIllustrations: true | false (per-backend default if unset),
//     language: 'auto' | 'en' | 'tr' | … }
const STORE_KEY = 'wonderlab.connector.settings.v1';

const defaultSettings = () => ({
  backend: null,           // null → resolved at boot from recommendation
  keys:    {},
  models:  {},
  lmstudioUrl: 'http://localhost:1234/v1/chat/completions',
  drawIllustrations: null, // null → fall back to the connector's default
  language: 'auto',        // 'auto' resolves from navigator.language
});

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw);
    return { ...defaultSettings(), ...parsed, keys: { ...parsed.keys }, models: { ...parsed.models } };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {}
}

export function clearSettings() {
  try { localStorage.removeItem(STORE_KEY); } catch {}
}

export function getActiveConnector(settings = loadSettings()) {
  return CONNECTORS[settings.backend] || null;
}

// Convenience: resolve the per-backend params (key / model / url) from settings,
// merge in the question + callbacks, and dispatch to the connector.
export async function ask(question, settings, callbacks) {
  const conn = getActiveConnector(settings);
  if (!conn) {
    return callbacks.onError(new Error('no backend chosen — open settings to pick one'));
  }
  const params = {
    withImage: resolveDrawIllustrations(settings, conn),
    key:    settings.keys[conn.id] || '',
    model:  settings.models[conn.id] || '',
    url:    conn.id === 'lmstudio' ? settings.lmstudioUrl : undefined,
    language: settings.language || 'auto',
  };
  return conn.ask(question, { ...params, ...callbacks });
}

export function resolveDrawIllustrations(settings, conn) {
  if (typeof settings.drawIllustrations === 'boolean') return settings.drawIllustrations;
  return conn?.defaultDrawIllustrations ?? true;
}
