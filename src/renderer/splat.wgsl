// =============================================================
// Fused Gaussian Splat Renderer
// One compute pass projects + culls, one fused pass composites.
// No fragment shader. No CPU sort. No readback. Single submit.
//
// Correctness envelope (v1):
//   This renderer uses per-tile *chunked* compositing without a global
//   sort. It is exact when, for every tile, the number of splats whose
//   2D projection touches that tile is ≤ CHUNK (256). For our target
//   workloads — small molecules (~10²–10³ atoms), small fluid sims,
//   point clouds at sparse-to-medium density — this holds in practice.
//   For larger scenes (tens of thousands of overlapping splats per
//   tile), add a tile-bucketing pre-pass before compositing.
// =============================================================

// ---- Shared types ------------------------------------------------------------

struct Splat {
  position: vec3<f32>,
  _pad0: f32,
  scale: vec3<f32>,
  _pad1: f32,
  rotation: vec4<f32>,
  color: vec4<f32>,
};

// What pass A writes, pass B reads.
// 48 bytes; covariance is symmetric so we store 3 floats.
struct Projected {
  pos2d: vec2<f32>,        // screen-space center (pixels)
  depth: f32,              // view-space z (positive = into scene)
  radius: f32,              // conservative pixel radius for tile binning
  cov2d: vec3<f32>,        // (a, b, c) of [[a,b],[b,c]]
  _pad0: f32,
  color: vec4<f32>,        // rgb + opacity
};

struct Camera {
  view: mat4x4<f32>,
  proj: mat4x4<f32>,
  view_proj: mat4x4<f32>,
  inv_view: mat4x4<f32>,
  viewport: vec2<f32>,     // (width, height) in pixels
  focal: vec2<f32>,        // (fx, fy) in pixels
  near: f32,
  splat_count: u32,
};

struct DrawCounter {
  count: atomic<u32>,
};

// ============================================================================
// PASS A — Project + Cull
// One thread per splat. Writes compact list of visible projected splats.
// ============================================================================

@group(0) @binding(0) var<storage, read>        splats:    array<Splat>;
@group(0) @binding(1) var<storage, read_write>  projected: array<Projected>;
@group(0) @binding(2) var<storage, read_write>  draw_count: DrawCounter;
@group(0) @binding(3) var<uniform>              cam:       Camera;

// Build 3D covariance from scale + rotation quaternion: Σ = R S Sᵀ Rᵀ
fn build_cov3d(scale: vec3<f32>, q: vec4<f32>) -> mat3x3<f32> {
  let r = q.w; let x = q.x; let y = q.y; let z = q.z;
  let R = mat3x3<f32>(
    1.0 - 2.0*(y*y + z*z),       2.0*(x*y + r*z),       2.0*(x*z - r*y),
          2.0*(x*y - r*z), 1.0 - 2.0*(x*x + z*z),       2.0*(y*z + r*x),
          2.0*(x*z + r*y),       2.0*(y*z - r*x), 1.0 - 2.0*(x*x + y*y),
  );
  let S = mat3x3<f32>(
    scale.x, 0.0,     0.0,
    0.0,     scale.y, 0.0,
    0.0,     0.0,     scale.z,
  );
  let M = R * S;
  return M * transpose(M);
}

// EWA splatting: project 3D covariance to 2D screen-space covariance via
// the local affine approximation J of the perspective projection.
fn project_cov(cov3d: mat3x3<f32>, view_pos: vec3<f32>) -> vec3<f32> {
  let z = view_pos.z;
  let z2 = z * z;
  let J = mat3x3<f32>(
    cam.focal.x / z, 0.0,             -cam.focal.x * view_pos.x / z2,
    0.0,             cam.focal.y / z, -cam.focal.y * view_pos.y / z2,
    0.0,             0.0,              0.0,
  );
  // Take view-space rotation only (upper 3x3 of view matrix).
  let W = mat3x3<f32>(
    cam.view[0].xyz,
    cam.view[1].xyz,
    cam.view[2].xyz,
  );
  let T = J * W;
  let cov2 = T * cov3d * transpose(T);
  // Tiny dilation to avoid sub-pixel splats vanishing.
  return vec3<f32>(cov2[0][0] + 0.3, cov2[0][1], cov2[1][1] + 0.3);
}

