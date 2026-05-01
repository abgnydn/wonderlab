// =============================================================
// FusedSplatRenderer — JS host for splat.wgsl
// Owns: device, pipelines, bind groups, camera UBO, output texture, blit.
// One submit per frame: adapter.update() + project + composite + blit.
// =============================================================

const CAMERA_UBO_BYTES = 288; // see splat.wgsl Camera struct

export class FusedSplatRenderer {
  /** @type {GPUDevice} */          device;
  /** @type {GPUCanvasContext} */   ctx;
  /** @type {GPUTextureFormat} */   format;
  /** @type {HTMLCanvasElement} */  canvas;

  /** @type {GPUComputePipeline} */ projectPipeline;
  /** @type {GPUComputePipeline} */ compositePipeline;
  /** @type {GPURenderPipeline}  */ blitPipeline;

  /** @type {GPUBuffer}    */ cameraBuf;
  /** @type {GPUBuffer}    */ projectedBuf;
  /** @type {GPUBuffer}    */ counterBuf;
  /** @type {GPUTexture}   */ outputTex;
  /** @type {GPUSampler}   */ blitSampler;

  /** Current adapter providing the splat buffer. */
  adapter = null;

  // Camera state (CPU side).
  viewMat = identity4();
  projMat = identity4();

  // Tunable: max projected splats kept after culling. Bigger = more memory.
  maxProjected = 65536;

  static async create(canvas) {
    if (!('gpu' in navigator)) {
      throw new Error('WebGPU not supported in this browser. Try Chrome, Edge, or Brave on desktop.');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No GPU adapter found.');
    const device = await adapter.requestDevice();

    const r = new FusedSplatRenderer();
    r.canvas = canvas;
    r.device = device;
    r.ctx = canvas.getContext('webgpu');
    r.format = navigator.gpu.getPreferredCanvasFormat();
    r.ctx.configure({ device, format: r.format, alphaMode: 'premultiplied' });

    // Load WGSL.
    const wgsl = await (await fetch(new URL('./splat.wgsl', import.meta.url))).text();
    const module = device.createShaderModule({ code: wgsl, label: 'splat-wgsl' });

    // Resources.
    r.cameraBuf    = device.createBuffer({ size: CAMERA_UBO_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    r.projectedBuf = device.createBuffer({ size: r.maxProjected * 48, usage: GPUBufferUsage.STORAGE });
    r.counterBuf   = device.createBuffer({ size: 4,                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    r.counterReadback = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    r.lastProjectedCount = -1;
    r._readbackInFlight = false;
    r.frameCount = 0;
    r.lastDispatched = -1;
    r.blitSampler  = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    r.#createOutputTexture(canvas.width, canvas.height);

    // Compute pipelines (auto layouts — bindings declared in WGSL).
    r.projectPipeline   = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'project_main' } });
    r.compositePipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'composite_main' } });

