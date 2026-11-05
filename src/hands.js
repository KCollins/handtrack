// hands.js - webcam + MediaPipe Hand Landmarker, hand tracks and hand features.
// The webcam image never leaves the device and is never drawn.
import * as THREE from 'three';
import { OneEuro, PoseFilterQuat, PoseFilterVec, integrateQuat } from './filters.js';

export const MP_VERSION = '0.10.35';
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
export const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const PALM = [0, 5, 9, 13, 17];
const FINGERS = [
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
export const TIPS = [4, 8, 12, 16, 20];

export const tuning = {
  openOn: 0.62, // openness to count as an open (active) hand
  openOff: 0.45, // openness to count as a closed fist (inactive clutch)
  debounce: 0.03, // s a new open/closed state must hold
  reach: 1.3, // hand-to-screen gain around the center, so edges are reachable
  // palm rotation filter (PoseFilterQuat): memories in seconds, errors in measured-noise units
  oriStill: 0.22, // memory for a steady or steadily turning hand
  oriFast: 0.025, // memory through a start, stop or reversal
  oriDetect: 0.4, // memory of the slow tracker that gates noise measurement
  oriT0: 0.85, // averaged prediction error that starts shortening the memory
  oriT1: 0.6, // ...and how quickly it shortens past that
  oriTCut: 4.5, // Hz: how that error is averaged
  oriS0: 0.45, // error trailing the turn that starts shedding speed
  oriS1: 0.3, // ...and how quickly the shedding strengthens past that
  oriSTau: 0.025, // s: speed shedding time at full strength
  oriNMax: 2.2, // a noisy still hand is smoothed up to this much harder
  oriJump: 0.45, // rad: a reading this far off the palm's course is held back as a likely glitch...
  oriJumpRate: 12, // rad/s: ...or this much per second between readings, if more
  refitGap: 0.15, // s: a hand found again after a gap this long (or 2.5 typical result gaps)...
  refitN: 3, // ...re-anchors a grab on this many readings, while the tracker settles on it again
  posStill: 0.2, // s: palm-center filter memory while the hand holds still
  posFast: 0.022, // s: ...and while it moves
  predictMax: 0.055, // s: hands are extrapolated between camera frames by at most this
  grace: 0.16, // s a lost hand is kept alive
  // open hands engage immediately; closed fists are always inactive
  steadySpeed: 2.5, // camera frames/s of palm travel that counts as settled
  steadyTurn: 6.0, // rad/s of palm turn that counts as settled
  armSteady: 0.0, // s settled before a new open hand takes hold (0 = immediate)
  armMax: 0.0, // s open before it takes hold anyway (0 = immediate)
  exitSpeed: 1.2, // camera frames/s: a hand vanishing this fast over the bottom edge was lowered
};

// --------------------------------------------------------------- camera + model
export async function startCamera(video) {
  // best settings first; slower or unusual cameras fall back to looser requests
  const attempts = [
    { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, min: 24 } },
    { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    true,
  ];
  let stream = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: attempts[i] });
      break;
    } catch (err) {
      const retry = err?.name === 'OverconstrainedError' || err?.name === 'NotReadableError' || err?.name === 'AbortError' || err?.name === 'TypeError';
      if (!retry || i === attempts.length - 1) throw err;
    }
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
  return stream;
}

// MediaPipe's WebAssembly runtime prints routine native log lines (TFLite INFO,
// glog I/W) through the console; keep the console for real problems.
let quieted = false;
function quietNativeLogs() {
  if (quieted) return;
  quieted = true;
  const noise = /^(INFO: |[IW]\d{4} \d\d:\d\d:\d\d)/;
  for (const k of ['error', 'warn', 'info', 'log']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      if (typeof a[0] === 'string' && noise.test(a[0])) return;
      orig(...a);
    };
  }
}

// Main-thread fallback (used when module workers or OffscreenCanvas are unavailable).
async function createLandmarker(prefer = 'GPU') {
  quietNativeLogs();
  const vision = await import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const make = (delegate) =>
    vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.5,
    });
  if (prefer === 'CPU') return { lm: await make('CPU'), delegate: 'CPU', make };
  try {
    return { lm: await make('GPU'), delegate: 'GPU', make };
  } catch (err) {
    console.warn('GPU delegate unavailable, using CPU', err);
    return { lm: await make('CPU'), delegate: 'CPU', make };
  }
}

