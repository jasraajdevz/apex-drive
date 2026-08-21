'use strict';
/* ============================================================
   Apex Drive — render pipeline
   shadow -> prepass -> SSAO -> opaque -> sky -> glass ->
   decals -> particles -> bloom -> tonemap -> FXAA
   ============================================================ */

const QUALITY = [
  { name: 'Low', shadow: 1024, soft: 0, ssao: 0, lights: 6, bloomMips: 4, scale: 0.78, fxaa: 1, drawDist: 260 },
  { name: 'Medium', shadow: 1536, soft: 1, ssao: 0, lights: 10, bloomMips: 5, scale: 0.92, fxaa: 1, drawDist: 340 },
  { name: 'High', shadow: 2048, soft: 1, ssao: 1, lights: 16, bloomMips: 6, scale: 1.0, fxaa: 1, drawDist: 430 },
  { name: 'Ultra', shadow: 3072, soft: 1, ssao: 1, lights: 24, bloomMips: 6, scale: 1.0, fxaa: 1, drawDist: 560 },
];

const R = {
  canvas: null, W: 1, H: 1, rw: 1, rh: 1, scale: 1, q: 2, userScale: 1,
  progs: {}, fbo: {}, meshes: {}, env: null, envSize: 128, envMips: 7,
  sky: {}, tod: 0.43, weather: 0, cloud: 0.25, wet: 0,
  cam: { pos: [0, 3, -8], target: [0, 1, 0], up: [0, 1, 0], fov: 74, near: 0.28, far: 3600 },
  view: M4.n(), proj: M4.n(), vp: M4.n(), invVP: M4.n(),
  planes: new Float32Array(24),
  csm: [M4.n(), M4.n(), M4.n()], csmSplit: [24, 78, 240],
  time: 0, exposure: 1.0, flash: 0, speedBlur: 0, ssrEnabled: true,
  lights: { pos: null, col: null, dir: null, n: 0 },
  stats: { draws: 0, tris: 0, chunks: 0 },

  init(canvas) {
    this.canvas = canvas;
    initGL(canvas);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);
    this.buildMeshes();
    this.buildPrograms();
    this.makeEnv();
    this.resize(true);
  },

  buildMeshes() {
    this.meshes.box = buildMesh(geoBox(1, 1, 1).done());
    this.meshes.cyl = buildMesh(geoCyl(0.5, 0.5, 1, 20, true).done());
    this.meshes.sph = buildMesh(geoSphere(0.5, 18, 12).done());
    this.meshes.cone = buildMesh(geoCone(0.5, 1, 16).done());
    const q = new Geo();
    q.v(-.5, -.5, 0, 0, 0, 1, 0, 0); q.v(.5, -.5, 0, 0, 0, 1, 1, 0);
    q.v(.5, .5, 0, 0, 0, 1, 1, 1); q.v(-.5, .5, 0, 0, 0, 1, 0, 1);
    q.quad(0, 1, 2, 3);
    this.meshes.quad = buildMesh(q.done());
  },

  buildPrograms() {
    const L = QUALITY[this.q].lights;
    const def = { LIGHT_COUNT: L };
    if (QUALITY[this.q].soft) def.SOFT_SHADOW = 1;
    this.progs.main = makeProgram('main', SH.mainVS, SH.mainFS, def);
    this.progs.pre = makeProgram('pre', SH.preVS, SH.preFS, {});
    this.progs.shadow = makeProgram('shadow', SH.shadowVS, SH.shadowFS, {});
    this.progs.ssao = makeProgram('ssao', SH.fsVS, SH.ssaoFS, {});
    this.progs.blur = makeProgram('blur', SH.fsVS, SH.blurFS, {});
    this.progs.sky = makeProgram('sky', SH.skyVS, SH.skyFS, {});
    this.progs.envc = makeProgram('envc', SH.fsVS, SH.envFS, {});
    this.progs.bpre = makeProgram('bpre', SH.fsVS, SH.bloomPreFS, {});
    this.progs.bdown = makeProgram('bdown', SH.fsVS, SH.bloomDownFS, {});
    this.progs.bup = makeProgram('bup', SH.fsVS, SH.bloomUpFS, {});
    this.progs.comp = makeProgram('comp', SH.fsVS, SH.compositeFS, {});
    this.progs.fxaa = makeProgram('fxaa', SH.fsVS, SH.fxaaFS, {});
    this.progs.part = makeProgram('part', SH.partVS, SH.partFS, {});
    this.progs.skid = makeProgram('skid', SH.skidVS, SH.skidFS, {});
    this.progs.glass = makeProgram('glass', SH.glassVS, SH.glassFS, {});
    this.progs.ssr = makeProgram('ssr', SH.fsVS, SH.ssrFS, {});
    this.progs.blit = makeProgram('blit', SH.fsVS, SH.blitFS, {});
    this.progs.shaft = makeProgram('shaft', SH.fsVS, SH.shaftFS, {});
    this.lights.pos = new Float32Array(L * 4);
    this.lights.col = new Float32Array(L * 4);
    this.lights.dir = new Float32Array(L * 4);
    this.maxLights = L;
  },

  setQuality(q) {
    if (q === this.q) return;
    this.q = clamp(q | 0, 0, 3);
    this.buildPrograms();
    this.makeShadow();
    this.resize(true);
  },

  makeShadow() {
    const s = QUALITY[this.q].shadow;
    if (this.shadowFBO && this.shadowFBO.w === s * 3) return;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, s * 3, s, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, t, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('shadow atlas incomplete');
    this.shadowFBO = { fb, w: s * 3, h: s, cell: s, tex: { tex: t, target: gl.TEXTURE_2D } };
  },

  makeEnv() {
    const s = this.envSize;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
    this.envMips = Math.log2(s) | 0;
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, this.envMips + 1, gl.RGBA16F, s, s);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.env = { tex: t, target: gl.TEXTURE_CUBE_MAP };
    this.envFB = gl.createFramebuffer();
  },

  resize(force) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const H = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const sc = QUALITY[this.q].scale * this.userScale;
    const rw = Math.max(160, Math.round(W * sc)), rh = Math.max(120, Math.round(H * sc));
    if (!force && rw === this.rw && rh === this.rh && W === this.W) return;
    this.W = W; this.H = H; this.rw = rw; this.rh = rh;
    this.canvas.width = W; this.canvas.height = H;
    this.makeShadow();

    const F = gl.RGBA16F, FMT = gl.RGBA, T = gl.HALF_FLOAT;
    this.fbo.pre = makeFBO(rw, rh, { color: [{ internal: F, format: FMT, type: T, filter: gl.NEAREST }], depth: 'tex' });
    this.fbo.scene = makeFBO(rw, rh, { color: [{ internal: F, format: FMT, type: T, filter: gl.LINEAR }], depthTex: this.fbo.pre.depth });
    const aw = Math.max(64, rw >> 1), ah = Math.max(64, rh >> 1);
    this.fbo.ao = makeFBO(aw, ah, { color: [{ internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR }] });
    this.fbo.ao2 = makeFBO(aw, ah, { color: [{ internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR }] });
    this.fbo.shaft = makeFBO(Math.max(64, aw >> 1), Math.max(64, ah >> 1), { color: [{ internal: F, format: FMT, type: T, filter: gl.LINEAR }] });
    this.fbo.ssr = makeFBO(aw, ah, { color: [{ internal: F, format: FMT, type: T, filter: gl.LINEAR }] });
    this.fbo.preHalf = makeFBO(aw, ah, { color: [{ internal: F, format: FMT, type: T, filter: gl.NEAREST }] });
    this.fbo.ldr = makeFBO(W, H, { color: [{ internal: gl.RGBA8, format: FMT, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR }] });
    this.bloom = [];
    let bw = rw >> 1, bh = rh >> 1;
    for (let i = 0; i < QUALITY[this.q].bloomMips; i++) {
      if (bw < 4 || bh < 4) break;
      this.bloom.push(makeFBO(bw, bh, { color: [{ internal: F, format: FMT, type: T, filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE }] }));
      bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1);
    }
    this.aoWhite = this.aoWhite || (() => {
      const t = texEmpty(1, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
      return t;
    })();
  },

  /* ---------------- atmosphere ---------------- */
  updateSky(tod, weather, dt) {
    this.tod = tod;
    const a = (tod - 0.25) * TAU;
    const sd = [Math.cos(a), Math.sin(a), 0.34];
    V3.norm(sd, sd);
    const el = sd[1];
    const night = smoothstep(0.045, -0.10, el);
    const dusk = Math.max(0, 1 - Math.abs(el) / 0.30) * (1 - night * 0.6);

    // sun colour: warm and dim near the horizon
    const warm = clamp01(1 - clamp01((el + 0.02) / 0.42));
    const sunI = lerp(0.22, 1.22, clamp01((el + 0.06) / 0.36)) * (1 - night * 0.94);
    const sunCol = [
      lerp(4.6, 6.4, 1 - warm) * sunI,
      lerp(2.2, 6.0, 1 - warm) * sunI,
      lerp(0.80, 5.6, 1 - warm) * sunI
    ];
    // overcast dims and neutralises the sun
    const cloudy = weather === 1 ? 0.62 : weather === 2 ? 0.80 : 0.0;
    for (let i = 0; i < 3; i++) sunCol[i] *= 1 - cloudy * 0.72;

    const zenD = [0.09, 0.20, 0.46], zenN = [0.012, 0.020, 0.048];
    const horD = [0.55, 0.66, 0.86], horN = [0.030, 0.040, 0.080];
    const horDusk = [1.05, 0.46, 0.24];
    const zen = [0, 0, 0], hor = [0, 0, 0], grd = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      zen[i] = lerp(zenD[i], zenN[i], night);
      hor[i] = lerp(lerp(horD[i], horDusk[i], dusk * 0.85), horN[i], night);
      grd[i] = lerp(0.055, 0.012, night) * [1, 1.02, 1.1][i];
    }
    if (cloudy > 0) {
      const g = [0.28, 0.30, 0.34];
      for (let i = 0; i < 3; i++) {
        zen[i] = lerp(zen[i], g[i] * (1 - night * 0.92), cloudy);
        hor[i] = lerp(hor[i], g[i] * 1.25 * (1 - night * 0.92), cloudy);
      }
    }

    this.sky = {
      dir: sd, col: sunCol, zen, hor, grd, night,
      cloud: weather === 0 ? 0.16 : weather === 1 ? 0.62 : 0.86,
      ambSky: [lerp(0.30, 0.014, night), lerp(0.38, 0.020, night), lerp(0.55, 0.046, night)],
      ambGrd: [lerp(0.075, 0.006, night), lerp(0.074, 0.007, night), lerp(0.070, 0.012, night)],
      ambStrength: lerp(1.0, 0.50, night) * lerp(1, 0.92, cloudy),
      windowLit: lerp(0.012, 0.34, night),
      shadowStrength: lerp(1.0, 0.34, night) * (1 - cloudy * 0.72),
      fogDensity: lerp(0.00110, 0.0026, cloudy) + (weather === 2 ? 0.0020 : 0) + night * 0.0007,
      fogHeight: 55,
    };
    this.wet = damp(this.wet, weather === 2 ? 1 : 0, 0.25, dt || 0.016);
    this.exposure = lerp(1.02, 2.10, night) * lerp(1, 1.20, cloudy);
    this.shaftAmount = clamp01(el * 2.2) * (1 - cloudy * 0.55) * (1 - night) * 0.55 * (1 + warm * 1.4);
    const key = Math.round(tod * 2000) + weather * 7919;
    if (key !== this._skyKey) { this._skyKey = key; this.envDirty = true; }
  },

  setSkyUniforms(p) {
    const s = this.sky;
    p.v3a('uSunDir', s.dir).v3a('uSunColor', s.col)
      .v3a('uSkyZenith', s.zen).v3a('uSkyHorizon', s.hor).v3a('uSkyGround', s.grd)
      .f('uNight', s.night).f('uCloud', s.cloud).f('uTime', this.time).f('uWet', this.wet);
  },

  renderEnv() {
    if (!this.envDirty) return;
    this.envDirty = false;
    const s = this.envSize;
    const faces = [
      [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
      [[-1, 0, 0], [0, 0, 1], [0, -1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
      [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
      [[0, 0, -1], [-1, 0, 0], [0, -1, 0]],
    ];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.envFB);
    gl.viewport(0, 0, s, s);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
    const p = this.progs.envc.use();
    this.setSkyUniforms(p);
    for (let i = 0; i < 6; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, this.env.tex, 0);
      p.v3a('uFaceF', faces[i][0]).v3a('uFaceR', faces[i][1]).v3a('uFaceU', faces[i][2]);
      drawFullscreen();
    }
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.env.tex);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  },

  /* ---------------- camera / cascades ---------------- */
  setCamera() {
    const c = this.cam;
    M4.lookAt(this.view, c.pos, c.target, c.up);
    M4.perspective(this.proj, c.fov * DEG, this.rw / this.rh, c.near, c.far);
    M4.mul(this.vp, this.proj, this.view);
    M4.invert(this.invVP, this.vp);
    extractPlanes(this.planes, this.vp);
  },

  buildCascades() {
    const c = this.cam, sd = this.sky.dir;
    const dd = QUALITY[this.q].drawDist;
    this.csmSplit = [Math.min(26, dd * 0.10), Math.min(85, dd * 0.30), Math.min(300, dd * 0.78)];
    const near = c.near;
    const fwd = [0, 0, 0]; V3.sub(fwd, c.target, c.pos); V3.norm(fwd, fwd);
    const right = [0, 0, 0]; V3.cross(right, fwd, [0, 1, 0]); V3.norm(right, right);
    const upv = [0, 0, 0]; V3.cross(upv, right, fwd);
    const aspect = this.rw / this.rh;
    const tanY = Math.tan(c.fov * DEG * 0.5), tanX = tanY * aspect;
    let prev = near;
    this.csmSphere = this.csmSphere || [{}, {}, {}];
    for (let i = 0; i < 3; i++) {
      const far = this.csmSplit[i];
      // frustum slice centre & radius
      const cx = [0, 0, 0];
      const mid = (prev + far) * 0.5;
      const extra = (tanY * tanY + tanX * tanX) * (far * far + prev * prev) / (2 * (far - prev) + 1e-4);
      let dist = mid + extra * 0.5;
      dist = clamp(dist, prev, far * 1.6);
      V3.addScaled(cx, c.pos, fwd, (prev + far) * 0.5);
      let radius = 0;
      for (const sz of [prev, far]) for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const px = c.pos[0] + fwd[0] * sz + right[0] * sx * tanX * sz + upv[0] * sy * tanY * sz;
        const py = c.pos[1] + fwd[1] * sz + right[1] * sx * tanX * sz + upv[1] * sy * tanY * sz;
        const pz = c.pos[2] + fwd[2] * sz + right[2] * sx * tanX * sz + upv[2] * sy * tanY * sz;
        const d = Math.hypot(px - cx[0], py - cx[1], pz - cx[2]);
        if (d > radius) radius = d;
      }
      radius = Math.ceil(radius * 1.02);
      const texel = (radius * 2) / this.shadowFBO.cell;
      cx[0] = Math.round(cx[0] / texel) * texel;
      cx[1] = Math.round(cx[1] / texel) * texel;
      cx[2] = Math.round(cx[2] / texel) * texel;
      const back = radius + 220;
      const eye = [cx[0] + sd[0] * back, cx[1] + sd[1] * back, cx[2] + sd[2] * back];
      const up = Math.abs(sd[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
      const lv = M4.lookAt(M4.n(), eye, cx, up);
      const lp = M4.ortho(M4.n(), -radius, radius, -radius, radius, 1, back + radius + 240);
      M4.mul(this.csm[i], lp, lv);
      this.csmSphere[i] = { x: cx[0], y: cx[1], z: cx[2], r: radius + 140 };
      prev = far;
    }
  },

  /* ---------------- lights ---------------- */
  gatherLights(scene) {
    const max = this.maxLights;
    const cand = [];
    const cp = this.cam.pos;
    const night = this.sky.night;
    if (night > 0.03) {
      const wl = World.lights;
      for (let i = 0; i < wl.length; i++) {
        const l = wl[i];
        const d2 = (l.p[0] - cp[0]) ** 2 + (l.p[1] - cp[1]) ** 2 + (l.p[2] - cp[2]) ** 2;
        if (d2 > (l.rad + 55) * (l.rad + 55)) continue;
        cand.push({ d2, p: l.p, c: l.col, r: l.rad, i: (l.kind === 'street' ? 330 : l.kind === 'sign' ? 90 : 26) * night, dir: null });
      }
    }
    for (const dl of scene.dynLights) {
      const d2 = (dl.p[0] - cp[0]) ** 2 + (dl.p[1] - cp[1]) ** 2 + (dl.p[2] - cp[2]) ** 2;
      cand.push({ d2: d2 * (dl.prio || 0.02), p: dl.p, c: dl.c, r: dl.r, i: dl.i, dir: dl.dir, inner: dl.inner, outer: dl.outer });
    }
    cand.sort((a, b) => a.d2 - b.d2);
    const n = Math.min(cand.length, max);
    for (let i = 0; i < n; i++) {
      const l = cand[i], o = i * 4;
      this.lights.pos[o] = l.p[0]; this.lights.pos[o + 1] = l.p[1]; this.lights.pos[o + 2] = l.p[2]; this.lights.pos[o + 3] = l.r;
      this.lights.col[o] = l.c[0] * l.i; this.lights.col[o + 1] = l.c[1] * l.i; this.lights.col[o + 2] = l.c[2] * l.i;
      this.lights.col[o + 3] = l.inner === undefined ? 1 : l.inner;
      if (l.dir) {
        this.lights.dir[o] = l.dir[0]; this.lights.dir[o + 1] = l.dir[1]; this.lights.dir[o + 2] = l.dir[2];
        this.lights.dir[o + 3] = l.outer;
      } else {
        this.lights.dir[o] = 0; this.lights.dir[o + 1] = -1; this.lights.dir[o + 2] = 0; this.lights.dir[o + 3] = -2;
      }
    }
    this.lights.n = n;
  },

  /* ---------------- geometry submission ---------------- */
  drawWorld(prog, cullSphere, isShadow) {
    let drawn = 0;
    const pl = this.planes;
    for (const ch of World.chunks) {
      if (!ch.batches) continue;
      if (cullSphere) {
        const dx = Math.max(0, Math.abs(cullSphere.x - ch.cxm) - ch.ex);
        const dz = Math.max(0, Math.abs(cullSphere.z - ch.czm) - ch.ez);
        if (dx * dx + dz * dz > cullSphere.r * cullSphere.r) continue;
      } else {
        if (!aabbInFrustum(pl, ch.cxm, ch.cym, ch.czm, ch.ex, ch.ey, ch.ez)) continue;
      }
      for (const b of ch.batches) { b.draw(); drawn++; }
    }
    this.stats.chunks = drawn;
    return drawn;
  },

  drawActors(batches) {
    for (const k in batches) { const b = batches[k]; if (b.n) b.draw(); }
  },

  /* ---------------- main frame ---------------- */
  render(scene, dt) {
    this.time += dt;
    this.setCamera();
    this.renderEnv();
    this.buildCascades();
    this.gatherLights(scene);

    const Q = QUALITY[this.q];

    /* ---- 1. shadow atlas ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO.fb);
    gl.viewport(0, 0, this.shadowFBO.w, this.shadowFBO.h);
    gl.clearDepth(1); gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.6, 3.0);
    const sp = this.progs.shadow.use();
    gl.cullFace(gl.FRONT);
    for (let i = 0; i < 3; i++) {
      gl.viewport(i * this.shadowFBO.cell, 0, this.shadowFBO.cell, this.shadowFBO.cell);
      sp.m4('uVP', this.csm[i]);
      this.drawWorld(sp, this.csmSphere[i], true);
      this.drawActors(scene.batches);
    }
    gl.cullFace(gl.BACK);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    /* ---- 2. depth + normal prepass ---- */
    bindFBO(this.fbo.pre, [0, 0, -1, 0]);
    gl.depthMask(true); gl.depthFunc(gl.LESS);
    gl.clearColor(0, 0, -1, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const pp = this.progs.pre.use();
    pp.m4('uVP', this.vp).m4('uView', this.view);
    this.drawWorld(pp, null, false);
    this.drawActors(scene.batches);

    /* ---- 3. SSAO ---- */
    let aoTex = this.aoWhite;
    if (Q.ssao) {
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
      bindFBO(this.fbo.ao);
      const ap = this.progs.ssao.use();
      ap.tex('uND', this.fbo.pre.tex, 0).v2('uRes', this.fbo.ao.w, this.fbo.ao.h)
        .m4('uProj', this.proj).f('uRadius', 1.15).f('uIntensity', 0.85).f('uBias', 0.030).f('uTime', this.time);
      drawFullscreen();
      const bp = this.progs.blur.use();
      bindFBO(this.fbo.ao2);
      bp.tex('uTex', this.fbo.ao.tex, 0).tex('uND', this.fbo.pre.tex, 1)
        .v2('uDir', 1, 0).v2('uRes', this.fbo.ao.w, this.fbo.ao.h);
      drawFullscreen();
      bindFBO(this.fbo.ao);
      bp.tex('uTex', this.fbo.ao2.tex, 0).tex('uND', this.fbo.pre.tex, 1).v2('uDir', 0, 1);
      drawFullscreen();
      aoTex = this.fbo.ao.tex;
      gl.enable(gl.DEPTH_TEST);
    }

    /* ---- 4. opaque ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.scene.fb);
    gl.viewport(0, 0, this.rw, this.rh);
    gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const mp = this.progs.main.use();
    this.setSkyUniforms(mp);
    mp.m4('uVP', this.vp).v3a('uCamPos', this.cam.pos).v2('uRes', this.rw, this.rh)
      .tex('uShadow', this.shadowFBO.tex, 0)
      .tex('uEnv', this.env, 1)
      .tex('uAO', aoTex, 2)
      .f('uEnvMips', this.envMips)
      .f('uAOEnabled', Q.ssao ? 1 : 0)
      .f('uShadowTexel', 1 / this.shadowFBO.cell)
      .f('uShadowStrength', this.sky.shadowStrength)
      .v3a('uAmbSky', this.sky.ambSky).v3a('uAmbGround', this.sky.ambGrd)
      .f('uAmbStrength', this.sky.ambStrength)
      .f('uFogDensity', this.sky.fogDensity).f('uFogHeight', this.sky.fogHeight)
      .f('uWindowLit', this.sky.windowLit)
      .v3('uCsmSplit', this.csmSplit[0], this.csmSplit[1], this.csmSplit[2])
      .i('uLCount', this.lights.n)
      .v4v('uLPos', this.lights.pos).v4v('uLCol', this.lights.col).v4v('uLDir', this.lights.dir);
    if (mp.U['uCsmMat']) gl.uniformMatrix4fv(mp.U['uCsmMat'], false, this._csmFlat());
    this.drawWorld(mp, null, false);
    this.drawActors(scene.batches);

    /* ---- 5. sky fills the untouched pixels ---- */
    gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
    const skp = this.progs.sky.use();
    this.setSkyUniforms(skp);
    skp.m4('uInvVP', this.invVP).v3a('uCamPos', this.cam.pos);
    gl.disable(gl.CULL_FACE);
    this._drawSkyQuad();
    gl.enable(gl.CULL_FACE);

    /* ---- 5b. screen-space reflections on standing water ---- */
    if (this.ssrEnabled && this.wet > 0.02 && QUALITY[this.q].ssao) {
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
      bindFBO(this.fbo.ssr);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const rp = this.progs.ssr.use();
      if (!this._invView) this._invView = M4.n();
      M4.invert(this._invView, this.view);
      rp.tex('uND', this.fbo.pre.tex, 0).tex('uScene', this.fbo.scene.tex, 1)
        .m4('uProj', this.proj).m4('uInvView', this._invView)
        .v2('uRes', this.fbo.ssr.w, this.fbo.ssr.h)
        .f('uWet', this.wet).f('uTime', this.time).f('uIntensity', 1.0).v3a('uCamPos', this.cam.pos);
      drawFullscreen();

      // blend the reflection back over the scene
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.scene.fb);
      gl.viewport(0, 0, this.rw, this.rh);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const bp2 = this.progs.blit.use();
      bp2.tex('uTex', this.fbo.ssr.tex, 0);
      drawFullscreen();
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
    }

    /* ---- 6. ground decals (skid marks) ---- */
    if (scene.skid && scene.skid.count) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
      const kp = this.progs.skid.use();
      kp.m4('uVP', this.vp).v3('uTint', 0.020, 0.020, 0.024).f('uWetLocal', this.wet);
      this.setSkyUniforms(kp);
      scene.skid.draw();
      gl.disable(gl.BLEND);
    }

    /* ---- 7. transparent glass ---- */
    if (scene.glassBatches) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const gp = this.progs.glass.use();
      this.setSkyUniforms(gp);
      gp.m4('uVP', this.vp).v3a('uCamPos', this.cam.pos).tex('uEnv', this.env, 0)
        .f('uEnvMips', this.envMips).f('uAmbStrength', this.sky.ambStrength)
        .f('uFogDensity', this.sky.fogDensity).f('uFogHeight', this.sky.fogHeight);
      for (const b of scene.glassBatches) if (b.n) b.draw();
      gl.disable(gl.BLEND);
    }

    /* ---- 8. particles ---- */
    this._drawParticles(scene);

    /* ---- 8b. god rays from the sun ---- */
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
    let shaftAmt = 0;
    if (this.shaftAmount > 0.01 && this.fbo.shaft) {
      // project the sun onto the screen
      const d = this.sky.dir;
      const sp = [this.cam.pos[0] + d[0] * 900, this.cam.pos[1] + d[1] * 900, this.cam.pos[2] + d[2] * 900];
      const c = this._sunClip || (this._sunClip = new Float32Array(4));
      const m = this.vp;
      c[0] = m[0] * sp[0] + m[4] * sp[1] + m[8] * sp[2] + m[12];
      c[1] = m[1] * sp[0] + m[5] * sp[1] + m[9] * sp[2] + m[13];
      c[3] = m[3] * sp[0] + m[7] * sp[1] + m[11] * sp[2] + m[15];
      if (c[3] > 0) {
        const sx = (c[0] / c[3]) * 0.5 + 0.5, sy = (c[1] / c[3]) * 0.5 + 0.5;
        const off = Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5));
        const onScreen = 1 - smoothstep(0.5, 1.25, off);
        if (onScreen > 0.01) {
          bindFBO(this.fbo.shaft);
          const shp = this.progs.shaft.use();
          shp.tex('uScene', this.fbo.scene.tex, 0).tex('uND', this.fbo.pre.tex, 1)
            .v2('uSun', sx, sy).f('uAmount', 1.0).f('uOnScreen', onScreen);
          drawFullscreen();
          shaftAmt = this.shaftAmount * onScreen;
        }
      }
    }
    this._shaftAmt = shaftAmt;

    /* ---- 9. bloom ---- */
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    const bl = this.bloom;
    if (bl.length) {
      bindFBO(bl[0]);
      const pf = this.progs.bpre.use();
      pf.tex('uTex', this.fbo.scene.tex, 0).v2('uTexel', 1 / this.rw, 1 / this.rh)
        .f('uThreshold', 1.05).f('uKnee', 0.55);
      drawFullscreen();
      const dn = this.progs.bdown.use();
      for (let i = 1; i < bl.length; i++) {
        bindFBO(bl[i]);
        dn.tex('uTex', bl[i - 1].tex, 0).v2('uTexel', 1 / bl[i - 1].w, 1 / bl[i - 1].h);
        drawFullscreen();
      }
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      const up = this.progs.bup.use();
      for (let i = bl.length - 1; i > 0; i--) {
        bindFBO(bl[i - 1]);
        up.tex('uTex', bl[i].tex, 0).v2('uTexel', 1 / bl[i].w, 1 / bl[i].h).f('uScale', 1.0);
        drawFullscreen();
      }
      gl.disable(gl.BLEND);
    }

    /* ---- 10. composite + FXAA ---- */
    bindFBO(this.fbo.ldr);
    const cp = this.progs.comp.use();
    cp.tex('uScene', this.fbo.scene.tex, 0)
      .tex('uBloom', bl.length ? bl[0].tex : this.fbo.scene.tex, 1)
      .tex('uShafts', this.fbo.shaft ? this.fbo.shaft.tex : this.fbo.scene.tex, 2)
      .f('uShaftAmt', this._shaftAmt || 0)
      .v2('uRes', this.W, this.H)
      .f('uExposure', this.exposure).f('uBloomAmt', bl.length ? 0.055 : 0)
      .f('uVignette', 0.34).f('uGrain', 0.024).f('uCA', scene.ca === undefined ? 0.9 : scene.ca)
      .f('uTime', this.time).f('uSpeedBlur', this.speedBlur)
      .f('uSat', 1.10).f('uContrast', 1.085).f('uNightGrade', this.sky.night)
      .v3('uLift', -0.006, -0.004, 0.004).v3('uGain', 1.0, 0.995, 1.005)
      .f('uFlash', this.flash);
    drawFullscreen();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);
    const fp = this.progs.fxaa.use();
    fp.tex('uTex', this.fbo.ldr.tex, 0).v2('uTexel', 1 / this.W, 1 / this.H);
    drawFullscreen();

    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LESS);
    this.flash = Math.max(0, this.flash - dt * 3.2);
  },

  _csmFlat() {
    if (!this._csmBuf) this._csmBuf = new Float32Array(48);
    for (let i = 0; i < 3; i++) this._csmBuf.set(this.csm[i], i * 16);
    return this._csmBuf;
  },

  _drawSkyQuad() {
    // full-screen triangle at the far plane
    if (!this._skyVAO) {
      this._skyVAO = gl.createVertexArray();
      gl.bindVertexArray(this._skyVAO);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(ATTR.POS);
      gl.vertexAttribPointer(ATTR.POS, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }
    gl.bindVertexArray(this._skyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  },

  _drawParticles(scene) {
    const p = scene.particles, sp = scene.sprites;
    if (!this.partBatch) {
      this.partBatch = new Batch(this.meshes.quad, 3200, true);
      this.partBatchAdd = new Batch(this.meshes.quad, 3200, true);
    }
    const [na, nb] = p.fill();
    const right = [this.view[0], this.view[4], this.view[8]];
    const upv = [this.view[1], this.view[5], this.view[9]];
    const prog = this.progs.part.use();
    prog.m4('uVP', this.vp).v3a('uCamR', right).v3a('uCamU', upv).v3a('uCamPos', this.cam.pos)
      .tex('uND', this.fbo.pre.tex, 0).v2('uRes', this.rw, this.rh).f('uSoftEnabled', 1);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    if (na) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.partBatch.grow(na);
      this.partBatch.data.set(p.buf.subarray(0, na * INSTANCE_FLOATS));
      this.partBatch.n = na; this.partBatch.dirty = true;
      this.partBatch.draw();
    }
    const totalAdd = nb + sp.n;
    if (totalAdd) {
      gl.blendFunc(gl.ONE, gl.ONE);
      this.partBatchAdd.grow(totalAdd);
      if (nb) this.partBatchAdd.data.set(p.bufAdd.subarray(0, nb * INSTANCE_FLOATS));
      if (sp.n) this.partBatchAdd.data.set(sp.buf.subarray(0, sp.n * INSTANCE_FLOATS), nb * INSTANCE_FLOATS);
      this.partBatchAdd.n = totalAdd; this.partBatchAdd.dirty = true;
      this.partBatchAdd.draw();
    }
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }
};
