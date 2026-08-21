'use strict';
/* ============================================================
   Apex Drive — procedural city
   ============================================================ */

const World = {
  N: 17,            // cells per side
  CELL: 76,
  ROAD: 15,
  BLOCK: 61,
  CURB: 0.15,
  size: 0, half: 0,
  chunks: [],
  chunkCells: 3,
  colliders: [],    // {x0,z0,x1,z1,y}
  grid: null, gridCell: 40, gridN: 0,
  lights: [],       // {p:[x,y,z], col:[r,g,b], rad, kind}
  trees: [],
  spawn: { x: 0, z: 0, yaw: 0 },
  nodes: [],        // intersection nodes for AI + race routes
  signals: [],      // traffic-light heads, driven per frame
  blockInfo: [],
};

World.roadX = i => i * World.CELL - World.half;      // road centre line coordinate
World.isOnBlock = function (x, z) {
  const h = this.half, C = this.CELL, B = this.BLOCK;
  if (x < -h || x > h || z < -h || z > h) return false;
  const fx = x + h, fz = z + h;
  const cx = Math.floor(fx / C), cz = Math.floor(fz / C);
  if (cx < 0 || cz < 0 || cx >= this.N || cz >= this.N) return false;
  const lx = fx - cx * C, lz = fz - cz * C;
  const m = (C - B) * .5;   // = ROAD/2 + ... offset from cell edge to block edge
  return lx > m && lx < C - m && lz > m && lz < C - m;
};
World.groundY = function (x, z) { return this.isOnBlock(x, z) ? this.CURB : 0; };

/* --------- collider grid --------- */
World.addCollider = function (x0, z0, x1, z1, y) {
  const c = { x0, z0, x1, z1, y };
  this.colliders.push(c);
  const g = this.grid, n = this.gridN, cs = this.gridCell, h = this.half;
  const i0 = clamp(Math.floor((x0 + h) / cs), 0, n - 1), i1 = clamp(Math.floor((x1 + h) / cs), 0, n - 1);
  const j0 = clamp(Math.floor((z0 + h) / cs), 0, n - 1), j1 = clamp(Math.floor((z1 + h) / cs), 0, n - 1);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) g[j * n + i].push(c);
};
World.queryColliders = function (x, z, out) {
  out.length = 0;
  const g = this.grid, n = this.gridN, cs = this.gridCell, h = this.half;
  const i = clamp(Math.floor((x + h) / cs), 0, n - 1), j = clamp(Math.floor((z + h) / cs), 0, n - 1);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const ii = i + di, jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
    const cell = g[jj * n + ii];
    for (let k = 0; k < cell.length; k++) if (out.indexOf(cell[k]) < 0) out.push(cell[k]);
  }
  return out;
};

/* --------- instance accumulation --------- */
function Chunk(cx, cz, x0, z0, x1, z1) {
  return {
    cx, cz, x0, z0, x1, z1,
    cxm: (x0 + x1) * .5, czm: (z0 + z1) * .5,
    ex: (x1 - x0) * .5, ez: (z1 - z0) * .5, ey: 10, cym: 5,
    tmp: { box: [], cyl: [], sph: [], cone: [] },
    batches: null, count: 0
  };
}

const M_PAINT = 0, M_FACADE = 1, M_ASPHALT = 2, M_CONCRETE = 3, M_ROADPAINT = 4,
  M_EMISSIVE = 5, M_TIRE = 6, M_METAL = 7, M_GRASS = 8, M_FOLIAGE = 9,
  M_GLASSDARK = 10, M_PLASTIC = 11;

