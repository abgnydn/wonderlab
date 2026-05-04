// =============================================================
// iris-art.js — Iris as a hand-authored 2D illustration that
// renders to a canvas texture, then maps onto a billboard plane
// in the 3D lab.
//
// We export a few "poses" for different states. Each is a full
// SVG string with the same viewBox so they swap cleanly:
//
//   IDLE_SMILE     — default standing, eyes open, gentle smile
//   IDLE_BLINK     — same pose, eyes closed (blink frame)
//   TALKING        — mouth open, slightly different brows
//   POINTING_BOARD — same upper body, marker arm fully extended
//
// All paths use a consistent palette tied to the lab room.
// =============================================================

const PALETTE = {
  ink:        '#2D2622',
  inkSoft:    '#5C4A3F',
  skin:       '#FBD2B0',
  skinShade:  '#E8B388',
  blush:      '#FF9B94',
  hair:       '#6B4626',
  hairShade:  '#4D3018',
  coat:       '#FFFFFF',
  coatShade:  '#E8E0CB',
  coatTrim:   '#FFE4A8',
  pants:      '#4A5570',
  pantsShade: '#363D52',
  shoes:      '#2D2622',
  marker:     '#E66363',
  badge:      '#FFD16B',
  bow:        '#FF8AAD',
  bowShade:   '#E0688D',
  catchlight: '#FFFFFF',
  cheek:      '#FFB7A8',
  smile:      '#C56565',
};

// Reusable filter + gradient defs (same across poses).
const DEFS = `
  <defs>
    <radialGradient id="cheekGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%"  stop-color="${PALETTE.blush}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${PALETTE.blush}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="hairShine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="${PALETTE.hairShade}"/>
      <stop offset="55%" stop-color="${PALETTE.hair}"/>
      <stop offset="100%" stop-color="${PALETTE.hairShade}"/>
    </linearGradient>
    <linearGradient id="coatShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="${PALETTE.coat}"/>
      <stop offset="100%" stop-color="${PALETTE.coatShade}"/>
    </linearGradient>
    <radialGradient id="floorShadow" cx="50%" cy="50%" r="50%">
      <stop offset="0%"  stop-color="${PALETTE.inkSoft}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${PALETTE.inkSoft}" stop-opacity="0"/>
    </radialGradient>
  </defs>
`;

