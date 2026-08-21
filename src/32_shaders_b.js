'use strict';
/* ============================================================
   Apex Drive — GLSL: prepass, shadows, SSAO, bloom, composite,
   sky, env capture, particles, decals
   ============================================================ */

/* ---------------- fullscreen VS ---------------- */
SH.fsVS = `
layout(location=0) in vec2 aPOS;
out vec2 vUV;
void main(){ vUV = aPOS*0.5+0.5; gl_Position = vec4(aPOS,0.0,1.0); }
`;

/* fullscreen VS pinned to the far plane (sky fills untouched pixels only) */
SH.skyVS = `
layout(location=0) in vec2 aPOS;
out vec2 vUV;
void main(){ vUV = aPOS*0.5+0.5; gl_Position = vec4(aPOS,1.0,1.0); }
`;

/* ---------------- depth + view-normal prepass ---------------- */
SH.preVS = `
layout(location=0) in vec3 aPOS;
layout(location=1) in vec3 aNRM;
layout(location=3) in vec4 aI0;
layout(location=4) in vec4 aI1;
layout(location=5) in vec4 aI2;
layout(location=6) in vec4 aI3;
uniform mat4 uVP, uView;
out vec3 vVN;
out float vVD;
void main(){
  mat4 M = mat4(aI0,aI1,aI2,aI3);
  vec4 wp = M*vec4(aPOS,1.0);
  vec3 c0=M[0].xyz,c1=M[1].xyz,c2=M[2].xyz;
  vec3 s2=vec3(dot(c0,c0),dot(c1,c1),dot(c2,c2));
  mat3 nm=mat3(c0/max(s2.x,1e-8),c1/max(s2.y,1e-8),c2/max(s2.z,1e-8));
  vec3 wn = nm*aNRM;
  vVN = mat3(uView)*wn;
  vec4 vp = uView*wp;
  vVD = -vp.z;
  gl_Position = uVP*wp;
}
`;
SH.preFS = `
precision highp float;
in vec3 vVN; in float vVD;
uniform float uInvFar;
out vec4 oND;
void main(){ oND = vec4(normalize(vVN)*0.5 + 0.5, vVD*uInvFar); }
`;

/* ---------------- shadow depth ---------------- */
SH.shadowVS = `
layout(location=0) in vec3 aPOS;
layout(location=3) in vec4 aI0;
layout(location=4) in vec4 aI1;
layout(location=5) in vec4 aI2;
layout(location=6) in vec4 aI3;
uniform mat4 uVP;
void main(){ gl_Position = uVP*(mat4(aI0,aI1,aI2,aI3)*vec4(aPOS,1.0)); }
`;
SH.shadowFS = `
precision mediump float;
void main(){}
`;

