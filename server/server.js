// =============================================================
// server.js — tiny no-deps Node server.
// Serves static files from the project root and handles
// POST /api/ask by shelling out to `claude -p` with streaming.
// The `reply` field of the SceneSpec is streamed to the client
// over Server-Sent Events as soon as the model starts typing it,
// then the full structured payload is sent in a final `done` event.
// =============================================================

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const PORT      = Number(process.env.PORT || 5173);

// Backend selection:
//   claude   → Claude Code OAuth via the CLI (your existing plan, no key)
//   gemini   → Google Gemini 2.5 Flash, free tier, needs GEMINI_API_KEY
//   cerebras → Cerebras Llama 3.x, free 1M tokens/day, needs CEREBRAS_API_KEY
//              (the actual-instant option — 1500+ tok/s)
//   lmstudio → Local LM Studio at http://localhost:1234, no key
const BACKEND = (process.env.WONDER_BACKEND || 'claude').toLowerCase();

const MODEL = process.env.WONDER_MODEL || ({
  claude:   'sonnet',
  gemini:   'gemini-2.5-flash',
  cerebras: 'llama-3.3-70b',
  lmstudio: 'qwen3-14b-mlx',
}[BACKEND] || 'sonnet');

const LMSTUDIO_URL = process.env.LMSTUDIO_URL || 'http://localhost:1234/v1/chat/completions';
const GEMINI_URL   = process.env.GEMINI_URL   || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_KEY   = process.env.GEMINI_API_KEY || '';
const CEREBRAS_URL = process.env.CEREBRAS_URL || 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY || '';

// One slim system prompt (~2K tokens) that fits free-tier context windows
// and small models. Soul + contract in a single file.
// system-prompt lives at the project root (so it's also a clean static asset
// for the browser-side connectors to fetch as /system-prompt.txt)
const SYSTEM_PROMPT = await readFile(path.join(ROOT, 'system-prompt.txt'), 'utf8');

// Two schema variants:
//   • SCENE_SCHEMA          → full SceneSpec, requires illustration_svg
//   • SCENE_SCHEMA_NO_IMAGE → text-only mode, no SVG (faster, cheaper, and
//     works with smaller / local models that can't reliably emit an SVG).
const SCENE_SCHEMA = {
  type: 'object',
  required: ['level', 'reply', 'answer', 'scene', 'research'],
  properties: {
    level:  { type: 'string', enum: ['kid', 'curious', 'expert'] },
    reply:  { type: 'string' },
    answer: {
      type: 'object',
      required: ['kid', 'real'],
      properties: {
        kid:  { type: 'string' },
        real: { type: 'string' },
        glossary: {
          type: 'array',
          description: '3-6 kid_word → real_term pairs, the "rosetta" hover layer for answer.kid',
          items: {
            type: 'object',
            required: ['kid_word', 'real_term'],
            properties: {
              kid_word:  { type: 'string' },
              real_term: { type: 'string' },
            },
          },
        },
      },
    },
    scene: {
      type: 'object',
      required: ['question', 'illustration_svg'],
      properties: {
        question:         { type: 'string' },
        illustration_svg: { type: 'string' },
      },
    },
    research: {
      type: 'object',
      required: ['open_question', 'benchmark'],
      properties: {
        open_question: { type: 'string' },
        benchmark:     { type: ['string', 'null'] },
      },
    },
    follow_ups: {
      type: 'array',
      description: '2-3 short kid-voice questions branching from this answer',
      minItems: 0, maxItems: 3,
      items: { type: 'string' },
    },
    field: {
      type: 'string',
      description: 'closest scientific field — drives which furniture grows in the room',
      enum: ['astronomy', 'biology', 'chemistry', 'physics', 'climate',
             'medicine', 'geology', 'food', 'psychology', 'tech',
             'math', 'general'],
    },
  },
};