// Hand detection on every new camera frame. Prefers a module worker so inference
// never blocks rendering; falls back to the main thread.
export class Detector {
  constructor(onResult, onError = () => {}, { prefer = 'GPU', watchdogMs = 6000, gpuSetupMs = 8000, slowMs = 100, onLost = () => {}, stallMs = 2000, stuckMs = 10000 } = {}) {
    this.onResult = onResult;
    this.onError = onError;
    this.onLost = onLost; // the camera stopped: its track ended, or no new frame for stallMs
    this.stallMs = stallMs;
    this.stuckMs = stuckMs; // a worker that has not answered a frame for this long is restarted
    this.prefer = prefer;
    this.watchdogMs = watchdogMs;
    this.gpuSetupMs = gpuSetupMs;
    this.slowMs = slowMs;
    this.pace = null; // inference-time sample for the GPU/CPU choice
    this.paced = false;
    this.gotResult = false;
    this.kind = null;
    this.delegate = null;
    this.fps = 0;
    this.inferMs = 0;
    this._count = 0;
    this._countT = performance.now();
    this._lastTs = 0;
    this.stopped = false;
  }

  async init() {
    try {
      await this.initWorker();
      this.kind = 'worker';
    } catch (err) {
      if (this.stopped) return this;
      console.warn('Worker hand tracking unavailable, using main thread:', err?.message || err);
      if (this.worker) this.worker.terminate();
      this.worker = null;
      this.ctx = await createLandmarker(this.prefer);
      this.delegate = this.ctx.delegate;
      this.kind = 'main';
    }
    return this;
  }

  initWorker(prefer = this.prefer) {
    return new Promise((resolve, reject) => {
      let w;
      try {
        w = new Worker(new URL('./detector-worker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        reject(err);
        return;
      }
      this.worker = w;
      let gpuTimer = 0;
      const settle = () => {
        clearTimeout(timer);
        clearTimeout(gpuTimer);
      };
      const timer = setTimeout(() => {
        settle();
        reject(new Error('worker init timeout'));
      }, 90000);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'stage' && m.stage === 'gpu') {
          // a GPU that is slow to set up (busy, or rendering in software) is skipped for the CPU
          gpuTimer = setTimeout(() => {
            settle();
            w.terminate();
            if (this.stopped) {
              reject(new Error('stopped'));
              return;
            }
            console.debug('GPU hand tracking is slow to start; switching to CPU');
            this.initWorker('CPU').then(resolve, reject);
          }, this.gpuSetupMs);
        } else if (m.type === 'ready') {
          settle();
          this.delegate = m.delegate;
          w.onmessage = (ev) => this.onWorkerMessage(ev.data);
          resolve();
        } else if (m.type === 'error') {
          settle();
          reject(new Error(m.message));
        }
      };
      w.onerror = (e) => {
        settle();
        e.preventDefault?.();
        reject(new Error(e.message || 'worker error'));
      };
      w.postMessage({ type: 'init', prefer });
    });
  }

  nextTs() {
    let ts = performance.now();
    if (ts <= this._lastTs) ts = this._lastTs + 0.5;
    this._lastTs = ts;
    return ts;
  }

  tick(ms) {
    this.inferMs = this.inferMs * 0.9 + ms * 0.1;
    this._count++;
    const now = performance.now();
    if (now - this._countT >= 1000) {
      this.fps = (this._count * 1000) / (now - this._countT);
      this._count = 0;
      this._countT = now;
    }
  }

  // A GPU that answers, but slowly (software rendering, a starved GPU), is tried once on the
  // CPU, and the CPU is kept only if it proves faster.
  checkPace(ms) {
    if (this.paced || this.kind !== 'worker' || !this.worker) return;
    const now = performance.now();
    const P = this.pace || (this.pace = { t0: now, n: 0, sum: 0 });
    if (now - P.t0 < 500) return; // past the warm-up
    P.n++;
    P.sum += ms;
    if (now - P.t0 < 2500 || P.n < 5) return;
    const avg = P.sum / P.n;
    this.pace = null;
    if (this.delegate === 'GPU' && !this.gpuMs && avg > this.slowMs) {
      this.gpuMs = avg;
      this.swap('CPU', 'GPU hand tracking is slow; trying the CPU');
    } else {
      this.paced = true;
      if (this.delegate === 'CPU' && this.gpuMs && avg > this.gpuMs * 1.2) this.swap('GPU', 'CPU hand tracking is slower; back to the GPU');
    }
  }

