import * as THREE from 'three';
import { env, LIGHT_GLSL } from '../render/environment';

/** Sky dome plus the flat base of the parent supercell (the cloud deck at the LCL). */
export class Sky {
  readonly group = new THREE.Group();
  private dome: THREE.Mesh;
  private deck: THREE.Mesh;
  readonly deckUniforms = {
    ...env,
    tNoise: { value: null as THREE.Data3DTexture | null },
    uStorm: { value: new THREE.Vector3() }, // x, z, rotation sign
    uFlashPos: { value: new THREE.Vector2() },
  };

  constructor(noise: THREE.Data3DTexture) {
    this.deckUniforms.tNoise.value = noise;

    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(60000, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        uniforms: env,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
            gl_Position = p.xyww;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uHorizonColor; uniform vec3 uZenithColor; uniform vec3 uFogColor;
          uniform vec3 uSunDir; uniform float uFlash;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float e = d.y;
            // bright clear slot along the horizon beneath the storm base
            float sunAz = max(dot(normalize(d.xz), normalize(uSunDir.xz)), 0.0);
            vec3 hor = uHorizonColor * (0.55 + 0.9 * pow(sunAz, 3.0));
            vec3 c = mix(hor, uZenithColor, smoothstep(0.0, 0.3, e));
            c = mix(c, uFogColor, smoothstep(0.02, -0.03, e));
            c += uFlash * vec3(0.12, 0.14, 0.2);
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;

    const geo = new THREE.PlaneGeometry(80000, 80000);
    geo.rotateX(Math.PI / 2); // faces down
    this.deck = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        transparent: true,
        uniforms: this.deckUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          precision highp sampler3D;
          ${LIGHT_GLSL}
          uniform sampler3D tNoise;
          uniform vec3 uStorm; uniform vec2 uFlashPos;
          varying vec3 vWorld;
          float deckNoise(vec2 rel, float a, float seed) {
            float ca = cos(a), sa = sin(a);
            vec2 q = vec2(rel.x * ca - rel.y * sa, rel.x * sa + rel.y * ca) + uStorm.xy + seed * 3100.0;
            float n1 = texture(tNoise, vec3(q / 5200.0, 0.31 + uTime * 0.002).xzy).r;
            vec2 q2 = vec2(q.x * 0.8 - q.y * 0.6, q.x * 0.6 + q.y * 0.8) + n1 * 420.0;
            float n2 = texture(tNoise, vec3(q2 / 1900.0, 0.57 + uTime * 0.004).xzy).r;
            vec2 q3 = vec2(q.x * 0.28 + q.y * 0.96, -q.x * 0.96 + q.y * 0.28) + n2 * 260.0;
            float n3 = texture(tNoise, vec3(q3 / 760.0, 0.83).xzy).r;
            return n1 * 0.52 + n2 * 0.34 + n3 * 0.14;
          }
          void main() {
            vec2 rel = vWorld.xz - uStorm.xy;
            float r = length(rel);
            // slow rotation of the mesocyclone, strongest near the tornado. Two cross-faded
            // phases keep the differential rotation from winding the texture up over time.
            float rate = uStorm.z * 0.03 * exp(-r / 2600.0);
            float ph = uTime / 90.0;
            float p1 = fract(ph), p2 = fract(ph + 0.5);
            float n = mix(deckNoise(rel, rate * (p2 - 0.5) * 90.0, 0.4), deckNoise(rel, rate * (p1 - 0.5) * 90.0, 0.0), 1.0 - abs(2.0 * p1 - 1.0));
            // inflow bands spiralling toward the updraft
            float bands = 0.5 + 0.5 * sin(r / 210.0 - atan(rel.y, rel.x) * uStorm.z * 2.0 + n * 5.0);
            n = mix(n, n * (0.72 + 0.45 * bands), smoothstep(250.0, 900.0, r) * exp(-r / 2600.0));
            float core = smoothstep(200.0, 7000.0, r);
            vec3 dark = uZenithColor * 0.38;
            vec3 light = uZenithColor * 1.35 + uSkyColor * 0.3;
            vec3 c = mix(dark, light, smoothstep(0.25, 0.85, n)) * mix(0.55, 1.15, core);
            // lightning inside the cloud
            float fd = distance(vWorld.xz, uFlashPos);
            c += uFlash * vec3(0.75, 0.82, 1.0) * (0.25 + 2.2 * exp(-fd * fd / 2.5e6)) * (0.35 + n);
            float dist = distance(vWorld, cameraPosition);
            float haze = 1.0 - exp(-dist * 0.00011);
            c = mix(c, uHorizonColor * 0.75, haze * haze);
            float alpha = 1.0 - smoothstep(13000.0, 26000.0, dist);
            gl_FragColor = vec4(c, alpha);
          }`,
      }),
    );
    this.deck.renderOrder = -8;
    this.deck.frustumCulled = false;
    this.group.add(this.dome, this.deck);
  }

  setCloudBase(h: number) {
    this.deck.position.y = h;
  }

  update(camera: THREE.Camera, stormX: number, stormZ: number, rotation: number) {
    this.deck.position.x = camera.position.x;
    this.deck.position.z = camera.position.z;
    this.deckUniforms.uStorm.value.set(stormX, stormZ, rotation);
  }
}