const SCENE_SCHEMA_NO_IMAGE = {
  type: 'object',
  required: ['level', 'reply', 'answer', 'scene', 'research'],
  properties: {
    level:  { type: 'string', enum: ['kid', 'curious', 'expert'] },
    reply:  { type: 'string' },
    answer: {
      type: 'object',
      required: ['kid', 'real'],
      properties: {
        kid:  { type: 'string' },
        real: { type: 'string' },
        glossary: {
          type: 'array',
          description: '3-6 kid_word → real_term pairs, the "rosetta" hover layer for answer.kid',
          items: {
            type: 'object',
            required: ['kid_word', 'real_term'],
            properties: {
              kid_word:  { type: 'string' },
              real_term: { type: 'string' },
            },
          },
        },
      },
    },
    scene: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string' },
      },
    },
    research: {
      type: 'object',
      required: ['open_question', 'benchmark'],
      properties: {
        open_question: { type: 'string' },
        benchmark:     { type: ['string', 'null'] },
      },
    },
    follow_ups: {
      type: 'array',
      description: '2-3 short kid-voice questions branching from this answer',
      minItems: 0, maxItems: 3,
      items: { type: 'string' },
    },
    field: {
      type: 'string',
      description: 'closest scientific field — drives which furniture grows in the room',
      enum: ['astronomy', 'biology', 'chemistry', 'physics', 'climate',
             'medicine', 'geology', 'food', 'psychology', 'tech',
             'math', 'general'],
    },
  },
};

const NO_IMAGE_DIRECTIVE =
  '\n\n[mode: text-only — do NOT include scene.illustration_svg. Skip the SVG entirely; ' +
  'fill in everything else as usual: reply, answer.kid, answer.real, scene.question, research.*]';

