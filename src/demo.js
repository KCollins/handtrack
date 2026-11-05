// demo.js - scripted synthetic hands for ?demo=1 (no camera): grab and turn,
// flick to spin, catch, two-hand zoom / move / roll, then two fists pull the engine
// apart into its exploded view and later push it back together.
import * as THREE from 'three';

export const DEMO_PERIOD = 24;

const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

// keyframes: [[t, v], ...] -> smooth interpolation, clamped at the ends
function kf(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const u = smooth((t - t0) / (t1 - t0));
      if (Array.isArray(v0)) return v0.map((a, j) => a + (v1[j] - a) * u);
      return v0 + (v1 - v0) * u;
    }
  }
  return keys[keys.length - 1][1];
}

// keyframes with linear segments (used for the flick, where velocity matters)
function lin(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const u = (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * u;
    }
  }
  return keys[keys.length - 1][1];
}

// The flick: the wrist turns in one smooth burst of speed (peaking at 4.4 rad/s) and the hand
// closes near the peak, so the engine flies on at full speed.
const FLICK = { t0: 5.45, t1: 6.0, peak: 4.4, yaw0: 0.15 };
function flickYaw(T) {
  const { t0, t1, peak, yaw0 } = FLICK;
  const u = Math.min(1, Math.max(0, (T - t0) / (t1 - t0)));
  return yaw0 + peak * (t1 - t0) * (u / 2 - Math.sin(2 * Math.PI * u) / (4 * Math.PI));
}

// a right hand facing the camera, fingers up (palm frame from palmQuat)
const BASE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const _e = new THREE.Euler();

function handQuat(yaw, pitch, roll) {
  const q = new THREE.Quaternion().setFromEuler(_e.set(pitch, yaw, roll, 'YXZ'));
  return q.multiply(BASE);
}

// small natural tremor so the motion never looks robotic
function tremor(t, seed, k = 1) {
  return k * (0.006 * Math.sin(t * 7.1 + seed) + 0.004 * Math.sin(t * 12.7 + seed * 2.3));
}

export function demoHands(time) {
  const T = time % DEMO_PERIOD;
  const hands = [];

  // A: grab, turn, flick to spin (0.8 - 6.6 s)
  if (T >= 0.8 && T < 6.6) {
    const open = T < 5.68 ? kf([[0.8, 0.15], [1.15, 0.15], [1.45, 1], [5.68, 1]], T) : lin([[5.68, 1], [5.86, 0.12]], T);
    const yaw = T < 5.45 ? kf([[1.5, 0], [2.6, 0.75], [3.9, -0.5], [4.9, 0.1], [5.45, 0.15]], T) : flickYaw(T);
    const pitch = kf([[1.5, 0], [3.0, 0.38], [4.4, -0.22], [5.4, 0]], T);
    const roll = kf([[1.5, 0], [3.4, -0.18], [4.8, 0.12], [5.4, 0]], T);
    const cx = kf([[0.8, 0.7], [1.4, 0.64], [3.0, 0.6], [5.4, 0.63], [6.6, 0.7]], T);
    const cy = kf([[0.8, 0.78], [1.4, 0.6], [5.85, 0.57], [6.6, 0.95]], T);
    hands.push({ center: [cx + tremor(T, 1), cy + tremor(T, 2)], quat: handQuat(yaw, pitch, roll), open, handed: 'Left' });
  }

  // B: catch the spinning engine and set it down (9.2 - 11.4 s)
  if (T >= 9.2 && T < 11.4) {
    const open = kf([[9.2, 0.15], [9.45, 0.15], [9.7, 1], [10.85, 1], [11.05, 0.12]], T);
    const yaw = kf([[9.8, 0], [10.7, -0.35]], T);
    const cx = kf([[9.2, 0.7], [9.6, 0.62], [11.4, 0.66]], T);
    const cy = kf([[9.2, 0.8], [9.6, 0.58], [10.9, 0.58], [11.4, 0.9]], T);
    hands.push({ center: [cx + tremor(T, 3), cy + tremor(T, 4)], quat: handQuat(yaw, 0.05, 0), open, handed: 'Left' });
  }

  // C: two hands - zoom, move, roll, return; then the hands close into fists, hold, and pull
  // apart: the exploded view (12.2 - 19.15 s)
  if (T >= 12.2 && T < 19.15) {
    const open = kf([[12.2, 0.3], [12.45, 0.3], [12.75, 1], [17.75, 1], [17.98, 0.02]], T);
    const half = kf([[12.8, 0.12], [14.2, 0.165], [16.7, 0.165], [17.6, 0.12], [18.25, 0.12], [18.65, 0.3]], T);
    const mid = kf([[12.8, [0.5, 0.56]], [14.3, [0.5, 0.56]], [15.4, [0.4, 0.5]], [16.7, [0.4, 0.5]], [17.6, [0.5, 0.56]]], T);
    const tilt = kf([[15.4, 0], [16.0, 0.45], [16.6, 0], [17.6, 0]], T);
    const ca = Math.cos(tilt);
    const sa = Math.sin(tilt);
    const dx = half * ca;
    const dy = half * sa * (16 / 9); // a unit of image height is shorter on a wide screen
    // the fists drop away
    const drop = kf([[12.2, 0.2], [12.6, 0], [18.75, 0], [19.15, 0.3]], T);
    hands.push({ center: [mid[0] - dx + tremor(T, 5, 0.4), mid[1] + dy + drop + tremor(T, 6, 0.4)], quat: handQuat(0.15, 0, -0.2 + tilt), open, handed: 'Right' });
    hands.push({ center: [mid[0] + dx + tremor(T, 7, 0.4), mid[1] - dy + drop + tremor(T, 8, 0.4)], quat: handQuat(-0.15, 0, 0.2 + tilt), open, handed: 'Left' });
  }

  // D: one hand turns the exploded engine (19.4 - 22.5 s)
  if (T >= 19.4 && T < 22.5) {
    const open = kf([[19.4, 0.15], [19.65, 0.15], [19.95, 1], [21.85, 1], [22.05, 0.12]], T);
    const yaw = kf([[20.1, 0], [21.7, -0.9]], T);
    const pitch = kf([[20.1, 0], [21.7, 0.15]], T);
    const cx = kf([[19.4, 0.72], [19.8, 0.66], [22.5, 0.7]], T);
    const cy = kf([[19.4, 0.82], [19.8, 0.6], [21.9, 0.6], [22.5, 0.92]], T);
    hands.push({ center: [cx + tremor(T, 9), cy + tremor(T, 10)], quat: handQuat(yaw, pitch, 0), open, handed: 'Left' });
  }

  // E: two fists come up, hold, and push together: assembled (22.7 - 23.97 s)
  if (T >= 22.7 && T < 23.97) {
    const half = kf([[23.12, 0.3], [23.5, 0.1]], T);
    const drop = kf([[22.7, 0.25], [22.98, 0], [23.6, 0], [23.95, 0.3]], T);
    hands.push({ center: [0.5 - half + tremor(T, 11, 0.4), 0.56 + drop + tremor(T, 12, 0.4)], quat: handQuat(0.15, 0, -0.2), open: 0.02, handed: 'Right' });
    hands.push({ center: [0.5 + half + tremor(T, 13, 0.4), 0.56 + drop + tremor(T, 14, 0.4)], quat: handQuat(-0.15, 0, 0.2), open: 0.02, handed: 'Left' });
  }

  return { hands, loop: Math.floor(time / DEMO_PERIOD) };
}