  async swap(delegate, why) {
    if (this.stopped || this.swapping) return;
    this.swapping = true;
    console.debug(why);
    this.worker?.terminate();
    this.worker = null;
    try {
      await this.initWorker(delegate);
    } catch (err) {
      if (!this.stopped) {
        this.onError(err);
        this.stop();
        this.onLost('tracking');
      }
    }
    this.swapping = false;
    this.busy = false;
  }

  // Some GPUs (and software WebGL) take many seconds for the first GPU inference.
  // If nothing comes back in time, restart the worker on the CPU delegate.
  armWatchdog() {
    if (this.gotResult || this.watchdog || this.delegate !== 'GPU' || this.kind !== 'worker') return;
    this.watchdog = setTimeout(() => {
      if (this.gotResult || this.stopped) return;
      this.swap('CPU', 'GPU hand tracking is slow to start; switching to CPU');
    }, this.watchdogMs);
  }

  onWorkerMessage(m) {
    if (m.type === 'result') {
      this.gotResult = true;
      clearTimeout(this.watchdog);
      this.busy = false;
      this.tick(m.ms || 0);
      if (!m.failed) this.checkPace(m.ms || 0);
      if (!this.stopped) this.onResult(m, m.ts / 1000);
    } else if (m.type === 'delegate') {
      this.delegate = m.delegate;
      this.pace = null;
    } else if (m.type === 'error') {
      this.onError(new Error(m.message));
    }
  }

  start(video) {
    this.video = video;
    let lastVideoTime = -1;
    let seenTime = -1;
    this.frameAt = performance.now();
    // back from a hidden tab, the camera gets a fresh moment to show a frame
    this.onVisible = () => {
      if (document.visibilityState === 'visible') this.frameAt = performance.now();
    };
    document.addEventListener('visibilitychange', this.onVisible);
    const pump = () => {
      if (this.stopped) return;
      const now = performance.now();
      if (video.readyState >= 2 && video.currentTime !== seenTime) {
        seenTime = video.currentTime;
        this.frameAt = now;
      }
      // the camera went away: unplugged, access revoked, or taken by another app (its track
      // ends), or it simply stopped sending frames
      const track = video.srcObject?.getVideoTracks?.()[0];
      if (!track || track.readyState === 'ended' || (document.visibilityState === 'visible' && now - this.frameAt > this.stallMs)) {
        this.stop();
        this.onLost('camera');
        return;
      }
      // a worker that stopped answering (it crashed) is started again
      if (this.kind === 'worker' && this.busy && this.gotResult && !this.swapping && now - this.sentAt > this.stuckMs) {
        this.swap(this.delegate || this.prefer, 'hand tracking stopped answering; restarting it');
      }
      if (!this.busy && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const ts = this.nextTs();
        if (this.kind === 'worker') {
          if (!this.worker || this.swapping) {
            requestAnimationFrame(pump);
            return;
          }
          this.busy = true;
          this.sentAt = now;
          this.armWatchdog();
          createImageBitmap(video)
            .then((bmp) => this.worker.postMessage({ type: 'frame', bitmap: bmp, ts }, [bmp]))
            .catch(() => {
              this.busy = false;
            });
        } else {
          const t0 = performance.now();
          try {
            const res = this.ctx.lm.detectForVideo(video, ts);
            this.tick(performance.now() - t0);
            this.onResult(res, ts / 1000);
          } catch (err) {
            if (this.ctx.delegate === 'GPU') {
              this.ctx.delegate = 'CPU';
              this.delegate = 'CPU';
              this.ctx.make('CPU').then((lm) => (this.ctx.lm = lm)).catch(this.onError);
            } else this.onError(err);
          }
        }
      }
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.watchdog);
    if (this.worker) this.worker.terminate();
    this.worker = null;
    if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
  }
}

// --------------------------------------------------------------- features
const _v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _m = new THREE.Matrix4();