// Language directive — mirrors the client-side one in src/connectors/system-prompt.js.
// English ("en" or empty/auto-resolved-as-English) gets no directive; everything else
// asks iris to translate every visible field while keeping research.* and benchmark
// in English so the backend resolver still works.
const NATIVE_NAME = {
  en:'English', tr:'Türkçe', es:'Español', pt:'Português', fr:'Français',
  de:'Deutsch', it:'Italiano', nl:'Nederlands', sv:'Svenska', pl:'Polski',
  ru:'Русский', uk:'Українська', ar:'العربية', fa:'فارسی', hi:'हिन्दी',
  bn:'বাংলা', ur:'اردو', id:'Bahasa Indonesia', vi:'Tiếng Việt', th:'ไทย',
  ja:'日本語', ko:'한국어', zh:'中文',
};
const ENGLISH_NAME = {
  en:'English', tr:'Turkish', es:'Spanish', pt:'Portuguese', fr:'French',
  de:'German', it:'Italian', nl:'Dutch', sv:'Swedish', pl:'Polish',
  ru:'Russian', uk:'Ukrainian', ar:'Arabic', fa:'Persian', hi:'Hindi',
  bn:'Bengali', ur:'Urdu', id:'Indonesian', vi:'Vietnamese', th:'Thai',
  ja:'Japanese', ko:'Korean', zh:'Chinese',
};
function languageDirective(code) {
  if (!code || code === 'auto') code = 'en';
  if (code === 'en' || !NATIVE_NAME[code]) return '';
  const native = NATIVE_NAME[code];
  const english = ENGLISH_NAME[code];
  return [
    '',
    '',
    `[Visitor language: ${english} (${native}, code "${code}").`,
    `Reply ENTIRELY in ${english} for every visible field — reply, answer.kid, scene.question, follow_ups, and any text inside the SVG (including the title at the top of the picture).`,
    `The kid-words rule still applies in ${english}: avoid the ${english} equivalents of the banned technical terms; swap them for everyday metaphors a 7-year-old in ${english} would recognize.`,
    `Keep these in English so the backend mapping still works: answer.real, answer.glossary.real_term, research.open_question, research.benchmark, and the field tag.]`,
  ].join('\n');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

// -----------------------------------------------------------
// Streaming JSON-string extractor.
// The model emits a JSON object as text. We watch the stream of
// partial text deltas, find the value of the `"reply"` field,
// and emit unescaped chars to onDelta as they arrive. Once the
// closing quote of `reply` is seen, we stop — the rest of the
// JSON arrives but we don't need to peek inside it.
// -----------------------------------------------------------
function makeReplyExtractor(onDelta) {
  let state  = 'SEARCH';   // SEARCH → IN_VALUE → DONE
  let buf    = '';
  let pending = '';        // chars held back across feeds (mid-escape)

  return function feed(text) {
    if (state === 'DONE') return;
    buf += text;

    if (state === 'SEARCH') {
      const m = buf.match(/"reply"\s*:\s*"/);
      if (!m) {
        // keep tail in case the pattern is split across deltas
        if (buf.length > 128) buf = buf.slice(-64);
        return;
      }
      buf = buf.slice(m.index + m[0].length);
      state = 'IN_VALUE';
    }

    if (state === 'IN_VALUE') {
      buf = pending + buf;
      pending = '';
      let out = '';
      let i = 0;
      while (i < buf.length) {
        const c = buf[i];
        if (c === '\\') {
          if (i + 1 >= buf.length) { pending = '\\'; break; }
          const n = buf[i + 1];
          const simple = { 'n':'\n', 't':'\t', 'r':'\r', '"':'"', '\\':'\\', '/':'/', 'b':'\b', 'f':'\f' };
          if (simple[n] !== undefined) { out += simple[n]; i += 2; continue; }
          if (n === 'u') {
            if (i + 6 > buf.length) { pending = buf.slice(i); break; }
            out += String.fromCharCode(parseInt(buf.slice(i + 2, i + 6), 16));
            i += 6; continue;
          }
          out += n; i += 2; continue;
        }
        if (c === '"') {
          if (out) onDelta(out);
          state = 'DONE';
          buf = '';
          return;
        }
        out += c; i++;
      }
      buf = '';
      if (out) onDelta(out);
    }
  };
}

// -----------------------------------------------------------
// Spawn `claude -p` in stream-json mode and pipe partial text
// deltas through the reply extractor. Final structured output
// is delivered via onDone.
// -----------------------------------------------------------
// =============================================================
// Generic OpenAI-compatible streaming call. Used by both gemini and
// lmstudio backends — they only differ in URL, auth, and model name.
// =============================================================
async function askOpenAICompat({ url, model, headers, question, label, withImage, language, onReply, onDone, onError }) {
  const t0 = Date.now();
  const userMsg = question
    + '\n\nReply with a single JSON object matching the contract. No prose, no markdown fences. /no_think'
    + languageDirective(language)
    + (withImage === false ? NO_IMAGE_DIRECTIVE : '');
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMsg },
    ],
    stream: true,
    temperature: 0.5,
    // Big budget so reasoning models (DeepSeek-R1, Qwen3 thinking-mode) have
    // room to think AND still produce the actual JSON output afterwards.
    max_tokens: 16000,
  };

  let response;
  try {
    response = await fetch(url, {
      method:  'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    return onError(new Error(`Could not reach ${label}: ${e.message}`));
  }
  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    return onError(new Error(`${label} HTTP ${response.status}: ${txt.slice(0, 240)}`));
  }

  const extract = makeReplyExtractor(onReply);
  let fullText = '';
  let lineBuf  = '';
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    let chunk;
    try { chunk = await reader.read(); }
    catch (e) { return onError(new Error(`${label} stream broke: ${e.message}`)); }
    const { value, done } = chunk;
    if (done) break;
    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const payload = t.slice(6);
      if (payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      const d = evt.choices?.[0]?.delta;
      const delta = typeof d?.content === 'string' ? d.content : '';
      if (delta.length) {
        fullText += delta;
        extract(delta);
      }
    }
  }

  // Parse final JSON, recovering from any prose wrapping
  let inner = null;
  try { inner = JSON.parse(fullText); }
  catch (_) {
    const start = fullText.indexOf('{');
    const end   = fullText.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { inner = JSON.parse(fullText.slice(start, end + 1)); } catch {}
    }
  }
  if (!inner) {
    return onError(new Error(
      `${label} output did not contain valid JSON.\n` +
      '--- first 500 chars ---\n' + fullText.slice(0, 500)
    ));
  }

  onDone({
    spec: inner,
    meta: { duration_ms: Date.now() - t0, cost_usd: 0, model, backend: label.toLowerCase() },
  });
}

