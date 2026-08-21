'use strict';
/* ============================================================
   Apex Drive — engines, parts, economy, dyno
   Everything the shop sells feeds one function: buildPhys().
   ============================================================ */

const ENGINES = [
  { id: 'stock', n: 'Factory Unit', sound: null, nm: 0, rl: 0, mass: 0, cost: 0, desc: 'As it left the line' },
  { id: 'i4t', n: 'I4 Turbo 2.0', sound: 'i4', nm: 300, rl: 7200, mass: -70, cost: 22000, cyl: 4, desc: 'Light, revvy, boost-hungry' },
  { id: 'flat6', n: 'Flat-6 3.8', sound: 'flat6', nm: 420, rl: 8200, mass: -30, cost: 48000, cyl: 6, desc: 'Rear-biased scream' },
  { id: 'v6tt', n: 'V6 Twin-Turbo', sound: 'v6', nm: 470, rl: 7600, mass: 10, cost: 56000, cyl: 6, desc: 'Broad, brutal midrange' },
  { id: 'v8', n: 'V8 6.2 OHV', sound: 'v8', nm: 620, rl: 6600, mass: 60, cost: 64000, cyl: 8, desc: 'Torque and thunder' },
  { id: 'v8f', n: 'V8 Flat-Plane 4.5', sound: 'v8', nm: 560, rl: 9000, mass: 20, cost: 88000, cyl: 8, desc: 'Race-derived howl' },
  { id: 'v10', n: 'V10 5.2 NA', sound: 'v10', nm: 610, rl: 8900, mass: 55, cost: 112000, cyl: 10, desc: 'The purist choice' },
  { id: 'v12', n: 'V12 6.5 NA', sound: 'v12', nm: 720, rl: 8700, mass: 110, cost: 165000, cyl: 12, desc: 'Twelve cylinders of theatre' },
  { id: 'rot', n: '4-Rotor 26B', sound: 'rotary', nm: 380, rl: 9800, mass: -80, cost: 96000, cyl: 4, desc: 'Buzzsaw. No replacement.' },
  { id: 'ev', n: 'Tri-Motor EV', sound: 'ev', nm: 980, rl: 5200, mass: 280, cost: 190000, cyl: 2, desc: 'Silent, savage, instant' },
];

