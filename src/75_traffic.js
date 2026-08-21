'use strict';
/* ============================================================
   Apex Drive — traffic + parked cars
   Kinematic agents that follow the road grid.
   ============================================================ */

const LANE = 3.6;

class TrafficCar {
  constructor(model, i, j, dir, rnd) {
    this.model = model;
    this.i = i; this.j = j; this.dir = dir;   // dir 0:+x 1:+z 2:-x 3:-z
    this.t = rnd();
    this.speed = 11 + rnd() * 7;
    this.targetSpeed = this.speed;
    this.yaw = 0;
    this.x = 0; this.z = 0;
    this.wheelSpin = 0;
    this.color = null;
    this.brake = 0;
    this.horn = 0;
    this.parked = false;
    this.bob = rnd() * TAU;
    this.nx = 0; this.nz = 0;
    this.setNodeTargets(rnd);
    this.x = this.px; this.z = this.pz;
    this.yaw = Math.atan2(this.tx - this.px, this.tz - this.pz);
  }
  dirVec(d) { return d === 0 ? [1, 0] : d === 1 ? [0, 1] : d === 2 ? [-1, 0] : [0, -1]; }
  setNodeTargets(rnd) {
    const W = World, N = W.N;
    const dv = this.dirVec(this.dir);
    let ni = this.i + dv[0], nj = this.j + dv[1];
    if (ni < 0 || nj < 0 || ni > N || nj > N) {
      this.dir = (this.dir + 2) % 4;
      const d2 = this.dirVec(this.dir);
      ni = this.i + d2[0]; nj = this.j + d2[1];
    }
    const dv2 = this.dirVec(this.dir);
    // right-hand lane offset
    const ox = -dv2[1] * LANE, oz = dv2[0] * LANE;
    this.px = W.roadX(this.i) + ox; this.pz = W.roadX(this.j) + oz;
    this.tx = W.roadX(ni) + ox; this.tz = W.roadX(nj) + oz;
    this.ni = ni; this.nj = nj;
  }
  advance(rnd) {
    this.i = this.ni; this.j = this.nj;
    // choose a new direction, prefer straight, never U-turn
    const r = rnd();
    let nd = this.dir;
    if (r < 0.24) nd = (this.dir + 1) % 4;
    else if (r < 0.48) nd = (this.dir + 3) % 4;
    const N = World.N;
    const dv = this.dirVec(nd);
    if (this.i + dv[0] < 0 || this.i + dv[0] > N || this.j + dv[1] < 0 || this.j + dv[1] > N) {
      // fall back to any legal direction
      for (let k = 0; k < 4; k++) {
        const d2 = this.dirVec(k);
        if (k === (this.dir + 2) % 4) continue;
        if (this.i + d2[0] >= 0 && this.i + d2[0] <= N && this.j + d2[1] >= 0 && this.j + d2[1] <= N) { nd = k; break; }
      }
    }
    this.dir = nd;
    this.setNodeTargets(rnd);
  }
}

