'use strict';
/* ============================================================
   Apex Drive — vehicle dynamics
   Rigid body + 4 raycast wheels + slip-curve tyres + drivetrain
   ============================================================ */

const AIR = 1.225;

function magicLat(a) {   // a = slip angle (rad)
  const B = 9.4, C = 1.86, E = 0.96;
  const bx = B * a;
  return Math.sin(C * Math.atan(bx - E * (bx - Math.atan(bx))));
}
function magicLong(k) {  // k = slip ratio
  const B = 11.5, C = 1.62, E = 0.92;
  const bx = B * k;
  return Math.sin(C * Math.atan(bx - E * (bx - Math.atan(bx))));
}
function torqueCurve(t) { // t = rpm / redline -> normalised torque
  const x = clamp01(t);
  // broad flat plateau like a big modern engine, soft tail past the peak
  let v = 0.66 + 0.90 * x - 0.62 * x * x;
  if (x > 0.80) v *= lerp(1, 0.84, (x - 0.80) / 0.20);
  if (x < 0.12) v *= lerp(0.72, 1, x / 0.12);
  return clamp(v, 0.20, 1.05);
}

class Wheel {
  constructor(x, y, z, radius, width, steered, driven, handbraked) {
    this.lp = [x, y, z];
    this.r = radius; this.width = width;
    this.steered = steered; this.driven = driven; this.hand = handbraked;
    this.rest = 0.34;          // suspension travel
    this.comp = 0; this.compV = 0; this.prevComp = 0;
    this.omega = 0;            // rad/s
    this.contact = false;
    this.load = 0;
    this.slipL = 0; this.slipA = 0; this.skid = 0;
    this.spin = 0;             // visual roll angle
    this.steer = 0;
    this.wp = [0, 0, 0];       // world hub position
    this.cp = [0, 0, 0];       // contact point
    this.surface = 0;          // 0 road, 1 kerb/pavement, 2 grass
    this.Iw = 1.5;
  }
}

class Vehicle {
  constructor(spec, isAI, phys) {
    this.spec = spec;
    this.ph = phys || spec.phys;
    this.isAI = !!isAI;
    this.pos = [0, 1, 0];
    this.vel = [0, 0, 0];
    this.q = Q.n();
    this.av = [0, 0, 0];
    this.mass = this.ph.mass;
    const L = spec.len, W = spec.width, H = 1.3;
    this.I = [
      this.mass / 12 * (H * H + L * L),
      this.mass / 12 * (W * W + L * L),
      this.mass / 12 * (W * W + H * H)
    ];
    const R = spec.wheelR, hub = R + 0.26;
    this.wheels = [
      new Wheel(-spec.trackF, hub, spec.axleF, R, spec.wheelW, true, this.ph.drive !== 'rwd', false),
      new Wheel(spec.trackF, hub, spec.axleF, R, spec.wheelW, true, this.ph.drive !== 'rwd', false),
      new Wheel(-spec.trackR, hub, spec.axleR, R, spec.wheelW, false, this.ph.drive !== 'fwd', true),
      new Wheel(spec.trackR, hub, spec.axleR, R, spec.wheelW, false, this.ph.drive !== 'fwd', true),
    ];
    for (const w of this.wheels) w.Iw = 0.55 * 22 * w.r * w.r;

    this.steer = 0; this.steerTarget = 0;
    this.throttle = 0; this.brake = 0; this.handbrake = 0;
    this.gear = 1; this.shiftT = 0;
    this.idle = this.ph.idleRpm || 900;
    this.rpm = this.idle;
    this.manual = 0;
    this.clutchPedal = 0;
    this.clutchEngage = 1;
    this.boostPsi = 0;
    this.forced = this.ph.forced || 'none';
    this.maxBoostPsi = this.ph.maxBoostPsi || 0;
    this.nos = 1; this.nosActive = 0;
    this.wetness = 0;
    this.boost = 1; this.boostActive = 0;
    this.shiftFlash = 0; this.lastShiftDir = 0; this.onLimiter = 0;
    this.damage = 0; this.scrape = 0;
    this.speed = 0; this.fwdSpeed = 0;
    this.slipAngle = 0; this.driftAmount = 0;
    this.grounded = 4; this.airTime = 0;
    this.engineLoad = 0;
    this.impact = 0; this.lastImpactT = -99;
    this.odo = 0;
    this.reverse = false;
    this._acc = 0;
    this._tmp = [0, 0, 0]; this._tmp2 = [0, 0, 0];
    this._colliders = [];
    this.headlights = 0;
    this.brakeLight = 0;
    this.wheelieGuard = 0;
    this.stuckT = 0;
  }

