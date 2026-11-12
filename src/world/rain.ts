import * as THREE from 'three';
import { env } from '../render/environment';

const COUNT = 14000;
const BOX = 110;

/** Camera-following rain streaks, slanted by the local wind. */
export class Rain {
  readonly mesh: THREE.LineSegments;
  private offset = new THREE.Vector3();
  private uniforms = {
    ...env,
    uOffset: { value: this.offset },
    uStreak: { value: new THREE.Vector3(0, -0.4, 0) },
    uOpacity: { value: 0 },
    uBox: { value: BOX },
  };

  constructor() {
    const pos = new Float32Array(COUNT * 2 * 3);
    const end = new Float32Array(COUNT * 2);
    for (let i = 0; i < COUNT; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random();
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2 + 1] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.mesh = new THREE.LineSegments(
      geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          attribute float aEnd;
          uniform vec3 uOffset; uniform vec3 uStreak; uniform float uBox;
          varying float vFade;
          void main() {
            vec3 p = fract(position + uOffset / uBox) * uBox - 0.5 * uBox;
            vFade = (1.0 - smoothstep(0.32, 0.5, length(p) / uBox)) * (1.0 - 0.6 * aEnd);
            p += cameraPosition + uStreak * aEnd;
            gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uSkyColor; uniform vec3 uHorizonColor; uniform float uOpacity; uniform float uFlash;
          varying float vFade;
          void main() {
            vec3 c = (uSkyColor * 0.9 + uHorizonColor * 0.15) * (1.0 + uFlash * 2.0);
            gl_FragColor = vec4(c, uOpacity * vFade);
          }`,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  update(dt: number, intensity: number, windX: number, windY: number, windZ: number) {
    this.mesh.visible = intensity > 0.01;
    if (!this.mesh.visible) return;
    // raindrops fall at ~9 m/s and are carried horizontally by the wind
    const vx = windX, vy = -9 + Math.min(windY, 6), vz = windZ;
    this.offset.x = (this.offset.x + vx * dt) % (BOX * 64);
    this.offset.y = (this.offset.y + vy * dt) % (BOX * 64);
    this.offset.z = (this.offset.z + vz * dt) % (BOX * 64);
    this.uniforms.uStreak.value.set(vx, vy, vz).multiplyScalar(0.035);
    this.uniforms.uOpacity.value = 0.04 + 0.3 * intensity;
    this.mesh.geometry.setDrawRange(0, Math.floor(COUNT * Math.min(1, intensity * 1.2)) * 2);
  }
}
