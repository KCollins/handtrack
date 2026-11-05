// hud.js - 2D overlay above the WebGL canvas, no text. Each tracked hand is a compact
// reticle at a fixed size: a palm ring that tilts with the palm, ringed by five fingertip
// glints that fan out as the fingers open and fold onto the ring as they close. It stays
// small and light so the engine is always the subject. While the engine is held, lock-on
// brackets frame it; a catch sends out a shockwave and a release a softer pulse.
import * as THREE from 'three';
import { reachMap } from './hands.js';

const CYAN = '80, 205, 255';
const WHITE = '228, 248, 255';
const IDLE = '128, 184, 232';
const TAU = Math.PI * 2;

const TIPS = [4, 8, 12, 16, 20];
const KNUCKLES = [2, 5, 9, 13, 17]; // base joint of each finger, thumb first
const FINGER_CHAINS = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
const PALM_POLY = [0, 1, 5, 9, 13, 17];
const METACARPALS = [1, 5, 9, 13, 17];
const INNER_JOINTS = [0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19];
const FAN = 1.7; // how much the crown widens the fingers' real spread
// fingertip distance from the palm centre, in palm lengths: curled -> fully extended
const REACH = [[0.55, 0.95], [0.75, 1.35], [0.8, 1.45], [0.75, 1.35], [0.65, 1.15]];
const GS = 2.15; // reticle unit, % of the viewport height
const PALM_LEN = 15.5; // palm length of the holographic hand skeleton, % of the viewport height
const SHADE = '1, 5, 10'; // the backdrop color, for the keyline under each reticle

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const damp = (dt, tau) => 1 - Math.exp(-dt / tau);
const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);
const easeOutBack = (u) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const _n = new THREE.Vector3();

export class Hud {
  // now(): the app clock in seconds. Everything animated here runs on that clock, so the
  // overlay looks the same however often frames are drawn.
  constructor(canvas, now = () => performance.now() / 1000) {
    this.canvas = canvas;
    this.now = now;
    this.lastDraw = null;
    this.ctx = canvas.getContext('2d');
    this.visible = true;
    this.glyphs = new Map(); // track id -> animated glyph
    this.waves = []; // rings around the engine
    this.tether = { a: 0, k: 0, dir: 1, A: null, B: null }; // between two fists
    this.lock = { on: false, t: 9, a: 0, from: 0 };
    this.rect = null; // smoothed screen rect of the engine
    this.time = 0;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = this.canvas.clientWidth || window.innerWidth;
    this.h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.U = this.h / 100;
  }

  toPx([x, y]) {
    const [X, Y] = reachMap(x, y);
    return [X * this.w, Y * this.h];
  }

  // a catch: a shockwave rings out from the engine
  shockwave() {
    const born = this.now();
    this.waves.push({ born, delay: 0, dur: 0.62, r0: 0.32, r1: 1.05, w0: 1.1, w1: 0.12, a: 1, flash: true });
    this.waves.push({ born, delay: 0.08, dur: 0.6, r0: 0.28, r1: 0.82, w0: 0.6, w1: 0.08, a: 0.55 });
  }

  // two fists: the exploded view bursts out of the engine; assembling draws the rings back in
  burst(on) {
    const born = this.now();
    if (on) {
      this.waves.push({ born, delay: 0, dur: 0.7, r0: 0.25, r1: 1.2, w0: 1.2, w1: 0.1, a: 1, flash: true });
      this.waves.push({ born, delay: 0.07, dur: 0.7, r0: 0.2, r1: 0.95, w0: 0.7, w1: 0.08, a: 0.6 });
      this.waves.push({ born, delay: 0.14, dur: 0.7, r0: 0.15, r1: 0.7, w0: 0.4, w1: 0.06, a: 0.4 });
    } else {
      this.waves.push({ born, delay: 0, dur: 0.55, r0: 1.15, r1: 0.35, w0: 0.15, w1: 0.9, a: 0.85 });
      this.waves.push({ born, delay: 0.08, dur: 0.5, r0: 0.95, r1: 0.3, w0: 0.1, w1: 0.6, a: 0.5 });
    }
  }

