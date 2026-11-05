// gestures.js - the interaction grammar from the demo:
//   open hand            -> grab: the model follows the hand's rotation
//   close hand / leave   -> release: the engine flies on at the speed it is turning
//   open hand on a spin  -> catch
//   two open hands       -> zoom (spread), move (both hands together), roll (steer)
//   two fists            -> pulled apart: exploded view; pushed together: assembled
// Gestures start only once a new hand has settled. A hand lets go the moment it starts
// to close, so the engine never stalls or lurches; if it opens straight back up it takes
// hold again where it is. Hands that drop away or vanish leave the engine where it was
// before they began to leave.
//
// update() runs on each camera result and changes state; follow() runs every frame and
// drives the engine from hands carried forward between camera results.
import * as THREE from 'three';
import { controlTuning, rollQuat } from './control.js';
import { rotVecToQuat } from './filters.js';
import { tuning as handTuning } from './hands.js';

export const gestureTuning = {
  minAge: 0.025, // s a hand must be tracked before it can grab
  releaseWindow: 0.15, // s of motion searched for the throw velocity of a vanished hand
  rollDeadzone: THREE.MathUtils.degToRad(8),
  rollGain: 1.05,
  rollbackLead: 0.033, // s before the detected start of an exit motion
  flickTurn: 4.0, // rad/s: a hand lost while turning at least this fast was flicking
  flickRatio: 3.5, // ...and turning fast relative to its travel (rad per camera frame)
  commitDrop: 0.1, // openness fall below plateau that lets go (the hand began to close into a fist)
  commitRate: 2.0, // /s: ...or openness falling this fast into a fist
  confirmDrop: 0.12, // further fall after letting go that confirms the hand is closing
  resumeWindow: 0.25, // s after letting go in which the same hand opening again takes straight hold
  resumeRise: 0.05, // openness recovery that counts as opening again
  rearmRise: 0.06, // ...and after that window, before it can grab anew
  stillBand: THREE.MathUtils.degToRad(0.6), // slack between a held hand at rest and the engine...
  stillSpeed: [0.05, 0.12], // ...while it turns slower than this (rad/s), none above...
  stillAfter: 0.3, // ...once it has stayed that slow this long (s)
  stillWindow: 0.3, // s over which that turning speed is measured
  sweepSpeed: 1.0, // screen heights/s: both hands moving this fast at the end are leaving
  zoomPivot: 0.35, // blend zoom pivot toward engine center so zooming in stays framed
  // 1-hand screen-space orbit: moving an open hand left/right/up/down rotates the engine
  // directly (in addition to 3D wrist tilt/twist), while closed fists register 0 movement
  orbitYaw: 4.8, // rad of Y rotation per camera-frame width of open-hand travel
  orbitPitch: 4.0, // rad of X rotation per camera-frame height of open-hand travel
  orbitDeadSpeed: 0.04, // camera frames/s below which palm position shimmer is ignored
  orbitFullSpeed: 0.14, // camera frames/s at which full orbit gain is engaged
  edgeRollback: false, // keep rotations where the hand placed them instead of snapping back
  fistExplode: false, // closed fists are strictly inactive clutch by default
  fistOpen: 0.55, // openness under which a closed hand counts as a fist (when fistExplode is enabled)
  fistStill: 0.5,
  fistSettle: 0.12,
  fistFull: 0.32,
  fistHold: 0.3,
  fistAlong: 1.2,
  fistAcross: 0.6,
  fistFloor: 0.08,
};

function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

const _q = new THREE.Quaternion();
const _oq = new THREE.Quaternion();
const _ov = new THREE.Vector3();

export class Gestures {
  constructor(control, view, emit = () => {}) {
    this.control = control;
    this.view = view; // { width, height, worldPerPixel(), originPx() }
    this.emit = emit;
    this.state = 'idle';
    this.primary = null; // track id while grabbing
    this.pair = null; // [idA, idB] while two-handed
    this.two = null;
    this.byId = new Map();
    this.lastTracks = new Map();
    // hands that just let go: {t, min, kind: 'close' | 'stale' | 'partner', two}
    //   close   - started to close; out of play until it closes, or opens straight back up
    //   stale   - missing from a camera result while holding; the engine coasts until it returns
    //   partner - the other hand of a two-hand gesture that just ended
    this.spent = new Map();
    this.still = { grabT: null, q: new THREE.Quaternion(), trail: [], calm: 0, engage: 0, t: 0, speed: 0 }; // the held hand's orientation, with slack
    // two fists: { key, ids, since, armed, base: 0 assembled / 1 exploded, amount 0..1,
    // dir: +1 apart / -1 together, progress 0..1 toward the other end }
    this.fist = null;
  }

