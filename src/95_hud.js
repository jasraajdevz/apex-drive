'use strict';
/* ============================================================
   Apex Drive — HUD
   ============================================================ */
const $ = id => document.getElementById(id);

const HUD = {
  el: {}, mmCtx: null, arcLen: 0, boostLen: 0, _lastGear: null,

  init() {
    const e = this.el;
    ['hud', 'spdval', 'spdunit', 'gear', 'rpmArc', 'trackArc', 'redArc', 'boostArc', 'boostTrack',
      'ticks', 'minimap', 'bigmsg', 'submsg', 'popups', 'modename', 'objrows', 'driftbox',
      'driftval', 'driftmul', 'drifttime', 'boostval', 'nosfill', 'fps', 'touch',
      'shiftlights', 'hudcash', 'fuelfill', 'fuelpct', 'fuelbox', 'stationhint',
      'stname', 'stdist', 'skillbox', 'sklist', 'skchain', 'skmult', 'sktime',
      'radiochip', 'rcname', 'rcsub'].forEach(k => e[k] = $(k));
    this.mmCtx = e.minimap.getContext('2d');
    e.shiftlights.innerHTML = new Array(9).fill('<i></i>').join('');
    this.leds = [...e.shiftlights.querySelectorAll('i')];
    this.buildDial();
  },

  arcPath(cx, cy, r, a0, a1) {
    const p = a => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${(a1 - a0) > PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  },

  buildDial() {
    const A0 = PI * 0.70, A1 = PI * 2.30;
    this.A0 = A0; this.A1 = A1;
    const r = 120, rb = 104;
    const C = 150;
    this.el.trackArc.setAttribute('d', this.arcPath(C, C, r, A0, A1));
    this.el.rpmArc.setAttribute('d', this.arcPath(C, C, r, A0, A1));
    this.el.redArc.setAttribute('d', this.arcPath(C, C, r, A0 + (A1 - A0) * 0.86, A1));
    // boost gauge occupies the lower-left sweep
    const B0 = PI * 0.70, B1 = PI * 1.02;
    this.el.boostTrack.setAttribute('d', this.arcPath(C, C, rb, B0, B1));
    this.el.boostArc.setAttribute('d', this.arcPath(C, C, rb, B0, B1));
    this.arcLen = (A1 - A0) * r;
    this.boostLen = (B1 - B0) * rb;

    let s = '';
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, a = A0 + (A1 - A0) * t;
      const major = i % 2 === 0;
      const r0 = r - 16, r1 = r - (major ? 27 : 22);
      s += `<line class="${major ? 'tkm' : 'tk'}" x1="${(C + Math.cos(a) * r0).toFixed(1)}" y1="${(C + Math.sin(a) * r0).toFixed(1)}" x2="${(C + Math.cos(a) * r1).toFixed(1)}" y2="${(C + Math.sin(a) * r1).toFixed(1)}"/>`;
      if (major) {
        const rr = r - 41;
        s += `<text x="${(C + Math.cos(a) * rr).toFixed(1)}" y="${(C + 4 + Math.sin(a) * rr).toFixed(1)}">${i}</text>`;
      }
    }
    this.el.ticks.innerHTML = s;
  },

  update(g) {
    const car = g.player, e = this.el;
    const u = this.units(g);
    const spd = Math.abs(car.fwdSpeed) * u.mul;
    e.spdval.textContent = u.id === 'ms' ? spd.toFixed(1) : Math.round(spd);
    e.spdunit.textContent = u.label;

    const rev = clamp01(car.rpm / car.ph.redline);
    e.rpmArc.style.strokeDasharray = `${(this.arcLen * rev).toFixed(1)} 9999`;

    // gear
    const gtxt = car.gear === 0 ? 'R' : (car.clutchEngage < .4 && car.throttle < .02 && Math.abs(car.fwdSpeed) < 0.6 ? 'N' : car.gear);
    if (gtxt !== this._lastGear) { e.gear.textContent = gtxt; this._lastGear = gtxt; }
    e.gear.classList.toggle('shifting', car.shiftT > 0);

    // shift lights
    const n = this.leds.length;
    const start = 0.62;
    const f = clamp01((rev - start) / (1 - start));
    const lit = Math.round(f * n);
    const flash = car.onLimiter || (g.settings.manual && rev > 0.985);
    e.shiftlights.classList.toggle('flash', !!flash && (performance.now() % 120 < 60));
    for (let i = 0; i < n; i++) {
      const on = i < lit;
      this.leds[i].className = on ? (i < n * 0.45 ? 'on1' : i < n * 0.78 ? 'on2' : 'on3') : '';
    }

    // boost
    const psi = car.boostPsi || 0;
    const maxPsi = Math.max(car.maxBoostPsi || 0, 1);
    e.boostVal = e.boostVal || $('boostval');
    e.boostVal.textContent = psi.toFixed(1);
    e.boostArc.style.strokeDasharray = `${(this.boostLen * clamp01(psi / maxPsi)).toFixed(1)} 9999`;

    // nitrous
    e.nosfill.style.width = (car.ph.nosShot > 0 ? car.nos * 100 : 0).toFixed(0) + '%';
    e.nosfill.style.opacity = car.nosActive ? 1 : .6;

    e.hudcash.textContent = Math.round(Garage.cash).toLocaleString('en-US');
  },

  /* speed + distance in the unit the player picked */
  units(g) { return UNITS[clamp(g.settings.units | 0, 0, UNITS.length - 1)]; },

  fuel(frac, low) {
    this.el.fuelfill.style.width = (frac * 100).toFixed(0) + '%';
    this.el.fuelpct.textContent = Math.round(frac * 100) + '%';
    this.el.fuelbox.classList.toggle('low', low);
  },

  station(name, metres, u) {
    const el = this.el.stationhint;
    if (!name) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    this.el.stname.textContent = name;
    const d = metres / u.dist;
    this.el.stdist.textContent = (d < 0.1 ? Math.round(metres) + ' m' : d.toFixed(1) + ' ' + u.distLabel);
  },

  skill(label, pts, colour) {
    const d = document.createElement('div');
    d.className = 'sk-item';
    d.innerHTML = label + (pts ? ' <u>+' + pts + '</u>' : '');
    if (colour) d.style.color = colour;
    this.el.sklist.appendChild(d);
    while (this.el.sklist.children.length > 5) this.el.sklist.removeChild(this.el.sklist.firstChild);
    setTimeout(() => d.remove(), 1600);
  },

  chain(show, value, mult, frac) {
    this.el.skillbox.classList.toggle('hidden', !show);
    if (!show) return;
    this.el.skchain.textContent = Math.round(value).toLocaleString('en-US');
    this.el.skmult.textContent = 'x' + mult.toFixed(1);
    this.el.sktime.style.width = (frac * 100).toFixed(0) + '%';
  },

  radio(on, st) {
    this.el.radiochip.classList.toggle('hidden', !on);
    if (!on) return;
    this.el.rcname.textContent = st.name;
    this.el.rcsub.textContent = st.sub;
  },

  rows(list) {
    let s = '';
    for (const r of list) s += `<div class="r${r.warn ? ' warn' : ''}"><u>${r.k}</u><b>${r.v}</b></div>`;
    this.el.objrows.innerHTML = s;
  },

  big(msg, sub) {
    const b = this.el.bigmsg, s = this.el.submsg;
    b.textContent = msg || ''; s.textContent = sub || '';
    b.classList.remove('pop'); s.classList.remove('pop');
    void b.offsetWidth;
    if (msg) b.classList.add('pop');
    if (sub) s.classList.add('pop');
  },

  popup(text, col) {
    const d = document.createElement('div');
    d.className = 'pu'; d.textContent = text;
    if (col) d.style.color = col;
    this.el.popups.appendChild(d);
    setTimeout(() => d.remove(), 1350);
  },

  drift(show, val, mul, frac) {
    this.el.driftbox.classList.toggle('hidden', !show);
    if (!show) return;
    this.el.driftval.textContent = Math.round(val).toLocaleString('en-US');
    this.el.driftmul.textContent = 'x' + mul.toFixed(1);
    this.el.drifttime.style.width = (frac * 100).toFixed(0) + '%';
  },

  /* ---------------- minimap ---------------- */
  minimap(g) {
    const c = this.mmCtx, S = 280, half = S / 2;
    const car = g.player;
    const range = 210;
    const k = half / range;
    c.clearRect(0, 0, S, S);
    c.save();
    c.beginPath(); c.arc(half, half, half - 3, 0, TAU); c.clip();
    c.fillStyle = 'rgba(5,9,15,.78)'; c.fillRect(0, 0, S, S);

    c.translate(half, half);
    c.rotate(g.camYaw);
    const px = car.pos[0], pz = car.pos[2];

    const N = World.N, C = World.CELL, B = World.BLOCK, wh = World.half;
    c.fillStyle = 'rgba(150,180,210,.09)';
    const i0 = Math.max(0, Math.floor((px - range + wh) / C) - 1), i1 = Math.min(N - 1, Math.ceil((px + range + wh) / C));
    const j0 = Math.max(0, Math.floor((pz - range + wh) / C) - 1), j1 = Math.min(N - 1, Math.ceil((pz + range + wh) / C));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const bx = -wh + i * C + C * .5, bz = -wh + j * C + C * .5;
      c.fillRect((bx - px - B / 2) * k, (bz - pz - B / 2) * k, B * k, B * k);
    }
    c.strokeStyle = 'rgba(120,165,205,.34)'; c.lineWidth = World.ROAD * k;
    c.beginPath();
    for (let i = 0; i <= N; i++) {
      const rx = World.roadX(i);
      if (Math.abs(rx - px) > range + 20) continue;
      c.moveTo((rx - px) * k, (-wh - pz) * k); c.lineTo((rx - px) * k, (wh - pz) * k);
    }
    for (let j = 0; j <= N; j++) {
      const rz = World.roadX(j);
      if (Math.abs(rz - pz) > range + 20) continue;
      c.moveTo((-wh - px) * k, (rz - pz) * k); c.lineTo((wh - px) * k, (rz - pz) * k);
    }
    c.stroke();

    c.fillStyle = 'rgba(205,222,240,.6)';
    for (const t of Traffic.cars) {
      const dx = t.x - px, dz = t.z - pz;
      if (Math.abs(dx) > range || Math.abs(dz) > range) continue;
      c.fillRect(dx * k - 1.6, dz * k - 1.6, 3.2, 3.2);
    }

    if (Stations.list.length) {
      for (const st of Stations.list) {
        const dx = st.x - px, dz = st.z - pz;
        if (Math.abs(dx) > range || Math.abs(dz) > range) continue;
        c.beginPath(); c.arc(dx * k, dz * k, 4.5, 0, TAU);
        c.fillStyle = '#7cf37c'; c.shadowColor = '#7cf37c'; c.shadowBlur = 7; c.fill(); c.shadowBlur = 0;
      }
    }
    if (MapView.waypoint) {
      const dx = MapView.waypoint.x - px, dz = MapView.waypoint.z - pz;
      const cl = Math.hypot(dx, dz) * k > half - 12;
      const a = Math.atan2(dz, dx);
      const wx = cl ? Math.cos(a) * (half - 12) : dx * k;
      const wy = cl ? Math.sin(a) * (half - 12) : dz * k;
      c.beginPath(); c.arc(wx, wy, cl ? 4 : 5.5, 0, TAU);
      c.fillStyle = '#ffcf6b'; c.shadowColor = '#ffcf6b'; c.shadowBlur = 8; c.fill(); c.shadowBlur = 0;
    }
    if (g.route && g.route.length) {
      for (let i = g.cpIndex; i < Math.min(g.cpIndex + 3, g.route.length); i++) {
        const cpn = g.route[i];
        const dx = cpn.x - px, dz = cpn.z - pz;
        const active = i === g.cpIndex;
        c.beginPath();
        c.arc(clamp(dx * k, -half + 10, half - 10), clamp(dz * k, -half + 10, half - 10), active ? 6 : 3, 0, TAU);
        c.fillStyle = active ? '#22e3ff' : 'rgba(34,227,255,.35)';
        c.fill();
      }
    }
    c.restore();

    c.save();
    c.translate(half, half);
    c.beginPath();
    c.moveTo(0, -10); c.lineTo(7, 8); c.lineTo(0, 4.5); c.lineTo(-7, 8);
    c.closePath();
    c.fillStyle = '#fff'; c.shadowColor = '#22e3ff'; c.shadowBlur = 12; c.fill();
    c.restore();

    c.strokeStyle = 'rgba(150,190,225,.28)'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(half, half, half - 3, 0, TAU); c.stroke();
  }
};
