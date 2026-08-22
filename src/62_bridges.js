'use strict';
/* ============================================================
   Apex Drive — grade-separated junctions and viaducts

   The four connector roads used to run out toward the motorway and
   simply stop, because there was nothing to join them to. Each now
   climbs an embankment, crosses the carriageways on a bridge, and
   comes back down the other side, with a diamond of on and off ramps
   linking the two levels — which is what a motorway junction is.

   None of this can sit on the terrain. A height field holds exactly
   one surface per point, and a bridge is precisely the case where
   there are two: the deck, and the road you can also drive on beneath
   it. So the structure is placed at absolute heights and registers its
   running surface with World.addDeck, and the ground query resolves
   which of the two a given wheel is on by where that wheel already is.
   ============================================================ */

/* laid out in the frame of the junction: r runs out along the axis from
   the city centre, t runs across it */
World._interchange = function (a, rnd) {
  const R = Terrain.ringR, ring = this.ring;
  const CW = ring.CW, GAP = ring.GAP;
  const ca = Math.cos(a), sa = Math.sin(a);
  const yaw = Math.atan2(ca, sa);             // heading of the axis itself
  const PX = (r, t) => ca * r - sa * t;
  const PZ = (r, t) => sa * r + ca * t;

  const road = [.058, .060, .065];
  const conc = [.50, .495, .48];
  const concD = [.40, .40, .39];
  const steel = [.36, .37, .39];
  const rail = [.62, .63, .64];

  /* The terrain already carries this road's vertical alignment — it graded
     itself to it — so read the heights back out of it rather than inventing
     a second set that would only disagree. 7.6 m over the motorway leaves a
     shade over six to the underside of the girders once the deck is taken
     off, which is the clearance a bridge is built to. */
  const ai = ((Math.round(a / (PI * .5)) % 4) + 4) % 4;
  const deckY = Terrain.ringHeight(a) + Terrain.bridgeRise;
  const HW = 7.6;                             // half width of the crossing road

  const footIn = R - 126, abutIn = R - Terrain.bridgeHalf;
  const abutOut = R + Terrain.bridgeHalf, footOut = R + 126;
  const yIn = Terrain.connH(ai, footIn);
  const yOut = Terrain.connH(ai, footOut);

  const bridge = { a, x: ca * R, z: sa * R, deckY, r0: footIn, r1: footOut, span: 60 };
  this.bridges.push(bridge);

  /* ---------- approach embankments ---------- */
  /* the climb, and the retaining walls holding the fill in on either side */
  const approach = (r0, y0, r1, y1) => {
    const n = 20;
    for (let k = 0; k < n; k++) {
      const f0 = k / n, f1 = (k + 1) / n;
      const ra = lerp(r0, r1, f0), rb = lerp(r0, r1, f1);
      const ya = Terrain.connH(ai, ra), yb = Terrain.connH(ai, rb);
      const rm = (ra + rb) * .5, ym = (ya + yb) * .5;
      const grade = (yb - ya) / (rb - ra);
      const len = Math.abs(rb - ra) * 1.06;
      const x = PX(rm, 0), z = PZ(rm, 0);
      this._boxAt(x, ym, z, HW * 2, .30, len, yaw, grade, road, .90, 0, 0, M_ASPHALT, 1);
      this.addDeck(PX(ra, 0), PZ(ra, 0), ya, PX(rb, 0), PZ(rb, 0), yb, HW + .4);
      // lane divider down the middle of the climb
      this._boxAt(x, ym + .17, z, .28, .02, len * .55, yaw, grade,
        [.72, .70, .58], .6, 0, 0, M_ROADPAINT, 0);

      for (const t of [-1, 1]) {
        const wx = PX(rm, t * (HW + .55)), wz = PZ(rm, t * (HW + .55));
        const gnd = Terrain.h(wx, wz);
        const h = Math.max(.5, ym - gnd);
        // retaining wall, its bulk under the road rather than beside it
        this._boxAt(wx, ym - h * .5, wz, 1.1, h, len, yaw, 0, conc, .88, 0, 0, M_CONCRETE, 0);
        this._boxAt(wx, ym + .42, wz, 1.25, .55, len, yaw, grade, concD, .85, 0, 0, M_CONCRETE, 0);
        if (h > 1.6) this.addCollider(wx - 1.2, wz - 1.2, wx + 1.2, wz + 1.2, ym + .75, ym - .4);
        if (k % 4 === 0 && h > 2.2)                      // counterfort buttress
          this._boxAt(PX(rm, t * (HW + 1.5)), ym - h * .55, PZ(rm, t * (HW + 1.5)),
            .8, h * .9, 1.5, yaw, 0, concD, .9, 0, 0, M_CONCRETE, 0);
      }
      if (k % 5 === 2) {
        const lx = PX(rm, HW + 1.6), lz = PZ(rm, HW + 1.6);
        this._cylAt(lx, ym + 4.2, lz, .12, 8.4, steel, .5, .8, 0, M_METAL, 0);
        this._boxAt(lx, ym + 8.5, lz, .9, .22, .42, yaw, 0, [1, .95, .85], .3, 0, 2.6, M_EMISSIVE, 1);
        this.lights.push({ p: [lx, ym + 8.3, lz], col: [1, .92, .78], rad: 30, kind: 'street' });
      }
    }
  };
  approach(footIn, yIn, abutIn, deckY);
  approach(footOut, yOut, abutOut, deckY);

  /* ---------- the bridge itself ---------- */
  const SPAN = abutOut - abutIn;
  const NSEG = 16, segLen = SPAN / NSEG;

  // deck slabs, and the running surface they carry
  for (let k = 0; k < NSEG; k++) {
    const r0 = abutIn + segLen * k, r1 = r0 + segLen, rm = (r0 + r1) * .5;
    const x = PX(rm, 0), z = PZ(rm, 0);
    this._boxAt(x, deckY, z, HW * 2, .30, segLen * 1.04, yaw, 0, road, .90, 0, 0, M_ASPHALT, 1);
    this.addDeck(PX(r0, 0), PZ(r0, 0), deckY, PX(r1, 0), PZ(r1, 0), deckY, HW + .4);
    // soffit: the slab you see from underneath, and the drainage kerbs
    this._boxAt(x, deckY - .62, z, HW * 2 + .5, .95, segLen * 1.02, yaw, 0, conc, .86, 0, 0, M_CONCRETE, 0);
    this._boxAt(x, deckY + .17, z, .28, .02, segLen * .55, yaw, 0, [.72, .70, .58], .6, 0, 0, M_ROADPAINT, 0);
    // edge marking so the deck reads as a carriageway at night
    for (const t of [-1, 1])
      this._boxAt(PX(rm, t * (HW - .55)), deckY + .17, PZ(rm, t * (HW - .55)),
        .16, .02, segLen * .92, yaw, 0, [.80, .79, .70], .55, 0, 0, M_ROADPAINT, 0);
  }

  // longitudinal girders and the cross-bracing between them
  for (const t of [-5.4, -1.8, 1.8, 5.4]) {
    for (let k = 0; k < NSEG; k++) {
      const rm = abutIn + segLen * (k + .5);
      this._boxAt(PX(rm, t), deckY - 1.55, PZ(rm, t), .36, .95, segLen * 1.02, yaw, 0,
        steel, .55, .80, 0, M_METAL, 0);
    }
  }
  for (let k = 1; k < NSEG; k += 2) {
    const rm = abutIn + segLen * k;
    this._boxAt(PX(rm, 0), deckY - 1.55, PZ(rm, 0), 11.4, .30, .26, yaw, 0,
      steel, .55, .80, 0, M_METAL, 0);
    this._boxAt(PX(rm, 0), deckY - 2.05, PZ(rm, 0), 11.4, .22, .22, yaw, 0,
      steel, .55, .80, 0, M_METAL, 0);
  }

  /* parapets: solid upstand, steel rail above, posts at intervals.
     Their collider carries an underside so it stops you on the deck
     without also walling off the motorway running beneath. */
  for (const t of [-1, 1]) {
    for (let k = 0; k < NSEG; k++) {
      const rm = abutIn + segLen * (k + .5);
      const px = PX(rm, t * (HW + .35)), pz = PZ(rm, t * (HW + .35));
      this._boxAt(px, deckY + .60, pz, .34, .90, segLen * 1.02, yaw, 0, conc, .84, 0, 0, M_CONCRETE, 0);
      this._boxAt(px, deckY + 1.12, pz, .46, .14, segLen * 1.02, yaw, 0, concD, .8, 0, 0, M_CONCRETE, 0);
      this._boxAt(px, deckY + 1.62, pz, .09, .10, segLen * 1.02, yaw, 0, rail, .40, .85, 0, M_METAL, 0);
      this._boxAt(px, deckY + 1.32, pz, .07, .08, segLen * 1.02, yaw, 0, rail, .40, .85, 0, M_METAL, 0);
      if (k % 2 === 0)
        this._boxAt(px, deckY + 1.30, pz, .10, .78, .10, yaw, 0, rail, .45, .82, 0, M_METAL, 0);
      this.addCollider(px - .5, pz - .5, px + .5, pz + .5, deckY + 1.4, deckY - .8);
    }
  }

  /* piers: one line in the central reservation, one just outside each
     carriageway. Tapered shaft, a cap spreading the load across the
     girders, bearings on top of the cap, and a barrier around the base
     so nobody drives into a bridge pier at motorway speed. */
  const pierR = [R, R - (GAP * .5 + CW + 3.2), R + (GAP * .5 + CW + 3.2)];
  for (const pr of pierR) {
    for (const t of [-4.2, 4.2]) {
      const px = PX(pr, t), pz = PZ(pr, t);
      const gnd = Terrain.h(px, pz);
      const h = deckY - 2.15 - gnd;
      if (h < 1) continue;
      this._cylAt(px, gnd + h * .5, pz, 1.05, h, conc, .86, 0, 0, M_CONCRETE, 0);
      this._cylAt(px, gnd + .55, pz, 1.35, 1.1, concD, .88, 0, 0, M_CONCRETE, 0);   // plinth
      this.addCollider(px - 1.3, pz - 1.3, px + 1.3, pz + 1.3, gnd + h, gnd - 1);
    }
    // pier cap across both shafts, then the bearings the deck sits on
    const cx = PX(pr, 0), cz = PZ(pr, 0);
    const cy = deckY - 2.15 + Terrain.h(cx, cz) * 0;
    this._boxAt(cx, cy, cz, 13.0, .95, 2.0, yaw, 0, conc, .85, 0, 0, M_CONCRETE, 0);
    this._boxAt(cx, cy + .62, cz, 12.2, .34, 1.5, yaw, 0, concD, .85, 0, 0, M_CONCRETE, 0);
    for (const t of [-5.4, -1.8, 1.8, 5.4])
      this._boxAt(PX(pr, t), cy + .92, PZ(pr, t), .70, .28, .70, yaw, 0,
        [.20, .21, .22], .5, .6, 0, M_METAL, 0);
    // crash barrier ringing the pier base
    for (const t of [-6.4, 6.4]) {
      const bx = PX(pr, t), bz = PZ(pr, t);
      this._boxAt(bx, Terrain.h(bx, bz) + .62, bz, .12, .34, 9.0, yaw, 0,
        [.42, .43, .45], .45, .85, 0, M_METAL, 0);
    }
  }

  /* abutments and their wing walls, plus the expansion joint you can
     hear as you cross onto the span */
  for (const s of [-1, 1]) {
    const ar = s < 0 ? abutIn : abutOut;
    const ax = PX(ar, 0), az = PZ(ar, 0);
    const gnd = Terrain.h(ax, az);
    const h = deckY - 1.2 - gnd;
    this._boxAt(ax + ca * s * 1.1, deckY - 1.2 - h * .5, az + sa * s * 1.1,
      HW * 2 + 2.6, h, 2.2, yaw, 0, conc, .87, 0, 0, M_CONCRETE, 0);
    this._boxAt(ax, deckY + .18, az, HW * 2, .05, .34, yaw, 0,
      [.14, .145, .15], .55, .3, 0, M_METAL, 0);
    for (const t of [-1, 1]) {
      const wx = PX(ar + s * 4.5, t * (HW + 1.9)), wz = PZ(ar + s * 4.5, t * (HW + 1.9));
      const wg = Terrain.h(wx, wz);
      this._boxAt(wx, deckY - .9 - (deckY - .9 - wg) * .5, wz,
        1.0, deckY - .9 - wg, 10.0, yaw, 0, conc, .87, 0, 0, M_CONCRETE, 0);
    }
  }

  /* ---------- the ramp diamond ---------- */
  const rInner = R - (GAP * .5 + CW * .5);
  const rOuter = R + (GAP * .5 + CW * .5);
  const approachY = (r) => {
    if (r <= abutIn && r >= footIn) return lerp(yIn, deckY, (r - footIn) / (abutIn - footIn));
    if (r >= abutOut && r <= footOut) return lerp(yOut, deckY, (footOut - r) / (footOut - abutOut));
    return deckY;
  };
  const RAMPS = [
    { rc: rInner, si: -1, ts: -1, rj: R - 82 },   // off, city side
    { rc: rInner, si: -1, ts: 1, rj: R - 82 },   // on,  city side
    { rc: rOuter, si: 1, ts: 1, rj: R + 82 },   // off, far side
    { rc: rOuter, si: 1, ts: -1, rj: R + 82 },   // on,  far side
  ];
  for (const rp of RAMPS) this._ramp(a, rp, approachY(rp.rj), yaw, rnd);

  /* a sign gantry on each carriageway warning of the junction */
  for (const rc of [rInner, rOuter]) {
    for (const ts of [-1, 1]) {
      const ang = a + ts * (210 / rc);
      const gx = Math.cos(ang) * rc, gz = Math.sin(ang) * rc;
      const gy = Terrain.h(gx, gz);
      const gyaw = Math.atan2(Math.cos(ang), Math.sin(ang)) + PI * .5;
      for (const o of [-1, 1]) {
        const px = gx + Math.cos(ang) * o * 6.4, pz = gz + Math.sin(ang) * o * 6.4;
        this._cylAt(px, Terrain.h(px, pz) + 3.4, pz, .16, 6.8, steel, .5, .8, 0, M_METAL, 0);
      }
      this._boxAt(gx, gy + 6.9, gz, .22, .22, 13.0, gyaw, 0, steel, .5, .8, 0, M_METAL, 0);
      this._boxAt(gx, gy + 5.9, gz, .12, 1.9, 8.4, gyaw, 0, [.06, .28, .12], .7, 0, .30, M_EMISSIVE, 2);
      this._boxAt(gx, gy + 6.4, gz, .14, .16, 6.4, gyaw, 0, [.85, .86, .84], .6, 0, .22, M_EMISSIVE, 1);
      this.lights.push({ p: [gx, gy + 6.2, gz], col: [.6, 1, .75], rad: 22, kind: 'sign' });
    }
  }
};