  roleOf(id) {
    if (this.state === 'grab' && this.primary === id) return 'grab';
    if (this.state === 'two' && this.pair && this.pair.includes(id)) return 'two';
    if (this.coasting(id)) return 'grab';
    if (this.fist?.armed && this.fist.ids.includes(id)) return 'fist';
    return 'idle';
  }

  update(tracks, t) {
    const G = gestureTuning;
    const byId = new Map(tracks.map((tr) => [tr.id, tr]));
    this.byId = byId;
    const resumed = this.reviewSpent(byId, t);

    // ---- a holding hand that starts to close lets go at once; one missing from this camera
    // result lets the engine coast at its own speed until it returns
    if (this.state === 'grab') {
      const p = byId.get(this.primary);
      if (p && p.isOpen && p.lastSeen < t) {
        this.control.coast({ limbo: true });
        this.spent.set(p.id, { t, min: p.open, kind: 'stale', two: false });
        this.state = 'free';
        this.primary = null;
      } else if (p && p.isOpen && p.closing(G.commitDrop, G.commitRate)) {
        // let go now, at the speed the engine is turning; the release is announced once the
        // hand keeps closing, so a hand that opens straight back up takes hold again silently
        this.control.coast();
        this.spent.set(p.id, { t, min: p.open, at: p.open, kind: 'close', two: false, told: false });
        this.state = 'free';
        this.primary = null;
      }
    } else if (this.state === 'two') {
      const closer = this.pair.map((id) => byId.get(id)).find((h) => h && h.isOpen && h.lastSeen === t && h.closing(G.commitDrop, G.commitRate));
      if (closer) {
        this.endTwo(byId, closer, t);
        this.state = 'free';
      }
    }

    // a hand already holding the model keeps it while open; a new hand must settle first
    const inUse = (id) => (this.state === 'grab' && this.primary === id) || (this.state === 'two' && this.pair?.includes(id));
    const open = tracks
      .filter((tr) => tr.isOpen && tr.age >= G.minAge && !this.spent.has(tr.id) && (inUse(tr.id) || resumed.has(tr.id) || tr.armed(t)))
      .sort((a, b) => a.id - b.id);

    let want = 'free';
    if (open.length >= 2) want = 'two';
    else if (open.length === 1) want = 'grab';

    // ---- leave the current state for any other reason
    if (this.state === 'grab') {
      if (!(want === 'grab' && open[0].id === this.primary)) {
        const p = byId.get(this.primary);
        if (want === 'two') {
          this.control.release(null);
        } else {
          const speed = this.letGo(p || this.lastTracks.get(this.primary), !p);
          this.emit('release', { speed, lost: !p });
        }
        this.state = 'free';
        this.primary = null;
      }
    } else if (this.state === 'two') {
      const [a, b] = this.pair.map((id) => byId.get(id));
      if (!(want === 'two' && open.includes(a) && open.includes(b))) {
        // a hand that shut without a closing motion caught in time counts as closing
        this.endTwo(byId, [a, b].find((h) => h && !h.isOpen) ?? null, t);
        this.state = 'free';
      }
    }

    // ---- enter / continue
    if (want === 'grab' && this.state !== 'grab') {
      const p = open[0];
      const resume = resumed.has(p.id);
      const caught = this.control.grab(p.quat, t, controlTuning.gain, resume ? { resume: true } : {});
      this.orbitLast = p.centerAt(t).slice();
      this.state = 'grab';
      this.primary = p.id;
      this.emit(resume ? 'resume' : caught ? 'catch' : 'grab', { id: p.id });
    } else if (want === 'grab') {
      // a hand just found again: the engine stays put while the tracker settles on it
      const p = byId.get(this.primary);
      if (p && p.lastSeen === t && p.refit > 0) {
        this.control.rebase(p.quat);
        this.orbitLast = p.centerAt(t).slice();
      }
    } else if (want === 'two') {
      if (this.state !== 'two') this.beginTwo(open[0], open[1], t, resumed.has(open[0].id) || resumed.has(open[1].id));
      else {
        const a = byId.get(this.pair[0]);
        const b = byId.get(this.pair[1]);
        if (a && b && a.lastSeen === t && b.lastSeen === t && (a.refit > 0 || b.refit > 0)) this.rebaseTwo(a, b, t);
        this.recordTwo(a, b, t);
      }
    }

    this.lastTracks = byId;
    this.fists(tracks, t);
    // HUD state (a hand missing for a frame or two still reads as holding)
    if (this.state === 'free') {
      if (this.coasting()) this.hudState = 'grab';
      else this.hudState = this.control.spinSpeed > 0.3 ? 'spin' : tracks.length ? 'ready' : 'idle';
    } else this.hudState = this.state;
    return this.hudState;
  }

