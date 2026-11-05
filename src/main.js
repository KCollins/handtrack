// main.js - wires camera hand tracking, gestures, model physics, rendering, HUD and sound.
import * as THREE from 'three';
import { Viewer, MODES, look, BG } from './scene.js';
import { ModelControl, controlTuning } from './control.js';
import { Gestures, gestureTuning } from './gestures.js';
import { HandTracker, Detector, startCamera, tuning as handTuning, poseNoise } from './hands.js';
import { Hud } from './hud.js';
import { Sfx } from './audio.js';
import { MouseInput } from './mouse.js';
import { synthResult, eulerQuat, seedNoise } from './synthetic-hands.js';
import { demoHands } from './demo.js';

const params = new URLSearchParams(location.search);
const DEV = params.get('dev') === '1' || params.get('debug') === '1'; // tuning keys: D readout, A auto-rotate, G panel
const $ = (id) => document.getElementById(id);
// phones and tablets: the pointer fallback is touch (drag, pinch), not a mouse
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
if (TOUCH) {
  $('help-mouse').hidden = true;
  $('help-touch').hidden = false;
}

// ------------------------------------------------------------------ clock
// Live: performance.now(). Tests switch to a manual clock driven by advanceTime().
const clock = {
  manual: false,
  sim: 0,
  now() {
    return this.manual ? this.sim : performance.now() / 1000;
  },
};

// ------------------------------------------------------------------ core objects
const HOME = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.33, 0.5, 0, 'XYZ'));
const control = new ModelControl(HOME);
const viewer = new Viewer($('gl'), control);
const hud = new Hud($('hud'), () => clock.now());
const sfx = new Sfx();
const tracker = new HandTracker();
const gestures = new Gestures(
  control,
  {
    width: () => window.innerWidth,
    height: () => window.innerHeight,
    worldPerPixel: () => viewer.worldPerPixel(),
    originPx: () => viewer.originPx(),
    exploded: () => viewer.explodeTarget > 0.5,
    camAspect: () => tracker.aspect,
  },
  (type, data) => onEvent(type, { ...data, source: 'hand' })
);
const mouse = new MouseInput($('hud'), control, viewer, clock, (type, data) => onEvent(type, { ...data, source: 'mouse' }));

const state = {
  input: 'none', // 'none' (mouse / touch only) | 'camera' | 'demo'
  camera: 'off', // 'off' | 'starting' | 'loading' | 'on' | 'error'
  warming: false, // camera on, first hand-tracking result not back yet
  hudState: 'idle',
  ui: 'full', // 'full' | 'model' (overlays hidden)
  autoRotate: params.get('auto') === '1',
  debug: params.get('debug') === '1',
  demo: null,
  touched: false, // the engine drifts gently until someone first moves it
  t0: performance.now() / 1000,
};

// ------------------------------------------------------------------ events
// every state change shows on the engine itself: lock-on (brackets, in hud.js), a catch
// shockwave, a release pulse, and the lines flaring
function onEvent(type, data) {
  state.touched = true;
  if (type === 'grab') {
    sfx.grab();
    viewer.flash(0.5);
    viewer.sweepGlow();
  } else if (type === 'catch') {
    sfx.catch();
    viewer.flash(1.0);
    hud.shockwave();
  } else if (type === 'release') {
    const speed = data.speed ?? 0;
    sfx.release(speed);
    if (speed > 0.3) viewer.flash(0.35);
    hud.pulse(speed);
  } else if (type === 'two') {
    sfx.grab();
    viewer.flash(0.4);
  } else if (type === 'explode') {
    // two fists took the exploded view all the way apart (or together)
    settleExplode(data.on, true);
  } else if (type === 'fists') {
    // two fists moving the exploded view (it follows them every frame, in step())
    if (data.phase === 'pull' && data.toward === 1) control.frame();
    else if (data.phase === 'end') settleExplode(data.end === 1, data.changed);
  }
}

function settleExplode(on, changed) {
  viewer.toggleExplode(on);
  if (!changed) return;
  if (on) control.frame();
  sfx.explode(on);
  viewer.flash(0.6);
  hud.burst(on);
}