World.build = function (opts) {
  const N = this.N, C = this.CELL, B = this.BLOCK, R = this.ROAD;
  this.size = N * C; this.half = this.size / 2;
  const half = this.half;
  this.gridN = Math.ceil(this.size / this.gridCell) + 2;
  this.grid = new Array(this.gridN * this.gridN);
  for (let i = 0; i < this.grid.length; i++) this.grid[i] = [];
  this.colliders.length = 0; this.lights.length = 0; this.nodes.length = 0;
  this.chunks.length = 0; this.trees.length = 0; this.blockInfo.length = 0;
  this._lotCars = []; this._forceChunk = null; this.signals.length = 0;

  const rnd = mulberry32(opts.seed || 20260817);
  const CH = this.chunkCells, nch = Math.ceil(N / CH);
  const chunkAt = (x, z) => {
    let i = clamp(Math.floor((x + half) / (C * CH)), 0, nch - 1);
    let j = clamp(Math.floor((z + half) / (C * CH)), 0, nch - 1);
    return this.chunks[j * nch + i];
  };
  for (let j = 0; j < nch; j++) for (let i = 0; i < nch; i++) {
    this.chunks.push(Chunk(i, j, -half + i * C * CH, -half + j * C * CH,
      -half + Math.min((i + 1) * C * CH, this.size), -half + Math.min((j + 1) * C * CH, this.size)));
  }

  const tmpM = M4.n();
  /* push a scaled/rotated box */
  function box(x, y, z, sx, sy, sz, ry, col, rough, metal, emis, mat, seed) {
    const ch = World._forceChunk || chunkAt(x, z);
    M4.trs(tmpM, x, y, z, ry || 0, sx, sy, sz);
    const a = ch.tmp.box;
    for (let k = 0; k < 16; k++) a.push(tmpM[k]);
    a.push(col[0], col[1], col[2], rough, metal, emis, mat, seed === undefined ? 0 : seed);
    ch.count++;
  }
  function cyl(x, y, z, r, h, col, rough, metal, emis, mat, seed, ry) {
    const ch = World._forceChunk || chunkAt(x, z);
    M4.trs(tmpM, x, y, z, ry || 0, r * 2, h, r * 2);
    const a = ch.tmp.cyl;
    for (let k = 0; k < 16; k++) a.push(tmpM[k]);
    a.push(col[0], col[1], col[2], rough, metal, emis, mat, seed === undefined ? 0 : seed);
    ch.count++;
  }
  function sph(x, y, z, rx, ry_, rz, col, rough, metal, emis, mat, seed) {
    const ch = World._forceChunk || chunkAt(x, z);
    M4.trs(tmpM, x, y, z, 0, rx * 2, ry_ * 2, rz * 2);
    const a = ch.tmp.sph;
    for (let k = 0; k < 16; k++) a.push(tmpM[k]);
    a.push(col[0], col[1], col[2], rough, metal, emis, mat, seed === undefined ? 0 : seed);
    ch.count++;
  }
  World._box = box; World._cyl = cyl; World._sph = sph;

  const GREY = [.5, .5, .5], DARK = [.09, .095, .10], WHITE = [.88, .88, .86];

  /* ---------------- roads ---------------- */
  const roadCol = [.06, .062, .066];
  for (let i = 0; i <= N; i++) {
    const rx = this.roadX(i);
    for (let j = 0; j < N; j++) {
      const cz = -half + j * C + C * .5;
      box(rx, -.01, cz, R, .02, B, 0, roadCol, .9, 0, 0, M_ASPHALT, 1);   // N-S road
    }
  }
  for (let j = 0; j <= N; j++) {
    const rz = this.roadX(j);
    for (let i = 0; i < N; i++) {
      const cx = -half + i * C + C * .5;
      box(cx, -.01, rz, R, .02, B, PI * .5, roadCol, .9, 0, 0, M_ASPHALT, 1);
    }
  }
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    box(this.roadX(i), -.008, this.roadX(j), R, .02, R, 0, roadCol, .9, 0, 0, M_ASPHALT, 2);
    this.nodes.push({ x: this.roadX(i), z: this.roadX(j), i, j });
  }

  /* ---------------- blocks ---------------- */
  const blockPad = (C - B) * .5;
  for (let bi = 0; bi < N; bi++) {
    for (let bj = 0; bj < N; bj++) {
      const bx = -half + bi * C + C * .5, bz = -half + bj * C + C * .5;
      const dx = bx / half, dz = bz / half;
      const distC = Math.hypot(dx, dz);
      // sidewalk / block platform
      box(bx, this.CURB * .5, bz, B, this.CURB, B, 0, GREY, .85, 0, 0, M_CONCRETE, 0);

      let type = 'build';
      const rr = rnd();
      if (rr < .075) type = 'lot';
      else if (distC > .34 && rr < .19) type = 'park';
      else if (distC > .78 && rr < .40) type = 'low';
      if (bi === Math.floor(N / 2) && bj === Math.floor(N / 2)) type = 'plaza';
      this.blockInfo.push({ bx, bz, type });

      if (type === 'park') this._park(bx, bz, B, rnd);
      else if (type === 'lot') this._lot(bx, bz, B, rnd);
      else if (type === 'plaza') this._plaza(bx, bz, B, rnd);
      else this._buildings(bx, bz, B, distC, rnd, type === 'low');
    }
  }

  /* ---------------- street furniture ---------------- */
  this._streetFurniture(rnd);
  this._streetDetail(rnd);

  /* ---------------- surrounding terrain + skyline ---------------- */
  const farCh = Chunk(-1, -1, -4000, -4000, 4000, 4000);
  farCh.ey = 1200; farCh.cym = 0; farCh.always = true;
  this.chunks.push(farCh);
  this._forceChunk = farCh;
  this._outskirts(rnd);
  this._forceChunk = null;

  /* pick a spawn on a road */
  this.spawn = { x: this.roadX(Math.floor(N / 2)) + 3.6, z: -half + 1.5 * C, yaw: 0 };

  return this;
};

/* ---------- building cluster inside a block ---------- */
World._buildings = function (bx, bz, B, distC, rnd, low) {
  const usable = B - 7;
  const lots = [];
  const split = (x0, z0, x1, z1, d) => {
    const w = x1 - x0, h = z1 - z0;
    if (d > 2 || (w < 20 && h < 20) || (rnd() < .18 && d > 0)) { lots.push([x0, z0, x1, z1]); return; }
    if (w > h) { const s = x0 + w * (.36 + rnd() * .28); split(x0, z0, s, z1, d + 1); split(s, z0, x1, z1, d + 1); }
    else { const s = z0 + h * (.36 + rnd() * .28); split(x0, z0, x1, s, d + 1); split(x0, s, x1, z1, d + 1); }
  };
  split(bx - usable / 2, bz - usable / 2, bx + usable / 2, bz + usable / 2, 0);

  const heightScale = low ? .34 : lerp(1.0, .26, clamp01((distC - .12) / .85));
  for (const lot of lots) {
    const pad = .7 + rnd() * 1.4;
    const x0 = lot[0] + pad, z0 = lot[1] + pad, x1 = lot[2] - pad, z1 = lot[3] - pad;
    const w = x1 - x0, d = z1 - z0;
    if (w < 7 || d < 7) continue;
    this._tower((x0 + x1) * .5, (z0 + z1) * .5, w, d, heightScale, distC, rnd);
    this.addCollider(x0, z0, x1, z1, 400);
  }
};