  // a release: a soft outward pulse, stronger after a throw
  pulse(speed = 0) {
    const thrown = speed > 0.3;
    this.waves.push({ born: this.now(), delay: 0, dur: 0.48, r0: 0.55, r1: 0.92, w0: thrown ? 0.55 : 0.38, w1: 0.06, a: thrown ? 0.75 : 0.45 });
  }

  draw(frameDt, s) {
    // s: { tracks, gestures, viewer, control, now, aspect }
    // time since the last drawn frame on the app clock (not the frame step)
    const dt = this.lastDraw == null ? frameDt : Math.min(1, Math.max(0, s.now - this.lastDraw));
    this.lastDraw = s.now;
    this.time += dt;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.trackEngine(dt, s);
    if (!this.visible) {
      this.waves.length = 0;
      return;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    this.drawWaves(s.now);
    this.drawLock();
    this.drawHands(dt, s);
    ctx.globalCompositeOperation = 'source-over';
  }

  // glowing stroke of the current path: wide faint halo, mid glow, bright core
  neon(w, a) {
    if (a <= 0.004) return;
    const ctx = this.ctx;
    ctx.strokeStyle = `rgba(${CYAN}, ${0.06 * a})`;
    ctx.lineWidth = w * 7;
    ctx.stroke();
    ctx.strokeStyle = `rgba(${CYAN}, ${0.2 * a})`;
    ctx.lineWidth = w * 3;
    ctx.stroke();
    ctx.strokeStyle = `rgba(${WHITE}, ${Math.min(1, 0.95 * a)})`;
    ctx.lineWidth = w;
    ctx.stroke();
  }

  glow(x, y, r, a) {
    if (a <= 0.004) return;
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${CYAN}, ${a})`);
    g.addColorStop(0.45, `rgba(${CYAN}, ${a * 0.35})`);
    g.addColorStop(1, `rgba(${CYAN}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }

  // ---------------------------------------------------------------- engine frame
  trackEngine(dt, s) {
    const r = s.viewer.screenRect();
    if (Number.isFinite(r.x0) && Number.isFinite(r.y1)) {
      if (!this.rect) this.rect = { ...r };
      else {
        const k = damp(dt, 0.045);
        for (const key of ['x0', 'y0', 'x1', 'y1']) this.rect[key] += (r[key] - this.rect[key]) * k;
      }
    }
    const L = this.lock;
    const held = !!s.control.held;
    if (held !== L.on) {
      L.on = held;
      L.t = 0;
      L.from = L.a;
    }
    L.t += dt;
  }

  drawLock() {
    // Corner lock brackets disabled for clean unobstructed engine view
  }

  drawWaves(now) {
    this.waves = this.waves.filter((w) => now - w.born < w.delay + w.dur);
    const R = this.rect;
    if (!R || !this.waves.length) return;
    const ctx = this.ctx;
    const U = this.U;
    const cx = (R.x0 + R.x1) / 2;
    const cy = (R.y0 + R.y1) / 2;
    const hd = Math.min(46 * U, Math.max(14 * U, 0.5 * Math.hypot(R.x1 - R.x0, R.y1 - R.y0)));
    for (const w of this.waves) {
      w.hd ??= hd; // sized once, then centered on the engine as it moves
      const u = (now - w.born - w.delay) / w.dur;
      if (u < 0) continue;
      const e = easeOutCubic(u);
      const rad = w.hd * (w.r0 + (w.r1 - w.r0) * e);
      const width = U * (w.w0 + (w.w1 - w.w0) * e);
      const fade = (1 - u) * (1 - 0.4 * u);
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, TAU);
      this.neon(width, w.a * fade);
      if (w.flash && u < 0.45) this.glow(cx, cy, w.hd * 0.75, 0.22 * Math.pow(1 - u / 0.45, 2));
    }
  }

