'use strict';
/* ============================================================
   Apex Drive — procedural geometry
   All builders return { pos, nrm, uv, idx, radius }
   ============================================================ */

class Geo {
  constructor() { this.p = []; this.n = []; this.t = []; this.i = []; }
  get vcount() { return this.p.length / 3; }
  v(x, y, z, nx, ny, nz, u, vv) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.t.push(u, vv);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  /* append another Geo, transformed by a 4x4 */
  append(g, m) {
    const base = this.vcount;
    const nm = M4.invert(M4.n(), m); M4.transpose(nm, nm);
    const tp = [0, 0, 0], tn = [0, 0, 0];
    for (let k = 0; k < g.p.length; k += 3) {
      tp[0] = g.p[k]; tp[1] = g.p[k + 1]; tp[2] = g.p[k + 2];
      M4.xform(tp, m, tp);
      tn[0] = g.n[k]; tn[1] = g.n[k + 1]; tn[2] = g.n[k + 2];
      M4.xformDir(tn, nm, tn);
      const l = Math.hypot(tn[0], tn[1], tn[2]) || 1;
      this.p.push(tp[0], tp[1], tp[2]);
      this.n.push(tn[0] / l, tn[1] / l, tn[2] / l);
    }
    for (let k = 0; k < g.t.length; k++) this.t.push(g.t[k]);
    for (let k = 0; k < g.i.length; k++) this.i.push(g.i[k] + base);
    return this;
  }
  /* make every triangle wind consistently with its shading normal, so
     back-face culling keeps the outward side */
  fixWinding() {
    const p = this.p, n = this.n, idx = this.i;
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      const sx = n[a] + n[b] + n[c], sy = n[a + 1] + n[b + 1] + n[c + 1], sz = n[a + 2] + n[b + 2] + n[c + 2];
      if (gx * sx + gy * sy + gz * sz < 0) {
        const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t;
      }
    }
    return this;
  }
  done() {
    this.fixWinding();
    let r = 0;
    for (let k = 0; k < this.p.length; k += 3) {
      const d = this.p[k] * this.p[k] + this.p[k + 1] * this.p[k + 1] + this.p[k + 2] * this.p[k + 2];
      if (d > r) r = d;
    }
    return { pos: new Float32Array(this.p), nrm: new Float32Array(this.n), uv: new Float32Array(this.t), idx: this.i, radius: Math.sqrt(r) };
  }
  /* recompute smooth normals from faces */
  smooth() {
    const n = new Float32Array(this.p.length);
    for (let k = 0; k < this.i.length; k += 3) {
      const a = this.i[k] * 3, b = this.i[k + 1] * 3, c = this.i[k + 2] * 3;
      const ux = this.p[b] - this.p[a], uy = this.p[b + 1] - this.p[a + 1], uz = this.p[b + 2] - this.p[a + 2];
      const vx = this.p[c] - this.p[a], vy = this.p[c + 1] - this.p[a + 1], vz = this.p[c + 2] - this.p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    for (let k = 0; k < n.length; k += 3) {
      const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      this.n[k] = n[k] / l; this.n[k + 1] = n[k + 1] / l; this.n[k + 2] = n[k + 2] / l;
    }
    return this;
  }
}

/* ---------------- primitives ---------------- */
function geoBox(w = 1, h = 1, d = 1, uvScale = 1) {
  const g = new Geo();
  const x = w / 2, y = h / 2, z = d / 2;
  const faces = [
    [[x, -y, -z], [x, -y, z], [x, y, z], [x, y, -z], [1, 0, 0], d, h],
    [[-x, -y, z], [-x, -y, -z], [-x, y, -z], [-x, y, z], [-1, 0, 0], d, h],
    [[-x, y, -z], [x, y, -z], [x, y, z], [-x, y, z], [0, 1, 0], w, d],
    [[-x, -y, z], [x, -y, z], [x, -y, -z], [-x, -y, -z], [0, -1, 0], w, d],
    [[-x, -y, z], [-x, y, z], [x, y, z], [x, -y, z], [0, 0, 1], w, h],
    [[x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, -z], [0, 0, -1], w, h],
  ];
  for (const f of faces) {
    const n = f[4], su = f[5] * uvScale, sv = f[6] * uvScale;
    const a = g.v(f[0][0], f[0][1], f[0][2], n[0], n[1], n[2], 0, 0);
    const b = g.v(f[1][0], f[1][1], f[1][2], n[0], n[1], n[2], su, 0);
    const c = g.v(f[2][0], f[2][1], f[2][2], n[0], n[1], n[2], su, sv);
    const dd = g.v(f[3][0], f[3][1], f[3][2], n[0], n[1], n[2], 0, sv);
    g.quad(a, b, c, dd);
  }
  return g;
}