// ------------------------------------------------------------------ detections
function onDetections(result, t) {
  const tracks = tracker.update(result, t);
  state.hudState = gestures.update(tracks, t);
}

let detector = null;

// a camera permission the user already denied: skip loading hand tracking for nothing
let camPermission = null;
navigator.permissions
  ?.query({ name: 'camera' })
  .then((p) => (camPermission = p))
  .catch(() => {});

function embeddedPage() {
  // sandboxed previews (opaque origin) and embeds can never get the camera
  try {
    return window.origin === 'null' || window.self !== window.top;
  } catch {
    return true;
  }
}

const EXPECTED_CAMERA_ERRORS = ['NotAllowedError', 'SecurityError', 'NotFoundError', 'OverconstrainedError', 'NotReadableError', 'AbortError'];

async function enableCamera() {
  sfx.init();
  if (state.camera === 'starting' || state.camera === 'loading' || state.camera === 'on') return;
  const other = TOUCH ? 'use touch' : 'use the mouse';
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraError(`Camera is not available in this browser. You can still ${other}.`);
    return;
  }
  if (camPermission?.state === 'denied') {
    cameraError(
      embeddedPage()
        ? `Camera access is blocked in this preview. Open the published link, or ${other}.`
        : `Camera permission was denied. Allow it in your browser's site settings, or ${other}.`
    );
    return;
  }
  state.camera = 'starting';
  setCta('Starting camera', true);
  const video = $('cam');
  detector = new Detector(
    (res, t) => {
      if (state.warming) trackingLive();
      if (state.input === 'camera') onDetections(res, t);
    },
    (err) => console.warn('hand tracking error', err),
    { prefer: params.get('delegate') === 'cpu' ? 'CPU' : 'GPU', onLost: cameraLost }
  );
  const camP = startCamera(video);
  const detP = detector.init();
  detP.catch(() => {}); // handled below, once the camera answers; no unhandled rejection meanwhile
  try {
    await camP;
  } catch (err) {
    if (!EXPECTED_CAMERA_ERRORS.includes(err?.name)) console.warn(err);
    detector.stop();
    detector = null;
    const name = err?.name;
    const blocked = name === 'NotAllowedError' || name === 'SecurityError';
    const busy = name === 'NotReadableError' || name === 'AbortError';
    cameraError(
      blocked
        ? embeddedPage()
          ? `Camera access is blocked in this preview. Open the published link, or ${other}.`
          : `Camera permission was denied. Allow it in your browser's site settings, or ${other}.`
        : busy
          ? `The camera is in use by another app. Close it and try again, or ${other}.`
          : `No camera found. You can still ${other}.`
    );
    return;
  }
  tracker.aspect = video.videoWidth / video.videoHeight || 16 / 9;
  state.camera = 'loading';
  setCta('Loading hand tracking', true);
  try {
    await detP;
  } catch (err) {
    console.warn(err);
    detector.stop();
    detector = null;
    video.srcObject?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    cameraError(`Hand tracking failed to load. Check the connection, or ${other}.`);
    return;
  }
  state.camera = 'on';
  state.input = 'camera';
  // the first inference can take seconds (GPU warm-up, or the switch to CPU): the button stays
  // up, busy, until the first frame has been read
  state.warming = true;
  detector.start(video);
}

function trackingLive() {
  state.warming = false;
  sfx.boot();
  viewer.sweepGlow();
  els.msg.hidden = true;
  hideCta();
  els.status.textContent = 'Hand tracking on';
}

// The camera went away mid-session (unplugged, access revoked, taken by another app) or hand
// tracking stopped: the hands fade out, the engine keeps any spin it has, and the button returns.
function cameraLost(why = 'camera') {
  if (state.camera !== 'on') return;
  detector?.stop();
  detector = null;
  const video = $('cam');
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  gestures.endFists();
  gestures.reset();
  tracker.clear();
  state.input = 'none';
  state.warming = false;
  const other = TOUCH ? 'use touch' : 'use the mouse';
  cameraError(
    why === 'tracking'
      ? `Hand tracking stopped. Check the connection and press Enable camera, or ${other}.`
      : `The camera disconnected. Reconnect it and press Enable camera, or ${other}.`
  );
  els.status.textContent = why === 'tracking' ? 'Hand tracking stopped' : 'Camera disconnected';
}

