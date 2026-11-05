// cadkit.js - a tiny CAD-style geometry kit.
// Every primitive emits a shaded mesh (grouped by material key) and B-rep style
// feature edges (rings, seams, outlines), the way a CAD wireframe view draws them.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const V = (x, y, z) => new THREE.Vector3(x, y, z);

export function ringSegs(r) {
  return Math.max(10, Math.min(120, Math.round(r * 320)));
}

// orthonormal basis (u, v) perpendicular to n
export function basis(n) {
  const nn = _c.copy(n).normalize();
  const helper = Math.abs(nn.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(helper, nn).normalize();
  const v = new THREE.Vector3().crossVectors(nn, u).normalize();
  return [u, v, nn.clone()];
}

export function quatFromY(dir) {
  return new THREE.Quaternion().setFromUnitVectors(UP, _a.copy(dir).normalize());
}

function prepGeo(geo) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

export class Part {
  constructor(name, opts = {}) {
    this.name = name;
    this.label = opts.label ?? null;
    this.explode = new THREE.Vector3(...(opts.explode || [0, 0, 0]));
    this.anchor = opts.anchor ? new THREE.Vector3(...opts.anchor) : null;
    this.fadeOnExplode = !!opts.fadeOnExplode;
    this.segs = [];
    this.inten = [];
    this.weights = [];
    this.cadInten = []; // the same lines as ink on the CAD look's surfaces
    this.cadOwn = false; // some lines are drawn in one look only
    this.geos = new Map();
    this.stack = [new THREE.Matrix4()];
    this.k = 1;
    this.weight = 1;
    this.cadK = 1;
  }

  get m() {
    return this.stack[this.stack.length - 1];
  }

  push(mat) {
    this.stack.push(this.m.clone().multiply(mat));
    return this;
  }

  pushAt(pos, quat, scale) {
    const p = pos instanceof THREE.Vector3 ? pos : new THREE.Vector3(...pos);
    return this.push(new THREE.Matrix4().compose(p, quat || new THREE.Quaternion(), scale || new THREE.Vector3(1, 1, 1)));
  }

  pop() {
    this.stack.pop();
    return this;
  }

  withK(k, fn) {
    const prev = this.k;
    this.k = prev * k;
    fn();
    this.k = prev;
    return this;
  }

  // Width is independent of radiance: a flange outline can be broad without
  // turning every little fastener into an equally broad glowing stroke.
  withWeight(weight, fn) {
    const prev = this.weight;
    this.weight = prev * weight;
    try {
      fn();
    } finally {
      this.weight = prev;
    }
    return this;
  }

  // Lines drawn inside fn are inked on the CAD look's surfaces at k times their strength (0: the
  // surface reads smooth there, as on a satin metal bell).
  withCadK(k, fn) {
    const prev = this.cadK;
    this.cadK = prev * k;
    this.cadOwn = true;
    try {
      fn();
    } finally {
      this.cadK = prev;
    }
    return this;
  }

  // ---------- edges ----------
  seg(a, b, k = 1, weight = 1) {
    _a.copy(a).applyMatrix4(this.m);
    _b.copy(b).applyMatrix4(this.m);
    this.segs.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z);
    this.inten.push(k * this.k);
    this.cadInten.push(k * this.k * this.cadK);
    this.weights.push(weight * this.weight);
  }

  poly(pts, closed = false, k = 1) {
    for (let i = 0; i < pts.length - 1; i++) this.seg(pts[i], pts[i + 1], k);
    if (closed && pts.length > 2) this.seg(pts[pts.length - 1], pts[0], k);
  }

  circlePts(c, n, r, segs = ringSegs(r), a0 = 0, a1 = TAU) {
    const [u, v] = basis(n);
    const pts = [];
    const full = Math.abs(a1 - a0 - TAU) < 1e-6;
    const count = full ? segs : Math.max(2, Math.ceil(segs * (a1 - a0) / TAU));
    for (let i = 0; i <= count; i++) {
      if (full && i === count) break;
      const t = a0 + (a1 - a0) * (i / count);
      pts.push(new THREE.Vector3().copy(c).addScaledVector(u, Math.cos(t) * r).addScaledVector(v, Math.sin(t) * r));
    }
    return { pts, closed: full };
  }

  circle(c, n, r, k = 1, segs) {
    const { pts, closed } = this.circlePts(c, n, r, segs);
    this.poly(pts, closed, k);
  }

  arc(c, n, r, a0, a1, k = 1) {
    const { pts } = this.circlePts(c, n, r, ringSegs(r), a0, a1);
    this.poly(pts, false, k);
  }

  // ---------- meshes ----------
  mesh(geo, mat) {
    if (!mat) {
      geo.dispose();
      return;
    }
    geo.applyMatrix4(this.m);
    const g = prepGeo(geo);
    if (!this.geos.has(mat)) this.geos.set(mat, []);
    this.geos.get(mat).push(g);
  }

  // Surface of revolution around local +Y. profile: [[r, y, sharp?], ...]
  lathe(profile, o = {}) {
    const segs = o.segs ?? 96;
    const phi0 = o.phi0 ?? 0;
    const phiLen = o.phiLen ?? TAU;
    const k = o.k ?? 1;
    // mesh: split at sharp points so CAD shading stays crisp
    if (o.mat) {
      let run = [];
      for (let i = 0; i < profile.length; i++) {
        run.push(new THREE.Vector2(Math.max(1e-4, profile[i][0]), profile[i][1]));
        const sharp = profile[i][2] === 1 && i > 0 && i < profile.length - 1;
        if (sharp || i === profile.length - 1) {
          if (run.length > 1) this.mesh(new THREE.LatheGeometry(run, segs, phi0, phiLen), o.mat);
          run = [new THREE.Vector2(Math.max(1e-4, profile[i][0]), profile[i][1])];
        }
      }
    }
    // rings
    let ringIdx;
    if (o.rings === 'all') ringIdx = profile.map((_, i) => i);
    else if (Array.isArray(o.rings)) ringIdx = o.rings;
    else ringIdx = profile.map((p, i) => (i === 0 || i === profile.length - 1 || p[2] === 1 ? i : -1)).filter((i) => i >= 0);
    const full = Math.abs(phiLen - TAU) < 1e-6;
    this.withWeight(o.ringWeight ?? o.weight ?? 1, () => {
      for (const i of ringIdx) {
        const [r, y] = profile[i];
        if (r < 0.004) continue;
        const c = new THREE.Vector3(0, y, 0);
        if (full) this.circle(c, UP, r, (o.ringK ?? 1) * k);
        else this.arcY(r, y, phi0, phi0 + phiLen, (o.ringK ?? 1) * k);
      }
    });
    // seams along the profile
    for (const ang of o.seams ?? [0]) {
      const pts = profile.map(([r, y]) => new THREE.Vector3(Math.sin(ang) * r, y, Math.cos(ang) * r));
      this.withWeight(o.seamWeight ?? o.weight ?? 1, () => this.poly(pts, false, (o.seamK ?? 0.8) * k));
    }
    if (!full && o.cutEdges !== false) {
      for (const ang of [phi0, phi0 + phiLen]) {
        const pts = profile.map(([r, y]) => new THREE.Vector3(Math.sin(ang) * r, y, Math.cos(ang) * r));
        this.poly(pts, false, k);
      }
    }
    return this;
  }

  // arc around local Y matching LatheGeometry's angle convention (x = sin, z = cos)
  arcY(r, y, a0, a1, k = 1) {
    const n = Math.max(2, Math.ceil(ringSegs(r) * (a1 - a0) / TAU));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = a0 + (a1 - a0) * (i / n);
      pts.push(new THREE.Vector3(Math.sin(t) * r, y, Math.cos(t) * r));
    }
    this.poly(pts, false, k);
  }

  // rectangular-section ring (flange, band) around local Y
  band(r0, r1, y0, y1, o = {}) {
    return this.lathe(
      [
        [r0, y0, 1],
        [r1, y0, 1],
        [r1, y1, 1],
        [r0, y1, 1],
        [r0, y0, 1],
      ],
      { seams: [], rings: o.rings ?? [0, 1, 2, 3], ...o }
    );
  }

  // cylinder/cone between two points
  cyl(a, b, r, o = {}) {
    const r2 = o.r2 ?? r;
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-6) return this;
    const q = quatFromY(dir);
    const segs = o.segs ?? Math.max(10, Math.min(48, Math.round(Math.max(r, r2) * 260)));
    this.pushAt(a, q);
    if (o.mat) {
      const g = new THREE.CylinderGeometry(r2, r, len, segs, 1, o.caps === false);
      g.translate(0, len / 2, 0);
      this.mesh(g, o.mat);
    }
    const k = o.k ?? 1;
    this.withWeight(o.ringWeight ?? o.weight ?? 1, () => {
      if (o.ends !== false) {
        this.circle(V(0, 0, 0), UP, r, k);
        this.circle(V(0, len, 0), UP, r2, k);
      }
      for (const t of o.ringsAt ?? []) this.circle(V(0, len * t, 0), UP, r + (r2 - r) * t, k * 0.9);
    });
    const seams = o.seams ?? (o.seam === false ? [] : [o.seamAngle ?? 0.7]);
    this.withWeight(o.seamWeight ?? o.weight ?? 1, () => {
      for (const ang of seams) this.seg(V(Math.sin(ang) * r, 0, Math.cos(ang) * r), V(Math.sin(ang) * r2, len, Math.cos(ang) * r2), k * 0.75);
    });
    this.pop();
    return this;
  }

  // hex prism (bolt head / nut) standing on point c along normal n
  hex(c, n, r, h, o = {}) {
    const q = quatFromY(n);
    this.pushAt(c, q);
    if (o.mat) {
      const g = new THREE.CylinderGeometry(r, r, h, 6, 1, false);
      g.translate(0, h / 2, 0);
      this.mesh(g, o.mat);
    }
    const k = o.k ?? 0.55;
    const top = [];
    const bot = [];
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * TAU + Math.PI / 6;
      top.push(V(Math.sin(t) * r, h, Math.cos(t) * r));
      bot.push(V(Math.sin(t) * r, 0, Math.cos(t) * r));
    }
    this.poly(top, true, k);
    if (o.full) {
      this.poly(bot, true, k * 0.8);
      for (let i = 0; i < 6; i += 2) this.seg(top[i], bot[i], k * 0.6);
    }
    if (o.washer !== false) this.circle(V(0, 0, 0), UP, r * 1.35, k * 0.7, 14);
    this.pop();
    return this;
  }

  boltCircle(c, n, R, count, r, h, o = {}) {
    const [u, v, nn] = basis(n);
    const a0 = o.a0 ?? 0;
    for (let i = 0; i < count; i++) {
      const t = a0 + (i / count) * TAU;
      const p = new THREE.Vector3().copy(c).addScaledVector(u, Math.cos(t) * R).addScaledVector(v, Math.sin(t) * R);
      this.hex(p, nn, r, h, o);
    }
    return this;
  }

  box(c, size, o = {}) {
    const q = o.quat || new THREE.Quaternion();
    this.pushAt(c, q);
    const [sx, sy, sz] = size;
    if (o.mat) this.mesh(new THREE.BoxGeometry(sx, sy, sz), o.mat);
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const k = o.k ?? 1;
    const p = [
      V(-hx, -hy, -hz), V(hx, -hy, -hz), V(hx, -hy, hz), V(-hx, -hy, hz),
      V(-hx, hy, -hz), V(hx, hy, -hz), V(hx, hy, hz), V(-hx, hy, hz),
    ];
    this.poly([p[0], p[1], p[2], p[3]], true, k);
    this.poly([p[4], p[5], p[6], p[7]], true, k);
    for (let i = 0; i < 4; i++) this.seg(p[i], p[i + 4], k);
    this.pop();
    return this;
  }

  sphere(c, r, o = {}) {
    this.pushAt(c, o.quat);
    if (o.mat) this.mesh(new THREE.SphereGeometry(r, 28, 18), o.mat);
    const k = o.k ?? 1;
    this.circle(V(0, 0, 0), UP, r, k);
    this.circle(V(0, 0, 0), V(1, 0, 0), r, k * 0.8);
    this.pop();
    return this;
  }

  torus(c, n, R, r, o = {}) {
    const q = quatFromY(n);
    this.pushAt(c, q);
    if (o.mat) {
      const g = new THREE.TorusGeometry(R, r, 14, Math.max(48, Math.round(R * 260)), o.arc ?? TAU);
      g.rotateX(-Math.PI / 2);
      this.mesh(g, o.mat);
    }
    const k = o.k ?? 1;
    const arc = o.arc ?? TAU;
    if (arc >= TAU - 1e-6) {
      this.circle(V(0, 0, 0), UP, R + r, k);
      this.circle(V(0, 0, 0), UP, R - r, k * 0.85);
      this.circle(V(0, r, 0), UP, R, k * 0.85);
    } else {
      // TorusGeometry (after rotateX(-90deg)) sweeps x=cos(t), z=-sin(t)
      for (const [rr, yy, kk] of [[R + r, 0, 1], [R - r, 0, 0.85], [R, r, 0.85]]) {
        const n2 = Math.max(4, Math.ceil(ringSegs(rr) * arc / TAU));
        const pts = [];
        for (let i = 0; i <= n2; i++) {
          const t = (i / n2) * arc;
          pts.push(V(Math.cos(t) * rr, yy, -Math.sin(t) * rr));
        }
        this.poly(pts, false, k * kk);
      }
    }
    for (const t of o.minor ?? [0, Math.PI]) {
      const cc = V(Math.cos(t) * R, 0, -Math.sin(t) * R);
      const tangent = V(-Math.sin(t), 0, -Math.cos(t));
      this.circle(cc, tangent, r, k * 0.8, 16);
    }
    this.pop();
    return this;
  }

  // path with straight runs and rounded bends
  pipePath(points, bend = 0.08) {
    const path = new THREE.CurvePath();
    const P = points.map((p) => (p instanceof THREE.Vector3 ? p.clone() : V(...p)));
    let cur = P[0].clone();
    for (let i = 1; i < P.length; i++) {
      const p = P[i];
      if (i === P.length - 1) {
        if (cur.distanceTo(p) > 1e-5) path.add(new THREE.LineCurve3(cur.clone(), p.clone()));
        break;
      }
      const d1 = new THREE.Vector3().subVectors(p, P[i - 1]);
      const d2 = new THREE.Vector3().subVectors(P[i + 1], p);
      const l1 = d1.length();
      const l2 = d2.length();
      d1.normalize();
      d2.normalize();
      const ang = Math.acos(THREE.MathUtils.clamp(d1.dot(d2), -1, 1));
      const t = Math.min(bend * Math.tan(ang / 2), l1 * 0.48, l2 * 0.48);
      const s = new THREE.Vector3().copy(p).addScaledVector(d1, -t);
      const e = new THREE.Vector3().copy(p).addScaledVector(d2, t);
      if (cur.distanceTo(s) > 1e-5) path.add(new THREE.LineCurve3(cur.clone(), s.clone()));
      if (t > 1e-5) path.add(new THREE.QuadraticBezierCurve3(s.clone(), p.clone(), e.clone()));
      cur = e;
    }
    return path;
  }

  // tube along waypoints (CAD-like: rings at each run/bend boundary and a seam)
  pipe(points, r, o = {}) {
    const path = o.path || (o.smooth ? new THREE.CatmullRomCurve3(points.map((p) => (p instanceof THREE.Vector3 ? p : V(...p))), false, 'centripetal') : this.pipePath(points, o.bend ?? Math.max(r * 2.2, 0.05)));
    const len = path.getLength();
    const tubular = Math.max(8, Math.min(400, Math.round(len * (o.density ?? 90))));
    if (o.mat) this.mesh(new THREE.TubeGeometry(path, tubular, r, o.radial ?? Math.max(8, Math.min(24, Math.round(r * 320))), false), o.mat);
    const k = o.k ?? 1;
    const frames = path.computeFrenetFrames(tubular, false);
    // rings at boundaries
    const bounds = [0];
    if (path.curves && !o.smooth && o.boundaryRings !== false) {
      const lens = path.getCurveLengths();
      for (const l of lens) bounds.push(l / len);
    } else bounds.push(1);
    const uniq = [...new Set(bounds.map((b) => Math.round(b * 1e5) / 1e5))];
    this.withWeight(o.ringWeight ?? o.weight ?? 1, () => {
      for (const u of uniq) {
        const pt = path.getPointAt(Math.min(1, Math.max(0, u)));
        const tg = path.getTangentAt(Math.min(1, Math.max(0, u)));
        this.circle(pt, tg, r, k * (o.ringK ?? 0.9));
      }
    });
    for (const u of o.ringsAt ?? []) {
      this.circle(path.getPointAt(u), path.getTangentAt(u), r * (o.ringScale ?? 1.12), k);
    }
    if (o.bellows) {
      for (const [u0, u1, count] of o.bellows) {
        for (let i = 0; i <= count; i++) {
          const u = u0 + (u1 - u0) * (i / count);
          this.circle(path.getPointAt(u), path.getTangentAt(u), r * (i % 2 ? 1.08 : 1.18), k * 0.8);
        }
      }
    }
    if (o.seam !== false) {
      this.withWeight(o.seamWeight ?? o.weight ?? 1, () => {
        for (const angle of o.seams ?? [0]) {
          const seamPts = [];
          for (let i = 0; i <= tubular; i++) {
            const p = path.getPointAt(i / tubular);
            seamPts.push(p.addScaledVector(frames.normals[i], Math.cos(angle) * r).addScaledVector(frames.binormals[i], Math.sin(angle) * r));
          }
          this.poly(seamPts, false, k * (o.seamK ?? 0.7));
        }
      });
    }
    return path;
  }

  // thin wire: mesh tube + centerline edge
  wire(points, r, o = {}) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => (p instanceof THREE.Vector3 ? p : V(...p))), false, 'centripetal');
    const len = curve.getLength();
    const n = Math.max(6, Math.round(len * 60));
    if (o.mat) this.mesh(new THREE.TubeGeometry(curve, n, r, 5, false), o.mat);
    this.poly(curve.getPoints(n), false, o.k ?? 0.65);
    return curve;
  }

  // variable-radius sweep (volutes, ducts). pathFn(t)->Vector3, radiusFn(t)->r
  sweep(pathFn, radiusFn, o = {}) {
    const steps = o.steps ?? 80;
    const radial = o.radial ?? 18;
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(pathFn(i / steps));
    // parallel transport frames
    const T = [];
    const N = [];
    const B = [];
    for (let i = 0; i <= steps; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(steps, i + 1)];
      T.push(new THREE.Vector3().subVectors(b, a).normalize());
    }
    const [n0] = basis(T[0]);
    N.push(n0);
    B.push(new THREE.Vector3().crossVectors(T[0], n0));
    for (let i = 1; i <= steps; i++) {
      const axis = new THREE.Vector3().crossVectors(T[i - 1], T[i]);
      const nn = N[i - 1].clone();
      if (axis.length() > 1e-8) {
        axis.normalize();
        const ang = Math.acos(THREE.MathUtils.clamp(T[i - 1].dot(T[i]), -1, 1));
        nn.applyAxisAngle(axis, ang);
      }
      N.push(nn);
      B.push(new THREE.Vector3().crossVectors(T[i], nn));
    }
    if (o.mat) {
      const pos = [];
      const nor = [];
      const idx = [];
      for (let i = 0; i <= steps; i++) {
        const r = radiusFn(i / steps);
        for (let j = 0; j <= radial; j++) {
          const a = (j / radial) * TAU;
          const dir = new THREE.Vector3().addScaledVector(N[i], Math.cos(a)).addScaledVector(B[i], Math.sin(a));
          pos.push(pts[i].x + dir.x * r, pts[i].y + dir.y * r, pts[i].z + dir.z * r);
          nor.push(dir.x, dir.y, dir.z);
        }
      }
      for (let i = 0; i < steps; i++) {
        for (let j = 0; j < radial; j++) {
          const a = i * (radial + 1) + j;
          const b = a + radial + 1;
          idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setIndex(idx);
      this.mesh(g, o.mat);
    }
    const k = o.k ?? 1;
    for (const t of o.rings ?? [0, 1]) {
      const i = Math.round(t * steps);
      this.circle(pts[i], T[i], radiusFn(i / steps), k * 0.9);
    }
    for (const sa of o.seams ?? [0]) {
      const sp = [];
      for (let i = 0; i <= steps; i++) {
        const r = radiusFn(i / steps);
        sp.push(new THREE.Vector3().copy(pts[i]).addScaledVector(N[i], Math.cos(sa) * r).addScaledVector(B[i], Math.sin(sa) * r));
      }
      this.poly(sp, false, k * 0.75);
    }
    return { pts, T, N, B };
  }

  // flat plate from a THREE.Shape lying in local XZ, thickness along +Y
  plate(shape, thickness, o = {}) {
    const k = o.k ?? 1;
    if (o.mat) {
      const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: o.curveSegments ?? 24 });
      g.rotateX(-Math.PI / 2); // shape (x, y) -> (x, z = -y), extrude -> +y
      this.mesh(g, o.mat);
    }
    const outline = shape.getPoints(o.curveSegments ?? 24);
    const toV = (p, y) => V(p.x, y, -p.y);
    const draw = (pts, closed, kk) => {
      this.poly(pts.map((p) => toV(p, 0)), closed, kk);
      this.poly(pts.map((p) => toV(p, thickness)), closed, kk);
    };
    draw(outline, true, k);
    // vertical edges at outline corners
    for (let i = 0; i < outline.length; i++) {
      const p0 = outline[(i - 1 + outline.length) % outline.length];
      const p1 = outline[i];
      const p2 = outline[(i + 1) % outline.length];
      const d1 = new THREE.Vector2().subVectors(p1, p0).normalize();
      const d2 = new THREE.Vector2().subVectors(p2, p1).normalize();
      if (d1.dot(d2) < 0.94) this.seg(toV(p1, 0), toV(p1, thickness), k * 0.8);
    }
    for (const h of shape.holes) draw(h.getPoints(o.curveSegments ?? 24), true, k * (o.holeK ?? 0.85));
    return this;
  }

  // ---------- build ----------
  build(materials) {
    const group = new THREE.Group();
    group.name = this.name;
    const meshes = [];
    for (const [key, list] of this.geos) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      list.forEach((g) => g !== merged && g.dispose());
      merged.computeBoundingSphere();
      const mat = materials[key];
      if (!mat) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.userData.matKey = key;
      mesh.name = `${this.name}:${key}`;
      meshes.push(mesh);
      group.add(mesh);
    }
    const segs = new Float32Array(this.segs);
    const inten = new Float32Array(this.inten);
    const weights = new Float32Array(this.weights);
    // the CAD look's ink lines, when they differ from the luminous looks' lines
    let cad = null;
    if (this.cadOwn) {
      const keep = [];
      this.cadInten.forEach((k, i) => k > 0 && keep.push(i));
      cad = {
        segs: new Float32Array(keep.length * 6),
        inten: new Float32Array(keep.length),
        weights: new Float32Array(keep.length),
      };
      keep.forEach((i, j) => {
        cad.segs.set(this.segs.slice(i * 6, i * 6 + 6), j * 6);
        cad.inten[j] = this.cadInten[i];
        cad.weights[j] = this.weights[i];
      });
    }
    return { group, meshes, segs, inten, weights, cad };
  }
}

export function shapeFromPoints(points) {
  const s = new THREE.Shape();
  points.forEach(([x, z], i) => (i === 0 ? s.moveTo(x, -z) : s.lineTo(x, -z)));
  s.closePath();
  return s;
}

export function circleHole(x, z, r) {
  const h = new THREE.Path();
  h.absarc(x, -z, r, 0, TAU, true);
  return h;
}
