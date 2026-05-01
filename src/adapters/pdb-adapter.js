// =============================================================
// PdbAdapter — first concrete adapter for the fused splat renderer.
// Loads a PDB file, generates one Gaussian splat per atom.
// Color by element, scale by van der Waals radius.
// Wiggle animation via per-atom phase, evaluated on GPU each frame.
// =============================================================

const SPLAT_BYTES = 64; // matches Splat struct in splat.wgsl

// CPK / Jmol-ish element colors (subset of common biological elements).
const ELEMENT_COLOR = {
  H: [1.00, 1.00, 1.00],
  C: [0.45, 0.45, 0.50],
  N: [0.20, 0.40, 0.95],
  O: [0.95, 0.20, 0.20],
  S: [0.95, 0.85, 0.20],
  P: [0.95, 0.55, 0.15],
  FE: [0.85, 0.40, 0.10],
  ZN: [0.55, 0.55, 0.65],
  CA: [0.30, 0.85, 0.30],
  MG: [0.40, 0.85, 0.40],
};
const DEFAULT_COLOR = [0.70, 0.50, 0.85];

// Van der Waals radii in ångströms.
const ELEMENT_VDW = {
  H: 1.20, C: 1.70, N: 1.55, O: 1.52, S: 1.80, P: 1.80,
  FE: 1.94, ZN: 1.39, CA: 1.97, MG: 1.73,
};
const DEFAULT_VDW = 1.70;

export class PdbAdapter {
  /** @type {GPUBuffer} */ splatBuffer;
  /** @type {GPUBuffer} */ basePositionsBuf;
  /** @type {GPUBuffer} */ phasesBuf;
  /** @type {GPUBuffer} */ wiggleParamsBuf;
  /** @type {GPUComputePipeline} */ wigglePipeline;
  splatCount = 0;

  info = {
    domain: 'molecular',
    source: '',
    units: 'ångström',
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  };

  /**
   * Build adapter from a PDB string.
   * @param {GPUDevice} device
   * @param {string} pdbText
   * @param {string} sourceLabel
   */
  static async fromText(device, pdbText, sourceLabel = 'PDB') {
    const adapter = new PdbAdapter();
    adapter.info.source = sourceLabel;

    // Parse ATOM records.
    const atoms = parsePdbAtoms(pdbText);
    if (atoms.length === 0) throw new Error('No ATOM records found in PDB.');
    adapter.splatCount = atoms.length;

    // Compute bounds + center.
    const min = [+Infinity, +Infinity, +Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const a of atoms) {
      for (let k = 0; k < 3; k++) {
        if (a.pos[k] < min[k]) min[k] = a.pos[k];
        if (a.pos[k] > max[k]) max[k] = a.pos[k];
      }
    }
    const center = [(min[0]+max[0])/2, (min[1]+max[1])/2, (min[2]+max[2])/2];
    for (const a of atoms) {
      a.pos[0] -= center[0]; a.pos[1] -= center[1]; a.pos[2] -= center[2];
    }
    adapter.info.bounds = {
      min: [min[0]-center[0], min[1]-center[1], min[2]-center[2]],
      max: [max[0]-center[0], max[1]-center[1], max[2]-center[2]],
    };

    // Build CPU-side splat data.
    const splatBytes = new ArrayBuffer(atoms.length * SPLAT_BYTES);
    const f32 = new Float32Array(splatBytes);
    const basePos = new Float32Array(atoms.length * 4);
    const phases = new Float32Array(atoms.length);

    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      const off = i * 16; // 64 bytes / 4 bytes-per-f32

      const vdw = ELEMENT_VDW[a.element] ?? DEFAULT_VDW;
      // Slightly soften atoms so they overlap into a continuous surface.
      // sigma here is the Gaussian std dev, not the rendered radius.
      const sigma = vdw * 0.55;

      const col = ELEMENT_COLOR[a.element] ?? DEFAULT_COLOR;

      // position (vec3 + pad)
      f32[off + 0] = a.pos[0]; f32[off + 1] = a.pos[1]; f32[off + 2] = a.pos[2]; f32[off + 3] = 0;
      // scale (vec3 + pad) — isotropic for atoms
      f32[off + 4] = sigma;    f32[off + 5] = sigma;    f32[off + 6] = sigma;    f32[off + 7] = 0;
      // rotation quaternion (identity)
      f32[off + 8] = 0; f32[off + 9] = 0; f32[off + 10] = 0; f32[off + 11] = 1;
      // color rgba (alpha = density; tuned for chunky look)
      f32[off + 12] = col[0]; f32[off + 13] = col[1]; f32[off + 14] = col[2]; f32[off + 15] = 0.95;

      basePos[i*4 + 0] = a.pos[0];
      basePos[i*4 + 1] = a.pos[1];
      basePos[i*4 + 2] = a.pos[2];
      basePos[i*4 + 3] = 0;

      // Pseudo-random phase from atom index for breathing wiggle.
      phases[i] = (i * 0.6180339887) % 1 * Math.PI * 2;
    }

