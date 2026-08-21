'use strict';
/* ============================================================
   Apex Drive — audio engine

   The engine note is NOT an oscillator drone. Each cylinder's
   combustion event is rendered offline into a one-cycle buffer
   (thump + crack + pipe resonance), looped, and pitch-shifted by
   playbackRate. Five buffers are rendered at different reference
   RPMs and cross-faded so the formants stay put while the note
   climbs — the same multisample trick real engine-sound middleware
   uses. Two load variants (overrun / wide-open) blend on throttle.
   ============================================================ */

const ENGINE_ZONES = [820, 2000, 3600, 5600, 8200];

/* firing patterns: fraction-of-cycle offsets. Cross-plane V8s fire
   unevenly across the banks, which is where the burble comes from. */
const FIRING = {
  i4: { cyl: 4, jitter: [0, 0, 0, 0], thump: 118, res: 196, crack: 0.55, body: 0.85 },
  i6: { cyl: 6, jitter: [0, 0, 0, 0, 0, 0], thump: 104, res: 250, crack: 0.42, body: 0.95 },
  v6: { cyl: 6, jitter: [0, .016, 0, .016, 0, .016], thump: 110, res: 214, crack: 0.5, body: 0.92 },
  v8: { cyl: 8, jitter: [0, .022, 0, -.018, 0, .022, 0, -.018], thump: 92, res: 168, crack: 0.62, body: 1.0 },
  v10: { cyl: 10, jitter: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], thump: 88, res: 300, crack: 0.78, body: 0.8 },
  v12: { cyl: 12, jitter: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], thump: 84, res: 340, crack: 0.72, body: 0.74 },
  flat6: { cyl: 6, jitter: [0, .01, 0, .01, 0, .01], thump: 96, res: 268, crack: 0.68, body: 0.86 },
  rotary: { cyl: 6, jitter: [0, 0, 0, 0, 0, 0], thump: 76, res: 420, crack: 0.9, body: 0.6 },
  ev: { cyl: 2, jitter: [0, 0], thump: 60, res: 900, crack: 0.05, body: 0.3 },
};

