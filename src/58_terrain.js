'use strict';
/* ============================================================
   Apex Drive — terrain

   The city sits on a height field sampled at every road intersection
   and bilinearly interpolated in between. That choice matters: along a
   cell edge a bilinear patch is exactly linear, so a road segment from
   one junction to the next is a perfect plane and can still be drawn as
   a single pitched box. Blocks get the bilinear patch, which meets the
   roads exactly at the kerb, so the kerb height never drifts.

   Outside the grid the height comes straight from fbm, with the ring
   road flattened into a corridor so the highway has a sane grade.
   ============================================================ */

const Terrain = {
  N: 0, CELL: 76, half: 0,
  nodeH: null,          // (N+1) x (N+1) heights at the intersections
  amp: 34,              // metres from the lowest valley to the highest ridge
  ringR: 0, ringW: 30,
  enabled: true,

  build(opts) {
    const N = this.N = opts.N, C = this.CELL = opts.CELL;
    this.half = opts.half;
    this.ringR = opts.ringR || (this.half + 210);
    const rnd = mulberry32((opts.seed || 1) ^ 0x5f3a);
    const W = N + 1;
    this.nodeH = new Float32Array(W * W);

    // low-frequency ridges plus a gentler second octave; wavelengths are long
    // relative to a block so the grade between neighbouring junctions stays sane
    const ox = rnd() * 900, oz = rnd() * 900;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const x = i * C - this.half, z = j * C - this.half;
        let h = 0;
        h += fbm((x + ox) * 0.00085, (z + oz) * 0.00085, 3) * 1.0;
        h += fbm((x + ox) * 0.0026, (z + oz) * 0.0026, 3) * 0.34;
        h = (h / 1.34) * 2 - 1;
        // ease the very centre flat so downtown is not built on a hillside
        const d = Math.hypot(x, z) / this.half;
        h *= smoothstep(0.10, 0.62, d) * 0.85 + 0.15;
        this.nodeH[j * W + i] = h * this.amp;
      }
    }

    // clamp the grade between neighbours so no street becomes a ski jump
    const maxStep = C * 0.055;
    for (let pass = 0; pass < 6; pass++) {
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        const id = j * W + i;
        for (const [di, dj] of [[1, 0], [0, 1]]) {
          const ni = i + di, nj = j + dj;
          if (ni > N || nj > N) continue;
          const nid = nj * W + ni;
          const d = this.nodeH[nid] - this.nodeH[id];
          if (Math.abs(d) > maxStep) {
            const fix = (Math.abs(d) - maxStep) * 0.5 * Math.sign(d);
            this.nodeH[id] += fix; this.nodeH[nid] -= fix;
          }
        }
      }
    }
    let lo = 1e9;
    for (let k = 0; k < this.nodeH.length; k++) lo = Math.min(lo, this.nodeH[k]);
    for (let k = 0; k < this.nodeH.length; k++) this.nodeH[k] -= lo;   // keep it all above zero
    return this;
  },

  nodeAt(i, j) {
    const N = this.N, W = N + 1;
    return this.nodeH[clamp(j, 0, N) * W + clamp(i, 0, N)];
  },

  /* height inside the city grid — bilinear over the cell */
  cityH(x, z) {
    const C = this.CELL, h = this.half;
    const fx = (x + h) / C, fz = (z + h) / C;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const h00 = this.nodeAt(i, j), h10 = this.nodeAt(i + 1, j);
    const h01 = this.nodeAt(i, j + 1), h11 = this.nodeAt(i + 1, j + 1);
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  },

  /* open country outside the grid, with the ring corridor levelled off */
  wildH(x, z) {
    const d = Math.hypot(x, z);
    const edge = this.half;
    let h = fbm(x * 0.00062 + 91, z * 0.00062 - 37, 4);
    h += fbm(x * 0.0021 + 5, z * 0.0021 + 11, 3) * 0.30;
    h = (h / 1.30) * 2 - 1;
    // mountains rise well beyond the ring
    const far = smoothstep(this.ringR + 120, this.ringR + 1500, d);
    let out = h * (this.amp * 1.8) + far * (h * 0.5 + 0.55) * 420;

    // flatten a corridor for the ring highway so it rolls but never climbs a cliff
    const ringBand = 1 - smoothstep(this.ringW * 0.9, this.ringW * 3.2, Math.abs(d - this.ringR));
    if (ringBand > 0.001) {
      const ringH = this.ringHeight(Math.atan2(z, x));
      out = lerp(out, ringH, ringBand);
    }
    return out;
  },

  /* the ring's own gentle profile, a function of angle only */
  ringHeight(a) {
    return Math.sin(a * 2 + 0.7) * 9 + Math.sin(a * 3 - 1.9) * 5 + this.amp * 0.45;
  },

  h(x, z) {
    if (!this.enabled) return 0;
    const e = this.half;
    // inside the grid the height must be exactly the bilinear patch, or the
    // roads laid on it stop matching the ground mesh at the city edge
    if (x > -e && x < e && z > -e && z < e) return this.cityH(x, z);
    const m = Math.max(Math.abs(x), Math.abs(z));
    const t = smoothstep(e, e + 150, m);
    return lerp(this.cityH(clamp(x, -e, e), clamp(z, -e, e)), this.wildH(x, z), t);
  },

  /* central-difference normal; the tyre model needs the contact plane */
  normal(x, z, out) {
    const d = 1.2;
    const hx = this.h(x + d, z) - this.h(x - d, z);
    const hz = this.h(x, z + d) - this.h(x, z - d);
    const nx = -hx, ny = 2 * d, nz = -hz;
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
  },

  /* dh/dx and dh/dz, used to lay flat slabs down on the slope */
  grad(x, z, out) {
    const d = 1.5;
    out[0] = (this.h(x + d, z) - this.h(x - d, z)) / (2 * d);
    out[1] = (this.h(x, z + d) - this.h(x, z - d)) / (2 * d);
    return out;
  },

  /* pitch of a box laid along a direction, for road segments */
  pitchAlong(x0, z0, x1, z1) {
    const dy = this.h(x1, z1) - this.h(x0, z0);
    const len = Math.hypot(x1 - x0, z1 - z0) || 1;
    return Math.atan2(dy, len);
  }
};

/* fbm with an octave count, kept separate from the shader-side helper */
function fbmT(x, y, oct) { return fbm(x, y, oct); }
