// control.js - model dynamics: hand-held rotation, free spin with inertia,
// catch, two-hand zoom/translate/roll, reset. Runs every render frame.
// A short trail of held poses lets a gesture end where the hands meant it to
// (before they began to close or drop away), and soft bounds keep the engine in view.
import * as THREE from 'three';
import { damp, integrateQuat, quatPow, quatToRotVec, rotVecToQuat } from './filters.js';

export const controlTuning = {
  gain: 1.35, // hand rotation -> model rotation
  holdWn: 50, // rad/s: stiffness of the critically damped spring that carries the engine in a hand
  pointerWn: 90, // ...and under a mouse or finger, which reports precisely and often
  spinTau: 6.0, // free spin decay time constant (s)
  catchTau: 0.1, // how fast a caught spin is absorbed (s)
  maxSpin: 12.0, // rad/s
  minSpin: 0.45, // rad/s, slower releases glide to a stop
  glideTau: 0.09, // s: how quickly a slow release comes to rest
  stopSpin: 0.015,
  rampIn: 0.12, // s to fade control in after a grab
  zoomExp: 1.2,
  scaleMin: 0.3,
  scaleMax: 3.0,
  scaleTau: 0.04,
  posTau: 0.04,
  settleTau: 0.07, // s to ease back to the pose a gesture ended on
  bounds: 0.7, // a move carries the engine center freely within this fraction of the view
  margin: 0.03, // once let go, the engine comes to rest this far inside the view (share of its height)
  boundsTau: 0.14, // s to spring back inside after a move past the edge
};

const AXES = ['x', 'y'];

const Z = new THREE.Vector3(0, 0, 1);

export class ModelControl {
  constructor(homeQuat) {
    this.home = { q: homeQuat.clone(), scale: 1, pos: new THREE.Vector3() };
    this.q = homeQuat.clone();
    this.omega = new THREE.Vector3();
    this.held = false;
    this.anchorHand = new THREE.Quaternion();
    this.anchorModel = new THREE.Quaternion();
    this.handQ = new THREE.Quaternion();
    this.handT = 0;
    this.heldGain = 1;
    this.wn = controlTuning.holdWn;
    this.glide = false; // a slow release coming to rest (fast decay instead of a free spin)
    this.limbo = false; // coasting while the holding hand is briefly missing (still reads as held)
    this.catchW = new THREE.Vector3();
    this.ramp = 1;
    this.scale = 1;
    this.scaleTarget = 1;
    this.pos = new THREE.Vector3();
    this.posTarget = new THREE.Vector3();
    this.reset = null;
    this.caught = false;
    this.now = 0;
    this.trail = []; // held poses {t, q, pos, scale}, newest last
    this.grabT = -Infinity;
    this.settleQ = null; // orientation to ease back to after a gesture ends
    this.bounds = null; // {x, y}: half-extents (world units) for the engine center, set by the view
    this.fit = null; // {x: [lo, hi], y: [lo, hi]}: where the engine may rest in full view, set by the view
    this.dragging = false; // position driven by two hands or a pointer
    this.dragRaw = new THREE.Vector3();
    this.shownW = new THREE.Vector3(); // angular velocity of the engine as drawn while held (rad/s)
  }

  get spinSpeed() {
    return this.omega.length();
  }