const Traffic = {
  cars: [], parked: [], models: [], rnd: mulberry32(7771),
  count: 0,
  init(nModels) {
    this.models = [];
    for (let k = 0; k < nModels; k++) this.models.push(buildTrafficCar(1000 + k * 977));
  },
  populate(n) {
    this.cars.length = 0;
    const N = World.N;
    const rnd = this.rnd;
    let guard = 0;
    while (this.cars.length < n && guard++ < n * 20) {
      const i = (rnd() * (N + 1)) | 0, j = (rnd() * (N + 1)) | 0;
      const d = (rnd() * 4) | 0;
      const c = new TrafficCar((rnd() * this.models.length) | 0, i, j, d, rnd);
      c.t = rnd();
      const dx = c.tx - c.px, dz = c.tz - c.pz;
      c.x = c.px + dx * c.t; c.z = c.pz + dz * c.t;
      c.yaw = Math.atan2(dx, dz);
      c.color = TRAFFIC_COLORS[(rnd() * TRAFFIC_COLORS.length) | 0];
      this.cars.push(c);
    }
    this.count = this.cars.length;
  },
  buildParked() {
    this.parked.length = 0;
    const rnd = mulberry32(4242);
    for (const p of (World._lotCars || [])) {
      this.parked.push({ x: p.x, z: p.z, yaw: p.yaw, model: (rnd() * this.models.length) | 0, color: TRAFFIC_COLORS[(rnd() * TRAFFIC_COLORS.length) | 0] });
    }
    // street parking along block edges
    const N = World.N, C = World.CELL, R = World.ROAD, half = World.half;
    for (let bi = 0; bi < N; bi++) for (let bj = 0; bj < N; bj++) {
      if (rnd() < .45) continue;
      const bx = -half + bi * C + C * .5, bz = -half + bj * C + C * .5;
      const n = 1 + (rnd() * 3) | 0;
      for (let k = 0; k < n; k++) {
        const side = (rnd() * 4) | 0;
        const off = (rnd() - .5) * World.BLOCK * .65;
        let x, z, yaw;
        const e = World.BLOCK * .5 + 1.9;
        if (side === 0) { x = bx + off; z = bz + e; yaw = rnd() < .5 ? 0 : PI; }
        else if (side === 1) { x = bx + off; z = bz - e; yaw = rnd() < .5 ? 0 : PI; }
        else if (side === 2) { x = bx + e; z = bz + off; yaw = PI * .5; }
        else { x = bx - e; z = bz + off; yaw = -PI * .5; }
        this.parked.push({ x, z, yaw, model: (rnd() * this.models.length) | 0, color: TRAFFIC_COLORS[(rnd() * TRAFFIC_COLORS.length) | 0] });
      }
    }
  },
  /* move a car to a random road node near the player so traffic stays where it matters */
  recycle(c, px, pz) {
    const rnd = this.rnd, N = World.N, C = World.CELL, h = World.half;
    for (let tries = 0; tries < 12; tries++) {
      const a = rnd() * TAU, r = 110 + rnd() * 110;
      const i = clamp(Math.round((px + Math.cos(a) * r + h) / C), 0, N);
      const j = clamp(Math.round((pz + Math.sin(a) * r + h) / C), 0, N);
      const x = World.roadX(i), z = World.roadX(j);
      if (Math.hypot(x - px, z - pz) < 70) continue;
      c.i = i; c.j = j; c.dir = (rnd() * 4) | 0;
      c.setNodeTargets(rnd);
      const t = rnd();
      c.x = c.px + (c.tx - c.px) * t; c.z = c.pz + (c.tz - c.pz) * t;
      c.yaw = Math.atan2(c.tx - c.px, c.tz - c.pz);
      c.speed = c.targetSpeed * (.6 + rnd() * .4);
      return;
    }
  },
  clock: 0,
  update(dt, player) {
    this.clock += dt;
    const rnd = this.rnd;
    const px = player.pos[0], pz = player.pos[2];
    for (let ci = 0; ci < this.cars.length; ci++) {
      const c = this.cars[ci];
      const dxp = c.x - px, dzp = c.z - pz;
      const farSq = dxp * dxp + dzp * dzp;
      if (farSq > 400 * 400) { this.recycle(c, px, pz); continue; }
      const near = farSq < 260 * 260;
      const step = near ? dt : dt * 0.9;

      // desired heading toward the segment end
      const dx = c.tx - c.x, dz = c.tz - c.z;
      const dist = Math.hypot(dx, dz);
      const want = Math.atan2(dx, dz);
      let dy = wrapPi(want - c.yaw);
      const maxTurn = (2.4 + 6.0 / Math.max(c.speed, 3)) * step;
      c.yaw += clamp(dy, -maxTurn, maxTurn);

      // obstacle scan
      let brake = 0;
      const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
      if (near) {
        // player ahead?
        const rel = (px - c.x) * fx + (pz - c.z) * fz;
        const lat = Math.abs((px - c.x) * fz - (pz - c.z) * -fx);
        const latAbs = Math.abs(-(px - c.x) * fz + (pz - c.z) * fx);
        if (rel > 0 && rel < 22 && latAbs < 3.0) brake = Math.max(brake, 1 - rel / 22);
      }
      for (let k = 0; k < this.cars.length; k += 1) {
        if (k === ci) continue;
        const o = this.cars[k];
        const ox = o.x - c.x, oz = o.z - c.z;
        if (ox * ox + oz * oz > 420) continue;
        const rel = ox * fx + oz * fz;
        if (rel <= 0 || rel > 20) continue;
        const latAbs = Math.abs(-ox * fz + oz * fx);
        if (latAbs < 2.6) brake = Math.max(brake, 1 - rel / 20);
      }
      // slow into corners
      if (dist < 16 && Math.abs(dy) > 0.05) brake = Math.max(brake, 0.42);

      // obey the signal at the node being approached
      const N2 = World.N;
      const onEdge = c.ni === 0 || c.nj === 0 || c.ni === N2 || c.nj === N2;
      if (!onEdge && dist < 26) {
        const axis = (c.dir === 0 || c.dir === 2) ? 0 : 1;
        const st = World.signalState(c.ni, c.nj, axis, Traffic.clock);
        if (st !== 2) {
          const stopAt = 7.5;                       // metres short of the centre
          const gap = dist - stopAt;
          if (gap < 18) brake = Math.max(brake, st === 1 && gap > 9 ? 0.5 : clamp01(1 - gap / 16));
          if (gap < 1.2) { c.speed = Math.min(c.speed, Math.max(0, gap * 1.6)); brake = 1; }
        }
      }

      c.brake = brake;
      const tgt = c.targetSpeed * (1 - brake);
      c.speed = damp(c.speed, Math.max(tgt, 0), brake > 0.05 ? 4.5 : 1.6, step);
      c.x += fx * c.speed * step;
      c.z += fz * c.speed * step;
      c.wheelSpin += c.speed / 0.33 * step;

      if (dist < 4.0) c.advance(rnd);

      // separation from the player so cars do not sit inside the hero car
      if (near && farSq < 36) {
        const d = Math.sqrt(farSq) || 1;
        const push = (6 - d) * 0.5;
        c.x += dxp / d * push; c.z += dzp / d * push;
        player.vel[0] -= dxp / d * push * 2.4;
        player.vel[2] -= dzp / d * push * 2.4;
        player.impact = Math.max(player.impact, clamp01(push * 0.5));
        c.speed *= 0.55;
      }
    }
  }
};

