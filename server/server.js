// =============================================================
// server.js — tiny no-deps Node server.
// Serves static files from the project root and handles
// POST /api/ask by shelling out to `claude -p`.
// =============================================================

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const PORT      = Number(process.env.PORT || 5173);
const MODEL     = process.env.WONDER_MODEL || 'sonnet';

const SYSTEM_PROMPT = await readFile(path.join(__dirname, 'system-prompt.txt'), 'utf8');

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
      },
    },
    scene: {
      type: 'object',
      required: ['question', 'macro', 'micro', 'interaction'],
      properties: {
        question: { type: 'string' },
        macro: {
          type: 'object',
          required: ['shape', 'color', 'label'],
          properties: {
            shape: { type: 'string', enum: ['wedge', 'blob'] },
            color: { type: 'string' },
            label: { type: 'string' },
          },
        },
        micro: {
          type: 'object',
          required: ['source', 'label'],
          properties: {
            source: { type: 'string', enum: ['rcsb', 'inline-particles'] },
            id:     { type: ['string', 'null'] },
            label:  { type: 'string' },
          },
        },
        interaction: {
          type: 'object',
          required: ['type', 'label', 'macro', 'micro', 'aha'],
          properties: {
            type:  { type: 'string', enum: ['slider'] },
            label: { type: 'string' },
            macro: { type: 'string', enum: ['soften', 'harden'] },
            micro: { type: 'string', enum: ['wiggle', 'unfold', 'break', 'cluster'] },
            aha: {
              type: 'object',
              required: ['at', 'say'],
              properties: {
                at:  { type: 'number' },
                say: { type: 'string' },
              },
            },
          },
        },
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
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
};

function askClaude(question) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--tools', '',
      '--model', MODEL,
      '--output-format', 'json',
      '--system-prompt', SYSTEM_PROMPT,
      '--json-schema', JSON.stringify(SCENE_SCHEMA),
      '--max-budget-usd', '0.50',
      question,
    ];
    const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${err.trim() || out.trim()}`));
      }
      try {
        const wrap = JSON.parse(out);
        if (wrap.is_error) return reject(new Error(wrap.result || 'claude error'));
        // With --json-schema, the parsed object lives in `structured_output`.
        // Without, it's a JSON string in `result`. Support both.
        const inner = wrap.structured_output
          ?? (wrap.result ? JSON.parse(wrap.result) : null);
        if (!inner) return reject(new Error('claude returned no structured output'));
        resolve({ spec: inner, meta: {
          duration_ms: wrap.duration_ms,
          cost_usd:    wrap.total_cost_usd,
          model:       MODEL,
        }});
      } catch (e) {
        reject(new Error(`parse failed: ${e.message}\n--- raw stdout ---\n${out.slice(0, 800)}`));
      }
    });
  });
}

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
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
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
    try {
      const body = await readBody(req);
      const { question } = JSON.parse(body || '{}');
      if (!question || typeof question !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'missing question' }));
      }
      console.log(`[ask] ${question.slice(0, 80)}`);
      const result = await askClaude(question);
      console.log(`[ask] ok in ${result.meta.duration_ms}ms · $${result.meta.cost_usd?.toFixed(4)}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[ask] error:', e.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end();
});

server.listen(PORT, () => {
  console.log(`wonderlab → http://localhost:${PORT}`);
  console.log(`model: ${MODEL}`);
});
