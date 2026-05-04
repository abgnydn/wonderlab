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
  if (spec.source === 'chain')            return makeChain(spec);
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

// =============================================================
// inline-particles — a real animated particle cloud.
// Used for: hot stuff bouncing, water flow, drug bits in
// bloodstream, anything cloud-shaped without a specific PDB.
// Responds to all four interaction.micro effects.
// =============================================================
function makeParticles(spec) {
  const N = 360;
  const R = 4;                                 // initial cloud radius

  const basePos = new Float32Array(N * 3);
  const phase   = new Float32Array(N);
  const positions = new Float32Array(N * 3);

  for (let i = 0; i < N; i++) {
    // start in a roughly spherical shell so it reads as "inside the thing"
    const u = Math.random(), v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi   = Math.acos(2 * v - 1);
    const r     = R * (0.4 + 0.6 * Math.cbrt(Math.random()));
    basePos[i*3+0] = r * Math.sin(phi) * Math.cos(theta);
    basePos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
    basePos[i*3+2] = r * Math.cos(phi);
    positions.set(basePos.subarray(i*3, i*3+3), i*3);
    phase[i] = Math.random() * Math.PI * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  // colour the particles warm so they pop on the cream whiteboard
  const colorByEffect = {
    wiggle:  0xff8a5a,
    unfold:  0xb380d9,
    break:   0xe66363,
    cluster: 0xf2902a,
  };
  const fallback = 0xff8a5a;
  const colorHex = colorByEffect[spec.effectHint] ?? fallback;

  const mat = new THREE.PointsMaterial({
    color: colorHex,
    size: 0.42,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);

  let wiggleAmp = 0.18;
  let unfoldT   = 0;
  let breakT    = 0;
  let clusterT  = 0;

  return {
    object: points,
    bounds: R + 1,
    apply(effect, value) {
      switch (effect) {
        case 'wiggle':  wiggleAmp = 0.05 + value * 1.2; break;
        case 'unfold':  unfoldT   = value; break;
        case 'break':   breakT    = value; break;
        case 'cluster': clusterT  = value; break;
      }
    },
    setOpacity(a) { mat.opacity = a; },
    tick(t) {
      const arr = geo.attributes.position.array;
      for (let i = 0; i < N; i++) {
        const ph = phase[i];
        const dx = Math.sin(t * 1.5 + ph)         * wiggleAmp;
        const dy = Math.cos(t * 1.2 + ph * 1.7)   * wiggleAmp;
        const dz = Math.sin(t * 1.1 + ph * 0.7)   * wiggleAmp;

        let x = basePos[i*3+0];
        let y = basePos[i*3+1];
        let z = basePos[i*3+2];

        if (unfoldT  > 0) { z *= 1 + unfoldT * 0.8; }
        if (breakT   > 0) { x += (x >= 0 ? 1 : -1) * breakT * (R * 0.8); }
        if (clusterT > 0) { x *= 1 - clusterT * 0.65; y *= 1 - clusterT * 0.65; z *= 1 - clusterT * 0.65; }

        arr[i*3+0] = x + dx;
        arr[i*3+1] = y + dy;
        arr[i*3+2] = z + dz;
      }
      geo.attributes.position.needsUpdate = true;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// =============================================================
// chain — a polymer chain (tube + bead joints).
// The protein-folding archetype: starts loose and wiggling,
// ends locked into a permanent knot.
//
// Responds to:
//   wiggle  — increases thermal jitter on each segment
//   cluster — collapses into a tangled knot at the centre
//   unfold — straightens (negative folding direction)
//   break   — splits chain into two halves
// =============================================================
function makeChain(spec) {
  const N = 36;                                  // joints
  const SEG = 0.55;                              // ideal segment length

  // --- generate a random walk seed shape for the relaxed state ---
  const basePos = new Float32Array(N * 3);
  const phase   = new Float32Array(N);
  let x = -SEG * (N - 1) / 2, y = 0, z = 0, dir = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < N; i++) {
    basePos[i*3+0] = x;
    basePos[i*3+1] = y;
    basePos[i*3+2] = z;
    phase[i] = Math.random() * Math.PI * 2;
    // jitter direction so the relaxed chain has a casual curl
    dir.x += (Math.random() - 0.5) * 0.4;
    dir.y += (Math.random() - 0.5) * 0.4;
    dir.z += (Math.random() - 0.5) * 0.3;
    dir.normalize();
    x += dir.x * SEG;
    y += dir.y * SEG;
    z += dir.z * SEG;
  }
  // centre
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < N; i++) { cx += basePos[i*3]; cy += basePos[i*3+1]; cz += basePos[i*3+2]; }
  cx /= N; cy /= N; cz /= N;
  for (let i = 0; i < N; i++) { basePos[i*3] -= cx; basePos[i*3+1] -= cy; basePos[i*3+2] -= cz; }

  // --- bead spheres (instanced for cheap rendering) ---
  const beadGeo = new THREE.SphereGeometry(0.18, 14, 10);
  const beadMat = new THREE.MeshStandardMaterial({
    color: 0xff8a5a, roughness: 0.45, transparent: true, opacity: 1,
  });
  const beads = new THREE.InstancedMesh(beadGeo, beadMat, N);
  const dummy = new THREE.Object3D();

  // --- tube segments between beads ---
  const segGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 8);
  const segMat = new THREE.MeshStandardMaterial({
    color: 0xff8a5a, roughness: 0.5, transparent: true, opacity: 1,
  });
  const segs = new THREE.InstancedMesh(segGeo, segMat, N - 1);

  const group = new THREE.Group();
  group.add(beads, segs);

  // --- runtime state ---
  let wiggleAmp = 0.05;
  let clusterT  = 0;
  let unfoldT   = 0;
  let breakT    = 0;
  const cur = new Float32Array(N * 3);    // currently-displayed positions

  // helper: write bead+segment matrices from cur[]
  const _v = new THREE.Vector3();
  const _u = new THREE.Vector3(0, 1, 0);
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4();

  function refreshMatrices() {
    for (let i = 0; i < N; i++) {
      dummy.position.set(cur[i*3], cur[i*3+1], cur[i*3+2]);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      beads.setMatrixAt(i, dummy.matrix);
    }
    beads.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < N - 1; i++) {
      const ax = cur[i*3],     ay = cur[i*3+1],     az = cur[i*3+2];
      const bx = cur[(i+1)*3], by = cur[(i+1)*3+1], bz = cur[(i+1)*3+2];
      _v.set(bx - ax, by - ay, bz - az);
      const len = _v.length() || 0.001;
      _v.normalize();
      _q.setFromUnitVectors(_u, _v);
      _m.compose(
        new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2),
        _q,
        new THREE.Vector3(0.6, len, 0.6)
      );
      segs.setMatrixAt(i, _m);
    }
    segs.instanceMatrix.needsUpdate = true;
  }

  // initial state
  for (let i = 0; i < N * 3; i++) cur[i] = basePos[i];
  refreshMatrices();

  // bounding sphere radius
  let maxR = 0;
  for (let i = 0; i < N; i++) {
    const r = Math.hypot(basePos[i*3], basePos[i*3+1], basePos[i*3+2]);
    if (r > maxR) maxR = r;
  }

  return {
    object: group,
    bounds: maxR + 0.4,
    apply(effect, value) {
      switch (effect) {
        case 'wiggle':  wiggleAmp = 0.04 + value * 0.45; break;
        case 'cluster': clusterT  = value; break;
        case 'unfold':  unfoldT   = value; break;
        case 'break':   breakT    = value; break;
      }
    },
    setOpacity(a) {
      beadMat.opacity = a;
      segMat.opacity  = a;
    },
    tick(t) {
      // colour shifts from cool-orange to deep-rose as it locks (clusters)
      const tangleRed = Math.min(1, clusterT * 1.4);
      beadMat.color.setRGB(
        1.0 - 0.1 * tangleRed,
        0.54 - 0.30 * tangleRed,
        0.35 - 0.15 * tangleRed
      );
      segMat.color.copy(beadMat.color);

      for (let i = 0; i < N; i++) {
        let x = basePos[i*3];
        let y = basePos[i*3+1];
        let z = basePos[i*3+2];

        // unfold: stretch along x
        if (unfoldT > 0) x *= 1 + unfoldT * 0.8;

        // break: split halves apart along x
        if (breakT > 0) x += (i < N/2 ? -1 : 1) * breakT * 2.2;

        // cluster (tangle/lock): pull each bead toward the centre, but keep
        // some chaos so it reads as a knot rather than a single point
        if (clusterT > 0) {
          const k = clusterT * 0.7;
          x = THREE.MathUtils.lerp(x, Math.sin(phase[i] * 1.2) * 0.6, k);
          y = THREE.MathUtils.lerp(y, Math.cos(phase[i] * 0.9) * 0.6, k);
          z = THREE.MathUtils.lerp(z, Math.sin(phase[i] * 1.7) * 0.5, k);
        }

        // wiggle: thermal jitter (damped once locked)
        const damp = 1 - clusterT * 0.7;
        const ph = phase[i];
        x += Math.sin(t * 1.6 + ph)        * wiggleAmp * damp;
        y += Math.cos(t * 1.3 + ph * 1.7)  * wiggleAmp * damp;
        z += Math.sin(t * 1.1 + ph * 0.7)  * wiggleAmp * damp;

        cur[i*3]   = x;
        cur[i*3+1] = y;
        cur[i*3+2] = z;
      }
      refreshMatrices();
    },
    dispose() {
      beadGeo.dispose(); beadMat.dispose();
      segGeo.dispose();  segMat.dispose();
    },
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