  // a hand that began to close has kept closing (or is gone): tell the rest of the app
  announce(s) {
    if (s.kind !== 'close' || s.told) return;
    s.told = true;
    if (!s.two) this.emit('release', { speed: this.flying(), lost: false });
  }

  coasting(id = null) {
    for (const [k, s] of this.spent) if (s.kind === 'stale' && (id === null || k === id)) return true;
    return false;
  }

  // Hands that let go: resolve them (closed, gone, back) and return those that take
  // straight hold again this result.
  reviewSpent(byId, t) {
    const G = gestureTuning;
    const resumed = new Set();
    for (const [id, s] of this.spent) {
      const h = byId.get(id);
      if (!h) {
        // gone for good
        this.spent.delete(id);
        if (s.kind === 'stale') {
          this.control.limbo = false;
          this.lostWhileCoasting(this.lastTracks.get(id));
        } else this.announce(s);
        continue;
      }
      const fresh = h.lastSeen === t;
      if (!h.isOpen) {
        this.spent.delete(id);
        if (s.kind === 'stale') {
          this.control.limbo = false;
          this.emit('release', { speed: this.flying(), lost: false });
        } else this.announce(s);
        continue;
      }
      if (!fresh) continue;
      s.min = Math.min(s.min, h.open);
      if (s.kind === 'stale') {
        // back in view and still open: take hold where the engine is now, without a catch
        this.spent.delete(id);
        resumed.add(id);
      } else if (s.kind === 'close') {
        const rising = h.history.length < 2 || h.open >= h.history[h.history.length - 2].open;
        if (s.min <= s.at - G.confirmDrop || t - s.t > G.resumeWindow) this.announce(s);
        if (t - s.t <= G.resumeWindow) {
          if (h.open >= s.min + G.resumeRise && rising) {
            this.spent.delete(id);
            resumed.add(id);
          }
        } else if ((h.open >= s.min + G.rearmRise || h.open >= handTuning.openOn) && this.settledSince(h, s.t, t)) {
          this.spent.delete(id);
        } else if (t - s.t >= handTuning.armMax && s.min > s.at - G.confirmDrop) {
          this.spent.delete(id);
        }
      } else if (s.kind === 'partner') {
        if (handTuning.armSteady <= 0 || this.settledSince(h, s.t, t, 0.1)) this.spent.delete(id);
      }
    }
    // a two-hand gesture resumes with both hands
    if (resumed.size) {
      for (const [id, s] of this.spent) {
        if (s.kind !== 'partner') continue;
        const h = byId.get(id);
        if (h && h.isOpen && h.lastSeen === t) {
          this.spent.delete(id);
          resumed.add(id);
        }
      }
    }
    return resumed;
  }

  settledSince(h, t0, t, extra = 0) {
    if (handTuning.armSteady <= 0) return true;
    return h.steadySince !== null && t - Math.max(h.steadySince, t0) >= handTuning.armSteady + extra - 1e-6;
  }

  flying() {
    return this.control.spinSpeed >= controlTuning.minSpin ? this.control.spinSpeed : 0;
  }

