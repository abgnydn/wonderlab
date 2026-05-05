// =============================================================
// main.js — entry. Hydrates the lab room, plays the opening
// scene, and routes chat input + sticky-note picks through the
// /api/ask endpoint to drive new SceneSpecs onto the whiteboard.
// =============================================================

import { LabScene }            from './lab-scene.js';
import { cheeseSpec, makeWelcomeSpec } from './specs/cheese.js';
import { researcherQuestions } from './researcher-questions.js';
import * as audio               from './audio.js';
import { IRIS }                 from './iris-art.js';
import {
  bumpField, loadFieldCounts, clearFieldCounts, FIELD_FURNITURE,
} from './lab-grow.js';
import {
  getStorageInfo, clearCache, clearAllModelStorage, fmtBytes, prettyName,
} from './storage-info.js';
import { resolveBenchmark } from './benchmarks.js';
import {
  renderShareCard,
  downloadCanvasAsPng,
  copyCanvasToClipboard,
  nativeShareCanvas,
} from './share-card.js';
import {
  CONNECTORS, loadSettings, saveSettings,
  getActiveConnector, ask as connectorAsk, resolveDrawIllustrations,
} from './connectors/index.js';
import {
  detectCapabilities, recommend, describeCapabilities, WEBLLM_MODELS,
} from './device-detect.js';

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
    question:         s.scene?.question || '',
    answer:           s.answer,
    illustration_svg: s.scene?.illustration_svg || '',
    _reply:    s.reply,
    _level:    s.level,
    _research: s.research,
    _follow_ups: Array.isArray(s.follow_ups) ? s.follow_ups : [],
    _field:    typeof s.field === 'string' ? s.field : null,
    _meta:     reply.meta,
  };
}

// -----------------------------------------------------------
// the lab grows — call after each answer with the spec's `field`.
// First time a field appears: scene grows the matching furniture
// with a 1.2s spawn animation, plus a toast banner.
// -----------------------------------------------------------
function growLabFor(field) {
  if (!field) return;
  const { newGrowth } = bumpField(field);
  if (!newGrowth) return;
  const f = FIELD_FURNITURE[newGrowth];
  if (!f) return;
  scene.growFurniture?.(f.key, true);
  showGrowToast(`the lab grew ${f.label}`);
}

function showGrowToast(text) {
  const el = $('grow-toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  // double-rAF so transition runs (display: none → visible)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.classList.add('is-visible');
  }));
  clearTimeout(el._dismissT);
  el._dismissT = setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => { el.hidden = true; }, 350);
  }, 3800);
}

// -----------------------------------------------------------
// paint the static parts of a spec into the room
// -----------------------------------------------------------
function paintSpec(spec) {
  // The slider/zoom UI is gone. The visible "answer card" + status pill
  // are the only HTML chrome left for the spec.
  const isWelcome = spec.id === 'welcome';
  const kid       = isWelcome ? '' : (spec.answer?.kid || '');
  const glossary  = isWelcome ? [] : (spec.answer?.glossary || []);
  const target    = $('scene-answer-kid');
  if (target) {
    if (kid && glossary.length) {
      target.innerHTML = renderRosetta(kid, glossary);
    } else {
      target.textContent = kid;
    }
    target.closest('.answer-card')?.classList.toggle('visible', !!kid);
  }
  STATUS(spec.question || 'on the whiteboard', 'ok');

  const aha = $('scene-aha');
  if (aha) aha.classList.remove('show');

  paintFollowUps(isWelcome ? [] : (spec._follow_ups || []));
  paintBenchmarkChip(isWelcome ? null : spec._research?.benchmark);
}

// Benchmark chip — when iris cites a real-world benchmark, render it as
// a clickable pill anchored under the answer card. One click → the
// upstream Hugging Science / TDC / OpenProblems page in a new tab.
// This is the bridge from "kid question" to "real open problem", and
// the whole reason wonderlab pitches as a translation layer.
function paintBenchmarkChip(name) {
  const host = $('benchmark-chip');
  if (!host) return;
  const b = resolveBenchmark(name);
  if (!b) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML = `
    <span class="benchmark-chip__lede">tied to a real challenge:</span>
    <a class="benchmark-chip__link" href="${escapeAttr(b.url)}" target="_blank" rel="noopener">
      ${escapeHTML(b.label)} <span aria-hidden="true">↗</span>
    </a>
  `;
}

// follow-ups strip — small clickable bubbles above the chat input,
// each one a kid-voice branch question from the current answer.
function paintFollowUps(list) {
  const strip = $('follow-ups-strip');
  if (!strip) return;
  strip.innerHTML = '';
  const valid = (list || []).filter(s => typeof s === 'string' && s.trim());
  if (!valid.length) {
    strip.hidden = true;
    return;
  }
  const head = document.createElement('span');
  head.className = 'follow-ups-strip__head';
  head.textContent = 'next?';
  strip.appendChild(head);
  valid.slice(0, 3).forEach((q, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'follow-ups-strip__btn';
    b.style.setProperty('--rot', `${(i % 2 === 0 ? -0.8 : 1.2)}deg`);
    b.textContent = q;
    b.addEventListener('click', () => ask(q));
    strip.appendChild(b);
  });
  strip.hidden = false;
}

async function loadSpec(spec) {
  currentSpec = spec;
  paintSpec(spec);
  // Two render paths on the whiteboard:
  //   • spec carries an SVG → rasterise it (the live "illustration" mode)
  //   • spec has no SVG     → text-card mode (notepad-style, used when image
  //     generation is off, or when we just want to show the question/welcome)
  const hasSvg = typeof spec.illustration_svg === 'string'
              && spec.illustration_svg.includes('<svg');
  STATUS(hasSvg ? 'drawing…' : 'on the whiteboard');
  try {
    if (hasSvg) {
      await scene.play(spec);
    } else {
      scene.clearLoading?.();
      scene.renderTextCardToBoard?.({
        question: spec.question || '',
        kid:      spec.answer?.kid || spec._reply || '',
      });
    }
    STATUS(spec.question || 'on the whiteboard', 'ok');
  } catch (e) {
    STATUS('failed: ' + (e.message || e), 'error');
    console.error(e);
  }
}

// -----------------------------------------------------------
// researcher's speech bubble
// -----------------------------------------------------------
const WHO_HTML = '<span class="who">— the researcher</span>';

function setBubble(text, opts = {}) {
  const el = $('researcher-bubble');
  if (!el) return;
  if (opts.thinking) {
    el.classList.add('is-thinking');
    el.classList.remove('is-streaming');
    el.innerHTML = `${WHO_HTML}thinking it through`;
  } else {
    el.classList.remove('is-thinking');
    el.classList.remove('is-streaming');
    el.innerHTML = `${WHO_HTML}${escapeHTML(text || '')}`;
    if (text) {
      el.classList.remove('pop');
      void el.offsetWidth; // restart animation
      el.classList.add('pop');
    }
  }
}

