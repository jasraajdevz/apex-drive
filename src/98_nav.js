'use strict';
/* ============================================================
   Apex Drive — satnav: route finding + the line painted on the road
   ============================================================ */

const Nav = {
  path: [],            // world-space polyline
  nodes: [],           // grid nodes of the route
  dirty: false,
  vao: null, buf: null, count: 0, cap: 0,
  _lastKey: '',

  initGL() {
    this.cap = 4096;                       // vertices
    this.data = new Float32Array(this.cap * 5);   // xyz + u,v
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(ATTR.POS);
    gl.vertexAttribPointer(ATTR.POS, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(ATTR.UV);
    gl.vertexAttribPointer(ATTR.UV, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
  },

  clear() { this.path.length = 0; this.count = 0; this._lastKey = ''; },

  /* nearest grid intersection to a world point */
  nearestNode(x, z) {
    const N = World.N;
    return [clamp(Math.round((x + World.half) / World.CELL), 0, N),
    clamp(Math.round((z + World.half) / World.CELL), 0, N)];
  },

  /* breadth-first over the road grid — every edge is one block, so it is optimal */
  findPath(ai, aj, bi, bj) {
    const N = World.N, W = N + 1;
    const id = (i, j) => j * W + i;
    const prev = new Int32Array(W * W).fill(-1);
    const seen = new Uint8Array(W * W);
    const q = [id(ai, aj)];
    seen[q[0]] = 1;
    const goal = id(bi, bj);
    let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      if (cur === goal) break;
      const ci = cur % W, cj = (cur / W) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni > N || nj > N) continue;
        const nid = id(ni, nj);
        if (seen[nid]) continue;
        seen[nid] = 1; prev[nid] = cur; q.push(nid);
      }
    }
    if (!seen[goal]) return [];
    const out = [];
    for (let cur = goal; cur !== -1; cur = prev[cur]) {
      out.push([cur % W, (cur / W) | 0]);
      if (cur === id(ai, aj)) break;
    }
    return out.reverse();
  },

  /* recompute when the car has moved to a different intersection */
  update(car, waypoint) {
    if (!waypoint) { if (this.count) this.clear(); return; }
    const a = this.nearestNode(car.pos[0], car.pos[2]);
    const b = this.nearestNode(waypoint.x, waypoint.z);
    const key = a[0] + ',' + a[1] + '>' + b[0] + ',' + b[1];
    if (key === this._lastKey) return;
    this._lastKey = key;

    const nodes = this.findPath(a[0], a[1], b[0], b[1]);
    this.nodes = nodes;
    const pts = [];
    pts.push([car.pos[0], car.pos[2]]);
    // the nearest junction is often already behind the car; including it makes
    // the ribbon double back on itself
    const f = [0, 0, 0]; car.dirWorld(f, [0, 0, 1]);
    let start = 0;
    if (nodes.length > 1) {
      const nx = World.roadX(nodes[0][0]) - car.pos[0];
      const nz = World.roadX(nodes[0][1]) - car.pos[2];
      if (nx * f[0] + nz * f[2] < 0 && Math.hypot(nx, nz) < World.CELL * 0.85) start = 1;
    }
    for (let k = start; k < nodes.length; k++)
      pts.push([World.roadX(nodes[k][0]), World.roadX(nodes[k][1])]);
    pts.push([waypoint.x, waypoint.z]);
    this.path = pts;
    this.build(pts);
  },

  /* lay a ribbon of quads along the polyline, offset into the right-hand lane */
  build(pts) {
    if (pts.length < 2) { this.count = 0; return; }
    const HW = 0.9, LANE = 3.4, Y = 0.035;
    const d = this.data;
    let v = 0, run = 0;
    const push = (x, z, u, dist) => {
      if (v + 1 > this.cap) return;
      const o = v * 5;
      d[o] = x; d[o + 1] = Y; d[o + 2] = z; d[o + 3] = u; d[o + 4] = dist;
      v++;
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      let dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      dx /= len; dz /= len;
      const nx = -dz, nz = dx;                 // left normal
      const ox = dz * LANE, oz = -dx * LANE;   // shift into the right-hand lane
      const ax = x0 + ox, az = z0 + oz, bx = x1 + ox, bz = z1 + oz;
      const d0 = run, d1 = run + len;
      // two triangles
      push(ax - nx * HW, az - nz * HW, 0, d0);
      push(ax + nx * HW, az + nz * HW, 1, d0);
      push(bx + nx * HW, bz + nz * HW, 1, d1);
      push(ax - nx * HW, az - nz * HW, 0, d0);
      push(bx + nx * HW, bz + nz * HW, 1, d1);
      push(bx - nx * HW, bz - nz * HW, 0, d1);
      run = d1;
    }
    this.count = v;
    this.total = run;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, v * 5);
  },

  draw() {
    if (this.count < 3) return;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }
};