  // a coasting hand never came back
  lostWhileCoasting(old) {
    const G = gestureTuning;
    if (old && G.edgeRollback) {
      const tExit = old.exitStart();
      if (tExit !== null) {
        const w = old.flickVelocity(old.lastSeen, G.releaseWindow);
        const travel = old.motion(old.lastSeen)?.speed ?? 0;
        const flick = w.length() > G.flickTurn && w.length() > G.flickRatio * travel;
        if (!flick) {
          // moved away (an arm drop): the engine stays where it was before the hand left
          this.control.stop();
          this.control.rollback(tExit - G.rollbackLead);
          this.emit('release', { speed: 0, lost: true });
          return;
        }
      }
    }
    this.emit('release', { speed: this.flying(), lost: true });
  }

  px(tr, t) {
    const [x, y] = tr.screenAt(t);
    return [x * this.view.width(), y * this.view.height()];
  }

  // One-hand release without a closing motion caught in time: a hand that shut flies on at the
  // engine's speed; a hand that was moved away leaves the engine where it was before it left.
  letGo(tr, lost) {
    const G = gestureTuning;
    if (!tr) {
      this.control.release(null);
      return 0;
    }
    if (!lost || !G.edgeRollback) return this.control.coast();
    const tExit = tr.exitStart();
    if (tExit !== null) {
      const w = tr.flickVelocity(tr.lastSeen, G.releaseWindow);
      const travel = tr.motion(tr.lastSeen)?.speed ?? 0;
      const flick = w.length() > G.flickTurn && w.length() > G.flickRatio * travel;
      if (!flick) {
        this.control.release(null);
        this.control.rollback(tExit - G.rollbackLead);
        return 0;
      }
    }
    return this.control.coast();
  }

  // every frame: drive the engine from the hands as they are now
  follow(now) {
    if (this.state === 'grab') {
      const p = this.byId.get(this.primary);
      if (p) {
        const G = gestureTuning;
        const [cx, cy] = p.centerAt(now);
        const [lx, ly] = this.orbitLast ?? [cx, cy];
        this.orbitLast = [cx, cy];
        const dx = cx - lx;
        const dy = cy - ly;
        if ((G.orbitYaw > 0 || G.orbitPitch > 0) && (dx !== 0 || dy !== 0)) {
          const sp = Math.hypot(p.vc[0], p.vc[1]);
          const u = THREE.MathUtils.clamp((sp - G.orbitDeadSpeed) / Math.max(1e-5, G.orbitFullSpeed - G.orbitDeadSpeed), 0, 1);
          const openGate = THREE.MathUtils.clamp((p.open - handTuning.openOff) / Math.max(1e-5, handTuning.openOn - handTuning.openOff), 0, 1);
          const gate = u * u * (3 - 2 * u) * openGate;
          if (gate > 0) {
            _ov.set(dy * G.orbitPitch * gate, dx * G.orbitYaw * gate, 0);
            this.control.anchorModel.premultiply(rotVecToQuat(_ov, _oq)).normalize();
          }
        }
        this.control.drive(this.holdStill(p.quatAt(now, _q), now), now);
      }
    } else if (this.state === 'two' && this.two) {
      const a = this.byId.get(this.pair[0]);
      const b = this.byId.get(this.pair[1]);
      if (a && b) this.driveTwo(a, b, now);
    }
  }

