// =============================================================
// templates/ — slot-fill picture builders. The model picks a
// template kind + fills in a few slots (shape, color, label).
// We render the SVG procedurally on the client, so EVERY model
// produces a valid picture — small models can't break syntax
// because they never write any SVG.
//
// This is the reliability play. Custom illustration_svg is still
// supported (when the model is capable enough to draw richer
// pictures), but the template is always offered first and is the
// guaranteed-to-render path.
//
// Schema (added to scene.template in the SceneSpec):
//
//   {
//     "kind":  "before-after",      // currently the only kind
//     "title": "why does cheese melt?",
//     "left":  { "shape": "wedge",  "color": "yellow", "label": "cold — pieces hold tight",  "dots": 5 },
//     "right": { "shape": "blob",   "color": "yellow", "label": "warm — pieces slip past",   "dots": 5 },
//     "arrow_label": "heat ↑"
//   }
//
//   shapes: wedge | blob | sphere | chain | ring | box | drop | leaf
//   colors: yellow | red | blue | green | orange | pink | sky | brown | violet
//   dots:   integer 0-6 (specks/atoms inside the shape — atmosphere)
//
// Render returns a `<svg>...</svg>` string. The whiteboard already
// rasterizes SVG strings, so the return value drops cleanly into
// spec.illustration_svg and the existing pipeline carries it.
// =============================================================

import { renderBeforeAfter } from './before-after.js';

// Palette names → hex. The same swatches the system prompt names so
// the model can pick a "color name" without ever seeing a hex code.
export const COLOR_HEX = {
  yellow:  '#FFD16B',
  red:     '#E66363',
  blue:    '#7CB7D0',
  green:   '#B8DFA0',
  orange:  '#FFB7A8',
  pink:    '#FF9B94',
  sky:     '#7CB7D0',
  brown:   '#8B6240',
  violet:  '#B89DD9',
  cream:   '#FFFCEC',
  ink:     '#2D2622',
};

export const COLOR_DEEP = {
  yellow:  '#FFB94D',
  red:     '#C84A4A',
  blue:    '#4D8FA8',
  green:   '#6FB05C',
  orange:  '#FF9B8A',
  pink:    '#E66363',
  sky:     '#4D8FA8',
  brown:   '#5C4226',
  violet:  '#8C6CB0',
  cream:   '#F4E8C9',
  ink:     '#1F1A18',
};

export const SHAPES   = ['wedge', 'blob', 'sphere', 'chain', 'ring', 'box', 'drop', 'leaf'];
export const COLORS   = Object.keys(COLOR_HEX).filter(k => !['cream', 'ink'].includes(k));

export const TEMPLATE_KINDS = ['before-after'];

// Dispatch: build SVG from a template object, or return null if the
// template is invalid / unknown.
export function renderTemplate(template) {
  if (!template || typeof template !== 'object') return null;
  const kind = template.kind || template.type;
  switch (kind) {
    case 'before-after':
    case 'before_after':
    case 'compare':
      return renderBeforeAfter(template);
    default:
      return null;
  }
}

// Lightweight validity check — the model can omit fields and still get
// a picture (we substitute defaults), but the template needs at least
// a kind we know AND one labeled side.
export function isValidTemplate(template) {
  if (!template || typeof template !== 'object') return false;
  const kind = template.kind || template.type;
  if (!kind) return false;
  if (kind === 'before-after' || kind === 'before_after' || kind === 'compare') {
    const hasLeft  = template.left  && (template.left.label  || template.left.shape);
    const hasRight = template.right && (template.right.label || template.right.shape);
    return Boolean(hasLeft && hasRight);
  }
  return false;
}
