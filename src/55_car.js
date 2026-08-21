'use strict';
/* ============================================================
   Apex Drive — vehicle models
   Local space: +X right, +Y up, +Z forward (nose)
   ============================================================ */

/* loft an open band (subrange of a closed outline) — used for roof panels */
function loftBand(stations, i0, i1, push) {
  const g = new Geo();
  const rows = [];
  for (let s = 0; s < stations.length; s++) {
    const st = stations[s], row = [];
    for (let i = i0; i <= i1; i++) {
      const k = ((i % st.pts.length) + st.pts.length) % st.pts.length;
      const p = st.pts[k];
      const l = Math.hypot(p[0], p[1] - st.cy) || 1;
      row.push(g.v(p[0] + p[0] / l * push, p[1] + (p[1] - st.cy) / l * push, st.z, 0, 0, 0, (i - i0) / (i1 - i0), s / (stations.length - 1)));
    }
    rows.push(row);
  }
  for (let s = 0; s < stations.length - 1; s++)
    for (let i = 0; i < i1 - i0; i++)
      g.quad(rows[s][i], rows[s][i + 1], rows[s + 1][i + 1], rows[s + 1][i]);
  g.smooth();
  return g;
}

const CAR_SECT = 24; // outline points per station
/* profile arrays are authored nose-first; station params run tail->nose */
const pf = (arr, t) => catmull(arr, 1 - clamp01(t));

function bodyStationAt(spec, t, bodyW) {
  const P = spec.profile, L = spec.len;
  const z = lerp(-L / 2, L / 2, t);
  const hw = pf(P.width, t) * spec.width * .5;
  const yb = pf(P.sill, t), yt = pf(P.belt, t);
  const cy = (yb + yt) * .5, b = Math.max((yt - yb) * .5, .015);
  const pts = squircle(Math.max(hw, .02), b, pf(P.round, t), CAR_SECT, pf(P.taperT, t), pf(P.taperB, t));
  for (const q of pts) q[1] += cy;
  return { z, pts, cy };
}

function bodyStations(spec, n, bodyW) {
  const P = spec.profile, L = spec.len, out = [];
  for (let s = 0; s < n; s++) {
    const t = s / (n - 1);
    const z = lerp(-L / 2, L / 2, t);
    const hw = pf(P.width, t) * spec.width * .5;
    const yb = pf(P.sill, t);
    const yt = pf(P.belt, t);
    const cy = (yb + yt) * .5, b = Math.max((yt - yb) * .5, .015);
    const pts = squircle(Math.max(hw, .02), b, pf(P.round, t), CAR_SECT, pf(P.taperT, t), pf(P.taperB, t));
    for (const p of pts) p[1] += cy;
    out.push({ z, pts, cy });
  }
  return out;
}

function cabinStations(spec, n, bodyW) {
  const P = spec.profile, C = P.cabin, out = [];
  for (let s = 0; s < n; s++) {
    const t = s / (n - 1);
    const z = lerp(C.z0, C.z1, t);
    const tb = (z + spec.len / 2) / spec.len;
    const yb = pf(P.belt, tb) - .04;
    const yt = Math.max(pf(C.roof, t), yb + .02);
    const hw = pf(C.width, t) * spec.width * .5;
    const cy = (yb + yt) * .5, b = (yt - yb) * .5;
    const pts = squircle(Math.max(hw, .02), b, 3.2, CAR_SECT, pf(C.taper, t), 0);
    for (const p of pts) p[1] += cy;
    out.push({ z, pts, cy });
  }
  return out;
}

/* --------------------------------------------------------
   Build all meshes for one car spec.
   returns { paint, dark, glass, chrome, lightF, lightR, brake,
             tire, rim, wheelR, wheelW }
   -------------------------------------------------------- */
const SAG = CAR_SAG;   // static suspension sag: body origin height at rest

function shiftGeo(g, dy) {
  for (let i = 1; i < g.p.length; i += 3) g.p[i] += dy;
  return g;
}

/* --------------------------------------------------------
   Build every mesh for one car. Profile heights are authored
   in metres above the road; the whole car is shifted down by
   the static sag at the end so it sits correctly on its wheels.
   -------------------------------------------------------- */
