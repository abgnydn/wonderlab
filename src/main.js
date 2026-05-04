// =============================================================
// main.js — entry. Hydrates the lab room, plays the opening
// scene, and routes chat input + sticky-note picks through the
// /api/ask endpoint to drive new SceneSpecs onto the whiteboard.
// =============================================================

import { LabScene }            from './lab-scene.js';
import { cheeseSpec, makeWelcomeSpec } from './specs/cheese.js';
import { researcherQuestions } from './researcher-questions.js';
import * as audio               from './audio.js';
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
    _meta:     reply.meta,
  };
}

// -----------------------------------------------------------
// paint the static parts of a spec into the room
// -----------------------------------------------------------
function paintSpec(spec) {
  // The slider/zoom UI is gone. The visible "answer card" + status pill
  // are the only HTML chrome left for the spec.
  const isWelcome = spec.id === 'welcome';
  const kid = isWelcome ? '' : (spec.answer?.kid || '');
  if ($('scene-answer-kid')) {
    $('scene-answer-kid').textContent = kid;
    $('scene-answer-kid').closest('.answer-card')?.classList.toggle('visible', !!kid);
  }
  STATUS(spec.question || 'on the whiteboard', 'ok');

  const aha = $('scene-aha');
  if (aha) aha.classList.remove('show');
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
    // iris reads her reply aloud — show the talking pose while she speaks
    scene.setSpeaking?.(true);
    audio.speak(spec._reply);
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
  } catch (e) {
    const msg = `couldn't reach the lab — ${e.message}`;
    setBubble(msg);
    setReplyOnTurn(replyEl, msg, { streaming: false });
    scene.clearLoading?.();
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

function getName()       { try { return localStorage.getItem(PREF_NAME) || ''; } catch { return ''; } }
function setName(n)      { try { localStorage.setItem(PREF_NAME, n); } catch {} }
function getStoredVoice(){ try { return localStorage.getItem(PREF_VOICE) || 'af_heart'; } catch { return 'af_heart'; } }

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
  const greeting = name
    ? `hi ${name}! ✦ ask me anything you wonder about. grab a sticky, walk around with the arrows, click on stuff.`
    : `hi — ask me anything you wonder about. grab a sticky off the corkboard, walk around with the arrows, click on stuff.`;
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
  const settings = $('settings-btn');
  if (!overlay || !grid || !nameInp || !enterBtn) return;

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
      audio.speak("hi! it's me.");
    });
    grid.appendChild(b);
  }

  enterBtn.addEventListener('click', () => {
    const name = (nameInp.value || '').trim().slice(0, 24) || 'friend';
    setName(name);
    audio.setVoice(pickedVoice);
    overlay.setAttribute('hidden', '');
    settings?.removeAttribute('hidden');
    // greet by name + repaint the welcome whiteboard with the name
    setTimeout(() => audio.speak(`hi ${name}! welcome to the lab.`), 350);
    const thread = $('chat-thread');
    if (thread) thread.innerHTML = '';
    seedOpening();
    if (scene && currentSpec?.id === 'welcome') {
      loadSpec(makeWelcomeSpec(name));
    }
  });
  // pressing Enter in the name input also enters
  nameInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enterBtn.click();
  });

  // settings gear — re-open the modal so the visitor can change name/voice later
  settings?.addEventListener('click', () => {
    overlay.removeAttribute('hidden');
    settings.setAttribute('hidden', '');
    setTimeout(() => nameInp.focus(), 200);
  });

  // show the modal on first visit; auto-skip if both prefs already set
  if (savedName) {
    overlay.setAttribute('hidden', '');
    settings?.removeAttribute('hidden');
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
  audio.speak(text);
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
  refreshConnectHint();   // re-evaluate hint visibility after edits
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
        });
      }
      // url field for LM Studio
      if (conn.id === 'lmstudio') {
        const wrap = document.createElement('div');
        wrap.className = 'settings-field';
        wrap.innerHTML = `
          <label for="settings-url-lmstudio">LM Studio URL</label>
          <input id="settings-url-lmstudio" type="text" placeholder="http://localhost:1234/v1/chat/completions" value="${escapeAttr(settings.lmstudioUrl || '')}"/>
          <div class="settings-field__hint">browsers block http→https; if wonderlab is on cloudflare, run it locally to use this</div>
        `;
        det.appendChild(wrap);
        wrap.querySelector('input').addEventListener('input', (e) => {
          const s = loadSettings();
          s.lmstudioUrl = e.target.value;
          saveSettings(s);
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
        });
      }
    }
  }

  // hint visibility refresh (in case user changed backend / pasted key)
  refreshConnectHint();

  // draw toggle in settings (mirror of the chip in chat input)
  const drawT = $('settings-draw-toggle');
  if (drawT) {
    drawT.checked = getDrawPreference();
    drawT.onchange = () => {
      setDrawPreference(drawT.checked);
      // keep the chip in sync
      const chip = $('draw-toggle');
      if (chip) {
        chip.classList.toggle('is-on',  drawT.checked);
        chip.classList.toggle('is-off', !drawT.checked);
        chip.setAttribute('aria-pressed', drawT.checked ? 'true' : 'false');
      }
    };
  }
}