// MediaPipe camera frame (x right, y down, z away from camera, unmirrored) -> app frame
// (x = user's right, y up, z toward the user). (x, y, z) -> (-x, -y, z) is a proper rotation.
function P(world, i, out) {
  const p = world[i];
  return out.set(-p.x, -p.y, p.z);
}

export function palmQuat(world, out = new THREE.Quaternion()) {
  const w = P(world, 0, _v[0]);
  const up = _v[1].set(0, 0, 0);
  for (const i of [5, 9, 13]) up.add(P(world, i, _v[2]));
  up.multiplyScalar(1 / 3).sub(w).normalize();
  const across = P(world, 5, _v[2]).sub(P(world, 17, _v[3]));
  const z = new THREE.Vector3().crossVectors(across, up).normalize();
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  _m.makeBasis(x, up, z);
  return out.setFromRotationMatrix(_m);
}

export function openness(world) {
  const W = world[0];
  const scores = [];
  for (const [a, b, c, d] of FINGERS) {
    const A = world[a];
    const B = world[b];
    const C = world[c];
    const D = world[d];
    const chain = dist3(A, B) + dist3(B, C) + dist3(C, D);
    const straight = chain > 1e-6 ? dist3(A, D) / chain : 0;
    const mcp = W ? dist3(W, A) : 0;
    const ext = mcp > 1e-6 ? Math.min(1, Math.max(0, (dist3(W, D) / mcp - 0.95) / 0.95)) : 0;
    scores.push(Math.max(straight, 0.55 * straight + 0.45 * ext));
  }
  scores.sort((x, y) => x - y);
  return (0.4 * scores[0] + scores[1] + scores[2] + scores[3]) / 3.4;
}

function dist3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function reachMap(x, y, reach = tuning.reach) {
  return [0.5 + (x - 0.5) * reach, 0.5 + (y - 0.5) * reach];
}

function features(lm, world, handed, aspect) {
  let cx = 0;
  let cy = 0;
  for (const i of PALM) {
    cx += lm[i].x;
    cy += lm[i].y;
  }
  cx /= PALM.length;
  cy /= PALM.length;
  const X = 1 - cx; // mirrored, like a selfie view
  const Y = cy;
  const dx = (lm[9].x - lm[0].x) * aspect;
  const dy = lm[9].y - lm[0].y;
  const size = Math.hypot(dx, dy);
  return {
    center: [X, Y],
    quat: palmQuat(world),
    open: openness(world),
    size,
    tips: TIPS.map((i) => [1 - lm[i].x, lm[i].y]),
    points: lm.map((p) => [1 - p.x, p.y]),
    handed: handed?.categoryName ?? '',
    score: handed?.score ?? 1,
  };
}

// --------------------------------------------------------------- tracks
// camera noise levels shared by all hands (rad, and frame widths, per sample), so a new hand starts
// calm; they begin at a typical webcam's and are measured from then on
export const poseNoise = { n: 0.0087 };
export const centerNoise = { n: 0.0004 };
const centerOpts = {
  get still() {
    return tuning.posStill;
  },
  get fast() {
    return tuning.posFast;
  },
  detect: 0.5,
  m0: 2.0,
  m1: 1.5,
  rCutoff: 2.0,
  nCutoff: 0.5,
  gate: 0.1, // frames/s: noise is measured while the hand moves slower than this
  nRef: 0.0004, // a webcam's palm-center noise for a hand about a sixth of the frame tall
  nPow: 1.0,
  nMax: 1.4,
};
const poseOpts = {
  get still() {
    return tuning.oriStill;
  },
  get fast() {
    return tuning.oriFast;
  },
  get detect() {
    return tuning.oriDetect;
  },
  get t0() {
    return tuning.oriT0;
  },
  get t1() {
    return tuning.oriT1;
  },
  get tCutoff() {
    return tuning.oriTCut;
  },
  get s0() {
    return tuning.oriS0;
  },
  get s1() {
    return tuning.oriS1;
  },
  get sTau() {
    return tuning.oriSTau;
  },
  nCutoff: 0.5,
  gate: 0.6,
  nRef: 0.0087, // noise (rad) above which a still hand is smoothed harder...
  nPow: 1.0,
  get nMax() {
    return tuning.oriNMax; // ...up to this factor
  },
  get jump() {
    return tuning.oriJump;
  },
  get jumpRate() {
    return tuning.oriJumpRate;
  },
};

