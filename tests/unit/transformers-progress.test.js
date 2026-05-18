// =============================================================
// tests/unit/transformers-progress.test.js
//
// Pure unit tests for the Transformers.js progress aggregator.
// Runs in Node directly — no browser, no ONNX download.
//
//   node --test tests/unit/transformers-progress.test.js
// =============================================================

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeProgressAggregator } from '../../src/connectors/transformers-progress.js';

// Reusable: feed events sequentially and collect outputs.
function run(events) {
  const agg = makeProgressAggregator();
  return events.map((e) => agg.onEvent(e));
}

test('text field is always empty (no shard filenames leak to UI)', () => {
  const out = run([
    { status: 'initiate', file: 'model.onnx_data' },
    { status: 'progress', file: 'model.onnx_data', loaded:  50, total: 100 },
    { status: 'progress', file: 'model.onnx_data', loaded: 100, total: 100 },
    { status: 'done',     file: 'model.onnx_data' },
    { status: 'ready' },
  ]);
  for (const r of out) {
    assert.equal(r.text, '', 'text should always be empty');
  }
});

test('single file: progress moves 0 → 1 monotonically', () => {
  const out = run([
    { status: 'initiate', file: 'a' },
    { status: 'progress', file: 'a', loaded:   0, total: 100 },
    { status: 'progress', file: 'a', loaded:  25, total: 100 },
    { status: 'progress', file: 'a', loaded:  60, total: 100 },
    { status: 'progress', file: 'a', loaded: 100, total: 100 },
    { status: 'done',     file: 'a' },
  ]);
  const ps = out.map((r) => r.progress);
  assert.deepEqual(ps.map((p) => Math.round(p * 100)), [0, 0, 25, 60, 100, 100]);

  // Strictly non-decreasing.
  for (let i = 1; i < ps.length; i++) {
    assert.ok(ps[i] >= ps[i - 1], `progress regressed at step ${i}: ${ps[i - 1]} → ${ps[i]}`);
  }
});

test('multi-file: progress NEVER decreases when a new shard starts', () => {
  const out = run([
    // file a downloads fully
    { status: 'initiate', file: 'a' },
    { status: 'progress', file: 'a', loaded: 100, total: 100 },
    { status: 'done',     file: 'a' },
    // ← without monotonic clamp this is where the bar would jump back to ~0%
    { status: 'initiate', file: 'b' },
    { status: 'progress', file: 'b', loaded:   0, total: 400 },
    { status: 'progress', file: 'b', loaded: 200, total: 400 },
    { status: 'progress', file: 'b', loaded: 400, total: 400 },
    { status: 'done',     file: 'b' },
    { status: 'ready' },
  ]);
  const ps = out.map((r) => r.progress);

  // After file a's first real progress event we should be at 100%
  // (only file known so far, loaded=total=100). The regression check
  // catches the bug we're fixing — without monotonic clamp, the bar
  // would slide back to ~0% the moment file b shows up.
  assert.equal(ps[1], 1, 'a fully loaded → 100% (only file known so far)');
  for (let i = 1; i < ps.length; i++) {
    assert.ok(ps[i] >= ps[i - 1], `progress regressed at step ${i}: ${ps[i - 1]} → ${ps[i]}`);
  }
  assert.equal(ps[ps.length - 1], 1, 'final ready event → 100%');
});

test('aggregates correctly across multiple files when they download in parallel', () => {
  const agg = makeProgressAggregator();
  // Two files, both with total=100, downloading interleaved.
  agg.onEvent({ status: 'initiate', file: 'a' });
  agg.onEvent({ status: 'initiate', file: 'b' });
  const r1 = agg.onEvent({ status: 'progress', file: 'a', loaded: 50, total: 100 });
  const r2 = agg.onEvent({ status: 'progress', file: 'b', loaded: 50, total: 100 });
  // 50 + 50 of 200 total = 50%
  assert.equal(Math.round(r2.progress * 100), 50);

  const r3 = agg.onEvent({ status: 'progress', file: 'a', loaded: 100, total: 100 });
  // 100 + 50 of 200 = 75%
  assert.equal(Math.round(r3.progress * 100), 75);

  const r4 = agg.onEvent({ status: 'progress', file: 'b', loaded: 100, total: 100 });
  assert.equal(r4.progress, 1);
});

test('ready event clamps to 100% even if totals were stale', () => {
  const out = run([
    { status: 'initiate', file: 'a' },
    { status: 'progress', file: 'a', loaded: 80, total: 100 },
    { status: 'ready' },
  ]);
  assert.equal(out[out.length - 1].progress, 1);
});

test('malformed events do not crash; previous high-water is preserved', () => {
  const agg = makeProgressAggregator();
  agg.onEvent({ status: 'progress', file: 'a', loaded: 100, total: 100 });
  const r1 = agg.onEvent(null);
  const r2 = agg.onEvent(undefined);
  const r3 = agg.onEvent({});
  for (const r of [r1, r2, r3]) {
    assert.equal(r.progress, 1, 'high-water held across malformed events');
    assert.equal(r.text, '');
  }
});
