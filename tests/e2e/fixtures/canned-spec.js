// =============================================================
// tests/e2e/fixtures/canned-spec.js — a known-good SceneSpec used
// to mock the Gemini streamGenerateContent endpoint. The visible
// fields (reply, answer.kid, scene.draw labels, scene.question)
// must contain NO banned words from system-prompt.txt — that's the
// translation-rule invariant the tests assert.
// =============================================================

export const CANNED_SPEC = {
  level: 'curious',
  reply: "Heat makes the tiny strings in an egg tangle up. Once they are in a knot, they stay that way.",
  answer: {
    kid: "Heat ties the tiny strings into a knot. You cannot untie a knot by getting cold.",
    real: "Cooking irreversibly denatures egg proteins by disrupting weak bonds, allowing them to refold into stable aggregates.",
    glossary: [
      { kid_word: 'tiny strings', real_term: 'protein chains' },
      { kid_word: 'tangle up',    real_term: 'denature' },
      { kid_word: 'knot',         real_term: 'aggregate' },
    ],
  },
  scene: {
    question: "why can't a cooked egg go back?",
    draw: [
      { k: 'sphere',   x: 180, y: 260, color: 'cream',  label: 'raw — strings loose' },
      { k: 'squiggle', x: 180, y: 260 },
      { k: 'arrow',    x1: 310, y1: 270, x2: 490, y2: 270, label: 'heat ↑' },
      { k: 'sphere',   x: 610, y: 260, color: 'yellow', label: 'cooked — strings knotted' },
      { k: 'tangle',   x: 610, y: 270 },
    ],
  },
  research: {
    open_question: 'how stable does a protein stay as it folds and unfolds?',
    benchmark: 'Hugging Science protein-stability',
  },
  follow_ups: [
    'what do you think happens if you cook a clear egg white slowly?',
    'what do you think happens if you try to uncook it in cold water?',
  ],
  field: 'food',
};

// Banned words from system-prompt.txt that MUST NOT appear in any
// visible UI text. The translation rule says glossary.real_term,
// answer.real, and research.* are background-only and never render.
export const BANNED_WORDS = [
  'protein', 'molecule', 'atom', 'cell', 'DNA', 'gene', 'plasma',
  'neuron', 'antibody', 'enzyme', 'chromosome', 'receptor', 'membrane',
  'mitochondria', 'denature', 'aggregate', 'polymer', 'ion', 'electron',
  'proton', 'quantum', 'radiation', 'nucleus', 'stellarator', 'tokamak',
  'transcription', 'genome', 'synapse', 'neurotransmitter', 'catalyst',
  'oxidation', 'combustion', 'viscosity', 'spectrum', 'wavelength',
];

// Build an SSE body for Gemini's streamGenerateContent in structured-
// output mode (responseMimeType: 'application/json' + responseSchema).
// The model emits the JSON object as text deltas; one chunk is enough
// for the connector to assemble + parse on completion.
export function makeSSE(spec = CANNED_SPEC) {
  const chunk = {
    candidates: [{
      content: {
        parts: [{ text: JSON.stringify(spec) }],
      },
    }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}
