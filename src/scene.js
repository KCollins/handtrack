// scene.js - renderer, post-processing, the Merlin assembly in three looks
// (glowing wireframe, CAD shaded, hologram), scan-wipe transitions and the exploded view.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { buildMerlin, MERLIN_CENTER } from './merlin.js';
import { lineUniforms, makeLineMaterial, makeFatLines } from './lines.js';
import { damp } from './filters.js';

export const MODES = ['wire', 'cad', 'holo'];
export const MODE_NAMES = { wire: 'WIREFRAME', cad: 'CAD', holo: 'HOLOGRAM' };

export const look = {
  wireColor: new THREE.Color(0.10, 0.90, 1.12), // razor-sharp electric-cyan nozzle rings
  wireGain: 1.85,
  // crisp white-cyan CAD skeleton lines without additive blowout or milky haze
  hotColor: new THREE.Color(0.86, 0.98, 1.12),
  hotGain: 1.32,
  coolParts: ['nozzle'],
  lineWidth: 1.24, // crisp high-definition CAD wireframe line width
  // zero wide-radius haze: only a micro 1px anti-aliased edge sheen on the brightest intersections
  bloom: { wire: [0.03, 0.0, 1.28], cad: [0, 0, 1.5], holo: [0.10, 0.02, 1.15] },
  bloomMips: { wire: [1, 0, 0, 0, 0], cad: [0, 0, 0, 0, 0], holo: [1, 0.2, 0, 0, 0] },
  bootGhost: 0.24, // engine intensity ahead of the boot scan ring
  bootHold: 0.3, // s the boot scan waits on its first frame
  trail: { wire: 0, cad: 0, holo: 0 }, // zero motion-blur smearing during fast spins
  holdGlow: 0.08, // subtle brightness lift while held
  explodeDim: 0, // separated machinery must stay as bright as the assembled powerhead
  holoLineOpacity: 0.72,
  exposure: 1.0,
  // wire and hologram looks: dim back-facing hidden lines so front skeleton structure reads with crystal clarity
  occluded: 0.26,
  occludedDeep: 7.2,
};

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const HOME_DISTANCE = 5.35; // camera distance at the home view on landscape screens

export const BG = {
  wire: [new THREE.Color('#020508'), new THREE.Color('#000000')],
  cad: [new THREE.Color('#0b1418'), new THREE.Color('#020405')],
  holo: [new THREE.Color('#051220'), new THREE.Color('#010408')],
  none: [new THREE.Color('#020508'), new THREE.Color('#000000')],
};

function studioEnv(renderer) {
  const env = new THREE.Scene();
  const skyGeo = new THREE.SphereGeometry(10, 48, 24);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vP;
      void main() {
        vec3 top = vec3(0.78, 0.82, 0.85), mid = vec3(0.34, 0.37, 0.40), bot = vec3(0.07, 0.08, 0.09);
        vec3 c = vP.y > 0.0 ? mix(mid, top, smoothstep(0.0, 0.85, vP.y)) : mix(mid, bot, smoothstep(0.0, 0.6, -vP.y));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  env.add(new THREE.Mesh(skyGeo, skyMat));
  const panelGeo = new THREE.PlaneGeometry(1, 1);
  const panelMats = [];
  for (const [w, h, x, y, z, k] of [[6, 3, -4, 5, 5, 2.2], [3, 5, 6, 1, 2, 0.9], [4, 2, 1, 3, -6, 1.2]]) {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide });
    panelMats.push(mat);
    const m = new THREE.Mesh(panelGeo, mat);
    m.scale.set(w, h, 1);
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    env.add(m);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(env, 0.02).texture;
  pmrem.dispose();
  skyGeo.dispose();
  skyMat.dispose();
  panelGeo.dispose();
  for (const m of panelMats) m.dispose();
  return texture;
}