const TRAFFIC_COLORS = [
  [.52, .53, .56], [.08, .085, .09], [.72, .73, .75], [.14, .18, .30],
  [.32, .10, .11], [.10, .22, .18], [.55, .48, .38], [.20, .21, .24],
  [.62, .58, .50], [.28, .30, .34], [.45, .12, .10], [.10, .26, .36]
];

const PAINTS = [
  { n: 'Nardo', c: '#b9bcc0', r: .30, m: .05 },
  { n: 'Ember', c: '#e33a12', r: .22, m: .12 },
  { n: 'Midnight', c: '#0d1220', r: .18, m: .25 },
  { n: 'Acid', c: '#c9f227', r: .24, m: .08 },
  { n: 'Riviera', c: '#0f5fd8', r: .20, m: .18 },
  { n: 'Bone', c: '#e6e2d6', r: .30, m: .04 },
  { n: 'Plum', c: '#5a1a6b', r: .20, m: .22 },
  { n: 'Petrol', c: '#0b6a63', r: .22, m: .20 },
  { n: 'Sunburst', c: '#ffb020', r: .24, m: .14 },
  { n: 'Blood', c: '#8e0d18', r: .18, m: .26 },
  { n: 'Mint', c: '#8fe0c0', r: .26, m: .08 },
  { n: 'Graphite', c: '#3a3f46', r: .26, m: .30 },
];
