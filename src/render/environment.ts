import * as THREE from 'three';

/** Uniforms shared by every material in the scene (same object references everywhere). */
export const env = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.5, 0.25, 0.3).normalize() },
  uSunColor: { value: new THREE.Color() },
  uSkyColor: { value: new THREE.Color() },
  uGroundColor: { value: new THREE.Color() },
  uFogColor: { value: new THREE.Color() },
  uHorizonColor: { value: new THREE.Color() },
  uZenithColor: { value: new THREE.Color() },
  uFogDensity: { value: 0.00012 },
  uFlash: { value: 0 },
  uNight: { value: 0 },
  /** 0 dry … 1 soaked: darkens surfaces and adds reflections */
  uWet: { value: 0 },
  /** x, z, core radius, peak tangential wind × rotation sign */
  uVortex: { value: new THREE.Vector4(0, 0, 50, 0) },
  /** translation x, z, outer decay exponent alpha, cloud base height */
  uVortexB: { value: new THREE.Vector4(0, 0, 0.65, 600) },
};

export const LIGHT_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFlash;
uniform float uNight;
uniform float uWet;
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;

// What a reflective surface sees: the bright slot along the horizon beneath the
// dark storm base, strongest toward the sun, and the ground below the horizon.
vec3 skyColor(vec3 d) {
  float sunAz = max(dot(normalize(d.xz + 1e-5), normalize(uSunDir.xz)), 0.0);
  vec3 hor = uHorizonColor * (0.55 + 0.9 * sunAz * sunAz * sunAz);
  vec3 c = mix(hor, uZenithColor, smoothstep(0.0, 0.3, d.y));
  c = mix(c, uGroundColor * 1.6, smoothstep(0.0, -0.25, d.y));
  return c * (1.0 + uFlash * 1.5);
}

vec3 shade(vec3 albedo, vec3 n) {
  float hemi = n.y * 0.5 + 0.5;
  vec3 amb = mix(uGroundColor, uSkyColor, hemi);
  float nl = max(dot(n, uSunDir), 0.0);
  vec3 flash = uFlash * vec3(0.75, 0.8, 1.0) * (0.35 + 0.65 * hemi);
  return albedo * (amb + uSunColor * nl + flash);
}

vec3 applyFog(vec3 c, float dist) {
  float f = 1.0 - exp(-dist * uFogDensity);
  return mix(c, uFogColor * (1.0 + uFlash * 0.6), f);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** Cheap analytic copy of the tornado wind (tangential + translation) for vertex shaders. */
export const VORTEX_GLSL = /* glsl */ `
uniform vec4 uVortex;
uniform vec4 uVortexB;
vec2 vortexWind(vec2 p) {
  vec2 d = p - uVortex.xy;
  float r = length(d) + 0.001;
  float rb = r / uVortex.z;
  float a = uVortexB.z;
  float f = rb / pow((a + rb * rb * rb * rb) / (1.0 + a), (1.0 + a) * 0.25) * (1.0278 / (1.0 + rb * rb / 36.0));
  vec2 t = vec2(d.y, -d.x) / r;
  float env = exp(-r * r / pow(8.0 * uVortex.z + 300.0, 2.0));
  float inflow = 0.45 * abs(uVortex.w) * (1.89 * rb * rb) / (1.0 + rb * rb * rb);
  return t * uVortex.w * f - d / r * inflow + uVortexB.xy * env;
}
`;

export interface LightingPreset {
  id: string;
  name: string;
  sun: [number, number, number];
  sunColor: string;
  sunIntensity: number;
  sky: string;
  skyIntensity: number;
  ground: string;
  horizon: string;
  horizonIntensity: number;
  zenith: string;
  fog: string;
  exposure: number;
  night: number;
}

export const LIGHTING: LightingPreset[] = [
  {
    id: 'afternoon', name: 'Afternoon',
    sun: [-0.72, 0.22, 0.35], sunColor: '#fff0d8', sunIntensity: 0.55,
    sky: '#93a3ad', skyIntensity: 0.62, ground: '#4b4a40',
    horizon: '#e8e4cf', horizonIntensity: 1.25, zenith: '#3a4750', fog: '#9aa5a4',
    exposure: 1.0, night: 0,
  },
  {
    id: 'golden', name: 'Golden hour',
    sun: [-0.86, 0.1, 0.3], sunColor: '#ffb066', sunIntensity: 0.95,
    sky: '#7e8590', skyIntensity: 0.42, ground: '#54402f',
    horizon: '#ffb86a', horizonIntensity: 1.3, zenith: '#33343c', fog: '#8f877c',
    exposure: 1.05, night: 0,
  },
  {
    id: 'dusk', name: 'Green dusk',
    sun: [-0.8, 0.06, -0.3], sunColor: '#a8c8a0', sunIntensity: 0.18,
    sky: '#4e6a66', skyIntensity: 0.34, ground: '#26302a',
    horizon: '#8fb39a', horizonIntensity: 0.6, zenith: '#16242a', fog: '#4a615a',
    exposure: 1.15, night: 0.35,
  },
  {
    id: 'night', name: 'Night',
    sun: [-0.5, 0.3, 0.4], sunColor: '#8fa4c8', sunIntensity: 0.05,
    sky: '#2b3852', skyIntensity: 0.16, ground: '#141820',
    horizon: '#3a4a68', horizonIntensity: 0.2, zenith: '#080b12', fog: '#111827',
    exposure: 1.6, night: 1,
  },
];

export function applyLighting(p: LightingPreset, rain: number) {
  env.uSunDir.value.set(p.sun[0], p.sun[1], p.sun[2]).normalize();
  env.uSunColor.value.set(p.sunColor).multiplyScalar(p.sunIntensity * (1 - 0.5 * rain));
  env.uSkyColor.value.set(p.sky).multiplyScalar(p.skyIntensity);
  env.uGroundColor.value.set(p.ground).multiplyScalar(p.skyIntensity * 0.55);
  env.uHorizonColor.value.set(p.horizon).multiplyScalar(p.horizonIntensity * (1 - 0.45 * rain));
  env.uZenithColor.value.set(p.zenith).multiplyScalar(p.skyIntensity * 1.2);
  env.uFogColor.value.set(p.fog).multiplyScalar(p.skyIntensity * 1.05).lerp(env.uHorizonColor.value, 0.3);
  env.uFogDensity.value = 0.00011 + 0.00042 * rain * rain;
  env.uNight.value = p.night;
  env.uWet.value = Math.min(1, rain * 1.6);
}