async function askGeminiStreaming(question, { withImage, language, ...callbacks }) {
  if (!GEMINI_KEY) {
    return callbacks.onError(new Error(
      'Gemini backend needs GEMINI_API_KEY. Get one (free, no card) at https://aistudio.google.com/apikey'
    ));
  }
  return askOpenAICompat({
    url:     GEMINI_URL,
    model:   MODEL,
    headers: { authorization: `Bearer ${GEMINI_KEY}` },
    question,
    label:   'Gemini',
    withImage,
    language,
    ...callbacks,
  });
}

async function askLmStudioStreamingNew(question, { withImage, language, ...callbacks }) {
  return askOpenAICompat({
    url:     LMSTUDIO_URL,
    model:   MODEL,
    headers: {},
    question,
    label:   'LM Studio',
    withImage,
    language,
    ...callbacks,
  });
}

async function askCerebrasStreaming(question, { withImage, language, ...callbacks }) {
  if (!CEREBRAS_KEY) {
    return callbacks.onError(new Error(
      'Cerebras backend needs CEREBRAS_API_KEY. Free, no card: https://cloud.cerebras.ai/'
    ));
  }
  return askOpenAICompat({
    url:     CEREBRAS_URL,
    model:   MODEL,
    headers: { authorization: `Bearer ${CEREBRAS_KEY}` },
    question,
    label:   'Cerebras',
    withImage,
    language,
    ...callbacks,
  });
}

// (LM Studio backend uses askOpenAICompat above via askLmStudioStreamingNew)

// =============================================================
// askClaudeSDK — Anthropic SDK direct, with prompt caching on the
// system prompt. About 5× faster than the CLI subprocess because
// it skips the ~3-5s CLI init on every call. Same model, same cost,
// and (after the first call in a 5-minute window) much cheaper —
// the cached system prompt costs 1/10 the input tokens to read.
//
// The SDK is loaded via dynamic import so the server still boots
// without it installed. We pick this path automatically when
// ANTHROPIC_API_KEY is set; otherwise we fall through to the CLI
// (askClaudeStreaming below), which uses Claude Code's OAuth and
// needs no key.
// =============================================================
let _sdkClient = null;        // cached Anthropic() client
let _sdkResolved = false;     // we've tried to load the SDK at least once

async function getAnthropicClient() {
  if (_sdkResolved) return _sdkClient;
  _sdkResolved = true;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const mod = await import('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic;
    _sdkClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _sdkClient;
  } catch (e) {
    console.warn('[server] @anthropic-ai/sdk not installed (run `npm i`); falling back to claude CLI');
    return null;
  }
}

// Map our short MODEL alias to the SDK's full model id. The CLI's
// `--model sonnet` / `haiku` aliases don't exist on the API surface.
function sdkModelId(alias) {
  const a = (alias || '').toLowerCase();
  if (a.includes('opus'))   return 'claude-opus-4-7';
  if (a.includes('haiku'))  return 'claude-haiku-4-5';
  if (a.includes('sonnet')) return 'claude-sonnet-4-6';
  // already a full model id, pass through
  return alias || 'claude-sonnet-4-6';
}