const CAD_COLORS = {
  bell: ['#7a8b8f', 0.85, 0.34], // satin metal: lit by its own studio reflections (studioEnv)
  bellInside: ['#8a5a40', 0.3, 0.5], // the copper glow seen looking into the bell
  tubeWall: ['#7e8d90', 0.015, 0.81],
  metal: ['#b8c2c2', 0.015, 0.74],
  metalDark: ['#626f73', 0.01, 0.82],
  joint: ['#33474c', 0.005, 0.88],
  steel: ['#c5cecd', 0.04, 0.68],
  copper: ['#956c5c', 0.015, 0.81],
  white: ['#c4d0d0', 0.005, 0.79],
  teal: ['#1da1b8', 0.01, 0.72],
  tealInside: ['#235f6f', 0.005, 0.82],
  purple: ['#b67bd1', 0.005, 0.77],
  plate: ['#df8848', 0.005, 0.78],
  box: ['#92b3ec', 0.005, 0.76],
  black: ['#25343b', 0.005, 0.88],
  green: ['#2abb4f', 0.005, 0.76],
  blue: ['#347bd7', 0.005, 0.75],
  magenta: ['#b47acb', 0.005, 0.78],
  hose: ['#a36d3a', 0.005, 0.85],
  red: ['#c33a46', 0.005, 0.70],
  bronze: ['#9b7445', 0.04, 0.76],
  gold: ['#a88d4a', 0.04, 0.76],
};

const bgVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }
`;
const bgFrag = /* glsl */ `
uniform vec3 uInner;
uniform vec3 uOuter;
uniform vec2 uAspect;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * uAspect;
  float r = length(p);
  vec3 c = mix(uInner, uOuter, smoothstep(0.0, 0.85, r));
  gl_FragColor = vec4(c, 1.0);
}
`;

const holoVert = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const holoFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
uniform vec4 uClip;
uniform float uClipSign;
varying vec3 vN;
varying vec3 vW;
void main() {
  float dist = dot(uClip.xyz, vW) + uClip.w;
  if (uClipSign * dist < 0.0) discard;
  vec3 V = normalize(cameraPosition - vW);
  float f = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
  float scan = 0.62 + 0.38 * sin(vW.y * 140.0 - uTime * 3.0);
  float band = smoothstep(0.0, 1.0, sin(vW.y * 3.0 - uTime * 1.3) * 0.5 + 0.5);
  float flick = 0.93 + 0.07 * sin(uTime * 41.0) * sin(uTime * 17.0);
  vec3 c = uColor * (0.03 + 0.6 * f) * scan * flick * (0.75 + 0.5 * band) * uOpacity;
  gl_FragColor = vec4(c, 1.0);
}
`;

const highPassFrag = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec3 defaultColor;
uniform float defaultOpacity;
uniform float luminosityThreshold;
uniform float smoothWidth;
uniform vec2 uOff;
varying vec2 vUv;
void main() {
  vec4 texel = 0.25 * (texture2D(tDiffuse, vUv - uOff) + texture2D(tDiffuse, vUv + vec2(uOff.x, -uOff.y))
    + texture2D(tDiffuse, vUv + vec2(-uOff.x, uOff.y)) + texture2D(tDiffuse, vUv + uOff));
  float v = luminance(texel.xyz);
  float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
  gl_FragColor = mix(vec4(defaultColor.rgb, defaultOpacity), texel, alpha);
}
`;

const finalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.22 },
    uGrain: { value: 0.003 },
    uAspect: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform vec2 uAspect;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 p = (vUv - 0.5) * uAspect;
      float v = 1.0 - uVignette * smoothstep(0.35, 1.05, length(p));
      float g = (hash(vUv * 1000.0 + fract(uTime * 7.13)) - 0.5) * uGrain;
      gl_FragColor = vec4(c.rgb * v + g, 1.0);
    }
  `,
};

function ringSegments(r, n = 160) {
  const out = [];
  const inten = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    out.push(Math.sin(a0) * r, 0, Math.cos(a0) * r, Math.sin(a1) * r, 0, Math.cos(a1) * r);
    inten.push(1);
  }
  return { out, inten };
}

const _tmpV = new THREE.Vector3();
const _corner = new THREE.Vector3();

export class Viewer {
  constructor(canvas, control) {
    this.canvas = canvas;
    this.control = control;
    this.mode = 'wire';
    this.trans = null;
    this.explodeTarget = 0;
    this.explode = 0;
    this.explodeVel = 0;
    this.explodeLive = false; // two fists are moving the exploded view
    this.time = 0;
    this.pulse = 0;
    this.hold = 0;
    this.sweep = null;
    const forced = Number(new URLSearchParams(location.search).get('dpr'));
    this.dprMax = forced > 0 ? Math.min(forced, 3) : Math.min(window.devicePixelRatio || 1, 2);
    this.fixedDpr = forced > 0;
    this.dpr = this.dprMax;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.setPixelRatio(this.dpr);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = look.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.localClippingEnabled = true;
    renderer.setClearColor(0x000000, 1);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
    camera.position.set(0, 0, HOME_DISTANCE);
    this.camera = camera;
    this.baseDistance = HOME_DISTANCE;
    this.explodeShrink = null; // null = autoShrink()
    this.reserve = 0; // px at the bottom covered by the controls
    this.lift = 0; // px the view is shifted up so the engine centers above them
    this.controlsTop = null; // CSS px top of the visible bottom controls; the scan ring stays above it

    // background
    this.bgMat = new THREE.ShaderMaterial({
      uniforms: { uInner: { value: BG.wire[0].clone() }, uOuter: { value: BG.wire[1].clone() }, uAspect: { value: new THREE.Vector2(1, 1) } },
      vertexShader: bgVert,
      fragmentShader: bgFrag,
      depthTest: false,
      depthWrite: false,
    });
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMat);
    bg.frustumCulled = false;
    bg.renderOrder = -1000;
    scene.add(bg);