/* One ramp: a cubic from the motorway shoulder to the crossing road's
   embankment, climbing as it goes. Sampled into short straight links
   because that is what both the road slabs and the deck query want. */
World._ramp = function (a, rp, yEnd, axisYaw, rnd) {
  const R = Terrain.ringR, CW = this.ring.CW;
  const ca = Math.cos(a), sa = Math.sin(a);
  const road = [.058, .060, .065];
  const conc = [.50, .495, .48];

  const ang0 = a + rp.ts * (168 / rp.rc);
  const rEdge = rp.rc + rp.si * (CW * .5 + 2.8);
  const p0 = [Math.cos(ang0) * rEdge, Math.sin(ang0) * rEdge];
  const y0 = Terrain.h(p0[0], p0[1]);
  // heading along the motorway at the point the ramp leaves it
  const tan0 = [-Math.sin(ang0) * rp.ts, Math.cos(ang0) * rp.ts];
  const p3 = [ca * rp.rj, sa * rp.rj];
  const outward = rp.rj > R ? 1 : -1;
  const tan3 = [ca * outward, sa * outward];

  const c1 = [p0[0] + tan0[0] * 74, p0[1] + tan0[1] * 74];
  const c2 = [p3[0] - tan3[0] * 66, p3[1] - tan3[1] * 66];
  const bez = (t) => {
    const u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
    return [p0[0] * b0 + c1[0] * b1 + c2[0] * b2 + p3[0] * b3,
    p0[1] * b0 + c1[1] * b1 + c2[1] * b2 + p3[1] * b3];
  };

  const N = 20;
  const pts = [], ys = [];
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    pts.push(bez(t));
    // hold motorway level through the gore, then climb on a smooth curve
    const c = smoothstep(0.12, 0.94, t);
    ys.push(lerp(y0, yEnd, c));
  }

  const HW = 3.8;
  for (let k = 0; k < N; k++) {
    const A = pts[k], B = pts[k + 1];
    const dx = B[0] - A[0], dz = B[1] - A[1];
    const len = Math.hypot(dx, dz) || 1;
    const yaw = Math.atan2(dx, dz);
    const mx = (A[0] + B[0]) * .5, mz = (A[1] + B[1]) * .5;
    const my = (ys[k] + ys[k + 1]) * .5;
    const grade = (ys[k + 1] - ys[k]) / len;
    // the gore tapers out of the hard shoulder rather than starting full width
    const w = HW * (k < 3 ? 0.45 + 0.55 * (k / 3) : 1);
    this._boxAt(mx, my, mz, w * 2, .28, len * 1.08, yaw, grade, road, .90, 0, 0, M_ASPHALT, 1);
    this.addDeck(A[0], A[1], ys[k], B[0], B[1], ys[k + 1], w + .3);

    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (const s of [-1, 1]) {
      const ex = mx + rx * s * (w + .5), ez = mz + rz * s * (w + .5);
      const gnd = Terrain.h(ex, ez);
      const lift = my - gnd;
      if (lift > 0.9) {
        // once it is off the ground it needs holding up and fencing in
        this._boxAt(ex, my - lift * .5, ez, .8, lift, len * 1.05, yaw, 0, conc, .88, 0, 0, M_CONCRETE, 0);
        this._boxAt(ex, my + .58, ez, .10, .32, len * 1.05, yaw, grade,
          [.42, .43, .45], .45, .85, 0, M_METAL, 0);
        this.addCollider(ex - .7, ez - .7, ex + .7, ez + .7, my + .7, my - .9);
      } else {
        this._boxAt(ex, my - .06, ez, .55, .34, len * 1.05, yaw, grade,
          [.46, .455, .44], .82, 0, 0, M_CONCRETE, 0);
      }
    }
    if (k % 6 === 3) {
      const lx = mx + rx * (w + 1.5), lz = mz + rz * (w + 1.5);
      this._cylAt(lx, my + 3.9, lz, .11, 7.8, [.36, .37, .39], .5, .8, 0, M_METAL, 0);
      this.lights.push({ p: [lx, my + 7.6, lz], col: [1, .92, .78], rad: 26, kind: 'street' });
    }
  }

  // chevron board in the gore, where the ramp splits off the carriageway
  const gx = pts[1][0], gz = pts[1][1];
  this._boxAt(gx, Terrain.h(gx, gz) + 1.1, gz, 2.0, 1.3, .12,
    Math.atan2(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1]), 0,
    [.85, .55, .06], .5, 0, .5, M_EMISSIVE, 1);
};