class Track {
  constructor(id, f, t) {
    this.id = id;
    this.born = t;
    this.lastSeen = t;
    this.fCenter = new PoseFilterVec(2, centerOpts, centerNoise);
    this.fQuat = new PoseFilterQuat(poseOpts, poseNoise);
    this.fOpen = new OneEuro(5.0, 1.0, 1.0);
    this.w = this.fQuat.v; // angular velocity of the filtered palm (rad/s, app frame)
    this.vc = this.fCenter.v; // velocity of the filtered palm center (camera frames/s)
    this.dtDet = 1 / 30; // typical time between camera results
    this.refit = 0; // readings left during which a grab re-anchors (the hand was just found again)
    this.isOpen = f.open > tuning.openOn;
    this.pendingOpen = this.isOpen;
    this.pendingSince = t;
    this.openSince = this.isOpen ? t : null;
    this.steadySince = null;
    this.history = []; // {t, q, open, c}
    this.apply(f, t);
  }

  // dtRes: the tracker's typical time between results
  apply(f, t, dtRes = 1 / 30) {
    const prevT = this.lastSeen;
    this.raw = f;
    this.lastSeen = t;
    // found again after a gap: the first readings can jump while the tracker settles on the hand
    // again (the hand itself did not move), so a grab re-anchors on them instead of following
    const gap = t - prevT;
    this.refit = gap > Math.max(tuning.refitGap, 2.5 * dtRes) ? tuning.refitN : Math.max(0, this.refit - 1);
    if (this.refit > 0) {
      // and the filters start afresh on each of them: a jump between them is not motion
      this.fQuat.reset();
      this.fCenter.reset();
    }
    this.center = this.fCenter.filter(f.center, t);
    this.quat = this.fQuat.filter(f.quat, t);
    this.open = this.fOpen.filter(f.open, t);
    // the filters keep their own velocities (this.vc, this.w), used to carry the hand forward
    // between camera results
    const dt = t - prevT;
    if (dt > 1e-4 && dt < 0.25) this.dtDet += 0.2 * (dt - this.dtDet);
    this.size = f.size;
    this.tips = f.tips;
    this.points = f.points;
    this.handed = f.handed;
    // open/closed with hysteresis + debounce
    const want = this.isOpen ? this.open > tuning.openOff : this.open > tuning.openOn;
    if (want !== this.isOpen) {
      if (this.pendingOpen !== want) {
        this.pendingOpen = want;
        this.pendingSince = t;
      }
      if (t - this.pendingSince >= tuning.debounce) {
        this.isOpen = want;
        this.openSince = want ? t : null;
      }
    } else {
      this.pendingOpen = this.isOpen;
      this.pendingSince = t;
    }
    this.history.push({ t, q: this.quat.clone(), open: this.open, raw: f.open, c: f.center.slice() });
    while (this.history.length > 2 && t - this.history[0].t > 0.6) this.history.shift();
    // settled: an open hand that has stopped travelling and turning
    const m = this.isOpen ? this.motion(t) : null;
    if (!m || m.speed > tuning.steadySpeed || m.turn > tuning.steadyTurn) this.steadySince = null;
    else if (this.steadySince === null) this.steadySince = t;
  }

  // palm travel (camera frames/s, x and y) and turn rate (rad/s) over a window ending at tEnd
  motion(tEnd = this.lastSeen, window = 0.1) {
    const h = this.history;
    let j = h.length - 1;
    while (j >= 0 && h[j].t > tEnd + 1e-6) j--;
    if (j < 1) return null;
    const b = h[j];
    let i = j - 1;
    while (i > 0 && b.t - h[i].t < window - 1e-6) i--;
    const a = h[i];
    const dt = b.t - a.t;
    if (dt < 0.03) return null;
    const vx = (b.c[0] - a.c[0]) / dt;
    const vy = (b.c[1] - a.c[1]) / dt;
    return { vx, vy, speed: Math.hypot(vx, vy), turn: a.q.angleTo(b.q) / dt };
  }

