// =============================================================
// connectors/scene-schema.js — the SceneSpec contract, in OpenAPI
// 3.0 subset that Gemini / Gemma 4 native function calling accepts.
//
// The canonical source lives in server/server.js for the local-server
// path; this file mirrors it for the browser connectors. Keep them
// in sync — when one changes, change the other.
//
// Gemini function-calling caveats vs. plain JSON Schema:
//   • `type: ['string', 'null']` is NOT accepted → use `nullable: true`
//   • numeric range / array-length keywords (`minimum`, `maxItems`, …)
//     are ignored — keep them out so future strict validators don't trip
// =============================================================

const SHAPE_ENUM = [
  'title', 'text', 'circle', 'rect', 'line', 'arrow',
  'wedge', 'blob', 'sphere', 'ring', 'box', 'drop',
  'leaf', 'star', 'chain',
  'squiggle', 'tangle', 'wave', 'spiral', 'bolt', 'cluster',
];
const BODY_SHAPE_ENUM = ['wedge', 'blob', 'sphere', 'chain', 'ring', 'box', 'drop', 'leaf'];
const COLOR_ENUM = ['yellow', 'red', 'blue', 'green', 'orange', 'pink', 'sky', 'brown', 'violet', 'cream'];
const SIZE_ENUM  = ['title', 'big', 'label', 'caption'];
const FIELD_ENUM = ['astronomy', 'biology', 'chemistry', 'physics', 'climate',
                    'medicine', 'geology', 'food', 'psychology', 'tech',
                    'math', 'general'];

export const SCENE_SCHEMA = {
  type: 'object',
  required: ['level', 'reply', 'answer', 'scene', 'research'],
  properties: {
    level: { type: 'string', enum: ['kid', 'curious', 'expert'] },
    reply: { type: 'string', description: '2-3 plain-words sentences that point at the picture' },
    answer: {
      type: 'object',
      required: ['kid', 'real'],
      properties: {
        kid:  { type: 'string', description: 'even simpler 1-2 sentences' },
        real: { type: 'string', description: '1-2 honest scientific sentences — never rendered' },
        glossary: {
          type: 'array',
          description: '3-6 kid_word → real_term pairs',
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
        question: { type: 'string', description: '4-8 word plain-words title' },
        draw: {
          type: 'array',
          description: 'Drawing commands on an 800×500 canvas. Layer body shape + state primitive + marks per Johnstone\'s three layers.',
          items: {
            type: 'object',
            required: ['k'],
            properties: {
              k:     { type: 'string', enum: SHAPE_ENUM },
              x:     { type: 'integer' }, y:  { type: 'integer' },
              x1:    { type: 'integer' }, y1: { type: 'integer' },
              x2:    { type: 'integer' }, y2: { type: 'integer' },
              r:     { type: 'integer' },
              w:     { type: 'integer' }, h:  { type: 'integer' },
              s:     { type: 'string' }, label: { type: 'string' }, text: { type: 'string' },
              color: { type: 'string', enum: COLOR_ENUM },
              size:  { type: 'string', enum: SIZE_ENUM },
              dots:  { type: 'integer' },
            },
          },
        },
        template: {
          type: 'object',
          description: 'Fallback two-column layout when draw[] doesn\'t fit',
          properties: {
            kind:  { type: 'string', enum: ['before-after'] },
            title: { type: 'string' },
            left: {
              type: 'object',
              properties: {
                shape: { type: 'string', enum: BODY_SHAPE_ENUM },
                color: { type: 'string', enum: COLOR_ENUM },
                label: { type: 'string' },
                dots:  { type: 'integer' },
              },
            },
            right: {
              type: 'object',
              properties: {
                shape: { type: 'string', enum: BODY_SHAPE_ENUM },
                color: { type: 'string', enum: COLOR_ENUM },
                label: { type: 'string' },
                dots:  { type: 'integer' },
              },
            },
            arrow_label: { type: 'string' },
          },
        },
        illustration_svg: { type: 'string', description: 'Escape hatch: raw SVG markup' },
        narration: { type: 'string', description: '30-60s kid-voice walk-through' },
      },
    },
    research: {
      type: 'object',
      required: ['open_question', 'benchmark'],
      properties: {
        open_question: { type: 'string' },
        benchmark:     { type: 'string', nullable: true },
      },
    },
    follow_ups: {
      type: 'array',
      description: '2-3 "what do you think happens if…" predictions — not topic branches',
      items: { type: 'string' },
    },
    field: { type: 'string', enum: FIELD_ENUM },
  },
};

// Text-only variant (no SVG / scene illustration). Used when the user
// turns drawing off — saves tokens on small / local models.
export const SCENE_SCHEMA_NO_IMAGE = {
  type: 'object',
  required: ['level', 'reply', 'answer', 'scene', 'research'],
  properties: {
    level: SCENE_SCHEMA.properties.level,
    reply: SCENE_SCHEMA.properties.reply,
    answer: SCENE_SCHEMA.properties.answer,
    scene: {
      type: 'object',
      required: ['question'],
      properties: { question: SCENE_SCHEMA.properties.scene.properties.question },
    },
    research:  SCENE_SCHEMA.properties.research,
    follow_ups: SCENE_SCHEMA.properties.follow_ups,
    field:     SCENE_SCHEMA.properties.field,
  },
};

// Function declaration form expected by Gemini's tools API.
export function renderSceneTool(withImage = true) {
  return {
    name: 'render_scene',
    description: 'Render a translation-layer scene for the visitor: plain-words reply, kid answer, whiteboard illustration, and real-research tie-in.',
    parameters: withImage ? SCENE_SCHEMA : SCENE_SCHEMA_NO_IMAGE,
  };
}