/* ---------------- SSAO ---------------- */
SH.ssaoFS = `
${SH.common}
in vec2 vUV;
uniform sampler2D uND;
uniform vec2 uRes;
uniform mat4 uProj;
uniform float uFar;
uniform float uRadius, uIntensity, uBias;
uniform float uTime;
out vec4 oCol;

vec3 viewPosFromUV(vec2 uv, float d){
  vec2 ndc = uv*2.0-1.0;
  return vec3(ndc.x/uProj[0][0], ndc.y/uProj[1][1], -1.0)*d;
}
void main(){
  vec4 nd = texture(uND, vUV);
  float depth = ndDepth(nd, uFar);
  if(depth <= 0.0001 || depth > 900.0){ oCol = vec4(1.0); return; }
  vec3 P = viewPosFromUV(vUV, depth);
  vec3 N = ndNormal(nd);
  float ang = hash12(floor(gl_FragCoord.xy))*6.2831853;
  float ca = cos(ang), sa = sin(ang);
  float radius = uRadius;
  float occ = 0.0;
  const int NS = 12;
  for(int i=0;i<NS;i++){
    float fi = float(i);
    float a = (fi+0.5)/float(NS);
    float r = sqrt(a)*radius;
    float th = fi*2.39996323;
    vec2 dir = vec2(cos(th), sin(th));
    dir = vec2(dir.x*ca - dir.y*sa, dir.x*sa + dir.y*ca);
    vec3 sv = vec3(dir*r, 0.0);
    // orient into the hemisphere around N
    vec3 T = normalize(abs(N.z)<0.9 ? cross(N, vec3(0,0,1)) : cross(N, vec3(1,0,0)));
    vec3 B = cross(N,T);
    vec3 sp = P + (T*sv.x + B*sv.y + N*(0.30*radius*(0.35+0.65*hash12(vec2(fi,ang)))));
    vec4 cp = uProj*vec4(sp,1.0);
    vec2 suv = (cp.xy/cp.w)*0.5+0.5;
    if(suv.x<0.0||suv.x>1.0||suv.y<0.0||suv.y>1.0) continue;
    float sd = ndDepth(texture(uND, suv), uFar);
    float diff = (-sp.z) - sd;
    float rangeCheck = smoothstep(0.0,1.0, radius/max(abs(depth-sd),1e-4));
    occ += step(uBias, diff)*rangeCheck;
  }
  float ao = 1.0 - (occ/float(NS))*uIntensity;
  ao = pow(sat(ao), 1.25);
  // fade AO out in the distance
  ao = mix(ao, 1.0, smoothstep(70.0, 190.0, depth));
  oCol = vec4(ao,ao,ao,1.0);
}
`;
SH.blurFS = `
precision highp float;
vec3  ndNormal(vec4 nd){ return normalize(nd.xyz*2.0 - 1.0); }
float ndDepth(vec4 nd, float far){ return nd.w*far; }
in vec2 vUV;
uniform sampler2D uTex;
uniform sampler2D uND;
uniform vec2 uDir;
uniform vec2 uRes;
uniform float uFar;
out vec4 oCol;
void main(){
  float c = ndDepth(texture(uND, vUV), uFar);
  float sum = 0.0, wsum = 0.0;
  for(int i=-4;i<=4;i++){
    vec2 uv = vUV + uDir*float(i)/uRes;
    float d = ndDepth(texture(uND, uv), uFar);
    float w = exp(-abs(d-c)*0.55)*exp(-float(i*i)*0.16);
    sum += texture(uTex, uv).r*w; wsum += w;
  }
  float v = wsum>0.0 ? sum/wsum : texture(uTex,vUV).r;
  oCol = vec4(v,v,v,1.0);
}
`;

/* ---------------- sky (fullscreen) ---------------- */
SH.skyFS = `
${SH.common}
${SH.sky}
in vec2 vUV;
uniform mat4 uInvVP;
uniform vec3 uCamPos;
out vec4 oCol;
void main(){
  vec4 p = uInvVP*vec4(vUV*2.0-1.0, 1.0, 1.0);
  vec3 d = normalize(p.xyz/p.w - uCamPos);
  oCol = vec4(skyRadiance(d, 1.0), 1.0);
}
`;

/* ---------------- env cubemap capture ---------------- */
SH.envFS = `
${SH.common}
${SH.sky}
in vec2 vUV;
uniform vec3 uFaceF, uFaceR, uFaceU;
out vec4 oCol;
void main(){
  vec2 n = vUV*2.0-1.0;
  vec3 d = normalize(uFaceF + uFaceR*n.x + uFaceU*n.y);
  oCol = vec4(skyRadiance(d, 0.0), 1.0);
}
`;