  reset(x, z, yaw, y) {
    V3.set(this.pos, x, (y === undefined ? 0.9 : y), z);
    V3.set(this.vel, 0, 0, 0);
    V3.set(this.av, 0, 0, 0);
    Q.axisAngle(this.q, 0, 1, 0, yaw);
    for (const w of this.wheels) { w.omega = 0; w.comp = 0; w.skid = 0; }
    this.gear = 1; this.rpm = this.idle; this.steer = 0; this.speed = 0;
    this.boost = 1;
  }

  /* body-space -> world */
  toWorld(out, lp) { Q.rot(out, this.q, lp); out[0] += this.pos[0]; out[1] += this.pos[1]; out[2] += this.pos[2]; return out; }
  dirWorld(out, ld) { return Q.rot(out, this.q, ld); }

  pointVel(out, rx, ry, rz) {
    out[0] = this.vel[0] + (this.av[1] * rz - this.av[2] * ry);
    out[1] = this.vel[1] + (this.av[2] * rx - this.av[0] * rz);
    out[2] = this.vel[2] + (this.av[0] * ry - this.av[1] * rx);
    return out;
  }

  /* In reverse the pedals swap: the brake pedal drives backwards and the
     accelerator becomes the brake. Without this, holding the brake in
     reverse fed the engine zero throttle and the car simply sat there. */
  mapPedals(input) {
    if (this.gear !== 0) return input;
    return { steer: input.steer, throttle: input.brake, brake: input.throttle };
  }