function cameraError(msg) {
  state.camera = 'error';
  els.msg.textContent = msg;
  els.msg.hidden = false;
  els.cta.hidden = false;
  setCta('', false);
  measureDock();
}

// While busy the button shows a light running around its edge instead of status text;
// screen readers hear the status from a hidden live region.
function setCta(status, busy) {
  els.cta.setAttribute('aria-busy', busy ? 'true' : 'false');
  els.status.textContent = status;
}

function hideCta() {
  els.cta.hidden = true;
  els.cta.setAttribute('aria-busy', 'false');
  measureDock();
}

// ------------------------------------------------------------------ demo (synthetic hands, ?demo=1)
function startDemo() {
  state.input = 'demo';
  state.demo = { t0: clock.now(), lastPush: 0 };
  tracker.aspect = 16 / 9;
  hideCta();
}

function runDemo(now) {
  const D = state.demo;
  // synthetic hands at a webcam's 30 Hz
  if (!D || now - D.lastPush < 1 / 30 - 0.003) return;
  D.lastPush = now;
  const { hands, loop } = demoHands(now - D.t0);
  if (D.loop != null && loop !== D.loop) {
    // start over from the boot scan, with the engine home
    gestures.reset();
    control.goHome(1e-3);
    viewer.toggleExplode(false);
    viewer.rescan();
  }
  D.loop = loop;
  onDetections(synthResult(hands, tracker.aspect), now);
}

// ------------------------------------------------------------------ frame loop
let lastMs = performance.now();
let fps = 60;
const Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

let steps = 0; // frames stepped so far
function step(dt, render = true) {
  steps++;
  const now = clock.now();
  if (state.input === 'demo') runDemo(now);
  if (state.input === 'none') {
    // mouse / touch gestures report through the same physics; derive the HUD state from them
    state.hudState = mouse.busy ? (mouse.mode === 'pinch' || mouse.mode === 'pan' ? 'two' : 'grab') : control.spinSpeed > 0.3 ? 'spin' : 'idle';
  }
  if (state.autoRotate && !control.held && control.spinSpeed < 0.05 && !control.reset) {
    control.q.premultiply(_q.setFromAxisAngle(Y, 0.22 * dt));
  } else if (!state.touched && !state.autoRotate && !control.held && !control.reset && control.spinSpeed === 0) {
    idleDrift(now);
  }
  gestures.follow(now);
  const fist = gestures.fist?.armed ? gestures.fist : null;
  viewer.explodeLive = !!fist;
  if (fist) viewer.explodeTarget = fist.amount;
  control.bounds = viewer.centerBounds(controlTuning.bounds);
  control.fit = viewer.fitRange(controlTuning.margin);
  control.step(dt, now);
  viewer.update(dt);
  if (!viewer.trans) endBoot();
  updateDom(dt, now);
  if (!render) return;
  hud.draw(dt, {
    tracks: state.input === 'camera' || state.input === 'demo' ? tracker.tracks : [],
    gestures,
    viewer,
    control,
    now,
    resultT: tracker.lastResultT,
    aspect: tracker.aspect,
  });
  viewer.render(dt);
  sfx.spin(control.spinSpeed);
  sfx.stretch(viewer.explode, fist ? viewer.explodeVel : 0);
  motionSound(dt);
}

