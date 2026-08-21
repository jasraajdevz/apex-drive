'use strict';
/* ============================================================
   Apex Drive — thin WebGL2 layer
   ============================================================ */
let gl = null, GLX = { anisoExt: null, maxAniso: 1, colorBufferFloat: false, halfFloatLinear: false };

const ATTR = { POS: 0, NRM: 1, UV: 2, I0: 3, I1: 4, I2: 5, I3: 6, ICOL: 7, IPAR: 8 };
const INSTANCE_FLOATS = 24; // mat4(16) + rgba(4) + params(4)

function initGL(canvas) {
  const opts = {
    alpha: false, antialias: false, depth: true, stencil: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: true,
    desynchronized: false, failIfMajorPerformanceCaveat: false
  };
  gl = canvas.getContext('webgl2', opts);
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  GLX.colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
  GLX.halfFloatLinear = !!gl.getExtension('OES_texture_float_linear');
  GLX.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
  if (GLX.anisoExt) GLX.maxAniso = gl.getParameter(GLX.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
  gl.getExtension('EXT_float_blend');
  return gl;
}

/* ---------- shaders ---------- */
function compile(type, src, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const lines = src.split('\n');
    let ctx = '';
    const m = /ERROR:\s*\d+:(\d+)/.exec(log);
    if (m) {
      const ln = parseInt(m[1]);
      for (let i = Math.max(0, ln - 6); i < Math.min(lines.length, ln + 5); i++)
        ctx += (i + 1 === ln ? '>> ' : '   ') + (i + 1) + ': ' + lines[i] + '\n';
    }
    throw new Error('shader compile [' + name + ']\n' + log + '\n' + ctx);
  }
  return sh;
}

function makeProgram(name, vsSrc, fsSrc, defines) {
  let head = '#version 300 es\n';
  if (defines) for (const k in defines) head += '#define ' + k + ' ' + defines[k] + '\n';
  const vs = compile(gl.VERTEX_SHADER, head + vsSrc, name + '.vs');
  const fs = compile(gl.FRAGMENT_SHADER, head + fsSrc, name + '.fs');
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  for (const a in ATTR) gl.bindAttribLocation(p, ATTR[a], 'a' + a);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link [' + name + ']: ' + gl.getProgramInfoLog(p));
  gl.deleteShader(vs); gl.deleteShader(fs);

  const U = Object.create(null);
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const nm = info.name.replace(/\[0\]$/, '');
    U[nm] = gl.getUniformLocation(p, info.name);
  }
  return {
    name, prog: p, U,
    use() { gl.useProgram(p); return this; },
    f(k, v) { const l = U[k]; if (l) gl.uniform1f(l, v); return this; },
    i(k, v) { const l = U[k]; if (l) gl.uniform1i(l, v); return this; },
    v2(k, x, y) { const l = U[k]; if (l) gl.uniform2f(l, x, y); return this; },
    v3(k, x, y, z) { const l = U[k]; if (l) gl.uniform3f(l, x, y, z); return this; },
    v3a(k, a) { const l = U[k]; if (l) gl.uniform3f(l, a[0], a[1], a[2]); return this; },
    v4(k, x, y, z, w) { const l = U[k]; if (l) gl.uniform4f(l, x, y, z, w); return this; },
    fv(k, a) { const l = U[k]; if (l) gl.uniform1fv(l, a); return this; },
    v4v(k, a) { const l = U[k]; if (l) gl.uniform4fv(l, a); return this; },
    v3v(k, a) { const l = U[k]; if (l) gl.uniform3fv(l, a); return this; },
    m4(k, m) { const l = U[k]; if (l) gl.uniformMatrix4fv(l, false, m); return this; },
    m4v(k, m) { const l = U[k]; if (l) gl.uniformMatrix4fv(l, false, m); return this; },
    tex(k, t, unit) {
      const l = U[k]; if (!l) return this;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(t.target || gl.TEXTURE_2D, t.tex || t);
      gl.uniform1i(l, unit); return this;
    }
  };
}

/* ---------- textures ---------- */
function texFromCanvas(cv, opts = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, opts.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
  if (GLX.anisoExt) gl.texParameterf(gl.TEXTURE_2D, GLX.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, GLX.maxAniso));
  return { tex: t, target: gl.TEXTURE_2D, w: cv.width, h: cv.height };
}

function texEmpty(w, h, internal, format, type, filter, wrap) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap || gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap || gl.CLAMP_TO_EDGE);
  return { tex: t, target: gl.TEXTURE_2D, w, h, internal, format, type };
}

function makeFBO(w, h, spec) {
  // spec: { color:[{internal,format,type,filter}], depth:'tex'|'rb'|null, depthTex: existing }
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const colors = [];
  const bufs = [];
  (spec.color || []).forEach((c, i) => {
    const t = texEmpty(w, h, c.internal, c.format, c.type, c.filter, c.wrap);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.tex, 0);
    colors.push(t); bufs.push(gl.COLOR_ATTACHMENT0 + i);
  });
  if (bufs.length > 1) gl.drawBuffers(bufs);
  else if (bufs.length === 0) { gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); }
  let depth = spec.depthTex || null;
  if (spec.depth === 'tex' && !depth) {
    depth = texEmpty(w, h, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
  }
  if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth.tex, 0);
  else if (spec.depth === 'rb') {
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  }
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete 0x' + st.toString(16) + ' (' + w + 'x' + h + ')');
  return { fb, w, h, color: colors, tex: colors[0], depth, bufs };
}