async function askClaudeSDK(question, { withImage, language, onReply, onDone, onError }) {
  const client = await getAnthropicClient();
  if (!client) return null;       // signal "fall back to CLI"
  const t0 = Date.now();
  const schema = withImage === false ? SCENE_SCHEMA_NO_IMAGE : SCENE_SCHEMA;
  const userMsg =
    question
    + languageDirective(language)
    + (withImage === false ? NO_IMAGE_DIRECTIVE : '');

  // Single tool that mirrors the JSON-schema route the CLI uses. The
  // model fills in the tool's input via streaming input_json_delta —
  // same wire shape as the CLI path, so the same extractor works.
  const tool = {
    name: 'StructuredOutput',
    description: 'Return the SceneSpec as a single structured object.',
    input_schema: schema,
  };

  const extract = makeReplyExtractor(onReply);
  let finalSpec = null;
  let inputUsage = null, outputUsage = null;
  try {
    const stream = client.messages.stream({
      model: sdkModelId(MODEL),
      max_tokens: withImage === false ? 2048 : 8192,
      // prompt-cache the system prompt so subsequent calls in a 5-min
      // window read it for 1/10 the input-token cost.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'StructuredOutput' },
      messages: [{ role: 'user', content: userMsg }],
    });

    // Pipe streaming deltas to the same extractor the CLI path uses.
    // The SDK exposes raw stream events through .on('streamEvent').
    stream.on('streamEvent', (evt) => {
      if (!evt) return;
      if (evt.type === 'content_block_delta' && evt.delta) {
        if (evt.delta.type === 'input_json_delta' && typeof evt.delta.partial_json === 'string') {
          extract(evt.delta.partial_json);
        } else if (evt.delta.type === 'text_delta' && typeof evt.delta.text === 'string') {
          extract(evt.delta.text);
        }
      }
    });

    const finalMessage = await stream.finalMessage();
    inputUsage  = finalMessage?.usage?.input_tokens;
    outputUsage = finalMessage?.usage?.output_tokens;
    // pull the tool_use block — that's our SceneSpec
    for (const block of finalMessage?.content || []) {
      if (block.type === 'tool_use' && block.name === 'StructuredOutput' && block.input) {
        finalSpec = block.input;
        break;
      }
    }
  } catch (e) {
    return onError(new Error(`Anthropic SDK error: ${e?.message || e}`));
  }

  if (!finalSpec) {
    return onError(new Error('Anthropic SDK returned no structured output'));
  }
  onDone({
    spec: finalSpec,
    meta: {
      duration_ms: Date.now() - t0,
      model: sdkModelId(MODEL),
      backend: 'claude-sdk',
      usage: { input_tokens: inputUsage, output_tokens: outputUsage },
    },
  });
  return true;       // handled
}

// Try the SDK path first (fast, prompt-cached). If it returns null, the
// SDK isn't usable (no key or no install) — fall through to the CLI.
async function askClaudeWithFallback(question, opts) {
  const handled = await askClaudeSDK(question, opts);
  if (handled) return;
  return askClaudeStreaming(question, opts);
}

