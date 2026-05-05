// =============================================================
// sw.js — service worker that caches the Kokoro TTS model files
// (and any other huggingface assets) to disk on first download.
// Subsequent page loads serve them instantly from Cache Storage,
// regardless of whether transformers.js's own caching kicks in.
//
// Lives at the root of the site so its scope covers everything.
// Registered from src/main.js.
// =============================================================

const CACHE_NAME = 'wonderlab-models-v2';

// hostnames whose responses we want to cache forever.
// IMPORTANT: do NOT cover all of *.hf.co — WebLLM's model weights are
// served via cas-bridge.xethub.hf.co and stored under WebLLM's own
// internal Cache, which conflicts with this SW intercepting those
// requests (Cache.add() then fails with a network error). We only
// shadow the Kokoro / transformers.js CDNs, which are specifically:
const HF_HOSTS = [
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs.hf.co',
];

// hard exclude any subdomain we know belongs to WebLLM's pipeline,
// even if a future host rule accidentally matches them:
const SKIP_HOSTS = [
  'xethub.hf.co',                    // catches *.xethub.hf.co
  'cas-bridge.xethub.hf.co',
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

  // hard skip — WebLLM owns these
  if (SKIP_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    return;
  }

  // only intercept Kokoro / transformers.js CDN requests
  if (!HF_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    return;
  }

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