// streaming: write the in-progress reply with a cursor, no pop animation
function setBubbleStream(text) {
  const el = $('researcher-bubble');
  if (!el) return;
  el.classList.remove('is-thinking');
  el.classList.add('is-streaming');
  el.innerHTML = `${WHO_HTML}${escapeHTML(text || '')}<span class="cursor"></span>`;
}

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// -----------------------------------------------------------
// Rosetta hover layer — wrap kid_word phrases in answer.kid with a
// span carrying data-real, so CSS can underline them and a hover
// sticky-note can show the technical twin. Each kid_word is matched
// case-insensitively, only the FIRST occurrence is wrapped (so the
// answer doesn't get peppered by the same underline on every "the").
// -----------------------------------------------------------
function renderRosetta(text, glossary) {
  // sort longest-first so multi-word phrases beat single words on overlap
  const items = [...glossary]
    .filter(g => g && g.kid_word && g.real_term)
    .sort((a, b) => b.kid_word.length - a.kid_word.length);

  // walk a single pass, collecting non-overlapping ranges
  const lower = text.toLowerCase();
  const taken = [];   // [start, end) ranges already wrapped, kept sorted
  const overlaps = (s, e) => taken.some(([ts, te]) => !(e <= ts || s >= te));
  const slots = [];   // { s, e, real }

  for (const g of items) {
    const needle = g.kid_word.toLowerCase();
    if (!needle) continue;
    let pos = lower.indexOf(needle);
    while (pos !== -1) {
      const end = pos + needle.length;
      if (!overlaps(pos, end)) {
        slots.push({ s: pos, e: end, real: g.real_term });
        taken.push([pos, end]);
        taken.sort((a, b) => a[0] - b[0]);
        break;                             // only first occurrence
      }
      pos = lower.indexOf(needle, pos + 1);
    }
  }

  slots.sort((a, b) => a.s - b.s);
  let out = '';
  let cur = 0;
  for (const { s, e, real } of slots) {
    out += escapeHTML(text.slice(cur, s));
    out += `<span class="rosetta" tabindex="0" data-real="${escapeHTML(real)}">${escapeHTML(text.slice(s, e))}</span>`;
    cur = e;
  }
  out += escapeHTML(text.slice(cur));
  return out;
}

// -----------------------------------------------------------
// chat thread — turns auto-fade after ~25s. The latest turn stays.
// -----------------------------------------------------------
const TURN_LIFETIME_MS  = 25_000;     // visible time before fade starts
const TURN_FADE_DURATION = 1_200;     // fade animation
const KEEP_LAST_TURNS    = 4;         // never fade the most-recent N turns

function _scheduleFade(turn) {
  turn._addedAt = performance.now();
}

function _sweepChatThread() {
  const thread = $('chat-thread');
  if (!thread) return;
  const turns = Array.from(thread.querySelectorAll('.turn'));
  const now = performance.now();
  // most-recent N are never faded — they're the "latest exchange"
  const candidates = turns.slice(0, Math.max(0, turns.length - KEEP_LAST_TURNS));
  for (const t of candidates) {
    if (t.classList.contains('gone')) continue;
    if (!t._addedAt) continue;
    const age = now - t._addedAt;
    if (age > TURN_LIFETIME_MS && !t.classList.contains('fading')) {
      t.classList.add('fading');
      setTimeout(() => {
        t.classList.add('gone');
        setTimeout(() => t.remove(), TURN_FADE_DURATION);
      }, TURN_FADE_DURATION);
    }
  }
}
setInterval(_sweepChatThread, 2000);

function addChatTurn(question) {
  const thread = $('chat-thread');
  if (!thread) return null;
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `<div class="you-row"><div class="you">${escapeHTML(question)}</div></div>`;
  thread.appendChild(turn);
  thread.scrollTop = thread.scrollHeight;
  _scheduleFade(turn);
  return turn;
}

