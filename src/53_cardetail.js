'use strict';
/* ============================================================
   Apex Drive — per-model signature bodywork

   Every car was coming out of the same lofted template, so they all
   read the same. This adds the features that actually identify a car
   at a glance: what the nose does, what sits on the roof, where the
   exhaust exits, how the arches are treated.
   ============================================================ */

/* a thin dark groove following the body contour at one station — panel gaps */
function shutLine(spec, bodyW, t, i0, i1, push) {
  const e = 0.008;
  const a = bodyStationAt(spec, clamp01(t - e), bodyW);
  const b = bodyStationAt(spec, clamp01(t + e), bodyW);
  return loftBand([a, b], i0, i1, push === undefined ? 0.004 : push);
}

function addDetail(spec, G, H) {
  const { paint, dark, glass, chrome, lightF, lightR } = G;
  const { T, RX, L, W, bodyW, belt } = H;
  const sig = spec.sig || {};
  const S = CAR_SECT;

  /* ---------------- panel gaps, on every car ---------------- */
  if (spec.profile && spec.profile.width) {
    const gaps = sig.fourDoor ? [0.30, 0.48, 0.66, 0.80] : [0.34, 0.62, 0.80];
    for (const t of gaps) {
      // down the flanks only, from the shoulder to the sill
      dark.append(shutLine(spec, bodyW, t, 1, S / 2 - 1, 0.005), M4.n());
    }
    // bonnet and boot cut lines run across the top
    dark.append(shutLine(spec, bodyW, 0.86, S / 4 - 3, S / 4 + 3, 0.006), M4.n());
    dark.append(shutLine(spec, bodyW, 0.16, S / 4 - 3, S / 4 + 3, 0.006), M4.n());
  }

  /* ---------------- wipers, aerial, fuel filler ---------------- */
  const cowlZ = spec.profile.cabin.z1 + 0.06;
  const cowlY = belt(clamp01((cowlZ + L / 2) / L)) - 0.02;
  for (const sx of [-1, 1]) {
    dark.append(geoBox(0.035, 0.022, 0.52), RX(sx * bodyW * 0.20, cowlY + 0.03, cowlZ - 0.10, -0.20));
    dark.append(geoBox(0.028, 0.05, 0.06), T(sx * bodyW * 0.20, cowlY + 0.02, cowlZ + 0.14));
  }
  // shark-fin aerial on the roof
  {
    const rz = spec.profile.cabin.z0 + 0.30;
    const tt = clamp01((rz - spec.profile.cabin.z0) / (spec.profile.cabin.z1 - spec.profile.cabin.z0));
    const ry = catmull(spec.profile.cabin.roof, tt);
    paint.append(geoBox(0.045, 0.085, 0.24), RX(0, ry + 0.04, rz, 0.30));
  }
  // fuel filler
  {
    const fz = spec.profile.cabin.z0 - 0.12;
    const fy = belt(clamp01((fz + L / 2) / L)) - 0.14;
    chrome.append(geoLatheX([[0.075, 0], [0.082, 0.018], [0.055, 0.026]], 14, true),
      T(bodyW * 0.5 - 0.005, fy, fz));
  }
  // side repeaters
  for (const sx of [-1, 1])
    lightF.append(geoBox(0.02, 0.035, 0.11), T(sx * (bodyW * 0.5), belt(0.72) - 0.09, spec.axleF + 0.42));

  /* ---------------- mid-engine deck (supercar) ---------------- */
  if (sig.midEngine) {
    const dz = spec.profile.cabin.z0 - 0.34;
    const dy = spec.deckY - 0.10;
    glass.append(geoBox(bodyW * 0.62, 0.03, 0.72), T(0, dy + 0.035, dz));
    for (let i = -3; i <= 3; i++)
      chrome.append(geoBox(bodyW * 0.60, 0.022, 0.045), RX(0, dy + 0.06, dz + i * 0.105, 0.22));
    for (const sx of [-1, 1])
      dark.append(geoBox(0.06, 0.10, 0.78), T(sx * bodyW * 0.33, dy + 0.03, dz));
    // roof snorkel feeding the engine
    const tt = 0.08;
    const ry = catmull(spec.profile.cabin.roof, tt);
    dark.append(geoRounded(0.30, 0.13, 0.60, 0.05, 5), T(0, ry - 0.02, spec.profile.cabin.z0 + 0.42));
    dark.append(geoBox(0.24, 0.10, 0.06), T(0, ry + 0.01, spec.profile.cabin.z0 + 0.72));
  }

  /* ---------------- quad round headlights (muscle) ---------------- */
  if (sig.quadLamps) {
    const hz = L * 0.5 - 0.10;
    for (const sx of [-1, 1]) for (const o of [-1, 1]) {
      const x = sx * (W * 0.20 + o * 0.145 * sx * sx) * (o < 0 ? 0.72 : 1.16);
      chrome.append(geoLatheX([[0.108, -0.02], [0.115, 0.02], [0.10, 0.05]], 18, true),
        T(sx * (W * 0.20 + (o > 0 ? 0.17 : 0)), spec.lightY, hz - 0.02, 1, 1, 1));
      lightF.append(geoLatheX([[0.085, 0], [0.092, 0.03]], 18, true),
        T(sx * (W * 0.20 + (o > 0 ? 0.17 : 0)), spec.lightY, hz + 0.035));
    }
  }

  /* ---------------- bonnet scoop + stripe (muscle) ---------------- */
  if (sig.hoodScoop) {
    const hz = lerp(spec.axleF, L * 0.5, 0.30);
    const hy = belt((hz + L / 2) / L);
    dark.append(geoRounded(bodyW * 0.34, 0.11, 0.62, 0.05, 5), T(0, hy + 0.03, hz));
    dark.append(geoBox(bodyW * 0.26, 0.08, 0.05), T(0, hy + 0.055, hz + 0.30));
    for (const sx of [-1, 1])
      chrome.append(geoLatheX([[0.028, 0], [0.032, 0.02]], 10, true),
        T(sx * bodyW * 0.30, hy + 0.015, hz + 0.34));
  }

  /* ---------------- side-exit exhausts (muscle) ---------------- */
  if (sig.sideExhaust) {
    const ez = spec.axleR + 0.72;
    const ey = catmull(spec.profile.sill, 0.5) + 0.06;
    for (const sx of [-1, 1]) {
      chrome.append(geoBox(0.10, 0.10, 0.66), T(sx * (bodyW * 0.5 + 0.03), ey, ez));
      dark.append(geoBox(0.055, 0.14, 0.70), T(sx * (bodyW * 0.5 + 0.075), ey, ez));
    }
  }

  /* ---------------- chrome greenhouse + round tails (GT) ---------------- */
  if (sig.chromeTrim) {
    const cs2 = cabinStations(spec, 14, bodyW);
    chrome.append(loftBand(cs2, S - 2, S + 2, 0.016), M4.n());
    chrome.append(loftBand(cs2, S / 2 - 2, S / 2 + 2, 0.016), M4.n());
    // vent behind the front arch
    for (const sx of [-1, 1]) {
      dark.append(geoRounded(0.06, 0.17, 0.30, 0.03, 4), T(sx * (bodyW * 0.5 + 0.01), belt(0.70) - 0.10, spec.axleF - 0.52));
      for (let i = 0; i < 3; i++)
        chrome.append(geoBox(0.03, 0.022, 0.26), T(sx * (bodyW * 0.5 + 0.035), belt(0.70) - 0.16 + i * 0.055, spec.axleF - 0.52));
    }
  }
  if (sig.roundTails) {
    const tz = -L * 0.5 + 0.06;
    for (const sx of [-1, 1]) for (const o of [-1, 1]) {
      const x = sx * (W * 0.20 + (o > 0 ? 0.185 : 0));
      chrome.append(geoLatheX([[0.098, -0.02], [0.104, 0.01]], 16, true), T(x, spec.tailY, tz - 0.01));
      lightR.append(geoLatheX([[0.078, 0], [0.084, 0.026]], 16, true), T(x, spec.tailY, tz + 0.025));
    }
  }

  /* ---------------- roof rails, cladding, skid plates (crossover) ---------------- */
  if (sig.roofRails) {
    const tt = 0.5;
    const ry = catmull(spec.profile.cabin.roof, tt);
    const cz = (spec.profile.cabin.z0 + spec.profile.cabin.z1) * 0.5;
    const len = (spec.profile.cabin.z1 - spec.profile.cabin.z0) * 0.78;
    for (const sx of [-1, 1]) {
      dark.append(geoRounded(0.07, 0.06, len, 0.03, 4), T(sx * bodyW * 0.36, ry + 0.05, cz));
      for (const zz of [-0.34, 0.34])
        dark.append(geoBox(0.05, 0.07, 0.08), T(sx * bodyW * 0.36, ry + 0.01, cz + len * zz));
    }
    for (const zz of [-0.22, 0.18])
      dark.append(geoBox(bodyW * 0.70, 0.045, 0.08), T(0, ry + 0.055, cz + len * zz));
    // roof light bar
    lightF.append(geoBox(bodyW * 0.52, 0.06, 0.07), T(0, ry + 0.09, cz + len * 0.42));
  }
  if (sig.cladding) {
    for (const [z, tr] of [[spec.axleF, spec.trackF], [spec.axleR, spec.trackR]])
      for (const sx of [-1, 1])
        dark.append(geoArch3(spec.wheelR * 1.20, spec.wheelW * 0.5 + 0.085, 0.055, 0.06 * PI, 0.94 * PI, 18, 0.25),
          T(sx * tr, spec.wheelR, z));
    for (const sx of [-1, 1])
      dark.append(geoBox(0.09, 0.16, L * 0.44), T(sx * (bodyW * 0.5 - 0.005), catmull(spec.profile.sill, 0.5) + 0.06, 0));
    // side steps
    for (const sx of [-1, 1])
      dark.append(geoRounded(0.16, 0.07, L * 0.34, 0.03, 4), T(sx * (bodyW * 0.5 + 0.04), catmull(spec.profile.sill, 0.5) - 0.02, 0));
  }
  if (sig.skidPlates) {
    chrome.append(geoRounded(W * 0.52, 0.05, 0.34, 0.03, 4), T(0, catmull(spec.profile.sill, 0.94) + 0.03, L * 0.5 - 0.30));
    chrome.append(geoRounded(W * 0.50, 0.05, 0.30, 0.03, 4), T(0, catmull(spec.profile.sill, 0.06) + 0.03, -L * 0.5 + 0.28));
  }
  if (sig.spareWheel) {
    const tz = -L * 0.5 + 0.06;
    const rotY = () => { const r = M4.n(); r[0] = 0; r[2] = -1; r[8] = 1; r[10] = 0; return r; };
    // sits flush on the tailgate rather than floating behind it
    dark.append(geoLatheX([[0.185, -0.075], [0.29, -0.085], [0.29, 0.055], [0.185, 0.045]], 22, true),
      M4.mul(M4.n(), T(0, spec.tailY + 0.06, tz), rotY()));
    chrome.append(geoLatheX([[0.055, 0.05], [0.10, 0.055], [0.10, 0.07]], 16, true),
      M4.mul(M4.n(), T(0, spec.tailY + 0.06, tz), rotY()));
  }

  /* ---------------- swan-neck wing, canards, tow hook (track) ---------------- */
  if (sig.swanWing && spec.wing) {
    const wz = -L * 0.5 + spec.wing.z, wy = spec.wing.y + 0.10;
    for (const sx of [-1, 1]) {
      // the mount arcs over the top of the aerofoil
      dark.append(geoBox(0.05, spec.wing.h * 1.25, 0.10), T(sx * W * 0.34, wy - spec.wing.h * 0.62, wz + 0.16));
      dark.append(geoBox(0.05, 0.09, 0.34), RX(sx * W * 0.34, wy + 0.02, wz + 0.02, -0.55));
    }
    paint.append(geoBox(W * 0.98, 0.045, spec.wing.chord * 1.1), T(0, wy, wz));
    paint.append(geoBox(W * 0.98, 0.05, 0.03), T(0, wy + 0.046, wz - spec.wing.chord * 0.55));
    for (const sx of [-1, 1])
      dark.append(geoBox(0.022, 0.20, spec.wing.chord * 1.2), T(sx * W * 0.49, wy + 0.06, wz));
  }
  if (sig.canards) {
    for (const sx of [-1, 1]) for (let i = 0; i < 2; i++)
      dark.append(geoBox(0.20, 0.018, 0.13), RX(sx * (W * 0.42), spec.grilleY + 0.02 + i * 0.10, L * 0.5 - 0.26, 0.18));
  }
  if (sig.towHook) {
    lightR.append(geoLatheX([[0.05, 0], [0.055, 0.10]], 12, true),
      M4.mul(M4.n(), T(W * 0.30, spec.tailY - 0.24, -L * 0.5 + 0.02), (() => { const r = M4.n(); r[5] = 0; r[6] = -1; r[9] = 1; r[10] = 0; return r; })()));
  }
  if (sig.bonnetPins) {
    const hz = lerp(spec.axleF, L * 0.5, 0.62);
    const hy = belt((hz + L / 2) / L);
    for (const sx of [-1, 1])
      chrome.append(geoLatheX([[0.030, 0], [0.034, 0.014]], 10, true), T(sx * bodyW * 0.36, hy + 0.012, hz));
  }
  /* ---------------- flying buttresses (mid-engine signature) ---------------- */
  if (sig.buttress) {
    const C = spec.profile.cabin;
    const ry = catmull(C.roof, 0.06);
    const rw = catmull(C.width, 0.06) * bodyW * 0.5;
    const endZ = C.z0 - 1.05;
    const endY = spec.deckY - 0.06;
    const endW = bodyW * 0.48;
    const N = 9;
    for (const sx of [-1, 1]) {
      for (let i = 0; i < N; i++) {
        const t0 = i / N, t1 = (i + 1) / N;
        const at = t => {
          const e = t * t;                       // sweeps away fast, like a real buttress
          return [sx * lerp(rw, endW, t), lerp(ry, endY, e), lerp(C.z0 + 0.04, endZ, t)];
        };
        const a = at(t0), b = at(t1);
        const dz = b[2] - a[2], dy = b[1] - a[1], dx = b[0] - a[0];
        const len = Math.hypot(dz, dy) || 0.01;
        const m = M4.n();
        const ca = dz / len, sa2 = dy / len;
        m[0] = 1; m[5] = ca; m[6] = sa2; m[9] = -sa2; m[10] = ca;
        m[12] = (a[0] + b[0]) * 0.5; m[13] = (a[1] + b[1]) * 0.5; m[14] = (a[2] + b[2]) * 0.5;
        const h = lerp(0.16, 0.09, t0);
        paint.append(geoBox(Math.abs(dx) + 0.075, h, len * 1.12), m);
      }
    }
  }

  /* ---------------- bonnet and arch louvres ---------------- */
  if (sig.louvres) {
    const hz = lerp(spec.axleF, L * 0.5, 0.34);
    const hy = belt((hz + L / 2) / L);
    for (const sx of [-1, 1]) for (let i = 0; i < 4; i++)
      dark.append(geoBox(bodyW * 0.19, 0.022, 0.055),
        RX(sx * bodyW * 0.24, hy + 0.012, hz - 0.10 + i * 0.10, 0.28));
    // louvres venting the front arches
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++)
      dark.append(geoBox(0.035, 0.024, 0.20),
        T(sx * (bodyW * 0.5 - 0.01), belt(0.74) - 0.05 - i * 0.055, spec.axleF - 0.30));
  }

  /* ---------------- Y-shaped daytime running lights ---------------- */
  if (sig.yLamps) {
    const hz = L * 0.5 - 0.09;
    for (const sx of [-1, 1]) {
      lightF.append(geoBox(0.028, 0.026, 0.16), RX(sx * (W * 0.30), spec.lightY + 0.03, hz + 0.02, 0));
      for (const o of [-1, 1])
        lightF.append(geoBox(0.026, 0.026, 0.13),
          M4.mul(M4.n(), T(sx * (W * 0.30) + o * 0.045, spec.lightY - 0.055, hz + 0.02),
            (() => { const r = M4.n(), a2 = o * 0.55, c = Math.cos(a2), sn = Math.sin(a2); r[0] = c; r[1] = sn; r[4] = -sn; r[5] = c; return r; })()));
    }
  }

  /* ---------------- stacked centre-exit exhausts ---------------- */
  if (sig.centreExhaust) {
    const ez = -L * 0.5 + 0.14;
    const ey = catmull(spec.profile.sill, 0.06) + 0.20;
    const rotZ = () => { const r = M4.n(); r[5] = 0; r[6] = -1; r[9] = 1; r[10] = 0; return r; };
    for (const sx of [-1, 1]) for (const oy of [0, 1]) {
      chrome.append(geoLatheX([[0.052, -0.09], [0.058, 0.02], [0.050, 0.05]], 16, true),
        M4.mul(M4.n(), T(sx * 0.085, ey + oy * 0.115, ez), rotZ()));
      dark.append(geoLatheX([[0.040, 0], [0.040, 0.06]], 12, true),
        M4.mul(M4.n(), T(sx * 0.085, ey + oy * 0.115, ez + 0.03), rotZ()));
    }
    dark.append(geoBox(0.34, 0.30, 0.16), T(0, ey + 0.055, ez - 0.06));
  }

  /* ---------------- finned full-width tail bar ---------------- */
  if (sig.finTail) {
    const tz = -L * 0.5 + 0.11;
    for (let i = -5; i <= 5; i++)
      dark.append(geoBox(0.022, 0.11, 0.07), T(i * W * 0.072, spec.tailY, tz + 0.03));
    for (const sx of [-1, 1])
      chrome.append(geoBox(0.03, 0.13, 0.08), T(sx * W * 0.40, spec.tailY, tz + 0.03));
  }

  if (sig.roofScoop && !sig.midEngine) {
    const tt = 0.30;
    const ry = catmull(spec.profile.cabin.roof, tt);
    const rz = lerp(spec.profile.cabin.z0, spec.profile.cabin.z1, tt);
    dark.append(geoRounded(0.26, 0.14, 0.46, 0.05, 5), T(0, ry + 0.02, rz));
    dark.append(geoBox(0.20, 0.11, 0.05), T(0, ry + 0.04, rz + 0.23));
  }
}
