// =============================================================
// Opening "welcome" scene. Shown until the visitor asks something.
// Now parametric on the visitor's name (from localStorage).
// =============================================================

export function makeWelcomeSpec(name = '', lastQuestion = '') {
  const isReturning = !!(name && lastQuestion);
  const greeting = isReturning
    ? `welcome back, ${escapeXml(name)} ✦`
    : (name ? `hi ${escapeXml(name)}! ✦` : 'welcome ✦');
  const subtitle = isReturning
    ? "want to chase the last thing — or wonder about something new?"
    : (name ? "what should we wonder about today?" : "what do you wonder about?");

  return {
    id: 'welcome',
    question: greeting,
    answer: {
      kid:  "type a question below — or grab a sticky from the corkboard. or just walk around and click on stuff.",
      real: "Default welcome state. Replaced on first /api/ask response.",
    },
    illustration_svg: `<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#FFF8E8"/>
          <stop offset="60%"  stop-color="#FCEFD2"/>
          <stop offset="100%" stop-color="#FFE9A8"/>
        </linearGradient>
        <radialGradient id="sunGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stop-color="#FFD16B" stop-opacity="0.9"/>
          <stop offset="100%" stop-color="#FFD16B" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="800" height="500" fill="url(#bg)"/>

      <!-- floating wonder icons across the top, drawn small + warm -->
      <!-- tiny sun upper-left -->
      <g transform="translate(80 80)">
        <circle r="40" fill="url(#sunGlow)"/>
        <circle r="20" fill="#FFD16B" stroke="#2D2622" stroke-width="2.5"/>
        <g stroke="#FFD16B" stroke-width="3" stroke-linecap="round">
          <line x1="0" y1="-30" x2="0" y2="-38"/>
          <line x1="22" y1="-22" x2="28" y2="-28"/>
          <line x1="30" y1="0" x2="38" y2="0"/>
          <line x1="22" y1="22" x2="28" y2="28"/>
          <line x1="0" y1="30" x2="0" y2="38"/>
          <line x1="-22" y1="22" x2="-28" y2="28"/>
          <line x1="-30" y1="0" x2="-38" y2="0"/>
          <line x1="-22" y1="-22" x2="-28" y2="-28"/>
        </g>
      </g>

      <!-- planet upper-right with ring -->
      <g transform="translate(700 90)">
        <ellipse rx="55" ry="14" fill="none" stroke="#F4B942" stroke-width="3" transform="rotate(-15)"/>
        <circle r="32" fill="#7CB7D0" stroke="#2D2622" stroke-width="2.5"/>
        <circle cx="-10" cy="-8" r="5" fill="#5C4A3F"/>
        <circle cx="12" cy="6" r="3" fill="#5C4A3F"/>
        <ellipse rx="55" ry="14" fill="none" stroke="#2D2622" stroke-width="1" stroke-dasharray="3 4" transform="rotate(-15)"/>
      </g>

      <!-- egg mid-left -->
      <g transform="translate(70 380)">
        <ellipse rx="34" ry="42" fill="#FFFCEC" stroke="#2D2622" stroke-width="2.5"/>
        <ellipse cx="-8" cy="-16" rx="6" ry="3" fill="#2D2622" opacity="0.15"/>
      </g>

      <!-- leaf bottom -->
      <g transform="translate(180 430) rotate(-15)">
        <path d="M0 0 Q -25 -10 -32 -38 Q 0 -42 32 -38 Q 25 -10 0 0 Z" fill="#B8DFA0" stroke="#2D2622" stroke-width="2"/>
        <line x1="0" y1="0" x2="0" y2="-38" stroke="#2D2622" stroke-width="1.5"/>
      </g>

      <!-- balloon -->
      <g transform="translate(720 380)">
        <ellipse rx="25" ry="32" fill="#FF9B94" stroke="#2D2622" stroke-width="2.5"/>
        <path d="M0 32 L -3 38 L 3 38 Z" fill="#2D2622"/>
        <path d="M0 38 Q 5 60, -2 80" fill="none" stroke="#2D2622" stroke-width="1.5"/>
        <ellipse cx="-8" cy="-12" rx="5" ry="3" fill="#FFFFFF" opacity="0.6"/>
      </g>

      <!-- magnifying glass mid-right -->
      <g transform="translate(610 380) rotate(20)">
        <circle r="22" fill="rgba(124,183,208,0.25)" stroke="#2D2622" stroke-width="3"/>
        <line x1="16" y1="16" x2="34" y2="34" stroke="#2D2622" stroke-width="5" stroke-linecap="round"/>
      </g>

      <!-- tiny atom mid -->
      <g transform="translate(450 390)">
        <ellipse rx="22" ry="9" fill="none" stroke="#7CB7D0" stroke-width="2"/>
        <ellipse rx="22" ry="9" fill="none" stroke="#FF8AAD" stroke-width="2" transform="rotate(60)"/>
        <ellipse rx="22" ry="9" fill="none" stroke="#F4B942" stroke-width="2" transform="rotate(-60)"/>
        <circle r="4" fill="#2D2622"/>
      </g>

      <!-- sparkles scattered -->
      <g font-family="Caveat,cursive" font-size="32" fill="#F4B942">
        <text x="200" y="120">✦</text>
        <text x="600" y="180" fill="#FF9B94">✦</text>
        <text x="240" y="320" fill="#7CB7D0">✦</text>
        <text x="540" y="320" fill="#FFD16B">✦</text>
        <text x="380" y="100" fill="#B8DFA0">✦</text>
        <text x="160" y="270" fill="#FF8AAD" font-size="22">✦</text>
        <text x="640" y="290" fill="#7CB7D0" font-size="22">✦</text>
      </g>

      <!-- BIG GREETING — handwritten -->
      <text x="400" y="220"
            font-family="Caveat,cursive" font-weight="700" font-size="84"
            fill="#2D2622" text-anchor="middle"
            transform="rotate(-2 400 220)">${greeting}</text>

      <!-- subtitle -->
      <text x="400" y="290"
            font-family="Fredoka,sans-serif" font-weight="600" font-size="26"
            fill="#5C4A3F" text-anchor="middle">${escapeXml(subtitle)}</text>

      <!-- soft hint at bottom -->
      <text x="400" y="465"
            font-family="Caveat,cursive" font-size="22"
            fill="#8B6240" text-anchor="middle">type below · grab a sticky · click around · jump with space</text>

      ${isReturning ? renderMemorySticky(lastQuestion) : ''}
    </svg>`,
  };
}

