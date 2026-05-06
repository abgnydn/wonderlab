// =============================================================
// system-prompt.js — fetches the system prompt once and caches it.
// In dev (Node server) the URL is /server/system-prompt.txt.
// In Cloudflare deployment the same path will resolve to a static
// asset bundled into the deploy directory.
//
// This file also owns the small set of "user directives" we append
// to the visitor's question before sending — JSON-only, no-image,
// and (newest) the response language.
// =============================================================

const PROMPT_URL = '/system-prompt.txt';

let cached = null;
let inflight = null;

export function getSystemPrompt() {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  // We used to use cache:'force-cache' here, but that caused old
  // prompts to stick around for visitors who'd loaded the site once
  // and never hard-refreshed. Now we use 'no-cache' (sends a
  // conditional request: server can 304 if nothing changed, full
  // body otherwise), so prompt updates land within one normal reload.
  inflight = fetch(PROMPT_URL, { cache: 'no-cache' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`couldn't load system prompt (HTTP ${res.status})`);
      cached = await res.text();
      return cached;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// User directive appended when illustration generation is OFF.
export const NO_IMAGE_DIRECTIVE =
  '\n\n[mode: text-only — do NOT include scene.illustration_svg. Skip the SVG entirely; ' +
  'fill in everything else as usual: reply, answer.kid, answer.real, scene.question, research.*]';

// User directive appended when JSON-only output is required.
export const JSON_ONLY_DIRECTIVE =
  '\n\nReply with a single JSON object matching the contract. No prose, no markdown fences, no /think.';

// =============================================================
// Language support — visitor picks a language in settings; we tell
// iris to answer in it. Translation rule (kid-words on the front)
// still applies — just in their language.
//
// answer.real, glossary.real_term, research.*, field, and the
// benchmark name stay in English so the backend mapping still
// resolves to the right Hugging Face / TDC link.
// =============================================================

// Curated list of languages with their native names. This is the
// single source of truth — the settings picker, the directive, and
// the auto-detect resolver all read from it.
export const LANGUAGES = [
  { code: 'auto',  label: 'auto (match my browser)' },
  { code: 'en',    label: 'English' },
  { code: 'tr',    label: 'Türkçe' },
  { code: 'es',    label: 'Español' },
  { code: 'pt',    label: 'Português' },
  { code: 'fr',    label: 'Français' },
  { code: 'de',    label: 'Deutsch' },
  { code: 'it',    label: 'Italiano' },
  { code: 'nl',    label: 'Nederlands' },
  { code: 'sv',    label: 'Svenska' },
  { code: 'pl',    label: 'Polski' },
  { code: 'ru',    label: 'Русский' },
  { code: 'uk',    label: 'Українська' },
  { code: 'ar',    label: 'العربية' },
  { code: 'fa',    label: 'فارسی' },
  { code: 'hi',    label: 'हिन्दी' },
  { code: 'bn',    label: 'বাংলা' },
  { code: 'ur',    label: 'اردو' },
  { code: 'id',    label: 'Bahasa Indonesia' },
  { code: 'vi',    label: 'Tiếng Việt' },
  { code: 'th',    label: 'ไทย' },
  { code: 'ja',    label: '日本語' },
  { code: 'ko',    label: '한국어' },
  { code: 'zh',    label: '中文' },
];

const NATIVE_NAME = Object.fromEntries(LANGUAGES.map(l => [l.code, l.label]));
// English label for the directive itself, so the LLM gets the canonical name.
const ENGLISH_NAME = {
  en: 'English',  tr: 'Turkish', es: 'Spanish',  pt: 'Portuguese', fr: 'French',
  de: 'German',   it: 'Italian', nl: 'Dutch',    sv: 'Swedish',    pl: 'Polish',
  ru: 'Russian',  uk: 'Ukrainian', ar: 'Arabic', fa: 'Persian',    hi: 'Hindi',
  bn: 'Bengali',  ur: 'Urdu',    id: 'Indonesian', vi: 'Vietnamese', th: 'Thai',
  ja: 'Japanese', ko: 'Korean',  zh: 'Chinese',
};

// Resolve a user setting ("auto" | "en" | "tr" | …) to a concrete code.
// "auto" reads navigator.language; unknown codes fall back to English.
export function resolveLanguage(setting) {
  const supported = new Set(Object.keys(NATIVE_NAME));
  supported.delete('auto');
  if (!setting || setting === 'auto') {
    const browser = (typeof navigator !== 'undefined' ? (navigator.language || 'en') : 'en')
      .toLowerCase().split('-')[0];
    return supported.has(browser) ? browser : 'en';
  }
  return supported.has(setting) ? setting : 'en';
}

// Depth knob — translates the visitor's selection into a directive that
// nudges iris's voice. The schema's `level` field already exists, but
// the knob lets the visitor pick *up front* so we don't waste a turn
// guessing. Default ("curious") gets no directive — the prompt already
// targets that depth.
export function levelDirective(level) {
  const lvl = (level || 'curious').toLowerCase();
  if (lvl === 'curious' || !lvl) return '';
  if (lvl === 'kid') {
    return [
      '',
      '',
      '[depth: kid — even simpler than usual. 5-year-old voice in `reply` and `answer.kid`.',
      'Shorter sentences. One concrete picture. Set `level` to "kid".',
      'No technical terms anywhere visible. Tell the picture before you tell the words.]',
    ].join('\n');
  }
  if (lvl === 'expert' || lvl === 'grad') {
    return [
      '',
      '',
      '[depth: grad — the visitor is a researcher or grad student.',
      'Keep `reply` and `answer.kid` plain-words (the translation rule never breaks),',
      'but write `answer.real` as a real 3-5 sentence paragraph with proper terminology, mechanism, and one named open question.',
      'Glossary entries should pair the kid-words to precise technical terms (not approximations).',
      '`research.open_question` should name the actual frontier — be specific about what is unknown.',
      'Set `level` to "expert".]',
    ].join('\n');
  }
  return '';
}

// Build the user directive appended to the question. English needs no
// directive (the prompt already speaks English).
export function languageDirective(language) {
  const code = resolveLanguage(language);
  if (code === 'en') return '';
  const native  = NATIVE_NAME[code]  || code;
  const english = ENGLISH_NAME[code] || code;
  return [
    '',
    '',
    `[Visitor language: ${english} (${native}, code "${code}").`,
    `Reply ENTIRELY in ${english} for every visible field — reply, answer.kid, scene.question, follow_ups, and any text inside the SVG (including the title at the top of the picture).`,
    `The kid-words rule still applies in ${english}: avoid the ${english} equivalents of the banned technical terms; swap them for everyday metaphors a 7-year-old in ${english} would recognize.`,
    `Keep these in English so the backend mapping still works: answer.real, answer.glossary.real_term, research.open_question, research.benchmark, and the field tag.]`,
  ].join('\n');
}
