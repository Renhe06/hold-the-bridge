// ============================================================
//  WebAudio 程序化音效合成器（零音频素材）
//
//  iOS 限制：AudioContext 必须在用户手势里创建/resume，
//  所以 unlock() 只在第一次 touchstart / pointerdown 里调用。
// ============================================================

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.muted = false;
    this.ready = false;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch (e) {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.34;
    this.master.connect(this.ctx.destination);
    this.noiseBuf = this._makeNoise(1.2);
    this.ready = true;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.34;
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  _makeNoise(sec) {
    const n = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 时间戳基准，防止 iOS 上 currentTime 起点偏移导致爆音 */
  get t0() {
    return this.ctx.currentTime + 0.001;
  }

  /** 单个振荡器音符，可做频率滑音 */
  tone({ freq = 440, freq2 = null, type = 'sine', dur = 0.15, vol = 0.2, delay = 0, attack = 0.004, bus = null }) {
    if (!this.ready || this.muted) return;
    const c = this.ctx;
    const t = this.t0 + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freq), t);
    if (freq2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(bus || this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** 噪声爆裂，用于命中/脚步/爆炸 */
  burst({ dur = 0.08, vol = 0.2, type = 'bandpass', freq = 1600, q = 1.2, delay = 0, sweepTo = null }) {
    if (!this.ready || this.muted) return;
    const c = this.ctx;
    const t = this.t0 + delay;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // ---------------- 具体音效 ----------------

  shoot(tier = 0) {
    const detune = 1 + (Math.random() - 0.5) * 0.14;
    const base = [660, 720, 820, 940][Math.min(tier, 3)] * detune;
    this.tone({ freq: base, freq2: base * 0.42, type: 'square', dur: 0.07, vol: 0.075 });
    this.burst({ dur: 0.035, vol: 0.05, type: 'highpass', freq: 2400 });
  }

  hit() {
    this.burst({ dur: 0.055, vol: 0.14, type: 'bandpass', freq: 1900, q: 0.9 });
  }

  crit() {
    this.tone({ freq: 1500, freq2: 950, type: 'square', dur: 0.09, vol: 0.11 });
    this.burst({ dur: 0.07, vol: 0.1, type: 'bandpass', freq: 2600, q: 1.4 });
  }

  zombieDie(isBrute = false) {
    const f = isBrute ? 170 : 240;
    this.tone({ freq: f, freq2: f * 0.28, type: 'sawtooth', dur: isBrute ? 0.4 : 0.26, vol: isBrute ? 0.15 : 0.1 });
    this.burst({ dur: 0.2, vol: 0.1, type: 'lowpass', freq: isBrute ? 900 : 1300, sweepTo: 220 });
  }

  bite() {
    this.tone({ freq: 150, freq2: 58, type: 'triangle', dur: 0.3, vol: 0.3 });
    this.burst({ dur: 0.22, vol: 0.2, type: 'lowpass', freq: 700, sweepTo: 140 });
  }

  pickup() {
    this.tone({ freq: 880, type: 'sine', dur: 0.1, vol: 0.16 });
    this.tone({ freq: 1320, type: 'sine', dur: 0.14, vol: 0.13, delay: 0.08 });
  }

  upgrade() {
    // C5 - E5 - G5 - C6
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this.tone({ freq: f, type: 'triangle', dur: 0.22, vol: 0.14, delay: i * 0.075 }));
  }

  waveStart(n = 1) {
    const base = 330 + Math.min(n, 8) * 12;
    this.tone({ freq: base, type: 'triangle', dur: 0.16, vol: 0.15 });
    this.tone({ freq: base * 1.5, type: 'triangle', dur: 0.24, vol: 0.14, delay: 0.13 });
  }

  bossSpawn() {
    this.tone({ freq: 120, freq2: 48, type: 'sawtooth', dur: 1.1, vol: 0.3 });
    this.tone({ freq: 90, freq2: 40, type: 'square', dur: 1.2, vol: 0.12, delay: 0.06 });
    this.burst({ dur: 0.9, vol: 0.16, type: 'lowpass', freq: 420, sweepTo: 90 });
  }

  bomb() {
    this.tone({ freq: 200, freq2: 40, type: 'sawtooth', dur: 0.55, vol: 0.28 });
    this.burst({ dur: 0.5, vol: 0.26, type: 'lowpass', freq: 1400, sweepTo: 120 });
  }

  gameOver() {
    const notes = [440, 349.23, 261.63, 174.61];
    notes.forEach((f, i) => {
      this.tone({ freq: f, type: 'sawtooth', dur: 0.5, vol: 0.16, delay: i * 0.19 });
      this.tone({ freq: f / 2, type: 'triangle', dur: 0.6, vol: 0.08, delay: i * 0.19 });
    });
  }

  uiClick() {
    this.tone({ freq: 620, freq2: 880, type: 'square', dur: 0.06, vol: 0.09 });
  }

  // ---------------- v3 新增（打击感 / 新玩法）----------------

  /** 吐酸者喷吐：湿滑的向上滑音 */
  spit() {
    this.tone({ freq: 300, freq2: 720, type: 'sawtooth', dur: 0.16, vol: 0.075 });
    this.burst({ dur: 0.14, vol: 0.07, type: 'bandpass', freq: 900, q: 2.2, sweepTo: 2100 });
  }

  /** 破盾：金属碎裂 */
  shieldBreak() {
    this.tone({ freq: 2400, freq2: 700, type: 'square', dur: 0.12, vol: 0.1 });
    this.burst({ dur: 0.16, vol: 0.13, type: 'highpass', freq: 2600 });
  }

  /** 连杀升级：音高随连杀数往上爬，越连越亢奋 */
  combo(n) {
    const step = Math.min(n, 12);
    const f = 520 * Math.pow(1.0595, step * 2); // 每级两个半音
    this.tone({ freq: f, type: 'triangle', dur: 0.1, vol: 0.11 });
    this.tone({ freq: f * 1.5, type: 'sine', dur: 0.14, vol: 0.07, delay: 0.05 });
  }

  /** 空袭充能完毕 */
  chargeReady() {
    this.tone({ freq: 660, type: 'triangle', dur: 0.12, vol: 0.15 });
    this.tone({ freq: 990, type: 'triangle', dur: 0.16, vol: 0.13, delay: 0.1 });
    this.tone({ freq: 1320, type: 'triangle', dur: 0.22, vol: 0.12, delay: 0.2 });
  }

  /** 空袭：呼叫 + 一串落地炸响 */
  strike() {
    this.tone({ freq: 190, freq2: 60, type: 'sawtooth', dur: 0.9, vol: 0.22 });
    this.burst({ dur: 0.7, vol: 0.2, type: 'lowpass', freq: 1200, sweepTo: 90 });
    for (let i = 0; i < 6; i++) {
      const d = 0.25 + i * 0.13;
      this.tone({ freq: 150 + (i % 2) * 40, freq2: 36, type: 'sawtooth', dur: 0.42, vol: 0.24, delay: d });
      this.burst({ dur: 0.36, vol: 0.22, type: 'lowpass', freq: 1500, sweepTo: 110, delay: d });
    }
  }
}
