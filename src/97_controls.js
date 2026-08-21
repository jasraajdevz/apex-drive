'use strict';
/* ============================================================
   Apex Drive — input devices

   Detects how the player is likely to be playing, asks them to
   confirm, then wires the matching control set. Touch uses the
   layout every mobile racer settled on: steering on the left,
   pedals under the right thumb, everything multi-touch.
   ============================================================ */

const Controls = {
  KEY: 'apexdrive.input.v1',
  device: 'kbd',              // kbd | touch | pad
  scheme: 0,                  // 0 buttons · 1 wheel · 2 tilt
  autoGas: 0,
  tiltSens: 1, size: 1, haptic: 1,
  tiltZero: null, tiltRaw: 0,
  state: { steer: 0, gas: 0, brake: 0, hand: 0, nos: 0 },
  _touches: Object.create(null),
  _rects: [],
  _wheel: { id: null, x0: 0, angle: 0 },
  ready: false,

  /* ---------------- detection ---------------- */
  detect() {
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    const hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    const ua = navigator.userAgent || '';
    const mobileUA = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile|Silk|Kindle/i.test(ua);
    const bigTouch = hasTouch && navigator.maxTouchPoints > 1 && coarse;
    if (mobileUA || bigTouch) return 'touch';
    for (const p of (navigator.getGamepads ? navigator.getGamepads() : []))
      if (p && p.connected) return 'pad';
    return 'kbd';
  },

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) Object.assign(this, JSON.parse(raw));
    } catch (e) { }
    return this;
  },
  save() {
    try {
      localStorage.setItem(this.KEY, JSON.stringify({
        device: this.device, scheme: this.scheme, autoGas: this.autoGas,
        tiltSens: this.tiltSens, size: this.size, haptic: this.haptic, asked: 1
      }));
    } catch (e) { }
  },

  /* ---------------- first-run picker ---------------- */
  askIfNeeded(done) {
    this.load();
    const guess = this.detect();
    if (this.asked) { this.apply(); done(); return; }
    this.device = guess;
    if (guess === 'touch') this.scheme = 0;

    const pick = $('devpick');
    pick.classList.remove('hidden');
    $('devguess').textContent = guess === 'touch'
      ? 'Looks like a touchscreen — touch controls are selected.'
      : guess === 'pad' ? 'A gamepad is connected.'
        : 'Looks like a keyboard. Change it any time in Settings.';

    const cards = pick.querySelectorAll('.devcard');
    const mark = () => {
      cards.forEach(c => c.classList.toggle('on', c.dataset.dev === this.device));
      $('touchopts').classList.toggle('hidden', this.device !== 'touch');
    };
    cards.forEach(c => c.onclick = () => {
      this.device = c.dataset.dev; mark();
      if (typeof Audio2 !== 'undefined') { Audio2.start(); Audio2.ui('tick'); }
    });
    mark();

    const seg = (id, fn) => {
      const el = $(id); if (!el) return;
      el.querySelectorAll('button').forEach(b => b.onclick = () => {
        el.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on'); fn(+b.dataset.v);
      });
    };
    seg('steerseg', v => this.scheme = v);
    seg('autogasseg', v => this.autoGas = v);

    $('devgo').onclick = async () => {
      if (typeof Audio2 !== 'undefined') { Audio2.start(); Audio2.ui('ok'); }
      if (this.device === 'touch' && this.scheme === 2) await this.requestTilt();
      if (this.device === 'touch') this.goFullscreen();
      this.asked = 1; this.save(); this.apply();
      pick.classList.add('hidden');
      done();
    };
  },

  async requestTilt() {
    try {
      const D = window.DeviceOrientationEvent;
      if (D && typeof D.requestPermission === 'function') {
        const r = await D.requestPermission();
        if (r !== 'granted') { this.scheme = 0; return false; }
      }
    } catch (e) { this.scheme = 0; return false; }
    return true;
  },

  goFullscreen() {
    const el = document.documentElement;
    try {
      const fn = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fn) { const r = fn.call(el); if (r && r.catch) r.catch(() => { }); }
    } catch (e) { }
    try {
      if (screen.orientation && screen.orientation.lock) {
        const r = screen.orientation.lock('landscape');
        if (r && r.catch) r.catch(() => { });
      }
    } catch (e) { }
  },

  /* ---------------- wiring ---------------- */
  apply() {
    const t = $('touch');
    const on = this.device === 'touch';
    t.classList.toggle('hidden', !on);
    document.body.classList.toggle('touchmode', on);
    $('tleft').classList.toggle('hidden', !on || this.scheme !== 0);
    $('tright').classList.toggle('hidden', !on || this.scheme !== 0);
    $('twheel').classList.toggle('hidden', !on || this.scheme !== 1);
    $('tiltbar').classList.toggle('hidden', !on || this.scheme !== 2);
    $('tgas').classList.toggle('hidden', !on || !!this.autoGas);
    document.documentElement.style.setProperty('--tscale', this.size);
    this.updateShiftButtons();
    this.measure();
    this.syncUI();
    if (!this.ready) this.bind();
    this.ready = true;
  },

  updateShiftButtons() {
    const manual = typeof Game !== 'undefined' && Game.settings && Game.settings.manual;
    const on = this.device === 'touch' && manual;
    $('tup').classList.toggle('hidden', !on);
    $('tdown').classList.toggle('hidden', !on);
    this.measure();
  },

  syncUI() {
    const set = (id, v) => {
      const el = $(id); if (!el) return;
      el.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.v === v));
    };
    set('devseg', this.device === 'kbd' ? 0 : this.device === 'touch' ? 1 : 2);
    set('steerseg2', this.scheme);
    set('autogasseg2', this.autoGas);
    set('hapticseg', this.haptic);
    const ts = $('tiltsens'), tz = $('tsize');
    if (ts) { ts.value = Math.round(this.tiltSens * 100); $('tiltsenso').textContent = ts.value + '%'; }
    if (tz) { tz.value = Math.round(this.size * 100); $('tsizeo').textContent = tz.value + '%'; }
    const kh = $('keyhelp');
    if (kh) kh.innerHTML = this.helpHTML();
  },

  helpHTML() {
    if (this.device === 'touch') return '<b>Touch</b> · left thumb steers, right thumb is the throttle. E‑BRK swings the back out, NOS is the boost.';
    if (this.device === 'pad') return '<b>Gamepad</b> · RT throttle · LT brake · left stick steer · A handbrake · B nitrous · RB/LB shift · Y camera';
    return '<b>Keyboard</b> · W A S D or arrows · Space handbrake · Shift nitrous · E/Q shift · X clutch · C camera · R reset · T gearbox · P photo · Esc pause';
  },

  bindSettings() {
    const seg = (id, fn) => {
      const el = $(id); if (!el) return;
      el.querySelectorAll('button').forEach(b => b.onclick = () => {
        el.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on'); fn(+b.dataset.v);
        this.save(); this.apply();
        if (typeof Audio2 !== 'undefined') Audio2.ui('tick');
      });
    };
    seg('devseg', v => { this.device = ['kbd', 'touch', 'pad'][v]; if (this.device === 'touch') this.goFullscreen(); });
    seg('steerseg2', async v => { if (v === 2) { if (!await this.requestTilt()) return; } this.scheme = v; });
    seg('autogasseg2', v => this.autoGas = v);
    seg('hapticseg', v => this.haptic = v);
    const rng = (id, out, fn, fmt) => {
      const el = $(id), o = $(out); if (!el) return;
      el.oninput = () => { const v = +el.value; o.textContent = fmt(v); fn(v); this.save(); this.apply(); };
    };
    rng('tiltsens', 'tiltsenso', v => this.tiltSens = v / 100, v => v + '%');
    rng('tsize', 'tsizeo', v => this.size = v / 100, v => v + '%');
  },

  /* ---------------- touch plumbing ---------------- */
  measure() {
    this._rects = [];
    document.querySelectorAll('#touch .tc').forEach(el => {
      if (el.classList.contains('hidden') || !el.offsetParent) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2) return;
      this._rects.push({ el, id: el.dataset.ctl, r });
    });
    const w = $('twheel');
    if (w && !w.classList.contains('hidden')) this._wheelRect = w.getBoundingClientRect();
  },

  hit(x, y) {
    const pad = 14;
    let best = null, bd = 1e9;
    for (const z of this._rects) {
      const r = z.r;
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) {
        const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d < bd) { bd = d; best = z; }
      }
    }
    return best;
  },

  buzz(ms) { if (this.haptic && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { } } },

  press(id, down) {
    const s = this.state;
    if (id === 'left' || id === 'right') { /* handled by held set */ }
    if (!down) return;
    if (id === 'cam' && typeof Game !== 'undefined') Game.onKey('KeyC');
    else if (id === 'reset' && typeof Game !== 'undefined') Game.onKey('KeyR');
    else if (id === 'pause' && typeof Game !== 'undefined') Game.setPaused(!Game.paused);
    else if (id === 'up' && typeof Game !== 'undefined') Game.padShift(1);
    else if (id === 'down' && typeof Game !== 'undefined') Game.padShift(-1);
    if (id !== 'left' && id !== 'right') this.buzz(12);
  },

  bind() {
    const held = this._held = new Set();
    const active = this._touches;

    const refresh = () => {
      const s = this.state;
      const on = id => {
        for (const k in active) if (active[k] === id) return true;
        return false;
      };
      s.gas = this.autoGas ? 1 : (on('gas') ? 1 : 0);
      s.brake = on('brake') ? 1 : 0;
      s.hand = on('hand') ? 1 : 0;
      s.nos = on('nos') ? 1 : 0;
      if (this.scheme === 0) s.steer = (on('right') ? 1 : 0) - (on('left') ? 1 : 0);
      document.querySelectorAll('#touch .tc').forEach(el => el.classList.toggle('act', on(el.dataset.ctl)));
    };
    this._refresh = refresh;

    const start = e => {
      if (!this.isLive()) return;
      let used = false;
      for (const t of e.changedTouches) {
        // steering wheel drag
        if (this.scheme === 1 && this._wheelRect) {
          const r = this._wheelRect;
          if (t.clientX >= r.left - 30 && t.clientX <= r.right + 30 && t.clientY >= r.top - 30 && t.clientY <= r.bottom + 30) {
            this._wheel.id = t.identifier; this._wheel.x0 = t.clientX; used = true; continue;
          }
        }
        const z = this.hit(t.clientX, t.clientY);
        if (z) { active[t.identifier] = z.id; this.press(z.id, true); used = true; }
      }
      if (used) { refresh(); e.preventDefault(); }
    };
    const move = e => {
      if (!this.isLive()) return;
      let used = false;
      for (const t of e.changedTouches) {
        if (this.scheme === 1 && this._wheel.id === t.identifier) {
          const dx = t.clientX - this._wheel.x0;
          const rad = (this._wheelRect ? this._wheelRect.width : 160) * 0.62;
          this.state.steer = clamp(dx / rad, -1, 1);
          this._wheel.angle = this.state.steer * 100;
          const svg = $('twheelsvg');
          if (svg) svg.style.transform = 'rotate(' + this._wheel.angle.toFixed(1) + 'deg)';
          used = true; continue;
        }
        const prev = active[t.identifier];
        const z = this.hit(t.clientX, t.clientY);
        const nid = z ? z.id : null;
        if (nid !== prev) {
          if (prev) active[t.identifier] = undefined;
          if (nid) { active[t.identifier] = nid; this.press(nid, true); }
          else delete active[t.identifier];
          used = true;
        }
      }
      if (used) { refresh(); e.preventDefault(); }
    };
    const end = e => {
      for (const t of e.changedTouches) {
        if (this._wheel.id === t.identifier) {
          this._wheel.id = null; this.state.steer = 0;
          const svg = $('twheelsvg'); if (svg) svg.style.transform = 'rotate(0deg)';
        }
        delete active[t.identifier];
      }
      refresh();
    };

    document.addEventListener('touchstart', start, { passive: false });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end, { passive: false });
    document.addEventListener('touchcancel', end, { passive: false });

    // mouse fallback so the touch layout is testable on a desktop
    let mdown = null;
    document.addEventListener('mousedown', e => {
      if (this.device !== 'touch' || !this.isLive()) return;
      const z = this.hit(e.clientX, e.clientY);
      if (z) { mdown = z.id; active['m'] = z.id; this.press(z.id, true); refresh(); e.preventDefault(); }
    });
    document.addEventListener('mouseup', () => { if (mdown) { mdown = null; delete active['m']; refresh(); } });

    addEventListener('resize', () => setTimeout(() => this.measure(), 60));
    addEventListener('orientationchange', () => setTimeout(() => { this.measure(); this.checkOrientation(); }, 250));

    window.addEventListener('deviceorientation', e => {
      if (this.device !== 'touch' || this.scheme !== 2) return;
      const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      let v;
      if (ang === 90) v = -(e.beta || 0);
      else if (ang === -90 || ang === 270) v = (e.beta || 0);
      else v = (e.gamma || 0);
      if (this.tiltZero === null) this.tiltZero = v;
      this.tiltRaw = v;
      let d = (v - this.tiltZero) / 26 * this.tiltSens;
      if (Math.abs(d) < 0.06) d = 0; else d -= Math.sign(d) * 0.06;
      this.state.steer = clamp(d, -1, 1);
      const bar = $('tiltbar');
      if (bar && bar.firstElementChild)
        bar.firstElementChild.style.transform = 'translateX(' + (this.state.steer * 46).toFixed(1) + 'px)';
    });

    this.checkOrientation();
  },

  isLive() {
    return this.device === 'touch' && typeof Game !== 'undefined' &&
      Game.state === 'play' && !Game.paused && !Game.photo;
  },

  checkOrientation() {
    if (this.device !== 'touch') return;
    let el = $('rotatehint');
    const portrait = innerHeight > innerWidth * 1.05;
    if (!el) {
      el = document.createElement('div');
      el.id = 'rotatehint';
      el.innerHTML = '<div class="rot">📱</div><b>Rotate your device</b><u>Apex Drive plays in landscape</u>';
      document.body.appendChild(el);
    }
    el.classList.toggle('hidden', !portrait);
  },

  /* recentre tilt steering whenever a run starts */
  recalibrate() { this.tiltZero = null; }
};
