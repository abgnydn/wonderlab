# wonderlab ✦

[![live](https://img.shields.io/badge/live-wonderlab--9os.pages.dev-FFD16B?style=flat-square&labelColor=2D2622)](https://wonderlab-9os.pages.dev/)
[![deploy](https://img.shields.io/github/actions/workflow/status/abgnydn/wonderlab/deploy.yml?branch=main&style=flat-square&label=deploy&labelColor=2D2622&color=B8DFA0)](https://github.com/abgnydn/wonderlab/actions/workflows/deploy.yml)
[![license](https://img.shields.io/badge/license-MIT-FFB7A8?style=flat-square&labelColor=2D2622)](LICENSE)
[![hosting](https://img.shields.io/badge/hosting-Cloudflare%20Pages-F4B942?style=flat-square&labelColor=2D2622&logo=cloudflare&logoColor=white)](https://pages.cloudflare.com/)
[![server-side](https://img.shields.io/badge/server--side-none-B8DFA0?style=flat-square&labelColor=2D2622)](#privacy)
[![keys](https://img.shields.io/badge/keys-bring%20your%20own-7CB7D0?style=flat-square&labelColor=2D2622)](#what-runs-where)

[![three.js](https://img.shields.io/badge/three.js-r170-FCEFD2?style=flat-square&labelColor=2D2622)](https://threejs.org/)
[![WebLLM](https://img.shields.io/badge/WebLLM-in--browser-FFD16B?style=flat-square&labelColor=2D2622)](https://webllm.mlc.ai/)
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

## What runs where

wonderlab is **100% static**. There is no server. Every model call goes
from your browser straight to the provider you picked. wonderlab doesn't
log, store, or proxy anything.

The settings panel (⚙ in the top bar) lets you pick:

| backend | runs where | needs key | first-use cost |
|---|---|---|---|
| **WebLLM** | your browser, on your GPU | no | one-time ~900MB–2.5GB model download |
| **Gemini** | Google AI Studio (free tier) | yes (free, no card) | a few requests/min |
| **Claude** | Anthropic API | yes (paid) | best illustration quality |
| **LM Studio** | your localhost | no | run wonderlab locally too |
| **local dev server** | optional Node server, uses Claude Code CLI auth | no | dev only |

The settings panel auto-detects your device (WebGPU? RAM? connection
speed?) and recommends a backend + model accordingly.

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
2. `server/system-prompt.txt` — add it to the WHITEBOARD CONSTRAINTS
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

MIT — see [LICENSE](LICENSE).

## Story behind the project

Hugging Face launched [Hugging Science](https://huggingface.co/blog/welcome-hugging-science).
[Georgia Channing](https://huggingface.co/blog/welcome-hugging-science)
(AI4Science @ HF / Oxford TVG) wrote the launch post. I commented:

> *"Still waiting for science for kids… should i do it myself?"*

She replied:

> *"Hmmmmm... what are you envisioning?"*

This is the answer.