  // ---------------------------------------------------------------- hands
  drawHands(dt, s) {
    const seen = new Set();
    const aspect = s.aspect || 16 / 9;
    for (const tr of s.tracks) {
      seen.add(tr.id);
      const engaged = s.gestures.roleOf(tr.id) !== 'idle';
      const [x, y] = this.toPx(tr.centerAt ? tr.centerAt(s.now) : tr.center);
      let g = this.glyphs.get(tr.id);
      if (!g) {
        g = { x, y, eng: 0, open: tr.open, alpha: 0, spin: (tr.id * 1.7) % TAU, size: 0, pts: null, snap: 9, wasEng: false, squish: 1, phi: 0, isOpen: tr.isOpen, ext: [0, 0, 0, 0, 0], born: this.time };
        this.glyphs.set(tr.id, g);
      }
      g.x = x;
      g.y = y;
      if (engaged && !g.wasEng) g.snap = 0;
      g.wasEng = engaged;
      g.gone = false;
      g.eng += ((engaged ? 1 : 0) - g.eng) * damp(dt, 0.07);
      g.open += (tr.open - g.open) * damp(dt, 0.06);
      // dim a hand the tracker missed in its latest result, or all of them if results stop coming;
      // results that are merely slow (a webcam dropping to 15 fps in dim light) do not dim them
      const stale = s.resultT != null ? tr.lastSeen < s.resultT || s.now - s.resultT > 0.8 : s.now - tr.lastSeen > 0.25;
      const target = (stale ? 0.45 : 1) * (tr.isOpen ? 0.92 + 0.08 * g.eng : 0.82 + 0.18 * g.eng);
      g.alpha += (target - g.alpha) * damp(dt, 0.07);
      this.updateShape(tr, g, dt, aspect);
    }
    // hands that left fade out where they were last seen
    for (const [id, g] of this.glyphs) {
      if (seen.has(id)) continue;
      g.gone = true;
      g.wasEng = false;
      g.eng += (0 - g.eng) * damp(dt, 0.07);
      g.alpha *= Math.exp(-dt / 0.09);
      if (g.alpha < 0.02) this.glyphs.delete(id);
    }
    for (const g of this.glyphs.values()) {
      g.snap += dt;
      g.spin += dt * (0.15 + 3.0 * g.eng);
    }
    // a faint keyline under each reticle keeps it legible over the bright engine lines
    this.ctx.globalCompositeOperation = 'source-over';
    for (const g of this.glyphs.values()) this.drawShade(g);
    this.ctx.globalCompositeOperation = 'lighter';
    if (s.gestures.state === 'grab' && s.gestures.primary != null) {
      const G = this.glyphs.get(s.gestures.primary);
      if (G && !G.gone && G.eng > 0.15) this.drawGrabTether(G);
    }
    for (const g of this.glyphs.values()) this.drawReticle(g);
    if (s.gestures.state === 'two' && s.gestures.pair) {
      const [A, B] = s.gestures.pair.map((id) => this.glyphs.get(id));
      if (A && B && !A.gone && !B.gone) this.drawLink(A, B);
    }
    this.drawFists(dt, s);
  }

  // Two fists held: a tether between them tightens as they pull, and chevrons outside them
  // point the way that changes the engine (apart: explode; together: assemble).
  drawFists(dt, s) {
    const F = s.gestures.fist;
    const T = this.tether;
    const ends = F && F.armed ? F.ids.map((id) => this.glyphs.get(id)) : null;
    const on = !!(ends && ends[0] && ends[1] && !ends[0].gone && !ends[1].gone);
    if (on) {
      T.A = ends[0];
      T.B = ends[1];
      T.dir = F.dir;
      T.k += (F.progress - T.k) * damp(dt, 0.05);
    } else T.k *= Math.exp(-dt / 0.1);
    T.a += ((on ? 1 : 0) - T.a) * damp(dt, on ? 0.15 : 0.08);
    if (T.a < 0.02 || !T.A) return;
    const ctx = this.ctx;
    const U = this.U * GS;
    const { A, B, k, dir, a } = T;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return;
    const ux = dx / d;
    const uy = dy / d;
    const r = 4.2 * U; // clear of the fist reticles
    if (d > 2 * r + 2 * U) {
      ctx.beginPath();
      ctx.moveTo(A.x + ux * r, A.y + uy * r);
      ctx.lineTo(B.x - ux * r, B.y - uy * r);
      ctx.setLineDash([0.35 * U, 0.75 * U]);
      ctx.lineDashOffset = this.time * 3 * U * dir;
      this.neon((0.14 + 0.14 * k) * U, a * (0.35 + 0.6 * k));
      ctx.setLineDash([]);
    }
    // a chevron marching outward (or inward) beside each fist
    const ph = (this.time * 1.3) % 1;
    const c = 0.65 * U;
    ctx.beginPath();
    for (const [P, v] of [
      [A, 1],
      [B, -1],
    ]) {
      const ix = v * ux; // toward the other fist
      const iy = v * uy;
      const wx = dir > 0 ? -ix : ix; // the way to move
      const wy = dir > 0 ? -iy : iy;
      const q = 3.7 * U + (dir > 0 ? ph : 1 - ph) * 0.9 * U;
      const qx = P.x - ix * q;
      const qy = P.y - iy * q;
      ctx.moveTo(qx - wx * 0.5 * c - wy * c, qy - wy * 0.5 * c + wx * c);
      ctx.lineTo(qx + wx * 0.5 * c, qy + wy * 0.5 * c);
      ctx.lineTo(qx - wx * 0.5 * c + wy * c, qy - wy * 0.5 * c - wx * c);
    }
    this.neon(0.2 * U, a * (0.4 + 0.5 * k) * Math.sin(Math.PI * ph));
  }