    // Allocate GPU buffers.
    adapter.splatBuffer = device.createBuffer({
      size: splatBytes.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(adapter.splatBuffer, 0, splatBytes);

    adapter.basePositionsBuf = device.createBuffer({
      size: basePos.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(adapter.basePositionsBuf, 0, basePos);

    adapter.phasesBuf = device.createBuffer({
      size: phases.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(adapter.phasesBuf, 0, phases);

    adapter.wiggleParamsBuf = device.createBuffer({
      size: 16, // time, amplitude, count, _pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Wiggle compute pipeline.
    const wgsl = /* wgsl */`
      struct Splat {
        position: vec3<f32>, _pad0: f32,
        scale: vec3<f32>,    _pad1: f32,
        rotation: vec4<f32>,
        color: vec4<f32>,
      };
      struct Params {
        time: f32, amplitude: f32, count: u32, _pad: f32,
      };
      @group(0) @binding(0) var<storage, read_write> splats:    array<Splat>;
      @group(0) @binding(1) var<storage, read>       base_pos:  array<vec4<f32>>;
      @group(0) @binding(2) var<storage, read>       phases:    array<f32>;
      @group(0) @binding(3) var<uniform>             params:    Params;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i = gid.x;
        if (i >= params.count) { return; }
        let phase = phases[i];
        let t = params.time;
        // Per-atom breathing wiggle: small position perturbation + uniform pulse.
        let dx = sin(t * 1.6 + phase) * params.amplitude;
        let dy = cos(t * 1.3 + phase * 1.7) * params.amplitude;
        let dz = sin(t * 1.1 + phase * 0.7) * params.amplitude;
        let bp = base_pos[i].xyz;
        splats[i].position = bp + vec3<f32>(dx, dy, dz);

        // Subtle scale breathing.
        let pulse = 1.0 + 0.04 * sin(t * 0.8 + phase);
        let s0 = splats[i].scale.x; // assumes isotropic at load time
        let s = s0 * pulse;
        splats[i].scale = vec3<f32>(s, s, s);
      }
    `;
    const mod = device.createShaderModule({ code: wgsl, label: 'pdb-wiggle' });
    adapter.wigglePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: mod, entryPoint: 'main' },
    });

    return adapter;
  }

  static async fromUrl(device, url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch PDB: ${res.status} ${res.statusText}`);
    const text = await res.text();
    return PdbAdapter.fromText(device, text, url);
  }

  update(device, encoder, t) {
    // Wiggle amplitude in ångströms — small enough to feel like thermal motion.
    const amplitude = 0.18;
    device.queue.writeBuffer(
      this.wiggleParamsBuf, 0,
      new Float32Array([t, amplitude, 0, 0]).buffer
    );
    // Write count as u32 in the same buffer.
    const tmp = new ArrayBuffer(16);
    new Float32Array(tmp)[0] = t;
    new Float32Array(tmp)[1] = amplitude;
    new Uint32Array(tmp)[2]  = this.splatCount;
    device.queue.writeBuffer(this.wiggleParamsBuf, 0, tmp);

    const bg = device.createBindGroup({
      layout: this.wigglePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.splatBuffer } },
        { binding: 1, resource: { buffer: this.basePositionsBuf } },
        { binding: 2, resource: { buffer: this.phasesBuf } },
        { binding: 3, resource: { buffer: this.wiggleParamsBuf } },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'pdb-wiggle' });
    pass.setPipeline(this.wigglePipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(this.splatCount / 64));
    pass.end();
  }

  dispose() {
    this.splatBuffer?.destroy();
    this.basePositionsBuf?.destroy();
    this.phasesBuf?.destroy();
    this.wiggleParamsBuf?.destroy();
  }
}

// =============================================================
// Minimal PDB parser — ATOM records only, fixed-column format.
// Per PDB spec: cols 31-38 x, 39-46 y, 47-54 z (1-indexed, inclusive).
// Element symbol: cols 77-78. If missing, fall back to atom name (cols 13-16).
// =============================================================
function parsePdbAtoms(text) {
  const atoms = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!(line.startsWith('ATOM  ') || line.startsWith('HETATM'))) continue;
    if (line.length < 54) continue;
    const x = parseFloat(line.slice(30, 38));
    const y = parseFloat(line.slice(38, 46));
    const z = parseFloat(line.slice(46, 54));
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;

    let element = (line.length >= 78 ? line.slice(76, 78) : '').trim().toUpperCase();
    if (!element) {
      // Fallback: derive from atom name. First non-digit char(s).
      const name = line.slice(12, 16).trim();
      element = name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
      // Heuristic: if name starts with a single letter that's a common element, prefer that.
      if ('CHNOSP'.includes(element[0])) element = element[0];
    }
    atoms.push({ pos: [x, y, z], element });
  }
  return atoms;
}
