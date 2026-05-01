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

The pitch has two layers Hugging Science doesn't currently fill:

1. **Translation layer** (the friend) — turns a normal question into a real scientific challenge submission, and turns the result back into language the asker understands. The 5yo is the stress test, not the user base — real users are anyone non-expert with intuition.
2. **Compute layer** (Baris's territory) — P2P + WebGPU + kernel fusion (Zero-TVM, gpubench.dev). Runs inference and live visualization in the browser on whatever device the person already has.

The visualization piece is where Baris's kernel-fusion thesis lands honestly: standard splat libraries do projection / sort / rasterization as separate dispatches, which is exactly the dispatch-overhead bottleneck his preprints describe.

## Current shape (this session)

The project moved off the WebGPU splat path for now and onto a working three.js scene, so we could ship the *room* end-to-end and prove the LLM-as-researcher loop. The WGSL renderer is still in `src/renderer/` and the PDB-splat adapter in `src/adapters/` — kept as future work, not currently wired in.

```
/CLAUDE.md
/index.html                       — the lab room (full-page scene, all UI)
/server/server.js                 — Node http server. POST /api/ask spawns `claude -p`
/server/system-prompt.txt         — researcher persona + JSON SceneSpec contract
/src/main.js                      — boots scene, hydrates corkboard, wires chat→/api/ask
/src/scene.js                     — three.js Scene: macro/micro layers, zoom blend, slider
/src/macro.js                     — cartoon shapes (wedge, blob)
/src/micro.js                     — real-data shapes (rcsb PDB, inline-particles)
/src/specs/cheese.js              — opening demo SceneSpec (loads on page open)
/src/researcher-questions.js      — curated open researcher questions (sticky notes)
/src/renderer/splat.wgsl          — [parked] WGSL fused splat renderer
/src/renderer/splat-renderer.js   — [parked] WebGPU host
/src/adapters/pdb-adapter.js      — [parked] WebGPU PDB→splat adapter
```

### Architecture (3 layers, what's live)

- **The room** — `index.html`. Children's-book lab aesthetic, hand-drawn ink lines + flat color. Researcher SVG figure, wooden-framed whiteboard with the 3D canvas, hanging desk lamp casting a warm glow on the board, posters pinned to the wall, coffee mug with steam, corkboard of real-researcher sticky notes, notepad with chat thread + answer card + chat input. Every UI element has a physical place in the room.
- **The renderer** — `src/scene.js` is a three.js scene with a macro layer (cartoon shape: cheese wedge, blob) and a micro layer (real data: PDB structure, particle cloud). Zoom blends macro→micro. The slider drives a unified interaction value (e.g. temperature) that both layers respond to. New scenes are loaded by `scene.play(spec)`.
- **The researcher** — `server/server.js` shells out to `claude -p` with `--system-prompt` (the researcher persona) and `--json-schema` (validated SceneSpec). Returns `{ spec, meta }` where `spec` carries `level`, `reply`, `answer.{kid,real}`, `scene.{macro,micro,interaction}`, and `research.{open_question,benchmark}`.

### SceneSpec contract (the schema enforced server-side)

```jsonc
{
  "level":   "kid|curious|expert",
  "reply":   "researcher's voice, short paragraph at the asker's level",
  "answer":  { "kid": "...", "real": "..." },
  "scene": {
    "question": "rephrased as a 4-8 word title",
    "macro":    { "shape": "wedge|blob", "color": "#hex", "label": "..." },
    "micro":    { "source": "rcsb|inline-particles", "id": "PDB-ID|null", "label": "..." },
    "interaction": {
      "type":  "slider",
      "label": "everyday word for what the slider does",
      "macro": "soften|harden",
      "micro": "wiggle|unfold|break|cluster",
      "aha":   { "at": 0.0..1.0, "say": "one short line" }
    }
  },
  "research": {
    "open_question": "honest tie-in to a real open scientific question",
    "benchmark":     "Hugging Science / TDC / etc — null if no clean fit"
  }
}
```

The renderer only knows about the shapes/sources/effects in this enum. New ones are added by extending `macro.js` / `micro.js` AND the system prompt's whiteboard-constraints section.

## How to run it

```sh
cd ~/wonder
node server/server.js
# → http://localhost:5173/
```

Env knobs:
- `PORT` (default `5173`)
- `WONDER_MODEL` (default `sonnet`; `haiku` is ~3× faster and ~5× cheaper)

The server uses the user's Claude Code CLI auth (OAuth via keychain). No API key needed. Each `/api/ask` call costs ~$0.05 on Sonnet, ~$0.01 on Haiku, and takes ~30–45s on Sonnet, ~10s on Haiku, dominated by Claude Code init overhead — not actual generation.

## Known gaps / next moves, in order

1. **Latency.** `claude -p` re-initializes per call, which is ~5× slower than going straight to the Anthropic SDK. Right move: drop the CLI subprocess, hit the SDK directly with prompt caching on the system prompt. Same model, ~5× faster, same cost. Keep the CLI path as a fallback for users without an API key.
2. **Streaming the reply.** Right now the bubble shows "thinking it through…" until the full JSON is back. Streaming the `reply` text would feel ~10× more alive. The `answer/scene/research` fields are fine to wait on — they only fire after the bubble fills.
3. **More macro/micro shapes.** Today: 2 macro (wedge, blob) × 2 micro (rcsb, inline-particles) × 4 effects. Cheap wins: an SPH fluid sim adapter (proves the system on something not protein-shaped), a procedural lattice for ice/quartz/metals, a galactic n-body for astro questions.
4. **Real benchmark connections.** The system prompt currently asks Claude to *name* a benchmark family. Next step: actually link to the Hugging Face dataset/leaderboard for that benchmark when one fits, so the visitor can click through.
5. **Researcher-evaluates-the-visitor's-attempt.** The "researchers can evaluate after proposed solutions" loop the user wants. Sketch: when a question hits a benchmark, the room sprouts a "submit your guess" affordance, the AI runs a small model on the dataset using the visitor's framing, scores against baseline, and a real researcher (or a researcher persona) leaves a note. Big feature; not in this branch.
6. **Reply to Georgia.** Owed reply with the cheese/eggs conversation example. Don't pitch the compute layer in the reply — only if a call happens.

## Strategic context to preserve

- **Baris's mission:** democratizing intelligence by enabling GPU compute on edge devices through WebGPU/WGSL optimization. Distributed edge devices collectively tackling shared computational problems. When in doubt, the answer that lets a phone do science is the right answer.
- **Adjacent work that should stay legible:** Zero-TVM (Phi-3 in browser via hand-written WGSL replacing TVM's runtime), gpubench.dev (hundreds of devices benchmarked), the kernel fusion preprints on kernelfusion.dev, the P2P swarm (the-swarm / webgpu-p2p-evolution).
- **Voice for external posts:** short, human, no links in the body of LinkedIn posts. Baris writes the actual posts; drafts should match his cadence, not corporate launch copy.
- **The 5yo framing is a stress test, not a target market.** Lean on "everyday questions → real science," not on the kid line.

## Things to actively avoid

- **Don't wedge the WebGPU/P2P story into pitches where it doesn't fit.** The compute layer earns its place when the visualization or inference *requires* GPU work that benefits from fusion. Otherwise it's a distraction.
- **Don't oversell the "kid does real science" framing.** Real scientific progress is gated by experiments, data, and compute — not by missing simple questions. The honest version is co-authoring research direction with a domain model. The honest version is the better story.
- **Don't pull in heavy libraries when fusion is the point.** When the WebGPU path returns, three.js gaussian-splat libraries exist but using them defeats the entire thesis.
- **Don't break the SceneSpec contract silently.** New macro/micro/effect values need to land in three places at once: `macro.js` / `micro.js`, `server/system-prompt.txt` (whiteboard constraints), and `server/server.js` (JSON schema enum).