/* one building: picks an architectural style and models real relief */
World._tower = function (cx, cz, w, d, heightScale, distC, rnd) {
  let seed = rnd() * 90;
  const detail = distC < .62 ? 1 : (distC < .86 ? .6 : .3);   // outer districts get less trim
  const floors = Math.max(2, Math.round((3 + rnd() * rnd() * 26) * heightScale + 1));
  const fh = 3.5 + rnd() * .8;
  const H = floors * fh;

  let style;
  const r = rnd();
  if (H > 46 && r < .62) style = 'glass';
  else if (H < 16 && r < .34) style = 'industrial';
  else if (r < .30) style = 'masonry';
  else if (r < .52) style = 'concrete';
  else style = 'mixed';

  const palettes = {
    glass: [[.10, .13, .17], [.13, .16, .20], [.09, .11, .15]],
    masonry: [[.26, .15, .11], [.31, .19, .13], [.22, .14, .12], [.34, .26, .19]],
    concrete: [[.34, .335, .32], [.27, .27, .265], [.40, .39, .37]],
    industrial: [[.24, .25, .26], [.31, .30, .28], [.20, .22, .24]],
    mixed: [[.30, .29, .275], [.22, .225, .235], [.35, .30, .265], [.17, .185, .205]],
  };
  // the facade shader reads the style out of the integer part of the seed
  seed += ({ modern: 0, mixed: 0, masonry: 1, glass: 2, concrete: 3, industrial: 3 }[style] || 0) * 100;
  const pal = palettes[style];
  const base = pal[(rnd() * pal.length) | 0];
  const tint = .86 + rnd() * .30;
  const col = [base[0] * tint, base[1] * tint, base[2] * tint];
  const trim = [col[0] * .72 + .05, col[1] * .72 + .05, col[2] * .72 + .055];

  const CURB = this.CURB;
  let y = CURB, cw = w, cd = d, ccx = cx, ccz = cz;
  const tiers = H > 52 ? (rnd() < .62 ? 3 : 2) : (H > 22 && rnd() < .45 ? 2 : 1);

  for (let t = 0; t < tiers; t++) {
    const frac = t === tiers - 1 ? 1 : (.46 + rnd() * .24);
    const th = (H - (y - CURB)) * frac;
    if (th < 2) break;
    const nFloors = Math.max(1, Math.round(th / fh));

    // main shaft
    this._box(ccx, y + th * .5, ccz, cw, th, cd, 0, col, .82, 0, 0, M_FACADE, seed + t * 3.1);

    /* ---- horizontal relief: floor slab bands ---- */
    if (detail > .5) {
      const every = style === 'glass' ? Math.max(1, Math.round(2 / 1)) : 1;
      const step = fh * every;
      const bandDepth = style === 'glass' ? .14 : .26;
      for (let f = 1; f <= nFloors; f += every) {
        const by = y + f * fh;
        if (by > y + th - .4) break;
        this._box(ccx, by, ccz, cw + bandDepth, style === 'glass' ? .16 : .30, cd + bandDepth,
          0, trim, .85, 0, 0, M_CONCRETE, 0);
      }
    }

    /* ---- vertical relief: pilasters / mullion fins ---- */
    if (detail > .55 && style !== 'industrial') {
      const spacing = style === 'glass' ? 3.6 : 4.2;
      const finW = style === 'glass' ? .18 : .42;
      const finD = style === 'glass' ? .22 : .34;
      const nx = Math.min(9, Math.max(2, Math.round(cw / spacing)));
      const nz = Math.min(9, Math.max(2, Math.round(cd / spacing)));
      for (let i = 0; i <= nx; i++) {
        const px = ccx - cw * .5 + cw * i / nx;
        for (const sz of [-1, 1])
          this._box(px, y + th * .5, ccz + sz * (cd * .5 + finD * .5), finW, th, finD, 0, trim, .84, 0, 0, M_CONCRETE, 0);
      }
      for (let i = 0; i <= nz; i++) {
        const pz = ccz - cd * .5 + cd * i / nz;
        for (const sx of [-1, 1])
          this._box(ccx + sx * (cw * .5 + finD * .5), y + th * .5, pz, finD, th, finW, 0, trim, .84, 0, 0, M_CONCRETE, 0);
      }
    }

    /* ---- corner columns ---- */
    if (detail > .3) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1])
        this._box(ccx + sx * cw * .5, y + th * .5, ccz + sz * cd * .5, .55, th, .55, 0, trim, .82, 0, 0, M_CONCRETE, 0);
    }

    /* ---- balconies on residential-looking mid-rises ---- */
    if (style === 'masonry' && detail > .7 && th > 12 && rnd() < .55) {
      const nb = Math.min(6, Math.max(2, Math.round(cw / 5)));
      for (let f = 1; f < nFloors; f++) {
        if (f % 1) { }
        const by = y + f * fh + .1;
        if (by > y + th - 2) break;
        for (let i = 0; i < nb; i++) {
          const px = ccx - cw * .34 + cw * .68 * (nb === 1 ? .5 : i / (nb - 1));
          const sz = rnd() < .5 ? -1 : 1;
          this._box(px, by, ccz + sz * (cd * .5 + .45), cw / nb * .62, .16, .9, 0, trim, .85, 0, 0, M_CONCRETE, 0);
          this._box(px, by + .48, ccz + sz * (cd * .5 + .86), cw / nb * .62, .8, .06, 0, [.2, .21, .23], .5, .7, 0, M_METAL, 0);
        }
      }
    }

    /* ---- fire escape ---- */
    if (style === 'masonry' && detail > .7 && rnd() < .35) {
      const sx = rnd() < .5 ? -1 : 1;
      for (let f = 1; f < nFloors; f++) {
        const by = y + f * fh;
        if (by > y + th - 2) break;
        this._box(ccx + sx * (cw * .5 + .55), by, ccz, 1.1, .10, 2.6, 0, [.16, .17, .18], .7, .6, 0, M_METAL, 0);
        this._box(ccx + sx * (cw * .5 + 1.05), by + .55, ccz, .06, 1.1, 2.6, 0, [.16, .17, .18], .7, .6, 0, M_METAL, 0);
        this._box(ccx + sx * (cw * .5 + .8), by + fh * .5, ccz + 1.5, .9, .1, 2.2, 0, [.16, .17, .18], .7, .6, 0, M_METAL, 0);
      }
    }

    /* ---- ground floor: shopfront, awnings, columns ---- */
    if (t === 0) {
      const gh = Math.min(4.6, th * .5);
      this._box(ccx, CURB + gh * .5, ccz, cw + .5, gh, cd + .5, 0,
        [col[0] * .55, col[1] * .55, col[2] * .58], .55, .15, 0, M_CONCRETE, 0);
      // dark glazed shopfront band
      this._box(ccx, CURB + gh * .58, ccz, cw + .56, gh * .40, cd + .56, 0,
        [.045, .055, .075], .10, .2, 0, M_GLASSDARK, 0);
      if (detail > .4) {
        const nsx = Math.min(7, Math.max(2, Math.round(cw / 4.5)));
        for (let i = 0; i <= nsx; i++) {
          const px = ccx - cw * .5 + cw * i / nsx;
          for (const sz of [-1, 1])
            this._box(px, CURB + gh * .5, ccz + sz * (cd * .5 + .30), .34, gh, .34, 0, trim, .8, 0, 0, M_CONCRETE, 0);
        }
        // awnings
        if (rnd() < .55) {
          const ac = [[.55, .10, .10], [.10, .22, .40], [.14, .30, .16], [.35, .30, .10]][(rnd() * 4) | 0];
          const sz = rnd() < .5 ? -1 : 1;
          this._box(ccx, CURB + gh * .78, ccz + sz * (cd * .5 + .95), cw * .72, .10, 1.5, 0, ac, .75, 0, 0, M_PLASTIC, 0);
        }
      }
      // lit signage above the shopfront
      if (rnd() < .62) {
        const sc = [[1, .35, .5], [.3, .8, 1], [1, .75, .25], [.55, 1, .5], [1, .35, .18], [.75, .4, 1]][(rnd() * 6) | 0];
        const sz = rnd() < .5 ? -1 : 1;
        const sx2 = rnd() < .5 ? -1 : 1;
        if (rnd() < .5)
          this._box(ccx, CURB + gh + .55, ccz + sz * (cd * .5 + .42), Math.min(cw * .7, 9), 1.05, .16, 0, sc, .4, 0, 3.0, M_EMISSIVE, 2);
        else
          this._box(ccx + sx2 * (cw * .5 + .42), CURB + gh + .55, ccz, .16, 1.05, Math.min(cd * .7, 9), 0, sc, .4, 0, 3.0, M_EMISSIVE, 2);
        this.lights.push({ p: [ccx, CURB + gh + .2, ccz], col: sc, rad: 15, kind: 'sign' });
      }
      // vertical blade sign
      if (H > 24 && rnd() < .3) {
        const sc = [[1, .3, .35], [.35, .85, 1], [1, .8, .3]][(rnd() * 3) | 0];
        const sx2 = rnd() < .5 ? -1 : 1;
        const bh = Math.min(H * .35, 14);
        this._box(ccx + sx2 * (cw * .5 + .5), CURB + gh + bh * .5, ccz, .22, bh, 1.5, 0, sc, .4, 0, 2.4, M_EMISSIVE, 2);
        this.lights.push({ p: [ccx + sx2 * (cw * .5 + 1), CURB + gh + bh * .5, ccz], col: sc, rad: 20, kind: 'sign' });
      }
    }

    // parapet at the top of each tier
    this._box(ccx, y + th + .36, ccz, cw + .30, .72, cd + .30, 0,
      [trim[0] * .8, trim[1] * .8, trim[2] * .82], .9, 0, 0, M_CONCRETE, 0);

    y += th;
    const shrink = .74 + rnd() * .14;
    cw *= shrink; cd *= shrink;
    ccx += (rnd() - .5) * (w - cw) * .28; ccz += (rnd() - .5) * (d - cd) * .28;
  }

  /* ---------------- rooftop ---------------- */
  const roofY = y;
  // stair bulkhead
  this._box(ccx + (rnd() - .5) * cw * .3, roofY + 1.5, ccz + (rnd() - .5) * cd * .3,
    Math.min(cw * .34, 5), 3.0, Math.min(cd * .34, 5), 0, [.20, .20, .21], .9, 0, 0, M_CONCRETE, 0);
  const rc = 1 + (rnd() * 4) | 0;
  for (let k = 0; k < rc; k++) {
    const ox = ccx + (rnd() - .5) * cw * .6, oz = ccz + (rnd() - .5) * cd * .6;
    const sxx = 1.1 + rnd() * 2.4;
    this._box(ox, roofY + .6, oz, sxx, 1.2, sxx * (.6 + rnd() * .8), rnd() * PI, [.24, .25, .26], .7, .40, 0, M_METAL, 0);
    this._cyl(ox, roofY + 1.35, oz, sxx * .28, .30, [.30, .31, .32], .55, .6, 0, M_METAL, 0);
  }
  // water tank on legs
  if (rnd() < .34) {
    const wx = ccx + (rnd() - .5) * cw * .4, wz = ccz + (rnd() - .5) * cd * .4;
    for (const sx of [-1, 1]) for (const sz of [-1, 1])
      this._box(wx + sx * 1.1, roofY + 1.1, wz + sz * 1.1, .16, 2.2, .16, 0, [.22, .18, .14], .85, .2, 0, M_METAL, 0);
    this._cyl(wx, roofY + 3.6, wz, 1.7, 3.0, [.30, .23, .17], .9, .1, 0, M_PLASTIC, 0);
    this._cyl(wx, roofY + 5.2, wz, 1.75, .35, [.24, .19, .14], .9, .1, 0, M_PLASTIC, 0);
  }
  // rooftop billboard
  if (rnd() < .22 && cw > 12) {
    const sc = [[1, .35, .45], [.3, .8, 1], [1, .8, .3]][(rnd() * 3) | 0];
    const bw = Math.min(cw * .85, 16);
    for (const sx of [-1, 1])
      this._box(ccx + sx * bw * .42, roofY + 1.6, ccz, .25, 3.2, .25, 0, [.18, .19, .2], .7, .6, 0, M_METAL, 0);
    this._box(ccx, roofY + 4.0, ccz, bw, 4.2, .30, 0, sc, .45, 0, 2.2, M_EMISSIVE, 2);
    this.lights.push({ p: [ccx, roofY + 4, ccz], col: sc, rad: 34, kind: 'sign' });
  }
  // antenna + aircraft warning light
  if (rnd() < .5) {
    const ah = 5 + rnd() * 14;
    this._box(ccx, roofY + ah * .5, ccz, .20, ah, .20, 0, [.3, .3, .32], .6, .8, 0, M_METAL, 0);
    for (let k = 1; k <= 3; k++)
      this._box(ccx, roofY + ah * k / 4, ccz, .9, .06, .9, rnd() * PI, [.3, .3, .32], .6, .8, 0, M_METAL, 0);
    this._sph(ccx, roofY + ah, ccz, .22, .22, .22, [1, .18, .12], .4, 0, 3.5, M_EMISSIVE, 0);
    this.lights.push({ p: [ccx, roofY + ah, ccz], col: [1.0, .2, .12], rad: 9, kind: 'beacon' });
  }
};