  update(dt, input, world) {
    this.rawInput = input;
    const inp = this.mapPedals(input);
    this.pedal = inp;
    const steps = clamp(Math.ceil(dt / (1 / 180)), 1, 8);
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h, inp, world);
    this.postUpdate(dt);
  }

  step(dt, inp, world) {
    const ph = this.ph, m = this.mass;
    const up = [0, 0, 0], fwd = [0, 0, 0], right = [0, 0, 0];
    this.dirWorld(up, [0, 1, 0]);
    this.dirWorld(fwd, [0, 0, 1]);
    this.dirWorld(right, [1, 0, 0]);

    const F = [0, -9.81 * m, 0];
    const T = [0, 0, 0];
    const addForce = (fx, fy, fz, rx, ry, rz) => {
      F[0] += fx; F[1] += fy; F[2] += fz;
      T[0] += ry * fz - rz * fy;
      T[1] += rz * fx - rx * fz;
      T[2] += rx * fy - ry * fx;
    };

    this.speed = V3.len(this.vel);
    this.fwdSpeed = V3.dot(this.vel, fwd);

    /* ---------- steering ---------- */
    const spdKmh = this.speed * 3.6;
    const steerLimit = lerp(1.0, 0.34, clamp01((spdKmh - 25) / 190));
    // a bent car pulls to one side
    const pull = this.damage > 0.25 ? (this.damageSide || 0) * (this.damage - 0.25) * 0.16 : 0;
    const target = clamp(inp.steer + pull, -1, 1) * ph.steerMax * steerLimit;
    const rate = (Math.abs(target) > Math.abs(this.steer) ? 5.2 : 8.5) * dt * (this.isAI ? 1.6 : 1);
    this.steer = moveTo(this.steer, target, rate);

    /* ---------- aero ---------- */
    const v2 = this.speed * this.speed;
    if (this.speed > 0.1) {
      const cda = ph.drag * 2.0;
      const dragF = 0.5 * AIR * cda * v2;
      addForce(-this.vel[0] / this.speed * dragF, -this.vel[1] / this.speed * dragF, -this.vel[2] / this.speed * dragF, 0, 0, 0);
    }
    const dfF = 0.5 * AIR * ph.dfF * v2, dfR = 0.5 * AIR * ph.dfR * v2;

    /* ---------- drivetrain ---------- */
    const drivenWheels = this.wheels.filter(w => w.driven);
    let avgOmega = 0;
    for (const w of drivenWheels) avgOmega += w.omega;
    avgOmega /= Math.max(drivenWheels.length, 1);

    const gearRatio = this.gear === 0 ? -(ph.gears[0] * 1.28) : ph.gears[Math.min(this.gear - 1, ph.gears.length - 1)];
    const totalRatio = gearRatio * ph.final;

    this.shiftT = Math.max(0, this.shiftT - dt);
    const shifting = this.shiftT > 0;

    // clutch: released while shifting, or when the driver holds it
    const wantEngage = (shifting ? 0 : 1) * (1 - this.clutchPedal);
    this.clutchEngage = damp(this.clutchEngage, wantEngage,
      wantEngage > this.clutchEngage ? 9 * (ph.clutchGrab || 1) : 26, dt);

    const targetRpm = Math.abs(avgOmega * totalRatio) * 9.5493;
    if (this.clutchEngage > 0.45) {
      this.rpm = damp(this.rpm, clamp(targetRpm, this.idle, ph.redline * 1.03), lerp(6, 15, this.clutchEngage), dt);
    } else {
      const free = this.idle + inp.throttle * (ph.redline * 1.02 - this.idle);
      this.rpm = clamp(damp(this.rpm, free, inp.throttle > 0.08 ? 4.2 : 3.0, dt), this.idle, ph.redline * 1.03);
    }

    let throttle = inp.throttle;
    if (shifting) throttle *= this.manual ? 0.25 : 0.10;
    // reverse is governed, no car does 70 km/h backwards
    if (this.gear === 0) throttle *= 1 - smoothstep(8.5, 11.0, -this.fwdSpeed);

    let limiter = 1;
    if (this.rpm >= ph.redline) { limiter = 0.02; this.rpm -= 1400 * dt; }
    this.onLimiter = limiter < 0.5 ? 1 : 0;

    /* forced induction */
    const bTarget = boostAt(this.rpm, ph) * clamp01(throttle * 1.2);
    if (ph.forced === 'turbo') {
      const rate = throttle > 0.25 ? 1 / Math.max(0.06, ph.turboLag) : 7.5;
      this.boostPsi = damp(this.boostPsi, bTarget, rate, dt);
    } else if (ph.forced === 'super') {
      this.boostPsi = damp(this.boostPsi, bTarget, 22, dt);
    } else this.boostPsi = 0;
    this.maxBoostPsi = ph.maxBoostPsi;
    this.forced = ph.forced;

    /* nitrous */
    if (this.nosActive && this.nos > 0 && ph.nosShot > 0) {
      this.nos = Math.max(0, this.nos - dt / Math.max(1, ph.nosTank));
      if (this.nos <= 0) this.nosActive = 0;
    } else if (!this.nosActive) {
      this.nos = Math.min(1, this.nos + dt * 0.055);
    }
    const nosMul = (this.nosActive && this.nos > 0) ? (1 + ph.nosShot) : 1;

    const shape = torqueShape(this.rpm / ph.redline, ph);
    const healthy = 1 - this.damage * 0.32;
    const engTorque = ph.baseTorque * shape * (1 + this.boostPsi * ph.boostVE) * nosMul * throttle * limiter * healthy;
    this.engineTorque = engTorque;
    this.enginePower = engTorque * this.rpm / 7127;

    let wheelTorque = engTorque * totalRatio * 0.90 * this.clutchEngage / Math.max(drivenWheels.length, 1);
    if (drivenWheels.length >= 2 && (ph.diffLock === undefined ? 0.5 : ph.diffLock) < 0.99) {
      let spread = 0;
      for (let a2 = 0; a2 + 1 < drivenWheels.length; a2 += 2)
        spread = Math.max(spread, Math.abs(drivenWheels[a2].omega - drivenWheels[a2 + 1].omega));
      wheelTorque *= 1 - (1 - (ph.diffLock || 0)) * clamp01(spread / 55) * 0.55;
    }

    /* ---------- wheels ---------- */
    let grounded = 0;
    const cp = [0, 0, 0], wp = [0, 0, 0], down = [0, 0, 0], cv = [0, 0, 0];
    const gN = this._gn || (this._gn = [0, 1, 0]);
    V3.set(down, -up[0], -up[1], -up[2]);

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      // hub attach point in world
      this.toWorld(wp, w.lp);
      V3.copy(w.wp, wp);
      const maxLen = w.rest + w.r;
      // the hub height is what tells the world which surface this wheel is
      // on when it is standing over a bridge rather than merely near one
      const gY = world.groundY(wp[0], wp[2], wp[1]);
      world.groundNormal(wp[0], wp[2], gN, wp[1]);
      let t = 1e9;
      if (down[1] < -0.15) t = (wp[1] - gY) / -down[1];
      w.prevComp = w.comp;
      if (t <= maxLen && t >= 0) {
        w.contact = true; grounded++;
        w.comp = maxLen - t;
        cp[0] = wp[0] + down[0] * t; cp[1] = gY; cp[2] = wp[2] + down[2] * t;
        V3.copy(w.cp, cp);
        w.surface = world.isOnBlock(wp[0], wp[2]) ? 1 : 0;
      } else {
        w.contact = false;
        w.comp = Math.max(0, w.comp - dt * 3.5);
        V3.set(w.cp, wp[0], wp[1] - maxLen, wp[2]);
      }
      w.compV = (w.comp - w.prevComp) / dt;

      if (!w.contact) {
        // free wheel: engine torque still spins it, brakes still slow it
        const brakeT = (inp.brake * ph.brake * 900 + (w.hand ? this.handbrake * 2600 : 0));
        const dw = ((w.driven ? wheelTorque : 0) - Math.sign(w.omega) * Math.min(Math.abs(w.omega) * w.Iw / dt, brakeT)) / w.Iw;
        w.omega += dw * dt;
        w.omega *= (1 - 0.4 * dt);
        w.load = 0; w.skid = damp(w.skid, 0, 6, dt);
        continue;
      }

      /* suspension */
      const isFront = i < 2;
      const k = (isFront ? 46000 : 44000) * (m / 1500);
      const c = (isFront ? 4200 : 4000) * (m / 1500);
      let susp = k * w.comp - c * -w.compV;
      susp = clamp(susp, 0, 46000);
      // anti-roll bar
      const other = this.wheels[i ^ 1];
      const arb = (w.comp - other.comp) * (isFront ? 16000 : 13000) / Math.max(0.5, ph.rollStiff || 1);
      susp -= arb;
      susp = Math.max(susp, 0);
      susp += isFront ? dfF * 0.5 : dfR * 0.5;
      w.load = susp;

      const rx = cp[0] - this.pos[0], ry = cp[1] - this.pos[1], rz = cp[2] - this.pos[2];
      let sux = lerp(up[0], gN[0], 0.55), suy = lerp(up[1], gN[1], 0.55), suz = lerp(up[2], gN[2], 0.55);
      const sul = Math.hypot(sux, suy, suz) || 1;
      sux /= sul; suy /= sul; suz /= sul;
      addForce(sux * susp, suy * susp, suz * susp, rx, ry, rz);

      /* tyre frame projected onto the contact plane, not the horizontal —
         this is what lets the car climb and be pulled back down by gravity */
      const st = w.steered ? this.steer : 0;
      const cs = Math.cos(st), sn = Math.sin(st);
      let fx = fwd[0] * cs + right[0] * sn, fy = fwd[1] * cs + right[1] * sn, fz = fwd[2] * cs + right[2] * sn;
      const gnx = gN[0], gny = gN[1], gnz = gN[2];
      const fd = fx * gnx + fy * gny + fz * gnz;
      fx -= gnx * fd; fy -= gny * fd; fz -= gnz * fd;
      let fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      // right = normal x forward
      const sx = gny * fz - gnz * fy, sy = gnz * fx - gnx * fz, sz = gnx * fy - gny * fx;

      this.pointVel(cv, rx, ry, rz);
      const vF = cv[0] * fx + cv[1] * fy + cv[2] * fz;
      const vS = cv[0] * sx + cv[1] * sy + cv[2] * sz;

      const surfMu = w.surface === 1 ? 0.86 : 1.0;
      const wetMu = this.wetness ? lerp(1, (ph.wetGrip === undefined ? 1 : ph.wetGrip) * 0.86, this.wetness) : 1;
      let muL = (isFront ? ph.gripF : ph.gripR) * surfMu * wetMu;
      let muX = muL;
      if (w.hand && this.handbrake > 0.05) muL *= lerp(1, 0.42, this.handbrake);
      if (ph.slideMul && ph.slideMul !== 1 && !isFront) muL *= lerp(1, 1 / ph.slideMul, 0.35);

      /* longitudinal — semi-implicit so it stays stable at any frame rate */
      const brakeBias = isFront ? 0.62 : 0.38;
      let brakeT = inp.brake * ph.brake * 3400 * brakeBias;
      if (w.hand) brakeT += this.handbrake * 5200;
      const vRef = Math.max(Math.abs(vF), 2.2);
      const peak = w.load * muX;
      // slope of the longitudinal curve at zero slip, expressed per m/s of slip speed
      const Cs = Math.max(peak * 18.6 / vRef, 1.0);
      const driveT = w.driven ? wheelTorque : 0;
      let om = (w.omega + dt / w.Iw * (driveT + Cs * w.r * vF)) / (1 + dt * Cs * w.r * w.r / w.Iw);

      let kappa = clamp((om * w.r - vF) / vRef, -8, 8);
      let Fx = peak * magicLong(kappa);
      // the implicit step used a linear tyre; hand back the difference so the
      // wheel can actually break traction and spin up
      const Flin = Cs * (om * w.r - vF);
      om += (Flin - Fx) * w.r / w.Iw * dt * 0.65;

      // brakes: torque opposing rotation, capped so it cannot reverse the wheel
      const bt = Math.min(brakeT, Math.abs(om) * w.Iw / dt);
      om -= Math.sign(om) * bt * dt / w.Iw;
      w.omega = om;
      kappa = clamp((om * w.r - vF) / vRef, -8, 8);
      Fx = peak * magicLong(kappa);

      /* lateral */
      const alpha = Math.atan2(-vS, Math.max(Math.abs(vF), 1.4));
      let Fy = w.load * muL * magicLat(alpha);

      /* friction circle */
      const maxF = w.load * Math.max(muL, muX) * 1.05;
      const comb = Math.hypot(Fx, Fy);
      if (comb > maxF && comb > 1e-3) { const sc = maxF / comb; Fx *= sc; Fy *= sc; }

      if (Math.abs(w.omega) < 0.05 && Math.abs(vF) < 0.4 && inp.throttle < 0.05) w.omega = 0;

      w.slipL = kappa; w.slipA = alpha;
      const skidAmt = clamp01((Math.abs(alpha) - 0.14) * 2.6) + clamp01((Math.abs(kappa) - 0.28) * 1.1);
      w.skid = damp(w.skid, clamp01(skidAmt) * clamp01(this.speed / 3), 14, dt);

      addForce(fx * Fx + sx * Fy, fy * Fx + sy * Fy, fz * Fx + sz * Fy, rx, ry, rz);

      // rolling resistance
      const rr = w.load * 0.014;
      addForce(-fx * rr * Math.sign(vF), -fy * rr * Math.sign(vF), -fz * rr * Math.sign(vF), rx, ry, rz);
    }
    this.grounded = grounded;

    /* keep the car from tipping over too easily */
    if (grounded >= 3) {
      const roll = Math.asin(clamp(right[1], -1, 1));
      T[0] -= 0; // handled by suspension
      this.av[1] *= 1 - 0.02;
    }

    /* ---------- integrate ---------- */
    this.vel[0] += F[0] / m * dt; this.vel[1] += F[1] / m * dt; this.vel[2] += F[2] / m * dt;

    const tb = [0, 0, 0];
    Q.invRot(tb, this.q, T);
    tb[0] /= this.I[0]; tb[1] /= this.I[1]; tb[2] /= this.I[2];
    const tw = [0, 0, 0];
    Q.rot(tw, this.q, tb);
    this.av[0] += tw[0] * dt; this.av[1] += tw[1] * dt; this.av[2] += tw[2] * dt;
    // angular damping
    const ad = 1 - 1.1 * dt;
    this.av[0] *= ad; this.av[2] *= ad; this.av[1] *= 1 - 0.35 * dt;
    if (grounded === 0) { this.av[0] *= 1 - 1.6 * dt; this.av[2] *= 1 - 1.6 * dt; }

    this.pos[0] += this.vel[0] * dt; this.pos[1] += this.vel[1] * dt; this.pos[2] += this.vel[2] * dt;
    Q.integrate(this.q, this.q, this.av, dt);

    /* ---------- collisions ---------- */
    this.collide(world, dt);

    /* floor guard */
    // last-resort anti-tunnelling floor; must sit well below the static ride
    // height or it carries the car instead of the springs
    const gy = world.groundY(this.pos[0], this.pos[2], this.pos[1]);
    if (this.pos[1] < gy - 0.30) { this.pos[1] = gy - 0.30; if (this.vel[1] < 0) this.vel[1] *= -0.15; }
  }

  collide(world, dt) {
    const L = this.spec.len, W = this.spec.width;
    const r = W * 0.46;
    const pts = [[0, 0.55, L * 0.34], [0, 0.55, 0], [0, 0.55, -L * 0.34]];
    const wp = [0, 0, 0], cv = [0, 0, 0];
    const cols = world.queryColliders(this.pos[0], this.pos[2], this._colliders);
    let hit = 0;
    for (const lp of pts) {
      this.toWorld(wp, lp);
      for (let ci = 0; ci < cols.length; ci++) {
        const c = cols[ci];
        if (wp[1] > c.y + r) continue;
        if (c.y0 !== undefined && wp[1] < c.y0 - r) continue;   // passing underneath
        const cx = clamp(wp[0], c.x0, c.x1), cz = clamp(wp[2], c.z0, c.z1);
        let dx = wp[0] - cx, dz = wp[2] - cz;
        let d = Math.hypot(dx, dz);
        let nx, nz;
        if (d < 1e-5) {
          // centre inside: push out through the nearest face
          const dl = wp[0] - c.x0, dr = c.x1 - wp[0], db = wp[2] - c.z0, df = c.z1 - wp[2];
          const mn = Math.min(dl, dr, db, df);
          nx = mn === dl ? -1 : mn === dr ? 1 : 0;
          nz = mn === db ? -1 : mn === df ? 1 : 0;
          d = -mn;
        } else { nx = dx / d; nz = dz / d; }
        if (d >= r) continue;
        const pen = r - d;
        this.pos[0] += nx * pen; this.pos[2] += nz * pen;
        // impulse
        const rx = wp[0] - this.pos[0], ry = wp[1] - this.pos[1], rz = wp[2] - this.pos[2];
        this.pointVel(cv, rx, ry, rz);
        const vn = cv[0] * nx + cv[2] * nz;
        if (vn < 0) {
          const e = 0.22;
          const j = -(1 + e) * vn * this.mass * 0.55;
          this.vel[0] += nx * j / this.mass; this.vel[2] += nz * j / this.mass;
          // spin from the off-centre hit
          const tq = (rz * (nx * j) - rx * (nz * j)) / this.I[1];
          this.av[1] += tq * 0.55;
          // tangential scrub
          const tvx = cv[0] - nx * vn, tvz = cv[2] - nz * vn;
          this.vel[0] -= tvx * 0.16; this.vel[2] -= tvz * 0.16;
          hit = Math.max(hit, Math.min(1, -vn / 16));
        }
      }
    }
    // world bounds
    // the drivable area now reaches past the ring motorway, not just the city
    const lim = world.ring ? world.ring.R + 240 : world.half + 130;
    for (const ax of [0, 2]) {
      if (this.pos[ax] < -lim) { this.pos[ax] = -lim; this.vel[ax] = Math.abs(this.vel[ax]) * 0.3; hit = Math.max(hit, 0.3); }
      if (this.pos[ax] > lim) { this.pos[ax] = lim; this.vel[ax] = -Math.abs(this.vel[ax]) * 0.3; hit = Math.max(hit, 0.3); }
    }
    if (hit > 0.02) {
      this.impact = Math.max(this.impact, hit);
      if (hit > 0.08) {
        this.damage = clamp01(this.damage + hit * 0.075);
        if (!this.damageSide) this.damageSide = Math.random() < 0.5 ? -1 : 1;
      }
    }
    this.scrape = damp(this.scrape, hit > 0.005 && hit < 0.09 ? 1 : 0, 10, dt);
  }

  postUpdate(dt) {
    const fwd = [0, 0, 0], up = [0, 0, 0];
    this.dirWorld(fwd, [0, 0, 1]);
    this.dirWorld(up, [0, 1, 0]);
    this.speed = V3.len(this.vel);
    this.fwdSpeed = V3.dot(this.vel, fwd);
    const flatV = Math.hypot(this.vel[0], this.vel[2]);
    this.slipAngle = flatV > 2.2 ? Math.abs(wrapPi(Math.atan2(this.vel[0], this.vel[2]) - Math.atan2(fwd[0], fwd[2]))) : 0;
    this.driftAmount = clamp01((this.slipAngle - 0.16) * 2.4) * clamp01(flatV / 8);
    this.airTime = this.grounded === 0 ? this.airTime + dt : 0;
    this.odo += this.speed * dt;

    for (const w of this.wheels) {
      w.spin += w.omega * dt;
      w.steer = w.steered ? this.steer : 0;
    }
    this.impact = Math.max(0, this.impact - dt * 2.2);
    this.shiftFlash = Math.max(0, this.shiftFlash - dt * 3.4);
    this.moneyShift = 0;
    this.upness = up[1];
  }

  /* driver-operated sequential shift */
  shiftUp() {
    const ph = this.ph;
    if (this.shiftT > 0) return 0;
    if (this.gear === 0) { this.gear = 1; this.shiftT = ph.shiftTime; this.shiftFlash = 1; return 1; }
    if (this.gear >= ph.gears.length) return 0;
    this.gear++; this.shiftT = ph.shiftTime; this.lastShiftDir = 1; this.shiftFlash = 1;
    return 1;
  }

  shiftDown() {
    const ph = this.ph;
    if (this.shiftT > 0) return 0;
    if (this.gear <= 1) {
      if (this.gear === 1 && Math.abs(this.fwdSpeed) < 1.5) { this.gear = 0; this.shiftT = ph.shiftTime; return 1; }
      return 0;
    }
    const nextRatio = ph.gears[this.gear - 2] * ph.final;
    const projected = Math.abs(this.fwdSpeed / this.wheels[2].r * nextRatio) * 9.5493;
    if (projected > ph.redline * 1.10) { this.moneyShift = 1; return -1; }
    this.gear--; this.shiftT = ph.shiftTime; this.lastShiftDir = -1; this.shiftFlash = 1;
    this.rpm = Math.min(ph.redline, Math.max(this.rpm, projected));
    return 1;
  }

  /* automatic gearbox — fed the raw pedals, never the reverse-swapped ones */
  autoGearbox(dt, raw) {
    const ph = this.ph;
    if (this.shiftT > 0) return;
    if (this.manual) {
      // in manual the driver picks the gears, but holding the brake at a
      // standstill still drops into reverse — otherwise it feels broken
      if (this.gear === 1 && raw.brake > 0.5 && raw.throttle < 0.06 && Math.abs(this.fwdSpeed) < 0.9) {
        this.revHold = (this.revHold || 0) + dt;
        if (this.revHold > 0.65) { this.gear = 0; this.shiftT = ph.shiftTime; this.revHold = 0; }
      } else if (this.gear === 0 && raw.throttle > 0.2 && this.fwdSpeed > -0.8) {
        this.fwdHold = (this.fwdHold || 0) + dt;
        if (this.fwdHold > 0.35) { this.gear = 1; this.shiftT = ph.shiftTime; this.fwdHold = 0; }
      } else { this.revHold = 0; this.fwdHold = 0; }
      return;
    }
    const kmh = this.fwdSpeed * 3.6;

    if (this.gear === 0) {
      // pressing the accelerator while stopped or still rolling back picks 1st
      if (raw.throttle > 0.15 && this.fwdSpeed > -0.8) {
        this.fwdHold = (this.fwdHold || 0) + dt;
        if (this.fwdHold > 0.16) { this.gear = 1; this.shiftT = ph.shiftTime; this.fwdHold = 0; }
      } else this.fwdHold = 0;
      return;
    }

    // holding the brake at a standstill drops it into reverse
    if (raw.brake > 0.45 && raw.throttle < 0.06 && Math.abs(this.fwdSpeed) < 0.9 && this.gear <= 1) {
      this.revHold = (this.revHold || 0) + dt;
      if (this.revHold > 0.28) { this.gear = 0; this.shiftT = ph.shiftTime; this.revHold = 0; }
      return;
    }
    this.revHold = 0;

    this.shiftLock = Math.max(0, (this.shiftLock || 0) - dt);
    if (this.shiftLock > 0) return;
    const upAt = ph.redline * (raw.throttle > 0.7 ? 0.955 : 0.72);
    const downAt = ph.redline * 0.44;
    if (this.rpm > upAt && this.gear < ph.gears.length && kmh > 14 * this.gear) {
      this.gear++; this.shiftT = ph.shiftTime; this.shiftLock = 0.45; this.shiftFlash = 1;
    } else if (this.rpm < downAt && this.gear > 1) {
      this.gear--; this.shiftT = ph.shiftTime * 0.9; this.shiftLock = 0.35; this.shiftFlash = 1;
    }
  }

}
