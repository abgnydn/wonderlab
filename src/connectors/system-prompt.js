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
  inflight = fetch(PROMPT_URL, { cache: 'force-cache' })
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