const Audio2 = {
  ctx: null, ready: false, master: null, volume: 0.75,
  engineType: 'v8', zones: [], nodes: {}, _lastLoad: 0, _lastRpm: 900,
  _popT: 0, _muted: false,

  /* ---------------------------------------------------------- */
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    const sr = ctx.sampleRate;

    const master = this.master = ctx.createGain();
    master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 24; comp.ratio.value = 6;
    comp.attack.value = 0.005; comp.release.value = 0.18;
    master.connect(comp); comp.connect(ctx.destination);

    /* ---- shared noise ---- */
    const nlen = sr * 3;
    const nbuf = ctx.createBuffer(2, nlen, sr);
    for (let c = 0; c < 2; c++) {
      const d = nbuf.getChannelData(c);
      let l = 0;
      for (let i = 0; i < nlen; i++) { const w = Math.random() * 2 - 1; l = l * 0.18 + w * 0.82; d[i] = l; }
    }
    this.noiseBuf = nbuf;
    const mkNoise = (rate) => {
      const s = ctx.createBufferSource(); s.buffer = nbuf; s.loop = true;
      if (rate) s.playbackRate.value = rate;
      s.start(); return s;
    };
    this._mkNoise = mkNoise;

    /* ---- small generated reverb (street / tunnel tail) ---- */
    const irLen = (sr * 1.15) | 0;
    const ir = ctx.createBuffer(2, irLen, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.1) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
      }
    }
    const conv = ctx.createConvolver(); conv.buffer = ir;
    const revGain = ctx.createGain(); revGain.gain.value = 0.85;
    conv.connect(revGain); revGain.connect(master);
    this.nodes.reverb = conv;
    const revSend = ctx.createGain(); revSend.gain.value = 0.16;
    revSend.connect(conv);
    this.nodes.revSend = revSend;

    this.buildEngine();
    this.buildTyres();
    this.buildAero();
    this.ready = true;
    this.setEngineType(this.engineType, 1);
  },

  /* ============================================================
     ENGINE
     ============================================================ */
  /* render one full 4-stroke cycle (720 deg = 2 revolutions) */
  renderCycle(baseRpm, load, fp, forced) {
    const ctx = this.ctx, sr = ctx.sampleRate;
    const cycleSec = 120 / baseRpm;
    const n = Math.max(64, Math.round(sr * cycleSec));
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);

    const cyl = fp.cyl;
    // higher reference rpm = shorter, sharper events
    const rpmK = Math.min(1, 2600 / baseRpm);
    const thumpF = fp.thump * (1 + (1 - rpmK) * 0.35);
    const resF = fp.res * (1 + (1 - rpmK) * 0.25);
    const crackAmt = fp.crack * lerp(0.85, 1.75, load);
    const tauThump = cycleSec * lerp(0.42, 0.26, load) / Math.max(1, cyl / 6);
    const tauRes = cycleSec * 0.30 / Math.max(1, cyl / 6);
    const tauCrack = 0.0011 + 0.0028 * (1 - load);

    const add = (idx, v) => { d[((idx % n) + n) % n] += v; };

    for (let k = 0; k < cyl; k++) {
      const off = (k / cyl) + (fp.jitter[k % fp.jitter.length] || 0);
      const start = Math.round(off * n);
      const phase = Math.random() * TAU;
      const gain = 1 + (Math.random() - 0.5) * 0.10 * (1 - load);   // cylinder-to-cylinder variance
      const len = Math.min(n, Math.round(sr * cycleSec * 0.95));
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const eT = Math.exp(-t / tauThump);
        const eR = Math.exp(-t / tauRes);
        const eC = Math.exp(-t / tauCrack);
        let v = 0;
        v += Math.sin(TAU * thumpF * t + phase) * eT * 1.00 * fp.body;
        v += Math.sin(TAU * thumpF * 2.02 * t + phase * 1.3) * eT * 0.42 * load;
        v += Math.sin(TAU * resF * t + phase * 0.7) * eR * 0.55;
        v += Math.sin(TAU * resF * 1.51 * t) * eR * 0.22 * load;
        v += (Math.random() * 2 - 1) * eC * crackAmt * 1.55;
        // hard edge on the exhaust pulse — this is most of the 'bite'
        v += Math.sin(TAU * resF * 3.1 * t) * Math.exp(-t / (tauCrack * 3.2)) * 0.34 * load;
        if (forced === 'turbo') v += (Math.random() * 2 - 1) * Math.exp(-t / 0.010) * 0.20 * load;
        add(start + i, v * gain);
      }
    }
    // one-pole smoothing to knock the hardest edges off
    let p = 0; const a = load > 0.5 ? 0.82 : 0.64;
    for (let i = 0; i < n; i++) { p = p + (d[i] - p) * a; d[i] = p; }
    // wrap the filter once more so the loop point is continuous
    for (let i = 0; i < 64; i++) { p = p + (d[i] - p) * a; d[i] = p; }
    // normalise
    let mx = 1e-6;
    for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(d[i]));
    const s = 0.92 / mx;
    for (let i = 0; i < n; i++) d[i] *= s;
    return buf;
  },

  buildEngine() {
    const ctx = this.ctx;
    const sum = ctx.createGain(); sum.gain.value = 1;

    // exhaust formants — three parallel peaks give the pipe its voice
    const mkPeak = (f, q, g) => {
      const b = ctx.createBiquadFilter(); b.type = 'peaking';
      b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b;
    };
    const p1 = mkPeak(140, 2.2, 7);
    const p2 = mkPeak(430, 1.6, 5);
    const p3 = mkPeak(1900, 1.5, 2);
    const p4 = mkPeak(3400, 1.2, 0);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 1.05;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 42;

    const shaper = ctx.createWaveShaper();
    const cv = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) { const x = i / 1023.5 - 1; cv[i] = Math.tanh(x * 2.1) * 0.85; }
    shaper.curve = cv; shaper.oversample = '2x';

    const out = ctx.createGain(); out.gain.value = 0.0;
    sum.connect(p1); p1.connect(p2); p2.connect(p3); p3.connect(p4); p4.connect(shaper);
    shaper.connect(lp); lp.connect(hp); hp.connect(out);
    out.connect(this.master); out.connect(this.nodes.revSend);

    this.nodes.eng = { sum, lp, hp, out, p1, p2, p3, p4, shaper };

    /* turbo */
    // the whine is the blade-pass tone plus a beating second impeller order
    const tOsc = ctx.createOscillator(); tOsc.type = 'sawtooth'; tOsc.frequency.value = 3600;
    const tOsc2 = ctx.createOscillator(); tOsc2.type = 'sine'; tOsc2.frequency.value = 5400;
    const tOsc3 = ctx.createOscillator(); tOsc3.type = 'sine'; tOsc3.frequency.value = 7800;
    const tG = ctx.createGain(); tG.gain.value = 0;
    const tBp = ctx.createBiquadFilter(); tBp.type = 'bandpass'; tBp.frequency.value = 4200; tBp.Q.value = 7.5;
    const tBp2 = ctx.createBiquadFilter(); tBp2.type = 'peaking'; tBp2.frequency.value = 6200;
    tBp2.Q.value = 6; tBp2.gain.value = 9;
    tOsc.connect(tBp); tOsc2.connect(tBp); tOsc3.connect(tBp);
    tBp.connect(tBp2); tBp2.connect(tG); tG.connect(this.master);
    tOsc.start(); tOsc2.start(); tOsc3.start();
    const tNoise = this._mkNoise();
    const tnF = ctx.createBiquadFilter(); tnF.type = 'bandpass'; tnF.frequency.value = 5200; tnF.Q.value = 1.6;
    const tnG = ctx.createGain(); tnG.gain.value = 0;
    tNoise.connect(tnF); tnF.connect(tnG); tnG.connect(this.master);
    this.nodes.turbo = { osc: tOsc, osc2: tOsc2, osc3: tOsc3, gain: tG, bp: tBp, bp2: tBp2, nG: tnG, nF: tnF };

    /* supercharger whine — strong odd harmonics from the rotor lobes */
    const scSum = ctx.createGain(); scSum.gain.value = 0;
    const scOscs = [];
    for (const h of [1, 2, 3, 4.5]) {
      const o = ctx.createOscillator(); o.type = h === 1 ? 'sawtooth' : 'sine';
      const g = ctx.createGain(); g.gain.value = 1 / (h * h);
      o.connect(g); g.connect(scSum); o.start();
      scOscs.push({ o, h });
    }
    const scBp = ctx.createBiquadFilter(); scBp.type = 'bandpass'; scBp.frequency.value = 2400; scBp.Q.value = 1.1;
    scSum.connect(scBp); scBp.connect(this.master);
    this.nodes.sc = { sum: scSum, oscs: scOscs, bp: scBp };

    /* straight-cut gearbox whine */
    const gwO = ctx.createOscillator(); gwO.type = 'sawtooth'; gwO.frequency.value = 400;
    const gwG = ctx.createGain(); gwG.gain.value = 0;
    const gwB = ctx.createBiquadFilter(); gwB.type = 'bandpass'; gwB.frequency.value = 1400; gwB.Q.value = 4;
    gwO.connect(gwB); gwB.connect(gwG); gwG.connect(this.master); gwO.start();
    this.nodes.gearWhine = { osc: gwO, gain: gwG };
  },

  setEngineType(type, force) {
    if (!this.ready) { this.engineType = type; return; }
    if (!force && type === this._builtType) return;
    this._builtType = type; this.engineType = type;
    const fp = FIRING[type] || FIRING.v8;
    const ctx = this.ctx;
    // tear down old zone sources
    for (const z of this.zones) { try { z.a.stop(); z.b.stop(); } catch (e) { } }
    this.zones = [];
    for (const rpm of ENGINE_ZONES) {
      const bufA = this.renderCycle(rpm, 0.12, fp, this._forced);
      const bufB = this.renderCycle(rpm, 1.0, fp, this._forced);
      const a = ctx.createBufferSource(); a.buffer = bufA; a.loop = true;
      const b = ctx.createBufferSource(); b.buffer = bufB; b.loop = true;
      const ga = ctx.createGain(); ga.gain.value = 0;
      const gb = ctx.createGain(); gb.gain.value = 0;
      a.connect(ga); b.connect(gb);
      ga.connect(this.nodes.eng.sum); gb.connect(this.nodes.eng.sum);
      a.start(); b.start();
      this.zones.push({ rpm, a, b, ga, gb });
    }
  },

  setForced(kind) { this._forced = kind; },

  /* ============================================================
     TYRES / ROAD
     ============================================================ */
  buildTyres() {
    const ctx = this.ctx;
    // rolling roar: looped noise whose playbackRate rises with speed
    const roll = this._mkNoise(1);
    const rollF = ctx.createBiquadFilter(); rollF.type = 'lowpass'; rollF.frequency.value = 400; rollF.Q.value = 1.1;
    const rollP = ctx.createBiquadFilter(); rollP.type = 'peaking'; rollP.frequency.value = 190; rollP.Q.value = 1.6; rollP.gain.value = 8;
    const rollG = ctx.createGain(); rollG.gain.value = 0;
    roll.connect(rollP); rollP.connect(rollF); rollF.connect(rollG); rollG.connect(this.master);

    // coarse texture layer
    const grit = this._mkNoise(1);
    const gritF = ctx.createBiquadFilter(); gritF.type = 'bandpass'; gritF.frequency.value = 1400; gritF.Q.value = 0.8;
    const gritG = ctx.createGain(); gritG.gain.value = 0;
    grit.connect(gritF); gritF.connect(gritG); gritG.connect(this.master);

    // squeal: two resonant peaks with an LFO wobble
    const sq = this._mkNoise();
    const sqA = ctx.createBiquadFilter(); sqA.type = 'bandpass'; sqA.frequency.value = 1180; sqA.Q.value = 13;
    const sqB = ctx.createBiquadFilter(); sqB.type = 'bandpass'; sqB.frequency.value = 2360; sqB.Q.value = 17;
    const sqMix = ctx.createGain(); sqMix.gain.value = 0;
    sq.connect(sqA); sq.connect(sqB); sqA.connect(sqMix); sqB.connect(sqMix);
    sqMix.connect(this.master); sqMix.connect(this.nodes.revSend);
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 7.2;
    const lfoG = ctx.createGain(); lfoG.gain.value = 90;
    lfo.connect(lfoG); lfoG.connect(sqA.frequency); lfo.start();

    this.nodes.tyre = { roll, rollF, rollG, grit, gritF, gritG, sqA, sqB, sqMix, lfo, lfoG };
  },

  buildAero() {
    const ctx = this.ctx;
    const w = this._mkNoise();
    const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 600; wf.Q.value = 0.5;
    const wg = ctx.createGain(); wg.gain.value = 0;
    w.connect(wf); wf.connect(wg); wg.connect(this.master);
    this.nodes.wind = { g: wg, f: wf };

    const r = this._mkNoise();
    const rf = ctx.createBiquadFilter(); rf.type = 'highpass'; rf.frequency.value = 2200;
    const rg = ctx.createGain(); rg.gain.value = 0;
    r.connect(rf); rf.connect(rg); rg.connect(this.master);
    this.nodes.rain = rg;
  },

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); },
  duck(v) { if (this.master) this.master.gain.setTargetAtTime(this.volume * v, this.ctx.currentTime, 0.08); },

  /* ============================================================
     PER-FRAME
     ============================================================ */
  updateEngine(car, dt, camDist, wet) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime, N = this.nodes;
    const tune = car.tune || {};
    const rpm = Math.max(car.rpm, 400);
    const redline = car.ph.redline;
    const load = clamp01(car.throttleSm !== undefined ? car.throttleSm : car.throttle);
    const rev = clamp01(rpm / redline);
    const prox = clamp01(1.5 - camDist / 24);

    /* --- zone crossfade --- */
    let zi = 0;
    while (zi < ENGINE_ZONES.length - 2 && rpm > ENGINE_ZONES[zi + 1]) zi++;
    const lo = ENGINE_ZONES[zi], hi = ENGINE_ZONES[zi + 1];
    const f = clamp01((rpm - lo) / Math.max(1, hi - lo));
    const wobble = 1 + (rpm < 1400 ? Math.sin(t * 11.3) * 0.010 * (1 - load) : 0);

    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      let w = 0;
      if (i === zi) w = 1 - f; else if (i === zi + 1) w = f;
      const rate = clamp(rpm / z.rpm, 0.25, 4) * wobble;
      if (w > 0.0005) {
        z.a.playbackRate.setTargetAtTime(rate, t, 0.012);
        z.b.playbackRate.setTargetAtTime(rate, t, 0.012);
      }
      // load crossfade: overrun buffer vs wide-open buffer
      z.ga.gain.setTargetAtTime(w * (1 - load) * 0.95, t, 0.035);
      z.gb.gain.setTargetAtTime(w * (0.16 + load * 0.94), t, 0.030);
    }

    /* --- tone shaping --- */
    let limiterCut = 1;
    if (rpm >= redline * 0.995 && load > 0.4) {
      limiterCut = (Math.sin(t * 78) > 0 ? 0.18 : 1);
      if (limiterCut < 0.5) this.misfire(0.8);
    }
    const exhaust = 1 + (tune.exhaust || 0) * 0.28;
    N.eng.lp.frequency.setTargetAtTime((1500 + 5200 * rev + 3400 * load) * exhaust, t, 0.035);
    N.eng.p1.gain.setTargetAtTime(6 + 5 * (1 - rev), t, 0.08);
    N.eng.p2.gain.setTargetAtTime(3 + 6 * load, t, 0.08);
    N.eng.p3.gain.setTargetAtTime(-1 + 8 * load + 3 * rev, t, 0.08);
    N.eng.p4.gain.setTargetAtTime(-3 + 7 * load * rev, t, 0.08);
    const vol = (0.22 + 0.52 * load + 0.38 * rev) * prox * limiterCut * (0.85 + 0.30 * (tune.exhaust || 0));
    N.eng.out.gain.setTargetAtTime(vol * 0.82, t, 0.030);

    /* --- forced induction --- */
    const boost = clamp01(car.boostPsi ? car.boostPsi / Math.max(1, car.maxBoostPsi || 12) : 0);
    if (car.forced === 'turbo') {
      // shaft speed tracks both boost and revs, so the whine climbs with the engine
      const shaft = clamp01(boost * 0.72 + rev * 0.38);
      const f0 = 1500 + 9500 * shaft;
      N.turbo.osc.frequency.setTargetAtTime(f0, t, 0.045);
      N.turbo.osc2.frequency.setTargetAtTime(f0 * 1.62, t, 0.045);
      N.turbo.osc3.frequency.setTargetAtTime(f0 * 2.41, t, 0.045);
      N.turbo.bp.frequency.setTargetAtTime(f0 * 1.05, t, 0.045);
      N.turbo.bp2.frequency.setTargetAtTime(f0 * 1.7, t, 0.05);
      N.turbo.gain.gain.setTargetAtTime(0.105 * (0.20 + 0.80 * boost) * shaft * prox, t, 0.06);
      N.turbo.nF.frequency.setTargetAtTime(3800 + 6000 * shaft, t, 0.06);
      N.turbo.nG.gain.setTargetAtTime(0.045 * boost * (0.3 + 0.7 * load) * prox, t, 0.07);
      N.sc.sum.gain.setTargetAtTime(0, t, 0.1);
      if (this._lastLoad > 0.45 && load < 0.16 && boost > 0.16) this.flutter(boost);
    } else if (car.forced === 'super') {
      const base = rpm / 60 * 3.2;
      for (const s of N.sc.oscs) s.o.frequency.setTargetAtTime(clamp(base * s.h * 2.6, 20, 12000), t, 0.03);
      N.sc.bp.frequency.setTargetAtTime(1400 + 3600 * rev, t, 0.05);
      N.sc.sum.gain.setTargetAtTime(0.115 * (0.25 + 0.75 * load) * (0.25 + 0.75 * rev) * prox, t, 0.05);
      N.turbo.gain.gain.setTargetAtTime(0, t, 0.1);
      N.turbo.nG.gain.setTargetAtTime(0, t, 0.1);
    } else {
      N.turbo.gain.gain.setTargetAtTime(0, t, 0.12);
      N.turbo.nG.gain.setTargetAtTime(0, t, 0.12);
      N.sc.sum.gain.setTargetAtTime(0, t, 0.12);
    }

    /* --- overrun pops --- */
    if (this._lastLoad > 0.45 && load < 0.14 && rev > 0.34 && t - this._popT > 0.22) {
      this._popT = t;
      const n = 3 + ((Math.random() * 5) | 0);
      const boostBias = 1 + (car.forced !== 'none' ? 0.6 : 0) + (tune.exhaust || 0) * 0.25;
      for (let i = 0; i < n; i++)
        setTimeout(() => this.pop((0.55 + Math.random() * 0.6 * rev) * boostBias),
          i * (32 + Math.random() * 60));
    }
    this._lastLoad = load; this._lastRpm = rpm;

    /* --- gearbox whine (race boxes only) --- */
    const gw = (tune.gearbox || 0) >= 3 ? 1 : 0;
    N.gearWhine.osc.frequency.setTargetAtTime(clamp(140 + Math.abs(car.fwdSpeed) * 26, 60, 3800), t, 0.05);
    N.gearWhine.gain.gain.setTargetAtTime(gw * 0.020 * clamp01(Math.abs(car.fwdSpeed) / 30) * prox, t, 0.08);

    /* --- tyres --- */
    let skid = 0, contact = 0;
    for (const w of car.wheels) { skid = Math.max(skid, w.skid); if (w.contact) contact++; }
    const spd = car.speed;
    const grounded = contact / 4;
    const rollRate = clamp(0.35 + spd / 42, 0.35, 3.6);
    N.tyre.roll.playbackRate.setTargetAtTime(rollRate, t, 0.10);
    N.tyre.grit.playbackRate.setTargetAtTime(rollRate * 1.4, t, 0.10);
    N.tyre.rollF.frequency.setTargetAtTime(180 + spd * 13, t, 0.08);
    N.tyre.rollG.gain.setTargetAtTime(clamp01(spd / 34) * 0.16 * grounded * (wet ? 1.35 : 1), t, 0.07);
    N.tyre.gritF.frequency.setTargetAtTime(900 + spd * 22, t, 0.08);
    N.tyre.gritG.gain.setTargetAtTime(clamp01((spd - 4) / 40) * 0.045 * grounded * (wet ? 1.9 : 1), t, 0.07);

    const squeal = clamp01((skid - 0.12) * 1.5) * clamp01(spd / 7) * (wet ? 0.7 : 1);
    N.tyre.sqMix.gain.setTargetAtTime(0.10 * squeal * prox, t, 0.05);
    N.tyre.sqA.frequency.setTargetAtTime(950 + 620 * skid + spd * 2.4, t, 0.07);
    N.tyre.sqB.frequency.setTargetAtTime(2050 + 900 * skid, t, 0.07);
    N.tyre.lfoG.gain.setTargetAtTime(60 + 140 * skid, t, 0.1);

    /* --- aero --- */
    N.wind.g.gain.setTargetAtTime(clamp01((spd - 8) / 78) * 0.10, t, 0.12);
    N.wind.f.frequency.setTargetAtTime(380 + spd * 22, t, 0.12);
  },

  setRain(v) { if (this.ready) this.nodes.rain.gain.setTargetAtTime(v * 0.055, this.ctx.currentTime, 0.6); },

  /* ---------------- one-shots ---------------- */
  _burst(cfg) {
    if (!this.ready) return;
    const ctx = this.ctx, t = cfg.when === undefined ? ctx.currentTime : Math.max(cfg.when, ctx.currentTime);
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
    s.playbackRate.value = cfg.rate || 1;
    const f = ctx.createBiquadFilter();
    f.type = cfg.type || 'bandpass';
    f.frequency.setValueAtTime(cfg.f0, t);
    if (cfg.f1) f.frequency.exponentialRampToValueAtTime(Math.max(30, cfg.f1), t + cfg.dur);
    f.Q.value = cfg.q === undefined ? 1.2 : cfg.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(cfg.vol, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + cfg.dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    if (cfg.rev) g.connect(this.nodes.revSend);
    s.start(t); s.stop(t + cfg.dur + 0.05);
  },
  _tone(freq, dur, vol, type, sweep, when) {
    if (!this.ready) return;
    const ctx = this.ctx, t = when === undefined ? ctx.currentTime : Math.max(when, ctx.currentTime);
    const o = ctx.createOscillator(); o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweep), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },

  pop(strength) {
    this._burst({ f0: 1100 + Math.random() * 2400, f1: 200, dur: 0.10, vol: 0.24 * strength, q: 0.9, rev: 1 });
    this._burst({ f0: 5200, dur: 0.022, vol: 0.13 * strength, q: 2.5 });
    this._tone(85 + Math.random() * 60, 0.10, 0.15 * strength, 'triangle', 42);
  },
  /* compressor surge — the stu-stu-stu when the throttle shuts on boost */
  flutter(boost) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (t - (this._flutT || 0) < 0.30) return;
    this._flutT = t;
    const n = 5 + ((Math.random() * 5) | 0);
    const gap = 0.030 + Math.random() * 0.014;
    for (let i = 0; i < n; i++) {
      const k = 1 - i / n;
      this._burst({
        f0: (2600 + Math.random() * 900) * (0.65 + 0.45 * k),
        dur: 0.030 + 0.012 * k, vol: (0.10 + 0.16 * boost) * (0.45 + 0.55 * k),
        q: 9, when: t + i * gap, rev: 1
      });
      this._tone(190 + 120 * k, 0.035, 0.05 * boost * k, 'square', 120, t + i * gap);
    }
    // the exhale at the end
    this._burst({ f0: 3600, f1: 1100, dur: 0.22, vol: 0.09 * boost, q: 1.5, when: t + n * gap, rev: 1 });
  },

  /* ignition cut: fuel keeps arriving and lights in the pipe */
  misfire(strength) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (t - (this._misT || 0) < 0.055) return;
    this._misT = t;
    this._burst({ f0: 1400 + Math.random() * 2200, f1: 260, dur: 0.075, vol: 0.16 * strength, q: 1.1, rev: 1 });
    this._tone(110 + Math.random() * 90, 0.06, 0.11 * strength, 'square', 55);
  },

  bov(boost, flutter) {
    if (flutter) {
      for (let i = 0; i < 7; i++)
        setTimeout(() => this._burst({ f0: 3200, dur: 0.035, vol: 0.055 * boost, q: 5 }), i * 34);
    } else {
      this._burst({ f0: 4200, f1: 1500, dur: 0.30, vol: 0.11 * boost, q: 1.4, rev: 1 });
    }
  },
  shift(up) {
    this._burst({ f0: up ? 2600 : 2100, f1: 700, dur: 0.055, vol: 0.075, q: 2.2 });
    this._tone(up ? 150 : 120, 0.07, 0.055, 'square', 70);
  },
  grind() { this._burst({ f0: 1800, dur: 0.22, vol: 0.10, q: 8, rate: 0.6 }); },
  impact(strength) {
    if (!this.ready) return;
    const s = clamp01(strength);
    this._burst({ f0: 1200 + 1800 * s, f1: 90, dur: 0.38, vol: 0.20 + 0.45 * s, q: 0.6, type: 'lowpass', rev: 1 });
    for (let i = 0; i < 3; i++)
      this._tone(120 + Math.random() * 320, 0.30 + Math.random() * 0.3, 0.05 + 0.07 * s, 'triangle', 60);
    this._burst({ f0: 3400, dur: 0.10, vol: 0.10 * s, q: 1.6 });
  },
  scrape(amount) {
    if (!this.ready) return;
    if (!this._scrapeT || this.ctx.currentTime - this._scrapeT > 0.09) {
      this._scrapeT = this.ctx.currentTime;
      this._burst({ f0: 2600 + Math.random() * 2500, dur: 0.10, vol: 0.05 * amount, q: 6 });
    }
  },
  starter() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (let i = 0; i < 9; i++) {
      const tt = t + i * 0.085;
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(46, tt); o.frequency.linearRampToValueAtTime(60, tt + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.10, tt); g.gain.exponentialRampToValueAtTime(0.001, tt + 0.075);
      o.connect(g); g.connect(this.master); o.start(tt); o.stop(tt + 0.09);
    }
    setTimeout(() => { this.pop(0.9); this._burst({ f0: 500, f1: 160, dur: 0.4, vol: 0.2, q: 0.7, rev: 1 }); }, 800);
  },
  blip(freq = 660, dur = 0.06, vol = 0.07, type = 'triangle') { this._tone(freq, dur, vol, type); },
  ui(kind) {
    if (kind === 'hover') this._tone(1180, 0.03, 0.022, 'sine');
    else if (kind === 'ok') { this._tone(880, 0.06, 0.05, 'triangle'); setTimeout(() => this._tone(1320, 0.09, 0.045, 'triangle'), 55); }
    else if (kind === 'buy') { this._tone(660, 0.07, 0.05, 'triangle'); setTimeout(() => this._tone(990, 0.08, 0.05, 'triangle'), 70); setTimeout(() => this._tone(1320, 0.14, 0.05, 'triangle'), 140); }
    else if (kind === 'deny') { this._tone(190, 0.16, 0.07, 'square', 120); }
    else this._tone(760, 0.05, 0.04, 'triangle');
  },
  chord(freqs, dur = 0.5, vol = 0.07) {
    freqs.forEach((f, i) => setTimeout(() => this._tone(f, dur, vol, 'triangle'), i * 60));
  },
  checkpoint() { this._tone(1480, 0.08, 0.06, 'triangle'); setTimeout(() => this._tone(2200, 0.10, 0.05, 'sine'), 60); },
};