// Create the reply slot on the turn at the start of streaming so we can
// fill it incrementally. Returns the inner .them element to mutate.
function startReplyOnTurn(turnEl) {
  if (!turnEl) return null;
  const them = document.createElement('div');
  them.className = 'them-row';
  them.innerHTML = `<div class="them is-streaming"></div>`;
  turnEl.appendChild(them);
  const thread = $('chat-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
  return them.querySelector('.them');
}

function setReplyOnTurn(thenEl, text, { streaming = false } = {}) {
  if (!thenEl) return;
  thenEl.textContent = text || '';
  thenEl.classList.toggle('is-streaming', !!streaming);
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

  // close any open mobile sheet so the visitor sees the lab respond
  document.querySelectorAll('#chat-thread.open, .corkboard.open')
    .forEach(el => el.classList.remove('open'));
  document.querySelectorAll('.panel-toggles button.active')
    .forEach(el => { el.classList.remove('active'); el.setAttribute('aria-pressed', 'false'); });

  const submitBtn = $('ask-submit');
  const input     = $('ask-input');
  const turnEl    = addChatTurn(q);
  const replyEl   = startReplyOnTurn(turnEl);

  setBubble('', { thinking: true });
  if (submitBtn) submitBtn.disabled = true;
  if (input)    { input.value = ''; input.disabled = true; }

  // start the whiteboard loading animation IMMEDIATELY so the visitor sees
  // motion the moment they hit send (instead of staring at the previous SVG
  // for ~30s while the model thinks)
  scene.setLoading?.(q);
  // and switch iris to curious — eyes drift to the board, brows up
  scene.setMood?.('curious');
  // hide stale follow-ups so a slow click on yesterday's chain can't fire
  paintFollowUps([]);

  // Confirm we have a working backend before dispatching. If the active
  // connector needs a key and the key is empty, open settings instead of
  // tripping a confusing "401 / missing key" error.
  const settings = loadSettings();
  const conn = getActiveConnector(settings);
  if (!conn) {
    scene.clearLoading?.();
    openSettingsModal();
    asking = false;
    if (submitBtn) submitBtn.disabled = false;
    if (input) { input.disabled = false; input.focus(); }
    return;
  }
  if (conn.needsKey && !(settings.keys[conn.id] || '').trim()) {
    scene.clearLoading?.();
    openSettingsModal({ highlightKey: conn.id });
    asking = false;
    if (submitBtn) submitBtn.disabled = false;
    if (input) { input.disabled = false; input.focus(); }
    return;
  }

  let replyText = '';
  let final     = null;
  let firstChunk = true;

  try {
    await new Promise((resolve, reject) => {
      connectorAsk(q, settings, {
        onProgress: (p) => {
          // WebLLM model download progress: surface it on the loading screen
          scene.setLoadingProgress?.(p);
        },
        onReply: (delta) => {
          if (firstChunk) firstChunk = false;
          replyText += delta;
          setBubbleStream(replyText);
          setReplyOnTurn(replyEl, replyText, { streaming: true });
        },
        onDone:  (result) => { final = result; resolve(); },
        onError: (err)    => reject(err),
      });
    });

    if (!final) throw new Error('lab closed before sending an answer');
    const spec = asSceneSpec(final);

    // settle to the final reply (in case streamed text missed any tail chars)
    setBubble(spec._reply);
    setReplyOnTurn(replyEl, spec._reply, { streaming: false });
    audio.squeak();           // pen squeak as the new scene paints

    // mood pick before talking takes over: read the reply for tone cues.
    //   uncertainty → wondering · ! → excited · default → idle
    const reply = (spec._reply || '').toLowerCase();
    const uncertain = /(we (don'?t|do not)|still (don'?t|study|figuring)|honestly|not (sure|fully)|nobody (yet|knows)|open question|we'?re not sure)/.test(reply);
    const excited   = /[!?]\s*$/.test((spec._reply || '').trim()) || (spec._reply || '').includes('!');
    scene.setMood?.(uncertain ? 'wondering' : excited ? 'excited' : 'idle');

    // iris reads her reply aloud — show the talking pose while she speaks
    scene.setSpeaking?.(true);
    maybeSpeak(spec._reply);
    // poll: when speech ends, drop back to idle pose
    const settle = () => {
      if (typeof window !== 'undefined' && window.speechSynthesis?.speaking) {
        setTimeout(settle, 300);
      } else {
        scene.setSpeaking?.(false);
      }
    };
    setTimeout(settle, 400);
    await loadSpec(spec);
    // the lab grows: tag-driven furniture spawning. Runs after the spec
    // has painted so the new piece slides in alongside the answer.
    growLabFor(spec._field);
    // iris remembers — persist the last real question + kid answer so
    // the next visit's welcome scene can callback. Skip welcome specs.
    if (spec.id !== 'welcome' && q) {
      setLastAnswer(q, spec.answer?.kid || spec._reply || '');
    }
  } catch (e) {
    const msg = `couldn't reach the lab — ${e.message}`;
    setBubble(msg);
    setReplyOnTurn(replyEl, msg, { streaming: false });
    scene.clearLoading?.();
    scene.setMood?.('idle');
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
  // sticky notes are kid-only on the front — q.real stays in the data
  // (used by the system as background context) but never renders in the UI.
  researcherQuestions.forEach((q, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `sticky ${colors[i % colors.length]}`;
    card.dataset.qid = q.id;
    const rot = (i % 2 === 0 ? -1 : 1) * (1 + (i % 3));
    card.style.setProperty('--rot', `${rot}deg`);
    card.innerHTML = `
      <span class="badge">${escapeHTML(q.badge)}</span>
      <span class="sticky-text">${escapeHTML(q.text)}</span>
      <span class="by">— ${escapeHTML(q.by)}</span>
    `;
    card.addEventListener('click', () => ask(q.text));
    board.appendChild(card);
  });
}

// -----------------------------------------------------------
// boot
// -----------------------------------------------------------
// -----------------------------------------------------------
// preferences (name + voice) — persisted in localStorage
// -----------------------------------------------------------
const PREF_NAME  = 'wonderlab.name';
const PREF_VOICE = 'wonderlab.voice';
const PREF_VOICE_ON = 'wonderlab.voiceOn';   // master "iris speaks aloud" toggle

function getName()       { try { return localStorage.getItem(PREF_NAME) || ''; } catch { return ''; } }
function setName(n)      { try { localStorage.setItem(PREF_NAME, n); } catch {} }

// Iris remembers — persist the last (real, non-welcome) question +
// kid answer so the welcome screen can callback on the next visit.
const PREF_LAST_Q   = 'wonderlab.lastQuestion';
const PREF_LAST_KID = 'wonderlab.lastKid';
function getLastQuestion() { try { return localStorage.getItem(PREF_LAST_Q) || ''; } catch { return ''; } }
function getLastKid()      { try { return localStorage.getItem(PREF_LAST_KID) || ''; } catch { return ''; } }
function setLastAnswer(q, kid) {
  try {
    if (q)   localStorage.setItem(PREF_LAST_Q,   q);
    if (kid) localStorage.setItem(PREF_LAST_KID, kid);
  } catch {}
}
function getStoredVoice(){ try { return localStorage.getItem(PREF_VOICE) || 'af_heart'; } catch { return 'af_heart'; } }

// Off by default — Kokoro stays the picked voice, but iris doesn't auto-speak
// every reply unless the visitor turns this on in settings.
function getVoiceOn()    { try { return localStorage.getItem(PREF_VOICE_ON) === '1'; } catch { return false; } }
function setVoiceOn(on)  { try { localStorage.setItem(PREF_VOICE_ON, on ? '1' : '0'); } catch {} }

// Music ON by default — gentle procedural ambient, totally non-vocal.
const PREF_MUSIC_ON = 'wonderlab.musicOn';
function getMusicOn()   { try { const v = localStorage.getItem(PREF_MUSIC_ON); return v == null ? true : v === '1'; } catch { return true; } }
function setMusicOn(on) { try { localStorage.setItem(PREF_MUSIC_ON, on ? '1' : '0'); } catch {} }
// Single chokepoint: every audio.speak() in this file goes through here so we
// can gate it with one preference + always release the speaking pose.
function maybeSpeak(text) {
  if (!getVoiceOn()) return;
  audio.speak(text);
}

// Whether iris should generate an illustration (SVG) for the whiteboard, or
// just produce text (faster + works on small/local models). Source of truth
// is the connector settings — this helper picks up the per-backend default
// when nothing's been chosen.
function getDrawPreference() {
  const s = loadSettings();
  const conn = getActiveConnector(s);
  return resolveDrawIllustrations(s, conn);
}
function setDrawPreference(on) {
  const s = loadSettings();
  s.drawIllustrations = !!on;
  saveSettings(s);
}

const VOICE_OPTIONS = [
  { id: 'af_heart',    label: 'heart' },
  { id: 'af_bella',    label: 'bella' },
  { id: 'af_nicole',   label: 'nicole' },
  { id: 'af_sky',      label: 'sky' },
  { id: 'af_sarah',    label: 'sarah' },
  { id: 'af_nova',     label: 'nova' },
  { id: 'bf_emma',     label: 'emma · UK' },
  { id: 'bf_isabella', label: 'isabella · UK' },
  { id: 'bf_lily',     label: 'lily · UK' },
];

// -----------------------------------------------------------
// pre-seed the chat history with iris's opening line
// (uses the visitor's name if we know it)
// -----------------------------------------------------------
function seedOpening() {
  const thread = $('chat-thread');
  if (!thread) return;
  const name = getName();
  const last = getLastQuestion();
  const greeting = (name && last)
    ? `welcome back, ${name}! ✦ last time we wondered about "${last}" — keep going, or try something new?`
    : (name
        ? `hi ${name}! ✦ ask me anything you wonder about. grab a sticky, walk around with the arrows, click on stuff.`
        : `hi — ask me anything you wonder about. grab a sticky off the corkboard, walk around with the arrows, click on stuff.`);
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `<div class="them-row"><div class="them">${escapeHTML(greeting)}</div></div>`;
  thread.appendChild(turn);
  _scheduleFade(turn);
}

// -----------------------------------------------------------
// welcome overlay — first-visit name + voice picker.
// Re-openable later via the gear button.
// -----------------------------------------------------------
function setupWelcome() {
  const overlay  = $('welcome-overlay');
  const grid     = $('voice-grid');
  const nameInp  = $('welcome-name-input');
  const enterBtn = $('welcome-enter');
  const irisBox  = $('welcome-iris');
  if (!overlay || !grid || !nameInp || !enterBtn) return;

  // drop the actual IRIS.idle illustration into the welcome card so the
  // visitor sees the same character that's standing in the lab. One source
  // of truth — change iris-art.js and this updates too.
  if (irisBox && IRIS?.idle) irisBox.innerHTML = IRIS.idle;

  const savedName  = getName();
  const savedVoice = getStoredVoice();
  let pickedVoice  = savedVoice;
  if (savedName) nameInp.value = savedName;

  // build voice grid
  grid.innerHTML = '';
  for (const v of VOICE_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'voice-btn' + (v.id === pickedVoice ? ' selected' : '');
    b.dataset.voice = v.id;
    b.textContent = v.label;
    b.addEventListener('click', () => {
      pickedVoice = v.id;
      grid.querySelectorAll('.voice-btn').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      // preview — set voice and speak a tiny line
      audio.setVoice(pickedVoice);
      // voice preview is the one place we ALWAYS speak regardless of master
      // toggle — picking a voice is meaningless if you can't hear it. We also
      // flip the toggle on while previewing so the visitor's first action is
      // an explicit consent.
      setVoiceOn(true);
      audio.speak("hi! it's me.");
    });
    grid.appendChild(b);
  }

  enterBtn.addEventListener('click', () => {
    const name = (nameInp.value || '').trim().slice(0, 24) || 'friend';
    setName(name);
    audio.setVoice(pickedVoice);
    overlay.setAttribute('hidden', '');
    // greet by name + repaint the welcome whiteboard with the name
    setTimeout(() => maybeSpeak(`hi ${name}! welcome to the lab.`), 350);
    const thread = $('chat-thread');
    if (thread) thread.innerHTML = '';
    seedOpening();
    if (scene && currentSpec?.id === 'welcome') {
      loadSpec(makeWelcomeSpec(name, getLastQuestion()));
    }
    // surface the last question as a one-shot "revisit" follow-up
    const last = getLastQuestion();
    if (last) paintFollowUps([last]);
  });
  // pressing Enter in the name input also enters
  nameInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enterBtn.click();
  });

  // show the modal on first visit; auto-skip if a name's already saved
  if (savedName) {
    overlay.setAttribute('hidden', '');
  } else {
    overlay.removeAttribute('hidden');
    setTimeout(() => nameInp.focus(), 400);
  }
}

// -----------------------------------------------------------
// click reactions on world objects — each one triggers a tiny
// in-character beat in the chat history.
// -----------------------------------------------------------
const CLICK_LINES = {
  // researcher
  head:       "go on, ask me anything — type below or grab a sticky.",
  body:       "i'm here. every question is worth asking.",
  marker:     "want me to draw something? type a question.",
  badge:      "i'm dr. iris, the lab's resident curiosity. ✦ AI, but the welcome is real.",
  // room objects
  mug:        "hot chocolate keeps the lab cozy. want a sip while we wonder?",
  lamp:       "warmer with the lamp on, isn't it?",
  papers:     "lots of notes here — every one helped me figure something out.",
  whiteboard: "this is where i think out loud. ask me a question and i'll draw what i mean.",
  microscope: "this is for the close-up stuff. ask me about something tiny and we'll look together.",
  axolotl:    "that's pebble. she's just a baby — never grew up, but kept all her gills. perfect lab kid.",
  cat:        "that's atlas. she runs the lab, technically. i just fund her snacks.",
};

function reactToObjectClick(kind) {
  const thread = $('chat-thread');
  if (!thread) return;
  const text = CLICK_LINES[kind];
  if (!text) return;
  // sound feedback — soft thunk for the lamp, soft ping for everything else
  if (kind === 'lamp') audio.thunk();
  else                 audio.click();
  // iris speaks the line — talking pose while she does
  scene.setSpeaking?.(true);
  maybeSpeak(text);
  setTimeout(() => {
    const tick = () => {
      if (typeof window !== 'undefined' && window.speechSynthesis?.speaking) setTimeout(tick, 200);
      else scene.setSpeaking?.(false);
    };
    tick();
  }, 300);
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `<div class="them-row"><div class="them">${escapeHTML(text)}</div></div>`;
  thread.appendChild(turn);
  thread.scrollTop = thread.scrollHeight;
  _scheduleFade(turn);
  // gentle focus on input on most clicks (not badge / lamp / whiteboard)
  const input = $('ask-input');
  if (input && (kind === 'head' || kind === 'body' || kind === 'marker' || kind === 'mug' || kind === 'papers')) {
    input.focus();
  }
}

// -----------------------------------------------------------
// hover tooltip — small label that follows the cursor and
// names whatever object is under it. Quietly fades away when
// nothing's hovered.
// -----------------------------------------------------------
const TOOLTIP_LABELS = {
  head: 'iris', body: 'iris', marker: 'iris\'s marker', badge: 'iris\'s badge',
  mug: 'hot chocolate', lamp: 'lamp', papers: 'notes',
  whiteboard: 'whiteboard',
  microscope: 'microscope',
  axolotl: 'pebble the axolotl',
  cat:     'atlas the cat',
  atom: 'atom model',
  dna: 'dna helix',
  beakers: 'beaker rack',
  bookshelf: 'bookshelf',
};

let _tooltipEl = null;
function ensureTooltip() {
  if (_tooltipEl) return _tooltipEl;
  const t = document.createElement('div');
  t.id = 'hover-tooltip';
  t.style.cssText = `
    position: absolute; pointer-events: none; z-index: 8;
    background: rgba(255,255,255,0.92); color: var(--ink);
    border: 2px solid var(--ink); border-radius: 100px;
    padding: 0.25rem 0.65rem;
    font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 0.82rem;
    box-shadow: var(--shadow-sm);
    transform: translate(-50%, -130%);
    opacity: 0; transition: opacity .15s ease;
  `;
  document.querySelector('.lab-stage')?.appendChild(t);
  _tooltipEl = t;
  return t;
}
function reactToHover(kind, p) {
  const t = ensureTooltip();
  if (!kind || !TOOLTIP_LABELS[kind]) {
    t.style.opacity = '0';
    return;
  }
  t.textContent = TOOLTIP_LABELS[kind];
  t.style.left = `${p.x}px`;
  t.style.top  = `${p.y}px`;
  t.style.opacity = '1';
}

// -----------------------------------------------------------
// touch d-pad — wires the on-screen directional buttons to the
// same _keys map LabScene._walk() already reads. Pointer events so
// stylus / mouse / touch all work; touchAction: none on the buttons
// stops mobile browsers from scrolling while a button is held.
// -----------------------------------------------------------
function setupTouchDpad() {
  const dpad = $('touch-dpad');
  if (!dpad || !scene) return;
  const buttons = dpad.querySelectorAll('.touch-dpad__btn');
  buttons.forEach((b) => {
    const dir = b.dataset.dir;
    const press = (e) => {
      e.preventDefault();
      b.classList.add('is-active');
      if (dir === 'jump') scene.triggerJump?.();
      else                scene.setMoveKey?.(dir, true);
      b.setPointerCapture?.(e.pointerId);
    };
    const release = (e) => {
      b.classList.remove('is-active');
      if (dir !== 'jump') scene.setMoveKey?.(dir, false);
    };
    b.addEventListener('pointerdown',   press);
    b.addEventListener('pointerup',     release);
    b.addEventListener('pointercancel', release);
    b.addEventListener('pointerleave',  release);
    // contextmenu can pop on long-press; suppress it so movement is smooth
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}

// -----------------------------------------------------------
// settings — backend picker, key fields, test connection, save.
// Detects device capabilities on first open and recommends a backend.
// -----------------------------------------------------------
let _capabilities       = null;
let _recommendation     = null;
let _settingsHighlight  = null;   // backend id to scroll its key field into view

async function ensureCapabilities() {
  if (_capabilities) return _capabilities;
  _capabilities   = await detectCapabilities();
  _recommendation = recommend(_capabilities);
  return _capabilities;
}

export function openSettingsModal(opts = {}) {
  _settingsHighlight = opts.highlightKey || null;
  const modal = $('settings-modal');
  if (!modal) return;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  // refresh the contents so latest settings + capabilities show
  rebuildSettingsContents();
  // and focus the key input if a highlight was requested
  if (_settingsHighlight) {
    const f = document.querySelector(`#settings-key-${_settingsHighlight}`);
    f?.focus();
  }
}

function closeSettingsModal() {
  const modal = $('settings-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = '';
  refreshConnectHint();          // re-evaluate hint visibility after edits
  refreshActiveBackendChip();
}

function rebuildSettingsContents() {
  const settings = loadSettings();
  // device line + recommendation
  const dev = $('settings-device-line');
  const rec = $('settings-recommend');
  if (dev) dev.textContent = _capabilities ? describeCapabilities(_capabilities) : 'checking…';
  if (rec) {
    if (_recommendation) {
      const c = CONNECTORS[_recommendation.backend];
      rec.textContent = `recommended: ${c?.label || _recommendation.backend} — ${_recommendation.reason}`;
    } else rec.textContent = '';
  }

  // backend picker
  const list = $('settings-backends');
  if (list) {
    list.innerHTML = '';
    Object.values(CONNECTORS).forEach((c) => {
      const id = `settings-radio-${c.id}`;
      const row = document.createElement('label');
      row.className = 'settings-backend' + (settings.backend === c.id ? ' is-selected' : '');
      row.innerHTML = `
        <input type="radio" name="settings-backend" id="${id}" value="${c.id}"${settings.backend === c.id ? ' checked' : ''}/>
        <div class="settings-backend__body">
          <div class="settings-backend__label">${escapeHTML(c.label)}</div>
          <div class="settings-backend__desc">${escapeHTML(c.description)}</div>
        </div>
      `;
      row.addEventListener('click', () => {
        const s = loadSettings();
        s.backend = c.id;
        saveSettings(s);
        rebuildSettingsContents();
      });
      list.appendChild(row);
    });
  }

  // per-backend params
  const det = $('settings-details');
  if (det) {
    det.innerHTML = '';
    const conn = CONNECTORS[settings.backend];
    if (!conn) {
      det.innerHTML = '<p class="settings-help">pick a backend above to see its options</p>';
    } else {
      // key field (if needed)
      if (conn.needsKey) {
        const wrap = document.createElement('div');
        wrap.className = 'settings-field';
        wrap.innerHTML = `
          <label for="settings-key-${conn.id}">API key</label>
          <input id="settings-key-${conn.id}" type="password" autocomplete="off" placeholder="${conn.id === 'claude' ? 'sk-ant-…' : 'AI…'}" value="${escapeAttr(settings.keys[conn.id] || '')}"/>
          <div class="settings-field__hint">${keyHint(conn.id)}</div>
        `;
        det.appendChild(wrap);
        wrap.querySelector('input').addEventListener('input', (e) => {
          const s = loadSettings();
          s.keys[conn.id] = e.target.value;
          saveSettings(s);
          refreshConnectHint();
          refreshActiveBackendChip();
        });
      }
      // url field for LM Studio
      if (conn.id === 'lmstudio') {
        const onHttps = location.protocol === 'https:';
        const url = settings.lmstudioUrl || 'http://localhost:1234/v1/chat/completions';
        const isHttpUrl = /^http:\/\//i.test(url);
        const blocked = onHttps && isHttpUrl;
        const wrap = document.createElement('div');
        wrap.className = 'settings-field';
        wrap.innerHTML = `
          <label for="settings-url-lmstudio">LM Studio URL</label>
          <input id="settings-url-lmstudio" type="text" placeholder="http://localhost:1234/v1/chat/completions" value="${escapeAttr(settings.lmstudioUrl || '')}"/>
          <div class="settings-field__hint">point this at your LM Studio "Local Server" URL — usually <code>http://localhost:1234/v1/chat/completions</code></div>
          ${blocked ? lmstudioMixedContentHelp() : ''}
        `;
        det.appendChild(wrap);
        wrap.querySelector('input').addEventListener('input', (e) => {
          const s = loadSettings();
          s.lmstudioUrl = e.target.value;
          saveSettings(s);
        });
        // wire copy buttons inside the help block
        wrap.querySelectorAll('[data-copy]').forEach((b) => {
          b.addEventListener('click', async () => {
            const t = b.getAttribute('data-copy');
            try { await navigator.clipboard.writeText(t); b.textContent = 'copied!'; setTimeout(() => b.textContent = 'copy', 1400); }
            catch {}
          });
        });
      }
      // model picker
      if (conn.models?.length) {
        const wrap = document.createElement('div');
        wrap.className = 'settings-field';
        const opts = conn.models.map(m => `<option value="${escapeAttr(m.id)}"${settings.models[conn.id] === m.id ? ' selected' : ''}>${escapeHTML(m.label)}</option>`).join('');
        wrap.innerHTML = `
          <label for="settings-model-${conn.id}">model</label>
          <select id="settings-model-${conn.id}">${opts}</select>
          ${conn.id === 'webllm'
            ? '<div class="settings-field__hint">first run downloads weights from Hugging Face into your browser cache. subsequent runs are instant.</div>'
            : ''}
        `;
        det.appendChild(wrap);
        wrap.querySelector('select').addEventListener('change', (e) => {
          const s = loadSettings();
          s.models[conn.id] = e.target.value;
          saveSettings(s);
          refreshActiveBackendChip();
          refreshDrawHint();
        });
      }
    }
  }

  // hint visibility refresh (in case user changed backend / pasted key)
  refreshConnectHint();
  refreshActiveBackendChip();

  // draw toggle in settings (mirror of the chip in chat input)
  const drawT = $('settings-draw-toggle');
  if (drawT) {
    drawT.checked = getDrawPreference();
    drawT.onchange = () => {
      setDrawPreference(drawT.checked);
      refreshDrawHint();
    };
  }
  refreshDrawHint();

  // voice toggle (master "iris speaks aloud" switch — off by default)
  const voiceT = $('settings-voice-toggle');
  if (voiceT) {
    voiceT.checked = getVoiceOn();
    voiceT.onchange = () => {
      setVoiceOn(voiceT.checked);
      if (!voiceT.checked) audio.shutUp?.();   // cut off any in-flight TTS
    };
  }

  // music toggle (procedural ambient — on by default)
  const musicT = $('settings-music-toggle');
  if (musicT) {
    musicT.checked = getMusicOn();
    musicT.onchange = () => {
      setMusicOn(musicT.checked);
      audio.music?.(musicT.checked);
    };
  }

  // storage card — list cached models, show total, allow delete
  renderStorageCard();
}

// Surface the "WebLLM small models don't reliably draw" reality next to
// the draw checkbox, so flipping it on with WebLLM doesn't feel broken.
// Visible only when the active backend is WebLLM AND drawing is ON.
function refreshDrawHint() {
  const hint = $('settings-draw-hint');
  if (!hint) return;
  const s = loadSettings();
  const conn = getActiveConnector(s);
  const isWebllm = conn?.id === 'webllm';
  const drawOn   = getDrawPreference();
  if (isWebllm && drawOn) {
    const model = s.models.webllm || '';
    const isSmall = /-(0\.5B|1B)-/i.test(model) || !model;
    hint.hidden = false;
    hint.innerHTML = isSmall
      ? `<strong>heads up</strong> — small WebLLM models (1B) often skip or break the SVG. for reliable drawings, switch to <em>Claude</em> or <em>Gemini</em> in the backend picker, or try the 3B / Phi model in the dropdown above.`
      : `WebLLM 3B+ usually draws OK, but small browser models are hit-or-miss with complex scenes. <em>Claude</em> / <em>Gemini</em> remain the most reliable for drawings.`;
  } else {
    hint.hidden = true;
  }
}

async function renderStorageCard() {
  const host = $('settings-storage');
  if (!host) return;
  host.textContent = 'checking…';
  let info;
  try { info = await getStorageInfo(); }
  catch (e) { host.textContent = 'couldn\'t read storage.'; return; }

  host.innerHTML = '';

  // total line
  const total = document.createElement('div');
  total.className = 'settings-storage__total';
  if (info.quota) {
    const pct = info.quota ? Math.round((info.usage / info.quota) * 100) : 0;
    total.innerHTML = `<span>this site uses</span><span><b>${escapeHTML(fmtBytes(info.usage))}</b> of ${escapeHTML(fmtBytes(info.quota))} quota (~${pct}%)</span>`;
  } else {
    total.innerHTML = `<span>this site uses</span><span><b>${escapeHTML(fmtBytes(info.usage))}</b> on disk</span>`;
  }
  host.appendChild(total);

  // per-cache rows. measured size sometimes 0 if HF CDN headers omit
  // content-length — note that case so the visitor doesn't think it's broken.
  const interesting = info.caches.filter(c => c.kind !== 'other');
  if (!interesting.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-storage__empty';
    empty.textContent = 'nothing cached yet — first time you ask via WebLLM the model lands here.';
    host.appendChild(empty);
  } else {
    for (const c of interesting) {
      const row = document.createElement('div');
      row.className = 'settings-storage__row ' + c.kind;
      const sizeStr = c.bytes
        ? fmtBytes(c.bytes) + (c.measured < c.count ? ' (estimate)' : '')
        : c.count + ' files · size unknown';
      row.innerHTML = `
        <div class="settings-storage__row__main">
          <div class="settings-storage__row__name">${escapeHTML(prettyName(c.name))}</div>
          <div class="settings-storage__row__meta">${escapeHTML(sizeStr)} · ${c.count} ${c.count === 1 ? 'file' : 'files'}</div>
        </div>
        <button type="button" data-cache="${escapeAttr(c.name)}">delete</button>
      `;
      row.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Delete ${prettyName(c.name)}? Next use will re-download it.`)) return;
        await clearCache(c.name);
        renderStorageCard();
      });
      host.appendChild(row);
    }
  }

  // bulk action
  const actions = document.createElement('div');
  actions.className = 'settings-storage__actions';
  actions.innerHTML = `<button type="button" id="settings-clear-all-models" class="settings-action">clear all model caches</button>`;
  host.appendChild(actions);
  actions.querySelector('#settings-clear-all-models').addEventListener('click', async () => {
    if (!confirm('Clear all WebLLM + voice-model caches? Next time you ask, the model will re-download (~1GB on Llama-3.2-1B).')) return;
    await clearAllModelStorage();
    renderStorageCard();
  });
}

// Inline help block shown when LM Studio is selected on the live (HTTPS)
// site. The browser physically blocks https → http://localhost ("mixed
// content") and there's no server-side fix — only the visitor can break
// the wall. Three concrete escape hatches, easiest first.
function lmstudioMixedContentHelp() {
  return `
    <div class="lmstudio-help">
      <div class="lmstudio-help__title">⚠ your browser blocks https → http://localhost</div>
      <p class="lmstudio-help__lede">that's a security rule, not a wonderlab bug. three ways out — easiest first:</p>

      <ol class="lmstudio-help__list">
        <li>
          <strong>run wonderlab locally</strong> — the dev server runs on plain http, so it can talk to localhost without a fight:
          <pre><code>git clone https://github.com/abgnydn/wonderlab
cd wonderlab
npm run dev:static    <span class="muted"># http://localhost:5173</span></code>
          <button type="button" class="lmstudio-help__copy" data-copy="git clone https://github.com/abgnydn/wonderlab
cd wonderlab
npm run dev:static">copy</button></pre>
        </li>

        <li>
          <strong>Chrome flag</strong> — paste this into a new tab, add <code>http://localhost:1234</code>, set to <em>Enabled</em>, restart Chrome:
          <pre><code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code><button type="button" class="lmstudio-help__copy" data-copy="chrome://flags/#unsafely-treat-insecure-origin-as-secure">copy</button></pre>
          then reload wonderlab. the live site can now reach your LM Studio.
        </li>

        <li>
          <strong>cloudflared tunnel</strong> — wraps localhost:1234 in a real https URL:
          <pre><code>cloudflared tunnel --url http://localhost:1234</code><button type="button" class="lmstudio-help__copy" data-copy="cloudflared tunnel --url http://localhost:1234">copy</button></pre>
          paste the printed <code>https://….trycloudflare.com</code> URL into the field above (don't forget the <code>/v1/chat/completions</code> suffix).
        </li>
      </ol>

      <p class="lmstudio-help__foot">side note: LM Studio's <em>"Enable CORS"</em> toggle has to be on too — otherwise the browser refuses the cross-origin call regardless of all this.</p>
    </div>
  `;
}

function keyHint(id) {
  if (id === 'claude') return 'get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>';
  if (id === 'gemini') return 'free, no card — get one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com</a>';
  return '';
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);
}

// Active-backend chip — shows the visitor which model is currently
// powering iris. Clicks open settings.
function refreshActiveBackendChip() {
  const btn   = $('active-backend');
  const label = $('active-backend-label');
  if (!btn || !label) return;
  const s    = loadSettings();
  const conn = getActiveConnector(s);
  // category for the dot color
  const cls = !conn               ? 'is-empty'
            : conn.id === 'webllm'      ? 'is-empty'
            : conn.id === 'lmstudio'    ? 'is-local'
            : conn.id === 'local-server'? 'is-local'
            : 'is-cloud';
  btn.classList.remove('is-empty', 'is-cloud', 'is-local');
  btn.classList.add(cls);
  // label: short, fits in <200px chip
  let text = 'pick a backend';
  if (conn) {
    const map = {
      claude:        'Claude',
      gemini:        'Gemini',
      webllm:        'WebLLM (in-browser)',
      lmstudio:      'LM Studio (local)',
      'local-server':'local server',
    };
    text = `via ${map[conn.id] || conn.id}`;
    // if a specific model is picked, append the short label
    const model = (s.models[conn.id] || '').trim();
    if (model && conn.id === 'webllm') {
      // Llama-3.2-1B-Instruct-q4f16_1-MLC → 1B
      const m = /-(\d+(?:\.\d+)?B)-/i.exec(model);
      if (m) text = `via WebLLM · ${m[1]}`;
    }
  }
  label.textContent = text;
}

// First-time visitor hint: nudge them toward settings when the active
// backend needs a key and there isn't one. Stored "dismissed" in
// localStorage so it doesn't keep coming back after they choose to ignore it.
const HINT_DISMISSED_KEY = 'wonderlab.connectHint.dismissed';

function refreshConnectHint() {
  const hint = $('connect-hint');
  if (!hint) return;
  const dismissed = localStorage.getItem(HINT_DISMISSED_KEY) === '1';
  if (dismissed) { hint.hidden = true; return; }
  const s = loadSettings();
  const conn = getActiveConnector(s);
  // show only when the chosen backend needs a key AND the key is empty
  const need = conn?.needsKey && !(s.keys[conn.id] || '').trim();
  hint.hidden = !need;
}

function setupSettings() {
  // open the modal from the gear button (and on body's "open-settings" event)
  $('settings-btn')?.addEventListener('click', () => openSettingsModal());
  $('active-backend')?.addEventListener('click', () => openSettingsModal());
  document.addEventListener('open-settings', () => openSettingsModal());

  // first-time hint above the chat input
  $('connect-hint-open')?.addEventListener('click', () => openSettingsModal());
  $('connect-hint-dismiss')?.addEventListener('click', () => {
    try { localStorage.setItem(HINT_DISMISSED_KEY, '1'); } catch {}
    refreshConnectHint();
    refreshActiveBackendChip();
  });

  // close on backdrop / X / escape
  $('settings-modal')?.addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) closeSettingsModal();
  });
  document.addEventListener('keydown', (e) => {
    const m = $('settings-modal');
    if (!m || m.hidden) return;
    if (e.key === 'Escape') closeSettingsModal();
  });

  // save & close button
  $('settings-save')?.addEventListener('click', closeSettingsModal);

  // reset-the-lab button — wipes field counts, then reloads so the
  // room rebuilds clean (every spawned piece is destroyed too).
  $('settings-reset-lab')?.addEventListener('click', () => {
    if (!confirm('Reset the lab? Furniture grown from your past questions will go away.')) return;
    clearFieldCounts();
    location.reload();
  });

  // "use recommendation"
  $('settings-apply-rec')?.addEventListener('click', () => {
    if (!_recommendation) return;
    const s = loadSettings();
    s.backend = _recommendation.backend;
    if (_recommendation.webllmModel) s.models.webllm = _recommendation.webllmModel;
    if (typeof _recommendation.drawIllustrations === 'boolean') s.drawIllustrations = _recommendation.drawIllustrations;
    saveSettings(s);
    rebuildSettingsContents();
    setStatus('recommendation applied — paste a key (if needed) and you\'re set', 'ok');
  });

  // test connection
  $('settings-test')?.addEventListener('click', async () => {
    const s    = loadSettings();
    const conn = getActiveConnector(s);
    if (!conn) { setStatus('pick a backend first', 'error'); return; }
    setStatus('testing…');
    const params = {
      key:   s.keys[conn.id] || '',
      model: s.models[conn.id] || '',
      url:   conn.id === 'lmstudio' ? s.lmstudioUrl : undefined,
    };
    let res;
    try { res = await conn.testConnection(params); }
    catch (e) { res = { ok: false, error: e.message || String(e) }; }
    if (res.ok) setStatus(res.info || 'connected', 'ok');
    else        setStatus(res.error || 'failed', 'error');
  });

  function setStatus(msg, kind) {
    const el = $('settings-test-status');
    if (!el) return;
    el.textContent = msg;
    if (kind) el.dataset.kind = kind; else delete el.dataset.kind;
  }

  // first-run recommendation: if no backend chosen yet, set sensible defaults
  ensureCapabilities().then(() => {
    const s = loadSettings();
    if (!s.backend && _recommendation) {
      s.backend = _recommendation.backend;
      if (_recommendation.webllmModel) s.models.webllm = _recommendation.webllmModel;
      if (typeof _recommendation.drawIllustrations === 'boolean' && s.drawIllustrations == null) {
        s.drawIllustrations = _recommendation.drawIllustrations;
      }
      saveSettings(s);
    }
    // set a reasonable default model if missing for the chosen backend
    const cur = loadSettings();
    const conn = getActiveConnector(cur);
    if (conn && !cur.models[conn.id] && conn.models?.length) {
      cur.models[conn.id] = conn.models[0].id;
      saveSettings(cur);
    }
    // first-time hint + backend chip
    refreshConnectHint();
    refreshActiveBackendChip();
  });
}

// -----------------------------------------------------------
// share — render the current whiteboard + spec into a portrait
// share card and offer download / copy / native share.
// -----------------------------------------------------------
function setupShare() {
  const btn      = $('share-btn');
  const topBtn   = $('share-top-btn');
  const modal    = $('share-modal');
  const host     = $('share-preview-host');
  const status   = $('share-status');
  const dlBtn    = $('share-download');
  const cpBtn    = $('share-copy');
  const shBtn    = $('share-native');
  const linkBtn  = $('share-copylink');
  if (!modal || !host) return;

  let cardCanvas = null;     // last rendered share card
  let rendering  = false;

  // disable native-share / copy buttons when their APIs aren't available
  if (!navigator.share)            { shBtn.disabled = true; shBtn.title = 'native share not supported in this browser'; }
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    cpBtn.disabled = true; cpBtn.title = 'image clipboard not supported in this browser';
  }

  const setStatus = (msg = '', kind = 'info') => {
    status.textContent = msg;
    status.dataset.kind = kind;
  };

  const closeModal = () => {
    modal.hidden = true;
    document.body.style.overflow = '';
  };
  modal.addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (!modal.hidden && e.key === 'Escape') closeModal();
  });

  const openShare = async () => {
    if (rendering) return;
    rendering = true;
    setStatus('');
    host.innerHTML = '';
    modal.hidden = false;
    document.body.style.overflow = 'hidden';

    try {
      const wb = scene?._svgCanvas;
      if (!wb) throw new Error('whiteboard not ready');
      const isWelcome = !currentSpec || currentSpec.id === 'welcome';
      if (isWelcome) {
        setStatus("share the live link or take a snap of the welcome whiteboard.", 'ok');
      } else {
        setStatus('developing the photo…');
      }
      // Even on welcome we render a card — it's just the welcome SVG with
      // generic copy. The "copy link" action is the more useful path here.
      cardCanvas = await renderShareCard(currentSpec || { id: 'welcome', question: 'wonderlab', answer: { kid: '' } }, wb);
      host.appendChild(cardCanvas);
      if (!isWelcome) setStatus('');
    } catch (e) {
      console.error('[share] render failed:', e);
      setStatus(`couldn't develop the photo — ${e.message || e}`, 'error');
    } finally {
      rendering = false;
    }
  };

  btn?.addEventListener('click', openShare);
  topBtn?.addEventListener('click', openShare);

  // copy link — the simplest share path, no rendering required
  linkBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard?.writeText?.(location.href);
      setStatus('link copied — paste anywhere.', 'ok');
    } catch (e) {
      setStatus(`copy failed — ${e?.message || e}`, 'error');
    }
  });

  dlBtn.addEventListener('click', () => {
    if (!cardCanvas) return;
    const slug = (currentSpec?.question || 'wonderlab')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'wonderlab';
    downloadCanvasAsPng(cardCanvas, `${slug}.png`);
    setStatus('saved to your downloads.', 'ok');
  });

  cpBtn.addEventListener('click', async () => {
    if (!cardCanvas) return;
    setStatus('copying…');
    try {
      await copyCanvasToClipboard(cardCanvas);
      setStatus('copied! paste it anywhere.', 'ok');
    } catch (e) {
      setStatus(`copy failed — ${e.message || e}`, 'error');
    }
  });

  shBtn.addEventListener('click', async () => {
    if (!cardCanvas) return;
    setStatus('opening share sheet…');
    try {
      await nativeShareCanvas(cardCanvas, {
        title: 'wonderlab — ' + (currentSpec?.question || 'a question'),
        text:  (currentSpec?.answer?.kid || currentSpec?._reply || '') + '\n\nasked at the-wonderlab.pages.dev',
      });
      setStatus('shared.', 'ok');
    } catch (e) {
      // user cancelling the native sheet shows up as AbortError — silent
      if (e?.name === 'AbortError') { setStatus(''); return; }
      setStatus(`share failed — ${e.message || e}`, 'error');
    }
  });
}

// Register the service worker FIRST so it can cache huggingface model
// files (Kokoro TTS) on first download. Subsequent page loads serve
// the model from disk cache and Iris's voice is ready in seconds.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then((reg) => {
      console.log('[wonderlab] sw registered, scope:', reg.scope);
      // Force a fresh check on every visit so an older SW with a stale
      // allowlist can't linger. skipWaiting() inside sw.js then takes
      // over without a manual unregister.
      try { reg.update(); } catch {}
      // If a new SW takes control (visitor's first load post-deploy),
      // reload once so the page runs against the fresh SW. Guarded
      // against the very first install to avoid an infinite reload.
      let didReload = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (didReload) return;
        didReload = true;
        location.reload();
      });
    })
    .catch(err => console.warn('[wonderlab] sw registration failed:', err?.message || err));
}