World._park = function (bx, bz, B, rnd) {
  const s = B - 6;
  this._box(bx, this.CURB + .02, bz, s, .04, s, 0, [.09, .13, .06], .95, 0, 0, M_GRASS, 0);
  // paths
  this._box(bx, this.CURB + .05, bz, 3.2, .04, s, 0, [.5, .5, .48], .85, 0, 0, M_CONCRETE, 0);
  this._box(bx, this.CURB + .05, bz, s, .04, 3.2, 0, [.5, .5, .48], .85, 0, 0, M_CONCRETE, 0);
  const n = 7 + (rnd() * 7) | 0;
  for (let k = 0; k < n; k++) {
    const x = bx + (rnd() - .5) * s * .9, z = bz + (rnd() - .5) * s * .9;
    if (Math.abs(x - bx) < 2.6 || Math.abs(z - bz) < 2.6) continue;
    this._tree(x, z, rnd, rnd() < .3);
  }
  for (let k = 0; k < 4; k++) {
    const a = rnd() * TAU, r = s * .28;
    this._bench(bx + Math.cos(a) * r, bz + Math.sin(a) * r, a);
  }
  // fountain in some parks
  if (rnd() < .5) {
    this._cyl(bx, this.CURB + .25, bz, 3.4, .5, [.55, .54, .52], .8, 0, 0, M_CONCRETE, 0);
    this._cyl(bx, this.CURB + .52, bz, 3.0, .06, [.15, .3, .38], .06, .1, 0, M_PAINT, 0);
    this._cyl(bx, this.CURB + 1.1, bz, .45, 1.8, [.6, .59, .56], .8, 0, 0, M_CONCRETE, 0);
    this.addCollider(bx - 3.6, bz - 3.6, bx + 3.6, bz + 3.6, this.CURB + .5);
  }
};

