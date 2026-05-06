// =============================================================
// benchmarks.js — small lookup so iris's named benchmark
// (`research.benchmark` in the SceneSpec) becomes a real URL.
//
// We match loosely (lowercased, ignoring punctuation) so small
// model variations like "Therapeutic Data Commons" / "TDC" /
// "tdc-adme" all resolve to the same canonical destination.
//
// The whole reason this file exists: turn "the kid asked, here's
// a real benchmark family" into a one-click bridge to that family's
// upstream page. That click is the wonderlab pitch in two clicks
// of CSS.
// =============================================================

// First match wins, so order MOST-SPECIFIC → least. The Hugging
// Science org page is a strong fallback, so anything science-flavored
// that we don't recognize specifically still routes somewhere real.
const ENTRIES = [
  // ── Hugging Science specific themes ─────────────────────────
  // Their org launched with: protein stability, antibody devel.,
  // fusion / stellarator, drug discovery, single-cell genomics.
  // We deep-link the umbrella; their org page is the discovery hub.
  { match: /protein.?stab|protein.?fold|protein.?struct|stability/i,
    label: 'Hugging Science · protein stability',
    note:  'open scientific challenge — train a model to predict how stable a protein stays as it folds and unfolds',
    url:   'https://huggingface.co/Hugging-Science' },

  { match: /antibod|developability|immunogenic/i,
    label: 'Hugging Science · antibody developability',
    note:  'predict whether a candidate antibody will behave well in the lab and the body',
    url:   'https://huggingface.co/Hugging-Science' },

  { match: /stellarator|tokamak|fusion|plasma.?confine/i,
    label: 'Hugging Science · fusion / stellarator',
    note:  'help shape the magnetic trap that holds super-hot fuel for fusion energy',
    url:   'https://huggingface.co/Hugging-Science' },

  // Sub-area of Hugging Science but with its own first-class home.
  { match: /alphafold|protein.?structure.?predict/i,
    label: 'AlphaFold Database',
    note:  '200M+ predicted protein structures, free to browse and download',
    url:   'https://alphafold.ebi.ac.uk/' },

  { match: /\brcsb\b|protein.?data.?bank|\bpdb\b/i,
    label: 'RCSB Protein Data Bank',
    note:  'every solved protein structure since the 1970s, free to download',
    url:   'https://www.rcsb.org/' },

  // Catch-all for the org itself
  { match: /hugging.?science|hf.?science|hugscience/i,
    label: 'Hugging Science',
    note:  "Hugging Face's open-science hub — datasets, models, and benchmarks for real research questions",
    url:   'https://huggingface.co/Hugging-Science' },

  // ── Therapeutic Data Commons ────────────────────────────────
  // Has named sub-tasks (ADMET, DTI, etc.) we could deep-link, but
  // their docs landing is the cleanest single entry point.
  { match: /\badmet\b|absorption.?distribution.?metab/i,
    label: 'TDC · ADMET',
    note:  'predict how a drug moves through the body — absorption, metabolism, toxicity',
    url:   'https://tdcommons.ai/single_pred_tasks/adme/' },

  { match: /drug.?target.?interaction|\bdti\b/i,
    label: 'TDC · drug–target interaction',
    note:  'which drug binds which target — a classic open ML benchmark',
    url:   'https://tdcommons.ai/multi_pred_tasks/dti/' },

  { match: /therapeutic.?data.?commons|^tdc$|tdcommons|drug.?discovery.?bench/i,
    label: 'Therapeutic Data Commons',
    note:  '70+ AI-ready datasets and benchmarks for drug discovery and development',
    url:   'https://tdcommons.ai/' },

  // ── Open Problems in single-cell ────────────────────────────
  { match: /open.?problems|openproblems|single.?cell.?genom|scrnaseq/i,
    label: 'Open Problems in Single-Cell',
    note:  'community benchmarks for the algorithms that read individual cells',
    url:   'https://openproblems.bio/' },

  // ── Climate / earth ─────────────────────────────────────────
  { match: /climate.?bench|weather.?bench|chaosbench/i,
    label: 'WeatherBench / ClimateBench',
    note:  'forecast benchmarks the climate-ML community uses to compare models',
    url:   'https://huggingface.co/datasets?search=weatherbench' },

  // ── Astronomy / physics ─────────────────────────────────────
  { match: /\bsdss\b|sloan.?digital/i,
    label: 'Sloan Digital Sky Survey',
    note:  'deep imaging + spectra of half a billion stars and galaxies',
    url:   'https://www.sdss.org/' },

  { match: /\beuclid\b.*(satellite|telescope|esa)|euclid.?survey/i,
    label: 'ESA Euclid mission',
    note:  '6-year survey of dark matter and dark energy across a third of the sky',
    url:   'https://www.esa.int/Science_Exploration/Space_Science/Euclid' },

  // ── Materials / chemistry ───────────────────────────────────
  { match: /materials.?project|matbench/i,
    label: 'Materials Project',
    note:  'open database of computed material properties — free to query',
    url:   'https://next-gen.materialsproject.org/' },

  // ── Genomics / biomed ───────────────────────────────────────
  { match: /1000.?genomes|encode.?project/i,
    label: '1000 Genomes Project',
    note:  'reference catalogue of human genetic variation',
    url:   'https://www.internationalgenome.org/' },

  // ── ML benchmarks people will name ──────────────────────────
  { match: /papers.?with.?code|\bpwc\b/i,
    label: 'Papers with Code',
    note:  'leaderboards and code links for ML benchmarks across every domain',
    url:   'https://paperswithcode.com/' },

  // generic fall-back: search Hugging Face for the term
];

/**
 * Resolve a benchmark string from the SceneSpec to a { label, url, note, raw } pair.
 * Returns null when the input is empty / null / "none" / explicitly unmappable.
 *
 * `note` is a one-line plain-words description we can show in the chip's hover
 * tooltip — it's optional, so older callers that only read label/url still work.
 */
export function resolveBenchmark(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (/^(none|null|n\/a|—|-)$/i.test(trimmed)) return null;
  for (const e of ENTRIES) {
    if (e.match.test(trimmed)) {
      return { label: e.label, url: e.url, note: e.note || '', raw: trimmed };
    }
  }
  // unmapped — return the raw name with a search URL so the link still works
  const q = encodeURIComponent(trimmed + ' benchmark');
  return {
    label: trimmed,
    url:   `https://huggingface.co/datasets?search=${q}`,
    note:  '',
    raw:   trimmed,
  };
}