  // A hand held still never is, to the tracker. Once the held hand has stayed nearly still for a
  // moment, the engine follows it with a little slack (stillBand, like a fine backlash), so
  // tracker shimmer smaller than that leaves it perfectly still. As soon as the hand turns, the
  // slack is taken up smoothly and the hand is followed exactly, so small deliberate turns,
  // flicks and throws are untouched.
  holdStill(q, now) {
    const G = gestureTuning;
    const S = this.still;
    if (S.grabT !== this.control.grabT) {
      S.grabT = this.control.grabT;
      S.q.copy(q);
      S.trail.length = 0;
      S.calm = 0;
      S.engage = 0;
      S.t = now;
    }
    const dt = Math.max(0, now - S.t);
    S.t = now;
    // the hand's turning speed over the last moment (its net turn, so jitter largely cancels)
    S.trail.push({ t: now, q: q.clone() });
    while (S.trail.length > 2 && now - S.trail[1].t >= G.stillWindow) S.trail.shift();
    const ref = S.trail[0];
    const span = now - ref.t;
    const speed = (S.speed = span > 1e-3 ? ref.q.angleTo(q) / span : 0);
    const [lo, hi] = G.stillSpeed;
    S.calm = speed < lo ? S.calm + dt : 0;
    const want = S.calm >= G.stillAfter ? 1 : 0;
    S.engage = want > S.engage ? Math.min(1, S.engage + dt / 0.25) : Math.max(0, S.engage - dt / 0.12);
    const u = THREE.MathUtils.clamp((speed - lo) / (hi - lo), 0, 1);
    const band = G.stillBand * S.engage * (1 - u * u * (3 - 2 * u));
    const a = S.q.angleTo(q);
    if (a > band) S.q.slerp(q, (a - band) / a);
    return S.q;
  }

  // both hands sweeping away together right before the end (arms dropping): when that began
  sweepStart(hist) {
    const n = hist.length;
    if (n < 3) return null;
    const H = this.view.height();
    const vel = (j, win) => {
      let i = j - 1;
      while (i > 0 && hist[j].t - hist[i].t < win - 1e-6) i--;
      const dt = hist[j].t - hist[i].t;
      if (dt < 0.03) return null;
      return [(hist[j].mid[0] - hist[i].mid[0]) / dt / H, (hist[j].mid[1] - hist[i].mid[1]) / dt / H];
    };
    const v = vel(n - 1, 0.1);
    if (!v || Math.hypot(v[0], v[1]) < gestureTuning.sweepSpeed) return null;
    let j = n - 1;
    while (j > 0) {
      const vj = vel(j, 0.066);
      if (!vj || Math.hypot(vj[0], vj[1]) < 0.3 || vj[0] * v[0] + vj[1] * v[1] <= 0) break;
      j--;
    }
    return hist[j].t;
  }

  // what two-hand zoom, move and roll are measured from: the hands' spread, midpoint and angle
  // now, and the zoom and position the engine has
  twoFrame(a, b, t, p0) {
    const pa = this.px(a, t);
    const pb = this.px(b, t);
    const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    // the point on the engine's plane between the hands, relative to the engine (for pivot zoom)
    const wpp = this.view.worldPerPixel();
    const o = this.view.originPx ? this.view.originPx() : [this.view.width() / 2, this.view.height() / 2];
    return {
      d0: Math.max(20, Math.hypot(pb[0] - pa[0], pb[1] - pa[1])),
      mid0: mid,
      roll0: Math.atan2(pb[1] - pa[1], pb[0] - pa[0]),
      s0: this.control.scaleTarget,
      p0: p0.clone(),
      pivot: new THREE.Vector3((mid[0] - o[0]) * wpp, -(mid[1] - o[1]) * wpp, 0).sub(this.control.posTarget),
    };
  }

  beginTwo(a, b, t, resume = false) {
    const caught = !resume && this.control.omega.length() > 0.3;
    this.control.grab(rollQuat(0), t, 1, resume ? { resume: true } : {});
    this.control.beginDrag();
    const f = this.twoFrame(a, b, t, this.control.posTarget);
    this.two = { ...f, hist: [{ t, mid: f.mid0 }], roll: 0 };
    this.pair = [a.id, b.id];
    this.state = 'two';
    this.emit(resume ? 'resume' : caught ? 'catch' : 'two', {});
  }

  // two hands just found again: measure from where they are now, so the engine stays put
  // while the tracker settles on them
  rebaseTwo(a, b, t) {
    if (!this.two) return;
    Object.assign(this.two, this.twoFrame(a, b, t, this.control.dragRaw), { roll: 0 });
    this.control.rebase(rollQuat(0));
  }

