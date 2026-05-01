// =============================================================
// micro.js — real-data micro layer.
// rcsb: load PDB, render one instanced sphere per atom.
// inline-particles: small procedural sims (stub for now).
// =============================================================

import * as THREE from 'three';

const ELEMENT_COLOR = {
  H:  0xffffff, C:  0x707080, N:  0x3366f0, O:  0xf03333,
  S:  0xf2d930, P:  0xf2902a,
  FE: 0xd96619, ZN: 0x8c8ca5, CA: 0x4cd94c, MG: 0x66d966,
};
const DEFAULT_COLOR = 0xb380d9;

const ELEMENT_VDW = {
  H: 1.20, C: 1.70, N: 1.55, O: 1.52, S: 1.80, P: 1.80,
  FE: 1.94, ZN: 1.39, CA: 1.97, MG: 1.73,
};
const DEFAULT_VDW = 1.70;

export async function makeMicro(spec) {
  if (spec.source === 'rcsb')             return makePdb(spec);
  if (spec.source === 'inline-particles') return makeParticles(spec);
  throw new Error('unknown micro source: ' + spec.source);
}

async function makePdb(spec) {
  const url = `https://files.rcsb.org/download/${spec.id}.pdb`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PDB fetch ${res.status}`);
  const atoms = parsePdbAtoms(await res.text());
  if (atoms.length === 0) throw new Error('no ATOM records');

  // Center.
  const c = [0, 0, 0];
  for (const a of atoms) for (let k = 0; k < 3; k++) c[k] += a.pos[k];
  for (let k = 0; k < 3; k++) c[k] /= atoms.length;
  let maxR = 0;
  for (const a of atoms) {
    for (let k = 0; k < 3; k++) a.pos[k] -= c[k];
    const r = Math.hypot(a.pos[0], a.pos[1], a.pos[2]);
    if (r > maxR) maxR = r;
  }

  const geo = new THREE.SphereGeometry(1, 18, 14);
  const mat = new THREE.MeshStandardMaterial({
    metalness: 0.05, roughness: 0.55, transparent: true, opacity: 1,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, atoms.length);
  const dummy = new THREE.Object3D();
  const colorObj = new THREE.Color();

  const basePos = new Float32Array(atoms.length * 3);
  const phases  = new Float32Array(atoms.length);
  const radii   = new Float32Array(atoms.length);

  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    const vdw = ELEMENT_VDW[a.element] ?? DEFAULT_VDW;
    radii[i] = vdw * 0.55;
    basePos[i*3+0] = a.pos[0];
    basePos[i*3+1] = a.pos[1];
    basePos[i*3+2] = a.pos[2];
    phases[i] = (i * 0.6180339887) % 1 * Math.PI * 2;

    dummy.position.set(a.pos[0], a.pos[1], a.pos[2]);
    dummy.scale.setScalar(radii[i]);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    colorObj.setHex(ELEMENT_COLOR[a.element] ?? DEFAULT_COLOR);
    mesh.setColorAt(i, colorObj);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  // Effect parameters driven by `apply`.
  let wiggleAmp = 0.18;     // baseline thermal jitter
  let unfoldT   = 0;        // 0..1, stretches along principal axis
  let breakT    = 0;        // 0..1, splits halves apart
  let clusterT  = 0;        // 0..1, pulls toward centroid

  return {
    object: mesh,
    bounds: maxR,
    apply(effect, value) {
      switch (effect) {
        case 'wiggle':  wiggleAmp = 0.05 + value * 0.9; break;
        case 'unfold':  unfoldT = value; break;
        case 'break':   breakT = value; break;
        case 'cluster': clusterT = value; break;
      }
    },
    setOpacity(a) { mat.opacity = a; },
    tick(t) {
      for (let i = 0; i < atoms.length; i++) {
        const ph = phases[i];
        const dx = Math.sin(t * 1.6 + ph)         * wiggleAmp;
        const dy = Math.cos(t * 1.3 + ph * 1.7)   * wiggleAmp;
        const dz = Math.sin(t * 1.1 + ph * 0.7)   * wiggleAmp;

        let x = basePos[i*3+0];
        let y = basePos[i*3+1];
        let z = basePos[i*3+2];

        if (unfoldT > 0)  { z *= 1 + unfoldT * 0.6; }
        if (breakT > 0)   { x += (x >= 0 ? 1 : -1) * breakT * 6; }
        if (clusterT > 0) { x *= 1 - clusterT * 0.5; y *= 1 - clusterT * 0.5; z *= 1 - clusterT * 0.5; }

        const r = radii[i] * (1 + 0.04 * Math.sin(t * 0.8 + ph));
        dummy.position.set(x + dx, y + dy, z + dz);
        dummy.scale.setScalar(r);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

function makeParticles(spec) {
  // Stub. The cheese demo doesn't use this path; soda etc. will.
  const geo = new THREE.BufferGeometry();
  const N = 200;
  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    positions[i*3+0] = (Math.random() - 0.5) * 12;
    positions[i*3+1] = (Math.random() - 0.5) * 12;
    positions[i*3+2] = (Math.random() - 0.5) * 12;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0x88c4f0, size: 0.4, transparent: true });
  const points = new THREE.Points(geo, mat);
  return {
    object: points,
    bounds: 8,
    apply() {},
    setOpacity(a) { mat.opacity = a; },
    tick() {},
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

function parsePdbAtoms(text) {
  const atoms = [];
  for (const line of text.split('\n')) {
    if (!(line.startsWith('ATOM  ') || line.startsWith('HETATM'))) continue;
    if (line.length < 54) continue;
    const x = parseFloat(line.slice(30, 38));
    const y = parseFloat(line.slice(38, 46));
    const z = parseFloat(line.slice(46, 54));
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    let element = (line.length >= 78 ? line.slice(76, 78) : '').trim().toUpperCase();
    if (!element) {
      const name = line.slice(12, 16).trim().replace(/[^A-Za-z]/g, '').toUpperCase();
      element = (name && 'CHNOSP'.includes(name[0])) ? name[0] : name.slice(0, 2);
    }
    atoms.push({ pos: [x, y, z], element });
  }
  return atoms;
}
