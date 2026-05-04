# wonderlab — CLAUDE.md

Handoff context for picking this up in a fresh chat.

## What this is, in one breath

A small lab room you walk into. A researcher (Claude, prompted to read who's talking and reply at their level) waits at a whiteboard. The visitor types any question or pulls one off the corkboard of real researcher questions. The researcher answers in plain language, draws what they're describing live in a 3D scene on the whiteboard, and tags the question against an open scientific question worth a real attempt.

## Where it came from

Started from a Hugging Science launch post by Georgia Channing (AI4Science @ Hugging Face / Oxford TVG). She put open scientific datasets, models, and benchmark leaderboards on Hugging Face — fusion stellarators, antibody developability, drug discovery, genomics. Their pitch literally complains: *"You shouldn't need to scrape arxiv, run your own wetlab, fight a custom HDF5 parser, build a fusion stellarator, and beg for compute before you've trained a single epoch."*

Comment thread:
- Baris: *"Still waiting for science for kids… should i do it myself?"*
- Georgia: *"Hmmmmm... what are you envisioning?"*
- This project is the answer.

The pitch is one layer Hugging Science doesn't currently fill:

**Translation layer** (the friend) — turns a normal question into a real scientific challenge submission, and turns the result back into language the asker understands. The 5yo is the stress test, not the user base — real users are anyone non-expert with intuition.

(Baris's WebGPU / kernel-fusion / P2P thesis is its own thing — it lives in his other repos and is **not** part of wonderlab. three.js handles the visualization here just fine. See "Things to actively avoid" below.)

## Current shape (this session)

three.js carries the visualization. The renderer is the SceneSpec → three.js loop, end of story. WebGPU is not on the roadmap.

```
/CLAUDE.md
/index.html                       — the lab room (full-page scene, all UI)
/server/server.js                 — Node http server. POST /api/ask spawns `claude -p`
/server/character.md              — the SOUL: who the researcher is (Feynman/Pólya/Sagan/Montessori synthesis)
/server/system-prompt.txt         — the CONTRACT: schema, banned words, visual palette, worked examples
/src/main.js                      — boots scene, hydrates corkboard, wires chat→/api/ask
/src/lab-scene.js                 — OUTER 3D world: floor, walls, desk, 3D researcher, whiteboard plane. Owns the renderer + the animation loop. The whiteboard's texture comes from a render-to-target pass of src/scene.js
/src/scene.js                     — INNER scene: macro/micro layers, zoom blend, slider. Renders to a WebGLRenderTarget (no own renderer; driven by lab-scene)
/src/macro.js                     — cartoon shapes (wedge, blob)
/src/micro.js                     — real-data shapes (rcsb PDB, inline-particles)
/src/specs/cheese.js              — opening demo SceneSpec (loads on page open)
/src/researcher-questions.js      — curated open researcher questions (sticky notes)
```

(The earlier WGSL splat renderer and PDB-splat adapter under `src/renderer/` and `src/adapters/` have been deleted. They were dead weight for the new scope.)

### Architecture (3 layers, what's live)

- **The room** — `index.html`. Children's-book lab aesthetic, hand-drawn ink lines + flat color. Researcher SVG figure, wooden-framed whiteboard with the 3D canvas, hanging desk lamp casting a warm glow on the board, posters pinned to the wall, coffee mug with steam, corkboard of real-researcher sticky notes, notepad with chat thread + answer card + chat input. Every UI element has a physical place in the room.
- **The renderer** — `src/scene.js` is a three.js scene with a macro layer (cartoon shape: cheese wedge, blob) and a micro layer (real data: PDB structure, particle cloud). Zoom blends macro→micro. The slider drives a unified interaction value (e.g. temperature) that both layers respond to. New scenes are loaded by `scene.play(spec)`.
- **The researcher** — `server/server.js` shells out to `claude -p` with `--system-prompt`, `--json-schema`, `--effort low`, `--output-format stream-json`, and `--include-partial-messages`. The endpoint streams the response as Server-Sent Events: `open` → many `reply` chunks (extracted from the StructuredOutput tool's `input_json_delta` stream) → `done` carrying the full `{ spec, meta }`. `spec` carries `level`, `reply`, `answer.{kid,real}`, `scene.{macro,micro,interaction}`, and `research.{open_question,benchmark}`. The bubble paints the reply character-by-character as it arrives.

### SceneSpec contract (the schema enforced server-side)

```jsonc
{
  "level":   "kid|curious|expert",
  "reply":   "PLAIN-WORDS only — companion to the picture, 2-3 sentences",
  "answer":  { "kid": "plain words, even simpler", "real": "BACKGROUND ONLY, never rendered — proper terminology lives here" },
  "scene": {
    "question": "rephrased as a 4-8 word plain-words title",
    "macro":    { "shape": "wedge|blob|sphere|torus|pair", "color": "#hex", "label": "...", "left": {...}, "right": {...} },
    "micro":    { "source": "rcsb|inline-particles", "id": "PDB-ID|null", "label": "..." },
    "interaction": {
      "type":  "slider",
      "label": "everyday word for what the slider does — 'how hot', 'temperature', 'how strong the magnet'",
      "macro": "soften|harden|none",
      "micro": "wiggle|unfold|break|cluster",
      "aha":   { "at": 0.0..1.0, "say": "one short kid-voice line at the threshold" }
    }
  },
  "research": {
    "open_question": "honest plain-words tie-in to a real open scientific question (BACKGROUND, not rendered)",
    "benchmark":     "Hugging Science / TDC / etc — null if no clean fit (BACKGROUND)"
  }
}
```

**The translation rule (encoded in the prompt and the architecture):** every visible field is plain-words only — kid-targeted, no jargon. The `answer.real` and `research.*` fields hold the technical version for backend benchmark connection but never paint to the DOM. The front-end's `paintSpec` reads only `question`, `answer.kid`, and `interaction.label` from the spec.

**Macro shapes (in `src/macro.js`):**
- `wedge` — cheese, pie, layered things
- `blob`  — last-resort amorphous lump
- `sphere` — egg/ball/drop/fruit (smooth, slight Y-stretch for egg shape)
- `torus` — fusion magnet trap, donut, racetrack — auto-generates faint field-line tori that brighten with the slider
- `pair` — TWO shapes side-by-side with floating labels under each, for compare-style teaching ("A vs B"). Asymmetric slider response: left ≈ control, right ≈ full effect.

**Adding a new shape/source = three coordinated edits:**
1. `src/macro.js` (or `src/micro.js`) — implement the factory returning `{ object, bounds, apply, setOpacity, tick, dispose }`.
2. `server/system-prompt.txt` — add to the WHITEBOARD CONSTRAINTS section with explicit "use this when…" guidance. The model's creativity is bounded by how well-described its options are.
3. `server/server.js` — extend the `enum` in `SCENE_SCHEMA`.

## How to run it

```sh
cd ~/wonder
node server/server.js
# → http://localhost:5173/
```

Env knobs:
- `PORT` (default `5173`)
- `WONDER_MODEL` (default `sonnet`; `haiku` is ~3× faster and ~5× cheaper)

The server uses the user's Claude Code CLI auth (OAuth via keychain). No API key needed. Each `/api/ask` call costs ~$0.05 on Sonnet, ~$0.01–0.05 on Haiku, and takes ~30–45s on Sonnet, ~30–35s on Haiku-4-5 with `--effort low`. The wall-clock time is dominated by Claude Code CLI init (the actual generation is fast and now streams to the client). The next big latency win is the SDK swap (next move #1) — that's where you'd cut init overhead to near-zero.

## Known gaps / next moves, in order

The whole bet from here is **translation quality + UI/UX polish**. Nothing on this list is a compute task.

1. **Latency.** `claude -p` re-initializes per call, which is ~5× slower than going straight to the Anthropic SDK. Right move: drop the CLI subprocess, hit the SDK directly with prompt caching on the system prompt. Same model, ~5× faster, same cost. Keep the CLI path as a fallback for users without an API key.
2. ~~**Streaming the reply.**~~ ✅ Done. Server emits SSE; the bubble streams char-by-char from `input_json_delta` partials of the StructuredOutput tool call. The `answer/scene/research` fields fill in on the final `done` event after the bubble has settled.
3. **More macro/micro shapes (in three.js).** Today: 5 macro (wedge, blob, sphere, torus, pair) × 2 micro (rcsb, inline-particles) × 4 effects. Cheap wins: a `chain` micro (polymer line that wiggles → tangles → locks — for the egg/protein-folding archetype), a `body` macro (silhouette + bloodstream for drug-delivery questions), a `cell-pair` micro (two cells with the same DNA, different genes lit — for the gene-regulation archetype). Each addition must serve a SPECIFIC teaching pattern, not a generic "more options".
4. **Real benchmark connections.** The system prompt currently asks Claude to *name* a benchmark family. Next step: actually link to the Hugging Face dataset/leaderboard for that benchmark when one fits, so the visitor can click through.
5. **Researcher-evaluates-the-visitor's-attempt.** The "researchers can evaluate after proposed solutions" loop the user wants. Sketch: when a question hits a benchmark, the room sprouts a "submit your guess" affordance, the AI runs a small model on the dataset using the visitor's framing, scores against baseline, and a real researcher (or a researcher persona) leaves a note. Big feature; not in this branch.
6. **Translation polish.** Tighten the system prompt with worked examples (jargon-in → plain-out, kid-in → real-research-tie-in), and make the corkboard's "how researchers say it" reveal symmetric with the answer card's reveal. The translation IS the product.
7. **UI/UX polish.** Mobile layout, focus states, the chat thread overflow behavior, the aha popup timing, the slider feel, the hover-on-sticky tactile response. The room should feel like a physical place.
8. ~~**Delete the vestigial WGSL/adapter dirs.**~~ ✅ Deleted.
9. **Reply to Georgia.** Owed reply with the cheese/eggs conversation example. Pitch the translation layer only — never the compute layer.

## Strategic context to preserve

- **wonderlab's bet, narrowed:** translation layer + UI/UX polish. Nothing else. three.js is enough for the visualization forever, as far as this project is concerned.
- **Baris's broader mission lives elsewhere:** democratizing intelligence on edge devices via WebGPU/WGSL/kernel-fusion/P2P (Zero-TVM, gpubench.dev, kernelfusion.dev, the-swarm, webgpu-p2p-evolution). That work is real and important — but it lives in those repos, not this one. Don't mix them.
- **Voice for external posts:** short, human, no links in the body of LinkedIn posts. Baris writes the actual posts; drafts should match his cadence, not corporate launch copy.
- **The 5yo framing is a stress test, not a target market.** Lean on "everyday questions → real science," not on the kid line.

## Things to actively avoid

- **Don't propose the compute layer for wonderlab.** No WebGPU, no WGSL, no gaussian splats, no kernel fusion, no P2P. three.js is enough; that's a settled scope decision. If the visualization needs to be richer, do it inside three.js.
- **Don't pitch wonderlab on a compute-layer story.** The pitch is the translation layer, full stop. (When replying to Georgia, when posting on LinkedIn, when explaining the project to anyone — translation only.)
- **Don't oversell the "kid does real science" framing.** Real scientific progress is gated by experiments, data, and compute — not by missing simple questions. The honest version is co-authoring research direction with a domain model. The honest version is the better story.
- **Don't break the SceneSpec contract silently.** New macro/micro/effect values need to land in three places at once: `macro.js` / `micro.js`, `server/system-prompt.txt` (whiteboard constraints), and `server/server.js` (JSON schema enum).
- **Don't let jargon leak to the surface.** Every visible string defaults to plain words; the technical version lives behind "how researchers say it" reveals. See `feedback_translation_layer.md` in memory.
