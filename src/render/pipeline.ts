// Frame pipeline: scene → HDR target (+depth) → ray-marched tornado volume at
// reduced resolution → composite, tone-map and grade to the screen.
//
// The condensation funnel is not modelled as a shape. At every sample the
// shader evaluates the same cyclostrophic pressure field the physics uses and
// asks whether air there has been decompressed enough to reach saturation:
//     y + Δp(r, y) / (ρ g)  >  cloud-base height
// so the funnel's width, taper and whether it reaches the ground all follow
// from wind speed, core size and humidity.

import * as THREE from 'three';
import { env, LIGHT_GLSL } from './environment';
import { GRAV, LUT_N, LUT_RMAX, MAX_SUB, type Tornado } from '../physics/tornado';

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const VOL_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
${LIGHT_GLSL}
uniform sampler2D tDepth;
uniform sampler3D tNoise;
uniform sampler2D tLut;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uNear, uFar;
uniform vec3 uCenter;
uniform vec4 uAxis;   // tilt x, tilt z, meander amplitude, cloud base H
uniform vec4 uCore;   // rc, vmax, flare, rotation sign
uniform vec4 uSubP;   // sub rc, sub vmax, sub count, tornado time
uniform vec4 uSub[${MAX_SUB}];
uniform vec4 uWall;   // wall-cloud radius, depth, bounding radius, noise tile size
uniform vec4 uDust;   // amount, height scale, ring width, updraft speed
uniform vec3 uDustColor;
uniform float uSteps;
uniform float uFrame;
varying vec2 vUv;

const float G = ${GRAV.toFixed(2)};

vec2 lutv(float rbar) {
  float u = sqrt(clamp(rbar / ${LUT_RMAX.toFixed(1)}, 0.0, 1.0));
  return texture(tLut, vec2(u * ${((LUT_N - 1) / LUT_N).toFixed(6)} + ${(0.5 / LUT_N).toFixed(6)}, 0.5)).rg;
}

vec2 axisAt(float y) {
  float H = uAxis.w, T = uSubP.w;
  float s = min(y / H, 1.3);
  return uCenter.xz + uAxis.xy * y
    + uAxis.z * s * vec2(sin(y * 6.9813 / H + T * 0.31 + 1.0), cos(y * 4.8332 / H - T * 0.23));
}

// Two-phase advected noise: the pattern is carried round the axis at the local
// angular velocity and lifted by the updraft, then cross-faded before it shears apart.
float swirl(vec2 d, float y, float omega, float rise, float tile) {
  const float PERIOD = 5.0;
  float t = uTime / PERIOD;
  float p1 = fract(t), p2 = fract(t + 0.5);
  float w1 = 1.0 - abs(2.0 * p1 - 1.0);
  float a1 = omega * (p1 - 0.5) * PERIOD, a2 = omega * (p2 - 0.5) * PERIOD;
  vec3 q1 = vec3(d.x * cos(a1) - d.y * sin(a1), (y - rise * (p1 - 0.5) * PERIOD) * 0.42, d.x * sin(a1) + d.y * cos(a1)) / tile;
  vec3 q2 = vec3(d.x * cos(a2) - d.y * sin(a2), (y - rise * (p2 - 0.5) * PERIOD) * 0.42, d.x * sin(a2) + d.y * cos(a2)) / tile + 0.37;
  float n1 = texture(tNoise, q1).r * 0.62 + texture(tNoise, q1 * 3.1).r * 0.38;
  float n2 = texture(tNoise, q2).r * 0.62 + texture(tNoise, q2 * 3.1).r * 0.38;
  return mix(n2, n1, w1);
}

// Condensation excess (m) of the parent vortex only — used for cheap self-shadowing.
float excessAt(vec3 p) {
  float H = uAxis.w;
  float y = max(p.y, 0.0);
  float hn = clamp(y / H, 0.0, 1.2);
  float r = length(p.xz - axisAt(y)) + 1e-3;
  float rcz = uCore.x * (1.0 + uCore.z * hn * sqrt(hn));
  float lift = uCore.y * uCore.y * uCore.x / rcz * lutv(r / rcz).x / G;
  float edge = 1.0 - smoothstep(0.5 * uWall.z, 0.97 * uWall.z, length(p.xz - uCenter.xz));
  return y + (lift + uWall.y * exp(-(r * r) / (uWall.x * uWall.x))) * edge - H;
}