/* every part list is ordered stock -> best; index is the tier */
const PARTS = {
  forced: {
    n: 'Induction', icon: '🌀', items: [
      { n: 'Naturally Aspirated', cost: 0, kind: 'none', psi: 0, mass: 0 },
      { n: 'Street Turbo', cost: 14000, kind: 'turbo', psi: 8, spool: 3200, lag: 0.55, mass: 24 },
      { n: 'Sport Turbo', cost: 31000, kind: 'turbo', psi: 14, spool: 3800, lag: 0.68, mass: 30 },
      { n: 'Twin-Scroll Turbo', cost: 58000, kind: 'turbo', psi: 20, spool: 3100, lag: 0.40, mass: 34 },
      { n: 'Race Twin-Turbo', cost: 96000, kind: 'turbo', psi: 27, spool: 4200, lag: 0.62, mass: 46 },
      { n: 'Roots Supercharger', cost: 36000, kind: 'super', psi: 10, mass: 40 },
      { n: 'Twin-Screw Blower', cost: 74000, kind: 'super', psi: 17, mass: 52 },
    ]
  },
  intake: { n: 'Intake', icon: '💨', items: [
    { n: 'Stock Airbox', cost: 0, tq: 1.00 },
    { n: 'Panel Filter', cost: 1400, tq: 1.02 },
    { n: 'Cold Air Intake', cost: 5200, tq: 1.05 },
    { n: 'Carbon Ram Air', cost: 15000, tq: 1.09 },
  ]},
  exhaust: { n: 'Exhaust', icon: '🔥', items: [
    { n: 'Stock System', cost: 0, tq: 1.00, snd: 0 },
    { n: 'Cat-Back', cost: 2600, tq: 1.03, snd: 1 },
    { n: 'Sports Headers', cost: 9800, tq: 1.07, snd: 2 },
    { n: 'Full Titanium Race', cost: 26000, tq: 1.12, snd: 3, mass: -18 },
  ]},
  ecu: { n: 'ECU / Tune', icon: '🧠', items: [
    { n: 'Factory Map', cost: 0, tq: 1.00, rl: 0, boost: 1.0 },
    { n: 'Stage 1 Remap', cost: 4200, tq: 1.04, rl: 200, boost: 1.07 },
    { n: 'Stage 2 Remap', cost: 13500, tq: 1.08, rl: 400, boost: 1.14 },
    { n: 'Standalone ECU', cost: 34000, tq: 1.13, rl: 700, boost: 1.24 },
  ]},
  cooling: { n: 'Intercooler', icon: '❄️', items: [
    { n: 'Stock Cooler', cost: 0, boost: 1.00, heat: 1.00 },
    { n: 'Uprated Core', cost: 3800, boost: 1.06, heat: 0.80 },
    { n: 'Front-Mount', cost: 11000, boost: 1.12, heat: 0.62 },
    { n: 'Race Chargecooler', cost: 27000, boost: 1.20, heat: 0.45 },
  ]},
  gearbox: { n: 'Gearbox', icon: '⚙️', items: [
    { n: 'Stock Gearbox', cost: 0, shift: 0.22, spread: 1.00 },
    { n: 'Short Ratios', cost: 7400, shift: 0.18, spread: 0.92 },
    { n: 'Close-Ratio 6spd', cost: 19000, shift: 0.13, spread: 0.86, extra: 0 },
    { n: 'Sequential Race 7spd', cost: 47000, shift: 0.06, spread: 0.82, extra: 1 },
  ]},
  clutch: { n: 'Clutch', icon: '🔗', items: [
    { n: 'Stock Clutch', cost: 0, grab: 1.00 },
    { n: 'Sport Organic', cost: 2400, grab: 1.12 },
    { n: 'Twin-Plate', cost: 9600, grab: 1.28 },
    { n: 'Carbon Race', cost: 24000, grab: 1.45 },
  ]},
  diff: { n: 'Differential', icon: '🔄', items: [
    { n: 'Open Diff', cost: 0, lock: 0.0 },
    { n: '1.5-Way LSD', cost: 5600, lock: 0.45 },
    { n: '2-Way LSD', cost: 14000, lock: 0.72 },
    { n: 'Welded / Spool', cost: 21000, lock: 1.0, drift: 1 },
  ]},
  drivetrain: { n: 'Layout', icon: '🛞', items: [
    { n: 'Factory Layout', cost: 0, drive: null },
    { n: 'RWD Conversion', cost: 26000, drive: 'rwd' },
    { n: 'AWD Conversion', cost: 52000, drive: 'awd', mass: 85 },
    { n: 'FWD Conversion', cost: 18000, drive: 'fwd', mass: -40 },
  ]},
  tyres: { n: 'Tyres', icon: '⭕', items: [
    { n: 'All-Season', cost: 0, grip: 1.00, wet: 1.00, slide: 1.0 },
    { n: 'Performance', cost: 2200, grip: 1.10, wet: 0.95, slide: 1.0 },
    { n: 'Semi-Slick', cost: 8600, grip: 1.22, wet: 0.78, slide: 0.92 },
    { n: 'Full Slick', cost: 22000, grip: 1.36, wet: 0.55, slide: 0.85 },
    { n: 'Drift Compound', cost: 9400, grip: 0.94, wet: 0.9, slide: 1.55 },
  ]},
  susp: { n: 'Suspension', icon: '🪛', items: [
    { n: 'Factory Springs', cost: 0, grip: 1.00, roll: 1.00, ride: 0 },
    { n: 'Lowering Kit', cost: 3100, grip: 1.05, roll: 0.88, ride: -0.03 },
    { n: 'Coilovers', cost: 11500, grip: 1.11, roll: 0.74, ride: -0.05 },
    { n: 'Race Dampers', cost: 29000, grip: 1.18, roll: 0.60, ride: -0.07 },
  ]},
  brakes: { n: 'Brakes', icon: '🛑', items: [
    { n: 'Factory Brakes', cost: 0, brake: 1.00 },
    { n: 'Performance Pads', cost: 1900, brake: 1.10 },
    { n: 'Big Brake Kit', cost: 12000, brake: 1.26, mass: 6 },
    { n: 'Carbon-Ceramic', cost: 34000, brake: 1.42, mass: -14 },
  ]},
  weight: { n: 'Weight', icon: '🪶', items: [
    { n: 'Full Interior', cost: 0, mass: 0 },
    { n: 'Stage 1 Strip', cost: 4600, mass: -70 },
    { n: 'Stage 2 + Carbon', cost: 17000, mass: -150 },
    { n: 'Full Cage Shell', cost: 44000, mass: -240 },
  ]},
  aero: { n: 'Aero', icon: '🪽', items: [
    { n: 'Factory Body', cost: 0, df: 1.00, drag: 1.00 },
    { n: 'Lip + Ducktail', cost: 3400, df: 1.25, drag: 1.02 },
    { n: 'GT Wing + Splitter', cost: 14500, df: 1.75, drag: 1.09 },
    { n: 'Full Race Aero', cost: 38000, df: 2.40, drag: 1.16 },
  ]},
  nitrous: { n: 'Nitrous', icon: '💉', items: [
    { n: 'None', cost: 0, shot: 0, tank: 0 },
    { n: '50 Shot', cost: 3600, shot: 0.14, tank: 7 },
    { n: '100 Shot', cost: 9200, shot: 0.26, tank: 6 },
    { n: '150 Direct Port', cost: 21000, shot: 0.40, tank: 5 },
  ]},
};