// the held engine's turning, zoom and slide drive the continuous motion sounds
const heard = { has: false, ls: 0, x: 0, y: 0, zoom: 0, slide: 0 };
function motionSound(dt) {
  if (!sfx.ctx || !(dt > 0)) return;
  const ls = Math.log(control.scale);
  const { x, y } = control.pos;
  if (!heard.has) Object.assign(heard, { has: true, ls, x, y });
  const viewH = Math.max(1e-6, viewer.worldPerPixel() * viewer.h);
  const zoomRate = (ls - heard.ls) / dt;
  const slide = Math.hypot(x - heard.x, y - heard.y) / dt / viewH;
  Object.assign(heard, { ls, x, y });
  const k = 1 - Math.exp(-dt / 0.06);
  heard.zoom += (zoomRate - heard.zoom) * k;
  heard.slide += (slide - heard.slide) * k;
  const turn = control.held ? control.shownW.length() : 0;
  const pan = x / Math.max(1e-6, (viewH * viewer.camera.aspect) / 2);
  sfx.motion(turn, heard.zoom, control.scale, heard.slide, pan);
}

// before anyone touches it the engine sways slowly, so the opening frames are alive
const X = new THREE.Vector3(1, 0, 0);
const _qp = new THREE.Quaternion();
function idleDrift(now) {
  const t = now - state.t0;
  const ramp = THREE.MathUtils.smoothstep(t, 1.0, 3.5);
  const ph = (Math.PI * 2 * Math.max(0, t - 1.0)) / 14;
  _q.setFromAxisAngle(Y, 0.16 * ramp * Math.sin(ph));
  _qp.setFromAxisAngle(X, 0.035 * ramp * Math.sin(ph * 0.5 + 0.6) - 0.035 * ramp * Math.sin(0.6));
  control.q.copy(HOME).premultiply(_qp).premultiply(_q);
}

function frame(ms) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (ms - lastMs) / 1000));
  lastMs = ms;
  if (clock.manual) return;
  if (dt > 0) fps = fps * 0.95 + (1 / dt) * 0.05;
  step(dt);
}

// ------------------------------------------------------------------ DOM
const els = {
  debug: $('debug'),
  help: $('help'),
  helpBtn: document.querySelector('.ctl[data-act="help"]'),
  explodeBtn: document.querySelector('.ctl[data-act="explode"]'),
  lookBtn: document.querySelector('.ctl[data-act="look"]'),
  dock: $('dock'),
  cta: $('btn-camera'),
  msg: $('cam-msg'),
  status: $('cam-status'),
};
const LOOK_LABELS = { wire: 'wireframe', cad: 'CAD model', holo: 'hologram' };
let domT = 0;

function updateDom(dt, now) {
  domT += dt;
  if (domT < 0.1) return;
  domT = 0;
  if (els.explodeBtn) {
    const pressed = viewer.explodeTarget > 0.5 ? 'true' : 'false';
    if (els.explodeBtn.getAttribute('aria-pressed') !== pressed) els.explodeBtn.setAttribute('aria-pressed', pressed);
  }
  if (els.lookBtn) {
    const label = `Look: ${LOOK_LABELS[viewer.mode] ?? viewer.mode}`;
    if (els.lookBtn.getAttribute('aria-label') !== label) els.lookBtn.setAttribute('aria-label', label);
    if (els.lookBtn.dataset.look !== viewer.mode) els.lookBtn.dataset.look = viewer.mode;
  }
  if (state.debug) {
    const d = detector;
    const lines = [
      `render ${fps.toFixed(0)} fps  dpr ${viewer.dpr.toFixed(2)}`,
      d ? `track ${d.fps.toFixed(0)} fps  ${d.inferMs.toFixed(1)} ms  ${d.kind ?? '-'} ${d.delegate ?? ''}` : 'track -',
      `state ${state.hudState}  input ${state.input}  camera ${state.camera}`,
      ...tracker.tracks.map(
        (t) => `hand ${t.id} ${t.handed || '?'} open ${t.open.toFixed(2)} ${t.isOpen ? 'OPEN' : 'closed'} age ${t.age.toFixed(2)}`
      ),
      `omega ${control.omega.x.toFixed(2)} ${control.omega.y.toFixed(2)} ${control.omega.z.toFixed(2)}`,
      `spin ${(control.spinSpeed / (Math.PI * 2)).toFixed(2)} rev/s  scale ${control.scale.toFixed(2)}`,
      `segments ${viewer.stats.segments}  tris ${Math.round(viewer.stats.triangles)}`,
    ];
    els.debug.textContent = lines.join('\n');
  }
}

