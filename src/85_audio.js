'use strict';
/* ============================================================
   Apex Drive — audio engine

   This is a physical model, not a synth patch. It is built the way
   an exhaust system actually makes noise, in two separate halves:

     SOURCE    Each cylinder's exhaust valve opening is rendered as a
               blowdown pulse — a near-instant pressure release with a
               sharp rise and an exponential decay, plus the turbulent
               hiss of gas tearing past the valve seat and the broad
               hump of the piston pushing the rest of the charge out.
               There is not a single sine wave in it. That pulse train
               is baked into a looping buffer and pitch-shifted with
               rpm, which is correct: the *firing rate* is the thing
               that changes with engine speed.

     RESONATOR The pulses then run through digital waveguides — delay
               lines with a lossy, phase-inverting reflection at the
               open end. That is literally what a pipe is. The comb of
               resonances it stands up IS the voice of the car, and
               because it lives in the graph rather than in the buffer
               it does NOT slide upward when the revs climb. Chasing
               that one property is the whole reason for the rewrite:
               a pitch-shifted buffer drags its own formants along
               with it, and real pipes never do that. That single
               wrongness is most of what "synthetic" sounds like.

   Each bank gets its own header and its own tailpipe, which matters
   more than it sounds like it should. A cross-plane V8 fires evenly
   at the crank but *unevenly per bank*, and the burble everyone knows
   is the two banks' lopsided patterns beating against each other down
   two separate pipes. Give the same engine a flat-plane crank and each
   bank becomes even, and it screams instead. Same model, one table
   entry different.

   The intake is modelled too — a Helmholtz plenum fed by induction
   pulses and airflow noise, panned away from the exhaust. Onboard,
   half of what you hear is intake, and leaving it out is a large part
   of why game engines sound like they are outside the car.
   ============================================================ */

/* reference speeds the buffers are rendered at; crossfading between
   two neighbours keeps the pitch-shift inside about ±35%, which is
   where the pulse shape still reads correctly */
const ENGINE_ZONES = [700, 1500, 2700, 4400, 6600, 9400];

/* four load layers. The bottom one is a genuinely different render —
   no combustion at all, just pumping — because overrun is not simply
   "the same sound, quieter", and treating it that way is the second
   most obvious tell after sliding formants. */
const LOAD_LAYERS = [0.0, 0.34, 0.68, 1.0];
const LOAD_GAIN = [0.30, 0.58, 0.85, 1.00];

/* Effective speed of sound in a hot exhaust stream. Ambient air is
   343 m/s; exhaust gas leaves the port near 800 C and travels far
   quicker, cooling as it goes. 480 is the useful average and it is
   what every pipe length quoted below is tuned against. */
const GAS_C = 480;

/* Firing patterns.
     seq   event position as a fraction of the 720-degree cycle
     bank  which pipe the event goes down (2 = shared manifold)
     sharp how fast the blowdown collapses; big-bore lazy engines low
     hiss  turbulence past the valve seat
     pump  how much of the stroke is piston-pushed rather than blown
     tick  valvetrain clatter (rotaries have ports, so none)
     size  charge volume, which stretches the whole event

   The two V8 entries are the interesting ones. Cross-plane order
   1-8-4-3-6-5-7-2 puts the left bank on beats 0, 3, 5, 6 — gaps of
   270-180-90-180 degrees — and that lopsidedness is the burble.
   Flat-plane simply alternates, so each bank is an even four, and
   that is the howl. Nothing else about the two engines differs. */
