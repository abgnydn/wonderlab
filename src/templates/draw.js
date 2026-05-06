// =============================================================
// templates/draw.js — the "give iris a canvas" path. The model
// fills in scene.draw with an array of drawing commands. We
// render each command on the whiteboard. No SVG markup for the
// model to break. No fixed layout for the model to fight.
//
// Coordinate space: 0..800 wide × 0..500 tall (the whiteboard's
// SVG viewBox). x grows right, y grows down. (0,0) is top-left.
//
// Each command: { k: "<kind>", ...slots }.
//
//   { "k": "title",  "s": "why does cheese melt?" }
//   { "k": "circle", "x": 200, "y": 250, "r": 60, "color": "yellow" }
//   { "k": "rect",   "x": 100, "y": 100, "w": 200, "h": 100, "color": "blue" }
//   { "k": "line",   "x1": 100, "y1": 50, "x2": 300, "y2": 50 }
//   { "k": "arrow",  "x1": 320, "y1": 250, "x2": 480, "y2": 250, "label": "heat ↑" }
//   { "k": "text",   "x": 200, "y": 350, "s": "cold", "size": "label" }
//   { "k": "blob",   "x": 600, "y": 250, "color": "yellow", "label": "warm" }
//   { "k": "wedge",  "x": 200, "y": 250, "color": "yellow", "dots": 5 }
//   ... plus sphere, chain, ring, box, drop, leaf, star
//
// Colors are names (translated to hex). Out-of-bounds coords are
// clamped. Missing fields fall to safe defaults so even an empty
// command paints something.
// =============================================================

import { COLOR_HEX, COLOR_DEEP } from './index.js';

const W = 800, H = 500;
const INK = '#2D2622';
const PAPER = '#FCEFD2';

// XML-safe text
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function color(name, fallback = 'yellow') {
  if (typeof name !== 'string') return COLOR_HEX[fallback];
  const k = name.toLowerCase().trim();
  return COLOR_HEX[k] || COLOR_HEX[fallback] || '#FFD16B';
}

// Pre-baked dot positions for inside-shape sprinkles. Used by blob/wedge/etc.
const DOT_COLORS = ['#E66363', '#7CB7D0', '#6FB05C', '#FF9B94', '#FFB7A8', '#FFD16B'];
function dotsAt(cx, cy, count) {
  const n = clamp(num(count, 0), 0, 6);
  if (!n) return '';
  const positions = [
    { dx: -32, dy: 8 }, { dx: 0, dy: -6 }, { dx: 32, dy: 10 },
    { dx: -16, dy: 28 }, { dx: 18, dy: 28 }, { dx: 40, dy: -8 },
  ];
  let out = '';
  for (let i = 0; i < n && i < positions.length; i++) {
    const x = cx + positions[i].dx;
    const y = cy + positions[i].dy;
    out += `<circle cx="${x}" cy="${y}" r="8" fill="${DOT_COLORS[i % DOT_COLORS.length]}" stroke="${INK}" stroke-width="2"/>`;
  }
  return out;
}

// ---------- per-command renderers ----------
// Each takes the validated command object and returns an SVG fragment.

function rTitle(c) {
  const s = esc((c.s || c.text || '').slice(0, 80));
  if (!s) return '';
  const x = clamp(num(c.x, 400), 0, W);
  const y = clamp(num(c.y, 58),  0, H);
  return `<text x="${x}" y="${y}" font-family="Caveat, cursive" font-weight="700" font-size="34" fill="${INK}" text-anchor="middle" transform="rotate(-1 ${x} ${y})">${s}</text>`;
}

function rText(c) {
  const s = esc((c.s || c.text || '').slice(0, 80));
  if (!s) return '';
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const size = (c.size || '').toLowerCase();
  let fontSize = 22, family = 'Fredoka, sans-serif', weight = '600';
  if (size === 'title') { fontSize = 32; family = 'Caveat, cursive'; weight = '700'; }
  else if (size === 'caption') { fontSize = 16; }
  else if (size === 'big') { fontSize = 28; }
  return `<text x="${x}" y="${y}" font-family="${family}" font-weight="${weight}" font-size="${fontSize}" fill="${INK}" text-anchor="middle">${s}</text>`;
}

function rCircle(c) {
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const r = clamp(num(c.r, 40), 4, 200);
  const fill = color(c.color, 'yellow');
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${INK}" stroke-width="3"/>`;
}

function rRect(c) {
  const x = clamp(num(c.x, 100), 0, W);
  const y = clamp(num(c.y, 100), 0, H);
  const w = clamp(num(c.w, 100), 4, W);
  const h = clamp(num(c.h, 100), 4, H);
  const fill = color(c.color, 'yellow');
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${INK}" stroke-width="3"/>`;
}

function rLine(c) {
  const x1 = clamp(num(c.x1, 0), 0, W);
  const y1 = clamp(num(c.y1, H / 2), 0, H);
  const x2 = clamp(num(c.x2, W), 0, W);
  const y2 = clamp(num(c.y2, H / 2), 0, H);
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${INK}" stroke-width="3"/>`;
}

