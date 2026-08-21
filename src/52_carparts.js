'use strict';
/* ============================================================
   Apex Drive — reusable car sub-geometry
   ============================================================ */

/* Wheel hubs are authored so the body origin sits at road level when the
   suspension is at its static equilibrium, so car geometry is authored
   directly in metres above the road and needs no extra shift. */
const CAR_SAG = 0;

/* lathe a 2D profile [[radius, axialX], ...] around the X axis */
function geoLatheX(profile, seg = 24, closed = false) {
  const g = new Geo();
  const rows = [];
  for (let p = 0; p < profile.length; p++) {
    const r = profile[p][0], x = profile[p][1];
    const row = [];
    for (let i = 0; i <= seg; i++) {
      const a = i / seg * TAU;
      row.push(g.v(x, Math.sin(a) * r, Math.cos(a) * r, 0, Math.sin(a), Math.cos(a), i / seg, p / (profile.length - 1)));
    }
    rows.push(row);
  }
  for (let p = 0; p < profile.length - 1; p++)
    for (let i = 0; i < seg; i++)
      g.quad(rows[p][i], rows[p][i + 1], rows[p + 1][i + 1], rows[p + 1][i]);
  if (closed) {
    const capA = g.v(profile[0][1], 0, 0, -1, 0, 0, .5, .5);
    for (let i = 0; i < seg; i++) g.tri(capA, rows[0][i + 1], rows[0][i]);
    const L = profile.length - 1;
    const capB = g.v(profile[L][1], 0, 0, 1, 0, 0, .5, .5);
    for (let i = 0; i < seg; i++) g.tri(capB, rows[L][i], rows[L][i + 1]);
  }
  g.smooth();
  return g;
}

/* An arch swept about the X axis: rectangular cross-section tube from
   angle a0 to a1 (measured in the YZ plane, 0 = +Z, PI/2 = +Y).
   Used for wheel-arch flares and inner wheel wells. */
function geoArch3(R, halfW, thick, a0, a1, seg = 16, taper = 0) {
  const g = new Geo();
  const rows = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const a = lerp(a0, a1, t);
    const ca = Math.cos(a), sa = Math.sin(a);
    // cross-section corners: (outerR/innerR) x (+halfW/-halfW)
    const rIn = R, rOut = R + thick;
    const hw = halfW * (1 - taper * Math.abs(t * 2 - 1));
    const pts = [
      [-hw, rOut], [hw, rOut], [hw, rIn], [-hw, rIn]
    ];
    const row = [];
    for (const [x, r] of pts) row.push(g.v(x, sa * r, ca * r, 0, 0, 0, t, 0));
    rows.push(row);
  }
  for (let i = 0; i < seg; i++)
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      g.quad(rows[i][k], rows[i][k2], rows[i + 1][k2], rows[i + 1][k]);
    }
  // end caps
  const cap = (row, flip) => {
    if (flip) { g.tri(row[0], row[1], row[2]); g.tri(row[0], row[2], row[3]); }
    else { g.tri(row[0], row[2], row[1]); g.tri(row[0], row[3], row[2]); }
  };
  cap(rows[0], false); cap(rows[seg], true);
  g.smooth();
  return g;
}

/* thin inset panel line — a shallow dark groove */
function geoShutline(len, height, depth) { return geoBox(depth, height, len); }

/* headlight projector cluster */
function geoProjector(r, depth, seg = 14) {
  const g = new Geo();
  g.append(geoLatheX([[r * 0.30, 0], [r * 0.92, depth * 0.45], [r, depth]], seg, true), M4.n());
  return g;
}

/* a simple honeycomb grille panel built from thin slats */
function geoGrilleMesh(w, h, d, cols = 9, rows = 4) {
  const g = new Geo();
  for (let i = 0; i < cols; i++) {
    const x = (i / (cols - 1) - .5) * w;
    g.append(geoBox(w * 0.012 + 0.008, h, d), M4.trs(M4.n(), x, 0, 0, 0, 1, 1, 1));
  }
  for (let j = 0; j < rows; j++) {
    const y = (j / (rows - 1) - .5) * h;
    g.append(geoBox(w, h * 0.05, d * 0.7), M4.trs(M4.n(), 0, y, 0, 0, 1, 1, 1));
  }
  return g;
}

/* multi-spoke wheel: barrel + spokes + lip + centre cap */
function geoRim(R, W, spokes, style) {
  const g = new Geo();
  const I = M4.n();
  const rimR = R * 0.635;
  // barrel + outer lip
  g.append(geoLatheX([
    [rimR * 0.99, -W / 2 + 0.012],
    [rimR * 1.005, -W / 2 + 0.030],
    [rimR * 0.42, -W / 2 + 0.10],
    [rimR * 0.34, W / 2 - 0.055],
    [rimR * 0.985, W / 2 - 0.030],
    [rimR * 1.01, W / 2 - 0.012],
  ], 26, true), I);
  // spokes
  for (let i = 0; i < spokes; i++) {
    const a = i / spokes * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    const m = M4.n();
    m[0] = 1; m[5] = ca; m[6] = sa; m[9] = -sa; m[10] = ca;
    m[12] = W * 0.16; m[13] = sa * rimR * 0.50; m[14] = ca * rimR * 0.50;
    const sw = style === 'mesh' ? W * 0.16 : W * 0.26;
    g.append(geoBox(sw, rimR * 0.94, rimR * (style === 'mesh' ? 0.16 : 0.26)), m);
    if (style === 'mesh') {
      const a2 = (i + 0.5) / spokes * TAU;
      const c2 = Math.cos(a2), s2 = Math.sin(a2);
      const m2 = M4.n();
      m2[0] = 1; m2[5] = c2; m2[6] = s2; m2[9] = -s2; m2[10] = c2;
      m2[12] = W * 0.20; m2[13] = s2 * rimR * 0.62; m2[14] = c2 * rimR * 0.62;
      g.append(geoBox(W * 0.12, rimR * 0.70, rimR * 0.12), m2);
    }
  }
  // centre cap + lug ring
  g.append(geoLatheX([[rimR * 0.20, W * 0.16], [rimR * 0.24, W * 0.235], [rimR * 0.09, W * 0.25]], 18, true), I);
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * TAU;
    const m = M4.n();
    m[0] = 1; m[5] = 1; m[10] = 1;
    m[12] = W * 0.20; m[13] = Math.sin(a) * rimR * 0.20; m[14] = Math.cos(a) * rimR * 0.20;
    g.append(geoBox(W * 0.06, 0.030, 0.030), m);
  }
  return g;
}

/* tyre with rounded shoulders and a sidewall step */
function geoTyre(R, W) {
  const rimR = R * 0.635;
  return geoLatheX([
    [rimR, -W / 2 + 0.005],
    [R * 0.80, -W / 2],
    [R * 0.965, -W / 2 + W * 0.13],
    [R, -W / 2 + W * 0.26],
    [R, W / 2 - W * 0.26],
    [R * 0.965, W / 2 - W * 0.13],
    [R * 0.80, W / 2],
    [rimR, W / 2 - 0.005],
  ], 28, false);
}
