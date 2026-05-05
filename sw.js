// =============================================================
// sw.js — service worker for wonderlab.
//
// Two jobs, neither of which is a generic CDN cache:
//
//   1. Kokoro / transformers.js: shadow huggingface.co/onnx-community/
//      Kokoro* and *.hf.co CDN bytes so first-load latency only
//      happens once per visitor.
//
//   2. WebLLM × HuggingFace redirect cleansing.
//      WebLLM's internal Cache.add() rejects any Response with
//      `response.redirected === true`. HuggingFace serves the model
//      shards as 302 redirects (huggingface.co → xethub.hf.co →
//      cas-bridge.xethub.hf.co), which means the FINAL response the
//      browser hands WebLLM always has redirected:true and the
//      Cache.add() call crashes with "encountered a network error".
//      That's the error visitors see when they pick WebLLM and ask
//      a question for the first time.
//
//      The fix: intercept the request here, follow the redirect
//      ourselves, then construct a NEW Response from the body —
//      that new Response has redirected:false, so WebLLM's
//      Cache.add() accepts it cleanly.
//
// Lives at the root so its scope covers everything.
// =============================================================

const CACHE_NAME = 'wonderlab-models-v4';

// Kokoro/transformers asset matchers
const KOKORO_PATH_RE = /^\/onnx-community\/Kokoro/i;
const KOKORO_HOSTS = [
  'cdn-lfs.huggingface.co',
  'cdn-lfs.hf.co',
];

// WebLLM model matchers — both the canonical HF repo path AND the
// xethub redirect target. Both need cleansing because the redirect
// chain trips Cache.add() either way.
const WEBLLM_PATH_RE = /\/mlc-ai\//i;
const WEBLLM_HOSTS = [
  'cas-bridge.xethub.hf.co',
  'xethub.hf.co',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // wipe any older wonderlab caches so requests can't be served from
    // pre-fix entries that may carry the redirected flag
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n.startsWith('wonderlab-') && n !== CACHE_NAME)
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  const isKokoroCdn   = KOKORO_HOSTS.includes(url.hostname);
  const isKokoroHf    = url.hostname === 'huggingface.co' && KOKORO_PATH_RE.test(url.pathname);
  const isWebllmHf    = url.hostname === 'huggingface.co' && WEBLLM_PATH_RE.test(url.pathname);
  const isWebllmCdn   = WEBLLM_HOSTS.includes(url.hostname);
  const needsCleansing = isWebllmHf || isWebllmCdn;
  const wantsHandling  = isKokoroCdn || isKokoroHf || needsCleansing;

  if (!wantsHandling) return;

  event.respondWith((async () => {
    const cache  = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      // Use 'follow' redirect mode so we get the final response.
      const response = await fetch(req, { redirect: 'follow' });
      if (!response || response.status !== 200) return response;

      // If the browser flagged this response as redirected (or its type
      // is opaqueredirect / opaque), Cache.add() will reject it.
      // Rebuild a fresh Response from the body so redirected:false.
      let toReturn = response;
      if (response.redirected || response.type === 'opaqueredirect') {
        const body = await response.blob();
        // copy a useful subset of headers (Cache-Control, Content-Type,
        // Content-Length) — strip ones that don't make sense on a fresh
        // synthesised response (e.g., Date, Server, X-Amz-*)
        const headers = new Headers();
        for (const k of ['content-type', 'content-length', 'cache-control', 'last-modified', 'etag']) {
          const v = response.headers.get(k);
          if (v) headers.set(k, v);
        }
        toReturn = new Response(body, {
          status:     200,
          statusText: 'OK',
          headers,
        });
      }

      // cache for next visit (use a cleansed clone so cache.put never
      // sees a redirected response either)
      cache.put(req, toReturn.clone()).catch(() => {});
      return toReturn;
    } catch (err) {
      const fallback = await cache.match(req);
      return fallback || Response.error();
    }
  })());
});