/* ---------------- screen-space reflections (wet roads) ---------------- */
SH.ssrFS = `
${SH.common}
in vec2 vUV;
uniform sampler2D uND;      // xyz = biased view normal, w = depth / far
uniform float uFar;
uniform sampler2D uScene;   // HDR opaque + sky
uniform mat4 uProj, uInvView;
uniform vec2 uRes;
uniform float uWet, uTime, uIntensity;
uniform vec3 uCamPos;
out vec4 oCol;

vec3 viewPosFromUV(vec2 uv, float d){
  vec2 ndc = uv*2.0-1.0;
  return vec3(ndc.x/uProj[0][0], ndc.y/uProj[1][1], -1.0)*d;
}
vec2 projectUV(vec3 vp){
  vec4 c = uProj*vec4(vp,1.0);
  return (c.xy/c.w)*0.5+0.5;
}

void main(){
  oCol = vec4(0.0);
  if(uWet < 0.02) return;
  vec4 nd = texture(uND, vUV);
  float depth = ndDepth(nd, uFar);
  if(depth <= 0.001 || depth > 220.0) return;
  vec3 N = ndNormal(nd);
  // only near-horizontal surfaces get standing water
  vec3 wN = mat3(uInvView)*N;
  float flat_ = smoothstep(0.72, 0.93, wN.y);
  if(flat_ <= 0.001) return;

  vec3 P = viewPosFromUV(vUV, depth);
  // world position, so the puddle mask matches the one the road material uses
  vec3 wp = (uInvView*vec4(P,1.0)).xyz;
  float pud = smoothstep(0.46, 0.68, fbm(wp.xz*0.19));
  float sheet = 0.16 + 0.84*pud;          // thin film everywhere, deep water in dips
  if(sheet*uWet < 0.03) return;
  vec3 V = normalize(P);
  vec3 R = normalize(reflect(V, N));

  float NoV = sat(dot(N, -V));
  float fres = pow(1.0 - NoV, 4.0);
  float k = uIntensity * uWet * flat_ * sheet * mix(0.035, 0.62, fres);
  if(k <= 0.004) return;

  // jittered march so banding turns into noise the blur can eat
  float jit = hash12(gl_FragCoord.xy + fract(uTime)*137.0);
  float stepLen = 0.42 + depth*0.020;
  vec3 p = P + R*stepLen*(0.4 + jit*0.6);
  float hit = 0.0;
  vec2 hitUV = vec2(0.0);
  for(int i=0;i<26;i++){
    p += R*stepLen;
    stepLen *= 1.09;
    vec2 uv = projectUV(p);
    if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float sd = ndDepth(texture(uND, uv), uFar);
    if(sd <= 0.001) continue;
    float pd = -p.z;
    float diff = pd - sd;
    if(diff > 0.02 && diff < stepLen*2.6 + 0.9){
      // binary refine
      vec3 a = p - R*stepLen, b = p;
      for(int j=0;j<5;j++){
        vec3 m = (a+b)*0.5;
        vec2 muv = projectUV(m);
        float msd = ndDepth(texture(uND, muv), uFar);
        if(-m.z - msd > 0.02) b = m; else a = m;
      }
      hitUV = projectUV((a+b)*0.5);
      hit = 1.0;
      break;
    }
  }
  if(hit < 0.5) return;

  vec2 e = abs(hitUV*2.0-1.0);
  float edge = (1.0-smoothstep(0.72,1.0,e.x))*(1.0-smoothstep(0.72,1.0,e.y));
  float far = 1.0 - smoothstep(90.0, 190.0, depth);

  // wet asphalt is not a mirror: scatter the lookup so the reflection breaks up,
  // and stretch it vertically the way a rippled film does
  float rough = mix(0.010, 0.0018, pud);
  vec2 px = vec2(1.0)/uRes;
  vec3 c = vec3(0.0);
  for(int i=0;i<4;i++){
    vec2 o = (hash22(hitUV*512.0 + float(i)*7.13 + fract(uTime)*3.0)-0.5);
    o.y *= 2.4;
    c += texture(uScene, hitUV + o*rough*(1.0+depth*0.02)).rgb;
  }
  c *= 0.25;
  oCol = vec4(c, sat(k*edge*far));
}
`;

SH.blitFS = `
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 oCol;
void main(){ oCol = texture(uTex, vUV); }
`;