  driveTwo(a, b, now) {
    const T = this.two;
    const pa = this.px(a, now);
    const pb = this.px(b, now);
    const d = Math.max(20, Math.hypot(pb[0] - pa[0], pb[1] - pa[1]));
    const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    const roll = wrap(Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) - T.roll0);
    const scale = THREE.MathUtils.clamp(T.s0 * Math.pow(d / T.d0, controlTuning.zoomExp), controlTuning.scaleMin, controlTuning.scaleMax);
    const wpp = this.view.worldPerPixel();
    // follow the hands' midpoint, and grow or shrink about it
    const k = 1 - scale / T.s0;
    const pos = T.p0
      .clone()
      .add(new THREE.Vector3((mid[0] - T.mid0[0]) * wpp, -(mid[1] - T.mid0[1]) * wpp, 0))
      .addScaledVector(T.pivot, k * gestureTuning.zoomPivot);
    this.control.setTwoHand(scale, pos);
    // steering-wheel roll with a soft dead zone so zooming does not twist the model
    const dz = gestureTuning.rollDeadzone;
    const r = Math.abs(roll) <= dz ? 0 : Math.sign(roll) * (Math.abs(roll) - dz);
    T.roll = r;
    // screen y points down, so a clockwise hand turn is a negative rotation about +Z
    this.control.drive(rollQuat(-r * gestureTuning.rollGain), now);
  }

  // camera-rate history of the hands' midpoint (to tell a sweep away from a deliberate end)
  recordTwo(a, b, t) {
    const T = this.two;
    if (!T || !a || !b) return;
    const pa = this.px(a, t);
    const pb = this.px(b, t);
    const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    T.hist.push({ t, mid });
    while (T.hist.length > 2 && t - T.hist[0].t > 0.6) T.hist.shift();
  }

  // Two-hand release. A hand that starts to close (closer) lets go at once: zoom and position
  // come to rest where they are. Hands that sweep away or vanish leave the engine where it
  // was before they began to go (lowering the arms never moves it).
  endTwo(byId, closer, t) {
    const G = gestureTuning;
    const pair = this.pair;
    this.control.endDrag();
    if (closer) {
      const a = byId.get(pair[0]);
      const b = byId.get(pair[1]);
      if (this.two && a && b) this.recordTwo(a, b, t); // include this frame
      const ts = G.edgeRollback && this.two ? this.sweepStart(this.two.hist) : null;
      if (ts !== null) {
        this.control.release(null);
        this.control.rollback(ts - G.rollbackLead);
      } else {
        this.control.settleTwo();
        this.control.coast();
      }
      for (const id of pair) {
        const h = byId.get(id);
        if (!h) continue;
        this.spent.set(id, { t, min: h.open, at: h.open, kind: id === closer.id ? 'close' : 'partner', two: true, told: false });
      }
    } else {
      let tc = Infinity;
      if (G.edgeRollback) {
        for (const id of pair) {
          if (byId.get(id)) continue;
          const old = this.lastTracks.get(id);
          if (old) tc = Math.min(tc, old.exitStart() ?? old.lastSeen - 0.05);
        }
        const ts = this.two ? this.sweepStart(this.two.hist) : null;
        if (ts !== null) tc = Math.min(tc, ts);
      }
      this.control.release(null);
      if (Number.isFinite(tc)) this.control.rollback(tc - G.rollbackLead);
      for (const id of pair) {
        const h = byId.get(id);
        if (h && h.isOpen) this.spent.set(id, { t, min: h.open, kind: 'partner', two: true });
      }
    }
    this.two = null;
    this.pair = null;
    this.emit('twoEnd', {});
  }

  fists(tracks, t) {
    const G = gestureTuning;
    if (!G.fistExplode) {
      this.endFists();
      return;
    }
    const holding = this.state === 'grab' || this.state === 'two' || this.coasting();
    const both = !holding && tracks.length === 2 && tracks.every((h) => !h.isOpen && h.open < G.fistOpen);
    if (!both) {
      this.endFists();
      return;
    }
    const [a, b] = tracks[0].id < tracks[1].id ? tracks : [tracks[1], tracks[0]];
    const key = `${a.id}:${b.id}`;
    let F = this.fist;
    if (!F || F.key !== key) {
      this.endFists();
      F = this.fist = { key, ids: [a.id, b.id], since: t, armed: false, base: 0, amount: 0, dir: 1, progress: 0 };
    }
    if (a.lastSeen !== t || b.lastSeen !== t) return; // a hand missed this camera frame: wait for the next
    // in camera heights, so the same pull works at any window size
    const A = this.view.camAspect?.() ?? 16 / 9;
    const ax = a.center[0] * A;
    const bx = b.center[0] * A;
    const ay = a.center[1];
    const by = b.center[1];
    const sep = Math.hypot(bx - ax, by - ay);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    if (!F.armed) {
      const still = [a, b].every((h) => (h.motion(t)?.speed ?? Infinity) < G.fistStill);
      if (!still) F.since = t;
      if (t - F.since < G.fistSettle - 1e-6) return;
      F.armed = true;
      F.base = this.view.exploded?.() ? 1 : 0;
      F.amount = F.base;
      F.dir = F.base ? -1 : 1;
      F.progress = 0;
      F.a0 = F.base; // the amount at separation s0
      F.s0 = sep;
      F.prev = { t, sep, mx, my };
      F.vs = 0; // how fast the spread changes and the midpoint moves (camera heights/s)
      F.vm = [0, 0];
      F.holdRef = F.amount;
      F.holdT = t;
      F.pulled = false;
      this.emit('fists', { phase: 'hold' });
      return;
    }
    const P = F.prev;
    const dt = Math.max(1e-3, t - P.t);
    const k = 1 - Math.exp(-dt / 0.08);
    F.vs += ((sep - P.sep) / dt - F.vs) * k;
    F.vm[0] += ((mx - P.mx) / dt - F.vm[0]) * k;
    F.vm[1] += ((my - P.my) / dt - F.vm[1]) * k;
    F.prev = { t, sep, mx, my };
    // the arms moving together, not pulling: carry the reference along so nothing changes
    const ux = sep > 1e-6 ? (bx - ax) / sep : 1;
    const uy = sep > 1e-6 ? (by - ay) / sep : 0;
    const along = Math.abs(F.vm[0] * ux + F.vm[1] * uy);
    const across = Math.abs(F.vm[1] * ux - F.vm[0] * uy);
    const vs = Math.abs(F.vs);
    if (along > G.fistAlong * vs + G.fistFloor || across > G.fistAcross * vs + G.fistFloor) F.s0 += sep - P.sep;
    let amt = F.a0 + (sep - F.s0) / G.fistFull;
    if (amt < 0 || amt > 1) {
      // past an end: measure from here, so coming back responds at once
      amt = amt < 0 ? 0 : 1;
      F.a0 = amt;
      F.s0 = sep;
    }
    F.amount = amt;
    if (!F.pulled && Math.abs(amt - F.base) > 0.06) {
      F.pulled = true;
      this.emit('fists', { phase: 'pull', toward: 1 - F.base });
    }
    // settle on an end once the fists reach it, or hold still past halfway
    if (Math.abs(amt - F.holdRef) > 0.03) {
      F.holdRef = amt;
      F.holdT = t;
    }
    const far = 1 - F.base;
    if (amt === far || (Math.abs(amt - F.base) >= 0.5 && t - F.holdT >= G.fistHold - 1e-6)) this.settleFists(far);
    F.progress = Math.abs(F.amount - F.base);
  }

  // the exploded view settles on an end (0 assembled, 1 exploded) and the fists carry on from there
  settleFists(end) {
    const F = this.fist;
    const sep = F.prev.sep;
    F.base = end;
    F.amount = end;
    F.a0 = end;
    F.s0 = sep;
    F.dir = end ? -1 : 1;
    F.progress = 0;
    F.holdRef = end;
    F.pulled = false;
    this.emit('explode', { on: end === 1 });
  }

  // the fists let go: the view settles on the nearer end
  endFists() {
    const F = this.fist;
    this.fist = null;
    if (!F || !F.armed) return;
    const end = F.amount >= 0.5 ? 1 : 0;
    this.emit('fists', { phase: 'end', end, changed: end !== F.base });
  }

  reset() {
    this.fist = null;
    this.control.endDrag();
    if (this.state === 'grab' || this.state === 'two') this.control.release(null);
    this.state = 'free';
    this.primary = null;
    this.pair = null;
    this.two = null;
    this.spent.clear();
  }
}
