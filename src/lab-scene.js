// =============================================================
// lab-scene.js — the OUTER 3D world. The visitor is inside the
// lab. The researcher is a 3D character; the whiteboard is a
// 3D plane whose texture comes from a render-to-target pass of
// the SceneSpec scene (src/scene.js). Canvas-on-canvas.
//
// Responsibilities:
//   - own the WebGL renderer
//   - build the room geometry (floor, walls, desk, lamp, etc.)
//   - build the 3D researcher (geometric primitives for now;
//     will be upgraded later)
//   - build the whiteboard plane and wire its texture to the
//     inner scene's render target
//   - drive the animation loop: tick + render inner → render outer
//
// Public API mirrors what main.js used to call on Scene:
//   labScene.play(spec)   — load a SceneSpec into the inner scene
//   labScene.setValue(v)  — slider 0..1
//   labScene.setZoom(t)   — toggle macro ↔ micro
// =============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { IRIS } from './iris-art.js';

// canvas text-wrap helper — wraps a string into lines that fit `maxWidth`
function wrapText(ctx, text, maxWidth) {
  const words = (text || '').split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const trial = cur ? cur + ' ' + w : w;
    if (ctx.measureText(trial).width > maxWidth && cur) {
      lines.push(cur); cur = w;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// --- room dimensions (metres-ish, just relative units) ---
const ROOM_W = 14;
const ROOM_H = 6.5;
const ROOM_D = 14;

// whiteboard plane size + texture resolution
const BOARD_W   = 6.4;
const BOARD_H   = 4.4;
const TARGET_W  = 1024;
const TARGET_H  = 720;

// the researcher's anchor — standing right next to her whiteboard so
// she's the first thing the visitor sees walking into the room.
//   • whiteboard centre is at (1.4, 2.5, -6.79); back wall at z=-7
//   • RES_Z = -6.0 places her ~0.8 units in front of the board (close
//     enough to read as "her board"). Important: any z > -5.4 puts the
//     desk top in the camera ray to her feet (the desk slab at y≈1.04
//     occludes her bottom half from the default camera angle), so she
//     has to live behind the desk in z, not beside it in x.
//   • RES_X = +4.0 puts her on the RIGHT side of the whiteboard (the
//     visitor's "look at the board" view shows board-then-iris, left
//     to right). Plane (1.8 wide) spans 3.1..4.9, just clipping the
//     whiteboard's right edge (4.6) for the "presenter at her board"
//     read.
const RES_X =  4.0;
const RES_Z = -6.0;

export class LabScene {
  constructor(canvas) {
    this.canvas = canvas;

    // === renderer ============================================
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0xF6E8C4);     // wallpaper colour as fallback

    // === outer world =========================================
    this.world = new THREE.Scene();
    this.world.fog = new THREE.Fog(0xF6E8C4, 12, 28);

    this.cam = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
    // Eye-level, slightly back, framing iris + the whiteboard side-by-side
    this.cam.position.set(0, 1.72, 5.0);

    // === input state ===
    this._keys       = {};
    this._raycaster  = new THREE.Raycaster();
    this._mouse      = new THREE.Vector2();
    this._mouseDown  = null;
    this._dragging   = null;
    this._lastHoverKind = null;
    this._autoT       = 0;
    this._autoEnabled = true;
    this._lastSlider  = 0;
    this._ahaFiredFor = null;
    this.onAha        = null;
    // controls created later, AFTER our click listener, so ours fires first

    // === lighting ============================================
    this.world.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xfff2c8, 0.95);
    key.position.set(2.5, 5.0, 3.2);
    this.world.add(key);
    const rim = new THREE.DirectionalLight(0xa8d0ff, 0.32);
    rim.position.set(-3.0, 2.0, -1.0);
    this.world.add(rim);

    // === build the room ======================================
    this._buildRoom();
    this._buildResearcher();
    this._buildBoard();
    this._buildExtras();

    // === interactivity (MUST install before OrbitControls) ===
    this._setupKeyboard();
    this._setupClick();

    // === free-look orbit controls — full 360° yaw, near-full pitch,
    //     so the visitor can turn anywhere they want.
    this.controls = new OrbitControls(this.cam, canvas);
    this.controls.target.set(0, 1.85, -2.0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan      = false;
    this.controls.enableZoom     = false;
    this.controls.minPolarAngle  = 0.05;            // almost straight up
    this.controls.maxPolarAngle  = Math.PI * 0.95;  // almost straight down
    // azimuth: leave undefined → full rotation
    this.controls.rotateSpeed = 0.7;

    // === whiteboard surface — an HTML canvas painted with the LLM's SVG.
    //     The canvas is the texture on the whiteboard plane in the 3D lab.
    //     When a new spec arrives, we rasterise the SVG into this canvas
    //     and bump needsUpdate. No inner 3D scene anymore.
    this._svgCanvas = document.createElement('canvas');
    this._svgCanvas.width  = TARGET_W;
    this._svgCanvas.height = TARGET_H;
    const ctx0 = this._svgCanvas.getContext('2d');
    ctx0.fillStyle = '#FCEFD2';
    ctx0.fillRect(0, 0, TARGET_W, TARGET_H);
    ctx0.font = '700 56px "Caveat", cursive';
    ctx0.fillStyle = '#2D2622';
    ctx0.textAlign = 'center';
    ctx0.fillText('warming up the lab…', TARGET_W / 2, TARGET_H / 2);

    this._svgTex = new THREE.CanvasTexture(this._svgCanvas);
    this._svgTex.colorSpace = THREE.SRGBColorSpace;
    this.boardMat.map = this._svgTex;
    this.boardMat.needsUpdate = true;

    this._currentSpec = null;

    // === sizing + animation loop ============================
    this._fitCanvas();
    new ResizeObserver(() => this._fitCanvas()).observe(canvas);

    this._lastT = performance.now();
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  // ---------- public API ----------
  async play(spec) {
    this._currentSpec = spec;
    this._ahaFiredFor = null;
    if (typeof spec?.illustration_svg === 'string' && spec.illustration_svg.includes('<svg')) {
      await this._renderSvgToBoard(spec.illustration_svg);
    } else {
      // welcome / fallback — just show the question text in big script
      this._renderTextToBoard(spec?.question || 'warming up the lab…');
    }
  }
  // legacy hooks kept as no-ops in case anything still calls them
  setValue() {}
  setZoom() {}
  setAutoAnimate() {}

  /** Rasterise an SVG string onto the whiteboard canvas → texture. */
  async _renderSvgToBoard(svg) {
    this.clearLoading();
    const W = this._svgCanvas.width, H = this._svgCanvas.height;
    const ctx = this._svgCanvas.getContext('2d');
    // clear to cream so the rasterised SVG has a known background even if
    // the SVG itself is partially transparent
    ctx.fillStyle = '#FCEFD2';
    ctx.fillRect(0, 0, W, H);

    // Defensive SVG sanitisation — make it more likely to parse:
    //   • ensure xmlns is set
    //   • prepend XML declaration (some browsers need it)
    //   • use data: URL instead of blob: (data URLs are more robust for
    //     SVG-as-image and don't depend on URL.createObjectURL lifetimes)
    let svgText = svg.trim();
    if (!/xmlns=/.test(svgText)) {
      svgText = svgText.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    if (!/<\?xml/.test(svgText)) {
      svgText = '<?xml version="1.0" encoding="UTF-8"?>' + svgText;
    }
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);

    try {
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => {
          ctx.drawImage(img, 0, 0, W, H);
          this._svgTex.needsUpdate = true;
          resolve();
        };
        img.onerror = () => reject(new Error('SVG image failed to decode'));
        img.src = dataUrl;
      });
    } catch (e) {
      // Fallback: paint a polite "couldn't draw" card without spamming console
      ctx.fillStyle = '#FCEFD2'; ctx.fillRect(0, 0, W, H);
      ctx.font = '700 48px "Caveat", cursive';
      ctx.fillStyle = '#E66363';
      ctx.textAlign = 'center';
      ctx.fillText("(couldn't draw that one — try again?)", W / 2, H / 2);
      this._svgTex.needsUpdate = true;
      console.warn('[wonderlab] SVG render fell back:', e?.message || e);
    }
  }

  _renderTextToBoard(text) {
    const W = this._svgCanvas.width, H = this._svgCanvas.height;
    const ctx = this._svgCanvas.getContext('2d');
    ctx.fillStyle = '#FCEFD2'; ctx.fillRect(0, 0, W, H);
    ctx.font = '700 56px "Caveat", cursive';
    ctx.fillStyle = '#2D2622';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // wrap roughly into lines
    const lines = wrapText(ctx, text, W * 0.85);
    const lineH = 70;
    const startY = H / 2 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((line, i) => ctx.fillText(line, W / 2, startY + i * lineH));
    this._svgTex.needsUpdate = true;
  }

  // ---------- LOADING STATE ----------
  // Called the moment the visitor submits a question. The whiteboard
  // repaints every frame with an animated "iris is drawing…" cue
  // until either renderSvgToBoard or renderTextCardToBoard is called.
  setLoading(question) {
    this._loading = {
      question: (question || '').trim(),
      startT:   performance.now() / 1000,
      progress: null,    // set by setLoadingProgress while a model is downloading
    };
  }

  // Used by the WebLLM connector while the model is downloading on first
  // use. p = { progress: 0..1, text: 'fetching shard 3/12' }.
  setLoadingProgress(p) {
    if (!this._loading) return;
    this._loading.progress = p && typeof p.progress === 'number'
      ? { progress: p.progress, text: p.text || '' }
      : null;
  }

  clearLoading() {
    this._loading = null;
  }

  _paintLoadingFrame(t) {
    if (!this._loading) return;
    const W = this._svgCanvas.width, H = this._svgCanvas.height;
    const ctx = this._svgCanvas.getContext('2d');
    const dt = t - this._loading.startT;

    // cream paper
    ctx.fillStyle = '#FCEFD2';
    ctx.fillRect(0, 0, W, H);

    // a faint pencil-grid hint to feel like a sketchbook page
    ctx.strokeStyle = 'rgba(45,38,34,0.05)';
    ctx.lineWidth = 1;
    for (let y = 80; y < H; y += 64) {
      ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(W - 40, y); ctx.stroke();
    }

    // the question, small + handwritten in the top-left, so the visitor knows
    // exactly which question is being drawn (it survives the loading state into
    // the final SVG too, so it doesn't feel like a "page change")
    if (this._loading.question) {
      ctx.font = '700 36px "Caveat", cursive';
      ctx.fillStyle = '#5C4A3F';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const q = this._loading.question.length > 70
        ? this._loading.question.slice(0, 67) + '…'
        : this._loading.question;
      ctx.fillText('"' + q + '"', 48, 36);
    }

    // big handwritten line — switches to "downloading model…" when WebLLM is
    // pulling weights for the first time
    const dotCount = 1 + Math.floor(dt * 2) % 4;
    ctx.font = '700 78px "Caveat", cursive';
    ctx.fillStyle = '#2D2622';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this._loading.progress) {
      const pct = Math.round((this._loading.progress.progress || 0) * 100);
      ctx.fillText(`downloading the model… ${pct}%`, W / 2, H / 2 - 60);
      // a small subtitle line with the current step text from WebLLM
      if (this._loading.progress.text) {
        ctx.font = '500 28px "Nunito", sans-serif';
        ctx.fillStyle = '#5C4A3F';
        ctx.fillText(this._loading.progress.text.slice(0, 60), W / 2, H / 2 + 0);
      }
    } else {
      ctx.fillText('iris is drawing' + '.'.repeat(dotCount), W / 2, H / 2 - 60);
    }

    // animated marker squiggle below — wraps the page width, draws progressively
    const cycleDur = 1.8;
    const u = (dt % cycleDur) / cycleDur;          // 0..1
    const baseY = H / 2 + 60;
    const x0 = W * 0.18, x1 = W * 0.82;
    const span = x1 - x0;
    const N = 200;
    const drawTo = Math.max(2, Math.floor(N * u));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // shadow line (faint, completed copy)
    ctx.strokeStyle = 'rgba(45,38,34,0.10)';
    ctx.lineWidth = 8;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = x0 + span * (i / N);
      const y = baseY + Math.sin(i * 0.32 + dt * 1.4) * 14
                       + Math.sin(i * 0.11 - dt * 0.7) * 7;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // active marker line (red, growing)
    ctx.strokeStyle = '#E66363';
    ctx.lineWidth = 6;
    ctx.beginPath();
    let lastX = 0, lastY = 0;
    for (let i = 0; i <= drawTo; i++) {
      const x = x0 + span * (i / N);
      const y = baseY + Math.sin(i * 0.32 + dt * 1.4) * 14
                       + Math.sin(i * 0.11 - dt * 0.7) * 7;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      lastX = x; lastY = y;
    }
    ctx.stroke();
    // the marker tip (a little red dot riding the front of the line)
    if (drawTo > 0) {
      ctx.fillStyle = '#E66363';
      ctx.beginPath(); ctx.arc(lastX, lastY, 7, 0, Math.PI * 2); ctx.fill();
      // pen handle hint
      ctx.strokeStyle = '#2D2622';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(lastX + 18, lastY - 36);
      ctx.stroke();
    }

    // little stopwatch in the corner so the visitor can see it's actually working
    const secs = Math.floor(dt);
    ctx.font = '600 22px "Nunito", sans-serif';
    ctx.fillStyle = 'rgba(45,38,34,0.55)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${secs}s`, W - 40, 40);

    this._svgTex.needsUpdate = true;
  }

  // ---------- TEXT-CARD render path (image-off mode) ----------
  // When the active connector doesn't generate illustrations, the whiteboard
  // becomes a styled notepad page: question handwritten on top, kid reply
  // typeset below in friendly script.
  renderTextCardToBoard({ question, kid }) {
    this.clearLoading();
    const W = this._svgCanvas.width, H = this._svgCanvas.height;
    const ctx = this._svgCanvas.getContext('2d');

    // cream paper + faint grid lines
    ctx.fillStyle = '#FCEFD2'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(45,38,34,0.06)';
    ctx.lineWidth = 1;
    for (let y = 100; y < H; y += 70) {
      ctx.beginPath(); ctx.moveTo(60, y); ctx.lineTo(W - 60, y); ctx.stroke();
    }
    // red margin line
    ctx.strokeStyle = 'rgba(230,99,99,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(110, 40); ctx.lineTo(110, H - 40); ctx.stroke();

    // handwritten question
    ctx.font = '700 64px "Caveat", cursive';
    ctx.fillStyle = '#2D2622';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const qWrap = wrapText(ctx, '"' + (question || '').trim() + '"', W - 200);
    let y = 80;
    for (const line of qWrap.slice(0, 2)) {
      ctx.fillText(line, 130, y); y += 76;
    }
    y += 18;

    // ink underline
    ctx.strokeStyle = '#2D2622';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(130, y); ctx.lineTo(W * 0.55, y); ctx.stroke();
    y += 36;

    // kid reply
    if (kid) {
      ctx.font = '600 40px "Fredoka", sans-serif';
      ctx.fillStyle = '#5C4A3F';
      const replyWrap = wrapText(ctx, kid, W - 200);
      const remaining = Math.max(2, Math.floor((H - y - 80) / 56));
      for (const line of replyWrap.slice(0, remaining)) {
        ctx.fillText(line, 130, y); y += 56;
      }
    }

    // little corner mark — "no drawing today" cue, soft
    ctx.font = '500 20px "Nunito", sans-serif';
    ctx.fillStyle = 'rgba(45,38,34,0.4)';
    ctx.textAlign = 'right';
    ctx.fillText('— text-only mode', W - 40, H - 40);

    this._svgTex.needsUpdate = true;
  }

  // ---------- room construction ----------
  _buildRoom() {
    // floor — warm wooden tone with subtle plank lines via repeating canvas texture
    const floorGeo = new THREE.PlaneGeometry(ROOM_W, ROOM_D);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xb98e62, roughness: 0.92,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.world.add(floor);

    // back wall — wallpaper colour, slightly off-white
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0xf4e8c9, roughness: 0.95,
    });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_H), wallMat);
    back.position.set(0, ROOM_H / 2, -ROOM_D / 2);
    this.world.add(back);

    // side walls — angled slightly inward feel via plain geometry
    const sideGeo = new THREE.PlaneGeometry(ROOM_D, ROOM_H);
    const left = new THREE.Mesh(sideGeo, wallMat);
    left.rotation.y = Math.PI / 2;
    left.position.set(-ROOM_W / 2, ROOM_H / 2, 0);
    this.world.add(left);
    const right = new THREE.Mesh(sideGeo, wallMat);
    right.rotation.y = -Math.PI / 2;
    right.position.set( ROOM_W / 2, ROOM_H / 2, 0);
    this.world.add(right);

    // === FRONT WALL (behind the visitor) — closes the room and adds a
    //     friendly painted door so they know where they came from ===
    const front = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_H), wallMat);
    front.rotation.y = Math.PI;       // face -Z toward camera
    front.position.set(0, ROOM_H / 2, ROOM_D / 2);
    this.world.add(front);

    // door — painted on a thin plane just in front of the front wall
    const doorTex = (() => {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 512;
      const ctx = c.getContext('2d');
      // door body
      ctx.fillStyle = '#8B6240'; ctx.fillRect(0, 0, 256, 512);
      // panel inset
      ctx.strokeStyle = '#5C3F25'; ctx.lineWidth = 6;
      ctx.strokeRect(20, 20, 216, 220);
      ctx.strokeRect(20, 260, 216, 220);
      // handle
      ctx.fillStyle = '#FFD16B';
      ctx.beginPath(); ctx.arc(212, 280, 10, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#2D2622'; ctx.lineWidth = 2; ctx.stroke();
      // small handwritten "wonderlab" sign on the door
      ctx.font = '700 36px "Caveat", cursive';
      ctx.fillStyle = '#FCF4E4';
      ctx.fillRect(40, 60, 176, 60);
      ctx.strokeStyle = '#2D2622'; ctx.lineWidth = 3;
      ctx.strokeRect(40, 60, 176, 60);
      ctx.fillStyle = '#2D2622';
      ctx.textAlign = 'center';
      ctx.fillText('wonderlab ✦', 128, 100);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    })();
    const door = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 2.8),
      new THREE.MeshBasicMaterial({ map: doorTex })
    );
    door.position.set(0, 1.4, ROOM_D / 2 - 0.04);
    door.rotation.y = Math.PI;
    this.world.add(door);
    // door frame — slightly larger plane behind, deeper colour
    const doorFrame = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 3.0),
      new THREE.MeshStandardMaterial({ color: 0x5C3F25, roughness: 0.55 })
    );
    doorFrame.position.set(0, 1.5, ROOM_D / 2 - 0.06);
    doorFrame.rotation.y = Math.PI;
    this.world.add(doorFrame);

    // desk in front of the visitor — visitor's perspective hint
    const deskMat = new THREE.MeshStandardMaterial({ color: 0x8b6240, roughness: 0.55 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.18, 1.4), deskMat);
    desk.position.set(0, 0.95, 1.6);
    this.world.add(desk);
    // desk apron
    const apron = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.45, 0.06), deskMat);
    apron.position.set(0, 0.65, 1.0);
    this.world.add(apron);
    // four legs
    const legGeo = new THREE.BoxGeometry(0.12, 0.95, 0.12);
    for (const x of [-3.9, 3.9]) {
      for (const z of [1.05, 2.15]) {
        const leg = new THREE.Mesh(legGeo, deskMat);
        leg.position.set(x, 0.475, z);
        this.world.add(leg);
      }
    }

    // a hanging lamp above the whiteboard, casting a warm pool
    const lampShade = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 0.5, 18, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xf4b942, side: THREE.DoubleSide, roughness: 0.4 })
    );
    lampShade.position.set(1.2, 5.5, -ROOM_D / 2 + 0.7);
    lampShade.rotation.x = Math.PI;
    lampShade.userData.kind = 'lamp';
    this.world.add(lampShade);
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.015, 1.0, 6),
      new THREE.MeshStandardMaterial({ color: 0x2D2622 })
    );
    cord.position.set(1.2, 6.0, -ROOM_D / 2 + 0.7);
    this.world.add(cord);
    const lampLight = new THREE.PointLight(0xffe9a8, 1.2, 10, 2);
    lampLight.position.set(1.2, 5.0, -ROOM_D / 2 + 0.7);
    this.world.add(lampLight);
    this._lamp = { shade: lampShade, light: lampLight, on: true };

    // a mug of hot chocolate on the desk — kid-friendly, still steamy
    const mug = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.16, 0.34, 18),
      new THREE.MeshStandardMaterial({ color: 0xffd16b, roughness: 0.55 })
    );
    mug.position.set(2.4, 1.21, 1.5);
    mug.userData.kind = 'mug';
    this.world.add(mug);
    this._mug = mug;
    // hot chocolate (warm brown surface)
    const cocoa = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.02, 18),
      new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.4 })
    );
    cocoa.position.set(2.4, 1.38, 1.5);
    this.world.add(cocoa);
    // a tiny marshmallow floating on top
    const marshmallow = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.05, 0.07),
      new THREE.MeshStandardMaterial({ color: 0xfffcec, roughness: 0.85 })
    );
    marshmallow.position.set(2.40, 1.41, 1.49);
    marshmallow.rotation.y = 0.2;
    this.world.add(marshmallow);

    // a small stack of papers on the desk — clickable for fun
    const paperMat = new THREE.MeshStandardMaterial({ color: 0xfffcec, roughness: 0.85 });
    const papers = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 0.4), paperMat);
    papers.position.set(-1.6, 1.06, 1.55);
    papers.rotation.y = 0.18;
    papers.userData.kind = 'papers';
    this.world.add(papers);
    this._papers = papers;
  }

  // ---------- Iris — hand-illustrated 2D character on a 3D billboard plane ----------
  // Paper-Mario / Cuphead style: a beautiful SVG illustration is rasterised
  // to a canvas texture and mapped onto a Plane in the lab. The plane
  // rotates yaw-only to face the visitor. Multiple poses (idle / blink /
  // talking) are pre-rendered to ImageBitmaps so swaps are instant.
  _buildResearcher() {
    const W = 600, H = 900;       // SVG / canvas resolution
    const PLANE_W = 1.8;          // human-scale presence
    const PLANE_H = PLANE_W * (H / W);     // 2.7 — preserves aspect

    // canvas + texture (start blank, fills in as poses load)
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    this._irisCanvas = canvas;
    this._irisTexture = new THREE.CanvasTexture(canvas);
    this._irisTexture.colorSpace = THREE.SRGBColorSpace;
    this._irisTexture.minFilter = THREE.LinearFilter;
    this._irisTexture.magFilter = THREE.LinearFilter;

    const mat = new THREE.MeshBasicMaterial({
      map: this._irisTexture,
      transparent: true,
      alphaTest: 0.04,
      side: THREE.FrontSide,
      depthWrite: false,           // so transparent edges don't write depth
    });
    this._irisMat = mat;

    const plane = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_H), mat);
    // position so feet land on the floor (plane.y is the centre of the plane)
    plane.position.set(RES_X, PLANE_H / 2, RES_Z);
    plane.userData.kind = 'body';   // refined per-region in _handleClick by hit.uv
    this.world.add(plane);
    this.researcher = plane;

    // pre-render every pose to an ImageBitmap-style cache for instant swap
    this._irisPoses = {};
    this._currentPose = null;
    Object.entries(IRIS).forEach(([name, svg]) => this._loadPose(name, svg));

    // schedule first blink a few seconds in
    this._nextBlink = performance.now() / 1000 + 3 + Math.random() * 4;

    // dummy refs so any stale references in _frame don't NPE while we trim
    this._head = null;
    this._markerArm = null;
    this._lids = null;
  }

  /** Load and cache one pose; first one to arrive paints the canvas. */
  async _loadPose(name, svg) {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload  = () => res(i);
        i.onerror = (e) => rej(e);
        i.src = url;
      });
      this._irisPoses[name] = img;
      // first pose to load = paint immediately so iris appears
      if (!this._currentPose && name === 'idle') this._setPose('idle');
      else if (!this._currentPose) this._setPose(name);
    } catch (e) {
      console.warn('iris pose failed:', name, e);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Swap the texture to a different pose (idle / blink / talking / pointing). */
  _setPose(name) {
    const img = this._irisPoses[name];
    if (!img) return;
    if (this._currentPose === name) return;
    const ctx = this._irisCanvas.getContext('2d');
    ctx.clearRect(0, 0, this._irisCanvas.width, this._irisCanvas.height);
    ctx.drawImage(img, 0, 0, this._irisCanvas.width, this._irisCanvas.height);
    this._irisTexture.needsUpdate = true;
    this._currentPose = name;
  }

  /** Public helper: have iris show the talking pose while she's speaking. */
  setSpeaking(on) {
    this._talking = !!on;
    if (on)  this._setPose('talking');
    else if (!this._blinkActive) this._setPose('idle');
  }

  /**
   * Set iris's mood — drives both the pose and the body bounce amplitude.
   *   'idle'      → default
   *   'curious'   → eyes drift toward the board, brows up (used while
   *                 the model is thinking / streaming the first words)
   *   'wondering' → small head-tilt, "hmm" mouth (used when the reply
   *                 contains uncertainty markers)
   *   'excited'   → idle pose + bigger Y bounce (used when reply has !)
   *   'talking'   → handled by setSpeaking(); accepted here too so all
   *                 four moods route through one function.
   */
  setMood(mood) {
    if (this._talking && mood !== 'idle') return;     // talking takes priority
    this._mood = mood || 'idle';
    if (mood === 'curious'   && this._irisPoses?.curious)   this._setPose('curious');
    else if (mood === 'wondering' && this._irisPoses?.wondering) this._setPose('wondering');
    else if (mood === 'excited' || mood === 'idle' || !mood) {
      if (!this._blinkActive) this._setPose('idle');
    }
  }

  // ---- legacy ctor body removed; the rest of the old function is dropped ----
  _buildResearcher_LEGACY_DEAD() {
    const grp = new THREE.Group();
    const skin   = new THREE.MeshStandardMaterial({ color: 0xfbd2b0, roughness: 0.45 });
    const coat   = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 });
    const coatTrim = new THREE.MeshStandardMaterial({ color: 0xffe4a8, roughness: 0.6 });
    const dark   = new THREE.MeshStandardMaterial({ color: 0x4a5570, roughness: 0.7 });
    const hairC  = new THREE.MeshStandardMaterial({ color: 0x6b4626, roughness: 0.75 });
    const ink    = new THREE.MeshStandardMaterial({ color: 0x2D2622, roughness: 0.4 });
    const white  = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 });

    // === LEGS — short, rounded, friendly ===
    const legGeo = new THREE.CylinderGeometry(0.12, 0.14, 0.45, 12);
    const legL = new THREE.Mesh(legGeo, dark); legL.position.set(-0.13, 0.32, 0); grp.add(legL);
    const legR = new THREE.Mesh(legGeo, dark); legR.position.set( 0.13, 0.32, 0); grp.add(legR);

    // === SHOES — stubby ovals ===
    const shoeGeo = new THREE.SphereGeometry(0.18, 16, 10);
    const shoeL = new THREE.Mesh(shoeGeo, ink); shoeL.scale.set(1.1, 0.55, 1.5); shoeL.position.set(-0.13, 0.06, 0.05); grp.add(shoeL);
    const shoeR = new THREE.Mesh(shoeGeo, ink); shoeR.scale.set(1.1, 0.55, 1.5); shoeR.position.set( 0.13, 0.06, 0.05); grp.add(shoeR);

    // === BODY — chibi: short, squat lab coat ===
    // wider at bottom, narrower at top, pear-shaped for cuteness
    const bodyGeo = new THREE.CylinderGeometry(0.36, 0.46, 0.62, 18);
    const body = new THREE.Mesh(bodyGeo, coat);
    body.position.y = 0.86;
    body.userData.kind = 'body';
    grp.add(body);
    // coat hem (a slight flare at the bottom)
    const hem = new THREE.Mesh(new THREE.CylinderGeometry(0.49, 0.46, 0.08, 18), coat);
    hem.position.y = 0.59;
    grp.add(hem);
    // coat collar/lapel — a pale yellow trim
    const lapel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.40, 0.36, 0.06, 18),
      coatTrim
    );
    lapel.position.y = 1.16;
    grp.add(lapel);

    // === ARMS — short stubs, slight outward bend ===
    const armGeo = new THREE.CylinderGeometry(0.085, 0.10, 0.50, 12);
    const armL = new THREE.Mesh(armGeo, coat);
    armL.position.set(-0.40, 0.95, 0); armL.rotation.z = 0.30;
    grp.add(armL);
    const armR = new THREE.Mesh(armGeo, coat);
    armR.position.set( 0.40, 1.05, 0.05); armR.rotation.z = -0.55; armR.rotation.x = -0.30;
    grp.add(armR);
    this._markerArm = armR;

    // === HANDS — slightly bigger spheres for that mitten look ===
    const handGeo = new THREE.SphereGeometry(0.115, 14, 10);
    const handL = new THREE.Mesh(handGeo, skin); handL.position.set(-0.55, 0.71, 0); grp.add(handL);
    const handR = new THREE.Mesh(handGeo, skin); handR.position.set( 0.62, 1.30, 0.18); grp.add(handR);

    // === MARKER — held by right hand, pointed at the board ===
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.24, 0.06, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xE66363, roughness: 0.35 })
    );
    marker.position.set(0.78, 1.34, 0.18);
    marker.rotation.z = -0.4;
    marker.userData.kind = 'marker';
    grp.add(marker);

    // === HEAD — BIG, chibi proportions (~1.5x former size, ~50% body height) ===
    const headRadius = 0.46;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(headRadius, 32, 22),
      skin
    );
    head.scale.set(1.0, 1.0, 0.95);   // slightly less depth so the face plane reads
    head.position.y = 1.62;
    head.userData.kind = 'head';
    grp.add(head);
    this._head = head;

    // === HAIR — soft tousle, falls slightly to one side ===
    const hairTop = new THREE.Mesh(
      new THREE.SphereGeometry(headRadius + 0.025, 30, 16, 0, Math.PI * 2, 0, Math.PI / 2.1),
      hairC
    );
    hairTop.position.y = 1.64;
    grp.add(hairTop);
    // a side-bang
    const bang = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 10),
      hairC
    );
    bang.scale.set(1.2, 0.4, 0.8);
    bang.position.set(-0.18, 1.78, 0.34);
    bang.rotation.z = -0.4;
    grp.add(bang);

    // === BIG ROUND EYES — white sclera + dark pupil + bright catchlight ===
    const eyeWhiteGeo = new THREE.SphereGeometry(0.085, 18, 14);
    const eyePupilGeo = new THREE.SphereGeometry(0.06, 16, 12);
    const catchlightGeo = new THREE.SphereGeometry(0.018, 8, 6);
    const catchlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    const makeEye = (xOff) => {
      const eyeGroup = new THREE.Group();
      const w = new THREE.Mesh(eyeWhiteGeo, white);
      eyeGroup.add(w);
      const p = new THREE.Mesh(eyePupilGeo, ink);
      p.position.set(0, 0, 0.04);
      eyeGroup.add(p);
      const c = new THREE.Mesh(catchlightGeo, catchlightMat);
      c.position.set(0.018, 0.025, 0.085);
      eyeGroup.add(c);
      eyeGroup.position.set(xOff, 1.66, headRadius * 0.94);
      // children inherit head's position & rotation via group hierarchy
      return eyeGroup;
    };
    const eyeL = makeEye(-0.155);
    const eyeR = makeEye( 0.155);
    grp.add(eyeL, eyeR);
    this._eyes = { left: eyeL, right: eyeR };
    // upper eyelids — separate plane that drops to "blink"
    const lidMat = new THREE.MeshStandardMaterial({ color: 0xfbd2b0, roughness: 0.45 });
    const lidGeo = new THREE.SphereGeometry(0.092, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const lidL = new THREE.Mesh(lidGeo, lidMat);
    lidL.position.copy(eyeL.position);
    lidL.scale.y = 0.001;
    grp.add(lidL);
    const lidR = new THREE.Mesh(lidGeo, lidMat);
    lidR.position.copy(eyeR.position);
    lidR.scale.y = 0.001;
    grp.add(lidR);
    this._lids = { left: lidL, right: lidR };
    this._nextBlink = performance.now() / 1000 + 2 + Math.random() * 3;

    // === EYEBROWS — small curved lines above each eye ===
    const browMat = new THREE.MeshBasicMaterial({ color: 0x4a3220 });
    const browGeo = new THREE.TorusGeometry(0.07, 0.012, 6, 12, Math.PI * 0.6);
    const browL = new THREE.Mesh(browGeo, browMat);
    browL.position.set(-0.155, 1.78, headRadius * 0.92);
    browL.rotation.z = Math.PI - 0.3;
    grp.add(browL);
    const browR = new THREE.Mesh(browGeo, browMat);
    browR.position.set( 0.155, 1.78, headRadius * 0.92);
    browR.rotation.z = Math.PI + 0.3;
    grp.add(browR);

    // === SMALL ROUND NOSE TIP ===
    const nose = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xf5b88e, roughness: 0.6 })
    );
    nose.position.set(0, 1.59, headRadius * 0.97);
    grp.add(nose);

    // === MOUTH — small smile (curved torus arc) ===
    const mouthMat = new THREE.MeshBasicMaterial({ color: 0xc56565 });
    const mouthGeo = new THREE.TorusGeometry(0.05, 0.012, 6, 14, Math.PI);
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, 1.51, headRadius * 0.93);
    mouth.rotation.z = Math.PI;
    grp.add(mouth);

    // === BIG ROSY CHEEK BLUSH ===
    const blushMat = new THREE.MeshBasicMaterial({ color: 0xff9b94, transparent: true, opacity: 0.75 });
    const blushGeo = new THREE.CircleGeometry(0.085, 18);
    const blushL = new THREE.Mesh(blushGeo, blushMat);
    blushL.position.set(-0.24, 1.55, headRadius * 0.92);
    blushL.rotation.y = -0.25;
    grp.add(blushL);
    const blushR = new THREE.Mesh(blushGeo, blushMat);
    blushR.position.set( 0.24, 1.55, headRadius * 0.92);
    blushR.rotation.y = 0.25;
    grp.add(blushR);

    // === ID BADGE on the coat ===
    const badge = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.12, 0.025),
      new THREE.MeshStandardMaterial({ color: 0xFFD16B, roughness: 0.45 })
    );
    badge.position.set(-0.20, 0.95, 0.36);
    badge.userData.kind = 'badge';
    grp.add(badge);

    // === BOW on top of head — small accent ===
    const bowMat = new THREE.MeshStandardMaterial({ color: 0xff8a9d, roughness: 0.5 });
    const bow = new THREE.Group();
    const bowL = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), bowMat);
    bowL.scale.set(1.4, 0.7, 0.5);
    bowL.position.set(-0.07, 0, 0);
    bow.add(bowL);
    const bowR = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), bowMat);
    bowR.scale.set(1.4, 0.7, 0.5);
    bowR.position.set( 0.07, 0, 0);
    bow.add(bowR);
    const bowKnot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), bowMat);
    bow.add(bowKnot);
    bow.position.set(0.18, 1.98, 0.18);
    bow.rotation.y = 0.5;
    grp.add(bow);

    grp.position.set(RES_X, 0, RES_Z);
    grp.rotation.y = 0.30;

    this.world.add(grp);
    this.researcher = grp;
  }

  // ---------- extra lab decoration + interactive items ----------
  _buildExtras() {
    // === WALL CLOCK on the back wall, ticks every second ===
    {
      const grp = new THREE.Group();
      const face = new THREE.Mesh(
        new THREE.CircleGeometry(0.42, 32),
        new THREE.MeshStandardMaterial({ color: 0xfffcec, roughness: 0.7 })
      );
      face.position.z = 0.001;
      grp.add(face);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.42, 0.04, 12, 32),
        new THREE.MeshStandardMaterial({ color: 0x2D2622, roughness: 0.5 })
      );
      grp.add(ring);
      // hour markers
      for (let i = 0; i < 12; i++) {
        const tick = new THREE.Mesh(
          new THREE.BoxGeometry(0.03, 0.07, 0.005),
          new THREE.MeshStandardMaterial({ color: 0x2D2622 })
        );
        const a = (i / 12) * Math.PI * 2;
        tick.position.set(Math.sin(a) * 0.34, Math.cos(a) * 0.34, 0.005);
        tick.rotation.z = -a;
        grp.add(tick);
      }
      // minute hand (almost-still — barely moves)
      const minHand = new THREE.Mesh(
        new THREE.BoxGeometry(0.025, 0.32, 0.005),
        new THREE.MeshStandardMaterial({ color: 0x2D2622 })
      );
      minHand.geometry.translate(0, 0.16, 0);
      minHand.position.z = 0.008;
      grp.add(minHand);
      this._clockMin = minHand;
      // second hand (red, ticks)
      const secHand = new THREE.Mesh(
        new THREE.BoxGeometry(0.014, 0.36, 0.005),
        new THREE.MeshStandardMaterial({ color: 0xE66363 })
      );
      secHand.geometry.translate(0, 0.18, 0);
      secHand.position.z = 0.012;
      grp.add(secHand);
      this._clockSec = secHand;
      // centre cap
      const cap = new THREE.Mesh(
        new THREE.CircleGeometry(0.04, 16),
        new THREE.MeshStandardMaterial({ color: 0x2D2622 })
      );
      cap.position.z = 0.014;
      grp.add(cap);

      grp.position.set(-4.2, 4.2, -ROOM_D / 2 + 0.03);
      this.world.add(grp);
    }

    // === MICROSCOPE on the desk — clickable, animates ===
    {
      const grp = new THREE.Group();
      const baseMat = new THREE.MeshStandardMaterial({ color: 0x2D2622, roughness: 0.4, metalness: 0.5 });
      const armMat  = new THREE.MeshStandardMaterial({ color: 0x5C4A3F, roughness: 0.45, metalness: 0.4 });
      // base
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.06, 24), baseMat);
      base.position.y = 0.03;
      grp.add(base);
      // stage
      const stage = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.025, 0.30), baseMat);
      stage.position.y = 0.10;
      grp.add(stage);
      // arm
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.10), armMat);
      arm.position.set(0, 0.32, -0.10);
      grp.add(arm);
      // head + eyepiece
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.10, 0.18, 18), armMat);
      head.position.set(0, 0.55, 0);
      head.rotation.x = -0.3;
      grp.add(head);
      const eyepiece = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 18), armMat);
      eyepiece.position.set(0, 0.66, 0.04);
      eyepiece.rotation.x = -0.3;
      grp.add(eyepiece);
      // objective lens
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.06, 18), baseMat);
      lens.position.set(0, 0.43, 0.04);
      grp.add(lens);
      // tag every part as the same kind for click detection
      [base, stage, arm, head, eyepiece, lens].forEach(m => { m.userData.kind = 'microscope'; });

      grp.position.set(-2.8, 1.045, 1.35);
      grp.rotation.y = -0.4;
      this.world.add(grp);
      this._microscope = grp;
    }

    // === POTTED PLANT in the corner — gently sways ===
    {
      const grp = new THREE.Group();
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.26, 0.42, 16),
        new THREE.MeshStandardMaterial({ color: 0xb27d4d, roughness: 0.85 })
      );
      pot.position.y = 0.21;
      grp.add(pot);
      // soil
      const soil = new THREE.Mesh(
        new THREE.CylinderGeometry(0.30, 0.30, 0.05, 16),
        new THREE.MeshStandardMaterial({ color: 0x3a2a18, roughness: 0.95 })
      );
      soil.position.y = 0.42;
      grp.add(soil);
      // a handful of leaves — overlapping ellipses for a bushy effect
      const leafMat = new THREE.MeshStandardMaterial({ color: 0x6fb05c, roughness: 0.6, side: THREE.DoubleSide });
      const leaves = [];
      for (let i = 0; i < 14; i++) {
        const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.18), leafMat);
        const a = Math.random() * Math.PI * 2;
        const r = 0.08 + Math.random() * 0.18;
        leaf.position.set(Math.cos(a) * r, 0.55 + Math.random() * 0.7, Math.sin(a) * r);
        leaf.rotation.set(
          Math.random() * 0.4 - 0.2,
          a + Math.random() * 0.4 - 0.2,
          Math.random() * 1.2 - 0.6
        );
        leaf.userData._basePhase = Math.random() * Math.PI * 2;
        grp.add(leaf);
        leaves.push(leaf);
      }
      grp.position.set(-6.2, 0, -3.4);   // far back-left, out of iris's space
      this.world.add(grp);
      this._plant = { group: grp, leaves };
    }

    // === DUST MOTES in the air — small particle system, lit by lamp ===
    {
      const N = 80;
      const positions = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        positions[i * 3 + 0] = (Math.random() - 0.5) * (ROOM_W - 2);
        positions[i * 3 + 1] = 0.5 + Math.random() * (ROOM_H - 1);
        positions[i * 3 + 2] = (Math.random() - 0.5) * (ROOM_D - 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xfff5d4,
        size: 0.04,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        sizeAttenuation: true,
      });
      const points = new THREE.Points(geo, mat);
      this.world.add(points);
      this._dust = { points, basePos: positions.slice() };
    }

    // === STEAM rising from the hot chocolate mug ===
    {
      const N = 24;
      const positions = new Float32Array(N * 3);
      const phases    = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        positions[i * 3 + 0] = 0;
        positions[i * 3 + 1] = 0;
        positions[i * 3 + 2] = 0;
        phases[i] = (i / N) * Math.PI * 2;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.10,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        sizeAttenuation: true,
      });
      const points = new THREE.Points(geo, mat);
      points.position.copy(this._mug ? this._mug.position : new THREE.Vector3(2.4, 1.4, 1.5));
      points.position.y += 0.18;
      this.world.add(points);
      this._steam = { points, phases, geo };
    }

    // === EQUATIONS chalked on the back wall — texture decoration ===
    {
      const canvas = document.createElement('canvas');
      canvas.width = 1024; canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = "italic 56px 'Caveat', cursive";
      ctx.fillStyle = 'rgba(45,38,34,0.32)';
      ctx.fillText('E = m c²    ·    F = m a    ·    iħ ∂ψ/∂t = Ĥψ', 30, 90);
      ctx.font = "italic 38px 'Caveat', cursive";
      ctx.fillStyle = 'rgba(45,38,34,0.22)';
      ctx.fillText('— scribbles from a long week —', 30, 170);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      const eqPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(6.5, 1.6),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85 })
      );
      eqPlane.position.set(-3.5, 1.6, -ROOM_D / 2 + 0.03);
      this.world.add(eqPlane);
    }

    // === RUG on the floor — warm woven feel ===
    {
      const rug = new THREE.Mesh(
        new THREE.PlaneGeometry(5.5, 4.0),
        new THREE.MeshStandardMaterial({ color: 0xff9b94, roughness: 0.95 })
      );
      rug.rotation.x = -Math.PI / 2;
      rug.position.set(1.2, 0.005, 3.0);
      this.world.add(rug);
      // border
      const border = new THREE.Mesh(
        new THREE.PlaneGeometry(5.6, 4.1),
        new THREE.MeshStandardMaterial({ color: 0xe66363, roughness: 0.95 })
      );
      border.rotation.x = -Math.PI / 2;
      border.position.set(1.2, 0.003, 3.0);
      this.world.add(border);
    }

    // === WINDOWS — sky views on each side wall.
    //     Same outdoor world, two different views: the sun is visible
    //     from the LEFT window (looking east-ish), the RIGHT window
    //     looks the other way and has no sun in frame — instead a
    //     bright sky with a kite + birds. Both windows share the same
    //     horizon line and ground colours so the world feels coherent.
    // =================================================================
    const paintBaseSky = (c) => {
      const ctx = c.getContext('2d');
      // sky gradient — same on both sides
      const sky = ctx.createLinearGradient(0, 0, 0, c.height);
      sky.addColorStop(0.00, '#7CB7D0');
      sky.addColorStop(0.55, '#B5DCEB');
      sky.addColorStop(0.85, '#FFE9A8');
      sky.addColorStop(1.00, '#FFB7A8');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, c.width, c.height);
      return ctx;
    };
    const paintHills = (ctx, w, h) => {
      // far hills — same colour and horizon line on both windows
      ctx.fillStyle = '#8BC678';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.78);
      ctx.bezierCurveTo(w*0.18, h*0.70, w*0.36, h*0.81, w*0.54, h*0.76);
      ctx.bezierCurveTo(w*0.72, h*0.73, w*0.88, h*0.78, w, h*0.74);
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#6FB05C';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.86);
      ctx.bezierCurveTo(w*0.22, h*0.81, w*0.46, h*0.91, w*0.70, h*0.85);
      ctx.bezierCurveTo(w*0.85, h*0.81, w*0.94, h*0.87, w, h*0.83);
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fill();
    };
    const cloudPainter = (ctx) => (cx, cy, s) => {
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.arc(cx,        cy,       42 * s, 0, Math.PI * 2);
      ctx.arc(cx + 38*s, cy - 5*s, 36 * s, 0, Math.PI * 2);
      ctx.arc(cx - 38*s, cy + 5*s, 32 * s, 0, Math.PI * 2);
      ctx.arc(cx + 70*s, cy + 8*s, 26 * s, 0, Math.PI * 2);
      ctx.fill();
    };

    // SUNSET / EAST WINDOW — sun in the upper-right, distant tree
    const skyTexSun = (() => {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 768;
      const ctx = paintBaseSky(c);
      // soft sun
      const sunG = ctx.createRadialGradient(770, 220, 8, 770, 220, 150);
      sunG.addColorStop(0, '#FFFCEC'); sunG.addColorStop(0.5, '#FFD16B'); sunG.addColorStop(1, 'rgba(255,209,107,0)');
      ctx.fillStyle = sunG; ctx.beginPath(); ctx.arc(770, 220, 150, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FFFCEC';
      ctx.beginPath(); ctx.arc(770, 220, 62, 0, Math.PI * 2); ctx.fill();
      const cloud = cloudPainter(ctx);
      cloud(220, 160, 1.0);
      cloud(450, 320, 0.85);
      paintHills(ctx, 1024, 768);
      // a little tree
      ctx.fillStyle = '#6b4226'; ctx.fillRect(195, 595, 10, 32);
      ctx.fillStyle = '#6FB05C';
      ctx.beginPath(); ctx.arc(200, 590, 26, 0, Math.PI * 2); ctx.fill();
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    })();

    // OPPOSITE WINDOW — same world, different direction. No sun.
    // Has a kite drifting and three birds — feels alive, doesn't echo the sun.
    const skyTexKite = (() => {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 768;
      const ctx = paintBaseSky(c);
      const cloud = cloudPainter(ctx);
      cloud(160, 280, 1.05);
      cloud(640, 180, 0.90);
      cloud(820, 420, 0.78);
      paintHills(ctx, 1024, 768);
      // a small house in the distance for variety
      ctx.fillStyle = '#FFFCEC';
      ctx.fillRect(700, 555, 50, 40);
      ctx.fillStyle = '#E66363';
      ctx.beginPath(); ctx.moveTo(694, 555); ctx.lineTo(725, 528); ctx.lineTo(756, 555); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#2D2622'; ctx.lineWidth = 2;
      ctx.strokeRect(700, 555, 50, 40);
      ctx.beginPath(); ctx.moveTo(694, 555); ctx.lineTo(725, 528); ctx.lineTo(756, 555); ctx.stroke();
      // door
      ctx.fillStyle = '#6b4226';
      ctx.fillRect(720, 575, 12, 20);
      // a kite — diamond + tail
      ctx.save();
      ctx.translate(420, 200);
      ctx.rotate(-0.25);
      ctx.fillStyle = '#FFD16B';
      ctx.beginPath(); ctx.moveTo(0, -28); ctx.lineTo(22, 0); ctx.lineTo(0, 28); ctx.lineTo(-22, 0); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#2D2622'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -28); ctx.lineTo(0, 28); ctx.moveTo(-22, 0); ctx.lineTo(22, 0); ctx.stroke();
      // tail
      ctx.strokeStyle = '#E66363'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 28); ctx.quadraticCurveTo(15, 70, -8, 110); ctx.quadraticCurveTo(-26, 130, 0, 160); ctx.stroke();
      // tail bows
      ctx.fillStyle = '#FF9B94';
      for (const ty of [60, 95, 130]) {
        ctx.beginPath(); ctx.arc(2, ty, 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      // birds
      ctx.strokeStyle = '#2D2622'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      const bird = (bx, by, s = 1) => {
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(bx + 8*s, by - 8*s, bx + 16*s, by);
        ctx.quadraticCurveTo(bx + 24*s, by - 8*s, bx + 32*s, by);
        ctx.stroke();
      };
      bird(180, 200, 1.1);
      bird(720, 240, 0.9);
      bird(550, 320, 0.7);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    })();

    const makeWindow = (x, y, z, rotY, tex, w = 3.6, h = 2.4) => {
      // outer frame (wooden)
      const frame = new THREE.Mesh(
        new THREE.PlaneGeometry(w + 0.32, h + 0.32),
        new THREE.MeshStandardMaterial({ color: 0x8B6240, roughness: 0.6 })
      );
      frame.position.set(x, y, z);
      frame.rotation.y = rotY;
      this.world.add(frame);

      // sky inside the frame
      const view = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: tex })
      );
      // nudge slightly inward so it sits in front of the wall + frame
      const nudge = 0.02;
      view.position.set(
        x + Math.sin(rotY) * nudge,
        y,
        z + Math.cos(rotY) * nudge,
      );
      view.rotation.y = rotY;
      this.world.add(view);

      // window mullions (cross dividers, painted as thin boxes in front)
      const mullionMat = new THREE.MeshStandardMaterial({ color: 0x8B6240, roughness: 0.55 });
      const vMullion = new THREE.Mesh(new THREE.BoxGeometry(0.08, h, 0.04), mullionMat);
      vMullion.position.set(
        x + Math.sin(rotY) * (nudge + 0.01),
        y,
        z + Math.cos(rotY) * (nudge + 0.01),
      );
      vMullion.rotation.y = rotY;
      this.world.add(vMullion);
      const hMullion = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.04), mullionMat);
      hMullion.position.copy(vMullion.position);
      hMullion.rotation.y = rotY;
      this.world.add(hMullion);

      // sill — small ledge below the window
      const sill = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.5, 0.12, 0.25),
        new THREE.MeshStandardMaterial({ color: 0x5C3F25, roughness: 0.5 })
      );
      sill.position.set(
        x + Math.sin(rotY) * 0.10,
        y - h / 2 - 0.16,
        z + Math.cos(rotY) * 0.10,
      );
      sill.rotation.y = rotY;
      this.world.add(sill);
    };

    // left wall window — facing +x (room interior). Sun visible here.
    makeWindow(-ROOM_W / 2 + 0.04, 2.6, -1.0,  Math.PI / 2, skyTexSun);
    // right wall window — facing -x. No sun, kite + birds + house.
    makeWindow( ROOM_W / 2 - 0.04, 2.6, -1.0, -Math.PI / 2, skyTexKite);

    // === ONE friendly poster on the back wall (right of whiteboard) ===
    {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 512;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const svg = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="200" fill="#FFFCEC"/>
        <path d="M100 30 Q 130 70, 130 130 L 70 130 Q 70 70, 100 30 Z" fill="#FFFCEC" stroke="#2D2622" stroke-width="3"/>
        <circle cx="100" cy="80" r="14" fill="#7CB7D0" stroke="#2D2622" stroke-width="2.5"/>
        <path d="M70 120 L 50 160 L 90 145 Z" fill="#E66363" stroke="#2D2622" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M130 120 L 150 160 L 110 145 Z" fill="#E66363" stroke="#2D2622" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M85 135 Q 100 175, 115 135" fill="#F4B942" stroke="#2D2622" stroke-width="2"/>
        <text x="100" y="195" font-family="Caveat" font-size="22" fill="#2D2622" text-anchor="middle">to the moon</text>
      </svg>`;
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#FFFCEC'; ctx.fillRect(0, 0, 512, 512);
        ctx.drawImage(img, 0, 0, 512, 512);
        tex.needsUpdate = true;
        URL.revokeObjectURL(url);
      };
      img.src = url;
      const poster = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, 1.6),
        new THREE.MeshBasicMaterial({ map: tex })
      );
      poster.position.set(5.4, 4.6, -ROOM_D / 2 + 0.04);
      poster.rotation.z = -0.04;
      this.world.add(poster);
      const tack = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 12, 8),
        new THREE.MeshStandardMaterial({ color: 0xE66363, roughness: 0.4 })
      );
      tack.position.set(5.4, 5.30, -ROOM_D / 2 + 0.06);
      this.world.add(tack);
    }

    // === FAIRY LIGHTS along the back-wall ceiling — gentle twinkle ===
    {
      const grp = new THREE.Group();
      const N = 18;
      const bulbs = [];
      const wireMat = new THREE.MeshBasicMaterial({ color: 0x4a3220 });
      // wire arc as a tube along a sagging curve
      const curvePts = [];
      for (let i = 0; i <= 30; i++) {
        const t = i / 30;
        const x = -ROOM_W / 2 + 0.4 + t * (ROOM_W - 0.8);
        const dip = Math.sin(t * Math.PI) * 0.5;
        curvePts.push(new THREE.Vector3(x, ROOM_H - 0.45 - dip, -ROOM_D / 2 + 0.06));
      }
      const curve = new THREE.CatmullRomCurve3(curvePts);
      const wire = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 36, 0.012, 6, false),
        wireMat
      );
      grp.add(wire);
      // bulbs hanging from the wire at evenly spaced points
      const colors = [0xfff5d4, 0xffd16b, 0xff9b94, 0x7cb7d0, 0xb8dfa0, 0xff8aad];
      for (let i = 0; i < N; i++) {
        const t = (i + 0.5) / N;
        const pos = curve.getPointAt(t);
        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(0.06, 10, 8),
          new THREE.MeshBasicMaterial({ color: colors[i % colors.length], transparent: true, opacity: 0.95 })
        );
        bulb.position.copy(pos);
        bulb.position.y -= 0.06;
        grp.add(bulb);
        bulbs.push({ mesh: bulb, phase: i * 0.45 });
      }
      this.world.add(grp);
      this._fairyLights = bulbs;
    }

    // === DESK SUCCULENT — tiny plant beside the microscope ===
    {
      const grp = new THREE.Group();
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.10, 0.085, 0.10, 16),
        new THREE.MeshStandardMaterial({ color: 0x8B6240, roughness: 0.85 })
      );
      pot.position.y = 0.05;
      grp.add(pot);
      // succulent leaves — pointed cones radiating outward
      const leafMat = new THREE.MeshStandardMaterial({ color: 0x6FB05C, roughness: 0.6 });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.13, 6), leafMat);
        leaf.position.set(Math.cos(a) * 0.05, 0.16, Math.sin(a) * 0.05);
        leaf.rotation.z = Math.cos(a) * 0.4;
        leaf.rotation.x = Math.sin(a) * -0.4;
        grp.add(leaf);
      }
      // central tip
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.10, 6), leafMat);
      tip.position.y = 0.21;
      grp.add(tip);
      grp.position.set(-2.6, 1.04, 1.45);
      this.world.add(grp);
    }

    // === GLOBE on the desk — slowly rotates ===
    {
      const globe = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 28, 20),
        new THREE.MeshStandardMaterial({ color: 0x7CB7D0, roughness: 0.55 })
      );
      // continents (rough green shapes painted on)
      const continents = new THREE.Mesh(
        new THREE.SphereGeometry(0.181, 24, 16),
        new THREE.MeshStandardMaterial({
          color: 0xB8DFA0, roughness: 0.6,
          transparent: true, opacity: 0.85,
          alphaTest: 0.1,
        })
      );
      // procedural "land" via vertex displacement & color randomness — keep it simple
      // (just paint the second sphere with random splotches via canvas)
      const lc = document.createElement('canvas');
      lc.width = 256; lc.height = 128;
      const lctx = lc.getContext('2d');
      lctx.fillStyle = 'rgba(0,0,0,0)'; lctx.fillRect(0, 0, 256, 128);
      lctx.fillStyle = '#B8DFA0';
      for (let i = 0; i < 16; i++) {
        const x = Math.random() * 256, y = 20 + Math.random() * 88;
        const r = 8 + Math.random() * 22;
        lctx.beginPath();
        lctx.ellipse(x, y, r, r * 0.7, Math.random() * Math.PI, 0, Math.PI * 2);
        lctx.fill();
      }
      const landTex = new THREE.CanvasTexture(lc);
      landTex.colorSpace = THREE.SRGBColorSpace;
      continents.material.map = landTex;
      continents.material.color.set(0xffffff); // let texture drive colour
      continents.material.needsUpdate = true;
      const globeGroup = new THREE.Group();
      globeGroup.add(globe, continents);
      // little stand
      const stand = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.10, 0.07, 16),
        new THREE.MeshStandardMaterial({ color: 0x2D2622, roughness: 0.5 })
      );
      stand.position.y = -0.2;
      globeGroup.add(stand);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.20, 0.012, 6, 24),
        new THREE.MeshStandardMaterial({ color: 0xFFD16B, roughness: 0.4 })
      );
      ring.rotation.x = Math.PI / 2;
      globeGroup.add(ring);
      globeGroup.position.set(-3.3, 1.27, 1.45);
      this.world.add(globeGroup);
      this._globe = globeGroup;
    }

    // === AXOLOTL in a glass jar on the desk — clickable pet ===
    // Cute pink axolotl SVG billboard inside a transparent glass cylinder.
    // Idle: floats up + down + tiny rotation. Click: little wiggle.
    {
      const grp = new THREE.Group();
      // jar lid (dark cap)
      const lid = new THREE.Mesh(
        new THREE.CylinderGeometry(0.115, 0.115, 0.025, 18),
        new THREE.MeshStandardMaterial({ color: 0x4a5570, roughness: 0.55 })
      );
      lid.position.y = 0.30;
      grp.add(lid);
      // glass cylinder (thin shell)
      const glass = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.11, 0.30, 22, 1, true),
        new THREE.MeshStandardMaterial({
          color: 0xffffff, transparent: true, opacity: 0.18,
          roughness: 0.05, side: THREE.DoubleSide,
        })
      );
      glass.position.y = 0.15;
      grp.add(glass);
      // water inside (slightly tinted, fills ~80% of jar)
      const water = new THREE.Mesh(
        new THREE.CylinderGeometry(0.103, 0.103, 0.24, 22),
        new THREE.MeshStandardMaterial({
          color: 0xB5DCEB, transparent: true, opacity: 0.5,
          roughness: 0.3,
        })
      );
      water.position.y = 0.13;
      grp.add(water);
      // axolotl billboard — SVG rasterized to a canvas texture
      const axCanvas = document.createElement('canvas');
      axCanvas.width  = 160;
      axCanvas.height = 128;
      const axTex = new THREE.CanvasTexture(axCanvas);
      axTex.colorSpace = THREE.SRGBColorSpace;
      axTex.minFilter  = THREE.LinearFilter;
      axTex.magFilter  = THREE.LinearFilter;
      const axMat  = new THREE.MeshBasicMaterial({
        map: axTex, transparent: true, alphaTest: 0.04,
        side: THREE.FrontSide, depthWrite: false,
      });
      const axMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.128), axMat);
      axMesh.position.set(0, 0.13, 0.001);
      grp.add(axMesh);

      const axSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 128">
        <!-- gills (3 frilly stems on each side, drawn behind body) -->
        <g stroke="#E58B82" stroke-width="3.5" fill="#FF9B94" stroke-linejoin="round">
          <path d="M 110 50 Q 130 38 134 26 Q 116 32 102 44"/>
          <path d="M 116 60 Q 142 56 144 42 Q 124 50 110 56"/>
          <path d="M 116 70 Q 144 76 142 60 Q 124 64 110 64"/>
          <path d="M 50 50 Q 30 38 26 26 Q 44 32 58 44"/>
          <path d="M 44 60 Q 18 56 16 42 Q 36 50 50 56"/>
          <path d="M 44 70 Q 16 76 18 60 Q 36 64 50 64"/>
        </g>
        <!-- tail: little point on top -->
        <path d="M 80 16 Q 70 8 80 6 Q 90 8 80 16 Z" fill="#FFB7A8" stroke="#2D2622" stroke-width="2.5" stroke-linejoin="round"/>
        <!-- body: chubby oval -->
        <ellipse cx="80" cy="68" rx="38" ry="26" fill="#FFB7A8" stroke="#2D2622" stroke-width="3" stroke-linejoin="round"/>
        <!-- belly highlight -->
        <ellipse cx="80" cy="78" rx="22" ry="10" fill="#FFD7CE" opacity="0.7"/>
        <!-- legs (stubby) -->
        <ellipse cx="58" cy="98" rx="7" ry="4" fill="#FFB7A8" stroke="#2D2622" stroke-width="2.5"/>
        <ellipse cx="102" cy="98" rx="7" ry="4" fill="#FFB7A8" stroke="#2D2622" stroke-width="2.5"/>
        <!-- eyes (two beady) -->
        <circle cx="70" cy="62" r="3.2" fill="#2D2622"/>
        <circle cx="90" cy="62" r="3.2" fill="#2D2622"/>
        <circle cx="71" cy="61" r="1" fill="#FFFFFF"/>
        <circle cx="91" cy="61" r="1" fill="#FFFFFF"/>
        <!-- cheeks -->
        <ellipse cx="58" cy="72" rx="5" ry="2.5" fill="#FF8AAD" opacity="0.6"/>
        <ellipse cx="102" cy="72" rx="5" ry="2.5" fill="#FF8AAD" opacity="0.6"/>
        <!-- smile -->
        <path d="M 72 76 Q 80 82 88 76" fill="none" stroke="#2D2622" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
      const _img = new Image();
      const _url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(axSvg);
      _img.onload = () => {
        const c = axCanvas.getContext('2d');
        c.clearRect(0, 0, axCanvas.width, axCanvas.height);
        c.drawImage(_img, 0, 0, axCanvas.width, axCanvas.height);
        axTex.needsUpdate = true;
      };
      _img.src = _url;

      // tag for click + tooltip
      [lid, glass, water, axMesh].forEach(m => { m.userData.kind = 'axolotl'; });
      // sit on the desk surface (y=1.04). a little forward of centre.
      grp.position.set(0.7, 1.04, 1.7);
      this.world.add(grp);
      this._axolotl = { group: grp, fish: axMesh, ping: 0, baseY: 0.13 };
    }

    // === BOOKSHELF against the LEFT wall — colorful book spines ===
    {
      const grp = new THREE.Group();
      const wood = new THREE.MeshStandardMaterial({ color: 0x6b4626, roughness: 0.7 });
      const SH_W = 1.8, SH_H = 3.2, SH_D = 0.42;
      const back = new THREE.Mesh(new THREE.BoxGeometry(SH_W, SH_H, 0.05), wood);
      back.position.z = -SH_D / 2 + 0.025; grp.add(back);
      const sideGeo = new THREE.BoxGeometry(0.06, SH_H, SH_D);
      const sL = new THREE.Mesh(sideGeo, wood); sL.position.x = -SH_W / 2 + 0.03; grp.add(sL);
      const sR = new THREE.Mesh(sideGeo, wood); sR.position.x =  SH_W / 2 - 0.03; grp.add(sR);
      const shelfGeo = new THREE.BoxGeometry(SH_W, 0.05, SH_D);
      const shelfYs = [0.05, 0.85, 1.65, 2.45, SH_H - 0.025];
      for (const y of shelfYs) {
        const sh = new THREE.Mesh(shelfGeo, wood); sh.position.y = y; grp.add(sh);
      }
      const bookColors = [0xE66363, 0xF4B942, 0x6FB05C, 0x7CB7D0, 0xFFB7A8, 0xFFD16B, 0x4A5570, 0x8b6240];
      for (let row = 0; row < 4; row++) {
        let x = -SH_W / 2 + 0.10;
        while (x < SH_W / 2 - 0.18) {
          const w = 0.07 + Math.random() * 0.06;
          const h = 0.55 + Math.random() * 0.20;
          const color = bookColors[(Math.random() * bookColors.length) | 0];
          const book = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, 0.28),
            new THREE.MeshStandardMaterial({ color, roughness: 0.7 })
          );
          book.position.set(x + w / 2, shelfYs[row] + 0.05 + h / 2, 0);
          book.rotation.z = (Math.random() - 0.5) * 0.05;
          book.userData.kind = 'bookshelf';
          grp.add(book);
          x += w + 0.005;
        }
        // a horizontal stack on top of the row, sometimes
        if (Math.random() < 0.6) {
          const stackW = 0.30 + Math.random() * 0.20;
          const stack = new THREE.Mesh(
            new THREE.BoxGeometry(stackW, 0.07, 0.26),
            new THREE.MeshStandardMaterial({ color: bookColors[(Math.random() * bookColors.length) | 0], roughness: 0.7 })
          );
          stack.position.set(SH_W / 2 - stackW / 2 - 0.10, shelfYs[row] + 0.09, 0);
          stack.userData.kind = 'bookshelf';
          grp.add(stack);
        }
      }
      grp.position.set(-ROOM_W / 2 + SH_D / 2 + 0.05, 0, -3.5);
      grp.rotation.y = -Math.PI / 2;
      this.world.add(grp);
      this._bookshelf = grp;
    }

    // === BOHR ATOM MODEL on a pedestal — clickable, electrons orbit faster on tap ===
    {
      const grp = new THREE.Group();
      const ped = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.28, 0.9, 18),
        new THREE.MeshStandardMaterial({ color: 0xe8e0cb, roughness: 0.7 })
      );
      ped.position.y = 0.45; grp.add(ped);
      const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(0.30, 0.30, 0.05, 18),
        new THREE.MeshStandardMaterial({ color: 0x2D2622, roughness: 0.5 })
      );
      plate.position.y = 0.92; grp.add(plate);

      const atom = new THREE.Group();
      atom.position.y = 1.55;
      const nucleus = new THREE.Mesh(
        new THREE.SphereGeometry(0.10, 18, 14),
        new THREE.MeshStandardMaterial({
          color: 0xffd16b, emissive: 0xff8a3d, emissiveIntensity: 0.7, roughness: 0.4,
        })
      );
      atom.add(nucleus);
      const orbitMat = new THREE.MeshBasicMaterial({ color: 0x7cb7d0, transparent: true, opacity: 0.55 });
      const tilts = [
        [0, 0, 0],
        [Math.PI / 3, 0.3, 0],
        [-Math.PI / 4, 0, Math.PI / 2.5],
      ];
      const radii = [0.22, 0.32, 0.42];
      const electrons = [];
      for (let i = 0; i < 3; i++) {
        const orbit = new THREE.Mesh(new THREE.TorusGeometry(radii[i], 0.005, 8, 64), orbitMat);
        orbit.rotation.set(tilts[i][0], tilts[i][1], tilts[i][2]);
        atom.add(orbit);
        const e = new THREE.Mesh(
          new THREE.SphereGeometry(0.045, 14, 12),
          new THREE.MeshStandardMaterial({
            color: 0xff9b94, emissive: 0xe66363, emissiveIntensity: 0.8, roughness: 0.35,
          })
        );
        orbit.add(e);
        electrons.push({ mesh: e, r: radii[i], speed: 1.2 + i * 0.6, phase: i * 1.7 });
      }
      grp.add(atom);
      [nucleus, plate, ped].forEach(m => { m.userData.kind = 'atom'; });
      grp.position.set(-2.2, 0, -4.2);
      this.world.add(grp);
      this._atom = { group: atom, electrons, boost: 0, nucleus };
    }

    // === DNA DOUBLE HELIX SCULPTURE on a pedestal — slowly rotates ===
    {
      const grp = new THREE.Group();
      const ped = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.28, 0.9, 18),
        new THREE.MeshStandardMaterial({ color: 0xe8e0cb, roughness: 0.7 })
      );
      ped.position.y = 0.45; grp.add(ped);
      const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(0.30, 0.30, 0.05, 18),
        new THREE.MeshStandardMaterial({ color: 0x2D2622, roughness: 0.5 })
      );
      plate.position.y = 0.92; grp.add(plate);

      const helix = new THREE.Group();
      helix.position.y = 1.55;
      const N = 24, H = 1.4, R = 0.20;
      const sA = new THREE.MeshStandardMaterial({
        color: 0xff9b94, emissive: 0xe66363, emissiveIntensity: 0.25, roughness: 0.4,
      });
      const sB = new THREE.MeshStandardMaterial({
        color: 0x7cb7d0, emissive: 0x4a8aa0, emissiveIntensity: 0.25, roughness: 0.4,
      });
      const rungMat = new THREE.MeshStandardMaterial({ color: 0xffd16b, roughness: 0.5 });
      for (let i = 0; i < N; i++) {
        const tt = i / (N - 1);
        const y = (tt - 0.5) * H;
        const a = tt * Math.PI * 4;
        const x1 = Math.cos(a) * R, z1 = Math.sin(a) * R;
        const x2 = Math.cos(a + Math.PI) * R, z2 = Math.sin(a + Math.PI) * R;
        const ba = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 10), sA);
        ba.position.set(x1, y, z1); ba.userData.kind = 'dna'; helix.add(ba);
        const bb = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 10), sB);
        bb.position.set(x2, y, z2); bb.userData.kind = 'dna'; helix.add(bb);
        if (i % 2 === 0) {
          const dx = x2 - x1, dz = z2 - z1;
          const len = Math.hypot(dx, dz);
          const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 6), rungMat);
          rung.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
          rung.rotation.z = Math.PI / 2;
          rung.rotation.y = -Math.atan2(dz, dx);
          rung.userData.kind = 'dna';
          helix.add(rung);
        }
      }
      grp.add(helix);
      [plate, ped].forEach(m => { m.userData.kind = 'dna'; });
      grp.position.set(5.0, 0, -3.8);
      this.world.add(grp);
      this._dna = { group: helix, root: grp, ping: 0 };
    }

    // === BEAKER RACK — small wooden cart with 3 bubbling beakers ===
    {
      const grp = new THREE.Group();
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b6240, roughness: 0.6 });
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.5), woodMat);
      top.position.y = 0.78; grp.add(top);
      const bot = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.5), woodMat);
      bot.position.y = 0.20; grp.add(bot);
      for (const x of [-0.50, 0.50]) for (const z of [-0.20, 0.20]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.78, 0.05), woodMat);
        leg.position.set(x, 0.39, z); grp.add(leg);
      }
      // little book on the bottom shelf for charm
      const note = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.04, 0.20),
        new THREE.MeshStandardMaterial({ color: 0xfff5d4, roughness: 0.8 })
      );
      note.position.set(-0.30, 0.25, 0); grp.add(note);

      const fluidColors  = [0x6FB05C, 0xE66363, 0x7CB7D0];
      const fluidEmiss   = [0x2a5520, 0x803535, 0x355560];
      this._beakerBubbles = [];
      for (let i = 0; i < 3; i++) {
        const bx = -0.36 + i * 0.36;
        const beaker = new THREE.Mesh(
          new THREE.CylinderGeometry(0.10, 0.09, 0.28, 20, 1, true),
          new THREE.MeshStandardMaterial({
            color: 0xffffff, transparent: true, opacity: 0.20,
            roughness: 0.05, side: THREE.DoubleSide,
          })
        );
        beaker.position.set(bx, 0.95, 0); beaker.userData.kind = 'beakers'; grp.add(beaker);
        const fluid = new THREE.Mesh(
          new THREE.CylinderGeometry(0.092, 0.085, 0.18, 20),
          new THREE.MeshStandardMaterial({
            color: fluidColors[i], emissive: fluidEmiss[i], emissiveIntensity: 0.3,
            roughness: 0.3,
          })
        );
        fluid.position.set(bx, 0.90, 0); fluid.userData.kind = 'beakers'; grp.add(fluid);

        const N = 14;
        const positions = new Float32Array(N * 3);
        const phases = new Float32Array(N);
        for (let k = 0; k < N; k++) {
          positions[k * 3 + 0] = bx;
          positions[k * 3 + 1] = 0.85;
          positions[k * 3 + 2] = 0;
          phases[k] = Math.random() * Math.PI * 2;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
          color: 0xffffff, size: 0.04, transparent: true, opacity: 0.85, depthWrite: false,
        });
        const pts = new THREE.Points(geo, mat);
        grp.add(pts);
        this._beakerBubbles.push({ geo, phases, baseX: bx, count: N, surge: 0 });
      }
      grp.position.set(-1.4, 0, -1.8);
      grp.rotation.y = 0.25;
      this.world.add(grp);
      this._beakerCart = grp;
    }
  }

  _buildBoard() {
    // the wooden frame
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD_W + 0.5, BOARD_H + 0.5, 0.18),
      new THREE.MeshStandardMaterial({ color: 0xb98e62, roughness: 0.55 })
    );
    frame.position.set(1.4, 2.5, -ROOM_D / 2 + 0.10);
    this.world.add(frame);

    // the inner cream backing (shows through behind the texture if alpha)
    const backing = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_W + 0.05, BOARD_H + 0.05),
      new THREE.MeshStandardMaterial({ color: 0xFBFBF6 })
    );
    backing.position.set(1.4, 2.5, -ROOM_D / 2 + 0.20);
    this.world.add(backing);

    // the actual whiteboard plane — its texture is the inner SceneSpec
    // render target. Tagged so click+drag scrubs the auto-animation slider.
    const boardGeo = new THREE.PlaneGeometry(BOARD_W, BOARD_H);
    this.boardMat  = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const board = new THREE.Mesh(boardGeo, this.boardMat);
    board.position.set(1.4, 2.5, -ROOM_D / 2 + 0.21);
    board.userData.kind = 'whiteboard';
    this.world.add(board);
    this.board = board;

    // scribbled "live" mini-decoration could go here later
  }

  // ---------- keyboard movement (WASD / arrows + space to jump) ----------
  _setupKeyboard() {
    this._jumpVel = 0;
    this._jumpY   = 0;     // current vertical offset above eye-height baseline
    window.addEventListener('keydown', (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const k = e.key.toLowerCase();
      this._keys[k] = true;
      // spacebar → jump (only when feet are on the ground)
      if ((k === ' ' || k === 'spacebar') && this._jumpY <= 0.001) {
        this._jumpVel = 4.2;     // initial upward velocity (≈ 0.9m peak)
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      this._keys[e.key.toLowerCase()] = false;
    });
  }

  _walk(dt) {
    const k = this._keys;
    const fwd = k['w'] || k['arrowup'];
    const back = k['s'] || k['arrowdown'];
    const left = k['a'] || k['arrowleft'];
    const right = k['d'] || k['arrowright'];
    const moving = fwd || back || left || right;
    // head-bob: while walking, the camera bobs up/down ever so slightly
    const t = performance.now() / 1000;
    if (moving) {
      this._bobT = (this._bobT || 0) + dt * 7.5;
      this._bobAmount = Math.min(1, (this._bobAmount || 0) + dt * 4);
    } else {
      this._bobAmount = Math.max(0, (this._bobAmount || 0) - dt * 4);
    }
    const bobY = Math.sin(this._bobT || 0) * 0.025 * (this._bobAmount || 0);

    // === gravity + jump ===
    const G = -12; // m/s² (snappier than real gravity for arcade feel)
    this._jumpY  = (this._jumpY  ?? 0) + (this._jumpVel ?? 0) * dt;
    this._jumpVel = (this._jumpVel ?? 0) + G * dt;
    if (this._jumpY < 0) { this._jumpY = 0; this._jumpVel = 0; }

    const eyeY    = 1.72 + bobY + this._jumpY;
    const targetY = 1.85 + bobY * 0.5 + this._jumpY * 0.6;
    this.cam.position.y    = eyeY;
    this.controls.target.y = targetY;

    if (!moving) return;

    // forward direction in XZ plane (camera-look projected on floor)
    const f = new THREE.Vector3();
    this.cam.getWorldDirection(f);
    f.y = 0;
    if (f.lengthSq() < 1e-4) return;
    f.normalize();
    // right vector
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();

    let dx = 0, dz = 0;
    if (fwd)   { dx += f.x; dz += f.z; }
    if (back)  { dx -= f.x; dz -= f.z; }
    if (right) { dx += r.x; dz += r.z; }
    if (left)  { dx -= r.x; dz -= r.z; }

    const SPEED = 3.5; // units / sec
    const len = Math.hypot(dx, dz) || 1;
    const step = (SPEED * dt) / len;
    dx *= step; dz *= step;

    // tentative new positions
    let nx = this.cam.position.x + dx;
    let nz = this.cam.position.z + dz;
    // room-bound clamp (with margin so we don't clip walls)
    const MARGIN = 0.8;
    nx = Math.max(-ROOM_W / 2 + MARGIN, Math.min(ROOM_W / 2 - MARGIN, nx));
    nz = Math.max(-ROOM_D / 2 + MARGIN, Math.min(ROOM_D / 2 - MARGIN + 1.0, nz));
    // simple desk-wall block: don't walk through the desk
    if (nz < 2.6 && nz > 0.6 && Math.abs(nx) < 4.4) {
      // stay on the visitor side of the desk
      nz = Math.max(nz, 2.6);
    }

    const realDx = nx - this.cam.position.x;
    const realDz = nz - this.cam.position.z;
    this.cam.position.x = nx;
    this.cam.position.z = nz;
    this.controls.target.x += realDx;
    this.controls.target.z += realDz;
  }

  // ---------- pointer / click on world objects ----------
  _setupClick() {
    const px = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const t = e.touches?.[0] || e;
      return { x: t.clientX - rect.left, y: t.clientY - rect.top, t: performance.now() };
    };
    const updateMouse = (p) => {
      const rect = this.canvas.getBoundingClientRect();
      this._mouse.set(
        (p.x / rect.width) * 2 - 1,
        (p.y / rect.height) * -2 + 1
      );
      this._raycaster.setFromCamera(this._mouse, this.cam);
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      const p = px(e);
      updateMouse(p);
      const hits = this._raycaster.intersectObjects(this._clickables(), true);
      this._mouseDown = { ...p, hit: hits[0] || null };
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const p = px(e);
      // hover cursor + tooltip (drag-to-scrub removed — board is just a click target now)
      updateMouse(p);
      const hits = this._raycaster.intersectObjects(this._clickables(), true);
      let cursor = 'grab';
      let kind   = null;
      if (hits.length) {
        kind = hits[0].object.userData?.kind || null;
        cursor = 'pointer';
      }
      this.canvas.style.cursor = cursor;
      if (this._lastHoverKind !== kind) {
        this._lastHoverKind = kind;
        if (typeof this.onHoverChange === 'function') this.onHoverChange(kind, p);
      }
    });

    this.canvas.addEventListener('pointerup', (e) => {
      if (!this._mouseDown) return;
      const a = this._mouseDown;
      const b = px(e);
      this._mouseDown = null;
      const moved = Math.hypot(b.x - a.x, b.y - a.y);
      const elapsed = b.t - a.t;
      if (moved > 6 || elapsed > 700) return;
      if (a.hit) {
        let kind = a.hit.object.userData?.kind || 'body';
        // refine: clicks on the iris plane → use UV to pick head/body/marker/badge
        if (a.hit.object === this.researcher) {
          kind = this._irisRegionFromUV(a.hit.uv);
        }
        this._triggerAction(kind);
      }
    });
  }

  /** All clickable objects in the world. */
  _clickables() {
    const objs = [];
    // researcher is now a single Plane mesh (the SVG billboard) — no children
    if (this.researcher) objs.push(this.researcher);
    if (this._mug)    objs.push(this._mug);
    if (this._lamp)   objs.push(this._lamp.shade);
    if (this._papers) objs.push(this._papers);
    if (this.board)   objs.push(this.board);
    if (this._microscope) objs.push(...this._microscope.children);
    if (this._atom)       objs.push(this._atom.group.parent);  // root grp
    if (this._dna)        objs.push(this._dna.root);
    if (this._beakerCart) objs.push(this._beakerCart);
    if (this._bookshelf)  objs.push(this._bookshelf);
    if (this._axolotl)    objs.push(this._axolotl.group);
    return objs;
  }

  /** Map a UV hit on the iris plane to a body region. UV (0,0) is bottom-left. */
  _irisRegionFromUV(uv) {
    if (!uv) return 'body';
    const u = uv.x, v = uv.y;
    // SVG layout: head ~y=80..360 of 900 → V ~ 0.60..0.91
    //             marker arm top-right ~ x>0.62, y=350..510 → V ~ 0.43..0.61
    //             badge / lower coat ~ x<0.45, V ~ 0.45..0.55
    if (v > 0.60)                      return 'head';
    if (v > 0.42 && u > 0.60)          return 'marker';
    if (v > 0.42 && v < 0.56 && u < 0.46) return 'badge';
    return 'body';
  }

  /** (removed) drag-to-scrub on the whiteboard — replaced by pure auto-animation */

  _triggerAction(kind) {
    // ping animation for any iris-region click
    if (kind === 'head' || kind === 'body' || kind === 'marker' || kind === 'badge') {
      if (this.researcher) this.researcher.userData._pingT = performance.now() / 1000;
      // also flash the pointing pose for a beat on marker clicks — feels alive
      if (kind === 'marker' && this._irisPoses?.pointing) {
        this._setPose('pointing');
        clearTimeout(this._poseRevertT);
        this._poseRevertT = setTimeout(() => {
          if (!this._talking && !this._blinkActive) this._setPose('idle');
        }, 1200);
      }
    }
    if (this._mug && kind === 'mug') this._mug.userData._pingT = performance.now() / 1000;
    if (this._papers && kind === 'papers') this._papers.userData._pingT = performance.now() / 1000;
    // lamp click flips its on/off state
    if (kind === 'lamp' && this._lamp) {
      this._lamp.on = !this._lamp.on;
      this._lamp.light.intensity = this._lamp.on ? 1.2 : 0.18;
      this._lamp.shade.material.color.set(this._lamp.on ? 0xf4b942 : 0x8b6240);
      this._lamp.shade.material.needsUpdate = true;
    }
    if (kind === 'atom' && this._atom) this._atom.boost = 2.5;
    if (kind === 'dna' && this._dna)   this._dna.ping = performance.now() / 1000;
    if (kind === 'axolotl' && this._axolotl) this._axolotl.ping = performance.now() / 1000;
    if (kind === 'beakers' && this._beakerBubbles) {
      for (const b of this._beakerBubbles) b.surge = 1.0;
    }
    if (kind === 'bookshelf' && this._bookshelf) {
      this._bookshelf.userData._pingT = performance.now() / 1000;
    }
    if (typeof this.onObjectClick === 'function') this.onObjectClick(kind);
  }

  // ---------- canvas sizing ----------
  _fitCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(2, Math.floor(rect.width));
    const h = Math.max(2, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  // ---------- animation loop ----------
  _frame(now) {
    const t  = now / 1000;
    const dt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;

    // === walking ===
    this._walk(dt);

    // === researcher idle + body-turn-to-camera ===
    if (this.researcher) {
      // body smoothly rotates to face the visitor's camera position
      const dx = this.cam.position.x - this.researcher.position.x;
      const dz = this.cam.position.z - this.researcher.position.z;
      const targetAngle = Math.atan2(dx, dz);
      // shortest-path delta for smooth turning (handles wraparound)
      let diff = targetAngle - this.researcher.rotation.y;
      diff = ((diff + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const TURN_SPEED = 1.6;            // rad/sec
      const step = Math.sign(diff) * Math.min(Math.abs(diff), TURN_SPEED * dt);
      this.researcher.rotation.y += step;

      // body idle bob + click ping. mood='excited' makes the bob bigger,
      // 'curious' / 'wondering' make it slightly stiller (she's thinking).
      const moodAmp = this._mood === 'excited'    ? 0.024
                    : this._mood === 'curious'    ? 0.005
                    : this._mood === 'wondering'  ? 0.003
                    : 0.008;
      const moodFreq = this._mood === 'excited' ? 1.0 : 0.5;
      const baseY = Math.sin(t * moodFreq) * moodAmp;
      const ping = this.researcher.userData?._pingT;
      let pingY = 0;
      if (ping != null) {
        const dt2 = t - ping;
        if (dt2 < 0.6) pingY = Math.sin(dt2 * 18) * 0.08 * (1 - dt2 / 0.6);
      }
      this.researcher.position.y = baseY + pingY;
    }

    // === blink (pose-swap) — every 3-7s the texture swaps to 'blink'
    //     for ~140ms then back. Skipped while iris is talking — the
    //     talking pose has open eyes and we don't want to override it.
    if (this._irisPoses?.idle && this._nextBlink != null && !this._talking) {
      const dt2 = t - this._nextBlink;
      if (dt2 >= 0 && dt2 < 0.14) {
        if (!this._blinkActive) {
          this._blinkActive = true;
          this._setPose('blink');
        }
      } else if (dt2 >= 0.14) {
        if (this._blinkActive) {
          this._blinkActive = false;
          this._setPose('idle');
        }
        this._nextBlink = t + 3 + Math.random() * 4;
      }
    }

    // ping animations for other clickable objects
    const pingScale = (mesh) => {
      const p = mesh?.userData?._pingT;
      if (p == null) return;
      const dt2 = t - p;
      if (dt2 < 0.5) {
        const s = 1 + Math.sin(dt2 * 22) * 0.08 * (1 - dt2 / 0.5);
        mesh.scale.setScalar(s);
      } else {
        mesh.scale.setScalar(1);
        delete mesh.userData._pingT;
      }
    };
    pingScale(this._mug);
    pingScale(this._papers);
    if (this._microscope) {
      // microscope: ping on click via group scale
      const p = this._microscope.userData?._pingT;
      if (p != null) {
        const dt2 = t - p;
        if (dt2 < 0.6) this._microscope.rotation.y = -0.4 + Math.sin(dt2 * 18) * 0.18 * (1 - dt2 / 0.6);
        else { this._microscope.rotation.y = -0.4; delete this._microscope.userData._pingT; }
      }
    }

    // === wall clock — second hand ticks once per second ===
    if (this._clockSec) {
      const sec = Math.floor(t) % 60;
      this._clockSec.rotation.z = -sec * (Math.PI * 2 / 60);
    }
    if (this._clockMin) {
      const min = (t / 60) % 60;
      this._clockMin.rotation.z = -min * (Math.PI * 2 / 60);
    }

    // === plant — leaves sway gently ===
    if (this._plant) {
      for (const leaf of this._plant.leaves) {
        const ph = leaf.userData._basePhase || 0;
        leaf.rotation.x = Math.sin(t * 0.6 + ph) * 0.08;
        leaf.rotation.z = leaf.rotation.z + Math.sin(t * 0.4 + ph * 0.6) * 0.0007;
      }
    }

    // === dust motes — slow random drift, looping ===
    if (this._dust) {
      const arr = this._dust.points.geometry.attributes.position.array;
      const base = this._dust.basePos;
      for (let i = 0; i < arr.length / 3; i++) {
        const ph = i * 0.7;
        arr[i*3+0] = base[i*3+0] + Math.sin(t * 0.18 + ph) * 0.25;
        arr[i*3+1] = base[i*3+1] + Math.sin(t * 0.13 + ph * 1.7) * 0.20;
        arr[i*3+2] = base[i*3+2] + Math.cos(t * 0.15 + ph * 1.3) * 0.25;
      }
      this._dust.points.geometry.attributes.position.needsUpdate = true;
    }

    // === globe — slowly rotates ===
    if (this._globe) this._globe.rotation.y = t * 0.4;

    // === fairy lights — gentle twinkle (varying scale + opacity) ===
    if (this._fairyLights) {
      for (const { mesh, phase } of this._fairyLights) {
        const tw = 0.7 + Math.sin(t * 1.6 + phase) * 0.3;
        mesh.material.opacity = tw;
        mesh.scale.setScalar(0.85 + tw * 0.3);
      }
    }

    // === steam — particles rise and fade ===
    if (this._steam) {
      const arr = this._steam.geo.attributes.position.array;
      const phases = this._steam.phases;
      const N = phases.length;
      for (let i = 0; i < N; i++) {
        const cycle = ((t * 0.6 + i * 0.13) % 1.4) / 1.4;   // 0..1 every ~1.4s
        arr[i*3+0] = Math.sin(t * 1.3 + phases[i]) * (0.04 + cycle * 0.10);
        arr[i*3+1] = cycle * 0.55;
        arr[i*3+2] = Math.cos(t * 1.1 + phases[i] * 1.7) * (0.04 + cycle * 0.10);
      }
      this._steam.geo.attributes.position.needsUpdate = true;
      // pulse opacity so steam fades in/out softly
      this._steam.points.material.opacity = 0.35 + Math.sin(t * 0.7) * 0.15;
    }

    // === atom — electrons orbit, click temporarily speeds them up ===
    if (this._atom) {
      const boostMul = this._atom.boost > 0 ? 3.0 : 1.0;
      for (const e of this._atom.electrons) {
        const ang = t * e.speed * boostMul + e.phase;
        e.mesh.position.set(Math.cos(ang) * e.r, 0, Math.sin(ang) * e.r);
      }
      if (this._atom.boost > 0) this._atom.boost = Math.max(0, this._atom.boost - dt);
      this._atom.group.rotation.y = t * 0.18;
      // nucleus pulse
      const ns = 1 + Math.sin(t * 2.4) * 0.06 + (this._atom.boost > 0 ? 0.15 : 0);
      this._atom.nucleus.scale.setScalar(ns);
    }

    // === dna — slow rotation; click adds a brief vertical bounce ===
    if (this._dna) {
      this._dna.group.rotation.y = t * 0.55;
      const dt2 = t - this._dna.ping;
      this._dna.group.position.y = 1.55 + (dt2 < 0.6 ? Math.sin(dt2 * 14) * 0.05 * (1 - dt2 / 0.6) : 0);
    }

    // === beaker bubbles — rise, reset, surge on click ===
    if (this._beakerBubbles) {
      for (const b of this._beakerBubbles) {
        const speed = 0.7 + b.surge * 1.4;
        const arr = b.geo.attributes.position.array;
        for (let i = 0; i < b.count; i++) {
          const cycle = ((t * speed + i * 0.27 + b.phases[i] * 0.1) % 1.0);
          arr[i * 3 + 0] = b.baseX + Math.sin(t * 2.5 + i + b.phases[i]) * 0.018;
          arr[i * 3 + 1] = 0.83 + cycle * 0.16;
          arr[i * 3 + 2] = Math.cos(t * 2.0 + i * 1.3 + b.phases[i]) * 0.018;
        }
        b.geo.attributes.position.needsUpdate = true;
        if (b.surge > 0) b.surge = Math.max(0, b.surge - dt * 0.6);
      }
    }

    // === bookshelf — click ping makes the whole thing wiggle a tiny bit ===
    if (this._bookshelf?.userData?._pingT != null) {
      const dt2 = t - this._bookshelf.userData._pingT;
      this._bookshelf.rotation.z = dt2 < 0.5 ? Math.sin(dt2 * 22) * 0.02 * (1 - dt2 / 0.5) : 0;
    }

    // === whiteboard loading state — animated cue while iris is generating ===
    if (this._loading) this._paintLoadingFrame(t);

    // === axolotl — float gently up/down; click adds a tiny wiggle ===
    if (this._axolotl) {
      const ax = this._axolotl;
      const wiggleDt = t - ax.ping;
      const wiggleX = wiggleDt < 0.7 ? Math.sin(wiggleDt * 22) * 0.012 * (1 - wiggleDt / 0.7) : 0;
      ax.fish.position.y = ax.baseY + Math.sin(t * 0.9) * 0.012 + Math.sin(t * 0.3) * 0.005;
      ax.fish.position.x = wiggleX;
      ax.fish.rotation.z = Math.sin(t * 0.7) * 0.06;
    }

    // === draw ===
    this.controls.update();
    this.renderer.render(this.world, this.cam);

    requestAnimationFrame(this._frame);
  }
}
