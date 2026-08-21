'use strict';
/* ============================================================
   Apex Drive — fuel, petrol stations, skill chains, radio
   ============================================================ */

/* ---------------- speed units ---------------- */
const UNITS = [
  { id: 'kmh', label: 'km/h', mul: 3.6, dist: 1000, distLabel: 'km' },
  { id: 'mph', label: 'mph', mul: 2.236936, dist: 1609.34, distLabel: 'mi' },
  { id: 'ms', label: 'm/s', mul: 1, dist: 1000, distLabel: 'km' },
];

/* ============================================================
   FUEL
   ============================================================ */
const Fuel = {
  cap: 62, level: 62, warned: false, refuelling: 0, station: null,
  pricePerL: 1.85,

  reset(full) { this.level = full ? this.cap : this.level; this.warned = false; },

  /* burn is proportional to the work the engine is doing, plus a small idle draw */
  update(car, dt, playing) {
    if (!playing) return;
    const ph = car.ph;
    const load = clamp01(car.throttleSm || 0);
    const rev = clamp01(car.rpm / ph.redline);
    const boost = car.boostPsi > 0 ? 1 + car.boostPsi * 0.03 : 1;
    const nos = car.nosActive ? 2.2 : 1;
    // litres per second — tuned so a full tank is roughly 12 minutes of hard driving
    const burn = (0.010 + load * rev * 0.125 * boost * nos) * (ph.baseTorque / 500) * dt;
    this.level = Math.max(0, this.level - burn);

    if (this.level < this.cap * 0.15 && !this.warned) {
      this.warned = true;
      Game.toast('Low fuel — find a petrol station', 'bad');
      Audio2.ui('deny');
    }
    if (this.level > this.cap * 0.3) this.warned = false;

    // refuel when stopped on a forecourt
    const st = Stations.nearest(car.pos[0], car.pos[2]);
    this.station = st;
    const onPad = st && st.d < 9 && car.speed < 1.4;
    if (onPad && this.level < this.cap - 0.05) {
      const want = Math.min(this.cap - this.level, 16 * dt);
      const cost = want * this.pricePerL;
      if (Garage.cash >= cost) {
        this.level += want;
        Garage.add(-cost);
        this.refuelling = 0.4;
        if (!this._pumpT || Game.time - this._pumpT > 0.28) {
          this._pumpT = Game.time; Audio2.blip(1500, .03, .025, 'sine');
        }
      } else if (!this._brokeT || Game.time - this._brokeT > 2) {
        this._brokeT = Game.time;
        Game.toast('Not enough cash for fuel', 'bad');
      }
    }
    this.refuelling = Math.max(0, this.refuelling - dt);
  },

  /* dry tank kills the engine */
  starve() { return this.level <= 0.01; },
  frac() { return clamp01(this.level / this.cap); },
};

/* ============================================================
   PETROL STATIONS
   ============================================================ */
