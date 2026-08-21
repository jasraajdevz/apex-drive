'use strict';
/* ============================================================
   Apex Drive — game
   ============================================================ */

window.addEventListener('error', e => showErr(e.message + '\n' + (e.error && e.error.stack || '')));
window.addEventListener('unhandledrejection', e => showErr('promise: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
function showErr(m) {
  const el = $('err'); if (!el) return;
  el.style.display = 'block';
  el.textContent += m + '\n\n';
  console.error(m);
}

/* ---------------- input ---------------- */
const Input = {
  keys: Object.create(null),
  steer: 0, throttle: 0, brake: 0, hand: 0, boost: 0, clutch: 0,
  pad: null, padIdx: -1,
  init() {
    addEventListener('keydown', e => {
      if (e.repeat) return;
      this.keys[e.code] = 1;
      Game.onKey(e.code, e);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', e => { this.keys[e.code] = 0; });
    addEventListener('blur', () => { this.keys = Object.create(null); });
    addEventListener('gamepadconnected', e => { this.padIdx = e.gamepad.index; });
  },
  poll(dt, steerRate) {
    const k = this.keys;
    const SR = steerRate || 1;
    let sx = 0, th = 0, br = 0, hb = 0, bo = 0;

    /* ---- keyboard ---- */
    if (k.KeyA || k.ArrowLeft) sx -= 1;
    if (k.KeyD || k.ArrowRight) sx += 1;
    if (k.KeyW || k.ArrowUp) th = 1;
    if (k.KeyS || k.ArrowDown) br = 1;
    if (k.Space) hb = 1;
    if (k.ShiftLeft) bo = 1;
    this.clutch = damp(this.clutch, k.KeyX ? 1 : 0, 22, dt);

    /* ---- touch ---- */
    let analog = false;
    if (Controls.device === 'touch') {
      const t = Controls.state;
      if (Controls.scheme === 0) { sx += t.steer; }
      else { sx = t.steer; analog = Math.abs(t.steer) > 0.001 || Controls.scheme !== 0; }
      if (t.gas) th = 1;
      if (t.brake) br = 1;
      if (t.hand) hb = 1;
      if (t.nos) bo = 1;
    }

    /* ---- gamepad ---- */
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > 0.12) { sx = ax; analog = true; }
      const rt = p.buttons[7] ? p.buttons[7].value : 0;
      const lt = p.buttons[6] ? p.buttons[6].value : 0;
      if (rt > 0.03) { th = rt; analog = true; }
      if (lt > 0.03) { br = lt; analog = true; }
      if (p.buttons[0] && p.buttons[0].pressed) hb = 1;
      if (p.buttons[1] && p.buttons[1].pressed) bo = 1;
      const rb = p.buttons[5] && p.buttons[5].pressed;
      const lb = p.buttons[4] && p.buttons[4].pressed;
      if (rb && !this._rb) Game.padShift(1);
      if (lb && !this._lb) Game.padShift(-1);
      this._rb = rb; this._lb = lb;
      const yb = p.buttons[3] && p.buttons[3].pressed;
      if (yb && !this._yb) Game.onKey('KeyC');
      this._yb = yb;
      const st = p.buttons[9] && p.buttons[9].pressed;
      if (st && !this._st) Game.setPaused(!Game.paused);
      this._st = st;
      break;
    }

    sx = clamp(sx, -1, 1);
    if (Controls.autoGas && Controls.device === 'touch' && Game.state === 'play' && !br) th = 1;

    this.steer = analog ? sx : damp(this.steer, sx, (sx === 0 ? 11 : 7.4) * SR, dt);
    if (!analog && Math.abs(sx) < .01 && Math.abs(this.steer) < .02) this.steer = 0;
    this.throttle = analog ? th : damp(this.throttle, th, 13, dt);
    this.brake = analog ? br : damp(this.brake, br, 15, dt);
    this.hand = damp(this.hand, hb, 18, dt);
    this.boost = bo;
  }

};

/* ---------------- game ---------------- */
const Game = {
  state: 'load', mode: 'free',
  carIndex: 0, paintIndex: 1, finish: 0,
  models: [], batches: [], trafBatches: [],
  player: null,
  camYaw: 0, camPitch: 0.17, camDist: 8.2, camPos: [0, 5, -10], camLook: [0, 1, 0],
  camMode: 0, camShake: 0, camFov: 74,
  scene: null, route: [], cpIndex: 0, gateBatch: null,
  time: 0, raceTime: 0, bestTime: 0, driftScore: 0, driftBank: 0, driftMul: 1, driftTimer: 0,
  settings: { quality: 2, scale: 1, tod: 0.43, cycle: 0, weather: 0, traffic: 46, fov: 74,
    vol: .75, volEng: 1, volTyre: 1, volWorld: 1, mblur: 1, autoq: 1, ssr: 1,
    manual: 0, units: 0, steerRate: 1, assists: 1, shake: 1 },
  todNow: 0.43,
  airBest: 0, topSpeed: 0,
  paused: false, photo: false,
  msgT: 0,

  async boot() {
    const canvas = $('gl');
    const setLoad = (p, m) => { $('loadbar').style.width = (p * 100) + '%'; $('loadmsg').textContent = m; };
    const frame = () => new Promise(r => setTimeout(r, 16));

    setLoad(.05, 'starting renderer'); await frame();
    // a phone should not open on the same preset as a desktop GPU
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    const small = Math.min(innerWidth, innerHeight) < 500;
    if (coarse) this.settings.quality = small ? 0 : 1;
    R.q = this.settings.quality;
    R.init(canvas);
    if (GLX.safeMode) {
      this.settings.ssr = 0; R.ssrEnabled = false;
      this.toastQueue = 'Reduced graphics mode — this device has no float render targets';
    }
    R.userScale = this.settings.scale;
    R.updateSky(this.settings.tod, this.settings.weather, .016);

    Garage.load();
    setLoad(.16, 'forging bodywork'); await frame();
    for (let i = 0; i < CAR_SPECS.length; i++) {
      const mdl = this.prepModel(buildCar(CAR_SPECS[i]));
      mdl._spokes = CAR_SPECS[i].spokes;
      this.models.push(mdl);
      setLoad(.16 + .22 * (i + 1) / CAR_SPECS.length, 'forging bodywork'); await frame();
    }

    setLoad(.42, 'pouring concrete'); await frame();
    World.build({ seed: 20260817 });
    setLoad(.62, 'wiring the grid'); await frame();
    World.upload(R.meshes);

    setLoad(.74, 'filling the streets'); await frame();
    Traffic.init(5);
    for (const m of Traffic.models) this.trafBatches.push(this.prepTraffic(m));
    Traffic.buildParked();
    Traffic.populate(this.settings.traffic);

    setLoad(.88, 'painting the sky'); await frame();
    this.scene = {
      batches: {}, glassBatches: [], dynLights: [],
      particles: new Particles(2600), sprites: new Sprites(1400),
      skid: new SkidTrails(1500), ca: .9
    };
    this.scene.skid.initGL();
    this.gateMesh = buildMesh(geoArch(13, 8.5, .7).done());
    this.gateBatch = new Batch(this.gateMesh, 64, true);
    this.signalBatch = new Batch(R.meshes.sph, 320, true);
    this.wheelSimple = buildMesh(geoLatheX([[.20, -.14], [.33, -.15], [.33, .15], [.20, .14]], 16, true).done());

    this.todNow = this.settings.tod;
    HUD.init();
    Shop.init();
    this.bindUI();
    Input.init();
    this.applyCar();
    this.updateMenuCard();

    Controls.bindSettings();

    setLoad(1, 'ready'); await frame();
    $('load').classList.add('hidden');
    this.resetCar();
    Controls.askIfNeeded(() => {
      this.state = 'menu';
      $('menu').classList.remove('hidden');
      this.updateMenuCard();
      Controls.apply();
      if (this.toastQueue) { this.toast(this.toastQueue, 'bad'); this.toastQueue = null; }
      const h = document.querySelector('#menu .hint');
      if (h) h.innerHTML = Controls.helpHTML();
    });
  },

  prepModel(m) {
    const o = { spec: m.spec };
    for (const k of ['paint', 'dark', 'glass', 'chrome', 'lightF', 'lightR', 'brakeL', 'tire', 'rim', 'disc', 'caliper'])
      o[k] = buildMesh(m[k]);
    return o;
  },
  prepTraffic(m) {
    const o = { info: m };
    for (const k of ['paint', 'glass', 'dark', 'lightF', 'lightR']) o[k] = new Batch(buildMesh(m[k]), 64, true);
    return o;
  },

  /* rebuild the player vehicle from the garage + installed parts */
  applyCar(keepPlace) {
    const id = Garage.current;
    const spec = specById(id);
    const g = Garage.car(id);
    const ph = buildPhys(id);
    const keep = (keepPlace && this.player)
      ? { x: this.player.pos[0], z: this.player.pos[2], yaw: Q.yaw(this.player.q) } : null;

    this.carIndex = CAR_SPECS.indexOf(spec);
    // wheel style changes the mesh, so rebuild the model when it moves
    const rim = RIMS[g.rim | 0] || RIMS[0];
    if (!this.models[this.carIndex] || this.models[this.carIndex]._spokes !== rim.spokes) {
      const s2 = Object.assign({}, spec, { spokes: rim.spokes });
      const built = this.prepModel(buildCar(s2));
      built._spokes = rim.spokes;
      this.models[this.carIndex] = built;
      this.carBatches = null;
    }
    const m = this.models[this.carIndex];

    this.player = new Vehicle(spec, false, ph);
    this.player.throttleSm = 0;
    this.player.manual = this.settings.manual;

    this.carBatches = {};
    for (const k of ['paint', 'dark', 'chrome', 'lightF', 'lightR', 'brakeL', 'tire', 'rim', 'disc', 'caliper'])
      this.carBatches[k] = new Batch(m[k], 8, true);
    this.carGlass = new Batch(m.glass, 8, true);

    this.player.damage = g.damage || 0;
    if (keep) this.player.reset(keep.x, keep.z, keep.yaw, World.groundY(keep.x, keep.z) + 1.0);
    else this.resetCar();

    Audio2.setForced(ph.forced);
    Audio2.setEngineType(ph.soundType || 'v8');
    this.updateMenuCard();
  },

  updateMenuCard() {
    const el = $('menucard'); if (!el) return;
    const spec = specById(Garage.current);
    const ph = buildPhys(Garage.current);
    const st = statsFor(ph);
    el.innerHTML = '<h4>Current build</h4>' +
      '<div class="mc-name">' + spec.name + '</div>' +
      '<div class="mc-sub">' + spec.cls + ' · ' + ph.drive.toUpperCase() +
      (ph.forced !== 'none' ? ' · ' + (ph.forced === 'turbo' ? 'TURBO' : 'SUPERCHARGED') : '') + '</div>' +
      '<div class="mc-grid">' +
      '<div><u>Power</u><b>' + st.hp + '</b></div>' +
      '<div><u>0-100</u><b>' + st.zero100.toFixed(1) + '</b></div>' +
      '<div><u>Vmax</u><b>' + st.vmax + '</b></div>' +
      '</div>';
  },

  resetCar() {
    const s = World.spawn;
    this.player.reset(s.x, s.z, s.yaw, 1.0);
    this.clearTraffic(s.x, s.z, 16);
    this.scene && this.scene.skid.clear();
  },

  /* ---------------- UI ---------------- */
  bindUI() {
    const S = this.settings;

    document.querySelectorAll('#mainnav .mi').forEach(b => {
      b.onmouseenter = () => Audio2.ui('hover');
      b.onclick = () => {
        Audio2.start(); Audio2.ui('ok');
        const a = b.dataset.act;
        if (a === 'shop') this.openShop();
        else if (a === 'settings') { $('menu').classList.add('hidden'); $('settings').classList.remove('hidden'); this.state = 'settings'; }
        else this.startMode(a);
      };
    });
    document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => {
      $('settings').classList.add('hidden');
      if (this.prevState === 'pause') { $('pause').classList.remove('hidden'); this.state = 'pause'; }
      else { $('menu').classList.remove('hidden'); this.state = 'menu'; this.updateMenuCard(); }
      this.prevState = null;
    });
    $('resume').onclick = () => this.setPaused(false);
    $('p-menu').onclick = () => { this.setPaused(false); this.toMenu(); };
    $('p-settings').onclick = () => { this.prevState = 'pause'; $('pause').classList.add('hidden'); $('settings').classList.remove('hidden'); this.state = 'settings'; };
    $('p-shop').onclick = () => { this.prevState = 'pause'; $('pause').classList.add('hidden'); this.openShop(); };
    $('wipesave').onclick = () => {
      Garage.reset(); location.reload();
    };

    // settings tabs
    const tabs = $('settabs');
    tabs.querySelectorAll('button').forEach(b => b.onclick = () => {
      tabs.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      document.querySelectorAll('.tabpane').forEach(p2 => p2.classList.toggle('hidden', p2.dataset.p !== b.dataset.t));
      Audio2.ui('tick');
    });

    const seg = (id, fn, init) => {
      const el = $(id); if (!el) return;
      el.querySelectorAll('button').forEach(b => b.onclick = () => {
        el.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on'); fn(+b.dataset.v); Audio2.ui('tick');
      });
      if (init !== undefined) el.querySelectorAll('button').forEach(x => x.classList.toggle('on', +x.dataset.v === init));
    };
    seg('qseg', v => { S.quality = v; S.autoq = 0; this.syncQualityUI(); R.setQuality(v); }, S.quality);
    seg('autoq', v => S.autoq = v, S.autoq);
    seg('cycleseg', v => S.cycle = v, S.cycle);
    seg('wseg', v => { S.weather = v; Audio2.setRain(v === 2 ? 1 : 0); }, S.weather);
    seg('mbseg', v => S.mblur = v, S.mblur);
    seg('ssrseg', v => { S.ssr = v; R.ssrEnabled = !!v; }, S.ssr);
    seg('transseg', v => { S.manual = v; if (this.player) this.player.manual = v; Controls.updateShiftButtons();
      this.toast(v ? (Controls.device === 'touch' ? 'Manual — use the ▲ ▼ paddles' : 'Manual gearbox — E / Q to shift') : 'Automatic gearbox'); }, S.manual);
    seg('unitseg', v => S.units = v, S.units);
    seg('assistseg', v => S.assists = v, S.assists);

    const rng = (id, out, fn, fmt) => {
      const el = $(id), o = $(out); if (!el) return;
      el.oninput = () => { const v = +el.value; o.textContent = fmt(v); fn(v); };
      o.textContent = fmt(+el.value);
    };
    rng('rscale', 'rscaleo', v => { S.scale = v / 100; R.userScale = S.scale; R.resize(true); }, v => v + '%');
    rng('fov', 'fovo', v => S.fov = v, v => v + '\u00b0');
    rng('tod', 'todo', v => { S.tod = v / 1000; this.todNow = S.tod; }, v => {
      const t = v / 1000;
      return t < .21 ? 'night' : t < .3 ? 'dawn' : t < .44 ? 'morning' : t < .58 ? 'noon' : t < .70 ? 'evening' : t < .80 ? 'sunset' : 'night';
    });
    rng('traffic', 'traffico', v => { S.traffic = v; Traffic.populate(v); }, v => '' + v);
    rng('steerrate', 'steerrateo', v => S.steerRate = v / 100, v => v + '%');
    rng('shake', 'shakeo', v => S.shake = v / 100, v => v + '%');
    rng('vol', 'volo', v => { S.vol = v / 100; Audio2.setVolume(S.vol); }, v => v + '%');
    rng('volEng', 'volEngo', v => S.volEng = v / 100, v => v + '%');
    rng('volTyre', 'volTyreo', v => S.volTyre = v / 100, v => v + '%');
    rng('volWorld', 'volWorldo', v => S.volWorld = v / 100, v => v + '%');

    // mobile browsers fire resize every time the address bar slides; each one
    // used to reallocate the entire render target set
    let rzT = 0;
    addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => R.resize(), 180); });

    GLX.onLost = () => {
      _running = false;
      let el = $('ctxlost');
      if (!el) {
        el = document.createElement('div');
        el.id = 'ctxlost';
        el.innerHTML = '<div class="panel narrow"><h2>Graphics reset</h2>' +
          '<p class="sub">The browser dropped the WebGL context. Reloading puts you straight back.</p>' +
          '<div class="actions col"><button class="btn" id="ctxreload">Reload</button></div></div>';
        el.className = 'screen panel-screen';
        document.body.appendChild(el);
        $('ctxreload').onclick = () => location.reload();
      }
      el.classList.remove('hidden');
    };

    const cv = $('gl');
    let drag = false, lx = 0, ly = 0;
    cv.addEventListener('mousedown', e => { drag = true; lx = e.clientX; ly = e.clientY; });
    addEventListener('mouseup', () => drag = false);
    addEventListener('mousemove', e => {
      if (!drag) return;
      if (this.photo || this.state === 'menu') {
        this.camYaw -= (e.clientX - lx) * .006;
        this.camPitch = clamp(this.camPitch + (e.clientY - ly) * .004, -.2, 1.2);
      }
      lx = e.clientX; ly = e.clientY;
    });
    cv.addEventListener('wheel', e => {
      if (this.photo || this.state === 'menu') { this.camDist = clamp(this.camDist + e.deltaY * .01, 2.5, 45); e.preventDefault(); }
    }, { passive: false });
    cv.addEventListener('pointerdown', () => Audio2.start());
  },

  openShop() {
    Audio2.start();
    $('menu').classList.add('hidden');
    $('hud').classList.add('hidden');
    this.state = 'shop';
    Shop.open();
  },
  closeShop(drive) {
    Shop.close();
    if (drive) this.startMode(this.mode || 'free');
    else if (this.prevState === 'pause') { this.prevState = null; $('pause').classList.remove('hidden'); this.state = 'pause'; }
    else { $('menu').classList.remove('hidden'); this.state = 'menu'; this.updateMenuCard(); }
  },

  toast(msg, kind) {
    const t = $('toast');
    const d = document.createElement('div');
    d.className = 'tst' + (kind ? ' ' + kind : '');
    d.textContent = msg;
    t.appendChild(d);
    setTimeout(() => d.remove(), 2700);
  },

  pay(amount, why) {
    if (amount <= 0) return;
    Garage.add(Math.round(amount));
    HUD.popup('+' + money(amount), '#7cf37c');
    if (why) this.toast(why + '  ' + money(amount), 'good');
  },

  paintMaterial() {
    const g = Garage.car();
    const p = PAINTS[g.paint | 0] || PAINTS[0];
    const c = srgb2lin(hex2rgb(p.c));
    let rough = p.r, metal = p.m;
    const f = g.finish | 0;
    if (f === 1) { rough = .18; metal = .72; }
    else if (f === 2) { rough = .62; metal = .02; }
    else if (f === 3) { rough = .06; metal = 1.0; }
    return { c, rough, metal };
  },

  /* ---------------- modes ---------------- */
  startMode(m) {
    this.mode = m;
    $('menu').classList.add('hidden'); $('settings').classList.add('hidden');
    Shop.close();
    $('hud').classList.remove('hidden');
    this.state = 'play';
    this.resetCar();
    this.driftScore = 0; this.driftBank = 0; this.driftMul = 1; this.driftTimer = 0;
    this.topSpeed = 0; this.airBest = 0; this.trapBest = 0;
    this.route = []; this.cpIndex = 0;
    this.countdown = (m === 'free') ? 0 : 3.999;
    Controls.recalibrate(); Controls.updateShiftButtons(); Controls.measure();
    this._cdLast = -1;
    Audio2.start();
    Audio2.starter();
    if (m === 'race') {
      this.buildRoute(9);
      this.raceTime = 0;
      $('modename').textContent = 'CHECKPOINT RUN';
      HUD.big('GO', 'reach every gate');
    } else if (m === 'drift') {
      this.raceTime = 90;
      $('modename').textContent = 'DRIFT ATTACK';
      HUD.big('SLIDE', '90 seconds');
    } else if (m === 'speed') {
      this.raceTime = 60;
      $('modename').textContent = 'SPEED TRAP';
      HUD.big('FLAT OUT', 'best speed in 60s');
    } else {
      $('modename').textContent = 'FREE ROAM';
      HUD.big('', '');
    }
  },

  toMenu() {
    this.state = 'menu';
    $('hud').classList.add('hidden');
    $('menu').classList.remove('hidden');
    this.route = [];
  },

  buildRoute(n) {
    const rnd = mulberry32((Math.random() * 1e9) | 0);
    const N = World.N;
    this.route = [];
    let ci = clamp(Math.round((this.player.pos[0] + World.half) / World.CELL), 1, N - 1);
    let cj = clamp(Math.round((this.player.pos[2] + World.half) / World.CELL), 1, N - 1);
    for (let k = 0; k < n; k++) {
      let ni, nj, guard = 0;
      do {
        ni = clamp(ci + ((rnd() * 7) | 0) - 3, 1, N - 1);
        nj = clamp(cj + ((rnd() * 7) | 0) - 3, 1, N - 1);
      } while ((Math.abs(ni - ci) + Math.abs(nj - cj) < 2) && guard++ < 30);
      ci = ni; cj = nj;
      this.route.push({ x: World.roadX(ci), z: World.roadX(cj), i: ci, j: cj });
    }
    this.cpIndex = 0;
  },

  onKey(code, e) {
    if (code === 'KeyP') { this.togglePhoto(); return; }
    if (code === 'Escape') {
      if (this.state === 'play') this.setPaused(!this.paused);
      else if (this.state === 'shop') this.closeShop();
      else if (this.state === 'settings') {
        $('settings').classList.add('hidden'); $('menu').classList.remove('hidden'); this.state = 'menu';
      }
      return;
    }
    if (this.state !== 'play') return;
    if (code === 'KeyR') this.respawn();
    if (code === 'KeyC') { this.camMode = (this.camMode + 1) % 4; HUD.popup(['CHASE', 'CLOSE', 'HOOD', 'CINEMATIC'][this.camMode], '#8ba1bd'); }
    if (code === 'KeyH') this.player.headlightsManual = !this.player.headlightsManual;
    if (code === 'KeyT') {
      this.settings.manual = this.settings.manual ? 0 : 1;
      this.player.manual = this.settings.manual;
      this.syncSeg('transseg', this.settings.manual);
      Controls.updateShiftButtons();
      this.toast(this.settings.manual ? 'MANUAL — E upshift, Q downshift' : 'AUTOMATIC');
      Audio2.ui('tick');
    }
    if (this.settings.manual) {
      if (code === 'KeyE' || code === 'ShiftRight') {
        const r = this.player.shiftUp(); if (r > 0) Audio2.shift(true);
      }
      if (code === 'KeyQ' || code === 'ControlRight') {
        const r = this.player.shiftDown();
        if (r > 0) Audio2.shift(false);
        else if (r < 0) { Audio2.grind(); HUD.popup('OVER-REV', '#ff3d68'); }
      }
    }
  },

  padShift(dir) {
    if (this.state !== 'play' || !this.settings.manual) return;
    if (dir > 0) { if (this.player.shiftUp() > 0) Audio2.shift(true); }
    else { const r = this.player.shiftDown(); if (r > 0) Audio2.shift(false); else if (r < 0) Audio2.grind(); }
  },

  syncSeg(id, v) {
    const el = $(id); if (!el) return;
    el.querySelectorAll('button').forEach(x => x.classList.toggle('on', +x.dataset.v === v));
  },

  clearTraffic(x, z, r) {
    for (const t of Traffic.cars) {
      const dx = t.x - x, dz = t.z - z;
      const d = Math.hypot(dx, dz);
      if (d < r) {
        const a = d > 0.01 ? Math.atan2(dz, dx) : Math.random() * TAU;
        t.x = x + Math.cos(a) * (r + 6 + Math.random() * 40);
        t.z = z + Math.sin(a) * (r + 6 + Math.random() * 40);
      }
    }
  },

  respawn() {
    const p = this.player;
    // snap to the nearest road centre facing along it
    const i = clamp(Math.round((p.pos[0] + World.half) / World.CELL), 0, World.N);
    const rx = World.roadX(i);
    const yaw = Q.yaw(p.q);
    p.reset(rx + 3.6 * Math.sign(Math.cos(yaw) || 1), p.pos[2], Math.abs(wrapPi(yaw)) < PI / 2 ? 0 : PI, 1.2);
    this.clearTraffic(p.pos[0], p.pos[2], 14);
    HUD.popup('RESET', '#22e3ff');
  },

  setPaused(v) {
    this.paused = v;
    if (Controls.ready) Controls.measure();
    $('pause').classList.toggle('hidden', !v);
    if (v) { this.state = 'pause'; } else { this.state = 'play'; $('settings').classList.add('hidden'); $('garage').classList.add('hidden'); }
  },

  togglePhoto() {
    if (this.state !== 'play' && !this.photo) return;
    this.photo = !this.photo;
    $('photohint').classList.toggle('hidden', !this.photo);
    $('hud').classList.toggle('hidden', this.photo || this.state !== 'play');
  },

  /* ---------------- per-frame ---------------- */
  update(dt) {
    this.time += dt;
    const S = this.settings;
    if (S.cycle) this.todNow = (this.todNow + dt * (S.cycle === 2 ? 0.014 : 0.0042)) % 1;
    R.updateSky(this.todNow, S.weather, dt);

    Input.poll(dt, S.steerRate);
    const p = this.player;
    const playing = this.state === 'play' && !this.paused && !this.photo;

    const inp = playing
      ? { steer: Input.steer, throttle: Input.throttle, brake: Input.brake }
      : { steer: 0, throttle: 0, brake: 0 };

    // race start lights
    if (this.countdown > 0) {
      const prev = Math.ceil(this.countdown);
      this.countdown = Math.max(0, this.countdown - dt);
      const now = Math.ceil(this.countdown);
      if (now !== this._cdLast) {
        this._cdLast = now;
        if (now > 0) { HUD.big(String(now), ''); Audio2.blip(680, .10, .07, 'triangle'); }
        else { HUD.big('GO', ''); Audio2.blip(1320, .22, .09, 'triangle'); }
      }
      // held on the line: revs allowed, drive is not
      p.handbrake = 1;
      inp.brake = 1;
      p.clutchPedal = 1;
      p.throttle = inp.throttle;
      p.throttleSm = damp(p.throttleSm || 0, inp.throttle, 9, dt);
      p.autoGearbox(dt, { throttle: 0, brake: 1, steer: 0 });
      p.update(dt, { steer: 0, throttle: inp.throttle, brake: 1 }, World);
      this.updateEffects(dt);
      this.updateCamera(dt, false);
      Audio2.updateEngine(p, dt, this.camDist, R.wet > .5);
      HUD.rows([]);
      return;
    }

    if (playing) {
      p.handbrake = Input.hand;
      p.clutchPedal = Input.clutch;
      p.manual = S.manual;
      p.wetness = R.wet;
      // nitrous
      const wantNos = Input.boost && p.nos > 0.02 && p.ph.nosShot > 0;
      if (wantNos && !p.nosActive) Audio2.pop(0.6);
      p.nosActive = wantNos ? 1 : 0;
      p.boostActive = p.nosActive;
      p.boost = p.nos;
      if (p.nosActive) inp.throttle = Math.max(inp.throttle, 0.85);
      // light stability assist
      if (S.assists === 2 && p.grounded >= 3 && p.driftAmount > 0.35)
        p.av[1] *= 1 - 1.6 * dt;
    } else {
      p.handbrake = 1; p.boostActive = 0; p.nosActive = 0;
    }
    p.throttle = inp.throttle; p.brake = inp.brake;
    p.throttleSm = damp(p.throttleSm || 0, inp.throttle, 9, dt);
    p.autoGearbox(dt, inp);
    const prevGear = p.gear;
    p.update(dt, inp, World);
    if (p.gear !== prevGear && playing && !S.manual) Audio2.shift(p.gear > prevGear);
    p.brakeLight = damp(p.brakeLight, (inp.brake > .05 || p.handbrake > .3) ? 1 : 0, 18, dt);
    const wantLights = (R.sky.night > .35 || S.weather === 2) !== !!p.headlightsManual;
    p.headlights = damp(p.headlights, wantLights ? 1 : 0, 4, dt);

    Traffic.update(dt, p);

    if (p.impact > .05 && this.time - p.lastImpactT > .18) {
      p.lastImpactT = this.time;
      Audio2.impact(clamp01(p.impact));
      this.camShake = Math.max(this.camShake, p.impact * .9 * S.shake);
      R.flash = Math.max(R.flash, p.impact * .12);
      this.sparks(p);
      if (this.mode === 'drift' && this.driftScore > 0) { this.driftScore *= .3; this.driftMul = 1; }
    }

    this.updateEffects(dt);
    this.updateCamera(dt, playing);
    this.updateMode(dt, playing);

    Audio2.updateEngine(p, dt, this.camMode === 2 ? 1.5 : this.camDist, R.wet > .5);

    const kmh = Math.abs(p.fwdSpeed) * 3.6;
    if (kmh > this.topSpeed) this.topSpeed = kmh;
    if (playing) {
      Garage.stats.distance += p.speed * dt;
      if (kmh > Garage.stats.topSpeed) Garage.stats.topSpeed = kmh;
      // passive earnings so free roam still pays
      this._payAcc = (this._payAcc || 0) + p.speed * dt * 0.26 * (1 + p.driftAmount * 4) * (1 + clamp01((Math.abs(p.fwdSpeed) * 3.6 - 110) / 150));
      if (this._payAcc > 45) { const v = Math.floor(this._payAcc); this._payAcc = 0; Garage.add(v); }
      this._saveT = (this._saveT || 0) + dt;
      if (this._saveT > 12) { this._saveT = 0; Garage.car().damage = p.damage; Garage.save(); }
    }
    R.speedBlur = S.mblur ? clamp01((kmh - 95) / 210) * .95 * (p.nosActive ? 1.6 : 1) : 0;
    R.cam.fov = damp(R.cam.fov, S.fov + clamp01((kmh - 40) / 260) * 15 + (p.nosActive ? 6 : 0), 4, dt);
    this.scene.ca = .8 + clamp01((kmh - 120) / 200) * 2.4;
  },

  updateMode(dt, playing) {
    const p = this.player;
    const kmh = Math.abs(p.fwdSpeed) * 3.6;
    if (!playing) { HUD.drift(false); return; }

    if (this.countdown > 0) return;
    if (this.mode === 'race') {
      this.raceTime += dt;
      const cp = this.route[this.cpIndex];
      if (cp) {
        const d = Math.hypot(p.pos[0] - cp.x, p.pos[2] - cp.z);
        if (d < 9.5) {
          this.cpIndex++;
          Audio2.blip(1320, .09, .09, 'triangle');
          HUD.popup('CHECKPOINT ' + this.cpIndex + '/' + this.route.length, '#4ce0ff');
          this.pay(320 + Math.round(Math.max(0, 26 - this.raceTime / Math.max(1, this.cpIndex)) * 40));
          if (this.cpIndex >= this.route.length) {
            const t = this.raceTime;
            const par = this.route.length * 15;
            this.pay(Math.round(2200 + Math.max(0, par - t) * 120), 'Route complete');
            Garage.stats.races++;
            if (!this.bestTime || t < this.bestTime) this.bestTime = t;
            HUD.big(this.fmtTime(t), 'route complete');
            Audio2.chord([660, 880, 1320], .5);
            setTimeout(() => { if (this.state === 'play') { this.buildRoute(9); this.raceTime = 0; HUD.big('NEXT ROUTE', ''); } }, 1800);
          }
        }
      }
      HUD.rows([
        { k: 'time', v: this.fmtTime(this.raceTime) },
        { k: 'gate', v: Math.min(this.cpIndex + 1, this.route.length) + ' / ' + this.route.length },
        { k: 'best', v: this.bestTime ? this.fmtTime(this.bestTime) : '—' },
      ]);
      HUD.drift(false);
    } else if (this.mode === 'drift') {
      this.raceTime -= dt;
      const sliding = p.driftAmount > .12 && p.grounded >= 2 && kmh > 26;
      if (sliding) {
        this.driftTimer = 1.6;
        const gain = p.driftAmount * kmh * dt * 2.2;
        this.driftScore += gain * this.driftMul;
        this.driftMul = Math.min(9.9, this.driftMul + dt * 0.42);
      } else if (this.driftTimer > 0) {
        this.driftTimer -= dt;
        if (this.driftTimer <= 0) {
          if (this.driftScore > 400) { HUD.popup('+' + Math.round(this.driftScore).toLocaleString(), '#ffcf6b'); Audio2.blip(880, .12, .07, 'triangle'); }
          this.driftBank += this.driftScore; this.driftScore = 0; this.driftMul = 1;
        }
      }
      if (p.impact > .3 && this.driftScore > 0) { this.driftScore *= .35; this.driftMul = 1; }
      HUD.drift(this.driftScore > 20 || this.driftTimer > 0, this.driftScore, this.driftMul, clamp01(this.driftTimer / 1.6));
      HUD.rows([
        { k: 'banked', v: Math.round(this.driftBank).toLocaleString() },
        { k: 'time', v: this.fmtTime(Math.max(0, this.raceTime)), warn: this.raceTime < 12 },
      ]);
      if (this.raceTime <= 0) {
        this.driftBank += this.driftScore; this.driftScore = 0;
        Garage.stats.drift = Math.max(Garage.stats.drift, this.driftBank);
        this.pay(Math.round(this.driftBank * 0.75), 'Drift session');
        HUD.big(Math.round(this.driftBank).toLocaleString(), 'final score');
        Audio2.chord([523, 659, 784], .6);
        this.raceTime = 90; this.driftBank = 0; this.driftMul = 1;
      }
    } else if (this.mode === 'speed') {
      this.raceTime -= dt;
      this.trapBest = Math.max(this.trapBest || 0, kmh);
      HUD.rows([
        { k: 'best', v: Math.round(this.trapBest) + ' km/h' },
        { k: 'now', v: Math.round(kmh) + ' km/h' },
        { k: 'time', v: this.fmtTime(Math.max(0, this.raceTime)), warn: this.raceTime < 10 },
      ]);
      HUD.drift(false);
      if (this.raceTime <= 0) {
        const reward = Math.round(Math.max(0, this.trapBest - 120) * 22);
        HUD.big(Math.round(this.trapBest) + ' km/h', 'speed trap');
        this.pay(reward, 'Speed trap');
        Audio2.chord([523, 784, 1046], .5);
        this.raceTime = 60; this.trapBest = 0;
      }
    } else {
      HUD.drift(p.driftAmount > .2, this.driftScore, this.driftMul, 1);
      if (p.driftAmount > .12 && p.grounded >= 2 && kmh > 26) {
        this.driftScore += p.driftAmount * kmh * dt * 2.2 * this.driftMul;
        this.driftMul = Math.min(9.9, this.driftMul + dt * .42);
        this.driftTimer = 1.6;
      } else if (this.driftTimer > 0) {
        this.driftTimer -= dt;
        if (this.driftTimer <= 0) {
          if (this.driftScore > 300) this.pay(Math.round(this.driftScore * 0.30));
          this.driftScore = 0; this.driftMul = 1;
        }
      }
      if (p.airTime > .45) this.airBest = Math.max(this.airBest, p.airTime);
      const rows = [
        { k: 'top speed', v: Math.round(this.topSpeed) + ' km/h' },
        { k: 'distance', v: (p.odo / 1000).toFixed(2) + ' km' },
        { k: 'best air', v: this.airBest.toFixed(2) + ' s' },
      ];
      if (p.damage > 0.12) rows.push({ k: 'damage', v: Math.round(p.damage * 100) + '%', warn: p.damage > 0.5 });
      HUD.rows(rows);
    }
  },

  fmtTime(t) {
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  },

  /* ---------------- camera ---------------- */
  updateCamera(dt, playing) {
    const p = this.player;
    const up = [0, 0, 0], fwd = [0, 0, 0];
    p.dirWorld(fwd, [0, 0, 1]); p.dirWorld(up, [0, 1, 0]);
    const heading = Math.atan2(fwd[0], fwd[2]);
    const kmh = Math.abs(p.fwdSpeed) * 3.6;

    if (this.photo || this.state === 'menu' || this.state === 'garage' || this.state === 'settings') {
      if (!this.photo) { this.camYaw += dt * .10; this.camPitch = .19 + Math.sin(this.time * .18) * .06; this.camDist = 9.4; }
      const cy = Math.cos(this.camPitch);
      const px = p.pos[0] + Math.sin(this.camYaw) * this.camDist * cy;
      const pz = p.pos[2] + Math.cos(this.camYaw) * this.camDist * cy;
      const py = p.pos[1] + .9 + Math.sin(this.camPitch) * this.camDist;
      V3.set(R.cam.pos, px, py, pz);
      V3.set(R.cam.target, p.pos[0], p.pos[1] + .75, p.pos[2]);
      V3.set(R.cam.up, 0, 1, 0);
      return;
    }

    if (this.camMode === 2) { // hood
      const o = [0, 0, 0];
      p.toWorld(o, [0, 1.02, p.spec.len * .16]);
      const t = [0, 0, 0];
      p.toWorld(t, [0, 1.00, p.spec.len * .16 + 8]);
      V3.copy(R.cam.pos, o); V3.copy(R.cam.target, t);
      V3.set(R.cam.up, up[0], up[1], up[2]);
      this.camYaw = heading;
      return;
    }

    // chase / close
    const flat = Math.hypot(p.vel[0], p.vel[2]);
    let want = heading;
    if (flat > 6) {
      const vh = Math.atan2(p.vel[0], p.vel[2]);
      want = heading + wrapPi(vh - heading) * .34;
    }
    const lag = this.camMode === 3 ? 1.1 : (2.6 + clamp01(kmh / 200) * 4.2);
    this.camYaw += wrapPi(want - this.camYaw) * clamp01(lag * dt);

    let dist = this.camMode === 1 ? 5.4 : 8.0;
    let height = this.camMode === 1 ? 1.9 : 2.85;
    if (this.camMode === 3) { dist = 12 + Math.sin(this.time * .21) * 3; height = 3.6; }
    dist += clamp01(kmh / 240) * 1.5;
    dist -= p.boostActive ? .7 : 0;

    const gy = World.groundY(p.pos[0], p.pos[2]);
    const tx = p.pos[0] - Math.sin(this.camYaw) * dist;
    const tz = p.pos[2] - Math.cos(this.camYaw) * dist;
    const ty = Math.max(p.pos[1] + height, gy + 1.2);

    const k = clamp01(dt * (8 + clamp01(kmh / 200) * 10));
    this.camPos[0] = lerp(this.camPos[0], tx, k);
    this.camPos[1] = lerp(this.camPos[1], ty, clamp01(dt * 6));
    this.camPos[2] = lerp(this.camPos[2], tz, k);

    // shake
    this.camShake = Math.max(0, this.camShake - dt * 2.4);
    const sh = this.camShake * .35 + clamp01((kmh - 180) / 220) * .035;
    const sx = (Math.sin(this.time * 61.3) + Math.sin(this.time * 37.1)) * sh * .5;
    const sy = (Math.sin(this.time * 53.7) + Math.sin(this.time * 29.3)) * sh * .5;

    V3.set(R.cam.pos, this.camPos[0] + sx, this.camPos[1] + sy, this.camPos[2]);
    const lookAhead = clamp01(kmh / 160) * 6;
    V3.set(R.cam.target,
      p.pos[0] + p.vel[0] * .10 + Math.sin(this.camYaw) * lookAhead,
      p.pos[1] + .95,
      p.pos[2] + p.vel[2] * .10 + Math.cos(this.camYaw) * lookAhead);
    // subtle roll into the corner
    const roll = clamp(-p.av[1] * .05 + p.driftAmount * Math.sign(p.av[1]) * .04, -.09, .09);
    V3.set(R.cam.up, Math.sin(roll), Math.cos(roll), 0);
  },

  /* ---------------- effects ---------------- */
  sparks(p) {
    const P = this.scene.particles;
    const n = 6 + (p.impact * 26) | 0;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = 3 + Math.random() * 11;
      P.emit({
        x: p.pos[0] + (Math.random() - .5) * 1.6, y: p.pos[1] + .3 + Math.random() * .5, z: p.pos[2] + (Math.random() - .5) * 1.6,
        vx: Math.cos(a) * s - p.vel[0] * .25, vy: 1.5 + Math.random() * 4.5, vz: Math.sin(a) * s - p.vel[2] * .25,
        s0: .09, s1: .03, life: .30 + Math.random() * .45,
        r: 3.0, g: 1.5, b: .35, a: 1, kind: P_STREAK, stretch: .22, drag: .9, grav: -16, add: 1
      });
    }
  },

  updateEffects(dt) {
    const p = this.player, P = this.scene.particles, S = this.scene.sprites;
    S.clear();
    const wet = R.wet;

    /* tyre smoke + skid marks */
    for (let i = 0; i < 4; i++) {
      const w = p.wheels[i];
      if (!w.contact) { this.scene.skid.drop(i); continue; }
      const strength = clamp01((w.skid - .18) * 1.9);
      if (strength > .03 && p.speed > 2) {
        const fwd = [0, 0, 0]; p.dirWorld(fwd, [0, 0, 1]);
        const rx = fwd[2], rz = -fwd[0];
        this.scene.skid.add(i, w.cp[0], w.cp[1], w.cp[2], rx, rz, strength * .82, this.time);
        if (Math.random() < strength * 22 * dt) {
          const grass = false;
          P.emit({
            x: w.cp[0] + (Math.random() - .5) * .3, y: w.cp[1] + .12, z: w.cp[2] + (Math.random() - .5) * .3,
            vx: -p.vel[0] * .12 + (Math.random() - .5) * 1.6, vy: .5 + Math.random() * 1.1, vz: -p.vel[2] * .12 + (Math.random() - .5) * 1.6,
            s0: .55, s1: 3.4 + Math.random() * 2, life: 1.0 + Math.random() * 1.1,
            r: wet > .4 ? .55 : .40, g: wet > .4 ? .57 : .40, b: wet > .4 ? .60 : .41,
            a: (wet > .4 ? .16 : .34) * strength, kind: P_SMOKE, drag: 1.3, grav: .5, rotV: (Math.random() - .5) * 1.4
          });
        }
      } else this.scene.skid.drop(i);
    }
    this.scene.skid.fade(this.time);

    /* engine smoke once the car is properly bent */
    if (p.damage > 0.42 && Math.random() < (p.damage - 0.4) * 26 * dt) {
      const o = [0, 0, 0];
      p.toWorld(o, [(Math.random() - .5) * p.spec.width * .5, p.spec.profile.belt[3] * .9, p.spec.len * .30]);
      P.emit({
        x: o[0], y: o[1], z: o[2],
        vx: p.vel[0] * .35 + (Math.random() - .5), vy: 1.4 + Math.random() * 1.4, vz: p.vel[2] * .35 + (Math.random() - .5),
        s0: .30, s1: 2.6, life: 1.1 + Math.random() * .8,
        r: .16, g: .155, b: .15, a: .26 + p.damage * .2, kind: P_SMOKE, drag: 1.5, grav: .9,
        rotV: (Math.random() - .5) * 1.2
      });
    }
    if (p.scrape > .2 && p.speed > 4 && Math.random() < p.scrape * 30 * dt) {
      Audio2.scrape(p.scrape);
      const o = [0, 0, 0];
      p.toWorld(o, [(Math.random() < .5 ? -1 : 1) * p.spec.width * .5, .5, (Math.random() - .5) * p.spec.len * .6]);
      for (let i = 0; i < 3; i++) P.emit({
        x: o[0], y: o[1], z: o[2],
        vx: (Math.random() - .5) * 6 - p.vel[0] * .2, vy: Math.random() * 3, vz: (Math.random() - .5) * 6 - p.vel[2] * .2,
        s0: .07, s1: .02, life: .28, r: 3.0, g: 1.5, b: .4, a: 1, kind: P_STREAK, stretch: .2, drag: 1, grav: -14, add: 1
      });
    }

    /* exhaust */
    if (p.throttleSm > .35 && Math.random() < p.throttleSm * 12 * dt && p.speed < 42) {
      const o = [0, 0, 0];
      p.toWorld(o, [0, .35, -p.spec.len * .5 - .1]);
      P.emit({
        x: o[0], y: o[1], z: o[2],
        vx: p.vel[0] * .6 + (Math.random() - .5), vy: .7 + Math.random(), vz: p.vel[2] * .6 + (Math.random() - .5),
        s0: .22, s1: 1.5, life: .6 + Math.random() * .5,
        r: .30, g: .31, b: .33, a: .16, kind: P_SMOKE, drag: 1.9, grav: .6
      });
    }

    /* rain */
    if (this.settings.weather === 2) {
      const cnt = Math.min(120, (900 * dt) | 0);
      const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
      for (let i = 0; i < cnt; i++) {
        const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * 22;
        P.emit({
          x: R.cam.pos[0] + fx * 9 + Math.cos(a) * r + p.vel[0] * .35,
          y: R.cam.pos[1] + 7 + Math.random() * 9,
          z: R.cam.pos[2] + fz * 9 + Math.sin(a) * r + p.vel[2] * .35,
          vx: 2.2 - p.vel[0] * .28, vy: -23, vz: 1.1 - p.vel[2] * .28,
          s0: .055, s1: .055, life: .85,
          r: .78, g: .86, b: 1.05, a: .55, kind: P_STREAK, stretch: 6.5, drag: 0, grav: -3
        });
      }
      // spray kicked up by the wheels
      if (p.speed > 6) for (const w of p.wheels) {
        if (!w.contact || Math.random() > 18 * dt) continue;
        P.emit({
          x: w.cp[0], y: w.cp[1] + .1, z: w.cp[2],
          vx: -p.vel[0] * .35 + (Math.random() - .5) * 2, vy: 1.2 + Math.random(), vz: -p.vel[2] * .35 + (Math.random() - .5) * 2,
          s0: .3, s1: 2.2, life: .55 + Math.random() * .4,
          r: .62, g: .66, b: .72, a: .22 * clamp01(p.speed / 24), kind: P_SMOKE, drag: 2.4, grav: -1.2
        });
      }
    }

    /* headlight / tail glows and dynamic lights */
    const dyn = this.scene.dynLights;
    dyn.length = 0;
    const spec = p.spec;
    const hl = p.headlights;
    const fwd = [0, 0, 0]; p.dirWorld(fwd, [0, 0, 1]);
    const dn = [0, 0, 0]; p.dirWorld(dn, [0, -0.16, 1]); V3.norm(dn, dn);
    for (const sx of [-1, 1]) {
      const o = [0, 0, 0];
      p.toWorld(o, [sx * spec.width * .33, spec.lightY - CAR_SAG, spec.len * .5 - .05]);
      if (hl > .05) {
        S.add(o[0], o[1], o[2], .78, 1.0 * hl, .95 * hl, .82 * hl, .60 * hl, P_GLOW);
        dyn.push({ p: [o[0] + fwd[0] * .6, o[1], o[2] + fwd[2] * .6], c: [1, .96, .88], r: 46, i: 1500 * hl, dir: dn, inner: .965, outer: .60, prio: 0 });
      }
      const t = [0, 0, 0];
      p.toWorld(t, [sx * spec.width * .30, spec.tailY - CAR_SAG, -spec.len * .5 + .02]);
      const bi = .18 + p.brakeLight * .75;
      S.add(t[0], t[1], t[2], .26 + p.brakeLight * .16, 1.5 * bi, .10 * bi, .06 * bi, .40 * bi * (.35 + .65 * R.sky.night), P_GLOW);
      if (p.brakeLight > .1) dyn.push({ p: [t[0], t[1], t[2] - fwd[2] * .4], c: [1, .12, .06], r: 8, i: 16 * p.brakeLight * (.12 + .88 * R.sky.night), prio: 0 });
    }
    if (p.boostActive) {
      const o = [0, 0, 0];
      p.toWorld(o, [0, .35, -spec.len * .5 - .2]);
      S.add(o[0], o[1], o[2], 1.6 + Math.random() * .6, 1.4, .7, 2.4, .8, P_GLOW);
      dyn.push({ p: o, c: [.6, .4, 1], r: 14, i: 90, prio: 0 });
      for (let i = 0; i < 2; i++) P.emit({
        x: o[0], y: o[1], z: o[2], vx: -fwd[0] * 6 + (Math.random() - .5), vy: (Math.random() - .5), vz: -fwd[2] * 6 + (Math.random() - .5),
        s0: .3, s1: .9, life: .30, r: 1.6, g: .9, b: 2.6, a: .7, kind: P_GLOW, drag: 3, add: 1
      });
    }

    /* street lamp halos at night */
    if (R.sky.night > .12) {
      const cp = R.cam.pos;
      let added = 0;
      for (let i = 0; i < World.lights.length && added < 90; i++) {
        const l = World.lights[i];
        const d2 = (l.p[0] - cp[0]) ** 2 + (l.p[2] - cp[2]) ** 2;
        if (d2 > 150 * 150) continue;
        const f = R.sky.night * (l.kind === 'street' ? 1 : .7);
        S.add(l.p[0], l.p[1], l.p[2], l.kind === 'street' ? 3.4 : 2.2, l.col[0] * f, l.col[1] * f, l.col[2] * f, .30 * f, P_GLOW);
        added++;
      }
    }

    /* traffic head/tail lights */
    if (R.sky.night > .2) {
      const cp = R.cam.pos;
      for (const t of Traffic.cars) {
        const d2 = (t.x - cp[0]) ** 2 + (t.z - cp[2]) ** 2;
        if (d2 > 190 * 190) continue;
        const m = Traffic.models[t.model];
        const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);
        const rxv = fz, rzv = -fx;
        for (const s of [-1, 1]) {
          S.add(t.x + fx * m.len * .5 + rxv * s * m.width * .32, .82, t.z + fz * m.len * .5 + rzv * s * m.width * .32,
            1.0, .9, .88, .78, .35 * R.sky.night, P_GLOW);
          S.add(t.x - fx * m.len * .5 + rxv * s * m.width * .32, .82, t.z - fz * m.len * .5 + rzv * s * m.width * .32,
            .8, 1.3 * (.4 + t.brake), .07, .05, .35 * R.sky.night, P_GLOW);
        }
      }
    }

    P.update(dt, [0, 0, 0]);
  },

  /* ---------------- build draw batches ---------------- */
  buildBatches() {
    const sc = this.scene;
    sc.batches = {};
    sc.glassBatches = [];
    for (const k in this.carBatches) this.carBatches[k].clear();
    this.carGlass.clear();
    for (const tb of this.trafBatches) for (const k in tb) if (tb[k] && tb[k].clear) tb[k].clear();
    if (!this.trafWheel) this.trafWheel = new Batch(this.wheelSimple, 512, true);
    this.trafWheel.clear();
    this.gateBatch.clear();

    /* --- player --- */
    const p = this.player, m = M4.n();
    M4.compose(m, p.q, p.pos, [1, 1, 1]);
    const pm = this.paintMaterial();
    const dmg = p.damage || 0;
    const dr = lerp(pm.rough, Math.max(pm.rough, .70), dmg);
    const dk = 1 - dmg * .35;
    const B = this.carBatches;
    B.paint.push(m, pm.c[0] * dk, pm.c[1] * dk, pm.c[2] * dk, dr, pm.metal * (1 - dmg * .6), 0, M_PAINT, 0);
    B.dark.push(m, .075, .078, .085, .58, .05, 0, M_PLASTIC, 0);
    B.chrome.push(m, .82, .84, .88, .13, 1, 0, M_METAL, 0);
    const hl = p.headlights;
    B.lightF.push(m, 1.35, 1.30, 1.20, .12, .1, 3.6 * hl + .18, M_EMISSIVE, 0);
    const tail = (.85 + 1.10 * R.sky.night) + p.brakeLight * 2.6;
    B.lightR.push(m, 1.75, .11, .07, .18, .1, tail, M_EMISSIVE, 0);
    B.brakeL.push(m, 1.75, .12, .08, .18, .1, .25 + p.brakeLight * 3.0, M_EMISSIVE, 0);
    this.carGlass.push(m, .03, .04, .06, .06, 0, .30, M_GLASSDARK, 0);
    this.pushWheels(p, m, B);

    /* --- traffic --- */
    const cp = R.cam.pos;
    const tm = M4.n();
    for (const t of Traffic.cars) {
      const d2 = (t.x - cp[0]) ** 2 + (t.z - cp[2]) ** 2;
      if (d2 > 340 * 340) continue;
      const md = this.trafBatches[t.model], info = md.info;
      M4.trs(tm, t.x, 0, t.z, t.yaw, 1, 1, 1);
      md.paint.push(tm, t.color[0], t.color[1], t.color[2], .30, .18, 0, M_PAINT, 0);
      md.dark.push(tm, .05, .05, .055, .6, .05, 0, M_PLASTIC, 0);
      md.lightF.push(tm, 1, .95, .85, .2, 0, R.sky.night * 3.0 + .05, M_EMISSIVE, 0);
      md.lightR.push(tm, 1, .1, .07, .2, 0, (R.sky.night * .8 + .1) * (1 + t.brake * 2), M_EMISSIVE, 0);
      md.glass.push(tm, .03, .04, .06, .07, 0, .32, M_GLASSDARK, 0);
      this.pushTrafficWheels(t, info);
    }
    for (const t of Traffic.parked) {
      const d2 = (t.x - cp[0]) ** 2 + (t.z - cp[2]) ** 2;
      if (d2 > 240 * 240) continue;
      const md = this.trafBatches[t.model], info = md.info;
      M4.trs(tm, t.x, World.CURB, t.z, t.yaw, 1, 1, 1);
      md.paint.push(tm, t.color[0], t.color[1], t.color[2], .34, .16, 0, M_PAINT, 0);
      md.dark.push(tm, .05, .05, .055, .6, .05, 0, M_PLASTIC, 0);
      md.glass.push(tm, .03, .04, .06, .07, 0, .32, M_GLASSDARK, 0);
      this.pushTrafficWheels({ x: t.x, z: t.z, yaw: t.yaw, wheelSpin: 0 }, info, World.CURB);
    }

    /* --- traffic signal lamps --- */
    this.signalBatch.clear();
    {
      const t = Traffic.clock, cpx = cp[0], cpz = cp[2];
      const sm = M4.n();
      for (let i = 0; i < World.signals.length; i++) {
        const sg = World.signals[i];
        const dx = sg.x - cpx, dz = sg.z - cpz;
        if (dx * dx + dz * dz > 170 * 170) continue;
        const st = World.signalState(sg.i, sg.j, sg.axis, t);
        const col = st === 2 ? [.10, 1.0, .22] : st === 1 ? [1.0, .62, .06] : [1.0, .10, .07];
        const yOff = st === 2 ? -0.30 : st === 1 ? 0 : 0.30;
        M4.trs(sm, sg.x, sg.y + yOff, sg.z, 0, .22, .22, .22);
        this.signalBatch.push(sm, col[0], col[1], col[2], .3, 0, 3.4, M_EMISSIVE, 0);
      }
    }

    /* --- checkpoint gates --- */
    if (this.route.length) {
      for (let i = this.cpIndex; i < Math.min(this.cpIndex + 3, this.route.length); i++) {
        const c = this.route[i];
        const act = i === this.cpIndex;
        M4.trs(m, c.x, 0, c.z, 0, 1, 1, 1);
        const pulse = act ? (1.6 + Math.sin(this.time * 4) * .6) : .35;
        this.gateBatch.push(m, act ? .30 : .9, act ? 1.0 : .75, act ? 1.4 : .25, .3, 0, pulse * 2.2, M_EMISSIVE, 0);
      }
    }

    /* register */
    for (const k in B) if (B[k].n) sc.batches['p_' + k] = B[k];
    for (let i = 0; i < this.trafBatches.length; i++) {
      const tb = this.trafBatches[i];
      for (const k of ['paint', 'dark', 'lightF', 'lightR']) if (tb[k].n) sc.batches['t' + i + k] = tb[k];
      if (tb.glass.n) sc.glassBatches.push(tb.glass);
    }
    if (this.trafWheel.n) sc.batches.tw = this.trafWheel;
    if (this.gateBatch.n) sc.batches.gates = this.gateBatch;
    if (this.signalBatch.n) sc.batches.signals = this.signalBatch;
    if (this.carGlass.n) sc.glassBatches.push(this.carGlass);
  },

  pushWheels(p, bodyM, B) {
    const wm = M4.n(), out = M4.n();
    for (let i = 0; i < 4; i++) {
      const w = p.wheels[i];
      const left = (i % 2) === 0;
      const th = (left ? w.steer + PI : w.steer);
      const ph = left ? -w.spin : w.spin;
      const ct = Math.cos(th), st = Math.sin(th), cp2 = Math.cos(ph), sp2 = Math.sin(ph);
      wm[0] = ct; wm[1] = 0; wm[2] = -st; wm[3] = 0;
      wm[4] = st * sp2; wm[5] = cp2; wm[6] = ct * sp2; wm[7] = 0;
      wm[8] = st * cp2; wm[9] = -sp2; wm[10] = ct * cp2; wm[11] = 0;
      wm[12] = w.lp[0]; wm[13] = w.lp[1] - (w.rest - w.comp); wm[14] = w.lp[2]; wm[15] = 1;
      M4.mul(out, bodyM, wm);
      B.tire.push(out, .04, .042, .045, .82, 0, 0, M_TIRE, 0);
      B.rim.push(out, .72, .74, .78, .16, 1, 0, M_METAL, 0);
      B.disc.push(out, .30, .30, .32, .30, 1, 0, M_METAL, 0);
      B.caliper.push(out, .55, .06, .05, .35, .2, 0, M_PAINT, 0);
    }
  },

  pushTrafficWheels(t, info, baseY) {
    const y = (baseY || 0) + info.wheelR;
    const wm = M4.n();
    const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);
    const rxv = fz, rzv = -fx;
    const sp2 = Math.sin(t.wheelSpin || 0), cp2 = Math.cos(t.wheelSpin || 0);
    for (const az of [info.axleF, info.axleR]) {
      for (const s of [-1, 1]) {
        const x = t.x + fx * az + rxv * s * (info.width * .48);
        const z = t.z + fz * az + rzv * s * (info.width * .48);
        const th = t.yaw + (s < 0 ? PI : 0);
        const ph = s < 0 ? -(t.wheelSpin || 0) : (t.wheelSpin || 0);
        const ct = Math.cos(th), st = Math.sin(th), c2 = Math.cos(ph), s2 = Math.sin(ph);
        wm[0] = ct; wm[1] = 0; wm[2] = -st; wm[3] = 0;
        wm[4] = st * s2; wm[5] = c2; wm[6] = ct * s2; wm[7] = 0;
        wm[8] = st * c2; wm[9] = -s2; wm[10] = ct * c2; wm[11] = 0;
        wm[12] = x; wm[13] = y; wm[14] = z; wm[15] = 1;
        this.trafWheel.push(wm, .045, .047, .05, .82, 0, 0, M_TIRE, 0);
      }
    }
  },

  autoQuality(fps) {
    // this read settings.auto, which does not exist — the setting is autoq — so
    // adaptive quality silently never ran and the game could not climb out of a
    // bad frame rate on its own
    // a hidden tab runs on the watchdog at ~4fps; letting that count would
    // downgrade quality behind the player's back and the floor would keep it there
    if (document.hidden) { this._fpsHist = []; return; }
    if (!this.settings.autoq || this.state !== 'play' || this.countdown > 0) return;
    const now = this.time;
    if (now < (this._qCooldown || 0)) { this._fpsHist = []; return; }

    this._fpsHist = this._fpsHist || [];
    this._fpsHist.push(fps);
    if (this._fpsHist.length < 4) return;
    const avg = this._fpsHist.reduce((x, y) => x + y, 0) / this._fpsHist.length;
    this._fpsHist.length = 0;

    // wide dead band plus a cooldown: without them the two thresholds sat close
    // enough that one slow frame flipped the quality back and forth forever
    if (avg < 24 && R.q > 0) {
      R.setQuality(R.q - 1);
      this._qFloor = true;                 // never climb back past a downgrade
      this._qCooldown = now + 8;
      HUD.popup('GRAPHICS ↓ ' + QUALITY[R.q].name, '#8ba1bd');
      this.syncQualityUI();
    } else if (avg > 92 && R.q < 3 && !this._qFloor) {
      R.setQuality(R.q + 1);
      this._qCooldown = now + 12;
      this.syncQualityUI();
    }
  },

  syncQualityUI() {
    const el = $('qseg'); if (!el) return;
    el.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.v === R.q));
    this.settings.quality = R.q;
  },

  frame(dt) {
    this.update(dt);
    this.buildBatches();
    R.render(this.scene, dt);
    if (this.state === 'play' && !this.photo) { HUD.update(this); HUD.minimap(this); }
  }
};