/* ---------------- bloom ---------------- */
SH.bloomPreFS = `
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold, uKnee;
out vec4 oCol;
void main(){
  vec3 c = vec3(0.0);
  c += texture(uTex, vUV+vec2(-1,-1)*uTexel).rgb;
  c += texture(uTex, vUV+vec2( 1,-1)*uTexel).rgb;
  c += texture(uTex, vUV+vec2(-1, 1)*uTexel).rgb;
  c += texture(uTex, vUV+vec2( 1, 1)*uTexel).rgb;
  c *= 0.25;
  float br = max(c.r, max(c.g, c.b));
  float soft = br - uThreshold + uKnee;
  soft = clamp(soft, 0.0, 2.0*uKnee);
  soft = soft*soft/(4.0*uKnee+1e-5);
  float contrib = max(soft, br-uThreshold)/max(br,1e-5);
  oCol = vec4(c*contrib, 1.0);
}
`;
SH.bloomDownFS = `
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 oCol;
void main(){
  vec3 a = texture(uTex, vUV+vec2(-2,-2)*uTexel).rgb;
  vec3 b = texture(uTex, vUV+vec2( 0,-2)*uTexel).rgb;
  vec3 c = texture(uTex, vUV+vec2( 2,-2)*uTexel).rgb;
  vec3 d = texture(uTex, vUV+vec2(-1,-1)*uTexel).rgb;
  vec3 e = texture(uTex, vUV+vec2( 1,-1)*uTexel).rgb;
  vec3 f = texture(uTex, vUV+vec2(-2, 0)*uTexel).rgb;
  vec3 g = texture(uTex, vUV).rgb;
  vec3 h = texture(uTex, vUV+vec2( 2, 0)*uTexel).rgb;
  vec3 i = texture(uTex, vUV+vec2(-1, 1)*uTexel).rgb;
  vec3 j = texture(uTex, vUV+vec2( 1, 1)*uTexel).rgb;
  vec3 k = texture(uTex, vUV+vec2(-2, 2)*uTexel).rgb;
  vec3 l = texture(uTex, vUV+vec2( 0, 2)*uTexel).rgb;
  vec3 m = texture(uTex, vUV+vec2( 2, 2)*uTexel).rgb;
  vec3 o = g*0.125;
  o += (a+c+k+m)*0.03125;
  o += (b+f+h+l)*0.0625;
  o += (d+e+i+j)*0.125;
  oCol = vec4(o,1.0);
}
`;
SH.bloomUpFS = `
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uScale;
out vec4 oCol;
void main(){
  vec2 t = uTexel*uScale;
  vec3 s = texture(uTex, vUV+vec2(-1,-1)*t).rgb;
  s += texture(uTex, vUV+vec2( 0,-1)*t).rgb*2.0;
  s += texture(uTex, vUV+vec2( 1,-1)*t).rgb;
  s += texture(uTex, vUV+vec2(-1, 0)*t).rgb*2.0;
  s += texture(uTex, vUV).rgb*4.0;
  s += texture(uTex, vUV+vec2( 1, 0)*t).rgb*2.0;
  s += texture(uTex, vUV+vec2(-1, 1)*t).rgb;
  s += texture(uTex, vUV+vec2( 0, 1)*t).rgb*2.0;
  s += texture(uTex, vUV+vec2( 1, 1)*t).rgb;
  oCol = vec4(s/16.0, 1.0);
}
`;

