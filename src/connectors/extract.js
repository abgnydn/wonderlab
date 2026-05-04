// =============================================================
// extract.js — shared streaming-JSON extractor for the connectors.
// The model is asked to emit a single JSON object (the SceneSpec).
// We watch the streaming text deltas, find the value of the "reply"
// field, and surface its characters to the UI as they arrive — so
// the speech bubble starts typing within a few hundred ms instead
// of waiting for the whole 30s response. After the stream ends, we
// JSON.parse the full text (with brace recovery).
// =============================================================

export function makeReplyExtractor(onDelta) {
  let state   = 'SEARCH';   // SEARCH → IN_VALUE → DONE
  let buf     = '';
  let pending = '';

  return function feed(text) {
    if (state === 'DONE') return;
    buf += text;

    if (state === 'SEARCH') {
      const m = buf.match(/"reply"\s*:\s*"/);
      if (!m) {
        // hold a tail in case the pattern straddles two chunks
        if (buf.length > 128) buf = buf.slice(-64);
        return;
      }
      buf = buf.slice(m.index + m[0].length);
      state = 'IN_VALUE';
    }

    if (state === 'IN_VALUE') {
      buf = pending + buf;
      pending = '';
      let out = '';
      let i = 0;
      while (i < buf.length) {
        const c = buf[i];
        if (c === '\\') {
          if (i + 1 >= buf.length) { pending = '\\'; break; }
          const n = buf[i + 1];
          const simple = { 'n':'\n', 't':'\t', 'r':'\r', '"':'"', '\\':'\\', '/':'/', 'b':'\b', 'f':'\f' };
          if (simple[n] !== undefined) { out += simple[n]; i += 2; continue; }
          if (n === 'u') {
            if (i + 6 > buf.length) { pending = buf.slice(i); break; }
            out += String.fromCharCode(parseInt(buf.slice(i + 2, i + 6), 16));
            i += 6; continue;
          }
          out += n; i += 2; continue;
        }
        if (c === '"') {
          if (out) onDelta(out);
          state = 'DONE';
          buf = '';
          return;
        }
        out += c; i++;
      }
      buf = '';
      if (out) onDelta(out);
    }
  };
}

// Parse the final JSON, recovering from any prose wrapping the model added
// (some smaller models emit "Sure, here's your JSON:" before the object).
export function parseFinalJson(fullText) {
  try { return JSON.parse(fullText); } catch {}
  const start = fullText.indexOf('{');
  const end   = fullText.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(fullText.slice(start, end + 1)); } catch {}
  }
  return null;
}
