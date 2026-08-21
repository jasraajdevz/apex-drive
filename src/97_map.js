'use strict';
/* ============================================================
   Apex Drive — full-screen city map + waypoints
   ============================================================ */

const MapView = {
  open: false, cv: null, ctx: null,
  cx: 0, cz: 0, zoom: 0.35, minZoom: 0.12, maxZoom: 2.4,
  drag: false, moved: 0, lx: 0, ly: 0,
  waypoint: null,
  _blockAt: null,

  init() {
    this.cv = $('bigmap');
    this.ctx = this.cv.getContext('2d');
    $('mapbtn').onclick = () => { Audio2.ui('tick'); this.toggle(); };
    $('mapclose').onclick = () => this.close();
    $('mapgo').onclick = () => this.close();
    $('mapclear').onclick = () => { this.waypoint = null; Audio2.ui('tick'); this.draw(); };
    $('mapcentre').onclick = () => { this.centre(); Audio2.ui('tick'); this.draw(); };

    const cv = this.cv;
    const pt = e => {
      const r = cv.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return [t.clientX - r.left, t.clientY - r.top];
    };
    const down = e => {
      const [x, y] = pt(e);
      this.drag = true; this.moved = 0; this.lx = x; this.ly = y;
      e.preventDefault();
    };
    const move = e => {
      if (!this.drag) return;
      const [x, y] = pt(e);
      const dx = x - this.lx, dy = y - this.ly;
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.cx -= dx / this.zoom; this.cz -= dy / this.zoom;
      this.lx = x; this.ly = y;
      this.clampCentre(); this.draw();
      e.preventDefault();
    };
    const up = e => {
      if (this.drag && this.moved < 5) {
        const [x, y] = pt(e.changedTouches ? { touches: e.changedTouches } : e);
        this.setWaypointFromScreen(x, y);
      }
      this.drag = false;
    };
    cv.addEventListener('mousedown', down);
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
    cv.addEventListener('touchstart', down, { passive: false });
    cv.addEventListener('touchmove', move, { passive: false });
    cv.addEventListener('touchend', up);
    cv.addEventListener('wheel', e => {
      const [x, y] = pt(e);
      const before = this.screenToWorld(x, y);
      this.zoom = clamp(this.zoom * (e.deltaY < 0 ? 1.16 : 1 / 1.16), this.minZoom, this.maxZoom);
      const after = this.screenToWorld(x, y);
      this.cx += before[0] - after[0]; this.cz += before[1] - after[1];
      this.clampCentre(); this.draw();
      e.preventDefault();
    }, { passive: false });

    // pinch to zoom
    let pinch = 0;
    cv.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        this.drag = false;
      }
    }, { passive: false });
    cv.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && pinch) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        this.zoom = clamp(this.zoom * (d / pinch), this.minZoom, this.maxZoom);
        pinch = d; this.clampCentre(); this.draw();
        e.preventDefault();
      }
    }, { passive: false });

    this.buildBlockLookup();
  },

  /* block type per cell so the map can colour districts */
  buildBlockLookup() {
    const N = World.N;
    this._blockAt = new Array(N * N).fill('build');
    for (const b of World.blockInfo) {
      const i = Math.round((b.bx + World.half - World.CELL * .5) / World.CELL);
      const j = Math.round((b.bz + World.half - World.CELL * .5) / World.CELL);
      if (i >= 0 && j >= 0 && i < N && j < N) this._blockAt[j * N + i] = b.type;
    }
  },

  toggle() { this.open ? this.close() : this.show(); },

  show() {
    if (Game.state !== 'play') return;
    this.open = true;
    this.fit();
    this.centre();
    // open showing roughly 900 m across, like a satnav rather than a world map
    this.zoom = clamp(Math.min(this.cv.width, this.cv.height) / 900, this.minZoom, this.maxZoom);
    $('mapscreen').classList.remove('hidden');
    this.draw();
  },
  close() {
    this.open = false;
    $('mapscreen').classList.add('hidden');
  },

  fit() {
    const wrap = this.cv.parentElement;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.cv.width = Math.max(2, Math.round(wrap.clientWidth * dpr));
    this.cv.height = Math.max(2, Math.round(wrap.clientHeight * dpr));
    this.cv.style.width = wrap.clientWidth + 'px';
    this.cv.style.height = wrap.clientHeight + 'px';
    this.dpr = dpr;
    this.minZoom = Math.min(this.cv.width, this.cv.height) / (World.size * 1.5);
  },
  centre() {
    const p = Game.player;
    this.cx = p.pos[0]; this.cz = p.pos[2];
  },
  clampCentre() {
    const lim = World.half + 200;
    this.cx = clamp(this.cx, -lim, lim);
    this.cz = clamp(this.cz, -lim, lim);
  },

  worldToScreen(x, z) {
    return [(x - this.cx) * this.zoom + this.cv.width / 2,
    (z - this.cz) * this.zoom + this.cv.height / 2];
  },
  screenToWorld(sx, sy) {
    const d = this.dpr || 1;
    return [(sx * d - this.cv.width / 2) / this.zoom + this.cx,
    (sy * d - this.cv.height / 2) / this.zoom + this.cz];
  },

  setWaypointFromScreen(sx, sy) {
    const [x, z] = this.screenToWorld(sx, sy);
    const lim = World.half + 60;
    if (Math.abs(x) > lim || Math.abs(z) > lim) return;
    this.waypoint = { x, z };
    Audio2.ui('ok');
    Game.toast('Waypoint set', 'good');
    this.draw();
  },

  /* ---------------- drawing ---------------- */
  draw() {
    if (!this.open) return;
    const c = this.ctx, W = this.cv.width, H = this.cv.height, z = this.zoom;
    const N = World.N, C = World.CELL, B = World.BLOCK, half = World.half, R = World.ROAD;

    c.fillStyle = '#070b12'; c.fillRect(0, 0, W, H);

    // ground beyond the grid
    const g0 = this.worldToScreen(-half - 260, -half - 260);
    const g1 = this.worldToScreen(half + 260, half + 260);
    c.fillStyle = '#0b1410';
    c.fillRect(g0[0], g0[1], g1[0] - g0[0], g1[1] - g0[1]);

    // city footprint
    const c0 = this.worldToScreen(-half, -half), c1 = this.worldToScreen(half, half);
    c.fillStyle = '#0d131c';
    c.fillRect(c0[0], c0[1], c1[0] - c0[0], c1[1] - c0[1]);

    const TYPE_COL = {
      build: '#2a3a4d', low: '#2f3a44', park: '#24402c',
      lot: '#3a3320', plaza: '#3d2b3a'
    };

    // blocks, only the ones on screen
    const pad = 60;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const bx = -half + i * C + C * .5, bz = -half + j * C + C * .5;
        const p = this.worldToScreen(bx - B / 2, bz - B / 2);
        const s = B * z;
        if (p[0] + s < -pad || p[1] + s < -pad || p[0] > W + pad || p[1] > H + pad) continue;
        c.fillStyle = TYPE_COL[this._blockAt[j * N + i]] || TYPE_COL.build;
        c.fillRect(p[0], p[1], s, s);
      }
    }

    // roads
    c.strokeStyle = '#18222e';
    c.lineWidth = Math.max(1, R * z);
    c.beginPath();
    for (let i = 0; i <= N; i++) {
      const rx = World.roadX(i);
      const a = this.worldToScreen(rx, -half), b = this.worldToScreen(rx, half);
      if (a[0] < -pad || a[0] > W + pad) continue;
      c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
    }
    for (let j = 0; j <= N; j++) {
      const rz = World.roadX(j);
      const a = this.worldToScreen(-half, rz), b = this.worldToScreen(half, rz);
      if (a[1] < -pad || a[1] > H + pad) continue;
      c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
    }
    c.stroke();

    // centre lines on the wider roads when zoomed in
    if (z > 0.55) {
      c.strokeStyle = 'rgba(200,170,70,.28)';
      c.lineWidth = Math.max(0.7, z * 0.35);
      c.setLineDash([z * 6, z * 8]);
      c.beginPath();
      for (let i = 0; i <= N; i++) {
        const rx = World.roadX(i);
        const a = this.worldToScreen(rx, -half), b = this.worldToScreen(rx, half);
        if (a[0] < -pad || a[0] > W + pad) continue;
        c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
      }
      for (let j = 0; j <= N; j++) {
        const rz = World.roadX(j);
        const a = this.worldToScreen(-half, rz), b = this.worldToScreen(half, rz);
        if (a[1] < -pad || a[1] > H + pad) continue;
        c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
      }
      c.stroke();
      c.setLineDash([]);
    }

    // traffic
    if (z > 0.2) {
      c.fillStyle = 'rgba(190,210,232,.42)';
      const s = Math.max(1.5, z * 3);
      for (const t of Traffic.cars) {
        const p = this.worldToScreen(t.x, t.z);
        if (p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > H) continue;
        c.fillRect(p[0] - s / 2, p[1] - s / 2, s, s);
      }
    }

    // route
    if (Game.route && Game.route.length) {
      c.strokeStyle = 'rgba(255,61,104,.45)';
      c.lineWidth = 2 * this.dpr;
      c.setLineDash([6 * this.dpr, 6 * this.dpr]);
      c.beginPath();
      for (let i = Game.cpIndex; i < Game.route.length; i++) {
        const p = this.worldToScreen(Game.route[i].x, Game.route[i].z);
        i === Game.cpIndex ? c.moveTo(p[0], p[1]) : c.lineTo(p[0], p[1]);
      }
      c.stroke(); c.setLineDash([]);
      for (let i = Game.cpIndex; i < Game.route.length; i++) {
        const p = this.worldToScreen(Game.route[i].x, Game.route[i].z);
        const active = i === Game.cpIndex;
        c.beginPath(); c.arc(p[0], p[1], (active ? 8 : 5) * this.dpr, 0, TAU);
        c.fillStyle = active ? '#ff3d68' : 'rgba(255,61,104,.5)';
        c.fill();
        if (active) { c.strokeStyle = '#fff'; c.lineWidth = 2 * this.dpr; c.stroke(); }
      }
    }

    // waypoint
    if (this.waypoint) this.pin(c, this.worldToScreen(this.waypoint.x, this.waypoint.z), '#ffcf6b');

    // player
    const p = Game.player;
    const sp = this.worldToScreen(p.pos[0], p.pos[2]);
    const fwd = [0, 0, 0]; p.dirWorld(fwd, [0, 0, 1]);
    const yaw = Math.atan2(fwd[0], fwd[2]);
    c.save();
    c.translate(sp[0], sp[1]); c.rotate(-yaw);
    const k = 9 * this.dpr;
    c.beginPath();
    c.moveTo(0, -k); c.lineTo(k * .72, k * .82); c.lineTo(0, k * .42); c.lineTo(-k * .72, k * .82);
    c.closePath();
    c.fillStyle = '#22e3ff'; c.shadowColor = '#22e3ff'; c.shadowBlur = 14 * this.dpr;
    c.fill();
    c.restore();

    // scale bar
    const barM = z > 0.9 ? 50 : z > 0.35 ? 100 : 250;
    const barPx = barM * z;
    const bx0 = 18 * this.dpr, by0 = H - 20 * this.dpr;
    c.strokeStyle = 'rgba(220,235,250,.6)'; c.lineWidth = 1.5 * this.dpr;
    c.beginPath();
    c.moveTo(bx0, by0 - 5 * this.dpr); c.lineTo(bx0, by0); c.lineTo(bx0 + barPx, by0);
    c.lineTo(bx0 + barPx, by0 - 5 * this.dpr);
    c.stroke();
    c.fillStyle = 'rgba(220,235,250,.75)';
    c.font = (11 * this.dpr) + 'px Rajdhani, sans-serif';
    c.fillText(barM + ' m', bx0 + barPx + 7 * this.dpr, by0);
  },

  pin(c, p, col) {
    const d = this.dpr, r = 6 * d;
    c.beginPath();
    c.moveTo(p[0], p[1]);
    c.lineTo(p[0] - r, p[1] - r * 1.9);
    c.arc(p[0], p[1] - r * 2.3, r, PI * 0.82, PI * 0.18, true);
    c.closePath();
    c.fillStyle = col; c.shadowColor = col; c.shadowBlur = 10 * d; c.fill();
    c.shadowBlur = 0;
    c.beginPath(); c.arc(p[0], p[1] - r * 2.3, r * .42, 0, TAU);
    c.fillStyle = '#0a0f16'; c.fill();
  },

  /* distance + bearing to the waypoint for the HUD */
  guidance() {
    if (!this.waypoint) return null;
    const p = Game.player;
    const dx = this.waypoint.x - p.pos[0], dz = this.waypoint.z - p.pos[2];
    const dist = Math.hypot(dx, dz);
    if (dist < 14) { this.waypoint = null; Game.toast('Waypoint reached', 'good'); Audio2.checkpoint(); return null; }
    return { dist, bearing: Math.atan2(dx, dz) };
  }
};
