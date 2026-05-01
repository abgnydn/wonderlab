// Hand-written scene spec. The shape AI generation will fill later.
export const cheeseSpec = {
  id: 'cheese-stringy',
  question: "why does cheese get stringy when it's hot?",

  answer: {
    kid:  "Cheese has tiny tangled strings inside it. Heat unwads the strings, so they slide and stretch past each other — that's the cheese pull.",
    real: "Casein proteins form a calcium-phosphate-crosslinked gel. Above ~60 °C the crosslinks weaken; chains slide past each other under tension, producing the characteristic melt-stretch.",
  },

  macro: { shape: 'wedge', color: '#f5cf5b', label: 'cheese' },

  // 1UBQ stands in for casein here — RCSB does not host a clean casein
  // structure (it's intrinsically disordered). Honest stand-in for now.
  micro: { source: 'rcsb', id: '1UBQ', label: 'a protein chain (ubiquitin stand-in)' },

  interaction: {
    type:  'slider',
    label: 'temperature',
    macro: 'soften',
    micro: 'wiggle',
    aha:   { at: 0.7, say: 'feel that — the strings are loose enough to slide past each other now.' },
  },
};