void main() {
  // ---- reconstruct the view ray
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rdv = normalize((uInvProj * vec4(ndc, 1.0, 1.0)).xyz);
  vec3 rd = normalize((uCamWorld * vec4(rdv, 0.0)).xyz);
  vec3 ro = uCamPos;
  float depth = texture(tDepth, vUv).r;
  float viewZ = (uNear * uFar) / ((uFar - uNear) * depth - uFar);
  float tEnd = viewZ / rdv.z;
  if (rd.y < -1e-5) tEnd = min(tEnd, -ro.y / rd.y);

  // ---- bounding cylinder around the tornado and its wall cloud
  float H = uAxis.w;
  float Rb = uWall.z;
  vec2 oc = ro.xz - uCenter.xz;
  float a = dot(rd.xz, rd.xz);
  float b = dot(oc, rd.xz);
  float c = dot(oc, oc) - Rb * Rb;
  float disc = b * b - a * c;
  if (disc <= 0.0 || a < 1e-9 || uCore.y < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float sq = sqrt(disc);
  float t0 = max((-b - sq) / a, 0.0);
  float t1 = min((-b + sq) / a, tEnd);
  if (rd.y > 1e-5) t1 = min(t1, (H + 20.0 - ro.y) / rd.y);
  if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float rc = uCore.x, vmax = uCore.y, rot = uCore.w;
  float tile = uWall.w;
  float ampBase = clamp(0.3 * rc + 5.0, 7.0, 55.0);
  float hd = uDust.y;
  vec2 sunAz = normalize(uSunDir.xz);

  // interleaved-gradient jitter hides step banding
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uFrame * vec2(5.588, 3.37), vec2(0.06711056, 0.00583715))));
  float t = t0 + jitter * 3.0;
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  int steps = int(uSteps);

  for (int i = 0; i < 160; i++) {
    if (i >= steps || t >= t1 || trans < 0.012) break;
    vec3 p = ro + rd * t;
    float y = max(p.y, 0.0);
    float hn = clamp(y / H, 0.0, 1.2);
    vec2 ax = axisAt(y);
    vec2 d = p.xz - ax;
    float r = length(d) + 1e-3;
    float rcz = rc * (1.0 + uCore.z * hn * sqrt(hn));
    float vm2 = vmax * vmax * rc / rcz;
    vec2 L = lutv(r / rcz);
    float lift = vm2 * L.x / G;            // Δp / ρg in metres
    float dl = vm2 * L.y * L.y / (G * r);  // |∂lift/∂r|
    float omega = sqrt(vm2) * L.y / r * rot;
    float rPar = r;

    // sub-vortices: each adds its own pressure well and dust column
    float subDust = 0.0;
    int ns = int(uSubP.z);
    if (ns > 0) {
      float tw = y * 0.0045 * rot;
      float ct = cos(tw), st = sin(tw);
      float fade = exp(-y / (0.7 * H));
      float rcs = uSubP.x * (1.0 + 1.5 * hn);
      for (int k = 0; k < ${MAX_SUB}; k++) {
        if (k >= ns) break;
        vec2 cs = vec2(uSub[k].x * ct - uSub[k].y * st, uSub[k].y * ct + uSub[k].x * st);
        vec2 ds = p.xz - (ax + 0.8 * rcz * cs);
        float rs = length(ds) + 1e-3;
        vec2 Ls = lutv(rs / rcs);
        float vs = uSubP.y * uSub[k].z * fade;
        lift += vs * vs * Ls.x / G;
        float dls = vs * vs * Ls.y * Ls.y / (G * rs);
        if (dls > dl) { dl = dls; d = ds; r = rs; omega = vs * Ls.y / rs * rot; }
        float q = rs / (rcs * 1.6);
        subDust += uSub[k].z * exp(-q * q) * exp(-y / (hd * 1.4));
      }
    }

    float edge = 1.0 - smoothstep(0.5 * Rb, 0.97 * Rb, length(p.xz - uCenter.xz));
    float wall = uWall.y * exp(-(rPar * rPar) / (uWall.x * uWall.x));
    float e0 = y + (lift + wall) * edge - H;
    float amp = (ampBase * 0.45 + 0.03 * r * dl + 0.085 * H * hn * hn) * (0.15 + 0.85 * edge);

    // dust / debris cloud envelope (analytic, before noise)
    float rb0 = rPar / rc;
    float ring = (rb0 - 1.0) / uDust.z;
    float dustEnv = uDust.x * (exp(-ring * ring) * exp(-y / hd) + 0.6 * exp(-rb0 * rb0 / 1.3) * exp(-y / (3.5 * hd)) + 1.2 * subDust);

    float gradMag = sqrt(1.0 + dl * dl);
    float ds;
    if (e0 + amp * 0.55 < 0.0 && dustEnv < 0.006) {
      // empty air: stride toward the nearest surface that could hold cloud
      ds = clamp(min(-(e0 + amp * 0.55) / gradMag * 0.65, 0.33 * r + 4.0), 2.0, 400.0);
      t += ds;
      continue;
    }

    float n = swirl(d, y, omega, uDust.w * (0.3 + 0.7 * exp(-rb0 * rb0 * 0.4)), tile);
    float e = e0 + (n - 0.5) * 2.0 * amp;
    float soft = 0.7 * amp + 2.5;
    float cond = smoothstep(0.0, soft, e);
    float sc = cond * 0.085;
    float sd = dustEnv * (0.15 + 1.7 * n * n) * 0.04 * clamp(60.0 / rc, 0.3, 1.0);
    float sigma = sc + sd;
    ds = clamp(0.04 * r + 1.2, 1.5, 9.0);
    if (cond < 0.01) ds = min(max(ds, 0.12 * (rc + hd)), 22.0);
    ds *= 1.0 + t * 0.0006;

    if (sigma > 1e-4) {
      // outward normal of the condensation surface from the analytic gradient
      vec3 N = normalize(vec3(d.x / r * dl, -1.0, d.y / r * dl));
      float horiz = sqrt(max(1.0 - N.y * N.y, 0.0));
      float wrap = 0.5 + 0.5 * dot(normalize(N.xz + 1e-5), sunAz);
      // self-shadowing: is there cloud between this sample and the bright side of the sky?
      float eL = excessAt(p + vec3(sunAz.x, 0.12, sunAz.y) * (0.7 * r + 12.0));
      float vis = 1.0 - smoothstep(-0.4 * amp, 1.2 * amp, eL);
      float lit = wrap * wrap * (0.25 + 0.75 * vis);
      // light arrives sideways from the clear horizon band; undersides only get ground bounce
      // (undersides take the colour of the storm base so the wall cloud blends into the deck)
      vec3 amb = uHorizonColor * horiz * (0.035 + 0.2 * lit) + mix(uZenithColor * 1.1, uSkyColor * 0.1, horiz) + uGroundColor * 0.25 * horiz;
      vec3 sun = uSunColor * max(dot(N, uSunDir), 0.0) * 0.55 * vis;
      float depthDark = mix(1.0, 0.5, smoothstep(0.45 * H, 0.95 * H, y));
      vec3 flash = uFlash * vec3(0.7, 0.78, 1.0) * 0.5;
      vec3 cCloud = 0.82 * (amb + sun + flash) * (0.72 + 0.56 * n) * depthDark;
      vec3 cDust = uDustColor * (amb * 3.2 + sun + uSkyColor * 0.3 + flash) * (0.4 + 0.95 * n);
      vec3 col = (cCloud * sc + cDust * sd) / sigma;
      col = applyFog(col, t);
      float al = 1.0 - exp(-sigma * ds);
      acc += trans * al * col;
      trans *= 1.0 - al;
    }
    t += ds;
  }
  gl_FragColor = vec4(acc, trans);
}`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tVol;
uniform sampler2D tAo;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uFrame;
uniform float uBloom;
uniform vec2 uVolTexel;
uniform vec2 uAoTexel;
varying vec2 vUv;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 scene = texture(tScene, vUv).rgb;
  // small tent filter over the half-resolution volume to hide its pixel grid
  vec4 vol = texture(tVol, vUv) * 0.4
    + texture(tVol, vUv + uVolTexel * vec2(0.75, 0.25)) * 0.15
    + texture(tVol, vUv + uVolTexel * vec2(-0.75, -0.25)) * 0.15
    + texture(tVol, vUv + uVolTexel * vec2(-0.25, 0.75)) * 0.15
    + texture(tVol, vUv + uVolTexel * vec2(0.25, -0.75)) * 0.15;
  // ambient occlusion, blurred across its 4x4 jitter pattern
  float ao = (texture(tAo, vUv + uAoTexel * vec2(-1.0, -1.0)).r + texture(tAo, vUv + uAoTexel * vec2(1.0, -1.0)).r
    + texture(tAo, vUv + uAoTexel * vec2(-1.0, 1.0)).r + texture(tAo, vUv + uAoTexel * vec2(1.0, 1.0)).r) * 0.25;
  vec3 c = scene * ao * vol.a + vol.rgb;
  c *= uExposure;
  // glow around anything brighter than the scene can show: lightning, lamps, beacons, arcs
  c += texture(tBloom, vUv).rgb * uBloom;
  // slight storm-light grade: cool shadows, soft desaturation
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 0.92);
  c = aces(c * 1.35);
  c = pow(c, vec3(1.0 / 2.2));
  vec2 v = vUv - 0.5;
  c *= 1.0 - dot(v, v) * 0.42;
  float grain = fract(sin(dot(gl_FragCoord.xy + uFrame, vec2(12.9898, 78.233))) * 43758.5453);
  c += (grain - 0.5) * 0.018;
  gl_FragColor = vec4(c, 1.0);
}`;