  // a new open hand may take hold once it is on screen and has settled (or has been open a while)
  armed(t) {
    if (!this.isOpen) return false;
    const [sx, sy] = this.screen;
    if (sx < 0.02 || sx > 0.98 || sy < 0.02 || sy > 0.97) return false;
    if (this.steadySince !== null && t - this.steadySince >= tuning.armSteady - 1e-6) return true;
    return this.openSince !== null && t - this.openSince >= tuning.armMax;
  }

  // when the hand began to close: the last moment its openness was still near its recent plateau
  closeStartTime(window = 0.5) {
    const h = this.history;
    if (!h.length) return this.lastSeen;
    const tEnd = h[h.length - 1].t;
    let plateau = 0;
    for (const s of h) if (tEnd - s.t <= window && s.open > plateau) plateau = s.open;
    for (let j = h.length - 1; j >= 0; j--) if (h[j].open >= plateau - 0.05) return h[j].t;
    return h[0].t;
  }

  // the hand has begun to close: its openness has fallen at least `drop` below its recent
  // plateau and fell again on each of the last two camera frames
  // Whether the hand has begun to close: openness has fallen `drop` below its recent plateau
  // while still falling, or is falling faster than `rate` per second and has already fallen
  // half that far. An open hand at rest holds its openness to about 0.001.
  // Raw (unfiltered) openness: it is steady enough, and reacts a frame sooner.
  closing(drop, rate = Infinity, window = 0.4) {
    const h = this.history;
    const n = h.length;
    if (n < 2) return false;
    const tEnd = h[n - 1].t;
    let plateau = 0;
    for (let j = n - 1; j >= 0 && tEnd - h[j].t <= window + 1e-6; j--) plateau = Math.max(plateau, h[j].raw);
    const [b, c] = [h[n - 2].raw, h[n - 1].raw];
    const fell = plateau - c;
    if (fell >= drop && c < b) return true;
    const dt = tEnd - h[n - 2].t;
    return dt > 0 && dt < 0.1 && (b - c) / dt >= rate && fell >= drop / 2;
  }

  // For a hand that is gone: if it was moved away (fast, or out over the edge of the frame),
  // the time that motion began; null if it vanished in place.
  exitStart() {
    const h = this.history;
    const m = this.motion(this.lastSeen);
    if (!m) return null;
    const [sx, sy] = reachMap(...h[h.length - 1].c);
    const outward = (sy > 0.85 && m.vy > 0) || (sy < 0.1 && m.vy < 0) || (sx < 0.1 && m.vx < 0) || (sx > 0.9 && m.vx > 0);
    if (m.speed < tuning.exitSpeed && !(outward && m.speed > 0.2)) return null;
    let j = h.length - 1;
    while (j > 0) {
      const mj = this.motion(h[j].t, 0.066);
      if (!mj || mj.speed < 0.25 || mj.vx * m.vx + mj.vy * m.vy <= 0) break;
      j--;
    }
    return h[j].t;
  }

  get age() {
    return this.lastSeen - this.born;
  }

  // angular velocity (app frame, rad/s) over a window ending at tEnd
  angularVelocity(tEnd, window = 0.1) {
    const h = this.history.filter((s) => s.t <= tEnd + 1e-6 && s.t >= tEnd - window - 1e-6);
    if (h.length < 2) return new THREE.Vector3();
    const a = h[0];
    const b = h[h.length - 1];
    const dt = b.t - a.t;
    if (dt < 0.03) return new THREE.Vector3();
    const dq = b.q.clone().multiply(a.q.clone().invert());
    if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    const s = Math.sqrt(dq.x * dq.x + dq.y * dq.y + dq.z * dq.z);
    if (s < 1e-9) return new THREE.Vector3();
    const ang = 2 * Math.atan2(s, dq.w);
    return new THREE.Vector3(dq.x / s, dq.y / s, dq.z / s).multiplyScalar(ang / dt);
  }