// Body, arms, legs — shared base across every pose.
// Head + face is appended PER pose so we can swap eyes/mouth.
function bodyBase({ markerArmAngle = -28 } = {}) {
  return `
    <!-- soft floor shadow -->
    <ellipse cx="300" cy="870" rx="160" ry="20" fill="url(#floorShadow)"/>

    <!-- legs: dark pants -->
    <g>
      <path d="M 245 720 L 245 850 Q 245 858 253 858 L 285 858 Q 293 858 293 850 L 293 720 Z"
            fill="${PALETTE.pants}" stroke="${PALETTE.ink}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M 307 720 L 307 850 Q 307 858 315 858 L 347 858 Q 355 858 355 850 L 355 720 Z"
            fill="${PALETTE.pants}" stroke="${PALETTE.ink}" stroke-width="3" stroke-linejoin="round"/>
      <!-- subtle pant fold -->
      <line x1="269" y1="745" x2="269" y2="850" stroke="${PALETTE.pantsShade}" stroke-width="2"/>
      <line x1="331" y1="745" x2="331" y2="850" stroke="${PALETTE.pantsShade}" stroke-width="2"/>
    </g>

    <!-- shoes -->
    <ellipse cx="269" cy="858" rx="32" ry="11" fill="${PALETTE.shoes}" stroke="${PALETTE.ink}" stroke-width="2.5"/>
    <ellipse cx="331" cy="858" rx="32" ry="11" fill="${PALETTE.shoes}" stroke="${PALETTE.ink}" stroke-width="2.5"/>

    <!-- left arm (down at side) — DRAWN BEHIND BODY -->
    <g>
      <path d="M 188 405 Q 178 530 195 660 Q 200 685 218 685 Q 230 685 232 660 Q 232 530 222 405 Z"
            fill="url(#coatShade)" stroke="${PALETTE.ink}" stroke-width="3" stroke-linejoin="round"/>
      <!-- left hand -->
      <circle cx="217" cy="700" r="22" fill="${PALETTE.skin}" stroke="${PALETTE.ink}" stroke-width="3"/>
    </g>

    <!-- BODY: lab coat (pear-shaped) -->
    <path d="M 195 380 Q 200 350 240 340 Q 300 332 360 340 Q 400 350 405 380 L 425 720 Q 380 740 300 740 Q 220 740 175 720 Z"
          fill="url(#coatShade)" stroke="${PALETTE.ink}" stroke-width="3.5" stroke-linejoin="round"/>
    <!-- coat lapels -->
    <path d="M 250 360 L 300 410 L 350 360 L 340 470 L 300 500 L 260 470 Z"
          fill="${PALETTE.coatTrim}" stroke="${PALETTE.ink}" stroke-width="2.5" stroke-linejoin="round"/>
    <!-- coat buttons -->
    <circle cx="300" cy="510" r="4" fill="${PALETTE.ink}"/>
    <circle cx="300" cy="555" r="4" fill="${PALETTE.ink}"/>
    <circle cx="300" cy="600" r="4" fill="${PALETTE.ink}"/>
    <!-- coat seam down center -->
    <line x1="300" y1="500" x2="300" y2="720" stroke="${PALETTE.coatShade}" stroke-width="1.5" stroke-dasharray="3 3"/>
    <!-- ID badge -->
    <g>
      <line x1="240" y1="395" x2="232" y2="430" stroke="${PALETTE.ink}" stroke-width="1.5"/>
      <rect x="218" y="430" width="32" height="22" rx="3" fill="${PALETTE.badge}" stroke="${PALETTE.ink}" stroke-width="2"/>
      <circle cx="225" cy="438" r="3" fill="${PALETTE.coat}" stroke="${PALETTE.ink}" stroke-width="0.8"/>
      <line x1="222" y1="446" x2="246" y2="446" stroke="${PALETTE.ink}" stroke-width="0.8"/>
    </g>
    <!-- breast pocket with pen -->
    <rect x="343" y="430" width="36" height="38" rx="2" fill="none" stroke="${PALETTE.ink}" stroke-width="1.8"/>
    <line x1="361" y1="425" x2="361" y2="455" stroke="${PALETTE.sky || '#7CB7D0'}" stroke-width="3.5" stroke-linecap="round"/>

    <!-- right arm (raised, holding marker) -->
    <g transform="translate(380 360) rotate(${markerArmAngle})">
      <path d="M -18 0 Q -28 60 -16 130 Q -8 152 14 152 Q 28 150 30 130 Q 30 60 22 0 Z"
            fill="url(#coatShade)" stroke="${PALETTE.ink}" stroke-width="3" stroke-linejoin="round"/>
      <!-- right hand -->
      <circle cx="7" cy="158" r="22" fill="${PALETTE.skin}" stroke="${PALETTE.ink}" stroke-width="3"/>
      <!-- marker -->
      <g transform="translate(7 158) rotate(-15)">
        <rect x="-4" y="-46" width="14" height="46" rx="2.5" fill="${PALETTE.marker}" stroke="${PALETTE.ink}" stroke-width="2"/>
        <rect x="-3" y="-50" width="12" height="6" fill="${PALETTE.ink}"/>
      </g>
    </g>
  `;
}