// Screen-space ambient occlusion from the depth buffer. The ground is not in the depth
// buffer (it is an analytic plane), so each sample falls back to the ray / plane hit.
const AO_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uNear, uFar;
uniform vec2 uTexel;
uniform vec2 uProj;   // world metre -> uv at unit distance (x, y)
varying vec2 vUv;

vec4 posAt(vec2 uv) {
  vec3 rdv = normalize((uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0)).xyz);
  vec3 rd = normalize((uCamWorld * vec4(rdv, 0.0)).xyz);
  float depth = texture(tDepth, uv).r;
  float t = 1e9;
  if (depth < 0.999999) t = ((uNear * uFar) / ((uFar - uNear) * depth - uFar)) / rdv.z;
  if (rd.y < -1e-4) t = min(t, -uCamPos.y / rd.y);
  return vec4(uCamPos + rd * t, t);
}

void main() {
  vec4 P = posAt(vUv);
  if (P.w > 1400.0) { gl_FragColor = vec4(1.0); return; }
  // normal from the nearer neighbour on each axis, so silhouettes do not smear it
  vec3 l = P.xyz - posAt(vUv - vec2(uTexel.x, 0.0)).xyz, r = posAt(vUv + vec2(uTexel.x, 0.0)).xyz - P.xyz;
  vec3 d = P.xyz - posAt(vUv - vec2(0.0, uTexel.y)).xyz, u = posAt(vUv + vec2(0.0, uTexel.y)).xyz - P.xyz;
  vec3 n = normalize(cross(dot(l, l) < dot(r, r) ? l : r, dot(d, d) < dot(u, u) ? d : u));
  if (dot(n, P.xyz - uCamPos) > 0.0) n = -n;

  const float R = 1.9;
  vec2 rad = clamp(R * uProj / P.w, uTexel * 2.5, vec2(0.07));
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float occ = 0.0;
  for (int i = 0; i < 9; i++) {
    float a = (jitter + float(i) * 0.381966) * 6.2831853;
    float k = sqrt((float(i) + 0.5) / 9.0);
    vec4 S = posAt(vUv + vec2(cos(a), sin(a)) * rad * k);
    vec3 v = S.xyz - P.xyz;
    float len = length(v) + 1e-4;
    occ += max(dot(n, v) / len - 0.14, 0.0) * smoothstep(R * 2.6, R * 0.6, len);
  }
  float ao = clamp(1.0 - occ * 0.3, 0.0, 1.0);
  ao = mix(ao, 1.0, smoothstep(500.0, 1400.0, P.w));
  gl_FragColor = vec4(vec3(ao), 1.0);
}`;

// Bloom: bright pass, then a box-filtered mip chain added back up level by level.
const BRIGHT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tVol;
uniform float uExposure;
varying vec2 vUv;
void main() {
  vec4 vol = texture(tVol, vUv);
  vec3 c = min((texture(tScene, vUv).rgb * vol.a + vol.rgb) * uExposure, vec3(40.0));
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * max(l - 1.45, 0.0) / max(l, 1e-4), 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uGain;
varying vec2 vUv;
void main() {
  vec3 c = texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
    + texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c * 0.25 * uGain, 1.0);
}`;