function rArrow(c) {
  const x1 = clamp(num(c.x1, W * 0.4), 0, W);
  const y1 = clamp(num(c.y1, H / 2), 0, H);
  const x2 = clamp(num(c.x2, W * 0.6), 0, W);
  const y2 = clamp(num(c.y2, H / 2), 0, H);
  const label = esc((c.label || '').slice(0, 30));
  const labelEl = label
    ? `<text x="${(x1 + x2) / 2}" y="${Math.min(y1, y2) - 14}" font-family="Caveat, cursive" font-weight="700" font-size="28" fill="${COLOR_DEEP.red}" text-anchor="middle" transform="rotate(-3 ${(x1 + x2) / 2} ${Math.min(y1, y2) - 14})">${label}</text>`
    : '';
  return `${labelEl}<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${INK}" stroke-width="5" marker-end="url(#draw-arrow)"/>`;
}

// Body shapes — same vocabulary as the before-after template, but
// each is a drop-in unit you can position anywhere on the canvas.
// All shapes draw centered at (x, y).
function rWedge(c) {
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const fill = color(c.color, 'yellow');
  const label = esc((c.label || '').slice(0, 60));
  const dots = dotsAt(x, y + 10, c.dots);
  const labelEl = label
    ? `<text x="${x}" y="${y + 105}" font-family="Caveat, cursive" font-weight="700" font-size="24" fill="${INK}" text-anchor="middle">${label}</text>`
    : '';
  return `<polygon points="${x - 110},${y + 60} ${x + 110},${y + 60} ${x},${y - 80}" fill="${fill}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>${dots}${labelEl}`;
}

function rBlob(c) {
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const fill = color(c.color, 'yellow');
  const label = esc((c.label || '').slice(0, 60));
  const dots = dotsAt(x, y, c.dots);
  const labelEl = label
    ? `<text x="${x}" y="${y + 105}" font-family="Caveat, cursive" font-weight="700" font-size="24" fill="${INK}" text-anchor="middle">${label}</text>`
    : '';
  return `<path d="M ${x - 105} ${y} Q ${x - 125} ${y + 35} ${x - 85} ${y + 50} Q ${x - 25} ${y + 60} ${x + 30} ${y + 45} Q ${x + 90} ${y + 55} ${x + 130} ${y + 38} Q ${x + 165} ${y + 20} ${x + 125} ${y - 12} Q ${x + 90} ${y - 38} ${x + 25} ${y - 32} Q ${x - 45} ${y - 38} ${x - 90} ${y - 16} Z" fill="${fill}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>${dots}${labelEl}`;
}

function rSphere(c) {
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const fill = color(c.color, 'cream');
  const deep = COLOR_DEEP[(c.color || 'cream').toLowerCase()] || COLOR_DEEP.cream;
  const label = esc((c.label || '').slice(0, 60));
  const dots = dotsAt(x, y, c.dots);
  const labelEl = label
    ? `<text x="${x}" y="${y + 110}" font-family="Caveat, cursive" font-weight="700" font-size="24" fill="${INK}" text-anchor="middle">${label}</text>`
    : '';
  return `<circle cx="${x}" cy="${y}" r="78" fill="${fill}" stroke="${INK}" stroke-width="4"/><ellipse cx="${x - 22}" cy="${y - 22}" rx="20" ry="14" fill="${deep}" opacity="0.25"/>${dots}${labelEl}`;
}

function rRing(c) {
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const fill = color(c.color, 'sky');
  const label = esc((c.label || '').slice(0, 60));
  const labelEl = label
    ? `<text x="${x}" y="${y + 110}" font-family="Caveat, cursive" font-weight="700" font-size="24" fill="${INK}" text-anchor="middle">${label}</text>`
    : '';
  return `<circle cx="${x}" cy="${y}" r="78" fill="${fill}" stroke="${INK}" stroke-width="4"/><circle cx="${x}" cy="${y}" r="32" fill="${PAPER}" stroke="${INK}" stroke-width="4"/>${labelEl}`;
}

function rBox(c) {
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const fill = color(c.color, 'green');
  const label = esc((c.label || '').slice(0, 60));
  const dots = dotsAt(x, y, c.dots);
  const labelEl = label
    ? `<text x="${x}" y="${y + 95}" font-family="Caveat, cursive" font-weight="700" font-size="24" fill="${INK}" text-anchor="middle">${label}</text>`
    : '';
  return `<rect x="${x - 90}" y="${y - 65}" width="180" height="130" rx="8" fill="${fill}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>${dots}${labelEl}`;
}