function bindFBO(f, clearColor) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, f ? f.fb : null);
  const w = f ? f.w : gl.drawingBufferWidth, h = f ? f.h : gl.drawingBufferHeight;
  gl.viewport(0, 0, w, h);
  if (clearColor) { gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3] === undefined ? 1 : clearColor[3]); }
  return f;
}

/* ---------- shadow map (depth texture, compare mode) ---------- */
function makeShadowFBO(size) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
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
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('shadow FBO incomplete');
  return { fb, w: size, h: size, depth: { tex: t, target: gl.TEXTURE_2D } };
}

/* ---------- meshes ---------- */
/* geo = { pos:Float32Array, nrm:Float32Array, uv:Float32Array, idx:Uint16Array|Uint32Array } */
function makeMesh(geo) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const mk = (data, loc, size) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    return b;
  };
  mk(geo.pos, ATTR.POS, 3);
  mk(geo.nrm, ATTR.NRM, 3);
  mk(geo.uv, ATTR.UV, 2);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  const idx = geo.idx.length > 65535 || geo.idx instanceof Uint32Array ? new Uint32Array(geo.idx) : new Uint16Array(geo.idx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return {
    vao, count: idx.length, type: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    radius: geo.radius || 1, ib
  };
}

/* An instanced draw group: a mesh + a dynamic instance buffer. */
class Batch {
  constructor(mesh, cap = 256, dynamic = true) {
    this.mesh = mesh; this.cap = cap; this.n = 0; this.dynamic = dynamic;
    this.data = new Float32Array(cap * INSTANCE_FLOATS);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    // re-bind mesh attributes into this VAO
    gl.bindVertexArray(null);
    this.buf = gl.createBuffer();
    this._buildVAO();
    this.dirty = true;
  }
  _buildVAO() {
    const m = this.mesh;
    gl.bindVertexArray(this.vao);
    // vertex streams: rebind from the mesh's own VAO is not possible; store buffers on mesh
    gl.bindBuffer(gl.ARRAY_BUFFER, m._bpos); gl.enableVertexAttribArray(ATTR.POS); gl.vertexAttribPointer(ATTR.POS, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m._bnrm); gl.enableVertexAttribArray(ATTR.NRM); gl.vertexAttribPointer(ATTR.NRM, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m._buv); gl.enableVertexAttribArray(ATTR.UV); gl.vertexAttribPointer(ATTR.UV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, this.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    const stride = INSTANCE_FLOATS * 4;
    const locs = [ATTR.I0, ATTR.I1, ATTR.I2, ATTR.I3, ATTR.ICOL, ATTR.IPAR];
    for (let i = 0; i < 6; i++) {
      gl.enableVertexAttribArray(locs[i]);
      gl.vertexAttribPointer(locs[i], 4, gl.FLOAT, false, stride, i * 16);
      gl.vertexAttribDivisor(locs[i], 1);
    }
    gl.bindVertexArray(null);
  }
  clear() { this.n = 0; return this; }
  grow(need) {
    if (need <= this.cap) return;
    let c = this.cap; while (c < need) c *= 2;
    const nd = new Float32Array(c * INSTANCE_FLOATS);
    nd.set(this.data);
    this.data = nd; this.cap = c;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, nd.byteLength, this.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }
  /* push a raw model matrix + material */
  push(m, r, g, b, rough, metal, emis, matId, seed) {
    this.grow(this.n + 1);
    const d = this.data, o = this.n * INSTANCE_FLOATS;
    d[o] = m[0]; d[o + 1] = m[1]; d[o + 2] = m[2]; d[o + 3] = m[3];
    d[o + 4] = m[4]; d[o + 5] = m[5]; d[o + 6] = m[6]; d[o + 7] = m[7];
    d[o + 8] = m[8]; d[o + 9] = m[9]; d[o + 10] = m[10]; d[o + 11] = m[11];
    d[o + 12] = m[12]; d[o + 13] = m[13]; d[o + 14] = m[14]; d[o + 15] = m[15];
    d[o + 16] = r; d[o + 17] = g; d[o + 18] = b; d[o + 19] = rough;
    d[o + 20] = metal; d[o + 21] = emis; d[o + 22] = matId; d[o + 23] = seed;
    this.n++; this.dirty = true;
    return this;
  }
  upload() {
    if (!this.dirty || this.n === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.n * INSTANCE_FLOATS);
    this.dirty = false;
  }
  draw() {
    if (this.n === 0) return 0;
    this.upload();
    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.mesh.count, this.mesh.type, 0, this.n);
    return this.n;
  }
}

/* mesh factory that keeps raw buffers so Batches can build their own VAOs */
function buildMesh(geo) {
  const mk = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
  const m = { _bpos: mk(geo.pos), _bnrm: mk(geo.nrm), _buv: mk(geo.uv) };
  const idx = (geo.idx.length > 65000) ? new Uint32Array(geo.idx) : new Uint16Array(geo.idx);
  m.ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  m.count = idx.length;
  m.type = idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  m.radius = geo.radius || 1;
  return m;
}

/* fullscreen triangle */
let _fsVAO = null;
function drawFullscreen() {
  if (!_fsVAO) {
    _fsVAO = gl.createVertexArray();
    gl.bindVertexArray(_fsVAO);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(ATTR.POS);
    gl.vertexAttribPointer(ATTR.POS, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
  gl.bindVertexArray(_fsVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