function askClaudeStreaming(question, { withImage, language, onReply, onDone, onError }) {
  const schema = withImage === false ? SCENE_SCHEMA_NO_IMAGE : SCENE_SCHEMA;
  const userMsg =
    question
    + languageDirective(language)
    + (withImage === false ? NO_IMAGE_DIRECTIVE : '');
  const args = [
    '-p',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--tools', '',
    '--model', MODEL,
    '--effort', 'low',           // researcher chatting casually — no extended thinking
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--system-prompt', SYSTEM_PROMPT,
    '--json-schema', JSON.stringify(schema),
    '--max-budget-usd', '0.50',
    userMsg,
  ];

  const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const extract = makeReplyExtractor(onReply);
  let stderr  = '';
  let lineBuf = '';
  let finalResult = null;
  let finalError  = null;

  // Walk an event tree and feed any streamed JSON/text into the extractor.
  // With --json-schema, the model uses a `StructuredOutput` tool call, so the
  // SceneSpec arrives as `input_json_delta.partial_json` chunks (tiny, ~4-10
  // chars each). Plain text deltas also pass through, just in case.
  function harvestText(node) {
    if (!node || typeof node !== 'object') return;
    if (node.delta && typeof node.delta === 'object') {
      if (node.delta.type === 'input_json_delta' && typeof node.delta.partial_json === 'string') {
        extract(node.delta.partial_json);
      } else if (node.delta.type === 'text_delta' && typeof node.delta.text === 'string') {
        extract(node.delta.text);
      }
    }
    if (node.event)   harvestText(node.event);
    if (node.message) harvestText(node.message);
    if (Array.isArray(node.content)) node.content.forEach(harvestText);
  }

  function handleEvent(evt) {
    // Final result event from `claude -p`: structured output + meta
    if (evt.type === 'result') {
      if (evt.is_error || evt.subtype === 'error_during_execution') {
        finalError = new Error(evt.result || 'claude error');
        return;
      }
      let inner = evt.structured_output ?? null;
      if (!inner && evt.result) {
        try { inner = JSON.parse(evt.result); } catch { /* ignore */ }
      }
      if (inner) {
        finalResult = {
          spec: inner,
          meta: {
            duration_ms: evt.duration_ms,
            cost_usd:    evt.total_cost_usd,
            model:       MODEL,
          },
        };
      }
      return;
    }
    harvestText(evt);
  }

  proc.stdout.on('data', (chunk) => {
    lineBuf += chunk.toString('utf8');
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { handleEvent(JSON.parse(t)); } catch { /* skip non-JSON lines */ }
    }
  });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', onError);
  proc.on('close', (code) => {
    if (finalError) return onError(finalError);
    if (code !== 0 && !finalResult) {
      return onError(new Error(`claude exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    }
    if (!finalResult) return onError(new Error('claude returned no structured output'));
    onDone(finalResult);
  });
}

// -----------------------------------------------------------
// HTTP plumbing
// -----------------------------------------------------------
async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('forbidden');
  }
  try {
    const buf = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // dev-friendly: never cache, the file might have changed since last load
      'cache-control': 'no-cache, no-store, must-revalidate',
      'pragma':        'no-cache',
      'expires':       '0',
    });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/ask') {
    let question, withImage = true, language = 'en';
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}');
      question  = parsed.question;
      withImage = parsed.withImage !== false;     // default true; only false disables it
      language  = (typeof parsed.language === 'string' && parsed.language) || 'en';
      if (!question || typeof question !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'missing question' }));
      }
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }

    console.log(`[ask]${withImage ? '' : ' [no-image]'}${language && language !== 'en' ? ` [${language}]` : ''} ${question.slice(0, 80)}`);
    res.writeHead(200, {
      'content-type':  'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection':    'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // initial open event so the client can react quickly
    send('open', { ok: true });
    // heartbeat to keep proxies / browser EventSource happy during the long init
    const heartbeat = setInterval(() => {
      res.write(`: hb\n\n`);
    }, 8000);

    const cleanup = () => clearInterval(heartbeat);
    req.on('close', cleanup);

    // Pick the asker. For the default "claude" backend we try the SDK
    // first when ANTHROPIC_API_KEY is set + @anthropic-ai/sdk installed
    // (~5× faster cold-start than the CLI subprocess + prompt caching).
    // If that's not available, we fall back to the CLI (Claude Code OAuth).
    const askPrimary = BACKEND === 'gemini'   ? askGeminiStreaming
                     : BACKEND === 'cerebras' ? askCerebrasStreaming
                     : BACKEND === 'lmstudio' ? askLmStudioStreamingNew
                     :                          askClaudeWithFallback;

    askPrimary(question, {
      withImage,
      language,
      onReply: (delta) => send('reply', { text: delta }),
      onDone:  (result) => {
        cleanup();
        const cost = result.meta.cost_usd != null ? `$${result.meta.cost_usd.toFixed(4)}` : 'free';
        console.log(`[ask] ok in ${result.meta.duration_ms}ms · ${cost} · ${result.meta.backend || 'claude'}`);
        send('done', result);
        res.end();
      },
      onError: (e) => {
        cleanup();
        console.error('[ask] error:', e.message);
        send('error', { error: e.message });
        res.end();
      },
    });
    return;
  }
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end();
});

server.listen(PORT, () => {
  console.log(`wonderlab → http://localhost:${PORT}`);
  console.log(`backend: ${BACKEND}    model: ${MODEL}`);
  if (BACKEND === 'lmstudio') console.log(`lmstudio: ${LMSTUDIO_URL}`);
});
