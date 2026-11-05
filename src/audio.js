// audio.js - small synthesized interface sounds (no audio files).
export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.master = null;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.42;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    // noise buffer
    const len = ctx.sampleRate * 1.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    // spin hum: two detuned sines through a lowpass, gain follows spin speed
    this.hum = ctx.createGain();
    this.hum.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    this.humOsc = [ctx.createOscillator(), ctx.createOscillator()];
    this.humOsc[0].frequency.value = 55;
    this.humOsc[1].type = 'triangle';
    this.humOsc[1].frequency.value = 110.6;
    this.humOsc.forEach((o) => {
      o.connect(lp);
      o.start();
    });
    lp.connect(this.hum).connect(this.master);
    this.humLp = lp;
    // stretch: a soft mechanical whir while two fists slide the engine's parts apart or together
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 300;
    bp.Q.value = 2.5;
    this.whir = ctx.createGain();
    this.whir.gain.value = 0;
    src.connect(bp).connect(this.whir).connect(this.master);
    src.start();
    this.whirBp = bp;
    this.initMotion(ctx, buf);
    // a hidden tab stops the frame loop that steers the continuous layers: pause all sound with it
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ctx.suspend();
      else ctx.resume();
    });
  }

  // Continuous layers that follow the engine while a hand holds or moves it; each is silent at
  // rest and fades with the motion: air and a faint servo while it turns, a gliding tone while
  // it zooms, and a soft high slide, panned with the engine, while it moves across the view.
  initMotion(ctx, buf) {
    const loop = (offset) => {
      const n = ctx.createBufferSource();
      n.buffer = buf;
      n.loop = true;
      n.start(0, offset);
      return n;
    };
    const filter = (type, f, q) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const silent = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      return g;
    };
    this.air = silent();
    this.airBp = filter('bandpass', 400, 0.8);
    loop(0.31).connect(this.airBp).connect(this.air).connect(this.master);

    this.servo = silent();
    this.servoOsc = ctx.createOscillator();
    this.servoOsc.type = 'sawtooth';
    this.servoOsc.frequency.value = 70;
    this.servoOsc.connect(filter('lowpass', 520, 0.7)).connect(this.servo).connect(this.master);
    this.servoOsc.start();

    this.zoom = silent();
    const zLp = filter('lowpass', 1800, 0.7);
    zLp.connect(this.zoom).connect(this.master);
    this.zoomOsc = [ctx.createOscillator(), ctx.createOscillator()];
    this.zoomOsc[1].type = 'triangle';
    const fifth = ctx.createGain();
    fifth.gain.value = 0.35;
    this.zoomOsc[0].connect(zLp);
    this.zoomOsc[1].connect(fifth).connect(zLp);
    for (const o of this.zoomOsc) o.start();
    this.zoomAir = silent();
    this.zoomBp = filter('bandpass', 2000, 4);
    loop(0.77).connect(this.zoomBp).connect(this.zoomAir).connect(this.master);

    this.slide = silent();
    const slideOut = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.slidePan = slideOut;
    loop(1.13).connect(filter('highpass', 1200, 0.7)).connect(filter('lowpass', 6000, 0.7)).connect(this.slide);
    if (slideOut) this.slide.connect(slideOut).connect(this.master);
    else this.slide.connect(this.master);
  }

  // turn: rad/s of the held engine; zoomRate: change of ln(scale) per second; scale: the zoom;
  // slide: view heights per second across the screen; pan: -1 (left edge) .. 1 (right edge)
  motion(turn, zoomRate, scale, slide, pan) {
    if (!this.ctx || !this.air) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, turn / 5);
    this.air.gain.setTargetAtTime(0.2 * Math.pow(s, 0.9), t, 0.05);
    this.airBp.frequency.setTargetAtTime(400 + 2100 * s, t, 0.06);
    this.servo.gain.setTargetAtTime(0.03 * s, t, 0.06);
    this.servoOsc.frequency.setTargetAtTime(70 + 120 * s, t, 0.08);
    const z = Math.min(1, Math.abs(zoomRate) / 1.5);
    const f = 260 * Math.pow(Math.max(0.1, scale), 0.6);
    this.zoom.gain.setTargetAtTime(0.045 * z, t, 0.05);
    this.zoomOsc[0].frequency.setTargetAtTime(f, t, 0.05);
    this.zoomOsc[1].frequency.setTargetAtTime(f * 1.5, t, 0.05);
    this.zoomAir.gain.setTargetAtTime(0.12 * z, t, 0.05);
    this.zoomBp.frequency.setTargetAtTime(f * 8, t, 0.05);
    const m = Math.min(1, slide / 2);
    this.slide.gain.setTargetAtTime(0.16 * m, t, 0.05);
    if (this.slidePan) this.slidePan.pan.setTargetAtTime(Math.max(-0.7, Math.min(0.7, pan)), t, 0.08);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.42, this.ctx.currentTime, 0.05);
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  env(node, t0, a, peak, dur) {
    const g = node.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + a);
    g.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  tone(type, f0, f1, dur, peak, delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    this.env(g, t, 0.006, peak, dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  noiseBurst(type, f0, f1, q, dur, peak, delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    this.env(g, t, Math.min(0.03, dur * 0.25), peak, dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  grab() {
    this.tone('sine', 190, 120, 0.09, 0.22);
    this.noiseBurst('bandpass', 5200, 3800, 6, 0.035, 0.12);
  }

  catch() {
    this.tone('sine', 240, 140, 0.08, 0.22);
    this.noiseBurst('bandpass', 6000, 4000, 6, 0.03, 0.12);
    this.noiseBurst('bandpass', 5000, 3500, 6, 0.03, 0.1, 0.06);
  }

  release(speed) {
    const s = Math.min(1, speed / 6);
    if (s < 0.03) {
      this.tone('sine', 150, 110, 0.06, 0.1);
      return;
    }
    this.noiseBurst('bandpass', 700 + 1800 * s, 260, 1.4, 0.25 + 0.35 * s, 0.12 + 0.25 * s);
  }

  mode() {
    this.tone('sine', 420, 980, 0.22, 0.08);
    this.noiseBurst('bandpass', 2600, 500, 3, 0.9, 0.05);
  }

  explode(out) {
    this.tone('sawtooth', out ? 70 : 140, out ? 150 : 65, 0.42, 0.05);
    this.noiseBurst('lowpass', out ? 600 : 1400, out ? 1800 : 400, 0.8, 0.45, 0.07);
  }

  boot() {
    this.tone('sine', 90, 360, 1.1, 0.07);
    this.noiseBurst('bandpass', 400, 3200, 2, 1.3, 0.04);
  }

  // amount: how far apart the parts are (0..1); rate: how fast they are moving (per second)
  stretch(amount, rate) {
    if (!this.ctx || !this.whir) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, Math.abs(rate) / 2.5);
    this.whir.gain.setTargetAtTime(s * 0.09, t, 0.05);
    this.whirBp.frequency.setTargetAtTime(260 + 900 * Math.min(1, Math.max(0, amount)), t, 0.06);
  }

  spin(speed) {
    if (!this.ctx || !this.hum) return;
    const s = Math.min(1, speed / 7);
    const t = this.ctx.currentTime;
    this.hum.gain.setTargetAtTime(s * 0.08, t, 0.08);
    this.humOsc[0].frequency.setTargetAtTime(50 + 40 * s, t, 0.1);
    this.humOsc[1].frequency.setTargetAtTime(100 + 80 * s, t, 0.1);
    this.humLp.frequency.setTargetAtTime(300 + 900 * s, t, 0.1);
  }
}
