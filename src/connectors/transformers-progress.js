// =============================================================
// connectors/transformers-progress.js — pure progress aggregator
// for Transformers.js's per-file progress callback.
//
// Transformers.js emits events for each ONNX shard as it downloads:
//   { status: 'initiate',  file: 'tokenizer.json' }
//   { status: 'progress',  file: 'tokenizer.json', loaded: 50,   total: 100 }
//   { status: 'progress',  file: 'tokenizer.json', loaded: 100,  total: 100 }
//   { status: 'done',      file: 'tokenizer.json' }
//   …repeats for each shard…
//   { status: 'ready' }
//
// If we report each file's loaded/total ratio raw, the bar resets to
// 0% every time a new shard starts. This aggregator:
//   1. Tracks every file's latest (loaded, total) in a Map.
//   2. Reports the SUM, so progress reflects whole-download not shard.
//   3. Clamps with a monotonic high-water mark so the value never
//      decreases as new shards are discovered and inflate the
//      denominator.
//   4. Returns empty `text` — the UI already renders "downloading
//      the model… N%" as the headline; shard filenames are noise.
//
// Pure for testability — no DOM, no module-level state.
// =============================================================

export function makeProgressAggregator() {
  const fileState = new Map();      // file → { loaded, total }
  let highWater = 0;                // monotonic 0..1
  let ready = false;

  function onEvent(p) {
    if (!p || typeof p !== 'object') return { progress: highWater, text: '' };

    if (p.file && (typeof p.loaded === 'number' || typeof p.total === 'number')) {
      const cur = fileState.get(p.file) || { loaded: 0, total: 0 };
      if (typeof p.loaded === 'number') cur.loaded = p.loaded;
      if (typeof p.total  === 'number') cur.total  = p.total;
      fileState.set(p.file, cur);
    }
    if (p.status === 'done' && p.file) {
      const cur = fileState.get(p.file);
      if (cur && cur.total > 0) cur.loaded = cur.total;
    }
    if (p.status === 'ready') ready = true;

    let loadedSum = 0, totalSum = 0;
    for (const v of fileState.values()) {
      loadedSum += v.loaded;
      totalSum  += v.total;
    }
    let fraction;
    if (ready) fraction = 1;
    else if (totalSum > 0) fraction = Math.min(1, loadedSum / totalSum);
    else fraction = 0;

    if (fraction > highWater) highWater = fraction;
    return { progress: highWater, text: '' };
  }

  return { onEvent };
}
