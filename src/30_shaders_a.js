'use strict';
/* ============================================================
   Apex Drive — GLSL: common chunks, analytic sky, PBR uber shader
   ============================================================ */
const SH = {};

SH.common = `
precision highp float;
precision highp int;
precision highp sampler2DShadow;
precision highp sampler2D;
precision highp samplerCube;
const float PI = 3.141592653589793;
float sat(float x){ return clamp(x,0.0,1.0); }
vec2  sat2(vec2 x){ return clamp(x,0.0,1.0); }
vec3  sat3(vec3 x){ return clamp(x,0.0,1.0); }
float sq(float x){ return x*x; }
float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2  hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float hash13(vec3 p){ p=fract(p*0.1031); p+=dot(p,p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x), f.y);
}
float fbm(vec2 p){
  float s=0.0,a=0.5;
  for(int i=0;i<5;i++){ s+=a*vnoise(p); p*=2.03; a*=0.5; }
  return s;
}
float fbm3(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<3;i++){ s+=a*vnoise(p); p*=2.11; a*=0.5;} return s; }
// smooth box mask, used for windows / panel lines
float boxMask(vec2 uv, vec2 half_, float soft){
  vec2 d = abs(uv) - half_;
  return 1.0 - sat(max(d.x,d.y)/max(soft,1e-4));
}
`;

/* ---------- analytic sky: shared by sky pass, env capture and fog ---------- */
SH.sky = `
uniform vec3  uSunDir;        // normalised, points TO the sun
uniform vec3  uSunColor;      // sun disc + direct radiance
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;
uniform vec3  uSkyGround;
uniform float uNight;         // 0 day .. 1 night
uniform float uCloud;         // 0..1 coverage
uniform float uTime;
uniform float uWet;

float cloudLayer(vec3 d, float h, float scale, float t){
  if(d.y < 0.006) return 0.0;
  vec2 p = d.xz / d.y * h;
  p *= scale;
  p += vec2(t*0.9, t*0.35);
  float n = fbm3(p*0.0016);
  n += 0.45*fbm3(p*0.0051+vec2(11.0,-7.0));
  n /= 1.45;
  float cov = mix(0.72, 0.30, uCloud);
  float c = sat((n - cov) / max(0.001, (1.0-cov)) );
  c = smoothstep(0.0,0.85,c);
  return c * smoothstep(0.006,0.10,d.y);
}

vec3 skyFog(vec3 d){
  float up = d.y;
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(sat(up), 0.42));
  col = mix(col, uSkyGround, sat(-up*3.2));
  float mu = dot(d, uSunDir);
  col += uSunColor * pow(sat(mu), 8.0) * 0.20;
  col += uSkyHorizon * 0.30 * exp(-abs(up)*9.0) * (1.0-uNight*0.6);
  vec3 cc = mix(vec3(0.26,0.29,0.36), vec3(0.92,0.93,0.95), sat(mu*0.5+0.5)) * (1.0-uNight*0.88);
  col = mix(col, cc, uCloud*0.55);
  return max(col, vec3(0.0));
}

vec3 skyRadiance(vec3 d, float withSun){
  float up = d.y;
  float t = pow(sat(up*0.5+0.5), 1.0);
  // gradient
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(sat(up), 0.42));
  // below the horizon fades into haze/ground
  col = mix(col, uSkyGround, sat(-up*3.2));
  float mu = dot(d, uSunDir);
  // mie forward scattering halo
  float g = 0.76;
  float mie = (1.0-g*g)/(4.0*PI*pow(1.0+g*g-2.0*g*mu, 1.5));
  col += uSunColor * mie * 0.55 * (1.0 - uNight*0.85);
  // broad warm bloom around the sun near the horizon
  col += uSunColor * pow(sat(mu), 8.0) * 0.22;
  // horizon haze band
  col += uSkyHorizon * 0.30 * exp(-abs(up)*9.0) * (1.0-uNight*0.6);
  // sun disc
  if(withSun > 0.5){
    float disc = smoothstep(0.99965, 0.99988, mu);
    col += uSunColor * disc * 22.0 * (1.0-uNight);
  }
  // stars + moon at night
  if(uNight > 0.02 && up > -0.05){
    vec3 sd = d*260.0;
    vec3 cell = floor(sd);
    float st = hash13(cell);
    float s = step(0.9962, st);
    vec3 fr = fract(sd)-0.5;
    float d2 = dot(fr,fr);
    float tw = 0.62+0.38*sin(uTime*(1.5+st*5.0)+st*30.0);
    col += vec3(0.72,0.80,1.0) * s * exp(-d2*38.0) * 2.6 * uNight * tw * sat(up*4.0) * (1.0-uCloud*0.75);
    vec3 md = normalize(vec3(-uSunDir.x, abs(uSunDir.y)*0.85+0.25, -uSunDir.z));
    float mo = dot(d, md);
    col += vec3(0.85,0.90,1.0)*smoothstep(0.9990,0.99955,mo)*6.0*uNight;
    col += vec3(0.45,0.55,0.85)*pow(sat(mo),190.0)*0.55*uNight;
  }
  // clouds
  if(uCloud > 0.01){
    float c1 = cloudLayer(d, 900.0, 1.0, uTime*0.35);
    float c2 = cloudLayer(d, 2200.0, 0.55, uTime*0.18);
    float c = sat(c1*0.85 + c2*0.55);
    float lit = sat(0.35 + 0.65*pow(sat(mu*0.5+0.5), 2.0));
    vec3 cc = mix(vec3(0.30,0.34,0.42), vec3(1.05,1.02,0.99), lit);
    cc = mix(cc*vec3(0.16,0.19,0.28), cc, 1.0-uNight*0.82);
    cc += uSunColor*pow(sat(mu),22.0)*0.6*c;
    col = mix(col, cc, c*mix(0.86,0.97,uCloud));
  }
  return max(col, vec3(0.0));
}
`;