/* ---------- viaduct arcading where the ring rides high ----------
   The motorway corridor is levelled into the hills, so where the land
   falls away beside it the road is standing on a bank several storeys
   deep. Facing that bank with arches turns an unexplained wall into the
   structure that is obviously holding the road up. */
World._viaducts = function (rnd) {
  const R = Terrain.ringR, CW = this.ring.CW, GAP = this.ring.GAP;
  const conc = [.46, .45, .43], concD = [.37, .365, .35];
  const SEG = 168, segLen = TAU * R / SEG;
  const edge = GAP * .5 + CW + 3.0;
  const bridgeA = (this.bridges || []).map(b => b.a);

  /* Exactly where the terrain narrowed its corridor, so the structure and
     the ground it stands in were decided by the same number. Junctions are
     skipped: their own piers are already there. */
  const deep = [];
  for (let k = 0; k < SEG; k++) {
    const am = (k + .5) / SEG * TAU;
    let nearJunction = false;
    for (const a of bridgeA) if (Math.abs(wrapPi(am - a)) * R < 200) nearJunction = true;
    deep.push(!nearJunction && Terrain.deepAt(am) > 0.45);
  }
  const runs = [];
  let k = 0;
  while (k < SEG) {
    if (!deep[k]) { k++; continue; }
    let e = k;
    while (e + 1 < SEG && deep[e + 1]) e++;
    if (e - k + 1 >= 5) runs.push([k, e]);
    k = e + 1;
  }

  let built = 0;
  for (const [k0, k1] of runs) {
    for (let kk = k0; kk <= k1; kk++) {
      const am = (kk + .5) / SEG * TAU;
      const roadY = Terrain.h(Math.cos(am) * R, Math.sin(am) * R);
      const yawS = am + PI * .5;
      for (const s of [-1, 1]) {
        const ex = Math.cos(am) * (R + s * edge), ez = Math.sin(am) * (R + s * edge);
        // just outside the narrowed corridor, where the valley floor is real
        const gx = Math.cos(am) * (R + s * 52), gz = Math.sin(am) * (R + s * 52);
        const gnd = Math.min(Terrain.h(gx, gz), roadY - 2);
        const h = roadY - gnd;
        if (h < 4) continue;
        built++;
        // pier, then the spandrel over it: the gap between piers is the arch
        this._boxAt(ex, gnd + h * .5, ez, 2.0, h, segLen * .42, yawS, 0, conc, .88, 0, 0, M_CONCRETE, 0);
        this._boxAt(ex, roadY - h * .15, ez, 2.2, h * .30, segLen * 1.02, yawS, 0, concD, .9, 0, 0, M_CONCRETE, 0);
        this._boxAt(ex, roadY - .30, ez, 2.6, .62, segLen * 1.04, yawS, 0, conc, .85, 0, 0, M_CONCRETE, 0);
        // splayed footing where the pier meets the valley floor
        this._boxAt(ex, gnd + .6, ez, 2.9, 1.2, segLen * .52, yawS, 0, concD, .9, 0, 0, M_CONCRETE, 0);
        this.addCollider(ex - 1.3, ez - 1.3, ex + 1.3, ez + 1.3, roadY - 0.2, gnd - 1);
      }
    }
  }
  this.viaducts = runs.length;
  this.viaductSegs = built;
};