const PART_ORDER = ['forced', 'intake', 'exhaust', 'ecu', 'cooling', 'gearbox', 'clutch', 'diff', 'drivetrain', 'tyres', 'susp', 'brakes', 'weight', 'aero', 'nitrous'];

/* rim finishes and caliper colours are cosmetic, priced in the shop */
const RIM_FINISH = [
  [.30, .31, .33, .34, 1],    // anthracite
  [.72, .74, .78, .13, 1],    // polished
  [.055, .057, .06, .40, 1],  // satin black
  [.62, .50, .18, .22, 1],    // bronze
  [.78, .78, .80, .55, .2],   // white
];
const RIM_FINISH_NAMES = ['Anthracite', 'Polished', 'Satin Black', 'Bronze', 'Gloss White'];
const CALIPER_COLS = [
  [.55, .06, .05], [.06, .06, .07], [.75, .55, .04],
  [.06, .30, .60], [.10, .45, .16], [.62, .62, .64],
];
const CALIPER_NAMES = ['Red', 'Black', 'Gold', 'Blue', 'Green', 'Silver'];

const RIMS = [
  { n: 'Split 5', spokes: 5, cost: 0 },
  { n: 'Mesh 10', spokes: 10, cost: 1800 },
  { n: 'Twin 6', spokes: 6, cost: 2600 },
  { n: 'Turbofan 7', spokes: 7, cost: 4200 },
  { n: 'Race 12', spokes: 12, cost: 7600 },
];

/* ============================================================
   Save state
   ============================================================ */
const Garage = {
  KEY: 'apexdrive.save.v3',
  cash: 0,
  owned: {},          // carId -> true
  cars: {},           // carId -> { parts:{}, engine:'stock', paint, finish, rim, tint, cur }
  current: 'bruiser',
  stats: { distance: 0, topSpeed: 0, drift: 0, races: 0, earned: 0 },

  defaults(id) {
    const p = {}; for (const k of PART_ORDER) p[k] = 0;
    return { parts: p, engine: 'stock', paint: 1, finish: 0, rim: 0, rimFinish: 0, caliper: 0, stripe: -1, tint: 0.72 };
  },
  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) {
        const s = JSON.parse(raw);
        Object.assign(this, s);
      }
    } catch (e) { }
    if (!this.owned || !Object.keys(this.owned).length) {
      this.owned = { bruiser: true };
      this.current = 'bruiser';
    }
    for (const id in this.owned) if (!this.cars[id]) this.cars[id] = this.defaults(id);
    if (!this.cars[this.current]) { this.current = Object.keys(this.owned)[0]; }
    return this;
  },
  save() {
    try {
      localStorage.setItem(this.KEY, JSON.stringify({
        cash: this.cash, owned: this.owned, cars: this.cars, current: this.current, stats: this.stats
      }));
    } catch (e) { }
  },
  reset() { try { localStorage.removeItem(this.KEY); } catch (e) { } },
  car(id) { id = id || this.current; if (!this.cars[id]) this.cars[id] = this.defaults(id); return this.cars[id]; },
  add(v) { this.cash = Math.max(0, this.cash + v); if (v > 0) this.stats.earned += v; this.save(); },
  canAfford(c) { return this.cash >= c; },
};

