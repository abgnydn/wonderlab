// =============================================================
// benchmarks.js — small lookup so iris's named benchmark
// (`research.benchmark` in the SceneSpec) becomes a real URL.
//
// We match loosely (lowercased, ignoring punctuation) so small
// model variations like "Therapeutic Data Commons" / "TDC" /
// "tdc-adme" all resolve to the same canonical destination.
// =============================================================

const ENTRIES = [
  // Hugging Science — the org page is the umbrella; specific datasets
  // sit under it. We default to the org page and override for known
  // sub-collections.
  { match: /hugging.?science|hf.?science|hugscience/i,
    label: 'Hugging Science',
    url:   'https://huggingface.co/Hugging-Science' },

  { match: /protein.?stab|protein.?fold|stability/i,
    label: 'Hugging Science · protein stability',
    url:   'https://huggingface.co/Hugging-Science' },

  { match: /antibod|developability/i,
    label: 'Hugging Science · antibody developability',
    url:   'https://huggingface.co/Hugging-Science' },

  { match: /stellarator|fusion/i,
    label: 'Hugging Science · fusion / stellarator',
    url:   'https://huggingface.co/Hugging-Science' },

  // Therapeutic Data Commons
  { match: /therapeutic.?data.?commons|^tdc$|tdcommons/i,
    label: 'Therapeutic Data Commons',
    url:   'https://tdcommons.ai/' },

  // Open Problems in single-cell
  { match: /open.?problems|openproblems|single.?cell.?genomics/i,
    label: 'Open Problems in Single-Cell',
    url:   'https://openproblems.bio/' },

  // generic fall-back: search Hugging Face for the term
];

/**
 * Resolve a benchmark string from the SceneSpec to a { label, url } pair.
 * Returns null when the input is empty / null / "none" / unmappable.
 */
export function resolveBenchmark(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (/^(none|null|n\/a|—)$/i.test(trimmed)) return null;
  for (const e of ENTRIES) {
    if (e.match.test(trimmed)) {
      return { label: e.label, url: e.url, raw: trimmed };
    }
  }
  // unmapped — return the raw name with a search URL so the link still works
  const q = encodeURIComponent(trimmed + ' benchmark');
  return {
    label: trimmed,
    url:   `https://huggingface.co/datasets?search=${q}`,
    raw:   trimmed,
  };
}
