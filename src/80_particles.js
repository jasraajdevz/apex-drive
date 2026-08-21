'use strict';
/* ============================================================
   Apex Drive — particles, sprites, skid marks
   ============================================================ */

const P_SMOKE = 0, P_GLOW = 1, P_STREAK = 2, P_DOT = 3;

class Particles {
  constructor(cap = 2600) {
    this.cap = cap; this.n = 0;
    this.x = new Float32Array(cap); this.y = new Float32Array(cap); this.z = new Float32Array(cap);
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap); this.vz = new Float32Array(cap);
    this.s0 = new Float32Array(cap); this.s1 = new Float32Array(cap);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.r = new Float32Array(cap); this.g = new Float32Array(cap); this.b = new Float32Array(cap);
    this.a0 = new Float32Array(cap); this.kind = new Float32Array(cap);
    this.rot = new Float32Array(cap); this.rotV = new Float32Array(cap);
    this.drag = new Float32Array(cap); this.grav = new Float32Array(cap);
    this.stretch = new Float32Array(cap); this.seed = new Float32Array(cap);
    this.additive = new Uint8Array(cap);
    this.buf = new Float32Array(cap * INSTANCE_FLOATS);
    this.bufAdd = new Float32Array(cap * INSTANCE_FLOATS);
  }
  emit(o) {
    let i;
    if (this.n < this.cap) i = this.n++;
    else { // recycle the oldest-looking slot
      i = (Math.random() * this.cap) | 0;
    }
    this.x[i] = o.x; this.y[i] = o.y; this.z[i] = o.z;
    this.vx[i] = o.vx || 0; this.vy[i] = o.vy || 0; this.vz[i] = o.vz || 0;
    this.s0[i] = o.s0; this.s1[i] = o.s1 === undefined ? o.s0 : o.s1;
    this.life[i] = 0; this.max[i] = o.life;
    this.r[i] = o.r; this.g[i] = o.g; this.b[i] = o.b; this.a0[i] = o.a === undefined ? 1 : o.a;
    this.kind[i] = o.kind === undefined ? P_SMOKE : o.kind;
    this.rot[i] = o.rot || 0; this.rotV[i] = o.rotV || 0;
    this.drag[i] = o.drag === undefined ? 1.2 : o.drag;
    this.grav[i] = o.grav === undefined ? 0 : o.grav;
    this.stretch[i] = o.stretch || 0;
    this.seed[i] = Math.random() * 9;
    this.additive[i] = o.add ? 1 : 0;
    return i;
  }
  update(dt, wind) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.max[i]) {
        // swap-remove
        n--;
        if (i !== n) {
          this.x[i] = this.x[n]; this.y[i] = this.y[n]; this.z[i] = this.z[n];
          this.vx[i] = this.vx[n]; this.vy[i] = this.vy[n]; this.vz[i] = this.vz[n];
          this.s0[i] = this.s0[n]; this.s1[i] = this.s1[n];
          this.life[i] = this.life[n]; this.max[i] = this.max[n];
          this.r[i] = this.r[n]; this.g[i] = this.g[n]; this.b[i] = this.b[n];
          this.a0[i] = this.a0[n]; this.kind[i] = this.kind[n];
          this.rot[i] = this.rot[n]; this.rotV[i] = this.rotV[n];
          this.drag[i] = this.drag[n]; this.grav[i] = this.grav[n];
          this.stretch[i] = this.stretch[n]; this.seed[i] = this.seed[n];
          this.additive[i] = this.additive[n];
        }
        i--; continue;
      }
      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] = this.vx[i] * d + wind[0] * dt;
      this.vz[i] = this.vz[i] * d + wind[2] * dt;
      this.vy[i] = this.vy[i] * d + this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
      this.rot[i] += this.rotV[i] * dt;
      if (this.y[i] < 0.02 && this.grav[i] < 0) { this.y[i] = 0.02; this.vy[i] = 0; this.vx[i] *= .7; this.vz[i] *= .7; }
    }
    this.n = n;
  }
  /* fill instance buffers; returns [nNormal, nAdditive] */
  fill() {
    let na = 0, nb = 0;
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i] / this.max[i];
      const size = lerp(this.s0[i], this.s1[i], t);
      let a = this.a0[i];
      // fade in fast, out slow
      a *= smoothstep(0, 0.12, t) * (1 - smoothstep(0.45, 1, t));
      if (a <= 0.002) continue;
      const dst = this.additive[i] ? this.bufAdd : this.buf;
      const o = (this.additive[i] ? nb++ : na++) * INSTANCE_FLOATS;
      dst[o] = this.x[i]; dst[o + 1] = this.y[i]; dst[o + 2] = this.z[i]; dst[o + 3] = size;
      dst[o + 4] = this.rot[i]; dst[o + 5] = this.stretch[i]; dst[o + 6] = this.kind[i]; dst[o + 7] = this.seed[i];
      dst[o + 8] = this.vx[i]; dst[o + 9] = this.vy[i]; dst[o + 10] = this.vz[i]; dst[o + 11] = 0;
      dst[o + 12] = 0; dst[o + 13] = 0; dst[o + 14] = 0; dst[o + 15] = 0;
      dst[o + 16] = this.r[i]; dst[o + 17] = this.g[i]; dst[o + 18] = this.b[i]; dst[o + 19] = a;
      dst[o + 20] = size * 1.5; dst[o + 21] = 0; dst[o + 22] = 0; dst[o + 23] = 0;
    }
    return [na, nb];
  }
}