/* ============================================================
   Physics assembly
   ============================================================ */
function specById(id) { return CAR_SPECS.find(s => s.id === id) || CAR_SPECS[0]; }

function buildPhys(carId) {
  const spec = specById(carId);
  const g = Garage.car(carId);
  const base = spec.phys;
  const P = {};
  for (const k of PART_ORDER) P[k] = PARTS[k].items[clamp(g.parts[k] | 0, 0, PARTS[k].items.length - 1)];

  const eng = ENGINES.find(e => e.id === g.engine) || ENGINES[0];
  const ph = Object.assign({}, base);
  ph.gears = base.gears.slice();

  /* --- engine --- */
  let torque = eng.id === 'stock' ? base.power * 0.92 : eng.nm;
  let redline = eng.id === 'stock' ? base.redline : eng.rl;
  ph.cylinders = eng.id === 'stock' ? (base.cylinders || 8) : eng.cyl;
  ph.soundType = eng.id === 'stock' ? (base.sound || 'v8') : eng.sound;

  torque *= P.intake.tq * P.exhaust.tq * P.ecu.tq;
  redline += P.ecu.rl;

  /* --- forced induction --- */
  ph.forced = P.forced.kind;
  ph.maxBoostPsi = P.forced.psi * P.ecu.boost * P.cooling.boost;
  ph.spoolRpm = P.forced.spool || 1200;
  ph.turboLag = P.forced.lag === undefined ? 0.15 : P.forced.lag;
  ph.boostVE = 0.045;    // torque gain per psi after charge-air and efficiency losses

  ph.baseTorque = torque;
  ph.redline = redline;
  ph.idleRpm = ph.forced === 'none' && ph.cylinders >= 10 ? 1050 : 880;

  /* --- mass --- */
  let mass = base.mass + (eng.mass || 0) + (P.forced.mass || 0) + (P.exhaust.mass || 0) +
    (P.brakes.mass || 0) + (P.weight.mass || 0) + (P.drivetrain.mass || 0);
  ph.mass = clamp(mass, 780, 2600);

  /* --- drivetrain --- */
  ph.drive = P.drivetrain.drive || base.drive;
  ph.shiftTime = P.gearbox.shift;
  ph.clutchGrab = P.clutch.grab;
  ph.diffLock = P.diff.lock;
  ph.driftDiff = !!P.diff.drift;
  const spread = P.gearbox.spread;
  ph.gears = base.gears.map((r, i) => r * Math.pow(spread, i * 0.55 + 0.45));
  if (P.gearbox.extra) ph.gears.push(ph.gears[ph.gears.length - 1] * 0.86);
  ph.final = base.final * (1 / Math.pow(spread, 0.25));

  /* --- chassis --- */
  const gripMul = P.tyres.grip * P.susp.grip;
  ph.gripF = base.gripF * gripMul;
  ph.gripR = base.gripR * gripMul;
  ph.slideMul = P.tyres.slide;
  ph.wetGrip = P.tyres.wet;
  ph.rollStiff = P.susp.roll;
  ph.rideDrop = P.susp.ride;
  ph.brake = base.brake * P.brakes.brake;
  ph.dfF = base.dfF * P.aero.df;
  ph.dfR = base.dfR * P.aero.df;
  ph.drag = base.drag * P.aero.drag;

  /* --- nitrous --- */
  ph.nosShot = P.nitrous.shot;
  ph.nosTank = P.nitrous.tank;

  ph.cgH = base.cgH + (P.susp.ride || 0) * 0.5;
  ph.steerMax = base.steerMax;
  ph.parts = P;
  ph.engineId = eng.id;
  return ph;
}