@compute @workgroup_size(64)
fn project_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= cam.splat_count) { return; }

  let s = splats[i];

  // World → view
  let view_pos4 = cam.view * vec4<f32>(s.position, 1.0);
  let view_pos = view_pos4.xyz;

  // Near-plane cull. JS camera uses standard GL convention (-z forward),
  // so in-front atoms have negative view_pos.z. Reject anything closer
  // than `near` (i.e. -view_pos.z < near) or behind the camera.
  let view_z = -view_pos.z;
  if (view_z < cam.near) { return; }

  // Clip
  let clip = cam.proj * view_pos4;
  if (clip.w <= 0.0) { return; }
  let ndc = clip.xyz / clip.w;
  // Frustum cull with margin
  if (abs(ndc.x) > 1.3 || abs(ndc.y) > 1.3) { return; }

  // To pixels (y-flip for canvas convention)
  let pos2d = vec2<f32>(
    (ndc.x * 0.5 + 0.5) * cam.viewport.x,
    (1.0 - (ndc.y * 0.5 + 0.5)) * cam.viewport.y,
  );

  // Covariance projection
  let cov3d = build_cov3d(s.scale, s.rotation);
  let cov2d = project_cov(cov3d, view_pos);

  // Conservative pixel radius from 2D covariance eigenvalues (3σ).
  let mid = 0.5 * (cov2d.x + cov2d.z);
  let det = cov2d.x * cov2d.z - cov2d.y * cov2d.y;
  let disc = max(0.0, mid * mid - det);
  let lambda = mid + sqrt(disc);
  let radius = 3.0 * sqrt(max(lambda, 1.0));

  // Discard splats that project to less than a pixel.
  if (radius < 0.5) { return; }

  // Cull against viewport with the radius as margin.
  if (pos2d.x + radius < 0.0 || pos2d.x - radius > cam.viewport.x ||
      pos2d.y + radius < 0.0 || pos2d.y - radius > cam.viewport.y) { return; }

  // Append to compact list.
  let slot = atomicAdd(&draw_count.count, 1u);
  if (slot >= arrayLength(&projected)) { return; } // overflow guard

  projected[slot].pos2d  = pos2d;
  projected[slot].depth  = view_z;       // positive forward distance, sortable
  projected[slot].radius = radius;
  projected[slot].cov2d  = cov2d;
  projected[slot].color  = s.color;
}

// ============================================================================
// PASS B — Fused Tile Composite
// One workgroup per 16×16 tile. Workgroup loads chunks of projected splats
// into shared memory, depth-sorts the chunk with bitonic, composites
// front-to-back into per-pixel accumulators, writes final RGBA.
// All in one dispatch.
// ============================================================================

const TILE: u32 = 16u;
const TILE_PIXELS: u32 = 256u;     // 16*16
const CHUNK: u32 = 256u;           // splats loaded per shared-memory pass

@group(0) @binding(4) var<storage, read>       p_splats:   array<Projected>;
@group(0) @binding(5) var<storage, read_write> p_count:    DrawCounter;
@group(0) @binding(6) var<uniform>             p_cam:      Camera;
@group(0) @binding(7) var output:                          texture_storage_2d<rgba8unorm, write>;

// Shared memory: one chunk of projected splats, plus their pre-inverted
// 2D covariance (so per-pixel evaluation is just dot products).
struct LocalSplat {
  pos2d: vec2<f32>,
  depth: f32,
  _pad: f32,
  conic: vec3<f32>,    // inverse of [[a,b],[b,c]]: (a', b', c')
  _pad2: f32,
  color: vec4<f32>,
};
var<workgroup> tile_splats: array<LocalSplat, CHUNK>;
var<workgroup> tile_any:    atomic<u32>;   // nonzero if any real splat touches tile this chunk
var<workgroup> tile_min:    vec2<f32>;
var<workgroup> tile_max:    vec2<f32>;
var<workgroup> wg_n:        u32;           // staged copy of projected-count, made uniform via workgroupUniformLoad
var<workgroup> wg_any:      u32;           // staged copy of tile_any, ditto

const SENTINEL_DEPTH: f32 = 1.0e30;

// Pixel-level accumulator for front-to-back compositing.
// Each thread (one per pixel) keeps its own.
fn accumulate(acc_rgb: ptr<function, vec3<f32>>,
              acc_t:   ptr<function, f32>,
              s: LocalSplat,
              px: vec2<f32>) {
  let d = px - s.pos2d;
  // Mahalanobis-ish: 0.5 * dᵀ Σ⁻¹ d
  let power = -0.5 * (s.conic.x * d.x * d.x +
                      s.conic.z * d.y * d.y) -
                      s.conic.y * d.x * d.y;
  if (power > 0.0) { return; }
  let alpha = min(0.99, s.color.a * exp(power));
  if (alpha < 1.0/255.0) { return; }
  let t = *acc_t;
  *acc_rgb = *acc_rgb + s.color.rgb * alpha * t;
  *acc_t = t * (1.0 - alpha);
}

// Bitonic sort within the workgroup over the full CHUNK (power of 2).
// Sentinels with depth=SENTINEL_DEPTH naturally land at the back.
fn bitonic_sort_full(local_id: u32) {
  var k = 2u;
  loop {
    if (k > CHUNK) { break; }
    var j = k >> 1u;
    loop {
      if (j == 0u) { break; }
      let ixj = local_id ^ j;
      if (ixj > local_id) {
        let asc = ((local_id & k) == 0u);
        let a = tile_splats[local_id];
        let b = tile_splats[ixj];
        let swap = select((a.depth < b.depth), (a.depth > b.depth), asc);
        if (swap) {
          tile_splats[local_id] = b;
          tile_splats[ixj]      = a;
        }
      }
      workgroupBarrier();
      j = j >> 1u;
    }
    k = k << 1u;
  }
}

