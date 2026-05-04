// =============================================================
// scene.js — the SceneSpec layer (the whiteboard's content).
// Holds macro+micro+zoom+slider, but does NOT own a renderer
// and does NOT run its own animation loop. The owning LabScene
// (lab-scene.js) calls tick() and render() each frame.
// =============================================================

import * as THREE from 'three';
import { makeMacro } from './macro.js';
import { makeMicro } from './micro.js';

export class Scene {
  /**
   * @param {object} opts
   * @param {THREE.WebGLRenderer} opts.renderer  shared external renderer
   * @param {THREE.WebGLRenderTarget|null} opts.target  optional offscreen target
   * @param {number} opts.aspect  initial aspect ratio (target width / height)
   */
  constructor({ renderer, target = null, aspect = 4 / 3 } = {}) {
    if (!renderer) throw new Error('Scene needs a renderer');
    this.renderer = renderer;
    this.target   = target;

    this.world = new THREE.Scene();
    this.cam   = new THREE.PerspectiveCamera(40, aspect, 0.05, 2000);
    this.cam.position.set(0, 0, 12);

    // 3-point lighting — warm key + cool fill + warm rim. Tuned so
    // translucent macros (egg) read as egg and not as a fogged sphere.
    this.world.add(new THREE.AmbientLight(0xffffff, 0.45));
    const key = new THREE.DirectionalLight(0xfff5d4, 1.45);
    key.position.set(3.5, 4.5, 5.5);
    this.world.add(key);
    const fill = new THREE.DirectionalLight(0xc8e0ff, 0.55);
    fill.position.set(-4.5, 1.5, 3.5);
    this.world.add(fill);
    const rim = new THREE.DirectionalLight(0xffb98a, 0.4);
    rim.position.set(0, 2, -5);
    this.world.add(rim);

    this.macroGroup = new THREE.Group();
    this.microGroup = new THREE.Group();
    this.world.add(this.macroGroup, this.microGroup);

    this.zoom       = 0;          // 0 = macro, 1 = micro
    this.zoomTarget = 0;
    this.value      = 0;          // slider 0..1
    this.autoSpin   = true;       // gentle rotation when no user interaction
    this._lastT     = performance.now();
  }

  async play(spec) {
    this.spec = spec;
    this.macro?.dispose?.();
    this.micro?.dispose?.();
    this.macroGroup.clear();
    this.microGroup.clear();

    this.macro = await makeMacro(spec.macro);
    this.micro = await makeMicro(spec.micro);

    this.macroGroup.add(this.macro.object);
    this.microGroup.add(this.micro.object);

    this._frameTo(this.macro.bounds);
    this.zoom = 0; this.zoomTarget = 0;
    this._applyZoom();    // both layers visible from the first frame
    this.setValue(0);
  }

  setZoom(target)  { this.zoomTarget = Math.max(0, Math.min(1, target)); }
  setValue(v) {
    this.value = Math.max(0, Math.min(1, v));
    this.macro?.apply?.(this.spec.interaction.macro, this.value);
    this.micro?.apply?.(this.spec.interaction.micro, this.value);
  }

  /** Update camera aspect — call when target dimensions change. */
  setAspect(aspect) {
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();
  }

  /** Advance internal animations (zoom interpolation, macro/micro ticks, auto-rotation). */
  tick(now) {
    const dt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;
    const t = now / 1000;

    // smooth zoom interpolation
    if (Math.abs(this.zoom - this.zoomTarget) > 0.001) {
      this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 4);
      this._applyZoom();
    }

    // gentle auto-spin so the shape feels alive
    if (this.autoSpin) {
      this.macroGroup.rotation.y += dt * 0.25;
      this.microGroup.rotation.y += dt * 0.25;
    }

    this.macro?.tick?.(t, this.value);
    this.micro?.tick?.(t, this.value);
  }

  /** Render this scene to its render target (or directly to the canvas if target is null).
      Uses a warm-cream clear so the texture reads as a real whiteboard surface. */
  render() {
    const prevTarget = this.renderer.getRenderTarget();
    const prevClear  = new THREE.Color();
    this.renderer.getClearColor(prevClear);
    const prevAlpha  = this.renderer.getClearAlpha();

    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0xFCEFD2, 1.0);  // warm cream, like a sun-lit board
    this.renderer.render(this.world, this.cam);

    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevClear, prevAlpha);
  }

  _frameTo(bounds) {
    const r = bounds || 5;
    this.cam.position.set(0, 0, r * 2.6);
    this.cam.lookAt(0, 0, 0);
  }

  _applyZoom() {
    // New behaviour: BOTH layers stay visible. The macro becomes the
    // translucent everyday-object shell, the micro lives inside it.
    // The slider drives both layers' effects directly; "zoom" is just
    // a soft camera dolly + emphasis shift, never a blink toggle.
    const z = this.zoom;

    // Macro: always visible, fades from solid (0.92) at z=0 to a soft
    // ghost (0.28) at z=1 so the inner mechanism reads through.
    const macroAlpha = THREE.MathUtils.lerp(0.92, 0.28, z);
    this.macroGroup.visible = true;
    this.macroGroup.scale.setScalar(1);
    this.macro?.setOpacity?.(macroAlpha);

    // Micro: tucked INSIDE the macro at z=0 (small, opacity nudged up
    // so it reads through the shell), grows to full size at z=1.
    const macroR = this.macro?.bounds ?? 5;
    const microR = this.micro?.bounds ?? 30;
    const startScale = Math.min(0.85, (macroR / Math.max(0.5, microR)) * 0.55);
    const endScale   = 1.0;
    const microScale = THREE.MathUtils.lerp(startScale, endScale, z);
    this.microGroup.visible = true;
    this.microGroup.scale.setScalar(microScale);
    this.micro?.setOpacity?.(THREE.MathUtils.lerp(0.92, 1.0, z));

    // Camera: dollies in toward the micro view as zoom rises.
    const targetDist = THREE.MathUtils.lerp(macroR * 2.6, microR * endScale * 2.4, z);
    this.cam.position.set(0, 0, targetDist);
    this.cam.lookAt(0, 0, 0);
  }
}