  // Start holding. handQ is the controller orientation (hand palm frame or virtual).
  // opts.wn: spring stiffness; opts.resume: the same hand takes hold again right after
  // letting go, so the engine carries its motion straight back into the hand (no catch).
  grab(handQ, t, gain = controlTuning.gain, opts = {}) {
    const spinning = this.omega.length();
    this.caught = !opts.resume && spinning > 0.3;
    this.catchW.copy(this.caught ? this.omega : ZERO);
    // the engine keeps the velocity it has; the spring takes it from there
    this.shownW.copy(this.omega);
    this.omega.set(0, 0, 0);
    this.glide = false;
    this.limbo = false;
    this.held = true;
    this.heldGain = gain;
    this.wn = opts.wn ?? controlTuning.holdWn;
    this.anchorHand.copy(handQ);
    // a gesture that just ended may still be easing back to its pose; hold from there
    this.anchorModel.copy(this.settleQ ?? this.q);
    if (this.settleQ) this.shownW.set(0, 0, 0);
    this.settleQ = null;
    this.handQ.copy(handQ);
    this.handT = t;
    this.ramp = opts.resume ? 1 : 0;
    this.reset = null;
    this.grabT = t;
    this.trail.length = 0;
    this.record(t, this.anchorModel);
    return this.caught;
  }

  record(t, q) {
    this.trail.push({ t, q: q.clone(), pos: this.posTarget.clone(), scale: this.scaleTarget });
    while (this.trail.length > 2 && t - this.trail[0].t > 0.8) this.trail.shift();
  }

  // the controller's turn since the grab, scaled by the gain (eased in over the first moments)
  heldDelta(handQ, out = new THREE.Quaternion()) {
    const delta = _hd.copy(handQ).multiply(_hi.copy(this.anchorHand).invert());
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    return quatPow(delta, this.heldGain * easeOut(this.ramp), out);
  }

  // the held orientation for a controller orientation (what the model is easing toward)
  heldTarget(handQ) {
    return this.heldDelta(handQ).multiply(this.anchorModel);
  }

  // Take the controller's orientation as the new reference without moving the engine: while
  // the tracker settles on a hand it just found again, its readings can jump though the hand
  // stayed put.
  rebase(handQ) {
    if (!this.held) return;
    this.anchorModel.copy(this.heldTarget(this.handQ));
    this.anchorHand.copy(handQ);
    this.handQ.copy(handQ);
  }

  // the controller orientation now (hands are already carried forward between camera frames)
  drive(handQ, t) {
    if (!this.held) return;
    this.handQ.copy(handQ);
    this.handT = t;
    this.record(t, this.heldTarget(handQ));
  }

  // After letting go: ease back to the pose held at time tc (never before the current grab).
  rollback(tc) {
    const T = Math.max(tc, this.grabT);
    let s = this.trail[0];
    if (!s) return false;
    for (let i = this.trail.length - 1; i >= 0; i--) {
      if (this.trail[i].t <= T + 1e-6) {
        s = this.trail[i];
        break;
      }
    }
    this.settleQ = s.q.clone();
    this.posTarget.copy(s.pos);
    this.scaleTarget = s.scale;
    if (this.dragging) this.dragRaw.copy(s.pos);
    return true;
  }

  // Let go. w = controller angular velocity at release (rad/s, app frame); null stops in place.
  release(w = null) {
    if (!this.held) return 0;
    this.limbo = false;
    if (!w) {
      this.held = false;
      this.catchW.set(0, 0, 0);
      this.settleQ = null;
      this.omega.set(0, 0, 0);
      this.glide = false;
      return 0;
    }
    return this.letFly(w.clone().multiplyScalar(this.heldGain));
  }

  // Let go at the angular velocity the engine shows right now: a flick flies on without a
  // hitch, and a slow turn glides to rest instead of stopping dead.
  coast(opts = {}) {
    if (!this.held) return 0;
    const speed = this.letFly(this.shownW.clone());
    this.limbo = !!opts.limbo;
    return speed;
  }

  letFly(om) {
    this.held = false;
    this.catchW.set(0, 0, 0);
    this.settleQ = null;
    const s = om.length();
    if (s > controlTuning.maxSpin) om.multiplyScalar(controlTuning.maxSpin / s);
    this.glide = om.length() < controlTuning.minSpin;
    this.omega.copy(om);
    return this.glide ? 0 : this.omega.length();
  }