/* ============================================================
   MAIN — instanced PBR uber shader
   ============================================================ */
SH.mainVS = `
layout(location=0) in vec3 aPOS;
layout(location=1) in vec3 aNRM;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aI0;
layout(location=4) in vec4 aI1;
layout(location=5) in vec4 aI2;
layout(location=6) in vec4 aI3;
layout(location=7) in vec4 aICOL;
layout(location=8) in vec4 aIPAR;

uniform mat4 uVP;

out vec3 vWP;
out vec3 vN;
out vec2 vUV;
out vec3 vLP;
out vec3 vScale;
out vec4 vCol;
out vec4 vPar;
out float vVDepth;
uniform vec3 uCamPos;

void main(){
  mat4 M = mat4(aI0,aI1,aI2,aI3);
  vec4 wp = M*vec4(aPOS,1.0);
  vWP = wp.xyz;
  vec3 c0=M[0].xyz, c1=M[1].xyz, c2=M[2].xyz;
  vec3 s2 = vec3(dot(c0,c0), dot(c1,c1), dot(c2,c2));
  vScale = sqrt(s2);
  mat3 nm = mat3(c0/max(s2.x,1e-8), c1/max(s2.y,1e-8), c2/max(s2.z,1e-8));
  vN = nm*aNRM;
  vUV = aUV;
  vLP = aPOS;
  vCol = aICOL;
  vPar = aIPAR;
  vVDepth = distance(uCamPos, wp.xyz);
  gl_Position = uVP*wp;
}
`;

