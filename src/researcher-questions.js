// =============================================================
// The corkboard: questions a kid (or curious adult) would ACTUALLY
// wonder about, rooted in their own life. Trimmed for compact
// display — long versions kept as comments below for reference.
//
// `text`  — what shows on the sticky (kept short — fits 2-3 lines)
// `real`  — the original technical research question (background only)
// `by`    — warm "scientists work on this too" by-line
// =============================================================

export const researcherQuestions = [
  {
    id:    'protein-stability',
    badge: 'the egg trick',
    by:    'protein scientists wonder about this too',
    text:  "Why does a cooked egg never go back to runny?",
    real:  "Why does this protein fall apart at body temperature when its closest relative survives in a hot spring?",
  },
  {
    id:    'antibody-developability',
    badge: 'fridge medicine',
    by:    'medicine designers are stuck on this',
    text:  "Why do some medicines need the fridge but aspirin doesn't?",
    real:  "We have an antibody that binds beautifully but aggregates in the vial — what's the cheapest sequence change that fixes it without losing affinity?",
  },
  {
    id:    'tdc-admet',
    badge: 'medicine in your body',
    by:    "drug designers work on this",
    text:  "How does headache medicine know to go to your head?",
    real:  "Why does this drug candidate hit the target but never reach the brain?",
  },
  {
    id:    'fusion-stellarator',
    badge: 'a sun on earth',
    by:    'fusion scientists are trying this',
    text:  "Could we ever build a tiny sun on earth?",
    real:  "What exactly is wrecking the confinement at the stellarator's edge?",
  },
  {
    id:    'genomics-perturbation',
    badge: 'same DNA, different cells',
    by:    'biologists are still figuring this out',
    text:  "Same instructions in every cell — why are eyes and hair so different?",
    real:  "Knocking out this transcription factor in one cell line silences the program; in another it makes it louder. Why?",
  },
];
