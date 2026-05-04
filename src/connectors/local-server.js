// =============================================================
// connectors/local-server.js — wraps the existing dev server's
// /api/ask endpoint. Kept so hackers can still run wonderlab locally
// with Claude Code CLI auth (no API key paste). Probes for the route
// at startup so we can hide it on the static Cloudflare deploy.
// =============================================================

const ENDPOINT = '/api/ask';

export const localServerConnector = {
  id: 'local-server',
  label: 'Local dev server',
  description: 'runs through node server/server.js — uses your Claude Code CLI auth',
  needsKey: false,
  needsLocalServer: true,
  defaultDrawIllustrations: true,
  models: [],

  async isAvailable() {
    try {
      // HEAD against the same route — server returns 405 for HEAD which still
      // tells us it's mounted. fetch resolving without a network error is enough.
      const res = await fetch(ENDPOINT, { method: 'HEAD' });
      return res.status < 500;
    } catch {
      return false;
    }
  },

  async testConnection() {
    const ok = await this.isAvailable();
    return ok
      ? { ok: true, info: 'local dev server is up — Claude Code CLI auth in use' }
      : { ok: false, error: 'no /api/ask route — start `node server/server.js` first' };
  },

  async ask(question, { withImage, onReply, onDone, onError }) {
    const t0 = Date.now();
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, withImage }),
      });
    } catch (e) {
      return onError(new Error(`local server unreachable: ${e.message}`));
    }
    if (!response.ok) {
      const t = await response.text().catch(() => '');
      return onError(new Error(`local server HTTP ${response.status}: ${t.slice(0, 240)}`));
    }
    try {
      for await (const { event, data } of readSSE(response)) {
        if (event === 'reply')      onReply(data.text || '');
        else if (event === 'done')  onDone({ ...data, meta: { ...(data.meta || {}), duration_ms: Date.now() - t0 } });
        else if (event === 'error') return onError(new Error(data.error || 'local lab error'));
      }
    } catch (e) {
      return onError(new Error(`local server stream broke: ${e.message}`));
    }
  },
};

// Parse the SSE format the existing server emits: one event per "event:/data:"
// pair separated by a blank line.
async function* readSSE(response) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      let event = 'message';
      let dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      let data = null;
      try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
      yield { event, data };
    }
  }
}