// HEAD: shared base (skin, hair, blush, glasses). Eyes/mouth/brows added per pose.
function headBase() {
  return `
    <!-- neck -->
    <rect x="282" y="335" width="36" height="22" fill="${PALETTE.skin}" stroke="${PALETTE.ink}" stroke-width="2.5"/>
    <!-- head shape — slightly elongated round -->
    <ellipse cx="300" cy="240" rx="100" ry="115"
             fill="${PALETTE.skin}" stroke="${PALETTE.ink}" stroke-width="3.5"/>
    <!-- ear hint -->
    <path d="M 200 240 Q 188 250 195 275 Q 205 290 210 280" fill="${PALETTE.skin}" stroke="${PALETTE.ink}" stroke-width="2.5"/>

    <!-- HAIR: tousled top + side bang -->
    <path d="M 215 165 Q 200 110 240 90 Q 265 70 300 75 Q 340 68 365 92 Q 400 110 388 168
             Q 392 195 380 215 Q 360 195 340 200 Q 320 175 300 195 Q 275 175 260 200 Q 240 195 220 215 Q 208 195 215 165 Z"
          fill="url(#hairShine)" stroke="${PALETTE.ink}" stroke-width="3" stroke-linejoin="round"/>
    <!-- side bang -->
    <path d="M 230 175 Q 225 145 260 145 Q 285 155 270 200 Q 255 215 235 205 Z"
          fill="${PALETTE.hair}" stroke="${PALETTE.ink}" stroke-width="2.5" stroke-linejoin="round"/>
    <!-- a couple of stray strands for life -->
    <path d="M 260 95 Q 270 88 282 96" fill="none" stroke="${PALETTE.ink}" stroke-width="2" stroke-linecap="round"/>
    <path d="M 320 90 Q 332 84 344 92" fill="none" stroke="${PALETTE.ink}" stroke-width="2" stroke-linecap="round"/>

    <!-- pink bow on top, slightly off-center -->
    <g transform="translate(360 90) rotate(20)">
      <ellipse cx="-13" cy="0" rx="18" ry="10" fill="${PALETTE.bow}" stroke="${PALETTE.ink}" stroke-width="2"/>
      <ellipse cx="13"  cy="0" rx="18" ry="10" fill="${PALETTE.bow}" stroke="${PALETTE.ink}" stroke-width="2"/>
      <circle  cx="0"   cy="0" r="6" fill="${PALETTE.bowShade}" stroke="${PALETTE.ink}" stroke-width="2"/>
    </g>

    <!-- big rosy cheek blush — soft radial -->
    <ellipse cx="245" cy="270" rx="22" ry="14" fill="url(#cheekGrad)"/>
    <ellipse cx="355" cy="270" rx="22" ry="14" fill="url(#cheekGrad)"/>

    <!-- tiny round nose -->
    <circle cx="300" cy="262" r="3.5" fill="${PALETTE.skinShade}"/>

    <!-- glasses — round frames -->
    <g fill="none" stroke="${PALETTE.ink}" stroke-width="3">
      <circle cx="262" cy="232" r="28"/>
      <circle cx="338" cy="232" r="28"/>
      <line x1="289" y1="230" x2="311" y2="230" stroke-width="3.5"/>
      <!-- temple arms -->
      <line x1="234" y1="232" x2="220" y2="225" stroke-linecap="round"/>
      <line x1="366" y1="232" x2="380" y2="225" stroke-linecap="round"/>
    </g>
    <!-- lens highlight -->
    <ellipse cx="252" cy="222" rx="8" ry="5" fill="${PALETTE.coat}" opacity="0.45"/>
    <ellipse cx="328" cy="222" rx="8" ry="5" fill="${PALETTE.coat}" opacity="0.45"/>
  `;
}

// === Eyes / mouth variations per pose ===