World._lot = function (bx, bz, B, rnd) {
  const s = B - 6;
  this._box(bx, this.CURB + .02, bz, s, .04, s, 0, [.055, .057, .06], .9, 0, 0, M_ASPHALT, 0);
  for (let r = -2; r <= 2; r++)
    for (let k = -4; k <= 4; k++)
      this._box(bx + r * 11, this.CURB + .05, bz + k * 5.6, .16, .02, 4.8, 0, [.7, .68, .55], .7, 0, 0, M_ROADPAINT, 0);
  this._lotCars = this._lotCars || [];
  for (let k = 0; k < 10; k++) {
    if (rnd() < .35) continue;
    const r = ((rnd() * 5) | 0) - 2, c = ((rnd() * 9) | 0) - 4;
    this._lotCars.push({ x: bx + r * 11 + 5.5, z: bz + c * 5.6 + 2.8, yaw: rnd() < .5 ? 0 : PI, seed: rnd() * 1e6 });
  }
  // light poles
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = bx + sx * s * .3, z = bz + sz * s * .3;
    this._cyl(x, this.CURB + 3.2, z, .11, 6.4, [.2, .21, .22], .6, .7, 0, M_METAL, 0);
    this._box(x, this.CURB + 6.5, z, 1.1, .18, .5, 0, [.9, .88, .8], .3, 0, 2.2, M_EMISSIVE, 1);
    this.lights.push({ p: [x, this.CURB + 6.3, z], col: [1.0, .92, .78], rad: 20, kind: 'street' });
  }
};

World._plaza = function (bx, bz, B, rnd) {
  const s = B - 5;
  this._box(bx, this.CURB + .03, bz, s, .06, s, 0, [.58, .57, .55], .8, 0, 0, M_CONCRETE, 0);
  // monument
  this._box(bx, this.CURB + .8, bz, 9, 1.6, 9, 0, [.45, .44, .42], .85, 0, 0, M_CONCRETE, 0);
  this._box(bx, this.CURB + 1.6 + 6, bz, 2.0, 12, 2.0, PI * .25, [.62, .60, .56], .5, .2, 0, M_CONCRETE, 0);
  this._sph(bx, this.CURB + 14.6, bz, 1.5, 1.5, 1.5, [.9, .75, .35], .18, 1, .8, M_METAL, 0);
  this.lights.push({ p: [bx, this.CURB + 8, bz], col: [1.0, .85, .55], rad: 34, kind: 'sign' });
  this.addCollider(bx - 4.6, bz - 4.6, bx + 4.6, bz + 4.6, this.CURB + 2);
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * TAU;
    this._tree(bx + Math.cos(a) * s * .38, bz + Math.sin(a) * s * .38, rnd, true);
  }
};