// the help panel sits just above the dock, and the engine centers in the space above it
function measureDock(instant = false) {
  const r = els.dock.getBoundingClientRect();
  document.documentElement.style.setProperty('--dock-h', `${Math.round(r.height)}px`);
  viewer.setReserve(state.ui === 'model' ? 0 : window.innerHeight - r.top + 8, instant);
  viewer.controlsTop = state.ui === 'model' || document.body.classList.contains('booting') ? null : r.top;
}

// the controls fade in once the opening scan has swept the engine
function endBoot() {
  if (!document.body.classList.contains('booting')) return;
  document.body.classList.remove('booting');
  measureDock();
}

function showHelp() {
  measureDock();
  els.help.hidden = false;
  els.helpBtn?.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => els.help.classList.add('show'));
  wake();
}

function hideHelp() {
  els.help.classList.remove('show');
  els.helpBtn?.setAttribute('aria-expanded', 'false');
  setTimeout(() => {
    if (!els.help.classList.contains('show')) els.help.hidden = true;
  }, 260);
  wake();
}

// a press anywhere outside the help closes it; a press on the model only closes it, so
// dismissing the help does not also grab the engine
window.addEventListener(
  'pointerdown',
  (e) => {
    if (els.help.hidden || els.help.contains(e.target) || els.helpBtn?.contains(e.target)) return;
    hideHelp();
    if (e.target === mouse.el) e.stopPropagation();
  },
  true
);

// ------------------------------------------------------------------ idle: controls and cursor fade
const IDLE_S = 3;
let idleTimer = 0;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(goIdle, IDLE_S * 1000);
}

const HOVER = matchMedia('(hover: hover)').matches;
function goIdle() {
  // stay awake while the help is open, a control has keyboard focus, or the pointer rests on the dock
  if (!els.help.hidden || els.dock.querySelector(':focus-visible') || (HOVER && els.dock.matches(':hover'))) {
    wake();
    return;
  }
  document.body.classList.add('idle');
}

for (const type of ['pointermove', 'pointerdown', 'wheel', 'touchstart']) {
  window.addEventListener(type, wake, { passive: true });
}

// Shortcut keys act without bringing back the controls or the cursor, so a take stays clean.
// Other keys (Tab to reach the controls, for one) wake them, as does any key while a control has focus.
const SHORTCUTS = new Set(['1', '2', '3', 'e', 'r', 'h', 'm', 'c', ' ']);
const onControl = () => document.activeElement?.closest?.('button, a, input, .help') && document.activeElement !== document.body;
window.addEventListener(
  'keydown',
  (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !SHORTCUTS.has(e.key.toLowerCase()) || onControl()) wake();
  },
  { passive: true }
);

function applyUi() {
  document.body.dataset.ui = state.ui;
  hud.visible = state.ui !== 'model';
  if (state.ui === 'model' && !els.help.hidden) hideHelp();
  measureDock();
}

// ------------------------------------------------------------------ keys
function setMode(m) {
  if (viewer.setMode(m)) sfx.mode();
}

// actions shared by the keyboard and the on-screen control buttons
function act(name) {
  if (name === 'explode' || name === 'reset') state.touched = true;
  if (name === 'look') setMode(MODES[(MODES.indexOf(viewer.mode) + 1) % MODES.length]);
  else if (name === 'explode') {
    // (fists holding the exploded view let go of it)
    const was = viewer.explodeTarget > 0.5;
    gestures.fist = null;
    const out = viewer.toggleExplode(!was);
    if (out) control.frame();
    sfx.explode(out);
  } else if (name === 'reset') {
    control.goHome();
    gestures.reset();
    const was = viewer.explodeTarget > 0.5;
    viewer.toggleExplode(false);
    if (was) sfx.explode(false);
  } else if (name === 'hide') {
    state.ui = state.ui === 'full' ? 'model' : 'full';
    applyUi();
    if (state.ui === 'full') wake();
  } else if (name === 'help') {
    if (els.help.hidden) showHelp();
    else hideHelp();
  }
}