/* ---------------- volumetric light shafts ---------------- */
SH.shaftFS = `
${SH.common}
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uND;
uniform vec2 uSun;          // sun position in screen uv
uniform float uAmount, uOnScreen, uFar;
out vec4 oCol;
void main(){
  if(uAmount <= 0.001 || uOnScreen <= 0.001){ oCol = vec4(0.0); return; }
  vec2 dir = (uSun - vUV);
  float dist = length(dir);
  dir /= max(dist, 1e-4);
  float density = min(dist, 0.75);
  const int N = 22;
  float jit = hash12(gl_FragCoord.xy)*0.6 + 0.4;
  vec3 acc = vec3(0.0);
  float w = 0.0;
  for(int i=0;i<N;i++){
    float t = (float(i)+jit)/float(N);
    vec2 uv = vUV + dir*density*t;
    if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) break;
    // only unoccluded sky contributes to a shaft
    float d = texture(uND, uv).w;      // still normalised here, 0 == sky
    float sky = step(d, 0.00002);
    vec3 c = texture(uScene, uv).rgb;
    float lw = (1.0 - t)*(1.0 - t);
    acc += c*sky*lw;
    w += lw;
  }
  acc /= max(w, 1e-4);
  float falloff = 1.0 - smoothstep(0.05, 0.95, dist);
  oCol = vec4(acc*uAmount*falloff, 1.0);
}
`;

/* ---------------- composite: tonemap + grade + fx ---------------- */
SH.compositeFS = `
${SH.common}
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uShafts;
uniform vec2 uRes;
uniform float uShaftAmt;
uniform float uExposure, uBloomAmt, uVignette, uGrain, uCA, uTime;
uniform float uSpeedBlur, uSat, uContrast, uNightGrade;
uniform vec3 uLift, uGain;
uniform float uFlash;
out vec4 oCol;

vec3 ACESFitted(vec3 c){
  // input transform
  const mat3 IN = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
  const mat3 OUT= mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
  c = IN*c;
  vec3 a = c*(c+0.0245786)-0.000090537;
  vec3 b = c*(0.983729*c+0.4329510)+0.238081;
  c = a/b;
  return sat3(OUT*c);
}
vec3 sampleScene(vec2 uv){ return texture(uScene, uv).rgb; }

void main(){
  vec2 uv = vUV;
  vec2 c = uv-0.5;
  float r2 = dot(c,c);

  vec3 col;
  if(uSpeedBlur > 0.001){
    // radial motion blur toward the screen centre
    float amt = uSpeedBlur*(0.06+r2*0.55);
    vec3 acc = vec3(0.0); float w = 0.0;
    for(int i=0;i<8;i++){
      float t = float(i)/7.0;
      vec2 s = uv - c*amt*t;
      float wi = 1.0-t*0.55;
      acc += sampleScene(s)*wi; w += wi;
    }
    col = acc/w;
  } else {
    col = sampleScene(uv);
  }

  // chromatic aberration (sampled from the already-blurred colour for cheapness)
  if(uCA > 0.0001){
    float k = uCA*(0.0016+r2*0.010);
    col.r = sampleScene(uv - c*k).r;
    col.b = sampleScene(uv + c*k).b;
  }

  col += texture(uBloom, uv).rgb*uBloomAmt;
  if(uShaftAmt > 0.001) col += texture(uShafts, uv).rgb*uShaftAmt;
  col *= uExposure;
  col *= 1.0 + uFlash*3.0;

  col = ACESFitted(col);
  // linear -> display (sRGB-ish) encode
  col = pow(max(col, vec3(0.0)), vec3(1.0/2.2));

  // grade: lift/gain, contrast, saturation
  col = col*uGain + uLift;
  col = sat3((col-0.5)*uContrast+0.5);
  float lum = dot(col, vec3(0.2126,0.7152,0.0722));
  col = mix(vec3(lum), col, uSat);
  // night: cool shadows, slight desaturation of the low end
  col = mix(col, mix(vec3(lum)*vec3(0.72,0.84,1.12), col, 0.62), uNightGrade*(1.0-sat(lum*1.6)));

  // vignette
  float vig = 1.0 - uVignette*sat(r2*1.85);
  col *= vig;

  // grain
  float g = hash12(gl_FragCoord.xy + fract(uTime)*vec2(311.7,197.3))-0.5;
  col += g*uGrain*(1.0-sat(dot(col,vec3(0.33))));

  oCol = vec4(sat3(col), 1.0);
}
`;