World._tree = function (x, z, rnd, palm) {
  const y = this.CURB;
  if (palm) {
    const h = 5.6 + rnd() * 3.6;
    const lean = (rnd() - .5) * .25;
    for (let k = 0; k < 4; k++) {
      const t = k / 4;
      this._cyl(x + lean * t * h * .4, y + h * (t + .125), z, .20 - t * .07, h * .27,
        [.30 - t * .04, .25 - t * .03, .18], .92, 0, 0, M_PLASTIC, 0);
    }
    const tx = x + lean * h * .4;
    const nf = 8 + (rnd() * 4) | 0;
    for (let k = 0; k < nf; k++) {
      const a2 = k / nf * TAU + rnd() * .3;
      const droop = .28 + rnd() * .35;
      for (let seg = 0; seg < 3; seg++) {
        const t = (seg + 1) / 3;
        const r = 1.9 * t;
        this._sph(tx + Math.cos(a2) * r, y + h + .12 - droop * t * t * 1.7, z + Math.sin(a2) * r,
          .95 * (1.1 - t * .5), .13, .34 * (1.1 - t * .4),
          [.10 + rnd() * .04, .27 + rnd() * .08, .09], .9, 0, 0, M_FOLIAGE, 0);
      }
    }
    this._sph(tx, y + h + .22, z, .48, .42, .48, [.16, .32, .12], .9, 0, 0, M_FOLIAGE, 0);
  } else {
    const h = 4.4 + rnd() * 3.6;
    const trunkR = .18 + rnd() * .08;
    this._cyl(x, y + h * .20, z, trunkR * 1.25, h * .40, [.19, .15, .11], .93, 0, 0, M_PLASTIC, 0);
    this._cyl(x, y + h * .48, z, trunkR, h * .30, [.20, .16, .12], .93, 0, 0, M_PLASTIC, 0);
    // a couple of real branches
    for (let k = 0; k < 3; k++) {
      const a2 = rnd() * TAU, r = .5 + rnd() * .5;
      this._cyl(x + Math.cos(a2) * r, y + h * .62, z + Math.sin(a2) * r, trunkR * .5, h * .26,
        [.20, .16, .12], .93, 0, 0, M_PLASTIC, 0);
    }
    // canopy: a cluster of squashed lobes reads as foliage, one sphere does not
    const R = 1.6 + rnd() * 1.2;
    const g = [.055 + rnd() * .05, .16 + rnd() * .11, .045 + rnd() * .04];
    const lobes = 5 + (rnd() * 4) | 0;
    for (let k = 0; k < lobes; k++) {
      const a2 = k / lobes * TAU + rnd() * .6;
      const rr = R * (.32 + rnd() * .38);
      const dist = R * (.30 + rnd() * .45);
      const yy = y + h * (.74 + rnd() * .26);
      const shade = .78 + rnd() * .48;
      this._sph(x + Math.cos(a2) * dist, yy, z + Math.sin(a2) * dist,
        rr, rr * (.72 + rnd() * .3), rr,
        [g[0] * shade, g[1] * shade, g[2] * shade], .9, 0, 0, M_FOLIAGE, 0);
    }
    this._sph(x, y + h * .86, z, R * .62, R * .52, R * .62, g, .9, 0, 0, M_FOLIAGE, 0);
  }
  this.trees.push([x, z]);
};

World._bench = function (x, z, a) {
  const y = this.CURB;
  this._box(x, y + .42, z, 1.9, .09, .55, a, [.34, .24, .16], .8, 0, 0, M_PLASTIC, 0);
  this._box(x - Math.sin(a) * .26, y + .70, z - Math.cos(a) * .26, 1.9, .45, .08, a, [.34, .24, .16], .8, 0, 0, M_PLASTIC, 0);
  for (const s of [-.75, .75])
    this._box(x + Math.cos(a) * s, y + .2, z - Math.sin(a) * s, .1, .42, .5, a, [.15, .15, .16], .5, .8, 0, M_METAL, 0);
};