document.querySelectorAll('.controls .ctl').forEach((b) =>
  b.addEventListener('click', (e) => {
    sfx.init();
    act(b.dataset.act);
    // pointer clicks drop focus so Space keeps meaning "stop a spin"; keyboard focus stays
    if (e.detail > 0) b.blur();
  })
);

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === '1' || k === '2' || k === '3') setMode(MODES[Number(k) - 1]);
  else if (k === 'e') act('explode');
  else if (k === 'r') act('reset');
  else if (k === 'h') act('hide');
  else if (k === 'c' && !els.cta.hidden) enableCamera();
  else if (k === 'm') {
    sfx.init();
    sfx.toggleMute();
  } else if (DEV && k === 'd') {
    state.debug = !state.debug;
    els.debug.hidden = !state.debug;
  } else if (DEV && k === 'a') {
    state.autoRotate = !state.autoRotate;
  } else if (DEV && k === 'g') openTuning();
  else if (k === '?' || k === '/') act('help');
  else if (k === 'escape' && !els.help.hidden) hideHelp();
  else if (k === ' ' && !onControl()) {
    state.touched = true;
    control.stop();
    e.preventDefault();
  }
});

// lazily loaded tuning panel
let gui = null;
async function openTuning() {
  if (gui) {
    gui.show(gui._hidden);
    return;
  }
  const { GUI } = await import('https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/+esm');
  gui = new GUI({ title: 'Tuning' });
  const h = gui.addFolder('Hands');
  h.add(handTuning, 'openOn', 0.4, 0.95, 0.01);
  h.add(handTuning, 'openOff', 0.3, 0.9, 0.01);
  h.add(handTuning, 'reach', 1, 2, 0.01);
  h.add(handTuning, 'oriStill', 0.05, 1, 0.01).name('rotation memory (s)');
  h.add(handTuning, 'oriFast', 0.005, 0.2, 0.005).name('manoeuvre memory (s)');
  h.add(handTuning, 'oriT0', 0.2, 4, 0.05).name('manoeuvre threshold');
  h.add(handTuning, 'oriS0', 0.1, 3, 0.05).name('stop threshold');
  h.add(handTuning, 'oriNMax', 1, 4, 0.1).name('still smoothing');
  h.add(handTuning, 'predictMax', 0, 0.1, 0.005).name('prediction (s)');
  h.add(handTuning, 'posStill', 0.05, 1, 0.01);
  h.add(handTuning, 'posFast', 0.005, 0.2, 0.005);
  const c = gui.addFolder('Physics');
  c.add(controlTuning, 'gain', 0.5, 3, 0.01).name('rotation gain');
  c.add(controlTuning, 'holdWn', 10, 120, 1).name('hold stiffness');
  c.add(controlTuning, 'spinTau', 0.5, 30, 0.1).name('spin decay (s)');
  c.add(controlTuning, 'maxSpin', 1, 20, 0.1);
  c.add(controlTuning, 'minSpin', 0, 1, 0.01);
  c.add(controlTuning, 'zoomExp', 0.5, 2.5, 0.01);
  c.add(gestureTuning, 'releaseWindow', 0.04, 0.3, 0.005);
  const l = gui.addFolder('Look');
  l.add(look, 'lineWidth', 0.5, 4, 0.05).onChange(() => viewer.resize());
  l.add(look.bloom.wire, '0', 0, 3, 0.01).name('wire bloom');
  l.add(look.bloom.wire, '1', 0, 1, 0.01).name('wire bloom radius');
  l.add(look.bloom.wire, '2', 0, 1, 0.01).name('wire bloom threshold');
  l.add(look.bloom.holo, '0', 0, 3, 0.01).name('holo bloom');
  l.add(look, 'occluded', 0, 1, 0.01).name('hidden lines');
  l.add(look, 'occludedDeep', 0, 30, 0.5).name('hidden lines depth fade');
  l.add(viewer.renderer, 'toneMappingExposure', 0.3, 3, 0.01).name('exposure');
}

