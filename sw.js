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

const CACHE_NAME = 'wonderlab-models-v5';

// retry transient failures — large WebLLM downloads (~2-4 GB across
// 50+ shards) reliably hit a few 5xx / network blips on HF's CDN.
// Without retry, ONE failed shard kills the whole reload.
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [200, 600, 1500, 3000];

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

    let lastErr = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        // Use 'follow' redirect mode so we get the final response.
        const response = await fetch(req, { redirect: 'follow' });

        // 5xx and 408/429 are transient — retry. 4xx (except 408/429)
        // is the visitor's problem (auth/perm) — return as-is.
        if (response && response.status >= 500) { lastErr = new Error('5xx'); }
        else if (response && (response.status === 408 || response.status === 429)) { lastErr = new Error('rate-limit'); }
        else if (!response) { lastErr = new Error('no response'); }
        else if (response.status !== 200) {
          return response;       // 4xx — don't retry, surface to WebLLM
        }
        else {
          // 200 — cleanse if redirected so WebLLM's Cache.add accepts it
          let toReturn = response;
          if (response.redirected || response.type === 'opaqueredirect') {
            const body = await response.blob();
            const headers = new Headers();
            for (const k of ['content-type', 'content-length', 'cache-control', 'last-modified', 'etag']) {
              const v = response.headers.get(k);
              if (v) headers.set(k, v);
            }
            toReturn = new Response(body, { status: 200, statusText: 'OK', headers });
          }
          cache.put(req, toReturn.clone()).catch(() => {});
          return toReturn;
        }
      } catch (err) {
        lastErr = err;
      }

      // backoff before the next attempt (0/200/600/1500/3000ms-ish)
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt] || 1500));
      }
    }

    // all retries failed — try the cache one more time (in case another
    // tab populated it concurrently), otherwise return a network error
    const fallback = await cache.match(req);
    if (fallback) return fallback;
    console.warn('[wonderlab/sw] gave up after retries:', req.url, lastErr?.message);
    return Response.error();
  })());
});
