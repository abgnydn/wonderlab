// =============================================================
// scene.js — takes a SceneSpec and plays it.
// Owns the macro (cartoon) layer, the micro (real-data) layer,
// the zoom transition between them, and the interaction control.
// =============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeMacro } from './macro.js';
import { makeMicro } from './micro.js';

export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.world = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
    this.cam.position.set(0, 0, 12);

    this.world.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xfff2c8, 1.0); key.position.set(2, 3, 4); this.world.add(key);
    const rim = new THREE.DirectionalLight(0xa8d0ff, 0.4); rim.position.set(-3, -1, -2); this.world.add(rim);

    this.controls = new OrbitControls(this.cam, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.4;

    this.macroGroup = new THREE.Group();
    this.microGroup = new THREE.Group();
    this.world.add(this.macroGroup, this.microGroup);

    this.zoom = 0;          // 0 = macro, 1 = micro
    this.zoomTarget = 0;
    this.value = 0;         // interaction slider value 0..1

    this.fitCanvas();
    new ResizeObserver(() => this.fitCanvas()).observe(canvas);
    canvas.addEventListener('pointerdown', () => { this.controls.autoRotate = false; }, { once: true });

    this._lastT = performance.now();
    requestAnimationFrame(this._frame.bind(this));
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
    this.microGroup.visible = false;
    this.microGroup.scale.setScalar(0.0);

    // Frame the macro shape.
    this._frameTo(this.macro.bounds);
    this.zoom = 0; this.zoomTarget = 0;

    // Initial value 0 — apply once so the layers settle.
    this.setValue(0);
  }

  setZoom(target) {
    this.zoomTarget = Math.max(0, Math.min(1, target));
    // Once the user picks, stop auto-rotating so the transition reads cleanly.
    this.controls.autoRotate = false;
  }

  setValue(v) {
    this.value = Math.max(0, Math.min(1, v));
    this.macro?.apply?.(this.spec.interaction.macro, this.value);
    this.micro?.apply?.(this.spec.interaction.micro, this.value);
  }

  fitCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(2, Math.floor(rect.width));
    const h = Math.max(2, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  _frameTo(bounds) {
    const r = bounds || 5;
    this.cam.position.set(0, 0, r * 2.6);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  _frame(now) {
    const dt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;
    const t = now / 1000;

    // Smooth zoom toward target.
    if (Math.abs(this.zoom - this.zoomTarget) > 0.001) {
      this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 4);
      this._applyZoom();
    }

    this.macro?.tick?.(t, this.value);
    this.micro?.tick?.(t, this.value);

    this.controls.update();
    this.renderer.render(this.world, this.cam);
    requestAnimationFrame(this._frame.bind(this));
  }

  _applyZoom() {
    const z = this.zoom;
    // Macro fades out and slightly grows (camera "approaching the surface").
    const macroAlpha = Math.max(0, 1 - z * 1.4);          // hits 0 by z ≈ 0.7
    const macroScale = 1 + z * 0.6;
    this.macroGroup.visible = macroAlpha > 0.01;
    this.macroGroup.scale.setScalar(macroScale);
    this.macro?.setOpacity?.(macroAlpha);

    // Micro fades in starting around z = 0.4.
    const microAlpha = Math.max(0, Math.min(1, (z - 0.4) / 0.6));
    const microScale = 0.2 + microAlpha * 0.8;
    this.microGroup.visible = microAlpha > 0.01;
    this.microGroup.scale.setScalar(microScale);
    this.micro?.setOpacity?.(microAlpha);

    // Lerp camera framing between macro radius and micro radius.
    const macroR = this.macro?.bounds ?? 5;
    const microR = this.micro?.bounds ?? 30;
    const targetDist = THREE.MathUtils.lerp(macroR * 2.6, microR * 2.6 / Math.max(0.2, microScale), z);
    const dir = this.cam.position.clone().sub(this.controls.target).normalize();
    this.cam.position.copy(dir.multiplyScalar(targetDist).add(this.controls.target));
  }
}