// Open eyes with catchlights, gentle smile
function faceIdleSmile() {
  return `
    <!-- eyebrows: slight upward arc -->
    <path d="M 240 200 Q 262 192 285 200" fill="none" stroke="${PALETTE.ink}" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M 315 200 Q 338 192 360 200" fill="none" stroke="${PALETTE.ink}" stroke-width="3.5" stroke-linecap="round"/>

    <!-- eye whites -->
    <ellipse cx="262" cy="234" rx="14" ry="16" fill="${PALETTE.coat}" stroke="${PALETTE.ink}" stroke-width="2"/>
    <ellipse cx="338" cy="234" rx="14" ry="16" fill="${PALETTE.coat}" stroke="${PALETTE.ink}" stroke-width="2"/>
    <!-- pupils -->
    <circle cx="263" cy="236" r="8.5" fill="${PALETTE.ink}"/>
    <circle cx="339" cy="236" r="8.5" fill="${PALETTE.ink}"/>
    <!-- catchlights — the magic for a "alive" feel -->
    <circle cx="267" cy="232" r="3" fill="${PALETTE.catchlight}"/>
    <circle cx="343" cy="232" r="3" fill="${PALETTE.catchlight}"/>
    <circle cx="261" cy="240" r="1.3" fill="${PALETTE.catchlight}" opacity="0.7"/>
    <circle cx="337" cy="240" r="1.3" fill="${PALETTE.catchlight}" opacity="0.7"/>

    <!-- mouth: gentle smile -->
    <path d="M 282 295 Q 300 308 318 295" fill="none" stroke="${PALETTE.smile}" stroke-width="3.5" stroke-linecap="round"/>
  `;
}

// Eyes closed (blink frame)
function faceBlink() {
  return `
    <!-- eyebrows -->
    <path d="M 240 200 Q 262 192 285 200" fill="none" stroke="${PALETTE.ink}" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M 315 200 Q 338 192 360 200" fill="none" stroke="${PALETTE.ink}" stroke-width="3.5" stroke-linecap="round"/>

    <!-- closed eyes — short upward arcs (happy-eyes vibe) -->
    <path d="M 248 234 Q 262 226 276 234" fill="none" stroke="${PALETTE.ink}" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M 324 234 Q 338 226 352 234" fill="none" stroke="${PALETTE.ink}" stroke-width="3.5" stroke-linecap="round"/>

    <!-- mouth -->
    <path d="M 282 295 Q 300 308 318 295" fill="none" stroke="${PALETTE.smile}" stroke-width="3.5" stroke-linecap="round"/>
  `;
}

// Talking — small open mouth + slightly raised brows
function faceTalking() {
  return `
    <!-- eyebrows raised -->
    <path d="M 240 196 Q 262 186 285 196" fill="none" stroke="${PALETTE.ink}" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M 315 196 Q 338 186 360 196" fill="none" stroke="${PALETTE.ink}" stroke-width="3.5" stroke-linecap="round"/>

    <!-- eye whites -->
    <ellipse cx="262" cy="234" rx="14" ry="16" fill="${PALETTE.coat}" stroke="${PALETTE.ink}" stroke-width="2"/>
    <ellipse cx="338" cy="234" rx="14" ry="16" fill="${PALETTE.coat}" stroke="${PALETTE.ink}" stroke-width="2"/>
    <!-- pupils slightly up — looking at the visitor -->
    <circle cx="263" cy="234" r="8.5" fill="${PALETTE.ink}"/>
    <circle cx="339" cy="234" r="8.5" fill="${PALETTE.ink}"/>
    <circle cx="267" cy="230" r="3" fill="${PALETTE.catchlight}"/>
    <circle cx="343" cy="230" r="3" fill="${PALETTE.catchlight}"/>

    <!-- mouth: small open oval -->
    <ellipse cx="300" cy="298" rx="8" ry="6" fill="${PALETTE.smile}" stroke="${PALETTE.ink}" stroke-width="2"/>
    <!-- inside of mouth slightly darker -->
    <ellipse cx="300" cy="299" rx="5" ry="3.5" fill="${PALETTE.bowShade}"/>
  `;
}

// Compose a full SVG given a face function and a marker arm angle.
function compose(face, opts = {}) {
  return `<svg viewBox="0 0 600 900" xmlns="http://www.w3.org/2000/svg">
    ${DEFS}
    ${bodyBase(opts)}
    ${headBase()}
    ${face()}
  </svg>`;
}

// Public poses
export const IRIS = {
  idle:     compose(faceIdleSmile, { markerArmAngle: -28 }),
  blink:    compose(faceBlink,     { markerArmAngle: -28 }),
  talking:  compose(faceTalking,   { markerArmAngle: -22 }),
  pointing: compose(faceIdleSmile, { markerArmAngle: -55 }),
};