function buildCar(spec) {
  const L = spec.len, W = spec.width;
  const bodyW = W * (spec.bodyW || 0.88);
  const paint = new Geo(), dark = new Geo(), glass = new Geo(), chrome = new Geo();
  const lightF = new Geo(), lightR = new Geo(), brake = new Geo();
  const I = M4.n();
  const T = (x, y, z, sx, sy, sz, ry) => M4.trs(M4.n(), x, y, z, ry || 0,
    sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
  const RX = (x, y, z, ang) => {   // translate + rotate about X
    const m = M4.n(), c = Math.cos(ang), sn = Math.sin(ang);
    m[0] = 1; m[5] = c; m[6] = sn; m[9] = -sn; m[10] = c;
    m[12] = x; m[13] = y; m[14] = z; return m;
  };
  const belt = t => catmull(spec.profile.belt, t);

  /* ---------------- lower body ---------------- */
  const bs = bodyStations(spec, 30, bodyW);
  paint.append(loft(bs, true, true), I);
  // shoulder character lines: a proud ridge each side so the flank catches light
  const shoulder = Math.round(CAR_SECT * 0.085);
  paint.append(loftBand(bs, shoulder - 1, shoulder + 1, .017), I);
  paint.append(loftBand(bs, CAR_SECT / 2 - shoulder - 1, CAR_SECT / 2 - shoulder + 1, .017), I);
  // lower rocker crease
  paint.append(loftBand(bs, CAR_SECT - shoulder - 1, CAR_SECT - shoulder + 1, .012), I);
  paint.append(loftBand(bs, CAR_SECT / 2 + shoulder - 1, CAR_SECT / 2 + shoulder + 1, .012), I);

  /* ---------------- greenhouse ---------------- */
  const cs = cabinStations(spec, 18, bodyW);
  glass.append(loft(cs, true, true), I);
  const q = CAR_SECT / 4;
  const rw = Math.max(2, Math.round(CAR_SECT * 0.09));
  paint.append(loftBand(cs, q - rw, q + rw, .013), I);          // roof skin
  paint.append(loftBand(cs, CAR_SECT - 1, CAR_SECT + 1, .011), I);  // right shoulder
  paint.append(loftBand(cs, CAR_SECT / 2 - 1, CAR_SECT / 2 + 1, .011), I); // left shoulder

  /* pillars */
  const pillar = (z, w, tilt) => {
    const tb = clamp01((z + L / 2) / L);
    const yb = belt(tb) - .03;
    const tt = clamp01((z - spec.profile.cabin.z0) / (spec.profile.cabin.z1 - spec.profile.cabin.z0));
    const yt = catmull(spec.profile.cabin.roof, tt);
    const hw = catmull(spec.profile.cabin.width, tt) * bodyW * .5;
    for (const sx of [-1, 1]) {
      const h = Math.max(yt - yb, .05) * 1.03;
      paint.append(geoBox(w, h, .09), RX(sx * hw * .93, (yb + yt) * .5, z, tilt));
    }
  };
  pillar(spec.profile.cabin.z1 - .07, .072, -0.60);
  pillar(spec.profile.cabin.z0 + .10, .072, 0.52);
  if (spec.cpillar) pillar(spec.profile.cabin.z0 + .58, .066, 0.28);

  /* ---------------- wheel arches + wells ---------------- */
  const archAt = (z, track, r, flare) => {
    for (const sx of [-1, 1]) {
      const hw = spec.wheelW * .5 + flare;
      // inner fender liner, kept narrower than the tyre so it hides behind it
      dark.append(geoArch3(r * 1.01, spec.wheelW * .5 - .055, .085, 0.10 * PI, 0.90 * PI, 14),
        T(sx * track, r, z));
      // painted flare arching over the top
      paint.append(geoArch3(r * 1.17, hw, .07, 0.08 * PI, 0.92 * PI, 20, .30),
        T(sx * track, r, z));
    }
  };
  archAt(spec.axleF, spec.trackF, spec.wheelR, spec.flareF === undefined ? .055 : spec.flareF);
  archAt(spec.axleR, spec.trackR, spec.wheelR, spec.flareR === undefined ? .075 : spec.flareR);

  /* ---------------- sills, splitter, diffuser ---------------- */
  const sillY = catmull(spec.profile.sill, .5) + .03;
  for (const sx of [-1, 1])
    dark.append(geoBox(.10, .10, L * .40), T(sx * (bodyW * .5 - .01), sillY, (spec.axleF + spec.axleR) * .5));
  dark.append(geoBox(W * .86, .045, .34), T(0, catmull(spec.profile.sill, .96) - .01, L * .5 - .19));
  for (const sx of [-1, 1])  // canards
    dark.append(geoBox(.16, .022, .12, 0, 1, 1, 1), T(sx * W * .40, catmull(spec.profile.sill, .95) + .13, L * .5 - .32));
  dark.append(geoBox(W * .60, .085, .34), T(0, catmull(spec.profile.sill, .04) + .035, -L * .5 + .30));
  for (let i = -2; i <= 2; i++)
    dark.append(geoBox(.030, .095, .26), T(i * W * .11, catmull(spec.profile.sill, .04) + .055, -L * .5 + .31));

  /* ---------------- nose: grille + intakes ---------------- */
  const gz = L * .5 - .055, gy = spec.grilleY;
  dark.append(geoBox(W * .50, .20, .13), T(0, gy, gz - .03));
  dark.append(geoGrilleMesh(W * .46, .17, .05, 11, 4), T(0, gy, gz + .01));
  chrome.append(geoBox(W * .54, .030, .10), T(0, gy + .108, gz + .015));
  chrome.append(geoBox(W * .54, .028, .10), T(0, gy - .105, gz + .015));
  for (const sx of [-1, 1]) chrome.append(geoBox(.028, .21, .10), T(sx * W * .26, gy, gz + .015));
  chrome.append(geoBox(.10, .05, .04), T(0, gy + .19, gz + .02));     // badge
  for (const sx of [-1, 1]) {
    dark.append(geoBox(W * .16, .13, .12), T(sx * W * .35, gy - .035, gz - .01));
    dark.append(geoGrilleMesh(W * .14, .10, .04, 5, 3), T(sx * W * .35, gy - .035, gz + .02));
  }
  // side intakes ahead of the rear wheels
  for (const sx of [-1, 1]) {
    dark.append(geoBox(.09, .17, .46), T(sx * (bodyW * .5 + .01), belt(.42) - .18, spec.axleR + .70));
    dark.append(geoBox(.05, .13, .34), T(sx * (bodyW * .5 + .035), belt(.42) - .18, spec.axleR + .70));
  }

  /* ---------------- hood detail ---------------- */
  const hoodZ = lerp(spec.axleF, L * .5, .42);
  const hoodY = belt((hoodZ + L / 2) / L);
  paint.append(geoRounded(bodyW * .46, .055, L * .17, .045, 5), T(0, hoodY - .022, hoodZ));
  for (const sx of [-1, 1])
    dark.append(geoBox(.13, .02, .22), T(sx * bodyW * .20, hoodY + .022, hoodZ + .04));
  // rear deck vents
  for (let i = 0; i < 3; i++)
    dark.append(geoBox(W * .34, .018, .05), T(0, spec.deckY, -L * .16 - i * .12));

  /* ---------------- lights ---------------- */
  const hy = spec.lightY, hz = L * .5 - .085;
  for (const sx of [-1, 1]) {
    chrome.append(geoRounded(spec.lampW + .05, .155, .07, .025, 5), T(sx * W * .33, hy, hz - .045));
    lightF.append(geoRounded(spec.lampW, .105, .075, .032, 6), T(sx * W * .33, hy, hz));
    for (const o of [-1, 1])
      lightF.append(geoProjector(.042, .05, 12), T(sx * W * .33 + o * spec.lampW * .24, hy, hz + .03,
        1, 1, 1));
    // daytime running strip
    lightF.append(geoBox(spec.lampW * .92, .018, .03), T(sx * W * .33, hy - .062, hz + .025));
  }
  const ty = spec.tailY, tz = -L * .5 + .05;
  // recessed black surround so the lamps read as inset units, not stickers
  // slim bezel that hugs the lamps rather than a full-width black band
  if (spec.tailBar) {
    dark.append(geoBox(W * .82, .145, .05), T(0, ty, tz - .028));
    lightR.append(geoRounded(W * .80, .115, .075, .030, 6), T(0, ty, tz + .012));
    for (const sx of [-1, 1]) {
      lightR.append(geoRounded(W * .21, .165, .075, .034, 6), T(sx * W * .31, ty, tz + .020));
      // inner reflector detail
      dark.append(geoBox(W * .15, .035, .03), T(sx * W * .31, ty + .035, tz + .058));
    }
  } else {
    for (const sx of [-1, 1]) {
      dark.append(geoBox(W * .30, .185, .05), T(sx * W * .29, ty, tz - .028));
      lightR.append(geoRounded(W * .28, .155, .075, .034, 6), T(sx * W * .29, ty, tz + .015));
      lightR.append(geoBox(W * .23, .028, .05), T(sx * W * .29, ty - .095, tz + .02));
      dark.append(geoBox(W * .20, .03, .03), T(sx * W * .29, ty + .03, tz + .055));
    }
  }
  // reversing / fog lamps low in the bumper
  for (const sx of [-1, 1]) {
    dark.append(geoBox(.12, .055, .04), T(sx * W * .24, ty - .19, tz + .008));
  }
  brake.append(geoRounded(W * .36, .042, .05, .016, 4), T(0, ty + .175, tz + .03));
  for (const sx of [-1, 1]) chrome.append(geoBox(.09, .04, .035), T(sx * W * .17, ty - .10, tz));
  // plate
  chrome.append(geoBox(.36, .13, .022), T(0, ty - .34, tz + .02));
  dark.append(geoBox(.42, .17, .02), T(0, ty - .34, tz + .008));

  /* ---------------- mirrors, handles ---------------- */
  for (const sx of [-1, 1]) {
    const mz = spec.profile.cabin.z1 - .10;
    const y = belt(clamp01((mz + L / 2) / L)) + .05;
    dark.append(geoBox(.055, .03, .11), T(sx * (bodyW * .5 - .01), y, mz));
    paint.append(geoRounded(.07, .095, .175, .035, 5), T(sx * (bodyW * .5 + .085), y + .045, mz - .02));
    dark.append(geoBox(.02, .075, .145), T(sx * (bodyW * .5 + .12), y + .045, mz - .02));
    chrome.append(geoBox(.026, .032, .15), T(sx * (bodyW * .5 + .002), belt(.5) - .11, -L * .02));
  }

  /* ---------------- wing / ducktail ---------------- */
  if (spec.wing) {
    const wz = -L * .5 + spec.wing.z, wy = spec.wing.y;
    paint.append(geoBox(W * .94, .042, spec.wing.chord), T(0, wy, wz));
    paint.append(geoBox(W * .94, .036, spec.wing.chord * .5), T(0, wy - .045, wz - spec.wing.chord * .26));
    for (const sx of [-1, 1]) {
      dark.append(geoBox(.045, spec.wing.h, .14), T(sx * W * .38, wy - spec.wing.h * .5, wz));
      chrome.append(geoBox(.05, .02, .10), T(sx * W * .38, wy - spec.wing.h, wz));
    }
    if (spec.wing.gurney) paint.append(geoBox(W * .94, .048, .026), T(0, wy + .043, wz - spec.wing.chord * .5));
  } else if (spec.ducktail) {
    paint.append(geoRounded(W * .86, .065, .21, .045, 5), T(0, spec.ducktail.y, -L * .5 + spec.ducktail.z));
  }

  /* ---------------- exhausts ---------------- */
  const ez = -L * .5 + .10, ey = catmull(spec.profile.sill, .05) + .14;
  const pipes = spec.quadPipes ? [-1.75, -1.05, 1.05, 1.75] : [-1, 1];
  for (const sx of pipes) {
    const m = M4.mul(M4.n(), T(sx * W * .155, ey, ez), (() => {
      const r = M4.n(); r[5] = 0; r[6] = -1; r[9] = 1; r[10] = 0; return r;
    })());
    chrome.append(geoCyl(.053, .048, .13, 16, true), m);
    dark.append(geoCyl(.038, .038, .07, 12, true), M4.mul(M4.n(), T(sx * W * .155, ey, ez + .035), (() => {
      const r = M4.n(); r[5] = 0; r[6] = -1; r[9] = 1; r[10] = 0; return r;
    })()));
  }

  /* ---------------- interior ---------------- */
  const cz = (spec.profile.cabin.z0 + spec.profile.cabin.z1) * .5;
  const bY = belt(clamp01((cz + L / 2) / L));
  dark.append(geoBox(bodyW * .82, .10, 1.15), T(0, bY - .17, cz));                    // floor
  dark.append(geoBox(bodyW * .84, .16, .30), T(0, bY - .02, cz + .62));                // dash
  for (const sx of [-1, 1]) {
    dark.append(geoRounded(.36, .34, .14, .06, 4), T(sx * bodyW * .21, bY + .02, cz - .32)); // seat back
    dark.append(geoRounded(.36, .12, .42, .05, 4), T(sx * bodyW * .21, bY - .16, cz - .06)); // squab
    dark.append(geoBox(.16, .11, .10), T(sx * bodyW * .21, bY + .22, cz - .34));            // headrest
  }
  chrome.append(geoTorus(.145, .020, 18, 8), M4.mul(M4.n(),
    T(-bodyW * .21 * spec.rhd, bY - .01, cz + .42),
    (() => { const r = M4.n(), c = Math.cos(1.22), sn = Math.sin(1.22); r[5] = c; r[6] = sn; r[9] = -sn; r[10] = c; return r; })()));
  if (spec.cage) {
    for (const sx of [-1, 1]) {
      dark.append(geoCyl(.028, .028, .55, 10, true), T(sx * bodyW * .34, bY + .30, cz - .34));
      dark.append(geoBox(.05, .05, bodyW * .68, 0, 1, 1, 1), RX(0, bY + .56, cz - .34, PI / 2));
    }
  }

  /* ---------------- optional racing stripe ---------------- */
  const stripe = new Geo();
  {
    const w = 1;                       // a 3-point band across the very top
    const q2 = CAR_SECT / 4;
    // only the bonnet and boot decks, never the nose and tail caps where the
    // outline collapses and the band fans out into a slab
    const deck = bs.filter(st => {
      const t = (st.z + L / 2) / L;
      return t > 0.10 && t < 0.90;
    });
    if (deck.length > 2) stripe.append(loftBand(deck, q2 - w, q2 + w, 0.008), I);
    stripe.append(loftBand(cs, q2 - w, q2 + w, 0.016), I);
  }

  /* ---------------- per-model signature bodywork ---------------- */
  addDetail(spec, { paint, dark, glass, chrome, lightF, lightR, brake },
    { T, RX, L, W, bodyW, belt });

  /* ---------------- wheels ---------------- */
  const R = spec.wheelR, WW = spec.wheelW;
  const tire = geoTyre(R, WW);
  const rim = geoRim(R, WW, spec.spokes || 5, spec.rimStyle || 'split');
  const rimR = R * .575;
  const disc = geoLatheX([[rimR * .32, -.020], [rimR * .90, -.020], [rimR * .90, .020], [rimR * .32, .020]], 24, true);
  const caliperG = new Geo();
  caliperG.append(geoRounded(.06, rimR * .90, rimR * .34, .02, 4), T(-.05, rimR * .55, 0));

  for (const g of [paint, dark, glass, chrome, lightF, lightR, brake, stripe]) shiftGeo(g, -SAG);

  return {
    spec,
    paint: paint.done(), dark: dark.done(), glass: glass.done(), chrome: chrome.done(),
    lightF: lightF.done(), lightR: lightR.done(), brakeL: brake.done(),
    stripe: stripe.done(),
    tire: tire.done(), rim: rim.done(), disc: disc.done(), caliper: caliperG.done()
  };
}

/* ============================================================
   Car catalogue
   ============================================================ */
const CAR_SPECS = [
  {
    id: 'vypr', price: 168000, name: 'Auros Vyra V10', cls: 'Supercar',
    len: 4.52, width: 2.00, bodyW: .87, wheelR: .345, wheelW: .34, spokes: 5, rimStyle: 'split', rhd: 1,
    flareF: .065, flareR: .105, cage: 0, cpillar: 0, quadPipes: 1,
    grilleY: .44, lightY: .68, lampW: .30, tailY: .76, tailBar: 1, deckY: .96,
    axleF: 1.42, axleR: -1.36, trackF: .82, trackR: .86,
    wing: { z: .34, y: 1.02, chord: .30, h: .20, gurney: 1 },
    sig: { midEngine: 1, buttress: 1, louvres: 1, yLamps: 1,
           centreExhaust: 1, finTail: 1, canards: 1 },
    /* 5.2 naturally aspirated V10: short equal-length pipes, a hard
       open tail and a big high plenum. Formant-wise it is all top end. */
    voice: { pipe: 1.98, pipe2: 2.09, head: 0.79, refl: .79, damp: 5600,
             plenum: 340, plenumQ: 4.2, intake: 1.50, drive: 2.5, rasp: .95,
             lope: .03, idle: 1080 },
    profile: {
      width: [.66, .92, 1.00, 1.00, 1.00, .96, .78],
      sill:  [.26, .14, .11, .11, .11, .15, .28],
      belt:  [.58, .70, .80, .86, .88, .88, .80],
      round: [3.0, 3.5, 4.0, 4.4, 4.2, 3.7, 3.0],
      taperT:[.30, .22, .14, .10, .10, .16, .28],
      taperB:[.30, .20, .12, .10, .12, .20, .34],
      cabin: { z0: -1.28, z1: .60, roof: [.86, 1.06, 1.15, 1.16, 1.09, .94],
               width: [.78, .90, .93, .92, .86, .70], taper: [.34, .26, .22, .24, .30, .42] }
    },
    phys: { cylinders: 10, sound: 'v10', mass: 1420, power: 470, redline: 8600, gears: [3.4, 2.20, 1.62, 1.28, 1.02, .84], final: 3.55, drive: 'awd', gripF: 1.62, gripR: 1.72, cgH: .40, drag: .32, dfF: .55, dfR: .95, brake: 2.35, steerMax: .60 }
  },
  {
    id: 'kestrel', price: 74000, name: 'Marlowe Sabre GT', cls: 'Grand Tourer',
    len: 4.78, width: 1.94, bodyW: .89, wheelR: .355, wheelW: .30, spokes: 10, rimStyle: 'mesh', rhd: 1,
    flareF: .055, flareR: .085, cage: 0, cpillar: 1, quadPipes: 0,
    grilleY: .50, lightY: .76, lampW: .26, tailY: .84, tailBar: 0, deckY: 1.02,
    axleF: 1.48, axleR: -1.42, trackF: .80, trackR: .82,
    ducktail: { y: .98, z: .30 },
    sig: { chromeTrim: 1, roundTails: 1, fourDoor: 0 },
    /* cross-plane V8 in a long GT: mid-length pipes, a muffler still in
       the loop softening the reflection, and a plenum tuned for torque. */
    voice: { pipe: 2.36, pipe2: 2.49, head: 0.88, refl: .70, damp: 3600,
             plenum: 230, plenumQ: 3.0, intake: 1.10, drive: 2.1, rasp: .45,
             lope: .10, idle: 820 },
    profile: {
      width: [.66, .93, 1.00, 1.00, .99, .95, .78],
      sill:  [.28, .16, .13, .13, .13, .17, .30],
      belt:  [.66, .80, .90, .96, .98, .96, .88],
      round: [3.2, 3.7, 4.1, 4.5, 4.3, 3.9, 3.2],
      taperT:[.26, .18, .12, .10, .10, .14, .26],
      taperB:[.28, .18, .12, .10, .12, .18, .30],
      cabin: { z0: -1.52, z1: .52, roof: [.96, 1.18, 1.29, 1.30, 1.24, 1.04],
               width: [.80, .92, .95, .94, .88, .72], taper: [.30, .22, .18, .20, .26, .40] }
    },
    phys: { cylinders: 8, sound: 'v8', mass: 1620, power: 405, redline: 7400, gears: [3.2, 2.05, 1.50, 1.18, .96, .80], final: 3.35, drive: 'rwd', gripF: 1.50, gripR: 1.58, cgH: .44, drag: .34, dfF: .35, dfR: .55, brake: 2.05, steerMax: .58 }
  },
  {
    id: 'bruiser', price: 38000, name: 'Corbin Brute 440', cls: 'Muscle',
    len: 4.96, width: 1.98, bodyW: .90, wheelR: .365, wheelW: .34, spokes: 5, rimStyle: 'split', rhd: 1,
    flareF: .06, flareR: .115, cage: 0, cpillar: 1, quadPipes: 1,
    grilleY: .58, lightY: .84, lampW: .24, tailY: .90, tailBar: 1, deckY: 1.08,
    axleF: 1.52, axleR: -1.48, trackF: .82, trackR: .85,
    ducktail: { y: 1.06, z: .28 },
    sig: { quadLamps: 1, hoodScoop: 1, sideExhaust: 1, bonnetPins: 1 },
    /* big-bore pushrod V8: long, fat, low-damped pipes, so the comb sits
       low and the burble is enormous. The lope is a lumpy cam. */
    voice: { pipe: 3.06, pipe2: 3.25, head: 1.02, refl: .75, damp: 2400,
             plenum: 165, plenumQ: 2.4, intake: .95, drive: 2.3, rasp: .30,
             lope: .34, idle: 700 },
    profile: {
      width: [.70, .95, 1.00, 1.00, 1.00, .96, .82],
      sill:  [.30, .19, .16, .16, .16, .20, .32],
      belt:  [.78, .92, 1.02, 1.06, 1.08, 1.06, .98],
      round: [3.6, 4.1, 4.7, 5.0, 4.8, 4.3, 3.6],
      taperT:[.20, .14, .09, .07, .07, .11, .20],
      taperB:[.24, .16, .10, .08, .10, .16, .26],
      cabin: { z0: -1.60, z1: .36, roof: [1.06, 1.28, 1.40, 1.42, 1.38, 1.18],
               width: [.84, .94, .96, .95, .90, .76], taper: [.26, .18, .14, .16, .22, .36] }
    },
    phys: { cylinders: 8, sound: 'v8', mass: 1740, power: 455, redline: 6400, gears: [2.95, 1.85, 1.36, 1.06, .86, .74], final: 3.70, drive: 'rwd', gripF: 1.36, gripR: 1.42, cgH: .48, drag: .40, dfF: .18, dfR: .28, brake: 1.80, steerMax: .55 }
  },
  {
    id: 'nomad', price: 62000, name: 'Sable Nomad XR', cls: 'Crossover',
    len: 4.72, width: 1.96, bodyW: .91, wheelR: .45, wheelW: .32, spokes: 7, rimStyle: 'split', rhd: 1,
    flareF: .055, flareR: .075, cage: 0, cpillar: 1, quadPipes: 0,
    grilleY: .84, lightY: 1.06, lampW: .26, tailY: 1.16, tailBar: 0, deckY: 1.50,
    axleF: 1.42, axleR: -1.40, trackF: .80, trackR: .81,
    sig: { roofRails: 1, cladding: 1, skidPlates: 1, spareWheel: 1, fourDoor: 1 },
    /* family crossover: a real muffler, so the reflection is weak and
       everything above 1.5 kHz dies inside the pipe. Deliberately dull. */
    voice: { pipe: 2.76, pipe2: 2.86, head: 0.95, refl: .47, damp: 1500,
             plenum: 190, plenumQ: 2.0, intake: .70, drive: 1.5, rasp: .18,
             lope: .06, idle: 780 },
    profile: {
      width: [.72, .95, 1.00, 1.00, 1.00, .97, .84],
      sill:  [.54, .46, .44, .44, .44, .47, .56],
      belt:  [1.02, 1.14, 1.22, 1.26, 1.28, 1.26, 1.18],
      round: [3.6, 4.1, 4.7, 5.0, 4.8, 4.4, 3.8],
      taperT:[.20, .12, .08, .06, .06, .10, .20],
      taperB:[.22, .14, .10, .08, .10, .14, .24],
      cabin: { z0: -1.70, z1: .66, roof: [1.38, 1.60, 1.69, 1.70, 1.68, 1.58],
               width: [.86, .95, .97, .97, .94, .84], taper: [.22, .14, .12, .12, .16, .28] }
    },
    phys: { cylinders: 6, sound: 'v6', mass: 1930, power: 360, redline: 6800, gears: [3.6, 2.30, 1.68, 1.30, 1.02, .84], final: 3.60, drive: 'awd', gripF: 1.40, gripR: 1.44, cgH: .60, drag: .44, dfF: .10, dfR: .16, brake: 1.85, steerMax: .56 }
  },
  {
    id: 'vector', price: 245000, name: 'Auros Vektor RS', cls: 'Track Weapon',
    len: 4.62, width: 2.04, bodyW: .86, wheelR: .35, wheelW: .38, spokes: 6, rimStyle: 'mesh', rhd: 1,
    flareF: .075, flareR: .125, cage: 1, cpillar: 0, quadPipes: 1,
    grilleY: .38, lightY: .60, lampW: .26, tailY: .70, tailBar: 1, deckY: .90,
    axleF: 1.46, axleR: -1.40, trackF: .86, trackR: .90,
    wing: { z: .20, y: 1.14, chord: .36, h: .34, gurney: 1 },
    sig: { swanWing: 1, canards: 1, towHook: 1, bonnetPins: 1, roofScoop: 1 },
    /* flat-plane race V8: the shortest, hardest, brightest pipes here,
       with almost nothing absorbing the reflection. It screams. */
    voice: { pipe: 1.81, pipe2: 1.89, head: 0.74, refl: .84, damp: 6800,
             plenum: 380, plenumQ: 4.6, intake: 1.65, drive: 2.9, rasp: 1.05,
             lope: .02, idle: 1250 },
    profile: {
      width: [.68, .95, 1.00, 1.00, 1.00, .98, .84],
      sill:  [.22, .10, .08, .08, .08, .12, .24],
      belt:  [.52, .64, .74, .80, .82, .82, .74],
      round: [3.0, 3.4, 3.8, 4.2, 4.0, 3.6, 3.0],
      taperT:[.34, .24, .16, .12, .12, .18, .30],
      taperB:[.32, .22, .14, .10, .12, .20, .34],
      cabin: { z0: -1.22, z1: .54, roof: [.82, 1.02, 1.09, 1.10, 1.03, .88],
               width: [.76, .88, .91, .90, .84, .68], taper: [.36, .28, .24, .26, .32, .44] }
    },
    phys: { cylinders: 8, sound: 'v8f', mass: 1290, power: 540, redline: 9200, gears: [3.6, 2.35, 1.72, 1.34, 1.06, .86], final: 3.85, drive: 'rwd', gripF: 1.74, gripR: 1.88, cgH: .36, drag: .30, dfF: .85, dfR: 1.45, brake: 2.60, steerMax: .62 }
  }
];


/* traffic vehicles: cheap boxy shells, still readable as cars */
function buildTrafficCar(seed) {
  const r = mulberry32(seed | 0);
  const L = 4.10 + r() * 1.15, W = 1.76 + r() * 0.16, H = 0.60 + r() * 0.18;
  const paint = new Geo(), glass = new Geo(), dark = new Geo(), lightF = new Geo(), lightR = new Geo();
  const T = (x, y, z, sx, sy, sz) => M4.trs(M4.n(), x, y, z, 0,
    sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
  const sill = 0.30, belt = sill + H;

  // main body
  paint.append(geoRounded(W, H, L, .13, 6), T(0, (sill + belt) * .5, 0));
  // shoulder line: a slightly narrower slab on top of the body for a crease
  paint.append(geoRounded(W * .97, .12, L * .95, .05, 5), T(0, belt - .02, 0));

  // greenhouse: shorter than the body and set back a little
  const cabH = 0.50 + r() * 0.18, cl = L * (0.40 + r() * 0.07), cz = -L * 0.05;
  glass.append(geoRounded(W * .88, cabH, cl, .10, 5), T(0, belt + cabH * .5 - .05, cz));
  // painted roof + pillars so it does not read as a glass box
  paint.append(geoRounded(W * .80, .07, cl * .80, .035, 4), T(0, belt + cabH - .06, cz));
  for (const sx of [-1, 1]) {
    paint.append(geoBox(.055, cabH * .92, .07), T(sx * W * .42, belt + cabH * .5 - .06, cz + cl * .46));
    paint.append(geoBox(.055, cabH * .92, .07), T(sx * W * .42, belt + cabH * .5 - .06, cz - cl * .46));
  }

  // bumpers + sills
  dark.append(geoBox(W * .98, .17, .26), T(0, sill + .07, L * .5 - .10));
  dark.append(geoBox(W * .98, .17, .26), T(0, sill + .07, -L * .5 + .10));
  for (const sx of [-1, 1]) dark.append(geoBox(.07, .11, L * .52), T(sx * (W * .5 - .03), sill + .04, 0));
  // grille
  dark.append(geoBox(W * .52, .12, .07), T(0, sill + .20, L * .5 - .02));

  for (const sx of [-1, 1]) {
    lightF.append(geoRounded(W * .24, .105, .07, .03, 4), T(sx * W * .32, belt - .16, L * .5 - .03));
    lightR.append(geoRounded(W * .24, .095, .06, .03, 4), T(sx * W * .32, belt - .14, -L * .5 + .03));
  }

  return {
    paint: paint.done(), glass: glass.done(), dark: dark.done(),
    lightF: lightF.done(), lightR: lightR.done(),
    len: L, width: W, height: belt + cabH,
    axleF: L * .31, axleR: -L * .31, track: W * .40, wheelR: .33
  };
}