// ------------------------------------------------------------------ resize
window.addEventListener('resize', () => {
  viewer.resize();
  hud.resize();
  measureDock();
});

// ------------------------------------------------------------------ boot
els.cta.addEventListener('click', enableCamera);
// any first touch, click or key unlocks sound (browsers require a gesture)
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => sfx.init(), { once: true, passive: true });
els.debug.hidden = !state.debug;
applyUi();
if (params.get('mode') && MODES.includes(params.get('mode'))) viewer.setMode(params.get('mode'));
else viewer.boot();
if (params.get('ui') === 'model' || params.get('ui') === 'clean') {
  state.ui = 'model';
  applyUi();
}
if (params.get('demo') === '1') startDemo();
else if (params.get('input') === 'mouse') hideCta();
measureDock(true);
requestAnimationFrame((ms) => {
  frame(ms);
  // reveal once the first frame is drawn (it fades in over the matching poster); the dock
  // follows the boot scan, or shows anyway if frames stop before the scan ends
  document.body.classList.add('ready');
  setTimeout(() => $('poster')?.remove(), 600);
  let seen = steps;
  const bootFallback = () => {
    if (!document.body.classList.contains('booting')) return;
    if (viewer.trans && (steps > seen || clock.manual)) {
      seen = steps;
      setTimeout(bootFallback, 1000);
    } else endBoot();
  };
  setTimeout(bootFallback, 4000);
  wake();
});

// ------------------------------------------------------------------ test hooks
function normSpec(s) {
  const out = { ...s };
  if (s.euler) out.quat = eulerQuat(...s.euler);
  return out;
}

function snapshot() {
  const q = control.q;
  return {
    mode: viewer.mode,
    input: state.input,
    hudState: state.hudState,
    gesture: gestures.state,
    hands: tracker.tracks.map((t) => ({
      id: t.id,
      open: +t.open.toFixed(3),
      isOpen: t.isOpen,
      screen: t.screen.map((v) => +v.toFixed(3)),
      role: gestures.roleOf(t.id),
    })),
    quat: [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(4)),
    scale: +control.scale.toFixed(3),
    pos: control.pos.toArray().map((v) => +v.toFixed(3)),
    omega: control.omega.toArray().map((v) => +v.toFixed(3)),
    spinRevPerSec: +(control.spinSpeed / (Math.PI * 2)).toFixed(3),
    explode: +viewer.explode.toFixed(3),
    held: control.held,
  };
}

window.render_game_to_text = () => JSON.stringify(snapshot());
window.advanceTime = (ms, opts = {}) => {
  if (!clock.manual) {
    clock.manual = true;
    clock.sim = performance.now() / 1000;
  }
  const n = Math.max(1, Math.round(ms / (1000 / 60)));
  for (let i = 0; i < n; i++) {
    clock.sim += 1 / 60;
    step(1 / 60, i === n - 1 && opts.render !== false);
  }
};
window.__merlin = {
  viewer,
  control,
  gestures,
  tracker,
  hud,
  sfx,
  clock,
  state,
  mouse,
  snapshot,
  look,
  BG,
  tuning: { control: controlTuning, gesture: gestureTuning, hands: handTuning },
  poseNoise,
  get detector() {
    return detector;
  },
  test: {
    pushHands(specs, t = clock.now()) {
      if (state.input !== 'demo') state.input = 'camera';
      onDetections(synthResult(specs.map(normSpec), tracker.aspect), t);
    },
    clearHands(t = clock.now()) {
      onDetections({ landmarks: [], worldLandmarks: [], handedness: [] }, t);
    },
    pause() {
      clock.manual = true;
      clock.sim = performance.now() / 1000;
    },
    resume() {
      clock.manual = false;
    },
    hidePanel: hideCta,
    seedNoise,
  },
};