const Stations = {
  list: [],

  build(rnd) {
    this.list = [];
    const N = World.N, C = World.CELL, half = World.half, B = World.BLOCK;
    // one forecourt on a handful of blocks, spread across the map
    const want = 7;
    const picks = new Set();
    let guard = 0;
    while (picks.size < want && guard++ < 400) {
      const bi = 1 + ((rnd() * (N - 2)) | 0), bj = 1 + ((rnd() * (N - 2)) | 0);
      const key = bi + ',' + bj;
      if (picks.has(key)) continue;
      // keep them apart
      let ok = true;
      for (const k of picks) {
        const [ai, aj] = k.split(',').map(Number);
        if (Math.abs(ai - bi) + Math.abs(aj - bj) < 5) { ok = false; break; }
      }
      if (!ok) continue;
      picks.add(key);
      const bx = -half + bi * C + C * .5, bz = -half + bj * C + C * .5;
      const side = (rnd() * 4) | 0;
      const off = B * .5 - 9;
      let x = bx, z = bz;
      if (side === 0) z = bz + off; else if (side === 1) z = bz - off;
      else if (side === 2) x = bx + off; else x = bx - off;
      this.list.push({ x, z, name: STATION_NAMES[this.list.length % STATION_NAMES.length] });
    }
    return this.list;
  },

  /* build the forecourt geometry through the world's push helpers */
  place() {
    const CURB = World.CURB;
    for (const s of this.list) {
      const { x, z } = s;
      // apron
      World._box(x, CURB + .03, z, 17, .06, 15, 0, [.34, .34, .335], .8, 0, 0, M_CONCRETE, 0);
      // canopy on four columns
      for (const sx of [-1, 1]) for (const sz of [-1, 1])
        World._box(x + sx * 6.2, CURB + 2.6, z + sz * 5.0, .38, 5.2, .38, 0, [.80, .80, .82], .45, .3, 0, M_METAL, 0);
      World._box(x, CURB + 5.5, z, 15.5, .55, 13, 0, [.88, .88, .90], .4, .2, 0, M_METAL, 0);
      World._box(x, CURB + 5.15, z, 15.8, .22, 13.3, 0, [.10, .55, .35], .5, 0, 1.5, M_EMISSIVE, 2);
      // underside lighting
      World._box(x, CURB + 5.16, z, 13, .06, 10.5, 0, [1, .97, .9], .3, 0, 2.2, M_EMISSIVE, 1);
      World.lights.push({ p: [x, Terrain.h(x, z) + CURB + 4.8, z], col: [1, .96, .88], rad: 30, kind: 'street' });
      // pumps
      for (const sx of [-1, 1]) {
        World._box(x + sx * 2.6, CURB + .18, z, 3.4, .36, 1.5, 0, [.30, .30, .31], .8, 0, 0, M_CONCRETE, 0);
        for (const sz of [-1.0, 1.0]) {
          World._box(x + sx * 2.6, CURB + 1.05, z + sz * .45, .95, 1.5, .55, 0, [.86, .86, .88], .45, .2, 0, M_PLASTIC, 0);
          World._box(x + sx * 2.6, CURB + 1.55, z + sz * .72, .68, .42, .06, 0, [.05, .35, .22], .3, 0, .9, M_EMISSIVE, 2);
        }
      }
      // shop
      World._box(x, CURB + 1.8, z - 6.6, 9, 3.6, 4.2, 0, [.62, .62, .60], .8, 0, 0, M_CONCRETE, 0);
      World._box(x, CURB + 2.0, z - 4.6, 8.2, 2.4, .12, 0, [.05, .07, .09], .08, .2, 0, M_GLASSDARK, 0);
      World._box(x, CURB + 4.0, z - 4.5, 7, .9, .18, 0, [.15, .85, .45], .4, 0, 2.6, M_EMISSIVE, 2);
      // price totem
      World._box(x + 7.6, CURB + 2.4, z + 6.2, .3, 4.8, .3, 0, [.5, .5, .52], .5, .5, 0, M_METAL, 0);
      World._box(x + 7.6, CURB + 4.6, z + 6.2, 2.2, 1.8, .22, 0, [.10, .55, .35], .4, 0, 2.2, M_EMISSIVE, 2);
      World.addCollider(x - 4.6, z - 8.8, x + 4.6, z - 4.4, 500);
    }
  },

  nearest(x, z) {
    let best = null, bd = 1e9;
    for (const s of this.list) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) { bd = d; best = s; }
    }
    return best ? { s: best, d: bd, x: best.x, z: best.z, name: best.name } : null;
  }
};

const STATION_NAMES = ['Vertex Fuel', 'Redline Petro', 'Apex Energy', 'Nightshift Gas',
  'Union Fuel Co.', 'Cobalt Services', 'Meridian Oil'];

/* ============================================================
   SKILL CHAIN — near misses, overtakes, air, drift
   ============================================================ */