/* ---------------- loop ----------------
   requestAnimationFrame drives the game normally; a watchdog interval keeps it
   ticking when rAF is throttled (background tab, non-compositing preview pane). */
let _last = performance.now(), _lastFrameAt = 0, _accWall = 0, _fpsN = 0;
let _running = true, _inStep = false;

function step() {
  // the watchdog and requestAnimationFrame can both land here; re-entering
  // would render the same frame twice and double the GPU load
  if (_inStep || !_running || GLX.lost) return;
  _inStep = true;
  const now = performance.now();
  let wall = now - _last;
  let dt = wall / 1000;
  _last = now; _lastFrameAt = now;
  if (dt > 0.05) dt = 0.05;
  if (dt <= 0) dt = 1 / 60;
  try {
    if (Game.state !== 'load') Game.frame(dt);
  } catch (e) { showErr(e.stack || e.message); }
  _fpsN++; _accWall += Math.min(wall, 1000);
  if (_accWall > 500) {
    const fps = _fpsN * 1000 / _accWall;
    _fpsN = 0; _accWall = 0;
    if (HUD.el.fps) HUD.el.fps.textContent =
      fps.toFixed(0) + ' fps  ·  ' + QUALITY[R.q].name + '  ·  ' + R.rw + '×' + R.rh +
      (GLX.safeMode ? '  ·  safe' : '');
    Game.autoQuality(fps);
  }
  _inStep = false;
}

function raf() { step(); if (_running) requestAnimationFrame(raf); }

Game.boot().then(() => {
  requestAnimationFrame(raf);
  // Only a cover for requestAnimationFrame being starved outright — a background
  // tab or a throttled preview. At 45ms it fired constantly on any machine below
  // 22fps and drove a second, un-vsynced render loop on top of rAF.
  setInterval(() => { if (_running && performance.now() - _lastFrameAt > 400) step(); }, 250);
  document.addEventListener('visibilitychange', () => {
    _last = performance.now(); _accWall = 0; _fpsN = 0;
    if (Game.state === 'play') Game._fpsHist = [];
  });
}).catch(e => {
  const l = $('load');
  if (l) {
    l.classList.remove('hidden');
    const m = $('loadmsg');
    if (m) { m.textContent = 'could not start — see the message below'; m.style.color = '#ffb2c0'; }
  }
  showErr('boot: ' + (e.stack || e.message));
});
