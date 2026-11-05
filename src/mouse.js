// mouse.js - pointer fallback with the same physics as the hands:
// drag to rotate, flick and let go to spin, press on a spinning model to catch,
// wheel or pinch to zoom, right/shift drag or two fingers to move.
import * as THREE from 'three';
import { quatToRotVec } from './filters.js';
import { controlTuning } from './control.js';

const RAD_PER_PX = 0.0085;

export class MouseInput {
  constructor(el, control, viewer, clock, emit = () => {}) {
    this.el = el;
    this.control = control;
    this.viewer = viewer;
    this.clock = clock;
    this.emit = emit;
    this.enabled = true;
    this.pointers = new Map();
    this.vq = new THREE.Quaternion();
    this.hist = [];
    this.mode = null; // 'rotate' | 'pan' | 'pinch'
    this.pinch = null;
    this.active = false;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get busy() {
    return this.pointers.size > 0;
  }

  // when the input happened (s): the event's own time stamp, so a busy frame that delays
  // dispatch does not distort a flick's speed. Tests drive a manual clock instead.
  stamp(e) {
    const ts = e.timeStamp / 1000;
    if (this.clock.manual || !(ts > 0)) return this.clock.now();
    return Math.min(ts, this.clock.now());
  }

  down(e) {
    if (!this.enabled) return;
    this.el.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const t = this.stamp(e);
    if (this.pointers.size === 2) {
      // second finger: switch to pinch
      if (this.mode === 'rotate') this.control.release(null);
      const [a, b] = [...this.pointers.values()];
      this.mode = 'pinch';
      this.control.beginDrag();
      this.pinch = {
        d0: Math.max(10, Math.hypot(b.x - a.x, b.y - a.y)),
        m0: [(a.x + b.x) / 2, (a.y + b.y) / 2],
        s0: this.control.scaleTarget,
        p0: this.control.posTarget.clone(),
      };
      return;
    }
    if (this.pointers.size > 2) return;
    const pan = e.button === 2 || e.button === 1 || e.shiftKey;
    if (pan) {
      this.mode = 'pan';
      this.control.beginDrag();
      this.last = { x: e.clientX, y: e.clientY };
      return;
    }
    this.mode = 'rotate';
    this.vq.identity();
    this.hist = [{ t, q: this.vq.clone() }];
    const caught = this.control.grab(this.vq, t, 1, { wn: controlTuning.pointerWn });
    this.emit(caught ? 'catch' : 'grab', { x: e.clientX, y: e.clientY });
    this.last = { x: e.clientX, y: e.clientY };
  }

  move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const t = this.stamp(e);
    if (this.mode === 'rotate') {
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const axis = new THREE.Vector3(dy / len, dx / len, 0);
        const dq = new THREE.Quaternion().setFromAxisAngle(axis, len * RAD_PER_PX);
        this.vq.premultiply(dq).normalize();
      }
      this.control.drive(this.vq, t);
      this.hist.push({ t, q: this.vq.clone() });
      while (this.hist.length > 2 && t - this.hist[0].t > 0.25) this.hist.shift();
    } else if (this.mode === 'pan') {
      const wpp = this.viewer.worldPerPixel();
      this.control.panBy(new THREE.Vector3((e.clientX - this.last.x) * wpp, -(e.clientY - this.last.y) * wpp, 0));
      this.last = { x: e.clientX, y: e.clientY };
    } else if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const P = this.pinch;
      const d = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
      const m = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const wpp = this.viewer.worldPerPixel();
      this.control.setTwoHand(P.s0 * (d / P.d0), P.p0.clone().add(new THREE.Vector3((m[0] - P.m0[0]) * wpp, -(m[1] - P.m0[1]) * wpp, 0)));
    }
  }

  up(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const t = this.stamp(e);
    if (this.mode === 'rotate') {
      // velocity over the last ~90 ms; a pause before letting go means no spin
      const recent = this.hist.filter((h) => t - h.t <= 0.09);
      let w = new THREE.Vector3();
      if (recent.length >= 2 && t - recent[recent.length - 1].t < 0.05) {
        const a = recent[0];
        const b = recent[recent.length - 1];
        const dt = Math.max(0.016, b.t - a.t);
        const dq = b.q.clone().multiply(a.q.clone().invert());
        w = quatToRotVec(dq).multiplyScalar(1 / dt);
      }
      const speed = this.control.release(w);
      this.emit('release', { speed, x: e.clientX, y: e.clientY });
    }
    if (this.pointers.size === 0) {
      // a move past the edge springs back once let go
      if (this.mode !== 'rotate') this.control.endDrag();
      this.mode = null;
    } else if (this.mode === 'pinch') this.mode = 'pinch-end';
  }

  wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    // about 1.1x per 100 px of wheel; trackpad pinches (ctrlKey) send small deltas
    this.control.zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.001)));
  }
}