SH.mainFS = `
${SH.common}
${SH.sky}

in vec3 vWP;
in vec3 vN;
in vec2 vUV;
in vec3 vLP;
in vec3 vScale;
in vec4 vCol;
in vec4 vPar;
in float vVDepth;

uniform vec3  uCamPos;
uniform vec2  uRes;
uniform float uExposureless;

uniform sampler2DShadow uShadow;
uniform mat4  uCsmMat[3];
uniform vec3  uCsmSplit;
uniform float uShadowTexel;
uniform float uShadowStrength;

uniform samplerCube uEnv;
uniform float uEnvMips;
uniform vec3  uAmbSky;
uniform vec3  uAmbGround;
uniform float uAmbStrength;

uniform sampler2D uAO;
uniform float uAOEnabled;

uniform float uFogDensity;
uniform float uFogHeight;
uniform float uWindowLit;
uniform float uDebugLights;

#define MAXL LIGHT_COUNT
uniform vec4 uLPos[MAXL];   // xyz, radius
uniform vec4 uLCol[MAXL];   // rgb*intensity, spotCosInner
uniform vec4 uLDir[MAXL];   // dir.xyz, spotCosOuter (<-1 => omni)
uniform int  uLCount;

out vec4 oColor;

/* ---------------- shading helpers ---------------- */
float D_GGX(float NoH, float a){
  float a2=a*a; float d=NoH*NoH*(a2-1.0)+1.0;
  return a2/max(PI*d*d, 1e-7);
}
float V_Smith(float NoV, float NoL, float a){
  float a2=a*a;
  float gv=NoL*sqrt(NoV*NoV*(1.0-a2)+a2);
  float gg=NoV*sqrt(NoL*NoL*(1.0-a2)+a2);
  return 0.5/max(gv+gg,1e-6);
}
vec3 F_Schlick(vec3 f0, float u){ float f=pow(1.0-u,5.0); return f0 + (1.0-f0)*f; }
vec3 envBRDFApprox(vec3 f0, float rough, float NoV){
  const vec4 c0=vec4(-1.0,-0.0275,-0.572,0.022);
  const vec4 c1=vec4(1.0,0.0425,1.04,-0.04);
  vec4 r=rough*c0+c1;
  float a004=min(r.x*r.x, exp2(-9.28*NoV))*r.x+r.y;
  vec2 AB=vec2(-1.04,1.04)*a004+r.zw;
  return f0*AB.x+AB.y;
}

vec3 brdf(vec3 N, vec3 V, vec3 L, vec3 alb, float rough, float metal, out vec3 kd){
  vec3 H=normalize(V+L);
  float NoL=sat(dot(N,L)), NoV=abs(dot(N,V))+1e-5, NoH=sat(dot(N,H)), VoH=sat(dot(V,H));
  float a=max(rough*rough, 0.0018);
  vec3 f0=mix(vec3(0.04), alb, metal);
  vec3 F=F_Schlick(f0,VoH);
  float D=D_GGX(NoH,a);
  float Vis=V_Smith(NoV,NoL,a);
  vec3 spec=D*Vis*F;
  kd=(1.0-F)*(1.0-metal);
  return (kd*alb/PI + spec)*NoL;
}

/* ---------------- shadows ---------------- */
float sampleCascade(int idx, vec3 wp, vec3 N, float NoL){
  vec4 sc = uCsmMat[idx]*vec4(wp + N*(0.030 + 0.22*float(idx)),1.0);
  vec3 p = sc.xyz/sc.w;
  p = p*0.5+0.5;
  if(p.z>1.0) return 1.0;
  float bias = (0.00045 + 0.0016*(1.0-NoL))*(1.0+float(idx)*1.5);
  p.z -= bias;
  if(p.x<0.0||p.x>1.0||p.y<0.0||p.y>1.0) return 1.0;
  float u = (p.x + float(idx))/3.0;
  float tx = uShadowTexel;
  #ifdef SOFT_SHADOW
    // rotated Poisson disc: softer than a grid and it dithers the banding away
    const vec2 D[8] = vec2[8](
      vec2(-0.326,-0.406), vec2(-0.840,-0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
      vec2( 0.962,-0.195), vec2( 0.473,-0.480), vec2( 0.519, 0.767), vec2( 0.185,-0.893));
    float ang = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898,78.233)))*43758.5453)*6.2831853;
    float ca = cos(ang), sa = sin(ang);
    float spread = 1.55;
    float sum = texture(uShadow, vec3(u, p.y, p.z));
    for(int i=0;i<8;i++){
      vec2 o = vec2(D[i].x*ca - D[i].y*sa, D[i].x*sa + D[i].y*ca)*spread*tx;
      sum += texture(uShadow, vec3(u + o.x/3.0, p.y + o.y, p.z));
    }
    return sum/9.0;
  #else
    return texture(uShadow, vec3(u,p.y,p.z));
  #endif
}
float shadowFactor(vec3 wp, vec3 N, float NoL, float vdep){
  if(uShadowStrength<0.01) return 1.0;
  int idx = vdep<uCsmSplit.x ? 0 : (vdep<uCsmSplit.y ? 1 : 2);
  float s = sampleCascade(idx, wp, N, NoL);
  // fade out at the far edge of the last cascade
  float fade = 1.0 - smoothstep(uCsmSplit.z*0.78, uCsmSplit.z, vdep);
  s = mix(1.0, s, fade);
  return mix(1.0, s, uShadowStrength);
}

/* ---------------- procedural materials ---------------- */
struct Surf { vec3 alb; float rough; float metal; vec3 emis; vec3 nrm; float ao; };

void matFacade(inout Surf s, vec3 lp, vec3 nrm, vec3 scale, float seed){
  bool faceX = abs(nrm.x) > 0.5;
  vec2 uv = faceX ? vec2(lp.z*scale.z, (lp.y+0.5)*scale.y) : vec2(lp.x*scale.x, (lp.y+0.5)*scale.y);
  if(abs(nrm.y) > 0.7){                       // roof deck
    float n = fbm(vec2(lp.x*scale.x, lp.z*scale.z)*0.6);
    s.alb = mix(vec3(0.050,0.051,0.055), vec3(0.098,0.096,0.090), n);
    s.rough = 0.93 - 0.09*n;
    s.metal = 0.0;
    return;
  }

  float style = floor(seed/100.0);            // 0 modern · 1 masonry · 2 curtain wall · 3 panel
  float sd = fract(seed*0.0137)*10.0;
  vec3 wall = vCol.rgb;
  float grain = fbm(uv*2.6)*0.5 + fbm(uv*13.0)*0.22;

  float floorH, bayW;
  vec2 wsz;
  float mull = 0.0;

  if(style < 0.5){                            // modern office grid
    floorH = mix(3.4,4.3,hash11(seed*1.7)); bayW = mix(2.8,4.0,hash11(seed*3.1+0.3));
    wsz = vec2(0.34,0.33);
  } else if(style < 1.5){                     // masonry: punched windows, brick coursing
    floorH = mix(3.2,3.9,hash11(seed*1.7)); bayW = mix(2.6,3.4,hash11(seed*3.1+0.3));
    wsz = vec2(0.22,0.30);
  } else if(style < 2.5){                     // glass curtain wall
    floorH = mix(3.5,4.2,hash11(seed*1.7)); bayW = mix(1.5,2.2,hash11(seed*3.1+0.3));
    wsz = vec2(0.46,0.45);
    mull = 1.0;
  } else {                                    // precast panel with slot windows
    floorH = mix(3.3,4.0,hash11(seed*1.7)); bayW = mix(4.6,7.0,hash11(seed*3.1+0.3));
    wsz = vec2(0.40,0.19);
  }

  vec2 g = vec2(uv.x/bayW, (uv.y+0.6)/floorH);
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 d = abs(f-0.5) - wsz;
  float win = 1.0 - step(0.0, max(d.x,d.y));

  // ground floor is a shopfront / lobby, not a repeat of the office bay
  float ground = step(uv.y, floorH*0.95);
  win = mix(win, 1.0 - step(0.0, max(abs(f.x-0.5)-0.44, abs(f.y-0.46)-0.40)), ground);

  if(style > 0.5 && style < 1.5){
    // brick coursing: offset rows of small units
    float course = floor(uv.y*20.0);
    float bx = uv.x*7.0 + mod(course, 2.0)*0.5;
    float mortar = smoothstep(0.045,0.0, min(fract(bx), 1.0-fract(bx)))
                 + smoothstep(0.10,0.0, min(fract(uv.y*20.0), 1.0-fract(uv.y*20.0)));
    vec3 brick = wall*mix(0.80,1.20, hash12(vec2(floor(bx), course)));
    wall = mix(brick, wall*0.62, sat(mortar)*0.55);
    // stone sill + lintel around each opening
    float sill = smoothstep(0.055,0.0, abs(f.y-(0.5-wsz.y)-0.02))*step(abs(f.x-0.5), wsz.x+0.08);
    float lint = smoothstep(0.045,0.0, abs(f.y-(0.5+wsz.y)-0.02))*step(abs(f.x-0.5), wsz.x+0.08);
    wall = mix(wall, vec3(0.42,0.40,0.37), sat(sill+lint)*(1.0-win));
  } else {
    vec3 wallB = wall*mix(0.74,1.20,hash12(cell*0.37+seed));
    wall = mix(wall, wallB, 0.18);
  }

  wall *= 0.82 + 0.32*grain;
  float streak = sat(fbm(vec2(uv.x*3.0, uv.y*0.13))*1.5-0.42);
  wall *= 1.0 - streak*0.28;

  // spandrel / slab band between floors
  float band = smoothstep(0.055,0.0,abs(f.y-0.985)) + smoothstep(0.05,0.0,abs(f.y-0.015));
  wall = mix(wall, wall*(style > 1.5 && style < 2.5 ? 0.42 : 0.68), sat(band)*0.85);

  // mullions on curtain-wall towers
  if(mull > 0.5){
    float m = smoothstep(0.055,0.0,abs(f.x-0.5)-0.46);
    wall = mix(wall, vec3(0.20,0.21,0.23), m*0.9);
  }

  float lit = step(hash12(cell + vec2(seed*17.0, seed*7.0)), uWindowLit);
  vec3 litCol = vec3(1.0,0.80,0.50)*mix(0.55,1.0,hash12(cell*1.31+seed));
  litCol = mix(litCol, vec3(0.62,0.86,1.0), step(0.72, hash12(cell*2.7+seed)));
  litCol = mix(litCol, vec3(0.55,1.0,0.75), step(0.93, hash12(cell*5.1+seed)));

  vec3 glass = mix(vec3(0.020,0.028,0.042), vec3(0.026,0.040,0.055), step(1.5, style));
  s.alb   = mix(wall, glass, win);
  s.rough = mix(0.80-0.20*grain, style > 1.5 && style < 2.5 ? 0.045 : 0.075, win);
  s.metal = mix(0.0, 0.34, win);
  s.emis  = litCol*win*lit*uWindowLit*2.35;
  s.ao    = mix(1.0, 0.78, win);
}

void matAsphalt(inout Surf s, vec3 wp, vec3 lp, vec3 scale, float seed){
  float n = fbm3(wp.xz*1.35);
  float fine = vnoise(wp.xz*22.0);
  vec3 base = mix(vec3(0.052,0.054,0.058), vec3(0.108,0.108,0.114), n);
  base *= 0.84+0.32*fine;
  // tar seams + patches
  float seam = smoothstep(0.020,0.0,abs(fract(wp.x*0.062+0.5)-0.5)-0.006);
  base = mix(base, base*0.60, seam*0.55);
  float blotch = smoothstep(0.62,0.74, fbm3(wp.xz*0.55));
  base = mix(base, base*1.35, blotch*0.5);

  float paint = 0.0;
  vec3 pc = vec3(0.0);
  float ax = lp.x*scale.x;
  float az = lp.z*scale.z;

  if(seed > 0.5 && seed < 1.5){
    // --- straight road: double centre line, lane dashes, edge lines ---
    float centre = smoothstep(0.105,0.055, abs(abs(ax)-0.20));
    float dash   = step(fract(az/9.0), 0.40);
    float lane   = smoothstep(0.105,0.055, abs(abs(ax)-3.70))*dash;
    float edge   = smoothstep(0.115,0.065, abs(abs(ax)-6.85));
    float white  = max(lane, edge);
    // stop bar near each end of the segment
    float stopbar = smoothstep(0.32,0.20, abs(abs(az)-(scale.z*0.5-1.1))) * step(0.25, abs(ax)) * step(abs(ax), 7.0);
    white = max(white, stopbar);
    float wear = 0.62+0.38*vnoise(wp.xz*9.0);
    paint = max(centre, white);
    pc = mix(vec3(0.50,0.49,0.46), vec3(0.46,0.33,0.045), centre>white?1.0:0.0);
    paint *= wear;
  } else if(seed > 1.5){
    // --- intersection: zebra crossings on all four approaches ---
    float cw = 0.0;
    if(abs(az) > 4.55 && abs(az) < 6.95 && abs(ax) < 4.45) cw = max(cw, step(fract(ax/1.15+0.5), 0.55));
    if(abs(ax) > 4.55 && abs(ax) < 6.95 && abs(az) < 4.45) cw = max(cw, step(fract(az/1.15+0.5), 0.55));
    paint = cw*(0.60+0.40*vnoise(wp.xz*9.0));
    pc = vec3(0.50,0.49,0.46);
  }

  s.alb = mix(base, pc, sat(paint*0.92));
  s.rough = mix(0.92-0.16*fine, 0.58, sat(paint));
  s.metal = 0.0;
  if(uWet>0.01){
    float pn = fbm3(wp.xz*0.19) + 0.35*fbm3(wp.xz*0.9);
    float pud = smoothstep(0.60,0.86,pn)*uWet;
    s.rough = mix(s.rough, 0.035, pud);
    s.alb = mix(s.alb, s.alb*0.35, pud);
    s.rough = mix(s.rough, s.rough*0.42, uWet*0.85);
    s.alb *= mix(1.0, 0.72, uWet);
    s.metal = mix(s.metal, 0.14, pud);
  }
}

void matConcrete(inout Surf s, vec3 wp, vec3 lp, vec3 scale){
  float n = fbm3(wp.xz*1.9);
  s.alb = mix(vec3(0.20,0.202,0.198), vec3(0.315,0.315,0.305), n);
  // slab joints every 2m
  vec2 j = abs(fract(wp.xz*0.5)-0.5);
  float joint = smoothstep(0.030,0.0,min(j.x,j.y)-0.455);
  s.alb *= 1.0-joint*0.42;
  s.rough = 0.86-0.10*n;
  s.metal = 0.0;
  s.ao = 1.0-joint*0.3;
  if(uWet>0.01){ s.rough=mix(s.rough,0.30,uWet*0.7); s.alb*=mix(1.0,0.72,uWet); }
}

void matGrass(inout Surf s, vec3 wp){
  float n = fbm3(wp.xz*2.6);
  float m = fbm3(wp.xz*0.32);
  float t = sat(n*0.7+m*0.5);
  s.alb = mix(vec3(0.042,0.062,0.030), vec3(0.098,0.128,0.056), t);
  // dry patches
  s.alb = mix(s.alb, vec3(0.115,0.105,0.062), smoothstep(0.62,0.86,m)*0.55);
  s.rough = 0.96; s.metal = 0.0;
  s.ao = 0.86+0.14*t;
}

void matTire(inout Surf s, vec3 lp, vec3 nrm){
  float band = abs(nrm.y)>0.55 ? 0.0 : 1.0;
  float tread = 0.5+0.5*sin(atan(lp.y,lp.z)*54.0);
  s.alb = vec3(0.0165,0.0168,0.018)*(0.80+0.35*tread*band);
  s.rough = 0.80-0.12*tread*band;
  s.metal = 0.0;
}

void matRoadPaint(inout Surf s, vec3 wp){
  float n = vnoise(wp.xz*26.0);
  s.alb = vCol.rgb*(0.80+0.30*n);
  s.rough = 0.62;
  s.metal = 0.0;
  if(uWet>0.01) s.rough = mix(s.rough, 0.20, uWet);
}

void matFoliage(inout Surf s, vec3 wp, vec3 lp){
  float n = fbm3(lp.xz*3.4+wp.xz*0.21);
  s.alb = vCol.rgb*(0.48+0.62*n);
  s.rough = 0.90; s.metal=0.0;
  s.ao = 0.62+0.34*n;
}

void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vWP);
  if(dot(N,V) < 0.0 && vPar.z > 0.5 && vPar.z < 1.5) N = N; // keep facades single sided
  float matId = vPar.z;

  Surf s;
  s.alb = vCol.rgb; s.rough = max(vCol.a,0.03); s.metal = vPar.x; s.emis = vec3(0.0); s.ao = 1.0;
  float seed = vPar.w;

  if(matId < 0.5){
    // 0 : car paint / plain painted surface
    float ff = pow(1.0-sat(dot(N,V)),5.0);
    s.rough = max(s.rough, 0.02);
  } else if(matId < 1.5){
    matFacade(s, vLP, normalize(vN), vScale, seed);
  } else if(matId < 2.5){
    matAsphalt(s, vWP, vLP, vScale, seed);
  } else if(matId < 3.5){
    matConcrete(s, vWP, vLP, vScale);
  } else if(matId < 4.5){
    matRoadPaint(s, vWP);
  } else if(matId < 5.5){
    // 5 : emissive (seed 1 = street lamp, seed 2 = sign — both dim in daylight)
    float gate = 1.0;
    if(seed > 0.5 && seed < 1.5) gate = smoothstep(0.05, 0.45, uNight);
    else if(seed > 1.5) gate = 0.22 + 0.78*smoothstep(0.0, 0.40, uNight);
    s.emis = vCol.rgb*vPar.y*gate;
    s.alb = vCol.rgb*0.34;      // the lens is still coloured with the lamp off
    s.rough = 0.22;
    s.metal = 0.05;
  } else if(matId < 6.5){
    matTire(s, vLP, normalize(vN));
  } else if(matId < 7.5){
    // 7 : polished metal / chrome
    s.metal = 1.0;
  } else if(matId < 8.5){
    matGrass(s, vWP);
  } else if(matId < 9.5){
    matFoliage(s, vWP, vLP);
  } else if(matId < 10.5){
    // 10 : dark tinted glass (opaque variant, e.g. car windows seen from outside)
    s.alb = vec3(0.012,0.014,0.020);
    s.rough = 0.045; s.metal = 0.06;
  } else if(matId < 11.5){
    // 11 : rough plastic trim
    float n = vnoise(vWP.xz*30.0+vLP.yz*8.0);
    s.alb = vCol.rgb*(0.88+0.2*n);
    s.rough = 0.66;
  }
  s.emis += vCol.rgb*vPar.y*step(matId,0.5);

  float NoV = sat(dot(N,V));
  vec3 f0 = mix(vec3(0.04), s.alb, s.metal);

  /* ---- ambient occlusion ---- */
  float ao = s.ao;
  if(uAOEnabled>0.5){
    ao *= mix(1.0, texture(uAO, gl_FragCoord.xy/uRes).r, 0.82);
  }
  ao = max(ao, 0.16);

  /* ---- direct sun ---- */
  vec3 L = uSunDir;
  float NoL = sat(dot(N,L));
  vec3 col = vec3(0.0);
  vec3 kd;
  if(NoL > 0.0){
    float sh = shadowFactor(vWP, N, NoL, vVDepth);
    if(sh > 0.001) col += brdf(N,V,L,s.alb,s.rough,s.metal,kd)*uSunColor*sh;
  }

  /* ---- image based ambient ---- */
  vec3 R = reflect(-V, N);
  float lod = sqrt(s.rough)*uEnvMips;
  vec3 spec = textureLod(uEnv, R, lod).rgb;
  vec3 irr  = textureLod(uEnv, N, uEnvMips-0.6).rgb;
  vec3 hemi = mix(uAmbGround, uAmbSky, sat(N.y*0.5+0.5));
  vec3 diffAmb = mix(hemi, irr, 0.50)*uAmbStrength*1.30;
  col += s.alb*(1.0-s.metal)*diffAmb*ao;
  // cheap single-bounce fudge: sunlight kicked back off the ground
  col += s.alb*(1.0-s.metal)*uSunColor*0.055*sat(0.65-N.y*0.65)*sat(uSunDir.y*3.0)*ao;
  col += spec*envBRDFApprox(f0, s.rough, NoV)*ao*mix(0.55,1.0,sat(N.y*0.5+0.5))*uAmbStrength;

  /* ---- punctual lights ---- */
  vec3 punct = vec3(0.0);
  for(int i=0;i<MAXL;i++){
    if(i>=uLCount) break;
    vec3 dp = uLPos[i].xyz - vWP;
    float dist2 = dot(dp,dp);
    float rad = uLPos[i].w;
    if(dist2 > rad*rad) continue;
    float dist = sqrt(max(dist2,1e-6));
    vec3 Ld = dp/dist;
    float atten = sq(sat(1.0 - sq(dist2/(rad*rad))))/(dist2+1.0);
    float cone = 1.0;
    float cosOuter = uLDir[i].w;
    if(cosOuter > -1.0){
      float cd = dot(-Ld, uLDir[i].xyz);
      cone = sat((cd-cosOuter)/max(uLCol[i].w-cosOuter,1e-3));
      cone *= cone;
      if(cone<=0.0) continue;
    }
    float nl = sat(dot(N,Ld));
    if(nl<=0.0) continue;
    punct += brdf(N,V,Ld,s.alb,s.rough,s.metal,kd)*uLCol[i].rgb*atten*cone;
  }
  col += punct;
  if(uDebugLights > 0.5){ oColor = vec4(punct*uDebugLights, 1.0); return; }
  if(uDebugLights < -0.5){ oColor = vec4(N*0.5+0.5, 1.0); return; }

  col += s.emis;

  /* ---- fog / aerial perspective ---- */
  float dist = vVDepth;
  float hf = exp(-max(vWP.y-1.0,0.0)/max(uFogHeight,1.0));
  float fogAmt = 1.0 - exp(-dist*uFogDensity*mix(0.35,1.0,hf));
  vec3 fogCol = skyFog(-V);
  fogCol += uSunColor*pow(sat(dot(-V,uSunDir)),6.0)*0.35*(1.0-uNight);
  col = mix(col, fogCol, sat(fogAmt));

  oColor = vec4(max(col,vec3(0.0)), 1.0);
}
`;
