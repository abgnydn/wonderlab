// =============================================================
// main.js — entry. Hydrates the lab room, plays the opening
// scene, and routes chat input + sticky-note picks through the
// /api/ask endpoint to drive new SceneSpecs onto the whiteboard.
// =============================================================

import { Scene } from './scene.js';
import { cheeseSpec } from './specs/cheese.js';
import { researcherQuestions } from './researcher-questions.js';

const $ = (id) => document.getElementById(id);

const STATUS = (msg, kind = 'info') => {
  const el = $('splat-status');
  if (!el) return;
  el.textContent = msg;
  el.dataset.kind = kind;
};

let scene;
let currentSpec = null;
let zoomed = false;

// -----------------------------------------------------------
// translate the server's reply into the SceneSpec shape that
// scene.play() expects
// -----------------------------------------------------------
function asSceneSpec(reply) {
  const s = reply.spec;
  return {
    id: 'live',
    question: s.scene.question,
    answer:   s.answer,
    macro:    s.scene.macro,
    micro:    s.scene.micro,
    interaction: s.scene.interaction,
    _reply:    s.reply,
    _level:    s.level,
    _research: s.research,
    _meta:     reply.meta,
  };
}

// -----------------------------------------------------------
// paint the static parts of a spec into the room
// -----------------------------------------------------------
function paintSpec(spec) {
  if ($('scene-question'))     $('scene-question').textContent     = spec.question || '';
  if ($('scene-answer-kid'))   $('scene-answer-kid').textContent   = spec.answer?.kid || '';
  if ($('scene-answer-real'))  $('scene-answer-real').textContent  = spec.answer?.real || '';
  if ($('scene-slider-label')) $('scene-slider-label').textContent = spec.interaction?.label || 'value';

  const macroLabel = spec.macro?.label || 'scene';
  const zoomBtn = $('scene-zoom');
  if (zoomBtn) zoomBtn.textContent = zoomed ? `↑ pull back out` : `↓ zoom into the ${macroLabel}`;

  const slider = $('scene-slider');
  if (slider) slider.value = 0;
  const aha = $('scene-aha');
  if (aha) aha.classList.remove('show');
}

async function loadSpec(spec) {
  currentSpec = spec;
  zoomed = false;
  paintSpec(spec);

  const microLabel = spec.micro?.label || 'scene';
  STATUS(`loading ${microLabel}…`);
  try {
    await scene.play(spec);
    const macroLabel = spec.macro?.label || '';
    STATUS(`${macroLabel} → ${microLabel}`, 'ok');
  } catch (e) {
    STATUS('failed: ' + (e.message || e), 'error');
    console.error(e);
  }
}

// -----------------------------------------------------------
// researcher's speech bubble
// -----------------------------------------------------------
function setBubble(text, opts = {}) {
  const el = $('researcher-bubble');
  if (!el) return;
  const who = '<span class="who">— the researcher</span>';
  if (opts.thinking) {
    el.classList.add('is-thinking');
    el.innerHTML = `${who}thinking it through`;
  } else {
    el.classList.remove('is-thinking');
    el.innerHTML = `${who}${escapeHTML(text || '')}`;
    if (text) {
      el.classList.remove('pop');
      void el.offsetWidth; // restart animation
      el.classList.add('pop');
    }
  }
}

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// -----------------------------------------------------------
// chat thread
// -----------------------------------------------------------
function addChatTurn(question) {
  const thread = $('chat-thread');
  if (!thread) return null;
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `<div class="you-row"><div class="you">${escapeHTML(question)}</div></div>`;
  thread.appendChild(turn);
  thread.scrollTop = thread.scrollHeight;
  return turn;
}

function attachReplyToTurn(turnEl, reply) {
  if (!turnEl) return;
  const them = document.createElement('div');
  them.className = 'them-row';
  them.innerHTML = `<div class="them">${escapeHTML(reply)}</div>`;
  turnEl.appendChild(them);
  const thread = $('chat-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

// -----------------------------------------------------------
// ask the lab
// -----------------------------------------------------------
let asking = false;

async function ask(question) {
  const q = (question || '').trim();
  if (!q || asking) return;
  asking = true;

  const submitBtn = $('ask-submit');
  const input     = $('ask-input');
  const turnEl    = addChatTurn(q);

  setBubble('', { thinking: true });
  if (submitBtn) submitBtn.disabled = true;
  if (input)    { input.value = ''; input.disabled = true; }

  try {
    const res = await fetch('/api/ask', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ question: q }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reply = await res.json();
    const spec  = asSceneSpec(reply);

    setBubble(spec._reply);
    attachReplyToTurn(turnEl, spec._reply);
    await loadSpec(spec);
  } catch (e) {
    const msg = `couldn't reach the lab — ${e.message}`;
    setBubble(msg);
    attachReplyToTurn(turnEl, msg);
    console.error(e);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (input)    { input.disabled = false; input.focus(); }
    asking = false;
  }
}

// -----------------------------------------------------------
// hydrate the corkboard with real researcher questions
// -----------------------------------------------------------
function hydratePinboard() {
  const board = $('question-pinboard');
  if (!board) return;
  board.innerHTML = '';
  const colors = ['sun', 'peach', 'leaf', 'sky', 'pink'];
  researcherQuestions.forEach((q, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `sticky ${colors[i % colors.length]}`;
    card.dataset.qid = q.id;
    const rot = (i % 2 === 0 ? -1 : 1) * (1 + (i % 3));
    card.style.setProperty('--rot', `${rot}deg`);
    card.innerHTML = `
      <span class="badge">${escapeHTML(q.badge)}</span>
      ${escapeHTML(q.text)}
      <span class="by">— ${escapeHTML(q.by)}</span>
    `;
    card.addEventListener('click', () => ask(q.text));
    board.appendChild(card);
  });
}

// -----------------------------------------------------------
// boot
// -----------------------------------------------------------
async function main() {
  const canvas = $('splat-canvas');
  if (!canvas) return;

  STATUS('warming up…');
  scene = new Scene(canvas);

  hydratePinboard();

  $('ask-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    ask($('ask-input')?.value);
  });

  // open with the cheese demo so the room isn't empty before anyone asks
  setBubble("hi! pull up a chair. ask me anything, or grab a question off the corkboard. here's one i was just looking at.");
  await loadSpec(cheeseSpec);

  // slider drives the unified interaction value
  const slider = $('scene-slider');
  const ahaEl  = $('scene-aha');
  let ahaShownFor = null;
  if (slider) {
    slider.addEventListener('input', () => {
      const v = +slider.value / 100;
      scene.setValue(v);
      const aha = currentSpec?.interaction?.aha;
      if (aha && ahaShownFor !== currentSpec && v >= aha.at) {
        ahaShownFor = currentSpec;
        if (ahaEl) {
          ahaEl.textContent = aha.say;
          ahaEl.classList.add('show');
          setTimeout(() => ahaEl.classList.remove('show'), 4500);
        }
      }
    });
  }

  // zoom toggles macro ↔ micro
  const zoomBtn = $('scene-zoom');
  if (zoomBtn) {
    zoomBtn.addEventListener('click', () => {
      zoomed = !zoomed;
      scene.setZoom(zoomed ? 1 : 0);
      const label = currentSpec?.macro?.label || 'scene';
      zoomBtn.textContent = zoomed ? `↑ pull back out` : `↓ zoom into the ${label}`;
    });
  }
}

main();