function geoPlane(w = 1, d = 1, uvScale = 1, segs = 1) {
  const g = new Geo();
  for (let j = 0; j <= segs; j++) for (let i = 0; i <= segs; i++) {
    const u = i / segs, v = j / segs;
    g.v((u - .5) * w, 0, (v - .5) * d, 0, 1, 0, u * w * uvScale, v * d * uvScale);
  }
  for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) {
    const a = j * (segs + 1) + i;
    g.quad(a, a + segs + 1, a + segs + 2, a + 1);
  }
  return g;
}

/* cylinder along +Y, radius 1 (top) & 1 (bottom), height 1, centred */
function geoCyl(rTop = 1, rBot = 1, h = 1, seg = 20, caps = true, smoothN = true) {
  const g = new Geo();
  const y0 = -h / 2, y1 = h / 2;
  const slope = (rBot - rTop) / h;
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * TAU, c = Math.cos(a), s = Math.sin(a);
    const nl = Math.hypot(1, slope);
    g.v(c * rBot, y0, s * rBot, c / nl, slope / nl, s / nl, i / seg, 0);
    g.v(c * rTop, y1, s * rTop, c / nl, slope / nl, s / nl, i / seg, 1);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    g.quad(a, a + 2, a + 3, a + 1);
  }
  if (caps) {
    let ct = g.v(0, y1, 0, 0, 1, 0, .5, .5);
    for (let i = 0; i <= seg; i++) { const a = i / seg * TAU; g.v(Math.cos(a) * rTop, y1, Math.sin(a) * rTop, 0, 1, 0, .5 + Math.cos(a) * .5, .5 + Math.sin(a) * .5); }
    for (let i = 0; i < seg; i++) g.tri(ct, ct + 1 + i, ct + 2 + i);
    let cb = g.v(0, y0, 0, 0, -1, 0, .5, .5);
    for (let i = 0; i <= seg; i++) { const a = i / seg * TAU; g.v(Math.cos(a) * rBot, y0, Math.sin(a) * rBot, 0, -1, 0, .5 + Math.cos(a) * .5, .5 + Math.sin(a) * .5); }
    for (let i = 0; i < seg; i++) g.tri(cb, cb + 2 + i, cb + 1 + i);
  }
  return g;
}