  updateShape(tr, g, dt, aspect) {
    const P = tr.points;
    if (!P || !tr.raw) return;
    const [cx, cy] = tr.raw.center;
    // a palm size that does not shrink when the palm tilts: the longer of its length and width
    const len = Math.hypot((P[9][0] - P[0][0]) * aspect, P[9][1] - P[0][1]);
    const wid = 1.3 * Math.hypot((P[5][0] - P[17][0]) * aspect, P[5][1] - P[17][1]);
    const size = Math.max(len, wid, 0.02);
    g.size = g.size ? g.size + (size - g.size) * damp(dt, size > g.size ? 0.12 : 1.2) : size;
    const k = (PALM_LEN * this.U) / g.size;
    const kk = g.pts ? damp(dt, 0.03) : 1;
    if (!g.pts) g.pts = P.map(() => [0, 0]);
    for (let i = 0; i < 21; i++) {
      g.pts[i][0] += ((P[i][0] - cx) * aspect * k - g.pts[i][0]) * kk;
      g.pts[i][1] += ((P[i][1] - cy) * k - g.pts[i][1]) * kk;
    }
    // how far each finger reaches out of the palm (g.pts are relative to the palm centre)
    const palm = PALM_LEN * this.U;
    for (let f = 0; f < 5; f++) {
      const t = g.pts[TIPS[f]];
      const want = smooth(REACH[f][0], REACH[f][1], Math.hypot(t[0], t[1]) / palm);
      g.ext[f] += (want - g.ext[f]) * (kk === 1 ? 1 : damp(dt, 0.06));
    }
    // the palm ring lies in the palm plane
    _n.set(0, 0, 1).applyQuaternion(tr.quat);
    g.squish += (Math.max(0.3, Math.abs(_n.z)) - g.squish) * kk;
    if (Math.hypot(_n.x, _n.y) > 0.08) g.phi = Math.atan2(-_n.y, _n.x);
    g.isOpen = tr.isOpen;
  }

  // ring radius: open hands hold a wider ring, a fist a small one
  ringR(g) {
    return (g.isOpen ? 2.5 - 0.35 * g.eng : 1.8) * this.U * GS;
  }

  // the five fingertip glints: each sits on its finger's bearing from the palm centre and
  // slides out from the ring as the finger straightens, so the crown mirrors the hand
  crown(g, R, out = []) {
    const U = this.U * GS;
    const spread = easeOutBack(clamp01((this.time - g.born - 0.05) / 0.4));
    const P = g.pts;
    const ax = Math.atan2(P[9][1] - P[0][1], P[9][0] - P[0][0]); // wrist to middle knuckle
    for (let f = 0; f < 5; f++) {
      const e = g.ext[f];
      const k = P[KNUCKLES[f]];
      const t = P[TIPS[f]];
      // bearing from the knuckle (steady) toward the tip as the finger opens, fanned out
      // around the hand's axis so the five glints read as a hand at a glance
      const raw = Math.atan2(k[1] + (t[1] - k[1]) * e, k[0] + (t[0] - k[0]) * e) - ax;
      const th = ax + Math.max(-1.8, Math.min(1.8, FAN * Math.atan2(Math.sin(raw), Math.cos(raw))));
      const r = R + (0.75 + 1.85 * e) * U * spread;
      out[f] = { x: g.x + Math.cos(th) * r, y: g.y + Math.sin(th) * r, c: Math.cos(th), s: Math.sin(th), r, e };
    }
    return out;
  }