    // Blit pipeline: minimal full-screen triangle that samples the storage texture.
    const blitWgsl = /* wgsl */`
      @group(0) @binding(0) var samp: sampler;
      @group(0) @binding(1) var tex:  texture_2d<f32>;

      struct VsOut {
        @builtin(position) pos: vec4<f32>,
        @location(0) uv: vec2<f32>,
      };

      @vertex
      fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
        // Full-screen triangle.
        var p = array<vec2<f32>, 3>(
          vec2<f32>(-1.0, -1.0),
          vec2<f32>( 3.0, -1.0),
          vec2<f32>(-1.0,  3.0),
        );
        var o: VsOut;
        o.pos = vec4<f32>(p[i], 0.0, 1.0);
        o.uv  = vec2<f32>((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
        return o;
      }

      @fragment
      fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
        return textureSample(tex, samp, in.uv);
      }
    `;
    const blitMod = device.createShaderModule({ code: blitWgsl, label: 'blit' });
    r.blitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module: blitMod, entryPoint: 'vs_main' },
      fragment: { module: blitMod, entryPoint: 'fs_main', targets: [{ format: r.format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
      primitive: { topology: 'triangle-list' },
    });

    return r;
  }

  setAdapter(adapter) { this.adapter = adapter; }

  setCamera(viewMat, projMat) {
    this.viewMat = viewMat;
    this.projMat = projMat;
  }

  resize(w, h) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w; this.canvas.height = h;
    this.outputTex?.destroy();
    this.#createOutputTexture(w, h);
  }

  render(t) {
    if (!this.adapter) return;
    this.frameCount++;
    const { device, ctx } = this;

    // Camera UBO upload.
    const ubo = new ArrayBuffer(CAMERA_UBO_BYTES);
    const f32 = new Float32Array(ubo);
    const u32 = new Uint32Array(ubo);
    const view = this.viewMat;
    const proj = this.projMat;
    const vp = mul4(proj, view);
    const invView = invert4(view);
    f32.set(view, 0);
    f32.set(proj, 16);
    f32.set(vp, 32);
    f32.set(invView, 48);
    f32[64] = this.canvas.width;            // viewport.x
    f32[65] = this.canvas.height;           // viewport.y
    // Focal length in pixels for a vertical FoV. Standard formula: fy = h / (2 * tan(fov/2)).
    // We extract it from the proj matrix: proj[1][1] = 1/tan(fov/2). So fy = h * proj[1][1] / 2.
    f32[66] = (this.canvas.width  * proj[0]) * 0.5;   // fx
    f32[67] = (this.canvas.height * proj[5]) * 0.5;   // fy
    f32[68] = 0.1;                          // near
    u32[69] = this.adapter.splatCount;      // splat_count
    device.queue.writeBuffer(this.cameraBuf, 0, ubo);

    // Reset draw counter to 0.
    device.queue.writeBuffer(this.counterBuf, 0, new Uint32Array([0]));

    // Bind groups (rebuilt per frame because adapter buffer can change on hot-swap).
    const projectBg = device.createBindGroup({
      layout: this.projectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.adapter.splatBuffer } },
        { binding: 1, resource: { buffer: this.projectedBuf } },
        { binding: 2, resource: { buffer: this.counterBuf } },
        { binding: 3, resource: { buffer: this.cameraBuf } },
      ],
    });
    const compositeBg = device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 4, resource: { buffer: this.projectedBuf } },
        { binding: 5, resource: { buffer: this.counterBuf } },
        { binding: 6, resource: { buffer: this.cameraBuf } },
        { binding: 7, resource: this.outputTex.createView() },
      ],
    });
    const blitBg = device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.blitSampler },
        { binding: 1, resource: this.outputTex.createView() },
      ],
    });

    const encoder = device.createCommandEncoder({ label: 'fused-splat' });

    // 1) Adapter writes splats (e.g. wiggle pass).
    this.adapter.update?.(device, encoder, t);

    // 2) Pass A: project + cull.
    {
      const pass = encoder.beginComputePass({ label: 'project' });
      pass.setPipeline(this.projectPipeline);
      pass.setBindGroup(0, projectBg);
      const wgCount = Math.ceil(this.adapter.splatCount / 64);
      this.lastDispatched = wgCount;
      pass.dispatchWorkgroups(wgCount);
      pass.end();
    }

    // 3) Clear output texture by overwriting (storage texture writes overwrite).
    //    Pass B: fused tile composite.
    {
      const tw = Math.ceil(this.canvas.width  / 16);
      const th = Math.ceil(this.canvas.height / 16);
      const pass = encoder.beginComputePass({ label: 'composite' });
      pass.setPipeline(this.compositePipeline);
      pass.setBindGroup(0, compositeBg);
      pass.dispatchWorkgroups(tw, th, 1);
      pass.end();
    }

    // 4) Blit to canvas.
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear', storeOp: 'store',
        }],
      });
      pass.setPipeline(this.blitPipeline);
      pass.setBindGroup(0, blitBg);
      pass.draw(3);
      pass.end();
    }

    // Optional debug readback of the projected counter.
    if (!this._readbackInFlight) {
      const rbEnc = device.createCommandEncoder({ label: 'rb' });
      rbEnc.copyBufferToBuffer(this.counterBuf, 0, this.counterReadback, 0, 4);
      device.queue.submit([encoder.finish(), rbEnc.finish()]);
      this._readbackInFlight = true;
      this.counterReadback.mapAsync(GPUMapMode.READ).then(() => {
        this.lastProjectedCount = new Uint32Array(this.counterReadback.getMappedRange().slice(0))[0];
        this.counterReadback.unmap();
        this._readbackInFlight = false;
      }).catch(() => { this._readbackInFlight = false; });
    } else {
      device.queue.submit([encoder.finish()]);
    }
  }

  #createOutputTexture(w, h) {
    this.outputTex = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
  }
}

// ============================================================================
// Tiny mat4 helpers — column-major, column-vector convention (mul: M*v).
// Floats laid out as [c0r0, c0r1, c0r2, c0r3, c1r0, ..., c3r3].
// ============================================================================

export function identity4() {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
}

export function perspective4(fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0]  = f / aspect;
  m[5]  = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

export function lookAt4(eye, target, up) {
  const z = norm3(sub3(eye, target));
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  const m = new Float32Array(16);
  m[0]  = x[0]; m[1]  = y[0]; m[2]  = z[0]; m[3]  = 0;
  m[4]  = x[1]; m[5]  = y[1]; m[6]  = z[1]; m[7]  = 0;
  m[8]  = x[2]; m[9]  = y[2]; m[10] = z[2]; m[11] = 0;
  m[12] = -dot3(x, eye);
  m[13] = -dot3(y, eye);
  m[14] = -dot3(z, eye);
  m[15] = 1;
  return m;
}

export function mul4(a, b) {
  const m = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    m[i*4 + j] =
      a[0*4 + j] * b[i*4 + 0] +
      a[1*4 + j] * b[i*4 + 1] +
      a[2*4 + j] * b[i*4 + 2] +
      a[3*4 + j] * b[i*4 + 3];
  }
  return m;
}

// 4x4 matrix inverse (general).
export function invert4(m) {
  const inv = new Float32Array(16);
  inv[0] = m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15] - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14] + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15] + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14] - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15] - m[1]*m[7]*m[14] - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7] - m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15] + m[0]*m[7]*m[14] + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7] + m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15] - m[0]*m[7]*m[13] - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7] - m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14] + m[0]*m[6]*m[13] + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6] + m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11] + m[1]*m[7]*m[10] + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7] + m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11] - m[0]*m[7]*m[10] - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7] - m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11] + m[0]*m[7]*m[9] + m[4]*m[1]*m[11] - m[4]*m[3]*m[9] - m[8]*m[1]*m[7] + m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10] - m[0]*m[6]*m[9] - m[4]*m[1]*m[10] + m[4]*m[2]*m[9] + m[8]*m[1]*m[6] - m[8]*m[2]*m[5];
  let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  if (det === 0) return identity4();
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}

const sub3  = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const dot3  = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