/* ---------------- FXAA ---------------- */
SH.fxaaFS = `
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 oCol;
float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
void main(){
  vec3 rgbNW = texture(uTex, vUV+vec2(-1,-1)*uTexel).rgb;
  vec3 rgbNE = texture(uTex, vUV+vec2( 1,-1)*uTexel).rgb;
  vec3 rgbSW = texture(uTex, vUV+vec2(-1, 1)*uTexel).rgb;
  vec3 rgbSE = texture(uTex, vUV+vec2( 1, 1)*uTexel).rgb;
  vec3 rgbM  = texture(uTex, vUV).rgb;
  float lNW=lum(rgbNW), lNE=lum(rgbNE), lSW=lum(rgbSW), lSE=lum(rgbSE), lM=lum(rgbM);
  float lMin = min(lM, min(min(lNW,lNE), min(lSW,lSE)));
  float lMax = max(lM, max(max(lNW,lNE), max(lSW,lSE)));
  if(lMax-lMin < max(0.028, lMax*0.115)){ oCol = vec4(rgbM,1.0); return; }
  vec2 dir = vec2(-((lNW+lNE)-(lSW+lSE)), ((lNW+lSW)-(lNE+lSE)));
  float dirReduce = max((lNW+lNE+lSW+lSE)*0.03125, 0.0078125);
  float rcpDir = 1.0/(min(abs(dir.x),abs(dir.y))+dirReduce);
  dir = clamp(dir*rcpDir, -8.0, 8.0)*uTexel;
  vec3 rgbA = 0.5*(texture(uTex, vUV+dir*(1.0/3.0-0.5)).rgb + texture(uTex, vUV+dir*(2.0/3.0-0.5)).rgb);
  vec3 rgbB = rgbA*0.5 + 0.25*(texture(uTex, vUV-dir*0.5).rgb + texture(uTex, vUV+dir*0.5).rgb);
  float lB = lum(rgbB);
  oCol = vec4((lB<lMin||lB>lMax) ? rgbA : rgbB, 1.0);
}
`;

/* ---------------- particles / billboards ---------------- */
SH.partVS = `
layout(location=0) in vec3 aPOS;   // quad corner in [-0.5,0.5]
layout(location=3) in vec4 aI0;    // pos.xyz, size
layout(location=4) in vec4 aI1;    // rot, stretch, kind, seed
layout(location=5) in vec4 aI2;    // axis.xyz (for stretched sprites)
layout(location=7) in vec4 aICOL;  // rgba
layout(location=8) in vec4 aIPAR;  // softness, unused...
uniform mat4 uVP;
uniform vec3 uCamR, uCamU, uCamPos;
out vec2 vQ;
out vec4 vCol;
out vec4 vPar;
out float vKind;
out float vSeed;
out vec3 vWP;
void main(){
  float size = aI0.w;
  float rot = aI1.x, stretch = aI1.y;
  vec3 R = uCamR, U = uCamU;
  if(stretch > 0.001){
    vec3 ax = aI2.xyz;
    if(dot(ax,ax) > 1e-6){
      ax = normalize(ax);
      vec3 side = normalize(cross(ax, normalize(uCamPos-aI0.xyz)));
      U = ax*stretch; R = side;
    }
  } else if(abs(rot) > 0.0001){
    float ca=cos(rot), sa=sin(rot);
    vec3 r2 = uCamR*ca + uCamU*sa;
    vec3 u2 = -uCamR*sa + uCamU*ca;
    R = r2; U = u2;
  }
  vec3 wp = aI0.xyz + (R*aPOS.x + U*aPOS.y)*size;
  vWP = wp;
  vQ = aPOS.xy*2.0;
  vCol = aICOL; vPar = aIPAR; vKind = aI1.z; vSeed = aI1.w;
  gl_Position = uVP*vec4(wp,1.0);
}
`;
SH.partFS = `
${SH.common}
in vec2 vQ; in vec4 vCol; in vec4 vPar; in float vKind; in float vSeed; in vec3 vWP;
uniform sampler2D uND;
uniform vec2 uRes;
uniform float uSoftEnabled;
uniform float uFar;
uniform vec3 uCamPos;
out vec4 oCol;
void main(){
  float r = length(vQ);
  float a = vCol.a;
  if(vKind < 0.5){
    // soft smoke puff
    float n = fbm3(vQ*1.7 + vSeed*13.0);
    float mask = sat(1.0 - r*(0.78+0.34*n));
    a *= mask*mask;
  } else if(vKind < 1.5){
    // glow sprite
    float g = exp(-r*r*3.0);
    a *= g;
  } else if(vKind < 2.5){
    // rain streak / spark: soft along the quad
    a *= sat(1.0-abs(vQ.x))*sat(1.0-abs(vQ.y)*0.85);
  } else {
    float mask = sat(1.0-r);
    a *= mask*mask;
  }
  if(a <= 0.003) discard;
  if(uSoftEnabled > 0.5){
    float sceneD = ndDepth(texture(uND, gl_FragCoord.xy/uRes), uFar);
    float myD = distance(uCamPos, vWP);
    if(sceneD > 0.0) a *= sat((sceneD-myD)/max(vPar.x,0.05));
  }
  oCol = vec4(vCol.rgb*a, a);
}
`;