/* immediate-mode additive sprites (light halos, lens flares) */
class Sprites {
  constructor(cap = 900) {
    this.cap = cap; this.n = 0;
    this.buf = new Float32Array(cap * INSTANCE_FLOATS);
  }
  clear() { this.n = 0; }
  add(x, y, z, size, r, g, b, a, kind) {
    if (this.n >= this.cap) return;
    const o = this.n++ * INSTANCE_FLOATS, d = this.buf;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size;
    d[o + 4] = 0; d[o + 5] = 0; d[o + 6] = kind === undefined ? P_GLOW : kind; d[o + 7] = 0;
    d[o + 8] = 0; d[o + 9] = 0; d[o + 10] = 0; d[o + 11] = 0;
    d[o + 12] = 0; d[o + 13] = 0; d[o + 14] = 0; d[o + 15] = 0;
    d[o + 16] = r; d[o + 17] = g; d[o + 18] = b; d[o + 19] = a;
    d[o + 20] = size * 2.0; d[o + 21] = 0; d[o + 22] = 0; d[o + 23] = 0;
  }
}

/* ---------------- skid marks ---------------- */
class SkidTrails {
  constructor(maxQuads = 1400) {
    this.max = maxQuads;
    this.head = 0; this.count = 0;
    this.pos = new Float32Array(maxQuads * 4 * 3);
    this.uv = new Float32Array(maxQuads * 4 * 2);
    this.birth = new Float32Array(maxQuads);
    this.strength = new Float32Array(maxQuads);
    this.last = [];      // per-wheel last edge points
    this.dirty = true;
    this.life = 26;
  }
  initGL() {
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.bp = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bp);
    gl.bufferData(gl.ARRAY_BUFFER, this.pos.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(ATTR.POS); gl.vertexAttribPointer(ATTR.POS, 3, gl.FLOAT, false, 0, 0);
    this.bu = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bu);
    gl.bufferData(gl.ARRAY_BUFFER, this.uv.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(ATTR.UV); gl.vertexAttribPointer(ATTR.UV, 2, gl.FLOAT, false, 0, 0);
    const idx = new Uint32Array(this.max * 6);
    for (let i = 0; i < this.max; i++) {
      const v = i * 4, o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    this.ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }
  clear() { this.head = 0; this.count = 0; this.pos.fill(0); this.uv.fill(0); this.last.length = 0; this.dirty = true; }
  /* add a segment for wheel `id` between its previous and current contact */
  add(id, x, y, z, rx, rz, strength, now) {
    const prev = this.last[id];
    const hw = 0.16;
    const ax = x - rx * hw, az = z - rz * hw;
    const bx = x + rx * hw, bz = z + rz * hw;
    if (prev && prev.t > now - 0.35) {
      const d = Math.hypot(x - prev.x, z - prev.z);
      if (d > 0.10) {
        const i = this.head;
        const p = this.pos, u = this.uv;
        const o = i * 12, ou = i * 8;
        p[o] = prev.ax; p[o + 1] = prev.y + 0.012; p[o + 2] = prev.az;
        p[o + 3] = prev.bx; p[o + 4] = prev.y + 0.012; p[o + 5] = prev.bz;
        p[o + 6] = bx; p[o + 7] = y + 0.012; p[o + 8] = bz;
        p[o + 9] = ax; p[o + 10] = y + 0.012; p[o + 11] = az;
        const s0 = prev.s, s1 = strength;
        u[ou] = 0; u[ou + 1] = s0; u[ou + 2] = 1; u[ou + 3] = s0;
        u[ou + 4] = 1; u[ou + 5] = s1; u[ou + 6] = 0; u[ou + 7] = s1;
        this.birth[i] = now; this.strength[i] = Math.max(s0, s1);
        this.head = (this.head + 1) % this.max;
        this.count = Math.min(this.count + 1, this.max);
        this.dirty = true;
        this.last[id] = { x, y, z, ax, az, bx, bz, s: strength, t: now };
      }
      return;
    }
    this.last[id] = { x, y, z, ax, az, bx, bz, s: strength, t: now };
  }
  drop(id) { this.last[id] = null; }
  fade(now) {
    // age out old quads by zeroing their alpha
    const u = this.uv;
    for (let i = 0; i < this.max; i++) {
      if (this.birth[i] === 0) continue;
      const age = now - this.birth[i];
      if (age > this.life) {
        const ou = i * 8;
        u[ou + 1] = 0; u[ou + 3] = 0; u[ou + 5] = 0; u[ou + 7] = 0;
        this.birth[i] = 0; this.dirty = true;
      } else if (age > this.life - 6) {
        const f = (this.life - age) / 6;
        const ou = i * 8;
        const s = this.strength[i] * f;
        u[ou + 1] = s; u[ou + 3] = s; u[ou + 5] = s; u[ou + 7] = s;
        this.dirty = true;
      }
    }
  }
  upload() {
    if (!this.dirty) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bp);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.uv);
    this.dirty = false;
  }
  draw() {
    if (this.count === 0) return;
    this.upload();
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.max * 6, gl.UNSIGNED_INT, 0);
  }
}