  // flick velocity: the fastest short-span angular velocity in the window ending at tEnd.
  // People decelerate as they close the hand, so the peak is what they meant.
  flickVelocity(tEnd, window = 0.15, span = 0.06) {
    const h = this.history.filter((s) => s.t <= tEnd + 1e-6 && s.t >= tEnd - window - span - 1e-6);
    let best = new THREE.Vector3();
    let bestLen = 0;
    for (let j = h.length - 1; j > 0; j--) {
      const b = h[j];
      if (b.t < tEnd - window - 1e-6) break;
      let i = j - 1;
      while (i > 0 && b.t - h[i].t < span) i--;
      const a = h[i];
      const dt = b.t - a.t;
      if (dt < 0.03) continue;
      const dq = b.q.clone().multiply(a.q.clone().invert());
      if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
      const sn = Math.sqrt(dq.x * dq.x + dq.y * dq.y + dq.z * dq.z);
      if (sn < 1e-9) continue;
      const ang = (2 * Math.atan2(sn, dq.w)) / dt;
      if (ang > bestLen) {
        bestLen = ang;
        best = new THREE.Vector3(dq.x / sn, dq.y / sn, dq.z / sn).multiplyScalar(ang);
      }
    }
    return best;
  }

  // last time the hand was still clearly open (before a closing motion began)
  lastOpenTime() {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].open >= tuning.openOn) return this.history[i].t;
    }
    return this.history.length ? this.history[0].t : this.lastSeen;
  }

  get screen() {
    return reachMap(this.center[0], this.center[1]);
  }

  // how far past the last camera result the hand is carried forward at time t
  ahead(t) {
    return Math.min(Math.max(0, t - this.lastSeen), Math.min(this.dtDet, tuning.predictMax));
  }

  // palm orientation at time t (between camera results), predicted from its angular velocity
  quatAt(t, out = new THREE.Quaternion()) {
    out.copy(this.quat);
    const a = this.ahead(t);
    if (a > 0) integrateQuat(out, this.w.clone().multiplyScalar(a), 1);
    return out;
  }

  centerAt(t) {
    const a = this.ahead(t);
    return [this.center[0] + this.vc[0] * a, this.center[1] + this.vc[1] * a];
  }

  screenAt(t) {
    const [x, y] = this.centerAt(t);
    return reachMap(x, y);
  }
}

export class HandTracker {
  constructor() {
    this.tracks = [];
    this.nextId = 1;
    this.aspect = 16 / 9;
    this.lastResultT = 0;
    this.dtRes = 1 / 30; // typical time between results: the median of the last few, so a stall
    this.steps = []; //      does not count but a slower detector soon does
  }

  // every hand gone at once (the camera stopped)
  clear() {
    this.tracks = [];
    this.lastResultT = 0;
    this.steps = [];
  }

  // result: MediaPipe HandLandmarkerResult (landmarks, worldLandmarks, handedness)
  update(result, t) {
    const dtRes = this.dtRes;
    const step = t - this.lastResultT;
    if (this.lastResultT > 0 && step > 1e-4) {
      this.steps.push(step);
      if (this.steps.length > 9) this.steps.shift();
      const sorted = this.steps.slice().sort((a, b) => a - b);
      this.dtRes = sorted[sorted.length >> 1];
    }
    this.lastResultT = t;
    const lms = result?.landmarks ?? [];
    const worlds = result?.worldLandmarks ?? [];
    const hands = result?.handedness ?? result?.handednesses ?? [];
    const dets = [];
    for (let i = 0; i < lms.length; i++) {
      if (!lms[i] || !worlds[i] || lms[i].length < 21 || worlds[i].length < 21) continue;
      dets.push(features(lms[i], worlds[i], hands[i]?.[0], this.aspect));
    }
    // greedy nearest matching on palm center
    const pairs = [];
    this.tracks.forEach((tr, ti) => {
      dets.forEach((d, di) => {
        const dd = Math.hypot(tr.center[0] - d.center[0], tr.center[1] - d.center[1]);
        pairs.push([dd, ti, di]);
      });
    });
    pairs.sort((a, b) => a[0] - b[0]);
    const usedT = new Set();
    const usedD = new Set();
    for (const [dd, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di) || dd > 0.35) continue;
      usedT.add(ti);
      usedD.add(di);
      this.tracks[ti].apply(dets[di], t, dtRes);
    }
    dets.forEach((d, di) => {
      if (!usedD.has(di)) this.tracks.push(new Track(this.nextId++, d, t));
    });
    this.tracks = this.tracks.filter((tr) => t - tr.lastSeen <= tuning.grace);
    return this.tracks;
  }

  // tracks seen in the most recent result
  visible() {
    return this.tracks.filter((tr) => tr.lastSeen === this.lastResultT);
  }

  reset() {
    this.tracks = [];
  }
}