const Skills = {
  chain: 0, mult: 1, timer: 0, total: 0,
  _passed: null, _lastNearT: 0, _lastAir: 0, _cleanT: 0,

  reset() {
    this.chain = 0; this.mult = 1; this.timer = 0;
    this._passed = new Map();
  },

  award(points, label, colour) {
    this.chain += points * this.mult;
    this.timer = 3.2;
    this.mult = Math.min(8, this.mult + 0.25);
    HUD.skill(label, Math.round(points * this.mult), colour);
    Audio2.skill(clamp01(this.mult / 6));
  },

  update(car, dt, playing) {
    if (!playing) { return; }
    if (!this._passed) this._passed = new Map();
    const kmh = Math.abs(car.fwdSpeed) * 3.6;
    const t = Game.time;

    /* --- near miss / overtake against traffic --- */
    const fwd = [0, 0, 0]; car.dirWorld(fwd, [0, 0, 1]);
    for (const c of Traffic.cars) {
      const dx = c.x - car.pos[0], dz = c.z - car.pos[2];
      const d2 = dx * dx + dz * dz;
      if (d2 > 900) continue;
      const d = Math.sqrt(d2);
      const ahead = dx * fwd[0] + dz * fwd[2];
      const lateral = Math.abs(-dx * fwd[2] + dz * fwd[0]);

      // near miss: very close alongside, at speed, without touching
      if (d < 3.4 && lateral < 3.0 && kmh > 55 && car.impact < 0.02 && t - this._lastNearT > 0.5) {
        this._lastNearT = t;
        this.award(kmh > 140 ? 140 : 70, kmh > 140 ? 'CLOSE CALL!' : 'NEAR MISS', '#ffcf6b');
      }
      // overtake: was ahead, now behind
      const prev = this._passed.get(c);
      if (prev === undefined) { this._passed.set(c, ahead > 0); continue; }
      if (prev && ahead < -1.5 && d < 16 && kmh > 45) {
        this._passed.set(c, false);
        this.award(55, 'OVERTAKE', '#9df3a6');
      } else if (!prev && ahead > 1.5) this._passed.set(c, true);
    }

    /* --- air --- */
    if (car.grounded === 0) this._lastAir = Math.max(this._lastAir, car.airTime);
    else if (this._lastAir > 0.55) {
      this.award(Math.round(this._lastAir * 130), this._lastAir > 1.6 ? 'HUGE AIR!' : 'AIR', '#7cf3ff');
      this._lastAir = 0;
    } else this._lastAir = 0;

    /* --- sustained speed --- */
    if (kmh > 210) {
      this._fastT = (this._fastT || 0) + dt;
      if (this._fastT > 2.5) { this._fastT = 0; this.award(120, 'VELOCITY', '#ff8fb0'); }
    } else this._fastT = 0;

    /* --- swerve: quick direction change at speed without spinning --- */
    const yawRate = Math.abs(car.av[1]);
    if (kmh > 70 && yawRate > 1.1 && car.driftAmount < 0.35 && car.grounded >= 3) {
      this._swerveT = (this._swerveT || 0) + dt;
      if (this._swerveT > 0.42) { this._swerveT = -0.8; this.award(60, 'SWERVE', '#c9a6ff'); }
    } else this._swerveT = Math.max(0, (this._swerveT || 0) - dt);

    /* --- chain decay and payout --- */
    if (this.timer > 0) {
      this.timer -= dt;
      if (car.impact > 0.25) {           // a crash breaks the chain
        HUD.skill('WRECKED', 0, '#ff3d68');
        this.chain = 0; this.mult = 1; this.timer = 0;
      } else if (this.timer <= 0) {
        const cash = Math.round(this.chain * 0.55);
        if (cash > 0) { Garage.add(cash); this.total += cash; HUD.popup('+' + money(cash), '#7cf37c'); }
        this.chain = 0; this.mult = 1;
      }
    }
  }
};