function rDrop(c) {
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const fill = color(c.color, 'sky');
  const label = esc((c.label || '').slice(0, 60));
  const labelEl = label
    ? `<text x="${x}" y="${y + 100}" font-family="Caveat, cursive" font-weight="700" font-size="24" fill="${INK}" text-anchor="middle">${label}</text>`
    : '';
  return `<path d="M ${x} ${y - 80} Q ${x + 60} ${y - 20} ${x + 60} ${y + 20} Q ${x + 60} ${y + 70} ${x} ${y + 70} Q ${x - 60} ${y + 70} ${x - 60} ${y + 20} Q ${x - 60} ${y - 20} ${x} ${y - 80} Z" fill="${fill}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>${labelEl}`;
}

function rLeaf(c) {
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const fill = color(c.color, 'green');
  const label = esc((c.label || '').slice(0, 60));
  const labelEl = label
    ? `<text x="${x}" y="${y + 100}" font-family="Caveat, cursive" font-weight="700" font-size="24" fill="${INK}" text-anchor="middle">${label}</text>`
    : '';
  return `<path d="M ${x - 90} ${y + 30} Q ${x - 50} ${y - 80} ${x + 60} ${y - 50} Q ${x + 110} ${y - 10} ${x + 80} ${y + 50} Q ${x + 30} ${y + 90} ${x - 50} ${y + 70} Q ${x - 90} ${y + 60} ${x - 90} ${y + 30} Z" fill="${fill}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>${labelEl}`;
}

function rStar(c) {
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const fill = color(c.color, 'yellow');
  return `<path d="M ${x} ${y - 40} L ${x + 12} ${y - 10} L ${x + 40} ${y - 8} L ${x + 16} ${y + 10} L ${x + 24} ${y + 38} L ${x} ${y + 22} L ${x - 24} ${y + 38} L ${x - 16} ${y + 10} L ${x - 40} ${y - 8} L ${x - 12} ${y - 10} Z" fill="${fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
}

function rChain(c) {
  // a curving line of beads — for proteins, polymers, dna links
  const x = clamp(num(c.x, W / 2), 0, W);
  const y = clamp(num(c.y, H / 2), 0, H);
  const fill = color(c.color, 'orange');
  const label = esc((c.label || '').slice(0, 60));
  const labelEl = label
    ? `<text x="${x}" y="${y + 70}" font-family="Caveat, cursive" font-weight="700" font-size="24" fill="${INK}" text-anchor="middle">${label}</text>`
    : '';
  return `<path d="M ${x - 100} ${y + 30} Q ${x - 50} ${y - 20} ${x} ${y} Q ${x + 50} ${y + 20} ${x + 100} ${y - 25}" fill="none" stroke="${INK}" stroke-width="3"/><circle cx="${x - 100}" cy="${y + 30}" r="14" fill="${fill}" stroke="${INK}" stroke-width="3"/><circle cx="${x - 50}" cy="${y}" r="14" fill="${fill}" stroke="${INK}" stroke-width="3"/><circle cx="${x}" cy="${y}" r="14" fill="${fill}" stroke="${INK}" stroke-width="3"/><circle cx="${x + 50}" cy="${y + 3}" r="14" fill="${fill}" stroke="${INK}" stroke-width="3"/><circle cx="${x + 100}" cy="${y - 25}" r="14" fill="${fill}" stroke="${INK}" stroke-width="3"/>${labelEl}`;
}

const RENDERERS = {
  title:  rTitle,
  text:   rText,
  circle: rCircle,
  rect:   rRect,
  line:   rLine,
  arrow:  rArrow,
  wedge:  rWedge,
  blob:   rBlob,
  sphere: rSphere,
  ring:   rRing,
  box:    rBox,
  drop:   rDrop,
  leaf:   rLeaf,
  star:   rStar,
  chain:  rChain,
};

export const DRAW_KINDS = Object.keys(RENDERERS);

// True when scene.draw is an array we can render. Tolerant: the model
// can drop in unknown kinds (we skip them) so long as at least one
// known shape is in there.
export function isValidDraw(draw) {
  if (!Array.isArray(draw)) return false;
  return draw.some(c => c && typeof c === 'object' && RENDERERS[c.k]);
}

export function renderDraw(draw, opts = {}) {
  if (!Array.isArray(draw)) return null;
  const titleProvided = draw.some(c => c?.k === 'title');
  const fragments = [];
  for (const cmd of draw) {
    if (!cmd || typeof cmd !== 'object') continue;
    const fn = RENDERERS[cmd.k];
    if (!fn) continue;
    try {
      fragments.push(fn(cmd));
    } catch (e) {
      // one bad command shouldn't kill the whole picture
      console.warn('[wonderlab] draw command failed:', cmd, e?.message);
    }
  }
  // If the model didn't include a title command but a title was passed in,
  // prepend one so the picture has a heading.
  let titleSvg = '';
  if (!titleProvided && opts.title) {
    titleSvg = rTitle({ s: opts.title });
  }
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id="draw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="${INK}"/>
      </marker>
    </defs>
    <rect width="${W}" height="${H}" fill="${PAPER}"/>
    ${titleSvg}
    ${fragments.join('\n')}
  </svg>`.trim();
}
