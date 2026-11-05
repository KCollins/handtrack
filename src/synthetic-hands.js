// synthetic-hands.js - MediaPipe-shaped hand results from a parametric hand,
// used by automated tests and the ?demo=1 self-test. Not used with a camera.
import * as THREE from 'three';

// hand-local frame (meters): wrist at origin, fingers along +y, index toward +x,
// palm facing -z. Matches palmQuat() in hands.js, so quat == palm frame.
const MCP = [
  [0.038, 0.086, 0.0],
  [0.012, 0.093, 0.0],
  [-0.014, 0.088, 0.0],
  [-0.038, 0.075, 0.0],
];
const SEG = [
  [0.044, 0.027, 0.022],
  [0.049, 0.031, 0.023],
  [0.045, 0.029, 0.022],
  [0.036, 0.022, 0.02],
];

function fingerPoints(open) {
  // open 1 = straight and splayed wide, 0 = tight fist
  const curl = 1 - open;
  const pts = [];
  for (let f = 0; f < 4; f++) {
    const base = new THREE.Vector3(...MCP[f]);
    pts.push(base.clone());
    let dir = new THREE.Vector3(0, 1, 0);
    let p = base.clone();
    const spread = (f - 1.5) * 0.24 * open;
    dir.applyAxisAngle(new THREE.Vector3(0, 0, 1), spread);
    const angles = [1.45 * curl, 1.75 * curl, 1.2 * curl];
    for (let s = 0; s < 3; s++) {
      dir = dir.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), -angles[s]);
      p = p.clone().addScaledVector(dir, SEG[f][s]);
      pts.push(p.clone());
    }
  }
  return pts; // 16 points: MCP, PIP, DIP, TIP per finger
}

function thumbPoints(open) {
  const c = 1 - open;
  return [
    new THREE.Vector3(0.026, 0.024, -0.008),
    new THREE.Vector3(0.052 - 0.016 * c, 0.045, -0.016 - 0.01 * c),
    new THREE.Vector3(0.074 - 0.036 * c, 0.066 - 0.005 * c, -0.022 - 0.02 * c),
    new THREE.Vector3(0.094 - 0.058 * c, 0.086 - 0.016 * c, -0.026 - 0.03 * c),
  ];
}

// seeded gaussian noise for tests that model tracking jitter
let seed = 12345;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss() {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
export function seedNoise(s) {
  seed = s | 0;
}

// spec: { center: [X, Y] mirrored screen 0..1, quat: THREE.Quaternion | [x,y,z,w] (app frame),
//         open: 0..1, scale: 1, handed: 'Right' | 'Left',
//         noise: { world: m, image: frame fraction } per-landmark gaussian jitter (tests only),
//         residual: { world: [[x,y,z]]*21 m camera frame, image: [[x,y]]*21 hand sizes, scale } recorded
//         tracker noise added as is (tests only) }
export function synthHand(spec, aspect = 16 / 9) {
  const q = Array.isArray(spec.quat) ? new THREE.Quaternion(...spec.quat) : spec.quat || new THREE.Quaternion();
  const open = spec.open ?? 1;
  const s = spec.scale ?? 1;
  const local = [new THREE.Vector3(0, 0, 0), ...thumbPoints(open)];
  const f = fingerPoints(open);
  for (let i = 0; i < 4; i++) local.push(f[i * 4], f[i * 4 + 1], f[i * 4 + 2], f[i * 4 + 3]);
  // left hand: mirror the local hand across x (index on -x); palmQuat still yields a proper frame
  if (spec.handed === 'Left') local.forEach((p) => (p.x = -p.x));
  // palm center (avg of 0,5,9,13,17) used as origin for screen placement
  const pc = new THREE.Vector3();
  for (const i of [0, 5, 9, 13, 17]) pc.add(local[i]);
  pc.multiplyScalar(1 / 5);
  const app = local.map((p) => p.clone().sub(pc).multiplyScalar(s).applyQuaternion(q));
  // world landmarks in MediaPipe camera frame: (x, y, z)_cam = (-x, -y, z)_app
  const nw = spec.noise?.world ?? 0;
  const ni = spec.noise?.image ?? 0;
  const world = app.map((p) => ({ x: -p.x + nw * gauss(), y: -p.y + nw * gauss(), z: p.z + nw * gauss() }));
  const rs = spec.residual;
  if (rs) {
    const k = rs.scale ?? 1;
    world.forEach((p, i) => {
      p.x += rs.world[i][0] * k;
      p.y += rs.world[i][1] * k;
      p.z += rs.world[i][2] * k;
    });
  }
  // normalized image landmarks (unmirrored): x_img = 1 - X
  const k = 1.75; // normalized image height per meter at ~0.5 m
  const [X, Y] = spec.center;
  const lm = app.map((p) => ({ x: 1 - (X + (p.x * k) / aspect) + ni * gauss(), y: Y - p.y * k + ni * gauss(), z: p.z * k }));
  if (rs) {
    const hs = 0.093 * k * s * (rs.scale ?? 1); // hand size (wrist to middle MCP) in image heights
    lm.forEach((p, i) => {
      p.x += (rs.image[i][0] * hs) / aspect;
      p.y += rs.image[i][1] * hs;
    });
  }
  return { lm, world, handed: spec.handed || 'Right' };
}

export function synthResult(specs, aspect = 16 / 9) {
  const hands = specs.map((sp) => synthHand(sp, aspect));
  return {
    landmarks: hands.map((h) => h.lm),
    worldLandmarks: hands.map((h) => h.world),
    handedness: hands.map((h) => [{ categoryName: h.handed, score: 0.98, index: 0 }]),
  };
}

export function eulerQuat(x, y, z) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
}
