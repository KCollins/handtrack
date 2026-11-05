// filters.js - One Euro filters (Casiez et al. 2012) for scalars, vectors and rotations.
import * as THREE from 'three';

const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  filter(value, t) {
    if (this.x === null || this.t === null) {
      this.x = value;
      this.dx = 0;
      this.t = t;
      return value;
    }
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    const dRaw = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (dRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

// Vector filter: the cutoff adapts to the vector speed (not per-axis), so a diagonal
// motion is filtered like an axis-aligned one. As in the reference 1-euro filter, the
// speed comes from the low-passed signed derivative of the raw signal, so noise at
// rest averages out instead of opening the filter.
export class OneEuroVec {
  constructor(dim, minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.dim = dim;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.x = null;
    this.prev = null;
    this.dx = null;
    this.speed = 0;
    this.t = null;
  }
  filter(v, t) {
    if (this.x === null) {
      this.x = Array.from(v);
      this.prev = Array.from(v);
      this.dx = new Array(this.dim).fill(0);
      this.speed = 0;
      this.t = t;
      return this.x.slice();
    }
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    const ad = alpha(this.dCutoff, dt);
    let s2 = 0;
    for (let i = 0; i < this.dim; i++) {
      this.dx[i] += ad * ((v[i] - this.prev[i]) / dt - this.dx[i]);
      s2 += this.dx[i] * this.dx[i];
      this.prev[i] = v[i];
    }
    this.speed = Math.sqrt(s2);
    const a = alpha(this.minCutoff + this.beta * this.speed, dt);
    for (let i = 0; i < this.dim; i++) this.x[i] += a * (v[i] - this.x[i]);
    return this.x.slice();
  }
}

// Rotation filter: speed = magnitude of the low-passed angular velocity vector
// (rad/s) between successive raw samples. Using the signed vector rather than the
// step size keeps sensor noise from raising the cutoff while the hand is still.
export class OneEuroQuat {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0, speedFloor = 0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.speedFloor = speedFloor; // rad/s of residual noise speed ignored by the cutoff
    this.q = new THREE.Quaternion();
    this.prev = new THREE.Quaternion();
    this.w = new THREE.Vector3();
    this._dq = new THREE.Quaternion();
    this._inv = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this.reset();
  }
  reset() {
    this.has = false;
    this.speed = 0;
    this.t = null;
    this.w.set(0, 0, 0);
  }
  filter(qIn, t) {
    if (!this.has) {
      this.q.copy(qIn);
      this.prev.copy(qIn);
      this.has = true;
      this.t = t;
      this.speed = 0;
      this.w.set(0, 0, 0);
      return this.q.clone();
    }
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    const q = qIn.clone();
    if (q.dot(this.prev) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    this._dq.copy(q).multiply(this._inv.copy(this.prev).invert());
    quatToRotVec(this._dq, this._v).multiplyScalar(1 / dt);
    this.w.lerp(this._v, alpha(this.dCutoff, dt));
    this.speed = this.w.length();
    this.prev.copy(q);
    if (q.dot(this.q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    const fast = Math.max(0, this.speed - this.speedFloor);
    this.q.slerp(q, alpha(this.minCutoff + this.beta * fast, dt));
    return this.q.clone();
  }
}

// rotation vector (axis * angle) of a unit quaternion, shortest arc
export function quatToRotVec(q, out = new THREE.Vector3()) {
  let { x, y, z, w } = q;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-9) return out.set(0, 0, 0);
  const ang = 2 * Math.atan2(s, w);
  return out.set((x / s) * ang, (y / s) * ang, (z / s) * ang);
}

export function rotVecToQuat(v, out = new THREE.Quaternion()) {
  const ang = v.length();
  if (ang < 1e-9) return out.set(0, 0, 0, 1);
  const s = Math.sin(ang / 2) / ang;
  return out.set(v.x * s, v.y * s, v.z * s, Math.cos(ang / 2));
}

// raise a rotation to a power (scale its angle)
export function quatPow(q, k, out = new THREE.Quaternion()) {
  const v = quatToRotVec(q);
  v.multiplyScalar(k);
  return rotVecToQuat(v, out);
}

// integrate angular velocity w (world frame, rad/s) over dt onto q
export function integrateQuat(q, w, dt) {
  const dq = rotVecToQuat(new THREE.Vector3().copy(w).multiplyScalar(dt));
  return q.premultiply(dq).normalize();
}

export const damp = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-5, tau));

// Rotation tracker for noisy camera poses: a critically damped alpha-beta (g-h) filter on
// the rotation manifold, so a steady turn is followed without lag and the angular velocity
// comes out smooth. Its memory adapts to manoeuvres rather than to speed: the tracker's own
// prediction error, averaged as a vector so noise cancels and a consistent error stands out,
// shortens the memory only when it rises above the measured noise (a start, stop or
// reversal), and an error that trails the turn sheds velocity at once, so a stop lands where
// the hand stopped. The measurement noise is estimated online from second differences while
// the hand is slow, and is shared across hands through `shared`, so a new hand starts calm.
// Noise-free input (tests) runs at the short memory and follows exactly.
export class PoseFilterQuat {
  constructor(opts, shared = { n: 0 }) {
    this.o = opts; // { still, fast, detect, t0, t1, tCutoff, s0, s1, sTau, nCutoff, gate, nRef, nPow, nMax, jump, jumpRate }
    this.shared = shared;
    this.q = new THREE.Quaternion();
    this.v = new THREE.Vector3(); // angular velocity, rad/s, world frame
    this.qd = new THREE.Quaternion();
    this.vd = new THREE.Vector3();
    this.z1 = new THREE.Quaternion();
    this.z2 = new THREE.Quaternion();
    this.rv = new THREE.Vector3(); // the tracker's averaged prediction error (rotation vector)
    this._p = new THREE.Quaternion();
    this._r = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._dq = new THREE.Quaternion();
    this._z = new THREE.Quaternion();
    this._pq = new THREE.Quaternion();
    this._zin = new THREE.Quaternion();
    this.heldCount = 0; // readings held back as glitches (for tests and the debug readout)
    this.reset();
  }
  reset() {
    this.has = 0;
    this.t = null;
    this.held = null;
    this.v.set(0, 0, 0);
    this.vd.set(0, 0, 0);
    this.rv.set(0, 0, 0);
    this.memory = this.o.fast;
  }
  get speed() {
    return this.v.length();
  }
  // residual rotation vector log(z * p^-1) into out
  resid(z, p, out) {
    this._dq.copy(z).multiply(this._p.copy(p).invert());
    return quatToRotVec(this._dq, out);
  }
  // A reading far off the hand's course (a one-frame tracking glitch) is held back for a frame,
  // and the course carries on meanwhile. If the next reading agrees with it, it was real (a
  // sudden flick) and both are taken in order; otherwise it is dropped. Two such frames in a
  // row at most, so a hand that really jumped is followed a frame or two late, never lost.
  filter(qIn, t) {
    const o = this.o;
    const z = this._zin.copy(qIn);
    const dt = t - this.t;
    if (this.has >= 2 && o.jump > 0 && dt > 1e-4 && dt <= 0.25) {
      if (z.dot(this.z1) < 0) z.set(-z.x, -z.y, -z.z, -z.w);
      const pq = this._pq.copy(this.q);
      integrateQuat(pq, this.v, dt);
      const off = this.resid(z, pq, this._a).length();
      if (off > Math.max(o.jump, o.jumpRate * dt)) {
        const H = this.held;
        if (H && this.resid(z, H.q, this._b).length() < off) {
          // confirmed: the hand really moved that far
          this.held = null;
          this.update(H.q, H.t);
          return this.update(z, t);
        }
        if (!H || H.n < 2) {
          this.held = { q: z.clone(), t, n: (H?.n ?? 0) + 1 };
          this.heldCount++;
          return pq.clone();
        }
      }
    }
    this.held = null;
    return this.update(z, t);
  }

  update(qIn, t) {
    const o = this.o;
    const z = this._z.copy(qIn);
    if (!this.has) {
      this.q.copy(z);
      this.qd.copy(z);
      this.z1.copy(z);
      this.has = 1;
      this.t = t;
      return this.q.clone();
    }
    if (z.dot(this.z1) < 0) z.set(-z.x, -z.y, -z.z, -z.w);
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    if (dt > 0.25) {
      // after a gap, do not carry an old velocity across it
      this.v.set(0, 0, 0);
      this.vd.set(0, 0, 0);
      this.rv.set(0, 0, 0);
      this.has = 1;
    }
    // measurement noise from the second difference of raw samples, while slow
    if (this.has >= 2 && this.vd.length() < o.gate) {
      this.resid(z, this.z1, this._a);
      this.resid(this.z1, this.z2, this._b);
      const e = Math.min(this._a.sub(this._b).length() / Math.sqrt(6), 3 * this.shared.n + 0.004);
      this.shared.n += alpha(o.nCutoff, dt) * (e - this.shared.n);
    }
    this.z2.copy(this.z1);
    this.z1.copy(z);
    this.has = Math.min(2, this.has + 1);
    // a slow fixed-memory tracker, whose speed tells when the hand is slow enough to measure
    const thd = Math.exp(-dt / o.detect);
    integrateQuat(this.qd, this.vd, dt);
    this.resid(z, this.qd, this._r);
    integrateQuat(this.qd, this._r, 1 - thd * thd);
    this.vd.addScaledVector(this._r, ((1 - thd) * (1 - thd)) / dt);
    // the tracker: its memory runs from `still` down to `fast` as its averaged prediction error
    // rises above the noise
    const sig = this.shared.n + 1e-7;
    integrateQuat(this.q, this.v, dt);
    this.resid(z, this.q, this._r);
    this.rv.lerp(this._r, alpha(o.tCutoff, dt));
    const u = Math.max(0, this.rv.length() / sig - o.t0) / o.t1;
    // an error that trails the turn means the hand is slowing
    const sp = this.v.length();
    const lag = sp > 1e-6 ? -this.rv.dot(this.v) / sp : 0;
    const brake = Math.max(0, lag / sig - o.s0) / o.s1;
    const still = o.still * Math.min(o.nMax, Math.max(1, Math.pow(sig / o.nRef, o.nPow)));
    this.memory = o.fast + (still - o.fast) / (1 + u * u);
    const th = Math.exp(-dt / this.memory);
    integrateQuat(this.q, this._r, 1 - th * th);
    this.v.addScaledVector(this._r, ((1 - th) * (1 - th)) / dt);
    if (brake > 0) {
      // shed speed quickly, but never more than the trailing error accounts for, and only as
      // far as a long memory has not already followed it, so a clean signal is not jolted
      const s2 = this.v.length();
      const gf = 1 - Math.exp(-dt / o.fast);
      const room = Math.max(0, 1 - ((1 - th) * (1 - th)) / (gf * gf));
      const cut = room * Math.min(1 - Math.exp((-dt * brake) / o.sTau), s2 > 1e-9 ? lag / (dt * s2) : 1);
      this.v.multiplyScalar(1 - cut);
    }
    return this.q.clone();
  }
}

// The same adaptive tracker for a position (any number of dimensions): a critically damped
// alpha-beta filter whose memory is long while the hand holds still (noise averages out) and
// short the moment it moves (prediction error above the measured noise), so a steady move has
// no lag and a stop has no overshoot. Velocity comes from the same filter.
export class PoseFilterVec {
  constructor(dim, opts, shared = { n: 0 }) {
    this.dim = dim;
    this.o = opts; // { still, fast, detect, m0, m1, rCutoff, nCutoff, gate, nRef, nPow, nMax }
    this.shared = shared;
    this.x = new Array(dim).fill(0);
    this.v = new Array(dim).fill(0);
    this.xd = new Array(dim).fill(0);
    this.vd = new Array(dim).fill(0);
    this.z1 = new Array(dim).fill(0);
    this.z2 = new Array(dim).fill(0);
    this.reset();
  }
  reset() {
    this.has = 0;
    this.t = null;
    this.v.fill(0);
    this.vd.fill(0);
    this.rlp = 0;
    this.memory = this.o.fast;
  }
  filter(z, t) {
    const o = this.o;
    const D = this.dim;
    if (!this.has) {
      for (let i = 0; i < D; i++) this.x[i] = this.xd[i] = this.z1[i] = z[i];
      this.has = 1;
      this.t = t;
      return this.x.slice();
    }
    const dt = Math.max(1e-4, t - this.t);
    this.t = t;
    if (dt > 0.25) {
      this.v.fill(0);
      this.vd.fill(0);
      this.has = 1;
    }
    let vds = 0;
    for (let i = 0; i < D; i++) vds += this.vd[i] * this.vd[i];
    if (this.has >= 2 && Math.sqrt(vds) < o.gate) {
      let e2 = 0;
      for (let i = 0; i < D; i++) {
        const d = z[i] - 2 * this.z1[i] + this.z2[i];
        e2 += d * d;
      }
      const e = Math.min(Math.sqrt(e2) / Math.sqrt(6), 3 * this.shared.n + o.nRef * 0.5);
      this.shared.n += alpha(o.nCutoff, dt) * (e - this.shared.n);
    }
    for (let i = 0; i < D; i++) {
      this.z2[i] = this.z1[i];
      this.z1[i] = z[i];
    }
    this.has = Math.min(2, this.has + 1);
    // detector with a fixed slow memory: its prediction error flags a move
    const thd = Math.exp(-dt / o.detect);
    const gd = 1 - thd * thd;
    const hd = ((1 - thd) * (1 - thd)) / dt;
    let r2 = 0;
    for (let i = 0; i < D; i++) {
      this.xd[i] += this.vd[i] * dt;
      const r = z[i] - this.xd[i];
      r2 += r * r;
      this.xd[i] += gd * r;
      this.vd[i] += hd * r;
    }
    this.rlp += alpha(o.rCutoff, dt) * (Math.sqrt(r2) - this.rlp);
    // tracker: memory between `still` and `fast`, shortened by moves above the noise
    const sig = this.shared.n + 1e-9;
    const u = Math.max(0, this.rlp / sig - o.m0) / o.m1;
    const still = o.still * Math.min(o.nMax, Math.max(1, Math.pow(sig / o.nRef, o.nPow)));
    this.memory = o.fast + (still - o.fast) / (1 + u * u);
    const th = Math.exp(-dt / this.memory);
    const g = 1 - th * th;
    const h = ((1 - th) * (1 - th)) / dt;
    for (let i = 0; i < D; i++) {
      this.x[i] += this.v[i] * dt;
      const r = z[i] - this.x[i];
      this.x[i] += g * r;
      this.v[i] += h * r;
    }
    return this.x.slice();
  }
}
