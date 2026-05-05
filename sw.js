// =============================================================
// sw.js — service worker that caches the Kokoro TTS model files
// (and any other huggingface assets) to disk on first download.
// Subsequent page loads serve them instantly from Cache Storage,
// regardless of whether transformers.js's own caching kicks in.
//
// Lives at the root of the site so its scope covers everything.
// Registered from src/main.js.
// =============================================================

const CACHE_NAME = 'wonderlab-models-v3';

// We ONLY shadow Kokoro / transformers.js asset paths. Anything else —
// especially WebLLM's model shards under huggingface.co/mlc-ai/* — must
// pass straight through, because:
//
//   • WebLLM uses Cache.add(url) on those shards itself.
//   • huggingface.co serves them as 302 redirects to xethub.hf.co.
//   • If we intercept, our fetch() follows the redirect, returns a
//     redirected Response, and WebLLM's Cache.add then rejects with
//     "encountered a network error" because Cache.add does NOT accept
//     redirected responses.
//
// Path-scoped allowlist instead of host-scoped — only Kokoro repos
// (huggingface.co/onnx-community/Kokoro*) and HF blob/resolve paths
// from the same org get our caching layer.
const KOKORO_PATH_RE = /^\/onnx-community\/Kokoro/i;

// Hosts that ONLY ever serve Kokoro / transformers.js bytes can stay
// fully shadowed by hostname (their CDN names — kept narrow on purpose).
const ALWAYS_SHADOW_HOSTS = [
  'cdn-lfs.huggingface.co',
  'cdn-lfs.hf.co',
];

self.addEventListener('install', (event) => {
  // activate this SW as soon as it's installed
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // wipe any pre-v2 caches we left behind so they don't poison new
    // requests that were intercepted under broader hostname rules
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n.startsWith('wonderlab-') && n !== CACHE_NAME)
        .map(n => caches.delete(n))
    );
    // take control of any open clients (so the very first page load
    // gets caching immediately, no second-refresh needed)
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // pass-through unless this is unambiguously a Kokoro/transformers asset:
  //   • CDN-LFS subdomain (always Kokoro/HF model bytes)
  //   • huggingface.co with a path under /onnx-community/Kokoro*
  // anything else (WebLLM repos under huggingface.co/mlc-ai/*, the rest
  // of the open web) escapes this SW completely.
  const isCdnLfs   = ALWAYS_SHADOW_HOSTS.includes(url.hostname);
  const isKokoroHf = url.hostname === 'huggingface.co' && KOKORO_PATH_RE.test(url.pathname);
  if (!isCdnLfs && !isKokoroHf) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) {
      // fast path — serve from disk cache
      return cached;
    }
    // not cached yet — fetch from network and write to cache
    try {
      const response = await fetch(req);
      // cache successful responses (2xx) and "no-content" 304s
      if (response && response.status === 200) {
        // clone before consuming since Response is one-shot
        cache.put(req, response.clone()).catch(() => {});
      }
      return response;
    } catch (err) {
      // network failure — return any partial cache match if available
      const fallback = await cache.match(req);
      return fallback || Response.error();
    }
  })());
});