const FIRING = {
  i4: {
    seq: [0, .25, .5, .75], bank: [2, 2, 2, 2],
    sharp: 1.05, hiss: .58, pump: .55, tick: .55, size: .80
  },
  i6: {
    seq: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], bank: [2, 2, 2, 2, 2, 2],
    sharp: .95, hiss: .48, pump: .44, tick: .45, size: .88
  },
  v6: {
    seq: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], bank: [0, 1, 0, 1, 0, 1],
    sharp: .98, hiss: .52, pump: .48, tick: .48, size: .90
  },
  /* cross-plane V8 — uneven per bank, hence the burble */
  v8: {
    seq: [0, .125, .25, .375, .5, .625, .75, .875], bank: [0, 1, 1, 0, 1, 0, 0, 1],
    sharp: .88, hiss: .50, pump: .52, tick: .52, size: 1.00
  },
  /* flat-plane V8 — even per bank, hence the scream */
  v8f: {
    seq: [0, .125, .25, .375, .5, .625, .75, .875], bank: [0, 1, 0, 1, 0, 1, 0, 1],
    sharp: 1.22, hiss: .62, pump: .40, tick: .58, size: .86
  },
  v10: {
    seq: [0, .1, .2, .3, .4, .5, .6, .7, .8, .9], bank: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
    sharp: 1.30, hiss: .66, pump: .34, tick: .62, size: .78
  },
  v12: {
    seq: [0, 1 / 12, 2 / 12, 3 / 12, 4 / 12, 5 / 12, 6 / 12, 7 / 12, 8 / 12, 9 / 12, 10 / 12, 11 / 12],
    bank: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
    sharp: 1.34, hiss: .60, pump: .28, tick: .58, size: .70
  },
  /* three cylinders per bank, 120 apart, and the two banks offset — a
     flat six is really two triples arguing politely */
  flat6: {
    seq: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], bank: [0, 1, 0, 1, 0, 1],
    sharp: 1.14, hiss: .70, pump: .42, tick: .50, size: .84
  },
  /* ports, not valves: no clatter, and the port uncovers gradually so
     the pulse is fat and never really stops. Buzzsaw. */
  rotary: {
    seq: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], bank: [0, 1, 0, 1, 0, 1],
    sharp: .62, hiss: .92, pump: .24, tick: 0, size: .62
  },
  ev: {
    seq: [0, .5], bank: [2, 2],
    sharp: 2.4, hiss: .10, pump: .05, tick: .05, size: .35
  },
};

/* fallback if a car somehow has no voice of its own */
const DEFAULT_VOICE = {
  pipe: 2.40, pipe2: 2.52, head: 0.88, refl: .68, damp: 3200,
  plenum: 230, plenumQ: 3.0, intake: 1.0, drive: 2.1, rasp: .50,
  lope: .08, idle: 850
};

