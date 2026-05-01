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
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(3);
    return {
      object: mesh,
      bounds: 4,
      apply() {},
      setOpacity(a) { mat.opacity = a; },
      tick(t) { mesh.rotation.y = t * 0.2; },
      dispose() { geo.dispose(); mat.dispose(); },
    };
  },
};
