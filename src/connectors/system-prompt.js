// =============================================================
// system-prompt.js — fetches the system prompt once and caches it.
// In dev (Node server) the URL is /server/system-prompt.txt.
// In Cloudflare deployment the same path will resolve to a static
// asset bundled into the deploy directory.
// =============================================================

const PROMPT_URL = '/system-prompt.txt';

let cached = null;
let inflight = null;

export function getSystemPrompt() {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch(PROMPT_URL, { cache: 'force-cache' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`couldn't load system prompt (HTTP ${res.status})`);
      cached = await res.text();
      return cached;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// User directive appended when illustration generation is OFF.
export const NO_IMAGE_DIRECTIVE =
  '\n\n[mode: text-only — do NOT include scene.illustration_svg. Skip the SVG entirely; ' +
  'fill in everything else as usual: reply, answer.kid, answer.real, scene.question, research.*]';

// User directive appended when JSON-only output is required.
export const JSON_ONLY_DIRECTIVE =
  '\n\nReply with a single JSON object matching the contract. No prose, no markdown fences, no /think.';