async function main() {
  const canvas = $('splat-canvas');
  if (!canvas) return;

  // ?embed=1 → strip the chrome so the lab fits cleanly in an iframe
  // (Hugging Face Space, blog post, classroom worksheet). The room +
  // answer card + chat input stay; the wordmark, side panels, footer,
  // touch dpad and welcome modal are hidden via body.is-embed in CSS.
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('embed') === '1' || qs.has('embed') && qs.get('embed') !== '0') {
      document.body.classList.add('is-embed');
    }
  } catch {}

  STATUS('warming up…');
  scene = new LabScene(canvas);

  // restore previously-earned furniture instantly (no spawn animation)
  // so a returning visitor walks back into the room they built.
  const earned = loadFieldCounts();
  for (const field of Object.keys(earned)) {
    const f = FIELD_FURNITURE[field];
    if (f) scene.growFurniture?.(f.key, false);
  }

  hydratePinboard();
  setupWelcome();
  seedOpening();
  setupSettings();
  setupShare();
  setupTouchDpad();

  // Audio context can't start until the user interacts with the page.
  // First click/keypress anywhere wakes it up + starts the ambient hum.
  const wakeAudio = () => {
    audio.ambient(true);
    if (getMusicOn()) audio.music?.(true);
    window.removeEventListener('pointerdown', wakeAudio);
    window.removeEventListener('keydown',     wakeAudio);
  };
  window.addEventListener('pointerdown', wakeAudio, { once: false });
  window.addEventListener('keydown',     wakeAudio, { once: false });

  // pause iris's voice if the user types a new question (don't talk over her)
  $('ask-input')?.addEventListener('input', () => audio.shutUp());

  // ============== VOICE INPUT (mic button → Web Speech API) ==============
  const micBtn = $('mic-btn');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    // browser doesn't support speech recognition (Firefox, some mobile)
    micBtn?.classList.add('unsupported');
    micBtn?.setAttribute('title', 'voice mode is not supported in this browser');
  } else if (micBtn) {
    let recog = null;
    let listening = false;

    const ensureRecog = () => {
      if (recog) return recog;
      recog = new SR();
      recog.lang = 'en-US';
      recog.interimResults = true;
      recog.continuous = false;
      recog.maxAlternatives = 1;

      recog.onstart = () => {
        listening = true;
        micBtn.classList.add('listening');
        audio.shutUp();           // stop iris talking so we don't catch her voice
        const input = $('ask-input');
        if (input) input.placeholder = 'listening… speak your question';
      };
      recog.onerror = (e) => {
        console.warn('speech recog error', e?.error);
      };
      recog.onend = () => {
        listening = false;
        micBtn.classList.remove('listening');
        const input = $('ask-input');
        if (input) input.placeholder = 'ask anything you wonder about…';
      };
      recog.onresult = (e) => {
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) final += r[0].transcript;
          else           interim += r[0].transcript;
        }
        const input = $('ask-input');
        if (input) input.value = (final + interim).trim();
        if (final.trim()) {
          // got a complete utterance — submit it
          recog.stop();
          ask(final.trim());
        }
      };
      return recog;
    };

    micBtn.addEventListener('click', () => {
      const r = ensureRecog();
      if (listening) {
        try { r.stop(); } catch {}
      } else {
        try { r.start(); }
        catch (e) {
          console.warn('mic start failed', e);
          listening = false;
          micBtn.classList.remove('listening');
        }
      }
    });
  }

  // wire chat input
  $('ask-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    ask($('ask-input')?.value);
  });

  // world-object click → reaction in the chat
  scene.onObjectClick   = reactToObjectClick;
  // hover → tooltip
  scene.onHoverChange   = reactToHover;

  // aha popup driven by the auto-animation in lab-scene
  const ahaEl = $('scene-aha');
  scene.onAha = (text) => {
    if (!ahaEl || !text) return;
    ahaEl.textContent = text;
    ahaEl.classList.add('show');
    setTimeout(() => ahaEl.classList.remove('show'), 4500);
  };

  // controls hint — fade out after a few seconds
  const hint = $('controls-hint');
  if (hint) setTimeout(() => hint.classList.add('fade'), 5500);

  // mobile panel toggles — open/close chat history and corkboard as sheets
  const chatBtn  = $('toggle-chat');
  const corkBtn  = $('toggle-cork');
  const chatPane = $('chat-thread');
  const corkPane = document.querySelector('.corkboard');
  function setPanel(which) {
    const openChat = which === 'chat';
    const openCork = which === 'cork';
    chatPane?.classList.toggle('open', openChat);
    corkPane?.classList.toggle('open', openCork);
    chatBtn?.classList.toggle('active', openChat);
    corkBtn?.classList.toggle('active', openCork);
    chatBtn?.setAttribute('aria-pressed', openChat ? 'true' : 'false');
    corkBtn?.setAttribute('aria-pressed', openCork ? 'true' : 'false');
  }
  chatBtn?.addEventListener('click', () => {
    setPanel(chatPane?.classList.contains('open') ? null : 'chat');
  });
  corkBtn?.addEventListener('click', () => {
    setPanel(corkPane?.classList.contains('open') ? null : 'cork');
  });

  // open with the cheese demo so the room isn't empty before anyone asks
  await loadSpec(cheeseSpec);
  // returning visitors get their last question as a clickable pill above
  // the chat input — one-tap revisit, "or just type something fresh"
  const last = getLastQuestion();
  if (last) paintFollowUps([last]);
}

main();