/* ---------- streetlights, signals, hydrants, bins ---------- */
World._streetFurniture = function (rnd) {
  const N = this.N, C = this.CELL, R = this.ROAD, half = this.half, y = this.CURB;
  const poleCol = [.17, .18, .19];

  const streetlight = (x, z, rot) => {
    const h = 8.2;
    this._cyl(x, y + h * .5, z, .13, h, poleCol, .5, .85, 0, M_METAL, 0);
    const ax = Math.cos(rot), az = Math.sin(rot);
    this._box(x + ax * 1.3, y + h - .1, z + az * 1.3, 2.8, .16, .16, -rot, poleCol, .5, .85, 0, M_METAL, 0);
    this._box(x + ax * 2.5, y + h - .28, z + az * 2.5, .95, .22, .42, -rot, [1, .95, .85], .3, 0, 3.4, M_EMISSIVE, 1);
    this.lights.push({ p: [x + ax * 2.5, y + h - .45, z + az * 2.5], col: [1.0, .90, .72], rad: 26, kind: 'street' });
  };

  for (let i = 0; i <= N; i++) {
    const rx = this.roadX(i);
    for (let j = 0; j < N; j++) {
      const z0 = -half + j * C + C * .5;
      for (const o of [-.28, .28]) {
        const zz = z0 + o * C;
        if (i > 0) streetlight(rx - R * .5 - 1.2, zz, 0);
        if (i < N) streetlight(rx + R * .5 + 1.2, zz, PI);
      }
    }
  }
  for (let j = 0; j <= N; j++) {
    const rz = this.roadX(j);
    for (let i = 0; i < N; i++) {
      const x0 = -half + i * C + C * .5;
      for (const o of [-.28, .28]) {
        const xx = x0 + o * C;
        if (j > 0) streetlight(xx, rz - R * .5 - 1.2, PI * .5);
        if (j < N) streetlight(xx, rz + R * .5 + 1.2, -PI * .5);
      }
    }
  }

  // traffic signals at intersections
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = this.roadX(i), z = this.roadX(j);
    if (i === 0 || j === 0 || i === N || j === N) continue;
    for (let k = 0; k < 4; k++) {
      const a = k * PI * .5;
      const px = x + Math.cos(a) * (R * .5 + 1.4), pz = z + Math.sin(a) * (R * .5 + 1.4);
      this._cyl(px, y + 2.4, pz, .09, 4.8, poleCol, .5, .85, 0, M_METAL, 0);
      const hx = px - Math.cos(a) * 2.2, hz = pz - Math.sin(a) * 2.2;
      this._box((px + hx) * .5, y + 4.7, (pz + hz) * .5, 2.4, .12, .12, -a, poleCol, .5, .85, 0, M_METAL, 0);
      this._box(hx, y + 4.2, hz, .34, .95, .30, -a, [.08, .08, .09], .6, 0, 0, M_PLASTIC, 0);
      // the lamp itself is drawn per frame so it can actually change colour
      this.signals.push({
        x: hx - Math.cos(a) * .19, y: y + 4.2, z: hz - Math.sin(a) * .19,
        i, j, axis: (k % 2) === 0 ? 0 : 1
      });
    }
    // crossing bollards
  }

  // hydrants, bins, bollards along block corners
  for (let bi = 0; bi < N; bi++) for (let bj = 0; bj < N; bj++) {
    const bx = -half + bi * C + C * .5, bz = -half + bj * C + C * .5;
    const B = this.BLOCK;
    if (rnd() < .6) {
      const sx = rnd() < .5 ? -1 : 1, sz = rnd() < .5 ? -1 : 1;
      const x = bx + sx * (B * .5 - 1.6), z = bz + sz * (B * .5 - 1.6);
      this._cyl(x, y + .38, z, .17, .76, [.75, .12, .10], .55, .1, 0, M_PLASTIC, 0);
      this._sph(x, y + .80, z, .19, .16, .19, [.75, .12, .10], .55, .1, 0, M_PLASTIC, 0);
    }
    if (rnd() < .5) {
      const sx = rnd() < .5 ? -1 : 1;
      const x = bx + sx * (B * .5 - 1.4), z = bz + (rnd() - .5) * B * .7;
      this._cyl(x, y + .45, z, .32, .9, [.13, .16, .14], .8, .2, 0, M_PLASTIC, 0);
      this._cyl(x, y + .93, z, .34, .07, [.09, .10, .09], .7, .3, 0, M_PLASTIC, 0);
    }
    if (rnd() < .35) {
      const sz = rnd() < .5 ? -1 : 1;
      const z = bz + sz * (B * .5 - 1.3);
      for (let k = -2; k <= 2; k++)
        this._cyl(bx + k * 2.2, y + .45, z, .10, .9, [.2, .21, .23], .5, .8, 0, M_METAL, 0);
    }
    // bus shelter
    if (rnd() < .18) {
      const sx = rnd() < .5 ? -1 : 1;
      const x = bx + sx * (B * .5 - 2.0), z = bz + (rnd() - .5) * B * .5;
      this._box(x, y + 1.3, z, 1.2, 2.6, 4.4, 0, [.14, .15, .17], .35, .7, 0, M_METAL, 0);
      this._box(x, y + 2.7, z, 2.0, .12, 4.8, 0, [.2, .21, .23], .3, .8, 0, M_METAL, 0);
      this._box(x - sx * .5, y + 1.6, z, .06, 1.8, 3.0, 0, [.6, .8, 1], .05, .1, .8, M_EMISSIVE, 2);
      this.lights.push({ p: [x, y + 2.4, z], col: [.7, .85, 1.0], rad: 11, kind: 'sign' });
    }
  }
};