  // A faint keyline in the backdrop color under the articulated skeleton, ring, and nodes:
  // it separates the hand hologram from the bright engine metal without a dark blob around it.
  drawShade(g) {
    const a = g.alpha;
    const e = g.eng;
    const k = 0.58 * a * (0.45 + 0.55 * e);
    if (k < 0.02 || !g.pts) return;
    const ctx = this.ctx;
    const U = this.U * GS;
    const P = g.pts;
    // keyline under articulated finger bone chains and palm struts
    ctx.beginPath();
    for (const m of METACARPALS) {
      ctx.moveTo(g.x + P[0][0], g.y + P[0][1]);
      ctx.lineTo(g.x + P[m][0], g.y + P[m][1]);
    }
    ctx.moveTo(g.x + P[1][0], g.y + P[1][1]);
    for (let i = 1; i < METACARPALS.length; i++) {
      const m = METACARPALS[i];
      ctx.lineTo(g.x + P[m][0], g.y + P[m][1]);
    }
    for (const chain of FINGER_CHAINS) {
      ctx.moveTo(g.x + P[chain[0]][0], g.y + P[chain[0]][1]);
      for (let i = 1; i < chain.length; i++) {
        ctx.lineTo(g.x + P[chain[i]][0], g.y + P[chain[i]][1]);
      }
    }
    ctx.strokeStyle = `rgba(${SHADE}, ${k})`;
    ctx.lineWidth = (0.58 + 0.16 * e) * U;
    ctx.stroke();

    const R = this.ringR(g) * (1 + 1.4 * (1 - easeOutCubic(clamp01((this.time - g.born) / 0.32))));
    this.palmPath(g, (c) => {
      for (let i = 0; i < 4; i++) {
        const a0 = g.spin + (i * TAU) / 4;
        c.moveTo(R * Math.cos(a0), R * Math.sin(a0));
        c.arc(0, 0, R, a0, a0 + TAU / 4 - 0.4);
      }
    });
    ctx.strokeStyle = `rgba(${SHADE}, ${k})`;
    ctx.lineWidth = (0.64 + 0.14 * e) * U;
    ctx.stroke();
    ctx.fillStyle = `rgba(${SHADE}, ${k})`;
    ctx.beginPath();
    for (const idx of TIPS) {
      const pt = P[idx];
      const rt = (0.48 + 0.12 * e) * U;
      ctx.moveTo(g.x + pt[0] + rt, g.y + pt[1]);
      ctx.arc(g.x + pt[0], g.y + pt[1], rt, 0, TAU);
    }
    const rc = (g.isOpen ? 0.65 : 0.85) * U;
    ctx.moveTo(g.x + rc, g.y);
    ctx.arc(g.x, g.y, rc, 0, TAU);
    ctx.fill();
  }

