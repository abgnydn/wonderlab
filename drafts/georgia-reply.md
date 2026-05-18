# Reply to Georgia — wonderlab

Context: original Hugging Science launch post comment thread.
- Baris: *"Still waiting for science for kids… should i do it myself?"*
- Georgia: *"Hmmmmm... what are you envisioning?"*

Pitch the **translation layer only** — never the compute layer. The 5yo
framing is a stress test, not the user base. Don't oversell "kid does
real science."

Below: three options, short → longer. Pick one, edit lightly, post.
LinkedIn comments shouldn't have URLs in the body — drop the link in a
follow-up reply or DM if she asks.

---

## Option A — short, in his voice (recommended for the comment thread)

> hey Georgia — built the thing. called it wonderlab.
>
> a 3D lab room. a researcher (iris) waits at a whiteboard. you ask
> anything — "why does cheese melt?", "how does a magnet work?" — and
> she answers in plain words while drawing it live on the whiteboard,
> then tags it against an open scientific question + the closest
> Hugging Science / TDC benchmark. share card has the kid version on
> top and "how researchers say it →" on the back.
>
> it's a translation layer. kid words on the front, real research on
> the back. the 5yo is the stress test, not the user base — anyone
> non-expert with intuition is the real user.
>
> runs on Gemma 4, Apache 2.0, no server — your key (when you need
> one) stays in your browser. submitted to the Gemma 4 Good hackathon
> under Future of Education. happy to DM the link.

---

## Option A-mini — bare-bones single paragraph (if the thread is short)

> hey Georgia — wonderlab is what i ended up building. 3D lab room,
> researcher at a whiteboard, you ask anything and she answers in kid
> words while drawing it, then tags the closest Hugging Science / TDC
> open challenge. translation layer — kid words on the front, real
> research on the back. runs on Gemma 4 (Apache 2.0), no server. DM
> me if you want a link.

---

## Option B — slightly longer, with the cheese example

> hey Georgia — wonderlab is what i ended up building.
>
> a 3D lab room. you walk in, a researcher (Iris) is at a whiteboard.
> you type any question — "why does cheese melt?" — and she answers in
> plain words while drawing it: a wedge that softens with a slider, the
> protein-fat structure underneath when you zoom in. then a sticky
> note appears: *"how researchers say it → molecular dynamics of
> protein-fat interactions across temperature gradients · TDC"*.
>
> the bet is the translation layer. the 5yo is a stress test, not the
> user base — real users are anyone non-expert with intuition. that's
> the layer Hugging Science doesn't currently fill. the friend who
> turns a normal question into the closest open scientific challenge,
> and turns the result back into language the asker understands.
>
> can DM the link.

---

## Option C — longer, for if she replies asking for more

> we built wonderlab around the line in your launch post — *"you
> shouldn't need to scrape arxiv, run your own wetlab, fight a custom
> HDF5 parser…"*. that's the bottom of the funnel. the top is just as
> blocked: most non-experts don't know which open scientific question
> their everyday curiosity maps to.
>
> wonderlab tries that mapping. you ask anything; the researcher
> answers in plain words and draws it; under the answer is the closest
> open scientific question + the relevant TDC / Hugging Science
> benchmark family. share-card baked in, so each conversation can
> escape the page.
>
> 100% browser-side. no server. you bring your own LLM (WebLLM in the
> browser, Gemini free tier, Claude — whatever you have) and your key
> never leaves your machine. that means kids/teachers/researchers can
> use it without us in the loop.
>
> next step (not built): a researcher loop. when a question hits a
> benchmark, the room sprouts a "submit your guess" affordance, runs a
> small model on the dataset using the visitor's framing, and a real
> researcher leaves a note. that's the part i'd love your read on.

---

## Things to avoid (per CLAUDE.md memory)

- No mention of WebGPU / kernel fusion / P2P / "compute layer". That
  belongs to other projects.
- Don't lean on the kid line as the marketing angle — lead with
  "translation".
- No URL in the body of a LinkedIn comment.