    // CAD lighting
    this.envMap = null;
    scene.environment = null;
    const key = new THREE.DirectionalLight(0xf3f8f6, 2.25);
    key.position.set(-3, 5, 6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xc4d9e5, 0.85);
    fill.position.set(4, 1, 2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xe0eded, 1.05);
    rim.position.set(1, 3, -4);
    scene.add(rim);
    scene.add(new THREE.HemisphereLight(0xe9f0ef, 0x64747c, 0.95));

    // clip planes (CAD meshes); lines and hologram use shader uniforms
    this.cadPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e5);
    this.cadMats = {};
    for (const [k, [color, metalness, roughness]] of Object.entries(CAD_COLORS)) {
      const m = new THREE.MeshStandardMaterial({ color, metalness, roughness, envMapIntensity: 0, clippingPlanes: [this.cadPlane], side: THREE.DoubleSide });
      if (k === 'red') {
        m.emissive = new THREE.Color('#a82331');
        m.emissiveIntensity = 0.22;
      }
      this.cadMats[k] = m;
    }
    // Only the nozzle bell is satin metal, as in the video's CAD model; it reflects a small
    // soft studio (gradient sky plus three light panels) so it reads as metal, not paint.
    this.cadMats.bell.envMap = studioEnv(renderer);
    this.cadMats.bell.envMapIntensity = 1;
    this.holoMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0.135, 0.585, 0.94) },
        uTime: lineUniforms.uTime,
        uOpacity: { value: 1 },
        uClip: lineUniforms.uClip,
        uClipSign: { value: 0 },
      },
      vertexShader: holoVert,
      fragmentShader: holoFrag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.holoMat.toneMapped = false;
    this.cadEdgeMat = makeLineMaterial(new THREE.Color('#162a31'), {
      blend: 'normal', cadEdges: true, depthTest: true, depthBias: 0.0014,
      opacity: 0.78, widthScale: 0.46,
    });
    // A clipped CAD surface must not leave a ghost of its hidden edges.
    this.cadEdgeMat.uniforms.uGhost = { value: 0 };

    // model
    this.pivot = new THREE.Group();
    scene.add(this.pivot);
    this.offset = new THREE.Group();
    this.offset.position.copy(MERLIN_CENTER).negate();
    this.pivot.add(this.offset);
    this.parts = [];
    this.stats = { segments: 0, triangles: 0 };
    for (const part of buildMerlin()) {
      const built = part.build(this.cadMats);
      const group = built.group;
      this.offset.add(group);
      const cad = built.meshes;
      cad.forEach((m) => {
        m.renderOrder = 1;
        this.stats.triangles += m.geometry.attributes.position.count / 3;
      });
      const holo = cad.map((m) => {
        const h = new THREE.Mesh(m.geometry, this.holoMat);
        h.renderOrder = 2;
        h.visible = false;
        group.add(h);
        return h;
      });
      const cool = look.coolParts.includes(part.name);
      const wireMat = makeLineMaterial(this.wireColorFor(part.name), { opacity: 1, occlude: !cool });
      const holoLineMat = makeLineMaterial(new THREE.Color(0.3, 0.85, 1.25), { opacity: look.holoLineOpacity, flicker: 0.35, widthScale: 0.86, occlude: !cool });
      const wire = makeFatLines(built.segs, built.inten, wireMat, built.weights);
      const cadGeo = built.cad ? makeFatLines(built.cad.segs, built.cad.inten, this.cadEdgeMat, built.cad.weights).geometry : wire.geometry;
      const cadEdges = new THREE.Mesh(cadGeo, this.cadEdgeMat);
      cadEdges.frustumCulled = false;
      cadEdges.renderOrder = 3;
      cadEdges.visible = false;
      group.add(cadEdges);
      // Include the new edge pass in the existing CAD visibility lifecycle, so
      // boot, clipping transitions and disappearing exploded looms stay atomic.
      cad.push(cadEdges);
      const holoLines = new THREE.Mesh(wire.geometry, holoLineMat);
      holoLines.frustumCulled = false;
      holoLines.renderOrder = 11;
      holoLines.visible = false;
      group.add(wire, holoLines);
      this.stats.segments += built.segs.length / 6;
      const box = new THREE.Box3();
      const sg = built.segs;
      for (let i = 0; i < sg.length; i += 3) box.expandByPoint(_tmpV.set(sg[i], sg[i + 1], sg[i + 2]));
      this.parts.push({ part, group, cad, holo, wire, holoLines, wireMat, holoLineMat, box, cool });
    }
    // depth-only stand-ins for the CAD surfaces (the cool nozzle neither hides nor is hidden)
    this.occScene = new THREE.Scene();
    this.occScene.matrixWorldAutoUpdate = false; // the stand-ins copy their world matrices
    this.occMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    this.occProxies = [];
    for (const p of this.parts) {
      if (p.cool) continue;
      for (const m of p.cad) {
        if (m.material === this.cadEdgeMat) continue;
        const proxy = new THREE.Mesh(m.geometry, this.occMat);
        proxy.matrixAutoUpdate = false;
        proxy.matrixWorldAutoUpdate = false;
        proxy.frustumCulled = false;
        this.occScene.add(proxy);
        this.occProxies.push({ proxy, src: m, part: p });
      }
    }
    this.occRT = new THREE.WebGLRenderTarget(4, 4, { depthTexture: new THREE.DepthTexture(4, 4) });
    lineUniforms.uOccDepth.value = this.occRT.depthTexture;
    // parts spread unevenly when exploded; shift them together so the exploded
    // assembly stays centered on the assembled one at any orientation
    const b0 = new THREE.Box3();
    const b1 = new THREE.Box3();
    for (const p of this.parts) {
      b0.union(p.box);
      if (!p.part.fadeOnExplode) b1.union(p.box.clone().translate(p.part.explode));
    }
    this.explodeCenter = b1.getCenter(new THREE.Vector3()).sub(b0.getCenter(new THREE.Vector3()));

    // scanner ring used by transitions
    const ring = ringSegments(1.0);
    const ring2 = ringSegments(1.06, 120);
    const ticks = [];
    const tickI = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r0 = 1.06;
      const r1 = i % 6 === 0 ? 1.16 : 1.1;
      ticks.push(Math.sin(a) * r0, 0, Math.cos(a) * r0, Math.sin(a) * r1, 0, Math.cos(a) * r1);
      tickI.push(1);
    }
    this.scanMat = makeLineMaterial(new THREE.Color(0.5, 1.2, 1.6), { opacity: 0 });
    this.scanRing = makeFatLines(
      new Float32Array([...ring.out, ...ring2.out, ...ticks]),
      new Float32Array([...ring.inten, ...ring2.inten.map(() => 0.5), ...tickI.map(() => 0.8)]),
      this.scanMat
    );
    this.scanRing.visible = false;
    this.offset.add(this.scanRing);

    // bounding box in model space for HUD framing
    this.bbox = new THREE.Box3(new THREE.Vector3(-0.72, -0.02, -0.45), new THREE.Vector3(0.48, 2.3, 0.44));

    // post
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    // light trails behind a fast spin (on only while spinning, so it costs nothing at rest)
    this.trails = new AfterimagePass(0);
    this.trails.enabled = false;
    this.trailTau = 0.02;
    this.trailFresh = true;
    this.sinceRender = 0; // s of app time since the last rendered frame
    this.composer.addPass(this.trails);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), ...look.bloom.wire);
    // Bloom runs at CSS resolution whatever the devicePixelRatio, so the glow has the same
    // size on every screen (and costs 4x less on Retina). A 4-tap box downsample in the
    // high pass keeps thin lines from flickering when the source is denser than the target.
    const bloomSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.highPassUniforms.uOff = { value: new THREE.Vector2() };
    this.bloom.setSize = (width, height) => {
      const bw = Math.max(4, Math.round(width / this.dpr));
      const bh = Math.max(4, Math.round(height / this.dpr));
      bloomSetSize(bw, bh);
      this.bloom.highPassUniforms.uOff.value.set(0.25 / Math.round(bw / 2), 0.25 / Math.round(bh / 2));
    };
    this.bloom.materialHighPassFilter.fragmentShader = highPassFrag;
    this.bloom.materialHighPassFilter.needsUpdate = true;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.finalPass = new ShaderPass(finalShader);
    this.composer.addPass(this.finalPass);

    for (const m of MODES) this.applyModeVisibility(m, m === 'wire');
    this.resize();
    this.frameTimes = [];
  }

  // ------------------------------------------------------------------ layout
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.w = w;
    this.h = h;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(w, h);
    this.occRT.setSize(Math.round(w * this.dpr), Math.round(h * this.dpr));
    const aspect = w / h;
    this.camera.aspect = aspect;
    // the engine fills about 70% of the height on landscape screens, and fits portrait ones too
    this.baseDistance = Math.max(HOME_DISTANCE, 6.6 / (aspect * 1.6));
    this.camera.position.set(0, 0, this.baseDistance);
    this.camera.updateProjectionMatrix();
    lineUniforms.uResolution.value.set(w * this.dpr, h * this.dpr);
    lineUniforms.uWidth.value = look.lineWidth * this.dpr;
    this.bgMat.uniforms.uAspect.value.set(aspect, 1);
    this.finalPass.uniforms.uAspect.value.set(aspect, 1);
    this.applyLift();
  }

  // keep the engine centered in the space above the bottom controls
  setReserve(px, instant = false) {
    this.reserve = Math.max(0, Math.min(px, this.h * 0.3));
    if (instant) {
      this.lift = this.reserve / 2;
      this.applyLift();
    }
  }

  applyLift() {
    if (Math.abs(this.lift) < 0.05) this.camera.clearViewOffset();
    else this.camera.setViewOffset(this.w, this.h, 0, this.lift, this.w, this.h);
  }

  // exploded scale-down that keeps the spread-out assembly on screen and clear of the
  // controls. At the home view and full scale the centered exploded engine spans about
  // 1.03 of the screen height and 0.61 / aspect of its width (measured at distance 6.6).
  autoShrink() {
    const aspect = this.w / Math.max(1, this.h);
    const k = 6.6 / this.baseDistance;
    const h = 1.03 * k;
    const w = (0.61 / aspect) * k;
    const room = Math.min(0.8, (this.h - this.reserve - 64) / Math.max(1, this.h));
    return 1 - Math.min(1, room / h, 0.76 / w);
  }

  // where the engine's home position (world origin) appears on screen, in CSS pixels
  originPx() {
    return [this.w / 2, this.h / 2 - this.lift];
  }

  worldPerPixel() {
    const d = this.baseDistance - this.control.pos.z;
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.h;
  }

  // half-extents (world units) of the area above the controls at the engine's depth, times frac
  centerBounds(frac = 0.7) {
    const halfH = (this.worldPerPixel() * this.h) / 2;
    const usable = (this.h - this.reserve) / Math.max(1, this.h);
    return { x: halfH * this.camera.aspect * frac, y: halfH * usable * frac };
  }

  // Where the engine's origin may rest (world units, x right, y up) so the whole engine, as it
  // is turned and scaled right now, stays in view above the controls with a margin around it
  // (`margin`: share of the view's usable height). The margin narrows as the engine nears the
  // view's size; an engine larger than the view may move until its edges reach the view's edges.
  fitRange(margin = 0.03) {
    const r = this.screenRect();
    if (!(Number.isFinite(r.x0) && Number.isFinite(r.x1) && Number.isFinite(r.y0) && Number.isFinite(r.y1))) return null;
    const wpp = this.worldPerPixel();
    const [ox, oy] = this.originPx();
    const p = this.control.pos;
    // the engine's extent around its origin on screen (px)
    const ex = ox + p.x / wpp;
    const ey = oy - p.y / wpp;
    const M = margin * (this.h - this.reserve);
    const span = (a0, a1, size) => {
      const m = Math.min(M, Math.max(0, (size - (a1 - a0)) / 2));
      return [Math.min(m - a0, size - m - a1), Math.max(m - a0, size - m - a1)];
    };
    const [x0, x1] = span(r.x0 - ex, r.x1 - ex, this.w);
    const [y0, y1] = span(r.y0 - ey, r.y1 - ey, this.h - this.reserve);
    return {
      x: [(x0 - ox) * wpp, (x1 - ox) * wpp],
      y: [(oy - y1) * wpp, (oy - y0) * wpp],
      // the engine is larger than the view along this axis
      big: { x: r.x1 - r.x0 > this.w, y: r.y1 - r.y0 > this.h - this.reserve },
    };
  }

  // ------------------------------------------------------------------ modes
  applyModeVisibility(mode, on) {
    for (const p of this.parts) {
      if (mode === 'wire') p.wire.visible = on;
      if (mode === 'cad') p.cad.forEach((m) => (m.visible = on));
      if (mode === 'holo') {
        p.holo.forEach((m) => (m.visible = on));
        p.holoLines.visible = on;
      }
    }
  }

  setClipSign(mode, sign) {
    if (mode === 'wire') this.parts.forEach((p) => (p.wireMat.uniforms.uClipSign.value = sign));
    if (mode === 'holo') {
      this.holoMat.uniforms.uClipSign.value = sign;
      this.parts.forEach((p) => (p.holoLineMat.uniforms.uClipSign.value = sign));
    }
    if (mode === 'cad') {
      this.cadSign = sign;
      this.cadEdgeMat.uniforms.uClipSign.value = sign;
    }
  }

  setMode(next, { boot = false } = {}) {
    if (!MODES.includes(next)) return false;
    if (this.trans) this.finishTransition();
    if (next === this.mode && !boot) return false;
    const from = boot ? 'none' : this.mode;
    // the boot holds its first frame while the canvas fades in over the matching page poster
    this.trans = { from, to: next, t: 0, dur: boot ? 1.1 : 1.05, hold: boot ? look.bootHold : 0 };
    this.applyModeVisibility(next, true);
    this.setClipSign(next, 1);
    if (from !== 'none') this.setClipSign(from, -1);
    this.mode = next;
    this.scanRing.visible = true;
    lineUniforms.uGhost.value = boot ? look.bootGhost : 0;
    return true;
  }

  finishTransition() {
    const { from, to } = this.trans;
    if (from !== 'none' && from !== to) this.applyModeVisibility(from, false);
    for (const m of MODES) this.setClipSign(m, 0);
    this.cadSign = 0;
    this.trans = null;
    this.scanRing.visible = false;
    this.scanMat.uniforms.uOpacity.value = 0;
    lineUniforms.uScanGlow.value = 0;
    lineUniforms.uGhost.value = 0;
    lineUniforms.uClip.value.set(0, 1, 0, 1e5);
    this.cadPlane.set(new THREE.Vector3(0, 1, 0), 1e5);
  }

  boot() {
    this.mode = 'none';
    this.parts.forEach((p) => {
      p.wire.visible = false;
      p.cad.forEach((m) => (m.visible = false));
    });
    this.mode = 'wire';
    this.setMode('wire', { boot: true });
  }

  // the boot scan again in the current look, from nothing (the demo starting over)
  rescan() {
    const mode = this.mode;
    if (this.trans) this.finishTransition();
    for (const m of MODES) if (m !== mode) this.applyModeVisibility(m, false);
    this.setMode(mode, { boot: true });
    this.trans.hold = 0;
    lineUniforms.uGhost.value = 0;
  }

  toggleExplode(force) {
    this.explodeTarget = typeof force === 'boolean' ? (force ? 1 : 0) : this.explodeTarget > 0.5 ? 0 : 1;
    return this.explodeTarget > 0.5;
  }

  wireColorFor(name) {
    return look.coolParts.includes(name) ? look.wireColor.clone().multiplyScalar(look.wireGain) : look.hotColor.clone().multiplyScalar(look.hotGain);
  }

  setWireGain(g, hot = look.hotGain) {
    look.wireGain = g;
    look.hotGain = hot;
    this.parts.forEach((p) => p.wireMat.uniforms.uColor.value.copy(this.wireColorFor(p.part.name)));
  }

  flash(amount = 0.6) {
    this.pulse = Math.max(this.pulse, amount);
  }

  sweepGlow() {
    if (!this.trans) this.sweep = { t: 0 };
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    this.time += dt;
    lineUniforms.uTime.value = this.time;
    this.finalPass.uniforms.uTime.value = this.time;

    const lift = this.lift + (this.reserve / 2 - this.lift) * (1 - Math.exp(-dt / 0.3));
    if (Math.abs(lift - this.lift) > 0.01) {
      this.lift = lift;
      this.applyLift();
    }

    // model transform from the controller
    const c = this.control;
    this.pivot.quaternion.copy(c.q);
    // shrink while exploded so the spread-out assembly fits the screen
    const shrink = this.explodeShrink ?? this.autoShrink();
    this.pivot.scale.setScalar(c.scale * (1 - shrink * THREE.MathUtils.clamp(this.explode, 0, 1)));
    this.pivot.position.copy(c.pos);
    this.pivot.updateMatrixWorld(true);

    // exploded view: critically damped spring with a touch of overshoot (stiffer while two fists
    // hold it, so the parts follow them closely)
    const k = this.explodeLive ? 190 : 70;
    const z = this.explodeLive ? 0.9 : 0.82;
    const a = k * (this.explodeTarget - this.explode) - 2 * z * Math.sqrt(k) * this.explodeVel;
    this.explodeVel += a * dt;
    this.explode += this.explodeVel * dt;
    const e = this.explode;
    for (const p of this.parts) {
      p.group.position.copy(p.part.explode).sub(this.explodeCenter).multiplyScalar(e);
      if (p.part.fadeOnExplode) {
        const f = Math.max(0, 1 - e * 1.6);
        p.wireMat.uniforms.uOpacity.value = f;
        p.holoLineMat.uniforms.uOpacity.value = look.holoLineOpacity * f;
        const vis = f > 0.05;
        p.cad.forEach((m) => (m.visible = vis && (this.mode === 'cad' || this.trans?.from === 'cad')));
        p.holo.forEach((m) => (m.visible = vis && (this.mode === 'holo' || this.trans?.from === 'holo')));
      }
    }
    this.pivot.updateMatrixWorld(true);

    // depth fade range follows the model
    const dist = this.camera.position.z - c.pos.z;
    const R = 1.25 * c.scale;
    lineUniforms.uDepthNear.value = Math.max(0.05, dist - R * 0.6);
    lineUniforms.uDepthFar.value = dist + R;

    // pulse (events), a steady glow while held, dimmer when exploded
    this.pulse *= Math.exp(-dt / 0.28);
    this.hold += ((c.held || c.limbo ? look.holdGlow : 0) - this.hold) * damp(dt, 0.12);
    const ex = THREE.MathUtils.clamp(e, 0, 1);
    lineUniforms.uPulse.value = this.pulse + this.hold - look.explodeDim * ex;

    // light trails while spinning fast; the first frame back on starts clean. They fade
    // over app time, so the decay per drawn frame is set in render().
    const tau = (look.trail[this.mode] ?? 0) * smoothstep(2, 8, c.spinSpeed);
    this.sinceRender += dt;
    if (tau > 0.004 && dt > 0) {
      if (!this.trails.enabled) this.trailFresh = true;
      this.trailTau = tau;
      this.trails.enabled = true;
    } else if (dt > 0) this.trails.enabled = false;

    // transitions / sweep share the clip plane uniform
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(c.q).normalize();
    const plane = (yLocal) => {
      const P = this.offset.localToWorld(new THREE.Vector3(0, yLocal, 0));
      return { n: up, w: -up.dot(P) };
    };
    let bloomMix = null;
    if (this.trans) {
      const T = this.trans;
      if (T.hold > 0) T.hold -= dt;
      else T.t += dt / T.dur;
      const u = Math.min(1, T.t);
      // the boot scan starts at speed (the engine is already visible as a ghost);
      // look changes ease in and out
      const eased = T.from === 'none' ? 1 - Math.pow(1 - u, 2.2) : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const yTop = T.from === 'none' ? 2.3 : 2.42; // the boot ring starts on the top plate, clear of the screen edge
      const yBot = -0.12;
      const y = yTop + (yBot - yTop) * eased;
      const pl = plane(y);
      lineUniforms.uClip.value.set(pl.n.x, pl.n.y, pl.n.z, pl.w);
      // the boot ring is already lit on the first frame
      const env = Math.sin(Math.PI * (T.from === 'none' ? 0.12 + 0.88 * u : u));
      lineUniforms.uScanGlow.value = env;
      if (this.cadSign) this.cadPlane.set(pl.n.clone().multiplyScalar(this.cadSign), pl.w * this.cadSign);
      this.scanRing.position.set(-0.12, y, 0);
      this.scanMat.uniforms.uOpacity.value = Math.min(1, env * 2.2);
      // the ring's near side fades out just above the bottom controls instead of crossing them
      const floor = this.scanMat.uniforms.uFloor.value;
      if (this.controlsTop == null) floor.set(-1, 1);
      else floor.set(Math.max(0, (this.h - this.controlsTop + 14) * this.dpr), 40 * this.dpr);
      bloomMix = { from: T.from === 'none' ? T.to : T.from, to: T.to, u: eased };
      if (T.t >= 1) this.finishTransition();
    } else if (this.sweep) {
      this.sweep.t += dt / 0.55;
      const u = Math.min(1, this.sweep.t);
      const y = -0.1 + 2.5 * (1 - Math.pow(1 - u, 2));
      const pl = plane(y);
      lineUniforms.uClip.value.set(pl.n.x, pl.n.y, pl.n.z, pl.w);
      lineUniforms.uScanGlow.value = 0.55 * Math.sin(Math.PI * u);
      if (u >= 1) {
        this.sweep = null;
        lineUniforms.uScanGlow.value = 0;
      }
    }

    // background + bloom per mode
    const target = bloomMix ?? { from: this.mode, to: this.mode, u: 1 };
    const b0 = look.bloom[target.from] ?? look.bloom.wire;
    const b1 = look.bloom[target.to] ?? look.bloom.wire;
    const uu = target.u;
    this.bloom.strength = THREE.MathUtils.lerp(b0[0], b1[0], uu) * (1 - look.explodeDim * THREE.MathUtils.clamp(this.explode, 0, 1));
    this.bloom.radius = THREE.MathUtils.lerp(b0[1], b1[1], uu);
    this.bloom.threshold = THREE.MathUtils.lerp(b0[2], b1[2], uu);
    const m0 = look.bloomMips[target.from] ?? look.bloomMips.wire;
    const m1 = look.bloomMips[target.to] ?? look.bloomMips.wire;
    this.bloom.bloomTintColors.forEach((v, i) => v.setScalar(THREE.MathUtils.lerp(m0[i], m1[i], uu)));
    const g0 = BG[target.from] ?? BG.wire;
    const g1 = BG[target.to] ?? BG.wire;
    const kb = damp(dt, 0.25);
    this.bgMat.uniforms.uInner.value.lerp(g0[0].clone().lerp(g1[0], uu), kb);
    this.bgMat.uniforms.uOuter.value.lerp(g0[1].clone().lerp(g1[1], uu), kb);
  }

  render(dt) {
    if (this.trails.enabled) this.trails.damp = this.trailFresh ? 0 : Math.exp(-this.sinceRender / this.trailTau);
    this.trailFresh = false;
    this.sinceRender = 0;
    this.renderOcclusion();
    this.composer.render(dt);
    // adaptive resolution: step down (never back up) if the GPU cannot hold ~45 fps,
    // judged on the median frame time so tab switches and hitches do not count
    if (this.fixedDpr) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length >= 120) {
      const sorted = this.frameTimes.slice().sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      this.frameTimes.length = 0;
      if (median > 1 / 45 && this.dpr > 1) {
        this.dpr = Math.max(1, this.dpr - 0.25);
        this.resize();
      }
    }
  }

  // depth of the CAD surfaces behind the wire and hologram looks, for the line shader to dim
  // hidden lines
  renderOcclusion() {
    const occ = lineUniforms.uOcc.value;
    const wireShown = this.mode === 'wire' || this.trans?.from === 'wire';
    const holoShown = this.mode === 'holo' || this.trans?.from === 'holo';
    occ.x = wireShown || holoShown ? 1 - look.occluded : 0;
    occ.w = look.occludedDeep;
    if (occ.x <= 0) return;
    for (const o of this.occProxies) {
      const p = o.part;
      o.proxy.visible =
        (p.wire.visible && p.wireMat.uniforms.uOpacity.value > 0.05) ||
        (p.holoLines.visible && p.holoLineMat.uniforms.uOpacity.value > 0.05);
      o.proxy.matrixWorld.copy(o.src.matrixWorld);
    }
    lineUniforms.uNearFar.value.set(this.camera.near, this.camera.far);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.occRT);
    r.clear(true, true, false);
    r.render(this.occScene, this.camera);
    r.setRenderTarget(prev);
  }

  // ------------------------------------------------------------------ HUD helpers
  toScreen(world) {
    const v = world.clone().project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h, z: v.z };
  }

  screenRect() {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of this.parts) {
      if (p.part.fadeOnExplode && this.explode > 0.5) continue;
      const b = p.box;
      for (let i = 0; i < 8; i++) {
        _corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
        p.group.localToWorld(_corner);
        _corner.project(this.camera);
        const sx = (_corner.x * 0.5 + 0.5) * this.w;
        const sy = (-_corner.y * 0.5 + 0.5) * this.h;
        if (sx < x0) x0 = sx;
        if (sx > x1) x1 = sx;
        if (sy < y0) y0 = sy;
        if (sy > y1) y1 = sy;
      }
    }
    return { x0, y0, x1, y1 };
  }

}