  // build a path in the palm plane (an ellipse when the palm is tilted)
  palmPath(g, build) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.phi);
    ctx.scale(g.squish, 1);
    ctx.rotate(-g.phi);
    ctx.beginPath();
    build(ctx);
    ctx.restore();
  }

  // Subtle holographic beam connecting the active open hand to the engine lock-on frame
  drawGrabTether(g) {
    if (!this.rect) return;
    const ctx = this.ctx;
    const U = this.U * GS;
    const cx = (this.rect.x0 + this.rect.x1) / 2;
    const cy = (this.rect.y0 + this.rect.y1) / 2;
    const dx = cx - g.x;
    const dy = cy - g.y;
    const d = Math.hypot(dx, dy);
    const r0 = this.ringR(g) + 1.2 * U;
    const r1 = 3.2 * U;
    if (d <= r0 + r1 + 1.5 * U) return;
    const ux = dx / d;
    const uy = dy / d;
    ctx.beginPath();
    ctx.moveTo(g.x + ux * r0, g.y + uy * r0);
    ctx.lineTo(cx - ux * r1, cy - uy * r1);
    ctx.setLineDash([0.75 * U, 0.85 * U]);
    ctx.lineDashOffset = -this.time * 4.5 * U;
    this.neon(0.18 * U, 0.38 * g.eng * g.alpha);
    ctx.setLineDash([]);
  }

  drawReticle(g) {
    if (!g.pts) return;
    const ctx = this.ctx;
    const U = this.U * GS;
    const a = g.alpha;
    const e = g.eng;
    const age = this.time - g.born;
    const P = g.pts;
    const R0 = this.ringR(g);
    const R = R0 * (1 + 1.4 * (1 - easeOutCubic(clamp01(age / 0.32))));
    const active = g.isOpen || e > 0.25;
    const col = active ? CYAN : IDLE;

    // 1. Palm structural cage + translucent energy membrane
    ctx.beginPath();
    ctx.moveTo(g.x + P[PALM_POLY[0]][0], g.y + P[PALM_POLY[0]][1]);
    for (let i = 1; i < PALM_POLY.length; i++) {
      const idx = PALM_POLY[i];
      ctx.lineTo(g.x + P[idx][0], g.y + P[idx][1]);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(${col}, ${(active ? 0.055 + 0.055 * e : 0.025) * a})`;
    ctx.fill();

    if (e > 0.01) this.glow(g.x, g.y, R * 2.1, 0.22 * e * a);

    // 2. Metacarpal struts + knuckle bridge
    ctx.beginPath();
    for (const m of METACARPALS) {
      ctx.moveTo(g.x + P[0][0], g.y + P[0][1]);
      ctx.lineTo(g.x + P[m][0], g.y + P[m][1]);
    }
    ctx.moveTo(g.x + P[1][0], g.y + P[1][1]);
    for (let i = 1; i < METACARPALS.length; i++) {
      const m = METACARPALS[i];
      ctx.lineTo(g.x + P[m][0], g.y + P[m][1]);
    }
    if (active) {
      this.neon((0.16 + 0.06 * e) * U, a * (0.48 + 0.32 * e));
    } else {
      ctx.strokeStyle = `rgba(${IDLE}, ${0.65 * a})`;
      ctx.lineWidth = 0.2 * U;
      ctx.stroke();
    }

    // 3. Articulated 5-finger phalanx bone chains (21-landmark skeleton)
    ctx.beginPath();
    for (const chain of FINGER_CHAINS) {
      ctx.moveTo(g.x + P[chain[0]][0], g.y + P[chain[0]][1]);
      for (let i = 1; i < chain.length; i++) {
        ctx.lineTo(g.x + P[chain[i]][0], g.y + P[chain[i]][1]);
      }
    }
    if (active) {
      this.neon((0.24 + 0.1 * e) * U, a * (0.72 + 0.28 * e));
    } else {
      ctx.strokeStyle = `rgba(${IDLE}, ${0.78 * a})`;
      ctx.lineWidth = 0.26 * U;
      ctx.stroke();
    }

    // 4. Inner joint nodes (wrist + knuckles + PIP/DIP joints)
    ctx.fillStyle = active ? `rgba(${WHITE}, ${0.85 * a})` : `rgba(${IDLE}, ${0.85 * a})`;
    ctx.beginPath();
    const rj = (active ? 0.22 + 0.05 * e : 0.21) * U;
    for (const idx of INNER_JOINTS) {
      const pt = P[idx];
      ctx.moveTo(g.x + pt[0] + rj, g.y + pt[1]);
      ctx.arc(g.x + pt[0], g.y + pt[1], rj, 0, TAU);
    }
    ctx.fill();

    // 5. Fingertip target reticles (active open hand) vs folded fist nodes (inactive clutch)
    for (let f = 0; f < 5; f++) {
      const pt = P[TIPS[f]];
      const tx = g.x + pt[0];
      const ty = g.y + pt[1];
      const ext = g.ext[f];
      if (active) {
        const ga = a * (0.6 + 0.4 * ext);
        this.glow(tx, ty, (1.35 + 0.4 * e) * U, (0.32 + 0.25 * e) * ga);
        ctx.beginPath();
        ctx.arc(tx, ty, (0.58 + 0.18 * ext) * U, 0, TAU);
        ctx.strokeStyle = `rgba(${CYAN}, ${0.75 * ga})`;
        ctx.lineWidth = 0.14 * U;
        ctx.stroke();
        ctx.fillStyle = `rgba(${WHITE}, ${Math.min(1, 1.1 * ga)})`;
        ctx.beginPath();
        ctx.arc(tx, ty, (0.28 + 0.08 * ext) * U, 0, TAU);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(${IDLE}, ${0.85 * a})`;
        ctx.beginPath();
        ctx.arc(tx, ty, 0.26 * U, 0, TAU);
        ctx.fill();
      }
    }

    // 6. 3D-tilted palm repulsor gyroscope ring
    this.palmPath(g, (c) => {
      for (let i = 0; i < 4; i++) {
        const a0 = g.spin + (i * TAU) / 4;
        c.moveTo(R * Math.cos(a0), R * Math.sin(a0));
        c.arc(0, 0, R, a0, a0 + TAU / 4 - (active ? 0.36 : 0.55));
      }
    });
    if (active) {
      this.neon((0.3 + 0.09 * e) * U, a * (0.85 + 0.15 * e));
    } else {
      ctx.strokeStyle = `rgba(${IDLE}, ${0.76 * a})`;
      ctx.lineWidth = 0.26 * U;
      ctx.stroke();
    }

    // Counter-rotating vernier ticks around the palm ring
    this.palmPath(g, (c) => {
      for (let i = 0; i < 12; i++) {
        const ang = -0.6 * g.spin + (i * TAU) / 12;
        const r0 = R + 0.45 * U;
        const r1 = R + (i % 3 === 0 ? 1.05 : 0.78) * U;
        c.moveTo(r0 * Math.cos(ang), r0 * Math.sin(ang));
        c.lineTo(r1 * Math.cos(ang), r1 * Math.sin(ang));
      }
    });
    ctx.strokeStyle = `rgba(${col}, ${(active ? 0.52 : 0.32) * a})`;
    ctx.lineWidth = 0.17 * U;
    ctx.stroke();

    // Central palm core
    ctx.fillStyle = active ? `rgba(${WHITE}, ${a})` : `rgba(${IDLE}, ${0.75 * a})`;
    ctx.beginPath();
    ctx.arc(g.x, g.y, (active ? 0.48 : 0.42) * U, 0, TAU);
    ctx.fill();

    // A new hand sends a ripple out of the palm ring
    if (age < 0.5) {
      const u = age / 0.5;
      this.palmPath(g, (c) => c.arc(0, 0, R0 * 0.8 + 4.2 * U * easeOutCubic(u), 0, TAU));
      this.neon(0.18 * U, (1 - u) * 0.55 * a);
    }
    // The moment an open hand engages, a lock-on ring snaps outward
    if (g.snap < 0.38) {
      const u = g.snap / 0.38;
      const ee = easeOutCubic(u);
      this.palmPath(g, (c) => c.arc(0, 0, R0 + 3.4 * U * ee, 0, TAU));
      this.neon((0.42 - 0.34 * ee) * U, (1 - u) * 0.9);
    }
  }

  drawLink(A, B) {
    const ctx = this.ctx;
    const U = this.U * GS;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return;
    const ux = dx / d;
    const uy = dy / d;
    const r = 5.6 * U; // clear of the reticles and their fingertip crowns
    if (d > 2 * r + 2 * U) {
      ctx.beginPath();
      ctx.moveTo(A.x + ux * r, A.y + uy * r);
      ctx.lineTo(B.x - ux * r, B.y - uy * r);
      ctx.setLineDash([1.2 * U, 0.9 * U]);
      ctx.lineDashOffset = -this.time * 6 * U;
      this.neon(0.34 * U, 0.75);
      ctx.setLineDash([]);
    }
    const mx = (A.x + B.x) / 2;
    const my = (A.y + B.y) / 2;
    const q = 0.9 * U;
    ctx.beginPath();
    ctx.moveTo(mx, my - q);
    ctx.lineTo(mx + q, my);
    ctx.lineTo(mx, my + q);
    ctx.lineTo(mx - q, my);
    ctx.closePath();
    this.neon(0.28 * U, 0.95);
  }
}