  // two hands let go: zoom and position come to rest right where they are
  settleTwo() {
    this.scaleTarget = this.scale + (this.scaleTarget - this.scale) * 0.35;
    this.posTarget.lerpVectors(this.pos, this.posTarget, 0.35);
    this.dragRaw.copy(this.posTarget);
  }

  setTwoHand(scale, pos) {
    this.scaleTarget = THREE.MathUtils.clamp(scale, controlTuning.scaleMin, controlTuning.scaleMax);
    this.dragRaw.copy(pos);
    this.rubberBand(pos, this.posTarget);
  }

  zoomBy(f) {
    this.scaleTarget = THREE.MathUtils.clamp(this.scaleTarget * f, controlTuning.scaleMin, controlTuning.scaleMax);
  }

  // moving the engine: past the bounds it follows with growing resistance, and springs back on release
  beginDrag() {
    this.dragging = true;
    this.dragRaw.copy(this.posTarget);
  }

  endDrag() {
    this.dragging = false;
  }

  panBy(v) {
    if (!this.dragging) this.beginDrag();
    this.dragRaw.add(v);
    this.rubberBand(this.dragRaw, this.posTarget);
  }

  rubberBand(p, out) {
    out.copy(p);
    if (!this.bounds) return out;
    for (const ax of AXES) {
      const [lo, hi] = this.moveRange(ax);
      const R = 0.15 * (hi - lo);
      const v = p[ax];
      if (v > hi) out[ax] = hi + R * (1 - Math.exp(-(v - hi) / R));
      else if (v < lo) out[ax] = lo - R * (1 - Math.exp(-(lo - v) / R));
    }
    return out;
  }

  // how far a move may carry the engine freely, and where it comes to rest once let go
  moveRange(ax) {
    const b = this.bounds[ax];
    const f = this.fit?.[ax];
    return f && !this.fit.big?.[ax] ? [Math.min(-b, f[0]), Math.max(b, f[1])] : [-b, b];
  }

  restRange(ax) {
    const b = this.bounds[ax];
    const f = this.fit?.[ax];
    if (!f) return [-b, b];
    // the home position always counts as in view
    const lo = Math.min(0, f[0]);
    const hi = Math.max(0, f[1]);
    // zoomed in past the size of the view, the engine's middle stays within the bounds, so a
    // close look never ends on an edge of the engine with the rest of it off screen
    return this.fit.big?.[ax] ? [Math.max(-b, lo), Math.min(b, hi)] : [lo, hi];
  }

  stop() {
    this.omega.set(0, 0, 0);
    this.glide = false;
    this.limbo = false;
  }

  // bring the model back to the middle at a readable size (used by the exploded view)
  frame() {
    if (this.reset) return;
    this.posTarget.set(0, 0, 0);
    this.scaleTarget = THREE.MathUtils.clamp(this.scaleTarget, 0.7, 1.0);
  }

  // back to the home pose: quick and decisive by default; `gentle` eases in and out
  goHome(dur = 0.8, gentle = false) {
    this.held = false;
    this.dragging = false;
    this.settleQ = null;
    this.omega.set(0, 0, 0);
    this.glide = false;
    this.limbo = false;
    this.reset = { t: 0, dur, gentle, q0: this.q.clone(), s0: this.scaleTarget, p0: this.posTarget.clone() };
  }

