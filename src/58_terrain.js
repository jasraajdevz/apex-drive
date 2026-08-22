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
    this.ringR = opts.ringR || (this.half * 1.52);
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
    this.buildRingProfile();
    this.buildConnectors();
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

  /* the raw landscape, before the motorway corridor is levelled into it */
  rawWild(x, z) { return this.wildH(x, z); },

  /* open country outside the grid */
  wildH(x, z) {
    const d = Math.hypot(x, z);
    const edge = this.half;
    let h = fbm(x * 0.00062 + 91, z * 0.00062 - 37, 4);
    h += fbm(x * 0.0021 + 5, z * 0.0021 + 11, 3) * 0.30;
    h = (h / 1.30) * 2 - 1;
    // mountains rise well beyond the ring
    const far = smoothstep(this.ringR + 120, this.ringR + 1500, d);
    let out = h * (this.amp * 1.8) + far * (h * 0.5 + 0.55) * 420;

    return out;
  },

  /* Where the motorway crosses a real valley it should be carried on a
     structure, not on half a million tonnes of fill — so the levelled
     corridor is narrowed there and the land is allowed to fall away right
     at the hard shoulder, which is what gives the viaduct piers something
     to stand on. Everywhere else the corridor stays wide and the road sits
     on a natural-looking bank. Sampled from the raw landscape, before the
     corridor has had any say in it. */
  buildRingProfile() {
    const N = 256;
    const deep = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const a = k / N * TAU;
      const roadY = this.ringHeight(a);
      let lo = 1e9;
      for (const d of [90, 120, 160]) {
        lo = Math.min(lo,
          this.rawWild(Math.cos(a) * (this.ringR + d), Math.sin(a) * (this.ringR + d)),
          this.rawWild(Math.cos(a) * (this.ringR - d), Math.sin(a) * (this.ringR - d)));
      }
      deep[k] = clamp01((roadY - lo - 22) / 16);
    }
    // widen each run outward a little so a viaduct starts before the drop
    const out = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      let m = 0;
      for (let j = -3; j <= 3; j++) m = Math.max(m, deep[(k + j + N) % N] * (1 - Math.abs(j) * 0.12));
      out[k] = m;
    }
    // the four junctions need a wide graded platform for their ramps, so they
    // never narrow the corridor however far the land beside them falls
    for (const ja of [0, PI * .5, PI, PI * 1.5]) {
      for (let k = 0; k < N; k++) {
        const a = k / N * TAU;
        out[k] *= smoothstep(240, 430, Math.abs(wrapPi(a - ja)) * this.ringR);
      }
    }
    this.ringDeep = out;
    return this;
  },
  deepAt(a) {
    if (!this.ringDeep) return 0;
    const N = this.ringDeep.length;
    let f = (a / TAU) * N;
    f = ((f % N) + N) % N;
    const i = Math.floor(f), t = f - i;
    return lerp(this.ringDeep[i], this.ringDeep[(i + 1) % N], t);
  },

  /* the ring's own gentle profile, a function of angle only */
  ringHeight(a) {
    return Math.sin(a * 2 + 0.7) * 9 + Math.sin(a * 3 - 1.9) * 5 + this.amp * 0.45;
  },

  /* the landscape before any road has been graded into it */
  baseH(x, z) {
    const e = this.half;
    // inside the grid the height must be exactly the bilinear patch, or the
    // roads laid on it stop matching the ground mesh at the city edge
    if (x > -e && x < e && z > -e && z < e) return this.cityH(x, z);
    const m = Math.max(Math.abs(x), Math.abs(z));
    const t = smoothstep(e, e + 150, m);
    return lerp(this.cityH(clamp(x, -e, e), clamp(z, -e, e)), this.wildH(x, z), t);
  },

  /* The four connector roads run dead straight out along the axes, and
     until now they were laid on whatever the raw landscape happened to be
     doing — which included a 54% gradient. The city grades its streets and
     the motorway levels its own corridor; these had nothing. Each axis now
     carries a smoothed, gradient-limited profile, pinned to the city edge
     at one end and to the motorway's height at the other, and the ground
     is graded to meet it. */
  bridgeHalf: 30,        // half the span the junction bridge covers
  bridgeRise: 7.6,       // deck height above the motorway it crosses

  buildConnectors() {
    const A = [0, PI * .5, PI, PI * 1.5];
    const r0 = this.connR0 = this.half - 10;
    const r1 = this.connR1 = this.ringR + 420;
    const n = this.connN = 128;
    const dr = (r1 - r0) / n;
    const maxStep = dr * 0.062;                    // 6.2%, a motorway link road
    this.connProf = [];
    for (let ai = 0; ai < 4; ai++) {
      const a = A[ai], ca = Math.cos(a), sa = Math.sin(a);
      const p = new Float32Array(n + 1);
      for (let k = 0; k <= n; k++) {
        const r = lerp(r0, r1, k / n);
        p[k] = this.baseH(ca * r, sa * r);
      }
      for (let pass = 0; pass < 26; pass++) {
        const q = p.slice();
        for (let k = 1; k < n; k++) p[k] = (q[k - 1] + q[k] * 2 + q[k + 1]) * .25;
      }
      /* Two heights this road does not get to choose: the city edge it
         leaves and the motorway it has to meet. Between them, start from
         the straight line joining the two — a road crosses a dip on an
         embankment, it does not dive into one and climb out — and lift the
         profile only where the ground rises above that line. Then take the
         smallest gradient-limited curve lying on or above the result, in
         one forward and one backward pass, which is exact and needs no
         iteration. Beyond the motorway it simply follows the land.

         The obvious alternative — relax toward a gradient limit while
         re-asserting the fixed ends each pass — does not converge, because
         the pin discards on every pass exactly the correction the limiter
         just made to the cell being pinned, so that one step never improves
         and all the excess gradient piles up against it. */
      const kOf = (rr) => Math.round((rr - r0) / (r1 - r0) * n);
      const kA = kOf(this.ringR - this.bridgeHalf), kB = kOf(this.ringR + this.bridgeHalf);
      const q = p.slice();
      const t0 = this.baseH(ca * r0, sa * r0);
      const deck = this.ringHeight(a) + this.bridgeRise;
      // climb to deck height by the abutment, hold it across the span
      for (let k = 0; k <= kA; k++) p[k] = Math.max(lerp(t0, deck, k / kA), q[k]);
      for (let k = 1; k <= kA; k++) p[k] = Math.max(p[k], p[k - 1] - maxStep);
      for (let k = kA - 1; k >= 0; k--) p[k] = Math.max(p[k], p[k + 1] - maxStep);
      for (let k = kA; k <= kB; k++) p[k] = deck;
      // and back down the far side, following the land where it can
      for (let k = kB + 1; k <= n; k++)
        p[k] = clamp(q[k], p[k - 1] - maxStep, p[k - 1] + maxStep);
      this.connProf.push(p);
    }
    return this;
  },
  connH(ai, r) {
    const p = this.connProf[ai], n = this.connN;
    let f = (r - this.connR0) / (this.connR1 - this.connR0) * n;
    f = clamp(f, 0, n - 1e-4);
    const i = f | 0;
    return lerp(p[i], p[i + 1], f - i);
  },

  /* Whether a graded road corridor passes near enough to matter. The
     corridors reshape the ground by tens of metres over a few dozen, which
     a terrain mesh sampling every nineteen simply cannot see — so the tiles
     they cross are built at much higher resolution instead. */
  corridorNear(x, z) {
    const d = Math.hypot(x, z);
    if (Math.abs(d - this.ringR) < this.ringW * 3.6 + 40) return true;
    const ax = Math.abs(x), az = Math.abs(z);
    const r = Math.max(ax, az), off = Math.min(ax, az);
    return off < 120 && r > this.connR0 - 40 && r < this.connR1;
  },

  h(x, z) {
    if (!this.enabled) return 0;
    let base = this.baseH(x, z);
    /* The motorway corridor is levelled last of all. Doing it inside wildH
       meant that across the seam where the city hands over to open country
       only part of the blend was flat, and the carriageway inherited metres
       of crossfall from the half that was not. Applied here it flattens
       whatever happens to be underneath. */
    const d = Math.hypot(x, z);
    const off = Math.abs(d - this.ringR);
    if (off < this.ringW * 3.4) {
      const a = Math.atan2(z, x);
      // narrow over a valley so the ground drops at the shoulder, wide over
      // open country so the road sits on a bank you would want to look at
      const outer = lerp(this.ringW * 3.2, this.ringW * 1.05, this.deepAt(a));
      const band = 1 - smoothstep(this.ringW * 0.62, outer, off);
      if (band > 0.001) base = lerp(base, this.ringHeight(a), band);
    }

    /* The connectors run along the coordinate axes, so a point is only near
       one of them when one of its two coordinates is small — which makes the
       test almost free everywhere else. The corridor stops short of the
       motorway on both sides, because there the junction's own embankment
       and bridge take over and want the untouched ground to build off. */
    if (this.connProf) {
      const ax = Math.abs(x), az = Math.abs(z);
      if (az < 90 || ax < 90) {
        const ai = az < ax ? (x > 0 ? 0 : 2) : (z > 0 ? 1 : 3);
        const r = az < ax ? ax : az;
        const off2 = az < ax ? az : ax;
        /* Held off the motorway itself, which has to stay dead level across
           its full width — between there and the foot of the ramp the road is
           up on retaining walls anyway, so the ground beneath is free to
           belong to the corridor it actually crosses. Released slowly at the
           far end, or forcing the graded profile back to raw ground puts a
           cliff where the two disagree. */
        // pinned to the untouched ground at its inner end, so it can come up
        // to full strength quickly and be flat by the time the road starts
        const gate = smoothstep(this.connR0, this.connR0 + 54, r)
          * smoothstep(this.bridgeHalf + 4, this.bridgeHalf + 44, Math.abs(r - this.ringR))
          * (1 - smoothstep(this.connR1 - 260, this.connR1, r));
        const w = (1 - smoothstep(17, 78, off2)) * clamp01(gate);
        if (w > 0.001) base = lerp(base, this.connH(ai, r), w);
      }
    }
    return base;
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