const BLOOM_LEVELS = 5;

export class Pipeline {
  private sceneRT: THREE.WebGLRenderTarget;
  private volRT: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private volMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private aoRT: THREE.WebGLRenderTarget;
  private aoMat: THREE.ShaderMaterial;
  private bloomRT: THREE.WebGLRenderTarget[] = [];
  private brightMat: THREE.ShaderMaterial;
  private downMat: THREE.ShaderMaterial;
  private upMat: THREE.ShaderMaterial;
  /** strength of the glow added around over-bright pixels */
  bloom = 0.55;
  private lutData = new Uint16Array(LUT_N * 2);
  private lutTex: THREE.DataTexture;
  private frame = 0;
  volScale = 0.5;
  exposure = 1;
  steps = 96;
  dustColor = new THREE.Color(0x6b5442);

  constructor(private renderer: THREE.WebGLRenderer, noise: THREE.Data3DTexture) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(size.x, size.y),
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.volRT = new THREE.WebGLRenderTarget(Math.ceil(size.x * this.volScale), Math.ceil(size.y * this.volScale), {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.aoRT = new THREE.WebGLRenderTarget(Math.ceil(size.x / 2), Math.ceil(size.y / 2), {
      depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.bloomRT.push(new THREE.WebGLRenderTarget(Math.max(2, size.x >> (i + 1)), Math.max(2, size.y >> (i + 1)), {
        type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      }));
    }
    this.lutTex = new THREE.DataTexture(this.lutData, LUT_N, 1, THREE.RGFormat, THREE.HalfFloatType);
    this.lutTex.minFilter = this.lutTex.magFilter = THREE.LinearFilter;

    const sub: THREE.Vector4[] = [];
    for (let i = 0; i < MAX_SUB; i++) sub.push(new THREE.Vector4());
    this.volMat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      vertexShader: FS_VERT,
      fragmentShader: VOL_FRAG,
      uniforms: {
        ...env,
        tDepth: { value: this.sceneRT.depthTexture },
        tNoise: { value: noise },
        tLut: { value: this.lutTex },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uNear: { value: 1 },
        uFar: { value: 1000 },
        uCenter: { value: new THREE.Vector3() },
        uAxis: { value: new THREE.Vector4() },
        uCore: { value: new THREE.Vector4() },
        uSubP: { value: new THREE.Vector4() },
        uSub: { value: sub },
        uWall: { value: new THREE.Vector4() },
        uDust: { value: new THREE.Vector4() },
        uDustColor: { value: this.dustColor },
        uSteps: { value: 96 },
        uFrame: { value: 0 },
      },
    });
    this.compMat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      vertexShader: FS_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tVol: { value: this.volRT.texture },
        tAo: { value: this.aoRT.texture },
        tBloom: { value: this.bloomRT[0].texture },
        uExposure: { value: 1 },
        uFrame: { value: 0 },
        uBloom: { value: 0.5 },
        uVolTexel: { value: new THREE.Vector2() },
        uAoTexel: { value: new THREE.Vector2() },
      },
    });
    const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, additive = false) => new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, vertexShader: FS_VERT, fragmentShader, uniforms,
      blending: additive ? THREE.AdditiveBlending : THREE.NoBlending,
    });
    this.aoMat = pass(AO_FRAG, {
      tDepth: { value: this.sceneRT.depthTexture },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uNear: { value: 1 }, uFar: { value: 1000 },
      uTexel: { value: new THREE.Vector2() },
      uProj: { value: new THREE.Vector2() },
    });
    this.brightMat = pass(BRIGHT_FRAG, { tScene: { value: this.sceneRT.texture }, tVol: { value: this.volRT.texture }, uExposure: { value: 1 } });
    this.downMat = pass(BLUR_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uGain: { value: 1 } });
    this.upMat = pass(BLUR_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uGain: { value: 1 } }, true);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.volMat);
    this.quad.frustumCulled = false;
    this.fsScene.add(this.quad);
  }

  /** Upload the pressure / tangential-wind profile for the current tornado configuration. */
  setProfile(tornado: Tornado) {
    for (let i = 0; i < LUT_N; i++) {
      this.lutData[i * 2] = THREE.DataUtils.toHalfFloat(tornado.fP[i]);
      this.lutData[i * 2 + 1] = THREE.DataUtils.toHalfFloat(tornado.fT[i]);
    }
    this.lutTex.needsUpdate = true;
  }

  resize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    // a hidden or collapsed window reports zero size; keep every target valid
    size.x = Math.max(2, size.x); size.y = Math.max(2, size.y);
    this.sceneRT.setSize(size.x, size.y);
    this.volRT.setSize(Math.max(2, Math.ceil(size.x * this.volScale)), Math.max(2, Math.ceil(size.y * this.volScale)));
    this.aoRT.setSize(Math.ceil(size.x / 2), Math.ceil(size.y / 2));
    this.bloomRT.forEach((rt, i) => rt.setSize(Math.max(2, size.x >> (i + 1)), Math.max(2, size.y >> (i + 1))));
  }

  setQuality(volScale: number, steps: number) {
    this.volScale = volScale;
    this.steps = steps;
    this.resize();
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, tornado: Tornado, dustAmount: number) {
    const r = this.renderer;
    const u = this.volMat.uniforms;
    const c = tornado.cfg;
    this.frame = (this.frame + 1) % 1024;

    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    // ---- volume
    const live = tornado.intensity > 0;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCamPos.value.copy(camera.position);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uCenter.value.set(tornado.x, 0, tornado.z);
    u.uAxis.value.set(tornado.tiltX, tornado.tiltZ, tornado.sinA, c.lcl);
    u.uCore.value.set(tornado.rc, live ? tornado.vmax : 0, c.flare, c.rotation);
    u.uSubP.value.set(tornado.rcSub, tornado.vsub, c.subvortices, tornado.time);
    for (let k = 0; k < MAX_SUB; k++) u.uSub.value[k].set(tornado.subCos[k], tornado.subSin[k], tornado.subAmp[k], 0);
    const wallR = 2.2 * tornado.rc + 260;
    const lean = Math.hypot(tornado.tiltX, tornado.tiltZ) * c.lcl + tornado.sinA;
    const tile = Math.min(320, Math.max(40, 1.15 * tornado.rc + 30));
    u.uWall.value.set(wallR, 0.2 * c.lcl * Math.min(1, tornado.intensity * 1.3), 2.5 * wallR + lean, tile);
    const hd = Math.min(170, Math.max(26, 0.5 * tornado.rc + 24)) * (0.4 + 0.6 * tornado.intensity);
    u.uDust.value.set(dustAmount, hd, 1.25, c.updraft * tornado.vmax * 0.5);
    u.uSteps.value = this.steps;
    u.uFrame.value = this.frame;

    this.quad.material = this.volMat;
    r.setRenderTarget(this.volRT);
    r.render(this.fsScene, this.fsCam);

    // ---- ambient occlusion
    const au = this.aoMat.uniforms;
    au.uInvProj.value.copy(camera.projectionMatrixInverse);
    au.uCamWorld.value.copy(camera.matrixWorld);
    au.uCamPos.value.copy(camera.position);
    au.uNear.value = camera.near;
    au.uFar.value = camera.far;
    au.uTexel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    au.uProj.value.set(1 / (2 * tanHalf * camera.aspect), 1 / (2 * tanHalf));
    this.quad.material = this.aoMat;
    r.setRenderTarget(this.aoRT);
    r.render(this.fsScene, this.fsCam);

    // ---- bloom
    this.brightMat.uniforms.uExposure.value = this.exposure;
    this.quad.material = this.brightMat;
    r.setRenderTarget(this.bloomRT[0]);
    r.render(this.fsScene, this.fsCam);
    const autoClear = r.autoClear;
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      const src = this.bloomRT[i - 1];
      this.downMat.uniforms.tSrc.value = src.texture;
      this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.quad.material = this.downMat;
      r.setRenderTarget(this.bloomRT[i]);
      r.render(this.fsScene, this.fsCam);
    }
    r.autoClear = false;
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const src = this.bloomRT[i];
      this.upMat.uniforms.tSrc.value = src.texture;
      this.upMat.uniforms.uTexel.value.set(0.5 / src.width, 0.5 / src.height);
      this.quad.material = this.upMat;
      r.setRenderTarget(this.bloomRT[i - 1]);
      r.render(this.fsScene, this.fsCam);
    }
    r.autoClear = autoClear;

    // ---- composite
    const cu = this.compMat.uniforms;
    cu.uBloom.value = this.bloom;
    cu.uAoTexel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
    cu.uExposure.value = this.exposure;
    cu.uFrame.value = this.frame;
    cu.uVolTexel.value.set(1 / this.volRT.width, 1 / this.volRT.height);
    this.quad.material = this.compMat;
    r.setRenderTarget(null);
    r.render(this.fsScene, this.fsCam);
  }
}