// Sticky note in the lower-left that says "last time we wondered about X".
// Tilted -3°, sun-yellow, taped on. Truncates the question and uses SVG
// textLength so even an over-long sentence compresses to fit the sticky
// width instead of spilling past the right edge.
function renderMemorySticky(question) {
  const STICKY_W = 360;
  const STICKY_H = 100;
  const PAD = 20;
  const INNER_W = STICKY_W - PAD * 2;       // text box width inside the sticky
  const trim = String(question).length > 50
    ? String(question).slice(0, 47) + '…'
    : String(question);
  return `
    <g transform="translate(70 360) rotate(-3)">
      <rect width="${STICKY_W}" height="${STICKY_H}" fill="rgba(45,38,34,0.18)"/>
      <rect width="${STICKY_W}" height="${STICKY_H}" fill="#FFE4A8" stroke="#2D2622" stroke-width="2.5"/>
      <rect x="${(STICKY_W - 80) / 2}" y="-12" width="80" height="22" fill="rgba(124,183,208,0.65)"/>
      <text x="${PAD}" y="38" font-family="Caveat,cursive" font-weight="700" font-size="24" fill="#2D2622">last time we wondered:</text>
      <text x="${PAD}" y="72" font-family="Fredoka,sans-serif" font-weight="600" font-size="17" fill="#5C4A3F"
            textLength="${INNER_W}" lengthAdjust="spacingAndGlyphs">"${escapeXml(trim)}"</text>
    </g>
  `;
}

// Backwards-compat — older code imports cheeseSpec.
// Resolved on import time using the persisted name + lastQuestion (if any).
function readName()         { try { return localStorage.getItem('wonderlab.name') || ''; } catch { return ''; } }
function readLastQuestion() { try { return localStorage.getItem('wonderlab.lastQuestion') || ''; } catch { return ''; } }
export const cheeseSpec = makeWelcomeSpec(readName(), readLastQuestion());

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
