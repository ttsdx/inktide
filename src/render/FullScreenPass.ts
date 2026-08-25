import {
  BufferGeometry,
  Float32BufferAttribute,
  GLSL3,
  Mesh,
  OrthographicCamera,
  ShaderMaterial,
  type IUniform,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';

/**
 * Minimal full-screen triangle pass.
 *
 * We roll our own instead of using EffectComposer because the scene renders
 * into a multi-target framebuffer (colour + packed normal/depth) and the stock
 * composer assumes a single colour attachment.
 *
 * A single oversized triangle is used rather than a quad: it avoids the
 * diagonal seam where the two triangles of a quad meet, which shows up as a
 * one-pixel artefact in derivative-based effects like Sobel.
 */

const TRI = new BufferGeometry();
TRI.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
TRI.setAttribute('uv', new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

const CAMERA = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

export const FS_VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class FullScreenPass {
  readonly material: ShaderMaterial;
  private readonly mesh: Mesh;

  constructor(fragmentShader: string, uniforms: Record<string, IUniform>, name = 'FullScreenPass') {
    this.material = new ShaderMaterial({
      name,
      glslVersion: GLSL3,
      uniforms,
      vertexShader: FS_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(TRI, this.material);
    this.mesh.frustumCulled = false;
  }

  get uniforms(): Record<string, IUniform> {
    return this.material.uniforms;
  }

  render(renderer: WebGLRenderer, target: WebGLRenderTarget | null): void {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(target);
    renderer.autoClear = false;
    renderer.render(this.mesh, CAMERA);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.material.dispose();
  }
}