function keyHint(id) {
  if (id === 'claude') return 'get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>';
  if (id === 'gemini') return 'free, no card — get one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com</a>';
  return '';
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);
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
  document.addEventListener('open-settings', () => openSettingsModal());

  // first-time hint above the chat input
  $('connect-hint-open')?.addEventListener('click', () => openSettingsModal());
  $('connect-hint-dismiss')?.addEventListener('click', () => {
    try { localStorage.setItem(HINT_DISMISSED_KEY, '1'); } catch {}
    refreshConnectHint();
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
    // sync the draw toggle chip
    const chip = $('draw-toggle');
    if (chip) {
      const on = getDrawPreference();
      chip.classList.toggle('is-on', on);
      chip.classList.toggle('is-off', !on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // and the first-time hint
    refreshConnectHint();
  });
}

// -----------------------------------------------------------
// draw toggle — chip next to the chat input. ON = full SceneSpec
// (the illustration is drawn). OFF = text-only mode (notepad
// rendering on the whiteboard, much faster, works on small models).
// -----------------------------------------------------------
function setupDrawToggle() {
  const btn = $('draw-toggle');
  if (!btn) return;
  const apply = () => {
    const on = getDrawPreference();
    btn.classList.toggle('is-on',  on);
    btn.classList.toggle('is-off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on
      ? 'illustration on — iris will draw on the whiteboard'
      : 'illustration off — text-only on the whiteboard (faster)';
  };
  apply();
  btn.addEventListener('click', () => {
    setDrawPreference(!getDrawPreference());
    apply();
  });
}

// -----------------------------------------------------------
// share — render the current whiteboard + spec into a portrait
// share card and offer download / copy / native share.
// -----------------------------------------------------------
function setupShare() {
  const btn      = $('share-btn');
  const modal    = $('share-modal');
  const host     = $('share-preview-host');
  const status   = $('share-status');
  const dlBtn    = $('share-download');
  const cpBtn    = $('share-copy');
  const shBtn    = $('share-native');
  if (!btn || !modal || !host) return;

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

  btn.addEventListener('click', async () => {
    if (rendering) return;
    if (!currentSpec || currentSpec.id === 'welcome') {
      // nothing meaningful yet — gentle no-op
      return;
    }
    rendering = true;
    setStatus('developing the photo…');
    host.innerHTML = '';
    modal.hidden = false;
    document.body.style.overflow = 'hidden';

    try {
      const wb = scene?._svgCanvas;
      if (!wb) throw new Error('whiteboard not ready');
      cardCanvas = await renderShareCard(currentSpec, wb);
      host.appendChild(cardCanvas);
      setStatus('');
    } catch (e) {
      console.error('[share] render failed:', e);
      setStatus(`couldn't develop the photo — ${e.message || e}`, 'error');
    } finally {
      rendering = false;
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
        text:  (currentSpec?.answer?.kid || currentSpec?._reply || '') + '\n\nasked at wonderlab.app',
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
    .then(reg => console.log('[wonderlab] sw registered, scope:', reg.scope))
    .catch(err => console.warn('[wonderlab] sw registration failed:', err?.message || err));
}

async function main() {
  const canvas = $('splat-canvas');
  if (!canvas) return;

  STATUS('warming up…');
  scene = new LabScene(canvas);

  hydratePinboard();
  setupWelcome();
  seedOpening();
  setupSettings();
  setupDrawToggle();
  setupShare();

  // Audio context can't start until the user interacts with the page.
  // First click/keypress anywhere wakes it up + starts the ambient hum.
  const wakeAudio = () => {
    audio.ambient(true);
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
}

main();