const Audio2 = {
  ctx: null, ready: false, master: null, volume: 0.75,
  engineType: 'v8', zones: [], nodes: {}, _lastLoad: 0, _lastRpm: 900,
  _popT: 0, _muted: false, _acKey: '', _lastDist: 0,

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
    comp.threshold.value = -13; comp.knee.value = 26; comp.ratio.value = 5.5;
    comp.attack.value = 0.004; comp.release.value = 0.16;
    /* a soft ceiling after the compressor: a resonant pipe plus a pop plus
       an impact can still sum past full scale, and a hard clip there is an
       ugly crunch rather than the loud noise it is supposed to be */
    const ceil = ctx.createWaveShaper(); ceil.oversample = '2x';
    const cc = new Float32Array(4096);
    // 2x oversampling rings past the curve's own maximum on a hard edge,
    // so the curve tops out below the ceiling it is there to enforce
    for (let i = 0; i < 4096; i++) { const x = (i / 2047.5 - 1) * 2; cc[i] = Math.tanh(x * 1.05) * 0.82; }
    ceil.curve = cc;
    master.connect(comp); comp.connect(ceil); ceil.connect(ctx.destination);
    this.nodes.ceiling = ceil;

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
     SOURCE — one 720-degree cycle of exhaust-port events
     ============================================================ */
  renderCycle(baseRpm, load, fp) {
    const ctx = this.ctx, sr = ctx.sampleRate;
    const cycleSec = 120 / baseRpm;                 // 720 crank degrees
    const n = Math.max(96, Math.round(sr * cycleSec));
    const buf = ctx.createBuffer(2, n, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const nc = fp.seq.length;
    const evSec = cycleSec / nc;                    // average gap between events

    /* Blowdown timing is set by gas dynamics and valve lift, not by
       engine speed, so it is clamped at both ends. That one fact is
       why an engine reads as separate thumps at idle and as a single
       continuous howl at 9000 — up there the pulses simply overlap. */
    const rise = clamp(evSec * 0.030, 0.00007, 0.00055);
    const decay = clamp(evSec * 0.20 / fp.sharp, 0.00085, 0.0075) * fp.size;
    const pumpLen = evSec * 0.92;

    const add = (ch, idx, v) => { const i = ((idx % n) + n) % n; ch[i] += v; };

    for (let k = 0; k < nc; k++) {
      const s0 = Math.round(fp.seq[k] * n);
      const b = fp.bank[k];
      // the banks are not acoustically isolated, so each leaks into the other
      const gL = b === 1 ? 0.16 : (b === 2 ? 0.74 : 1.0);
      const gR = b === 0 ? 0.16 : (b === 2 ? 0.74 : 1.0);
      // no two cylinders ever make exactly the same pressure
      const varn = 1 + (Math.random() - 0.5) * 0.15 * (1 - load * 0.55);
      const amp = varn * (0.10 + 1.00 * load);
      const hiss = fp.hiss * (0.75 + 0.45 * load);

      const len = Math.min(n, Math.ceil(sr * decay * 8));
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = (1 - Math.exp(-t / rise)) * Math.exp(-t / decay);
        let v = env * amp;
        // gas tearing past the valve seat — broadband, rides the envelope
        v += (Math.random() * 2 - 1) * env * hiss * amp * 1.20;
        // the slower expansion as the header swallows the slug
        v += (1 - Math.exp(-t / (rise * 9))) * Math.exp(-t / (decay * 3.6)) * amp * 0.32;
        add(L, s0 + i, v * gL); add(R, s0 + i, v * gR);
      }

      /* The piston pushing the rest of the charge out. On a closed
         throttle this is nearly all that is left, which is exactly why
         overrun does not sound like full load turned down. */
      const pk = fp.pump * (0.50 + 0.85 * (1 - load)) * 0.40;
      const pl = Math.min(n - 1, Math.max(8, Math.round(sr * pumpLen)));
      const pOff = Math.round(sr * decay * 1.4);
      for (let i = 0; i < pl; i++) {
        const w = Math.sin(Math.PI * (i / pl));
        const v = w * w * pk * (1 + (Math.random() - 0.5) * 0.25 * fp.hiss);
        add(L, s0 + pOff + i, v * gL); add(R, s0 + pOff + i, v * gR);
      }

      /* Valve close. Mechanical, radiating from the block rather than
         out of a pipe, so it sits centred instead of panned to a bank. */
      if (fp.tick > 0) {
        const tOff = Math.round(sr * pumpLen * 0.95);
        const tl = Math.max(4, Math.round(sr * 0.00075));
        for (let i = 0; i < tl; i++) {
          const v = (Math.random() * 2 - 1) * Math.exp(-i / (tl * 0.34)) * fp.tick * 0.085
            * (0.7 + 0.5 * load);
          add(L, s0 + tOff + i, v); add(R, s0 + tOff + i, v);
        }
      }
    }

    /* the pumping hump is unipolar, so strip the DC it leaves behind */
    let mL = 0, mR = 0;
    for (let i = 0; i < n; i++) { mL += L[i]; mR += R[i]; }
    mL /= n; mR /= n;
    for (let i = 0; i < n; i++) { L[i] -= mL; R[i] -= mR; }

    /* Band-limit before the buffer ever gets pitched up, or the
       blowdown edge folds back as aliasing. One settling pass first,
       so the filter state at index 0 is already what it would be after
       wrapping and the loop joint stays inaudible. */
    const a = 1 - Math.exp(-TAU * 0.30);
    let p = 0, q = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        p += (L[i] - p) * a; q += (R[i] - q) * a;
        if (pass) { L[i] = p; R[i] = q; }
      }
    }

    let mx = 1e-6;
    for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i]));
    const s = 0.90 / mx;
    for (let i = 0; i < n; i++) { L[i] *= s; R[i] *= s; }
    return buf;
  },

  /* ============================================================
     RESONATOR — a real pipe, built out of a delay line
     ============================================================ */
  /* Signal enters, runs to the open end, and comes back inverted, a
     little quieter and short of its top end. Sustained that way it
     stands up a comb of resonances at odd multiples of c/4L, which is
     precisely what a tube closed at the engine and open at the tail
     does in metal. The inversion is also free DC rejection. */
  /* A loop that reflects R of what it is given resonates about 1/(1-R)
     times louder at its peaks, so a race system would come out seven
     times the level of a muffled one purely as an artefact. Back most
     of that out: the free-flowing pipe still ends up louder, which is
     true, but by a believable margin rather than an arithmetic one. */
  _pipeMakeup(refl) { return 1.45 * Math.pow(1 - clamp(refl, 0, 0.86), 0.45); },

  _mkPipe(len, refl, damp) {
    const ctx = this.ctx;
    const inG = ctx.createGain();
    const dl = ctx.createDelay(0.25);
    // one render quantum is the shortest delay a feedback loop can hold,
    // so clamp above it rather than let the graph silently retune the pipe
    dl.delayTime.value = clamp(2 * len / GAS_C, 0.0042, 0.20);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = damp; lp.Q.value = 0.4;
    const fb = ctx.createGain(); fb.gain.value = -clamp(refl, 0, 0.86);
    const wet = ctx.createGain(); wet.gain.value = this._pipeMakeup(refl);
    const dry = ctx.createGain(); dry.gain.value = 0.42;
    const out = ctx.createGain();
    inG.connect(dl);
    dl.connect(lp); lp.connect(fb); fb.connect(dl);   // the reflection
    dl.connect(wet); wet.connect(out);
    inG.connect(dry); dry.connect(out);               // the pulse you hear first
    return { inG, dl, lp, fb, wet, dry, out, len };
  },

  buildEngine() {
    const ctx = this.ctx;
    const sum = ctx.createGain(); sum.gain.value = 1;
    this.nodes.engSum = sum;

    /* one bank per channel, one pipe per bank */
    const split = ctx.createChannelSplitter(2);
    sum.connect(split);

    const exh = ctx.createGain(); exh.gain.value = 1;
    const pipes = [];
    for (let s = 0; s < 2; s++) {
      const head = this._mkPipe(0.88, 0.55, 4200);      // primaries into the collector
      const main = this._mkPipe(2.40, 0.68, 3200);      // the tailpipe run
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) pan.pan.value = s ? 0.34 : -0.34;
      const bank = ctx.createGain();
      split.connect(bank, s);
      bank.connect(head.inG);
      head.out.connect(main.inG);
      if (pan) { main.out.connect(pan); pan.connect(exh); } else main.out.connect(exh);
      pipes.push({ head, main, pan, bank });
    }
    this.nodes.pipes = pipes;

    /* One-shots that physically happen inside the exhaust — pops,
       misfires — enter here, so they come out with the pipe's own
       colour instead of being pasted over the top of it. */
    const pipeIn = ctx.createGain(); pipeIn.gain.value = 1;
    for (const p of pipes) pipeIn.connect(p.head.inG);
    this.nodes.pipeIn = pipeIn;

    /* the metal saturating, then radiation loss off the tail */
    const shaper = ctx.createWaveShaper();
    shaper.oversample = '2x';
    this._setDrive(shaper, 2.1);
    const rasp = ctx.createBiquadFilter();
    rasp.type = 'peaking'; rasp.frequency.value = 2600; rasp.Q.value = 1.3; rasp.gain.value = 0;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = 3400; tone.Q.value = 0.9;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 34;
    const out = ctx.createGain(); out.gain.value = 0;
    exh.connect(shaper); shaper.connect(rasp); rasp.connect(tone); tone.connect(hp); hp.connect(out);
    out.connect(this.master); out.connect(this.nodes.revSend);
    this.nodes.eng = { sum, exh, shaper, tone, hp, rasp, out };

    /* ---- intake tract ----
       A Helmholtz plenum: airbox volume working against the inertia of
       the air standing in the runners. Fed by airflow noise and by
       induction pulses at the firing rate, panned away from the
       exhaust because that is where it sits relative to your ears. */
    const helm = ctx.createBiquadFilter();
    helm.type = 'peaking'; helm.frequency.value = 230; helm.Q.value = 3.0; helm.gain.value = 14;
    const helm2 = ctx.createBiquadFilter();
    helm2.type = 'bandpass'; helm2.frequency.value = 620; helm2.Q.value = 0.7;
    const intG = ctx.createGain(); intG.gain.value = 0;
    const intAir = this._mkNoise(1);
    const airG = ctx.createGain(); airG.gain.value = 0;
    intAir.connect(airG); airG.connect(helm);
    // induction pulses: same firing rate as the exhaust, heavily rounded
    const pulseLP = ctx.createBiquadFilter();
    pulseLP.type = 'lowpass'; pulseLP.frequency.value = 900; pulseLP.Q.value = 0.7;
    const pulseG = ctx.createGain(); pulseG.gain.value = 0;
    sum.connect(pulseLP); pulseLP.connect(pulseG); pulseG.connect(helm);
    helm.connect(helm2); helm2.connect(intG);
    const intPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (intPan) { intPan.pan.value = -0.18; intG.connect(intPan); intPan.connect(this.master); }
    else intG.connect(this.master);
    this.nodes.intake = { helm, helm2, g: intG, air: airG, pulse: pulseG, pan: intPan };

    /* Turbo — blade-pass tone plus a beating second impeller order.
       Routed through the plenum, because the compressor sits upstream
       of the airbox and that is the path the whine actually takes to
       your ears. Hanging it straight on the master is why bolt-on
       turbo sounds always feel bolted on. */
    const tOsc = ctx.createOscillator(); tOsc.type = 'sawtooth'; tOsc.frequency.value = 3600;
    const tOsc2 = ctx.createOscillator(); tOsc2.type = 'sine'; tOsc2.frequency.value = 5400;
    const tOsc3 = ctx.createOscillator(); tOsc3.type = 'sine'; tOsc3.frequency.value = 7800;
    const tG = ctx.createGain(); tG.gain.value = 0;
    const tBp = ctx.createBiquadFilter(); tBp.type = 'bandpass'; tBp.frequency.value = 4200; tBp.Q.value = 7.5;
    const tBp2 = ctx.createBiquadFilter(); tBp2.type = 'peaking'; tBp2.frequency.value = 6200;
    tBp2.Q.value = 6; tBp2.gain.value = 9;
    tOsc.connect(tBp); tOsc2.connect(tBp); tOsc3.connect(tBp);
    tBp.connect(tBp2); tBp2.connect(tG); tG.connect(helm);
    tOsc.start(); tOsc2.start(); tOsc3.start();
    const tNoise = this._mkNoise();
    const tnF = ctx.createBiquadFilter(); tnF.type = 'bandpass'; tnF.frequency.value = 5200; tnF.Q.value = 1.6;
    const tnG = ctx.createGain(); tnG.gain.value = 0;
    tNoise.connect(tnF); tnF.connect(tnG); tnG.connect(helm);
    this.nodes.turbo = { osc: tOsc, osc2: tOsc2, osc3: tOsc3, gain: tG, bp: tBp, bp2: tBp2, nG: tnG, nF: tnF };

    /* supercharger — rotor lobes, strong odd harmonics, also upstream */
    const scSum = ctx.createGain(); scSum.gain.value = 0;
    const scOscs = [];
    for (const h of [1, 2, 3, 4.5]) {
      const o = ctx.createOscillator(); o.type = h === 1 ? 'sawtooth' : 'sine';
      const g = ctx.createGain(); g.gain.value = 1 / (h * h);
      o.connect(g); g.connect(scSum); o.start();
      scOscs.push({ o, h });
    }
    const scBp = ctx.createBiquadFilter(); scBp.type = 'bandpass'; scBp.frequency.value = 2400; scBp.Q.value = 1.1;
    scSum.connect(scBp); scBp.connect(helm);
    this.nodes.sc = { sum: scSum, oscs: scOscs, bp: scBp };

    /* straight-cut gearbox whine */
    const gwO = ctx.createOscillator(); gwO.type = 'sawtooth'; gwO.frequency.value = 400;
    const gwG = ctx.createGain(); gwG.gain.value = 0;
    const gwB = ctx.createBiquadFilter(); gwB.type = 'bandpass'; gwB.frequency.value = 1400; gwB.Q.value = 4;
    gwO.connect(gwB); gwB.connect(gwG); gwG.connect(this.master); gwO.start();
    this.nodes.gearWhine = { osc: gwO, gain: gwG };
  },

  _setDrive(shaper, d) {
    const cv = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) {
      const x = i / 1023.5 - 1;
      // asymmetric: the pressure side clips before the vacuum side, and
      // that asymmetry is where the even-harmonic warmth of real metal lives
      cv[i] = Math.tanh(x * d * (x > 0 ? 1.18 : 0.86)) * 0.86;
    }
    shaper.curve = cv;
  },

  setEngineType(type, force) {
    if (!this.ready) { this.engineType = type; return; }
    if (!force && type === this._builtType) return;
    this._builtType = type; this.engineType = type;
    const fp = FIRING[type] || FIRING.v8;
    const ctx = this.ctx;
    for (const z of this.zones) { for (const s of z.src) { try { s.stop(); } catch (e) { } } }
    this.zones = [];
    for (const rpm of ENGINE_ZONES) {
      const src = [], g = [];
      for (let l = 0; l < LOAD_LAYERS.length; l++) {
        const s = ctx.createBufferSource();
        s.buffer = this.renderCycle(rpm, LOAD_LAYERS[l], fp);
        s.loop = true;
        const gn = ctx.createGain(); gn.gain.value = 0;
        s.connect(gn); gn.connect(this.nodes.engSum);
        s.start();
        src.push(s); g.push(gn);
      }
      this.zones.push({ rpm, src, g });
    }
  },

  setForced(kind) { this._forced = kind; },

  /* ============================================================
     VOICE — pipe geometry from the car and the parts bolted to it
     ============================================================ */
  applyVoice(ph, force) {
    if (!this.ready || !this.nodes.pipes) return;
    const A = ph.acoustics || DEFAULT_VOICE;
    const key = (ph.engineId || '') + '|' + A.pipe.toFixed(3) + '|' + A.refl.toFixed(3) +
      '|' + A.damp.toFixed(0) + '|' + A.plenum.toFixed(0) + '|' + (A.absorb || 1).toFixed(2);
    if (!force && key === this._acKey) { this._ac = A; return; }
    this._acKey = key;
    const t = this.ctx.currentTime, N = this.nodes;
    const lens = [A.pipe, A.pipe2];
    for (let s = 0; s < 2; s++) {
      const p = N.pipes[s];
      p.main.dl.delayTime.setTargetAtTime(clamp(2 * lens[s] / GAS_C, 0.0042, 0.20), t, 0.08);
      p.head.dl.delayTime.setTargetAtTime(clamp(2 * A.head * (s ? 1.045 : 1) / GAS_C, 0.0042, 0.20), t, 0.08);
      p.main.fb.gain.setTargetAtTime(-clamp(A.refl, 0, 0.86), t, 0.10);
      p.head.fb.gain.setTargetAtTime(-clamp(A.refl * 0.80, 0, 0.84), t, 0.10);
      p.main.wet.gain.setTargetAtTime(this._pipeMakeup(A.refl), t, 0.10);
      p.head.wet.gain.setTargetAtTime(this._pipeMakeup(A.refl * 0.80), t, 0.10);
      p.main.lp.frequency.setTargetAtTime(clamp(A.damp, 300, 16000), t, 0.10);
      p.head.lp.frequency.setTargetAtTime(clamp(A.damp * 1.35, 300, 18000), t, 0.10);
      p.bank.gain.setTargetAtTime(A.absorb === undefined ? 1 : A.absorb, t, 0.10);
    }
    N.intake.helm.frequency.setTargetAtTime(clamp(A.plenum, 60, 2000), t, 0.08);
    N.intake.helm.Q.setTargetAtTime(clamp(A.plenumQ, 0.4, 12), t, 0.08);
    this._setDrive(N.eng.shaper, clamp(A.drive, 0.6, 5));
    this._ac = A;
  },

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

    this.applyVoice(car.ph);
    const A = this._ac || DEFAULT_VOICE;

    /* Doppler. A rigid chase camera sees almost none of this, but a
       fixed camera watching a car go past sees all of it, and it is
       the cheapest cue there is that the thing is actually moving. */
    let dop = 1;
    if (dt > 0 && this._lastDist) {
      const closing = (this._lastDist - camDist) / dt;
      const raw = clamp(1 + closing / 343, 0.86, 1.16);
      this._dop = this._dop === undefined ? raw : lerp(this._dop, raw, 0.25);
      dop = this._dop;
    }
    this._lastDist = camDist;

    /* --- zone / load crossfade --- */
    let zi = 0;
    while (zi < ENGINE_ZONES.length - 2 && rpm > ENGINE_ZONES[zi + 1]) zi++;
    const lo = ENGINE_ZONES[zi], hi = ENGINE_ZONES[zi + 1];
    const zf = clamp01((rpm - lo) / Math.max(1, hi - lo));

    /* Idle lope: an aggressive cam does not fill every cylinder
       equally, so the crank speed itself wanders at low rpm. */
    const lope = A.lope === undefined ? 0.08 : A.lope;
    const wob = rpm < 1900
      ? 1 + (Math.sin(t * 8.7) * 0.55 + Math.sin(t * 5.1 + 1.3) * 0.30 + Math.sin(t * 13.7) * 0.15)
      * lope * 0.11 * (1 - load)
      : 1;

    // which two load layers straddle the current throttle
    let li = 0;
    while (li < LOAD_LAYERS.length - 2 && load > LOAD_LAYERS[li + 1]) li++;
    const lf = clamp01((load - LOAD_LAYERS[li]) / Math.max(0.001, LOAD_LAYERS[li + 1] - LOAD_LAYERS[li]));

    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      let zw = 0;
      if (i === zi) zw = 1 - zf; else if (i === zi + 1) zw = zf;
      if (zw > 0.0004) {
        const rate = clamp(rpm / z.rpm, 0.2, 5) * wob * dop;
        for (const s of z.src) s.playbackRate.setTargetAtTime(rate, t, 0.010);
      }
      for (let l = 0; l < z.g.length; l++) {
        let lw = 0;
        if (l === li) lw = 1 - lf; else if (l === li + 1) lw = lf;
        z.g[l].gain.setTargetAtTime(zw * lw * LOAD_GAIN[l], t, 0.028);
      }
    }

    /* --- the pipe, live ---
       Hot gas travels faster, so the resonances climb a little under
       load and the top end survives the trip better. The pipe is not
       changing length; the gas inside it is changing speed. */
    const heat = clamp01(load * 0.7 + rev * 0.5);
    const lens = [A.pipe, A.pipe2];
    for (let s = 0; s < 2; s++) {
      const p = N.pipes[s];
      p.main.dl.delayTime.setTargetAtTime(
        clamp(2 * lens[s] / (GAS_C * (1 + 0.085 * heat)), 0.0042, 0.20), t, 0.18);
      p.main.lp.frequency.setTargetAtTime(clamp(A.damp * (1 + 0.60 * heat), 300, 16000), t, 0.09);
      p.head.lp.frequency.setTargetAtTime(clamp(A.damp * 1.35 * (1 + 0.75 * heat), 300, 18000), t, 0.09);
    }

    /* --- limiter / tone / level --- */
    let limiterCut = 1;
    if (rpm >= redline * 0.995 && load > 0.4) {
      limiterCut = (Math.sin(t * 78) > 0 ? 0.20 : 1);
      if (limiterCut < 0.5) this.misfire(0.85);
    }
    const rasp = A.rasp === undefined ? 0.5 : A.rasp;
    N.eng.tone.frequency.setTargetAtTime(
      clamp((1900 + 6200 * rev + 3200 * load) * (A.bright || 1), 400, 17000), t, 0.035);
    N.eng.rasp.frequency.setTargetAtTime(1700 + 2600 * rev, t, 0.07);
    N.eng.rasp.gain.setTargetAtTime(rasp * (2 + 8 * rev * (0.35 + 0.65 * load)), t, 0.07);
    // the pipe itself already gets louder with a freer system, so this
    // only adds the small part that is radiation off a bigger tailpipe
    const vol = (0.20 + 0.50 * load + 0.42 * rev) * prox * limiterCut
      * (0.88 + 0.09 * (tune.exhaust || 0));
    N.eng.out.gain.setTargetAtTime(vol * 0.72, t, 0.028);

    /* --- intake ---
       Mass flow, near enough: throttle opening times engine speed.
       This is why an intake goes quiet the instant you lift, even
       though the engine is still spinning just as hard. */
    const flow = clamp01(load * (0.30 + 0.70 * rev));
    const iv = A.intake || 1;
    N.intake.air.gain.setTargetAtTime(flow * 0.30 * iv, t, 0.05);
    N.intake.pulse.gain.setTargetAtTime((0.10 + 0.42 * flow) * iv * 0.55, t, 0.05);
    N.intake.helm2.frequency.setTargetAtTime(clamp(A.plenum * (1.6 + 1.8 * rev), 120, 6000), t, 0.06);
    N.intake.g.gain.setTargetAtTime((0.16 + 0.62 * flow) * prox * iv * 0.42, t, 0.05);

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
      N.turbo.gain.gain.setTargetAtTime(0.115 * (0.20 + 0.80 * boost) * shaft * prox, t, 0.06);
      N.turbo.nF.frequency.setTargetAtTime(3800 + 6000 * shaft, t, 0.06);
      N.turbo.nG.gain.setTargetAtTime(0.050 * boost * (0.3 + 0.7 * load) * prox, t, 0.07);
      N.sc.sum.gain.setTargetAtTime(0, t, 0.1);
      if (this._lastLoad > 0.45 && load < 0.16 && boost > 0.16) this.flutter(boost);
    } else if (car.forced === 'super') {
      const base = rpm / 60 * 3.2;
      for (const s of N.sc.oscs) s.o.frequency.setTargetAtTime(clamp(base * s.h * 2.6, 20, 12000), t, 0.03);
      N.sc.bp.frequency.setTargetAtTime(1400 + 3600 * rev, t, 0.05);
      N.sc.sum.gain.setTargetAtTime(0.125 * (0.25 + 0.75 * load) * (0.25 + 0.75 * rev) * prox, t, 0.05);
      N.turbo.gain.gain.setTargetAtTime(0, t, 0.1);
      N.turbo.nG.gain.setTargetAtTime(0, t, 0.1);
    } else {
      N.turbo.gain.gain.setTargetAtTime(0, t, 0.12);
      N.turbo.nG.gain.setTargetAtTime(0, t, 0.12);
      N.sc.sum.gain.setTargetAtTime(0, t, 0.12);
    }

    /* --- overrun: fuel keeps arriving and lights in a hot pipe.
       A harder-reflecting system cracks louder, which is exactly the
       reason people fit one. --- */
    if (this._lastLoad > 0.45 && load < 0.14 && rev > 0.32 && t - this._popT > 0.20) {
      this._popT = t;
      const n = 3 + ((Math.random() * 5) | 0);
      const bias = (1 + (car.forced !== 'none' ? 0.55 : 0) + (tune.exhaust || 0) * 0.30)
        * (0.6 + 0.6 * (A.refl || 0.68) / 0.68);
      for (let i = 0; i < n; i++)
        setTimeout(() => this.pop((0.55 + Math.random() * 0.6 * rev) * bias),
          i * (30 + Math.random() * 62));
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
    s.connect(f); f.connect(g);
    // anything that physically happens inside the exhaust goes down the
    // pipe, so it arrives wearing the pipe's resonances
    g.connect(cfg.pipe && this.nodes.pipeIn ? this.nodes.pipeIn : this.master);
    if (cfg.rev) g.connect(this.nodes.revSend);
    s.start(t); s.stop(t + cfg.dur + 0.05);
  },
  _tone(freq, dur, vol, type, sweep, when, pipe) {
    if (!this.ready) return;
    const ctx = this.ctx, t = when === undefined ? ctx.currentTime : Math.max(when, ctx.currentTime);
    const o = ctx.createOscillator(); o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweep), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    o.connect(g); g.connect(pipe && this.nodes.pipeIn ? this.nodes.pipeIn : this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },

  /* Unburnt fuel lighting off in the pipe. It detonates partway down,
     so the pipe rings behind it — the ring is the crack, not the bang. */
  pop(strength) {
    this._burst({ f0: 1100 + Math.random() * 2400, f1: 200, dur: 0.10, vol: 0.30 * strength, q: 0.9, pipe: 1, rev: 1 });
    this._burst({ f0: 5200, dur: 0.022, vol: 0.11 * strength, q: 2.5, pipe: 1 });
    this._tone(85 + Math.random() * 60, 0.10, 0.13 * strength, 'triangle', 42, undefined, 1);
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
    this._burst({ f0: 1400 + Math.random() * 2200, f1: 260, dur: 0.075, vol: 0.19 * strength, q: 1.1, pipe: 1, rev: 1 });
    this._tone(110 + Math.random() * 90, 0.06, 0.10 * strength, 'square', 55, undefined, 1);
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
  skill(intensity) {
    if (!this.ready) return;
    const base = 880 + intensity * 520;
    this._tone(base, 0.07, 0.045 + intensity * 0.02, 'triangle');
    setTimeout(() => this._tone(base * 1.5, 0.09, 0.04 + intensity * 0.02, 'triangle'), 55);
  },

  checkpoint() { this._tone(1480, 0.08, 0.06, 'triangle'); setTimeout(() => this._tone(2200, 0.10, 0.05, 'sine'), 60); },
};