/* ---------------- skid marks / ground decal strips ---------------- */
SH.skidVS = `
layout(location=0) in vec3 aPOS;
layout(location=2) in vec2 aUV;   // x = across strip, y = alpha
uniform mat4 uVP;
out vec2 vUV;
out vec3 vWP;
void main(){ vUV=aUV; vWP=aPOS; gl_Position = uVP*vec4(aPOS,1.0); }
`;
SH.skidFS = `
${SH.common}
in vec2 vUV; in vec3 vWP;
uniform vec3 uTint;
uniform float uWetLocal;
out vec4 oCol;
void main(){
  float edge = sat(1.0-abs(vUV.x*2.0-1.0)*1.06);
  edge = pow(edge, 0.55);
  float n = 0.62+0.38*fbm3(vWP.xz*7.0);
  float a = vUV.y*edge*n;
  if(a<=0.004) discard;
  oCol = vec4(uTint, a);
}
`;

/* ---------------- forward transparent (glass) ---------------- */
SH.glassVS = SH.mainVS;
SH.glassFS = `
${SH.common}
${SH.sky}
in vec3 vWP; in vec3 vN; in vec2 vUV; in vec3 vLP; in vec3 vScale;
in vec4 vCol; in vec4 vPar; in float vVDepth;
uniform vec3 uCamPos;
uniform samplerCube uEnv;
uniform float uEnvMips;
uniform float uFogDensity, uFogHeight;
uniform float uAmbStrength;
out vec4 oCol;
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos-vWP);
  if(dot(N,V)<0.0) N = -N;
  float NoV = sat(dot(N,V));
  float fres = pow(1.0-NoV, 5.0);
  float F = 0.045 + 0.955*fres;
  vec3 R = reflect(-V,N);
  vec3 env = textureLod(uEnv, R, vCol.a*uEnvMips*0.8).rgb*uAmbStrength;
  float sunSpec = pow(sat(dot(R, uSunDir)), 900.0)*3.2;
  vec3 col = env*(0.16 + F*0.94) + uSunColor*sunSpec*F*2.2;
  col += vCol.rgb*0.35 + vec3(0.012,0.016,0.026);
  float alpha = sat(vPar.y + F*0.80);
  float hf = exp(-max(vWP.y-1.0,0.0)/max(uFogHeight,1.0));
  float fogAmt = 1.0-exp(-vVDepth*uFogDensity*mix(0.35,1.0,hf));
  col = mix(col, skyFog(-V), sat(fogAmt));
  oCol = vec4(col*alpha, alpha);
}
`;