  step(dt, now) {
    this.now = now;
    if (this.reset) {
      const r = this.reset;
      r.t += dt / r.dur;
      const u = Math.min(1, r.t);
      const e = r.gentle ? u * u * u * (u * (u * 6 - 15) + 10) : 1 - Math.pow(1 - u, 3);
      this.q.slerpQuaternions(r.q0, this.home.q, e);
      this.scaleTarget = THREE.MathUtils.lerp(r.s0, 1, e);
      this.posTarget.lerpVectors(r.p0, this.home.pos, e);
      if (r.t >= 1) this.reset = null;
    } else if (this.held) {
      this.ramp = Math.min(1, this.ramp + dt / controlTuning.rampIn);
      if (this.catchW.lengthSq() > 1e-8) {
        // a caught spin keeps sliding briefly inside the hand, then dies out. The spring runs in
        // the sliding frame, so the engine slows smoothly from the moment it is caught.
        const D = this.heldDelta(this.handQ, _D);
        const t0 = _t0.copy(D).multiply(this.anchorModel);
        this.shownW.sub(_wT.copy(this.catchW).applyQuaternion(D));
        integrateQuat(this.anchorModel, this.catchW, dt);
        this.catchW.multiplyScalar(Math.exp(-dt / controlTuning.catchTau));
        if (this.catchW.length() < 0.01) this.catchW.set(0, 0, 0);
        springTo(this.q, this.shownW, t0, this.wn, dt, _t1.copy(D).multiply(this.anchorModel));
        this.shownW.add(_wT.copy(this.catchW).applyQuaternion(D));
      } else {
        springTo(this.q, this.shownW, this.heldTarget(this.handQ), this.wn, dt);
      }
    } else {
      const s = this.omega.length();
      if (s > 0) {
        integrateQuat(this.q, this.omega, dt);
        this.omega.multiplyScalar(Math.exp(-dt / (this.glide ? controlTuning.glideTau : controlTuning.spinTau)));
        if (this.omega.length() < controlTuning.stopSpin) {
          this.omega.set(0, 0, 0);
          this.glide = false;
        }
      } else if (this.settleQ) {
        this.q.slerp(this.settleQ, damp(dt, controlTuning.settleTau));
        if (this.q.angleTo(this.settleQ) < 1e-3) this.settleQ = null;
      }
    }
    // soft bounds: spring the engine back into full view once nothing is moving it
    if (this.bounds && !this.dragging && !this.reset) {
      const k = damp(dt, controlTuning.boundsTau);
      for (const ax of AXES) {
        const [lo, hi] = this.restRange(ax);
        const v = this.posTarget[ax];
        if (v > hi) this.posTarget[ax] += (hi - v) * k;
        else if (v < lo) this.posTarget[ax] += (lo - v) * k;
      }
    }
    this.scale += (this.scaleTarget - this.scale) * damp(dt, controlTuning.scaleTau);
    this.pos.lerp(this.posTarget, damp(dt, controlTuning.posTau));
    this.q.normalize();
  }
}

const ZERO = new THREE.Vector3();
const _inv = new THREE.Quaternion();
const _e = new THREE.Vector3();
const _c = new THREE.Vector3();
const _eq = new THREE.Quaternion();
const _hd = new THREE.Quaternion();
const _hi = new THREE.Quaternion();
const _D = new THREE.Quaternion();
const _t0 = new THREE.Quaternion();
const _t1 = new THREE.Quaternion();
const _wT = new THREE.Vector3();

// One step of a critically damped rotational spring toward a target orientation, solved
// exactly for the step: q = exp(e) * target, with e'' = -wn^2 e - 2 wn e' (w = e', world frame).
// Response is smooth and even at any frame rate, with no overshoot from a standing start.
// A target that moves on during the step (targetNext) carries the error along with it.
function springTo(q, w, target, wn, dt, targetNext = target) {
  if (dt <= 0) return;
  _eq.copy(q).multiply(_inv.copy(target).invert());
  quatToRotVec(_eq, _e);
  const k = Math.exp(-wn * dt);
  _c.copy(w).addScaledVector(_e, wn); // v0 + wn e0
  _e.addScaledVector(_c, dt).multiplyScalar(k);
  w.addScaledVector(_c, -wn * dt).multiplyScalar(k);
  q.copy(rotVecToQuat(_e, _eq)).multiply(targetNext).normalize();
}

export function rollQuat(angle) {
  return new THREE.Quaternion().setFromAxisAngle(Z, angle);
}

function easeOut(x) {
  return 1 - (1 - x) * (1 - x);
}