function geoSphere(r = 1, seg = 18, rings = 12) {
  const g = new Geo();
  for (let j = 0; j <= rings; j++) {
    const v = j / rings, phi = v * PI, sp = Math.sin(phi), cp = Math.cos(phi);
    for (let i = 0; i <= seg; i++) {
      const u = i / seg, th = u * TAU, st = Math.sin(th), ct = Math.cos(th);
      const x = sp * ct, y = cp, z = sp * st;
      g.v(x * r, y * r, z * r, x, y, z, u, v);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i;
    g.quad(a, a + seg + 1, a + seg + 2, a + 1);
  }
  return g;
}

function geoCone(r = 1, h = 1, seg = 14) { return geoCyl(0.001, r, h, seg, true); }

function geoTorus(R = 1, r = .2, seg = 30, sides = 12) {
  const g = new Geo();
  for (let i = 0; i <= seg; i++) {
    const u = i / seg * TAU, cu = Math.cos(u), su = Math.sin(u);
    for (let j = 0; j <= sides; j++) {
      const v = j / sides * TAU, cv = Math.cos(v), sv = Math.sin(v);
      const nx = cu * cv, ny = sv, nz = su * cv;
      g.v((R + r * cv) * cu, r * sv, (R + r * cv) * su, nx, ny, nz, i / seg, j / sides);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < sides; j++) {
    const a = i * (sides + 1) + j;
    g.quad(a, a + sides + 1, a + sides + 2, a + 1);
  }
  return g;
}

/* partial torus in the YZ plane (axis = X) — wheel arches, pipes */
function geoTorusArc(R, r, a0, a1, seg = 18, sides = 8) {
  const g = new Geo();
  for (let i = 0; i <= seg; i++) {
    const u = lerp(a0, a1, i / seg), cu = Math.cos(u), su = Math.sin(u);
    for (let j = 0; j <= sides; j++) {
      const v = j / sides * TAU, cv = Math.cos(v), sv = Math.sin(v);
      const ny = cu * cv, nz = su * cv, nx = sv;
      g.v(r * sv, (R + r * cv) * cu, (R + r * cv) * su, nx, ny, nz, i / seg, j / sides);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < sides; j++) {
    const a = i * (sides + 1) + j;
    g.quad(a, a + sides + 1, a + sides + 2, a + 1);
  }
  return g;
}

/* rounded box via squircle cross sections — used for props and car parts */
function geoRounded(w, h, d, r = .08, seg = 8) {
  const g = new Geo();
  const rings = seg, cols = seg * 4;
  // a radius larger than half of any dimension makes that half-extent negative,
  // which turns the box inside out and produces a huge inverted slab
  r = Math.min(r, w * .49, h * .49, d * .49);
  const hw = w / 2 - r, hh = h / 2 - r, hd = d / 2 - r;
  for (let j = 0; j <= rings; j++) {
    const v = j / rings, phi = v * PI, sp = Math.sin(phi), cp = Math.cos(phi);
    for (let i = 0; i <= cols; i++) {
      const u = i / cols, th = u * TAU, st = Math.sin(th), ct = Math.cos(th);
      const nx = sp * ct, ny = cp, nz = sp * st;
      // push the unit sphere out onto the box's flat faces
      const px = nx * r + Math.sign(nx) * hw * Math.min(1, Math.abs(nx) * 2.6);
      const py = ny * r + Math.sign(ny) * hh * Math.min(1, Math.abs(ny) * 2.6);
      const pz = nz * r + Math.sign(nz) * hd * Math.min(1, Math.abs(nz) * 2.6);
      g.v(px, py, pz, nx, ny, nz, u, v);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < cols; i++) {
    const a = j * (cols + 1) + i;
    g.quad(a, a + cols + 1, a + cols + 2, a + 1);
  }
  return g;
}

/* ---------------- spline helpers ---------------- */
function catmull(pts, t) {
  const n = pts.length - 1;
  const x = clamp(t, 0, 1) * n;
  let i = Math.min(Math.floor(x), n - 1);
  const f = x - i;
  const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, n)];
  const f2 = f * f, f3 = f2 * f;
  return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
}

/* squircle outline: half-width a, half-height b, exponent e, top taper */
function squircle(a, b, e, n, taperTop, taperBot) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / n * TAU;
    const c = Math.cos(t), s = Math.sin(t);
    const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / e) * a;
    const y = Math.sign(s) * Math.pow(Math.abs(s), 2 / e) * b;
    const ty = clamp01((y / b) * .5 + .5);
    const k = lerp(1 - taperBot, 1, ty) * lerp(1, 1 - taperTop, ty);
    pts.push([x * k, y]);
  }
  return pts;
}

/* Loft a closed outline along Z. stations = [{z, pts:[[x,y],..]}] (same length) */
function loft(stations, capFront, capBack, uvScale = 1) {
  const g = new Geo();
  const N = stations[0].pts.length;
  const rows = [];
  for (let s = 0; s < stations.length; s++) {
    const st = stations[s];
    const row = [];
    for (let i = 0; i < N; i++) {
      row.push(g.v(st.pts[i][0], st.pts[i][1], st.z, 0, 0, 0, i / N * uvScale, s / (stations.length - 1) * uvScale));
    }
    rows.push(row);
  }
  for (let s = 0; s < stations.length - 1; s++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      g.quad(rows[s][i], rows[s][j], rows[s + 1][j], rows[s + 1][i]);
    }
  }
  const cap = (row, st, flip) => {
    let cx = 0, cy = 0;
    for (const p of st.pts) { cx += p[0]; cy += p[1]; }
    cx /= N; cy /= N;
    const c = g.v(cx, cy, st.z, 0, 0, flip ? -1 : 1, .5, .5);
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      if (flip) g.tri(c, row[i], row[j]); else g.tri(c, row[j], row[i]);
    }
  };
  if (capBack) cap(rows[0], stations[0], true);
  if (capFront) cap(rows[rows.length - 1], stations[stations.length - 1], false);
  g.smooth();
  return g;
}

/* an arch / gate ring used for checkpoints */
function geoArch(w, h, thick) {
  const g = new Geo();
  const seg = 26;
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const a = PI * t;
    pts.push([-Math.cos(a) * w * .5, Math.sin(a) * h]);
  }
  for (let i = 0; i < seg; i++) {
    const p0 = pts[i], p1 = pts[i + 1];
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    const m = M4.n();
    const cx = (p0[0] + p1[0]) / 2, cy = (p0[1] + p1[1]) / 2;
    const ang = Math.atan2(dy, dx);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    m[0] = ca; m[1] = sa; m[4] = -sa; m[5] = ca; m[12] = cx; m[13] = cy;
    g.append(geoBox(l * 1.05, thick, thick), m);
  }
  return g;
}