/* ---------- kerbs, gutters, manholes, road arrows ---------- */
World._streetDetail = function (rnd) {
  const N = this.N, C = this.CELL, R = this.ROAD, B = this.BLOCK, half = this.half, y = this.CURB;
  const kerbCol = [.44, .435, .42], gutterCol = [.20, .205, .21];

  // kerb edge + gutter along every block boundary
  for (let bi = 0; bi < N; bi++) for (let bj = 0; bj < N; bj++) {
    const bx = -half + bi * C + C * .5, bz = -half + bj * C + C * .5;
    for (const sz of [-1, 1]) {
      this._box(bx, y - .01, bz + sz * (B * .5 + .09), B + .18, .30, .18, 0, kerbCol, .78, 0, 0, M_CONCRETE, 0);
      this._box(bx, .012, bz + sz * (B * .5 + .38), B, .02, .42, 0, gutterCol, .82, 0, 0, M_ASPHALT, 0);
    }
    for (const sx of [-1, 1]) {
      this._box(bx + sx * (B * .5 + .09), y - .01, bz, .18, .30, B + .18, 0, kerbCol, .78, 0, 0, M_CONCRETE, 0);
      this._box(bx + sx * (B * .5 + .38), .012, bz, .42, .02, B, 0, gutterCol, .82, 0, 0, M_ASPHALT, 0);
    }
    // storm drains
    if (rnd() < .7) {
      const sx = rnd() < .5 ? -1 : 1;
      this._box(bx + sx * (B * .5 + .38), .026, bz + (rnd() - .5) * B * .7, .5, .03, .8, 0,
        [.12, .125, .13], .55, .75, 0, M_METAL, 0);
    }
  }

  // manhole covers + patched tarmac down the middle of the carriageways
  for (let i = 0; i <= N; i++) {
    const rx = this.roadX(i);
    for (let j = 0; j < N; j++) {
      const cz = -half + j * C + C * .5;
      if (rnd() < .55) this._cyl(rx + (rnd() - .5) * R * .55, .022, cz + (rnd() - .5) * B * .8, .38, .035,
        [.14, .135, .13], .62, .55, 0, M_METAL, 0);
      if (rnd() < .35) this._box(rx + (rnd() - .5) * R * .6, .018, cz + (rnd() - .5) * B * .8,
        1.6 + rnd() * 2.4, .015, 1.4 + rnd() * 2.6, rnd() * PI, [.085, .086, .09], .88, 0, 0, M_ASPHALT, 0);
    }
  }
  for (let j = 0; j <= N; j++) {
    const rz = this.roadX(j);
    for (let i = 0; i < N; i++) {
      const cx = -half + i * C + C * .5;
      if (rnd() < .55) this._cyl(cx + (rnd() - .5) * B * .8, .022, rz + (rnd() - .5) * R * .55, .38, .035,
        [.14, .135, .13], .62, .55, 0, M_METAL, 0);
      if (rnd() < .35) this._box(cx + (rnd() - .5) * B * .8, .018, rz + (rnd() - .5) * R * .6,
        1.6 + rnd() * 2.4, .015, 1.4 + rnd() * 2.6, rnd() * PI, [.085, .086, .09], .88, 0, 0, M_ASPHALT, 0);
    }
  }

  // lane arrows on the approach to each intersection
  const paint = [.46, .455, .43];
  const arrow = (x, z, rot) => {
    this._box(x, .026, z, .34, .02, 2.2, rot, paint, .6, 0, 0, M_ROADPAINT, 0);
    for (let k = 0; k < 5; k++) {
      const t = k / 4, w = .34 + t * .78;
      this._box(x + Math.sin(rot) * (1.1 + t * .55), .026, z + Math.cos(rot) * (1.1 + t * .55),
        w, .02, .22, rot, paint, .6, 0, 0, M_ROADPAINT, 0);
    }
  };
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    if (i === 0 || j === 0 || i === N || j === N) continue;
    if (rnd() < .45) continue;
    const x = this.roadX(i), z = this.roadX(j);
    arrow(x + 3.6, z - R * .5 - 5.5, 0);
    arrow(x - 3.6, z + R * .5 + 5.5, PI);
    arrow(x + R * .5 + 5.5, z + 3.6, -PI * .5);
    arrow(x - R * .5 - 5.5, z - 3.6, PI * .5);
  }
};

/* traffic light state: 0 red, 1 amber, 2 green. axis 0 = runs along X, 1 = along Z */
World.signalState = function (i, j, axis, t) {
  const off = hash2(i * 7 + 3, j * 11 + 5) * 16;
  const c = (t + off) % 16;
  const nsGreen = c < 6.6 ? 2 : (c < 7.9 ? 1 : 0);
  const ewGreen = (c >= 8 && c < 14.6) ? 2 : ((c >= 14.6 && c < 15.9) ? 1 : 0);
  return axis === 1 ? nsGreen : ewGreen;
};

/* ---------- outskirts: ground plane, distant skyline, hills ---------- */
World._outskirts = function (rnd) {
  const half = this.half;
  const far = half + 1400;
  // ground
  this._box(0, -.06, 0, far * 2, .1, far * 2, 0, [.085, .095, .075], .95, 0, 0, M_GRASS, 0);
  // ring road / apron just outside the grid
  for (const s of [-1, 1]) {
    this._box(s * (half + 24), -.01, 0, 40, .02, half * 2 + 100, 0, [.06, .062, .066], .9, 0, 0, M_ASPHALT, 0);
    this._box(0, -.01, s * (half + 24), half * 2 + 100, .02, 40, 0, [.06, .062, .066], .9, 0, 0, M_ASPHALT, 0);
  }
  // distant skyline
  for (let k = 0; k < 260; k++) {
    const a = rnd() * TAU;
    const d = half + 160 + rnd() * 950;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const w = 16 + rnd() * 46, h = 30 + rnd() * rnd() * 220;
    const g = .10 + rnd() * .10;
    this._box(x, h * .5, z, w, h, w * (.6 + rnd() * .8), rnd() * PI, [g, g * 1.03, g * 1.12], .85, 0, 0, M_FACADE, rnd() * 90);
  }
  // hills
  for (let k = 0; k < 40; k++) {
    const a = rnd() * TAU, d = half + 1400 + rnd() * 1400;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const r = 300 + rnd() * 700, h = 120 + rnd() * 420;
    this._sph(x, -h * .25, z, r, h, r * (.7 + rnd() * .6), [.055, .07, .085], .98, 0, 0, M_FOLIAGE, 0);
  }
};

/* ---------- finalise: turn accumulated instance data into GPU batches ---------- */
World.upload = function (meshes) {
  for (const ch of this.chunks) {
    ch.batches = [];
    let maxY = 8;
    for (const key in ch.tmp) {
      const arr = ch.tmp[key];
      if (!arr.length) continue;
      const n = arr.length / INSTANCE_FLOATS;
      const b = new Batch(meshes[key], n, false);
      b.data.set(arr);
      b.n = n; b.dirty = true; b.upload();
      ch.batches.push(b);
      for (let k = 0; k < n; k++) {
        const o = k * INSTANCE_FLOATS;
        const y = arr[o + 13] + Math.abs(arr[o + 5]) * .5;
        if (y > maxY) maxY = y;
      }
      ch.tmp[key] = null;
    }
    ch.ey = maxY * .5 + 2; ch.cym = maxY * .5;
  }
  this.tmpCleared = true;
};
