# wonderlab ✦

[![live](https://img.shields.io/badge/live-the--wonderlab.pages.dev-FFD16B?style=flat-square&labelColor=2D2622)](https://the-wonderlab.pages.dev/)
[![deploy](https://img.shields.io/github/actions/workflow/status/abgnydn/wonderlab/deploy.yml?branch=main&style=flat-square&label=deploy&labelColor=2D2622&color=B8DFA0)](https://github.com/abgnydn/wonderlab/actions/workflows/deploy.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-FFB7A8?style=flat-square&labelColor=2D2622)](LICENSE)
[![hosting](https://img.shields.io/badge/hosting-Cloudflare%20Pages-F4B942?style=flat-square&labelColor=2D2622&logo=cloudflare&logoColor=white)](https://pages.cloudflare.com/)
[![server-side](https://img.shields.io/badge/server--side-none-B8DFA0?style=flat-square&labelColor=2D2622)](#privacy)
[![keys](https://img.shields.io/badge/keys-bring%20your%20own-7CB7D0?style=flat-square&labelColor=2D2622)](#what-runs-where)

[![Gemma 4](https://img.shields.io/badge/Gemma%204-31B%20%C2%B7%20open%20weights-FFD16B?style=flat-square&labelColor=2D2622)](https://ai.google.dev/gemma)
[![three.js](https://img.shields.io/badge/three.js-r170-FCEFD2?style=flat-square&labelColor=2D2622)](https://threejs.org/)
[![WebLLM](https://img.shields.io/badge/WebLLM-in--browser-FCEFD2?style=flat-square&labelColor=2D2622)](https://webllm.mlc.ai/)
[![Claude](https://img.shields.io/badge/Claude-Sonnet%204.6-FFB7A8?style=flat-square&labelColor=2D2622)](https://www.anthropic.com/)
[![Gemini](https://img.shields.io/badge/Gemini-2.5%20Flash-7CB7D0?style=flat-square&labelColor=2D2622)](https://ai.google.dev/)
[![LM Studio](https://img.shields.io/badge/LM%20Studio-localhost-E58B82?style=flat-square&labelColor=2D2622)](https://lmstudio.ai/)

A small lab room you walk into. A researcher waits at a whiteboard.
You ask any question — *why does cheese melt? how does the sun stay
on?* — and they answer in plain words while drawing what they're
describing live on the whiteboard, then tag it against a real open
scientific question.

It's a translation layer.
Kid words on the front.
Real research-tie-in on the back.

> *"You shouldn't need to scrape arxiv, run your own wetlab, fight a custom
> HDF5 parser, build a fusion stellarator, and beg for compute before you've
> trained a single epoch."* — [Hugging Science launch post](https://huggingface.co/blog/welcome-hugging-science)

wonderlab is one layer that pitch doesn't currently fill: the **friend**
who turns a normal question into a real scientific challenge submission,
and turns the result back into language the asker understands. The 5yo
is the stress test, not the user base — real users are anyone non-expert
with intuition.

---

## How it works

- **Front**: a 3D lab room (three.js) with a researcher (Iris) at a
  whiteboard. Type a question or click a sticky-note from the corkboard.
- **Back**: an LLM produces a `SceneSpec` — a plain-words reply, a kid
  answer, a hand-coded SVG for the whiteboard, and a real open-scientific
  tie-in.
- **Translation rule**: every visible field is plain words.
  The technical version lives behind a *"how researchers say it →"*
  reveal on the share card.

## How it teaches

The prompt and schema lean on a few well-cited frameworks from the
science-communication and educational-psychology literature, restated
in kid-words inside Iris's brief:

- **[Johnstone's triplet](https://edu.rsc.org/feature/improve-students-understanding-with-johnstones-triangle/4019740.article)**
  (Johnstone 1982) — every illustration coordinates *three layers*:
  the **big picture** (body shapes — what the thing *is*), the
  **inside picture** (state primitives — *why* it behaves that way),
  and a **word picture** (a name, a number, a tiny formula). Most
  answers use the first two; a few earn all three.
- **[Mayer's Cognitive Theory of Multimedia Learning](https://www.digitallearninginstitute.com/blog/mayers-principles-multimedia-learning)**
  — *coherence* (the banned-words list strips extraneous jargon from
  every visible field), *signaling* (the "pointing rule": every
  sentence directs the eye to a part of the picture), *spatial
  contiguity* (labels render under their shape), *personalization*
  (kid voice, never lecture).
- **Variation theory** (Marton & Booth) — when a question contrasts
  two states, the two halves of the picture must LOOK different in
  shape, not just colour. The visual difference *is* the teaching.
- **Self-explanation effect** (Chi et al.) — follow-up questions are
  framed as *"what do you think happens if…"* predictions the
  visitor can test, not topic branches.
- **Conceptual metaphor / structure-mapping** (Lakoff, Gentner) —
  Iris picks a kid-domain whose relational structure maps the target
  ("tiny strings tangle into knots" for protein denaturation).

The constraint is not visual rigidity — it's cognitive coordination.
Iris stays free to choose any content; the structure she chooses for
*how* to present it is what the research says novices need.

## What runs where

wonderlab is **100% static**. There is no server. Every model call goes
from your browser straight to the provider you picked. wonderlab doesn't
log, store, or proxy anything.

The settings panel (⚙ in the top bar) lets you pick:

| backend | runs where | needs key | first-use cost |
|---|---|---|---|
| **Gemma 4 (AI Studio)** ⭐ | Google AI Studio (free tier) | yes (free, no card) | a few requests/min — recommended default |
| **Gemini** | Google AI Studio (free tier) | yes (free, no card) | same key as Gemma 4 |
| **Claude** | Anthropic API | yes (paid) | best illustration quality |
| **WebLLM** | your browser, on your GPU | no | one-time ~900MB–2.5GB model download |
| **LM Studio** | your localhost | no | run wonderlab locally too |
| **local dev server** | optional Node server, uses Claude Code CLI auth | no | dev only |

The settings panel auto-detects your device (WebGPU? RAM? connection
speed?) and recommends **Gemma 4 31B** by default — it's open-weight
(Apache 2.0), multimodal, has native function calling, and runs free
on AI Studio. WebLLM stays one click away if you'd rather run fully
offline in your browser.

## Quick start (developing)

```sh
git clone https://github.com/abgnydn/wonderlab
cd wonderlab

# Option A — Cloudflare-style (static only, no Node):
npm run dev:static                   # → http://localhost:5173

# Option B — with the optional Node dev server (Claude Code CLI auth):
npm run dev                          # → http://localhost:5173
```

Option A matches what's deployed on Cloudflare; Option B keeps the
`/api/ask` route alive so you can ask without pasting a key.

## Deploying to Cloudflare Pages

```sh
npx wrangler login
npx wrangler pages project create wonderlab --production-branch main
npm run deploy
```

`npm run deploy` runs `npm run build` first — that copies the
public-only files (index.html, src/, system-prompt.txt, sw.js, OG image,
favicon, _headers) into `./public/` and then asks wrangler to deploy
that directory. server/, scripts/, package.json, drafts/ etc. never
leave your machine.

There are no environment variables to set, no Functions, no Workers —
wonderlab is just static assets. Cloudflare's CDN does the work; the
visitor's browser does the rest.

If you change `og.svg`, regenerate the PNG with `npm run og` (uses
`rsvg-convert`; install via `brew install librsvg` on macOS).

## Adding a new whiteboard shape

The `SceneSpec` contract is enforced in three places. To add a new
illustration shape, edit all three together:

1. `src/macro.js` (or `src/micro.js`) — implement the factory
2. `system-prompt.txt` (project root) — add it to the right Johnstone layer (big / inside / word)
3. `server/server.js` — extend the `enum` in `SCENE_SCHEMA`

See `CLAUDE.md` for the full contract + handoff context.

## Privacy

- wonderlab has no server. The site you load from Cloudflare is just HTML,
  CSS, and JavaScript.
- Your API key is stored in `localStorage` in your own browser.
- Each question goes from your browser **directly** to the provider you
  selected (`api.anthropic.com`, `generativelanguage.googleapis.com`,
  WebLLM in-browser, or your local LM Studio).
- We don't analytics-track question text or replies.

If you fork the repo and run your own deploy, the same is true of *that*
deploy — there's nothing in the codebase that opens a tunnel back to us.

## Credits

Default ambient track shipped at `/music/loop.mp3`:

> **"Wallpaper"** by Kevin MacLeod ([incompetech.com](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100296)) — licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

If you swap it out, the player falls back to a procedural pentatonic
piece generated entirely in Web Audio (no external asset). Drop any
kid-safe instrumental at `music/loop.mp3` and `npm run build` picks it
up automatically. See `music/CREDITS.txt` for free-music sources.

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Made by

**Ahmet Barış Günaydın** — [barisgunaydin.com](https://barisgunaydin.com) ·
[github.com/abgnydn](https://github.com/abgnydn)

## References

The system prompt and SceneSpec contract draw on the following work in
educational psychology and science communication. Each citation maps to
a behavior the prompt actually enforces — not decoration.

- **Johnstone, A. H.** (1991). *Why is science difficult to learn? Things are seldom what they seem.* Journal of Computer Assisted Learning, 7(2), 75–83. — origin of the macroscopic / submicroscopic / symbolic triplet that wonderlab restates in kid-words as *big picture / inside picture / word picture*.
- **Mayer, R. E.** (Ed.) (2014). *The Cambridge Handbook of Multimedia Learning* (2nd ed.). Cambridge University Press. — coherence, signaling, spatial contiguity, modality, personalization. The "pointing rule," the banned-words list, and the labels-under-shapes rule all come from this body of work.
- **Marton, F., & Booth, S.** (1997). *Learning and Awareness.* Lawrence Erlbaum Associates. — variation theory. The "both halves must LOOK different in shape, not just colour" rule when iris contrasts two states.
- **Chi, M. T. H., Bassok, M., Lewis, M. W., Reimann, P., & Glaser, R.** (1989). *Self-explanations: How students study and use examples in learning to solve problems.* Cognitive Science, 13(2), 145–182. — why `follow_ups` are framed as *"what do you think happens if…"* predictions rather than topic branches.
- **Lakoff, G., & Johnson, M.** (1980). *Metaphors We Live By.* University of Chicago Press; and **Gentner, D.** (1983). *Structure-mapping: A theoretical framework for analogy.* Cognitive Science, 7(2), 155–170. — iris picks a kid-domain whose *relational* structure maps the target (e.g., "tiny strings tangle into knots" for protein denaturation).
- **Sweller, J.** (1988). *Cognitive load during problem solving: Effects on learning.* Cognitive Science, 12(2), 257–285. — worked examples (the egg example baked into the system prompt) and intrinsic/extraneous load split.

The output side draws on the Hugging Science launch position: [*AI for
Scientific Discovery is a Social Problem*](https://huggingscience.co/)
and the broader Hugging Science community. The benchmark chip routes
every question to that community's home, not to an aggregator.
