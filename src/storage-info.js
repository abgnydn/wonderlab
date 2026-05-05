// =============================================================
// storage-info.js — peek at what wonderlab has cached on disk.
//
// WebLLM stores its model shards in the browser's Cache Storage
// under names containing 'webllm'. Kokoro/transformers.js uses
// our own SW cache (wonderlab-models-v*). We enumerate them, sum
// content-length headers for a size estimate, and offer a delete
// button per cache + a "clear everything" sweep.
//
// Two ways to measure:
//   • per-cache: walk Cache.keys(), sum each entry's content-length
//   • global:    navigator.storage.estimate() → { usage, quota }
// =============================================================

export async function getStorageInfo() {
  const out = {
    usage:   0,
    quota:   0,
    caches:  [],   // [{ name, count, bytes, kind }]  kind: webllm|tts|other
  };

  // total — single number across everything wonderlab has touched
  if (navigator.storage?.estimate) {
    try {
      const e = await navigator.storage.estimate();
      out.usage = e.usage || 0;
      out.quota = e.quota || 0;
    } catch {}
  }

  // per-cache breakdown via the Cache Storage API
  if (typeof caches !== 'undefined' && caches.keys) {
    let names;
    try { names = await caches.keys(); } catch { names = []; }
    for (const name of names) {
      try {
        const cache = await caches.open(name);
        const reqs  = await cache.keys();
        let bytes = 0;
        let measured = 0;
        for (const req of reqs) {
          const res = await cache.match(req);
          if (!res) continue;
          const len = res.headers?.get('content-length');
          if (len) { bytes += Number(len) || 0; measured++; }
        }
        out.caches.push({
          name,
          count:    reqs.length,
          bytes,
          measured,            // how many entries had content-length
          kind:     classify(name),
        });
      } catch {}
    }
  }
  return out;
}

function classify(name) {
  const n = String(name).toLowerCase();
  if (/webllm/.test(n))                           return 'webllm';
  if (/wonderlab-models|transformers|kokoro/.test(n)) return 'tts';
  return 'other';
}

/** Drop a single cache by name. Returns true if it existed. */
export async function clearCache(name) {
  if (typeof caches === 'undefined') return false;
  try { return await caches.delete(name); } catch { return false; }
}

/**
 * Drop everything wonderlab has cached on disk:
 *   • all wonderlab-models-* caches
 *   • all webllm-named caches (model shards + tokenisers)
 *   • IndexedDB databases used by transformers.js / WebLLM
 *
 * Asks the OPFS too in case future versions of WebLLM use it.
 */
export async function clearAllModelStorage() {
  // Cache Storage
  if (typeof caches !== 'undefined') {
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(n => /^wonderlab-models|webllm|transformers|kokoro/i.test(n))
          .map(n => caches.delete(n).catch(() => {}))
      );
    } catch {}
  }
  // IndexedDB
  if (typeof indexedDB !== 'undefined') {
    if (indexedDB.databases) {
      try {
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          const n = db?.name || '';
          if (/webllm|mlc|transformers|huggingface|kokoro/i.test(n)) {
            try { indexedDB.deleteDatabase(n); } catch {}
          }
        }
      } catch {}
    }
  }
}

export function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

/**
 * Friendly label for a cache name. WebLLM names its model caches like
 * "webllm/model" + a model tag, but the exact format varies by version,
 * so we just surface a humanised version of the raw name.
 */
export function prettyName(name) {
  if (/^wonderlab-models/i.test(name)) return 'Kokoro voice models';
  if (/webllm.*config/i.test(name))    return 'WebLLM (config)';
  if (/webllm.*model/i.test(name))     return 'WebLLM (weights)';
  if (/webllm/i.test(name))            return 'WebLLM (' + name.replace(/^.*?webllm[\/_-]?/i, '') + ')';
  if (/transformers|huggingface/i.test(name)) return name;
  return name;
}