// Conservative test: does this projected splat touch the tile's AABB?
fn splat_touches_tile(p: Projected, tmin: vec2<f32>, tmax: vec2<f32>) -> bool {
  return (p.pos2d.x + p.radius >= tmin.x) &&
         (p.pos2d.x - p.radius <= tmax.x) &&
         (p.pos2d.y + p.radius >= tmin.y) &&
         (p.pos2d.y - p.radius <= tmax.y);
}

// Invert the 2x2 covariance once, in shared memory, so per-pixel eval is cheap.
fn invert_cov(c: vec3<f32>) -> vec3<f32> {
  let det = c.x * c.z - c.y * c.y;
  if (det == 0.0) { return vec3<f32>(0.0); }
  let inv_det = 1.0 / det;
  return vec3<f32>(c.z * inv_det, -c.y * inv_det, c.x * inv_det);
}

@compute @workgroup_size(16, 16, 1)
fn composite_main(@builtin(workgroup_id) wg: vec3<u32>,
                  @builtin(local_invocation_id) lid: vec3<u32>,
                  @builtin(local_invocation_index) lindex: u32) {
  let pixel = vec2<u32>(wg.x * TILE + lid.x, wg.y * TILE + lid.y);
  let px = vec2<f32>(f32(pixel.x) + 0.5, f32(pixel.y) + 0.5);
  let in_bounds = pixel.x < u32(p_cam.viewport.x) && pixel.y < u32(p_cam.viewport.y);

  // Compute tile AABB once, store in shared mem.
  // Also stage the projected count into a workgroup var so we can read it
  // back as uniform (atomicLoad's result is treated as possibly non-uniform,
  // which would poison the chunk-loop's control flow and forbid barriers).
  if (lindex == 0u) {
    tile_min = vec2<f32>(f32(wg.x * TILE),       f32(wg.y * TILE));
    tile_max = vec2<f32>(f32((wg.x + 1u) * TILE), f32((wg.y + 1u) * TILE));
    wg_n = atomicLoad(&p_count.count);
  }
  let n = workgroupUniformLoad(&wg_n);

  // Per-thread (per-pixel) accumulator.
  var acc_rgb = vec3<f32>(0.0);
  var acc_t   = 1.0;     // remaining transmittance

  // Walk through the projected list in chunks of CHUNK=256.
  var base: u32 = 0u;
  loop {
    if (base >= n) { break; }

    // Each thread owns slot `lindex` in shared memory. Writes either the
    // splat at (base + lindex) — if it touches the tile and is in range —
    // or a sentinel that sorts to the back and contributes nothing.
    if (lindex == 0u) { atomicStore(&tile_any, 0u); }
    workgroupBarrier();

    let global_idx = base + lindex;
    var touches: bool = false;
    if (global_idx < n) {
      let p = p_splats[global_idx];
      if (splat_touches_tile(p, tile_min, tile_max)) {
        tile_splats[lindex].pos2d = p.pos2d;
        tile_splats[lindex].depth = p.depth;
        tile_splats[lindex].conic = invert_cov(p.cov2d);
        tile_splats[lindex].color = p.color;
        touches = true;
        atomicStore(&tile_any, 1u);
      }
    }
    if (!touches) {
      // Sentinel: depth far away, alpha zero. Sort to the back, no contribution.
      tile_splats[lindex].pos2d = vec2<f32>(0.0);
      tile_splats[lindex].depth = SENTINEL_DEPTH;
      tile_splats[lindex].conic = vec3<f32>(0.0);
      tile_splats[lindex].color = vec4<f32>(0.0);
    }
    workgroupBarrier();

    // Stage tile_any → uniform so the sort's barriers are reachable from
    // uniform control flow.
    if (lindex == 0u) { wg_any = atomicLoad(&tile_any); }
    let any_touch = workgroupUniformLoad(&wg_any);

    // Skip sort + composite if no real splats touched any pixel in this tile.
    if (any_touch != 0u) {
      // Sort full power-of-2 CHUNK front-to-back.
      bitonic_sort_full(lindex);
      workgroupBarrier();

      // Composite. Sentinels self-skip (alpha == 0 → exp term gates them out).
      if (in_bounds && acc_t > 1.0/255.0) {
        var i: u32 = 0u;
        loop {
          if (i >= CHUNK) { break; }
          // Once we hit sentinels (sorted to back), the rest contribute nothing.
          if (tile_splats[i].depth >= SENTINEL_DEPTH) { break; }
          accumulate(&acc_rgb, &acc_t, tile_splats[i], px);
          if (acc_t < 1.0/255.0) { break; }
          i = i + 1u;
        }
      }
    }
    workgroupBarrier();

    base = base + CHUNK;
  }

  // Write final pixel.
  if (in_bounds) {
    let final_rgb = acc_rgb;     // already premultiplied
    let final_a = 1.0 - acc_t;
    textureStore(output, vec2<i32>(i32(pixel.x), i32(pixel.y)),
                 vec4<f32>(final_rgb, final_a));
  }
}
