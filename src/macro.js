// =============================================================
// macro.js — cartoon macro layer.
// Each shape returns:
//   { object: THREE.Object3D, bounds: number,
//     apply(effect, value), setOpacity(a), tick(t,v), dispose() }
// =============================================================

import * as THREE from 'three';

export async function makeMacro(spec) {
  const factory = SHAPES[spec.shape] ?? SHAPES.blob;
  return factory(spec);
}

const SHAPES = {
  wedge(spec) {
    // Cartoon cheese wedge: extruded triangle with chunky bevel.
    const tri = new THREE.Shape();
    tri.moveTo(-1.2, -0.7);
    tri.lineTo( 1.2, -0.7);
    tri.lineTo( 0.0,  0.9);
    tri.closePath();
    const geo = new THREE.ExtrudeGeometry(tri, {
      depth: 1.4,
      bevelEnabled: true,
      bevelSize: 0.12,
      bevelThickness: 0.10,
      bevelSegments: 4,
      curveSegments: 6,
    });
    geo.translate(0, 0, -0.7);   // center along Z

    const mat = new THREE.MeshStandardMaterial({
      color: spec.color || '#f5cf5b',
      roughness: 0.55,
      metalness: 0.04,
      flatShading: true,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(2.0);

    // Cartoon "holes": small dark spheres recessed into the visible faces.
    // They live as children so opacity propagates via the material.
    const holeMat = new THREE.MeshStandardMaterial({
      color: '#9c7421', roughness: 0.85, transparent: true, opacity: 1,
    });
    const holePositions = [
      [-0.6,  0.05,  0.71],
      [ 0.55,-0.30,  0.71],
      [-0.30,-0.45,  0.71],
      [ 0.20, 0.30, -0.71],
    ];
    const holeMeshes = [];
    for (const [x, y, z] of holePositions) {
      const h = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), holeMat);
      h.position.set(x, y, z);
      mesh.add(h);
      holeMeshes.push(h);
    }

    const baseScaleY = mesh.scale.y;
    const baseRotZ   = mesh.rotation.z;

    return {
      object: mesh,
      bounds: 4.5,
      apply(effect, value) {
        if (effect === 'soften') {
          mesh.scale.y = baseScaleY * (1 - 0.35 * value);
          mesh.rotation.z = baseRotZ - 0.2 * value;
          mesh.position.y = -0.4 * value;     // sag
        } else if (effect === 'harden') {
          mesh.scale.y = baseScaleY * (1 + 0.05 * value);
        }
      },
      setOpacity(a) {
        mat.opacity = a;
        holeMat.opacity = a;
      },
      tick(t) {
        // Subtle idle bob so the wedge feels alive when value=0.
        mesh.position.x = Math.sin(t * 0.6) * 0.04;
      },
      dispose() {
        geo.dispose(); mat.dispose();
        for (const h of holeMeshes) h.geometry.dispose();
        holeMat.dispose();
      },
    };
  },

  blob(spec) {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color || '#dddddd', roughness: 0.6, transparent: true, opacity: 1,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(3);
    const baseScale = 3;
    return {
      object: mesh,
      bounds: 4,
      apply(effect, value) {
        if (effect === 'soften') mesh.scale.set(baseScale * (1 + 0.15*value), baseScale * (1 - 0.25*value), baseScale * (1 + 0.10*value));
        else if (effect === 'harden') mesh.scale.setScalar(baseScale * (1 - 0.05*value));
        else mesh.scale.setScalar(baseScale);
      },
      setOpacity(a) { mat.opacity = a; },
      tick(t, v) { mesh.rotation.y = t * 0.25; mesh.rotation.x = Math.sin(t*0.4) * 0.06 * (1 + v); },
      dispose() { geo.dispose(); mat.dispose(); },
    };
  },

  // smooth ball — egg-shaped via slight Y stretch. Translucent so the
  // micro layer (chain / particles) reads through. Great for: egg,
  // ball, fruit, planet, drop, bubble.
  sphere(spec) {
    const geo = new THREE.SphereGeometry(1, 56, 36);

    // Subtle two-tone material: warm cream outer with a soft inner glow,
    // tuned so a chain inside is clearly visible at any opacity.
    const mat = new THREE.MeshPhysicalMaterial({
      color: spec.color || '#fff4d6',
      roughness: 0.32,
      metalness: 0.0,
      transmission: 0.35,                // some light passes through (egg-y)
      thickness: 1.2,
      ior: 1.35,
      clearcoat: 0.4,
      clearcoatRoughness: 0.45,
      transparent: true,
      opacity: 1,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(2.4, 2.85, 2.4);      // egg-like vertical stretch
    const base = mesh.scale.clone();

    return {
      object: mesh,
      bounds: 4.4,
      apply(effect, value) {
        if (effect === 'soften') {
          mesh.scale.set(base.x * (1 + 0.12 * value), base.y * (1 - 0.22 * value), base.z * (1 + 0.12 * value));
        } else if (effect === 'harden') {
          mesh.scale.set(base.x * (1 - 0.04 * value), base.y * (1 - 0.04 * value), base.z * (1 - 0.04 * value));
        } else {
          mesh.scale.copy(base);
        }
        // tiny colour shift on harden — egg goes faintly creamier as it sets
        if (effect === 'harden') {
          const c = new THREE.Color(spec.color || '#fff4d6');
          c.lerp(new THREE.Color('#ffffff'), value * 0.15);
          mat.color.copy(c);
        }
      },
      setOpacity(a) { mat.opacity = a; },
      tick(t) {
        mesh.rotation.y = t * 0.30;
        mesh.position.y = Math.sin(t * 0.7) * 0.06;
      },
      dispose() { geo.dispose(); mat.dispose(); },
    };
  },

  // donut / ring. great for: fusion magnet trap, racetrack, anything looped.
  torus(spec) {
    const group = new THREE.Group();

    const geo = new THREE.TorusGeometry(2.2, 0.55, 24, 96);
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color || '#ffae3a',
      roughness: 0.4, metalness: 0.25,
      transparent: true, opacity: 1,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = Math.PI / 2 * 0.85;   // tilted so we read the donut as 3D
    group.add(ring);

    // a faint "field line" set to suggest containment — three thinner tori, twisted
    const fieldMats = [];
    const fieldGeos = [];
    for (let i = 0; i < 3; i++) {
      const fg = new THREE.TorusGeometry(2.2, 0.06, 8, 96);
      const fm = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.55,
      });
      const fr = new THREE.Mesh(fg, fm);
      fr.rotation.x = Math.PI / 2 * 0.85;
      fr.rotation.z = (i / 3) * Math.PI * 2;
      group.add(fr);
      fieldMats.push(fm);
      fieldGeos.push(fg);
    }

    return {
      object: group,
      bounds: 5.5,
      apply(effect, value) {
        // "harden" tightens the ring tube; "soften" loosens. Visually subtle but tied to the slider.
        const s = effect === 'harden' ? 1 - 0.08 * value
                : effect === 'soften' ? 1 + 0.10 * value
                : 1;
        ring.scale.set(1, 1, s);
        // field-line opacity rises with slider so "stronger magnet → clearer field"
        for (const fm of fieldMats) fm.opacity = 0.25 + 0.55 * value;
      },
      setOpacity(a) {
        mat.opacity = a;
        for (const fm of fieldMats) fm.opacity = Math.min(fm.opacity, a);
      },
      tick(t) {
        group.rotation.y = t * 0.3;
        // slow rotation of field lines to suggest motion of the trap
        for (let i = 0; i < fieldMats.length; i++) {
          const fr = group.children[i + 1];
          fr.rotation.z = (i / 3) * Math.PI * 2 + t * 0.4;
        }
      },
      dispose() {
        geo.dispose(); mat.dispose();
        for (const g of fieldGeos) g.dispose();
        for (const m of fieldMats) m.dispose();
      },
    };
  },

  // two shapes side-by-side for compare-style teaching.
  // spec.left / spec.right each carry { shape, color, label }.
  pair(spec) {
    const group = new THREE.Group();
    const SEP = 3.6;

    const left  = SHAPES[spec.left?.shape  || 'sphere']({ color: spec.left?.color  || '#d8d8d8' });
    const right = SHAPES[spec.right?.shape || 'blob'  ]({ color: spec.right?.color || '#ffd0a0' });

    left.object.position.x  = -SEP;
    right.object.position.x = +SEP;
    // shrink each so two fit on screen
    left.object.scale.multiplyScalar(0.8);
    right.object.scale.multiplyScalar(0.8);
    group.add(left.object, right.object);

    // labels as floating sprites under each shape
    const leftLabel  = makeLabelSprite(spec.left?.label  || '');
    const rightLabel = makeLabelSprite(spec.right?.label || '');
    leftLabel.position.set(-SEP, -3.4, 0);
    rightLabel.position.set(+SEP, -3.4, 0);
    group.add(leftLabel, rightLabel);

    return {
      object: group,
      bounds: 6,
      apply(effect, value) {
        // The whole point of `pair` is asymmetric reaction:
        //   - LEFT (the "tough" / control side) barely changes
        //   - RIGHT (the "fragile" side) responds fully
        left.apply?.('none', value * 0.15);
        right.apply?.(effect, value);
      },
      setOpacity(a) {
        left.setOpacity?.(a); right.setOpacity?.(a);
        leftLabel.material.opacity  = a;
        rightLabel.material.opacity = a;
      },
      tick(t, v) {
        left.tick?.(t, v); right.tick?.(t, v);
      },
      dispose() {
        left.dispose?.(); right.dispose?.();
        leftLabel.material.map?.dispose(); leftLabel.material.dispose();
        rightLabel.material.map?.dispose(); rightLabel.material.dispose();
      },
    };
  },
};

// canvas → texture sprite for floating labels under pair shapes.
function makeLabelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = '700 60px Fredoka, sans-serif';
  ctx.fillStyle = '#2D2622';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text || '', canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 1 });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3.2, 0.8, 1);
  return sprite;
}
