#!/usr/bin/env node
// =============================================================
// scripts/build.mjs — assemble the static files Cloudflare Pages
// should ship into ./public. Pure copy job, no bundling, no
// minification — the source already ships as ES modules over a
// modern CDN. Pure mirror keeps source maps + readable code in
// production for free.
// =============================================================

import { rm, mkdir, cp, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname }                            from 'node:path';
import { fileURLToPath }                            from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT  = join(ROOT, 'public');

// Each entry is either a relative path (file or dir) to copy as-is, or
// { from, to } to copy from one path to another. Anything not listed
// here stays out of the deploy — server/, package.json, wrangler.toml,
// scripts/, drafts/, .env.example, etc.
const SHIP = [
  'index.html',
  'sw.js',
  'favicon.svg',
  'og.png',
  'og.svg',
  'system-prompt.txt',
  'src',
  'music',           // drop loop.mp3 (or any kid-safe instrumental) in here
  '_headers',
];

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

async function build() {
  if (await exists(OUT)) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  for (const item of SHIP) {
    const from = typeof item === 'string' ? join(ROOT, item)         : join(ROOT, item.from);
    const to   = typeof item === 'string' ? join(OUT,  item)         : join(OUT,  item.to);
    if (!(await exists(from))) {
      console.warn(`[build] skipping (missing): ${item}`);
      continue;
    }
    await cp(from, to, { recursive: true });
    console.log(`[build] ${item}`);
  }

  // sanity check the deploy: index.html must exist
  if (!(await exists(join(OUT, 'index.html')))) {
    throw new Error('build failed: public/index.html missing');
  }
  console.log(`[build] → ${OUT}`);
}

build().catch((e) => { console.error(e); process.exit(1); });