/* ============================================================
   RADIO — three generative stations, toggled any time
   ============================================================ */
const Radio = {
  on: false, station: 0, gain: null, ctx: null, timer: null, step: 0, vol: 0.5,
  stations: [
    {
      name: 'APEX FM', sub: 'synthwave',
      root: 55, scale: [0, 3, 5, 7, 10], bpm: 104, wave: 'sawtooth', pad: 1, drums: 1
    },
    {
      name: 'NIGHT DRIVE', sub: 'downtempo',
      root: 49, scale: [0, 2, 3, 7, 9], bpm: 84, wave: 'triangle', pad: 1, drums: 0
    },
    {
      name: 'REDLINE RADIO', sub: 'drive rock',
      root: 62, scale: [0, 2, 4, 7, 9], bpm: 128, wave: 'square', pad: 0, drums: 1
    },
  ],

  init() {
    if (!Audio2.ready || this.gain) return;
    this.ctx = Audio2.ctx;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 4200;
    this.gain.connect(lp); lp.connect(Audio2.master);
    this.filter = lp;
  },

  toggle() {
    Audio2.start(); this.init();
    this.on = !this.on;
    if (this.on) this.play(); else this.stop();
    Game.toast(this.on ? ('Radio · ' + this.stations[this.station].name) : 'Radio off');
    HUD.radio(this.on, this.stations[this.station]);
  },

  next() {
    this.station = (this.station + 1) % this.stations.length;
    if (this.on) { this.stop(); this.play(); }
    Game.toast('Radio · ' + this.stations[this.station].name);
    HUD.radio(this.on, this.stations[this.station]);
  },

  setVolume(v) { this.vol = v; if (this.gain) this.gain.gain.setTargetAtTime(this.on ? v * 0.28 : 0, this.ctx.currentTime, 0.2); },

  play() {
    if (!this.gain) return;
    const st = this.stations[this.station];
    this.gain.gain.setTargetAtTime(this.vol * 0.28, this.ctx.currentTime, 0.4);
    const beat = 60 / st.bpm / 2;
    this.step = 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(st), beat * 1000);
  },

  stop() {
    clearInterval(this.timer); this.timer = null;
    if (this.gain) this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
  },

  note(semi, dur, vol, type, when) {
    const ctx = this.ctx, t = when || ctx.currentTime;
    const f = 440 * Math.pow(2, (semi - 69) / 12);
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.gain);
    o.start(t); o.stop(t + dur + 0.03);
  },

  tick(st) {
    const s = this.step++;
    const bar = (s >> 3) % 4;
    const prog = [0, 5, 3, 4];              // i - VI - IV - V feel
    const deg = prog[bar];
    const ctx = this.ctx, now = ctx.currentTime;

    // bass on the beat
    if (s % 2 === 0) this.note(st.root + st.scale[deg % st.scale.length] - 12, 0.22, 0.24, 'sine', now);
    // arpeggio
    const arp = st.scale[(s * 2 + deg) % st.scale.length];
    this.note(st.root + arp + 12, 0.16, 0.075, st.wave, now);
    if (s % 4 === 2) this.note(st.root + arp + 19, 0.20, 0.045, st.wave, now + 0.02);
    // pad every bar
    if (st.pad && s % 8 === 0) {
      for (const k of [0, 3, 7]) this.note(st.root + st.scale[deg % st.scale.length] + k, 1.5, 0.030, 'triangle', now);
    }
    // drums
    if (st.drums) {
      if (s % 4 === 0) Audio2._burst({ f0: 90, f1: 45, dur: 0.13, vol: 0.16, q: 1.2, type: 'lowpass' });
      if (s % 8 === 4) Audio2._burst({ f0: 1800, dur: 0.10, vol: 0.07, q: 1.0 });
      if (s % 2 === 1) Audio2._burst({ f0: 8000, dur: 0.03, vol: 0.022, q: 2.0, type: 'highpass' });
    }
  }
};