/* normalised torque shape by rpm fraction, engine-character aware */
function torqueShape(x, ph) {
  x = clamp01(x);
  const forced = ph.forced !== 'none';
  const cyl = ph.cylinders || 8;
  if (ph.soundType === 'ev') return clamp01(1.0 - Math.max(0, x - 0.42) * 0.85);
  // peak position: big-bore NA peaks late, boosted engines peak early and flat
  const peak = forced ? 0.50 : (cyl >= 10 ? 0.76 : 0.68);
  const width = forced ? 0.46 : (cyl >= 10 ? 0.34 : 0.30);
  const lowEnd = forced ? 0.38 : (cyl >= 8 ? 0.66 : 0.52);
  const base = lerp(lowEnd, 1.0, clamp01(1 - Math.pow(Math.abs(x - peak) / width, 1.9)));
  const tail = x > 0.90 ? lerp(1, 0.80, (x - 0.90) / 0.12) : 1;
  const bottom = x < 0.10 ? lerp(0.45, 1, x / 0.10) : 1;
  return clamp(base * tail * bottom, 0.15, 1.15);
}

/* boost in psi available at an rpm at full throttle */
function boostAt(rpm, ph) {
  if (ph.forced === 'none' || ph.maxBoostPsi <= 0) return 0;
  if (ph.forced === 'super') return ph.maxBoostPsi * clamp01(rpm / (ph.redline * 0.72));
  const t = clamp01((rpm - ph.spoolRpm * 0.55) / (ph.spoolRpm * 0.85));
  return ph.maxBoostPsi * t * t * (3 - 2 * t) / 1.0;
}

/* absolute crank torque (Nm) at rpm, full throttle */
function torqueAt(rpm, ph) {
  const nm = ph.baseTorque * torqueShape(rpm / ph.redline, ph);
  return nm * (1 + boostAt(rpm, ph) * ph.boostVE);
}

/* Longitudinal sim so the shop numbers match what the car actually does */
function simulate(ph, target) {
  const g = 9.81, wheelR = 0.35, dtS = 0.02;
  const driveShare = ph.drive === 'awd' ? 1.0 : (ph.drive === 'fwd' ? 0.44 : 0.56);
  const mu = (ph.gripF + ph.gripR) * 0.5 * 0.92;
  const cda = ph.drag * 2.0;
  const top = ph.gears.length - 1;
  let v = 0.1, t = 0, gear = 0, shiftHold = 0, stall = 0;
  while (t < 90) {
    const ratio = ph.gears[gear] * ph.final;
    let rpm = v / wheelR * ratio * 9.5493;
    if (rpm > ph.redline && gear < top && shiftHold <= 0) { gear++; shiftHold = ph.shiftTime; continue; }
    rpm = clamp(rpm, ph.idleRpm || 900, ph.redline);
    let F = 0;
    if (shiftHold > 0) shiftHold -= dtS;
    else F = torqueAt(rpm, ph) * ratio * 0.90 / wheelR;
    const down = ph.dfR * 0.5 * 1.225 * v * v;
    F = Math.min(F, mu * (ph.mass * g * driveShare + down));
    const drag = 0.5 * 1.225 * cda * v * v + ph.mass * g * 0.013;
    const a = (F - drag) / ph.mass;
    v = Math.max(0.1, v + a * dtS);
    t += dtS;
    if (target && v >= target) return t;
    // terminal velocity: in top gear, pulling, and no longer gaining
    if (shiftHold <= 0 && gear === top && a < 0.02) { if (++stall > 25) break; } else stall = 0;
  }
  return target ? 99 : v;
}

function statsFor(ph) {
  let peakNm = 0, peakNmRpm = 0, peakHp = 0, peakHpRpm = 0;
  for (let r = 800; r <= ph.redline; r += 50) {
    const nm = torqueAt(r, ph);
    const hp = nm * r / 7127;
    if (nm > peakNm) { peakNm = nm; peakNmRpm = r; }
    if (hp > peakHp) { peakHp = hp; peakHpRpm = r; }
  }
  const zero100 = simulate(ph, 100 / 3.6);
  const vmax = simulate(ph, 0);
  return {
    hp: Math.round(peakHp), hpRpm: peakHpRpm,
    nm: Math.round(peakNm), nmRpm: peakNmRpm,
    mass: Math.round(ph.mass),
    zero100: Math.min(zero100, 30),
    vmax: Math.round(vmax * 3.6),
    grip: (ph.gripF + ph.gripR) / 2,
    boost: ph.maxBoostPsi,
    pwr: peakHp / (ph.mass / 1000),
  };
}

function partCost(cat, tier) { return PARTS[cat].items[tier] ? PARTS[cat].items[tier].cost : 0; }
function money(v) { return '$' + Math.round(v).toLocaleString('en-US'); }
