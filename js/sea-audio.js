// ---------------------------------------------------------------------------
//  第五关 · 上篇「跃」—— 水下声场
//
//  为什么这一篇要先做声音、再做画面：
//    画面可以靠光雾遮丑，声音遮不了。水下的"空间感"几乎全靠两件事 ——
//    卷积混响的长尾（声速 1500m/s，比空气快四倍多，混响又长又密）和
//    深度低通（高频在水里衰减极快）。这两件没做对，玩家立刻觉得"在浴室里"。
//
//  更关键的是：这一篇玩家唯一的主动行为就是"发声"。
//  所以声音不是配乐，是雷达 —— 回声返回的**延时就是距离**，越远越晚、越闷、越轻。
//  玩家靠听判断前面有没有东西，画面只负责把它画出来。
//
//  三条硬约束（沿用 js/audio.js 踩过的坑）：
//    1) 绝不 new 第二个 AudioContext。一个页面只许 6 个，主游戏已经占了一个；
//       这里复用 snd.ctx 和 snd.master，静音键、iOS 会话自愈、切后台恢复全部一起生效。
//    2) 不用 Math.random。冒烟测试把全局随机数换成定种流给游戏逻辑用，
//       音效去抽签会把那条流冲掉，跑分立刻不可复现。自己开一条 LCG。
//    3) 不挂 setInterval。所有稀疏事件由渲染循环的 update(dt) 驱动，页面一停就停。
// ---------------------------------------------------------------------------

import { clamp, lerp } from './util.js';

// 频段在对数上插值才符合听感：线性插值会让"潜到 10%"听起来像已经潜了 40%。

const logLerp = (a, b, t) => Math.exp(lerp(Math.log(a), Math.log(b), clamp(t, 0, 1)));

/** 七个音 = 七次回应。A 小调，第四音是那个"本该在却一直缺着"的半音。 */
const THEME = [
  [110.00, 0.00], [146.83, 0.62], [155.56, 1.28], [164.81, 1.90],
  [196.00, 2.60], [220.00, 3.30], [261.63, 4.00],
];

export class SeaAudio {
  /** @param sound 主游戏的 Sound 实例（见 js/audio.js），只借用它的 ctx / master */
  constructor(sound) {
    this.snd = sound;
    this.ready = false;
    this.ctx = null;

    this.depth = 0;      // 0 = 海面，1 = 深渊
    this.oxygen = 1;     // 1 = 满，0 = 见底
    // 已经找回来的声部数（1~7）。开局只有一个音 ——
    // 「我深情地唱着听不见的歌」：那不是合唱，是一个人。
    // 六只同类，每回应一只多一个音，最后凑成七个。
    this.voices = 1;
    this.muted = false;

    this._t = 0;         // 事件计时（秒）
    this._next = 2.6;    // 下一次环境事件
    this._hb = 0;        // 心跳计时
    this._seed = 0x9e3779b9;

    // 诊断：无头环境里看不到波形，只能靠计数确认节点真的建出来了
    this.diag = { calls: 0, echoes: 0, returns: 0, events: 0, voices: 0, nodes: 0 };

    // 真实录音。海浪、海鸥、破水这三样合成不出来 ——
    // 合成海浪永远是"白噪声过一遍滤波"，海鸥更是完全没法用正弦拼。
    // 按需加载，不占首屏。
    this.buf = {};
    this.surfLoop = null;
    this.sndLoaded = false;
  }

  // 自己的一条随机流，别去碰游戏那条
  _rnd() {
    this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
    return this._seed / 4294967296;
  }

  /**
   * 载入真实录音。失败就静默退回合成音 —— 这一关可以没有录音，不能没有声音。
   */
  async loadSamples(base = '../audio/sea/') {
    if (!this.ctx) return false;
    const grab = async (name) => {
      try {
        const r = await fetch(base + name);
        if (!r.ok) return null;
        const ab = await r.arrayBuffer();
        return await this.ctx.decodeAudioData(ab);
      } catch (_) {
        return null;
      }
    };
    const [waves, splash] = await Promise.all([grab('waves-birds.mp3'), grab('sea-swim.mp3')]);
    if (waves) this.buf.waves = waves;
    if (splash) this.buf.splash = splash;
    this.sndLoaded = true;
    return !!(waves || splash);
  }

  /** 播放一段已加载的录音。没有素材就返回 null，调用方自己决定要不要退回合成。 */
  _playBuf(name, { vol = 0.3, rate = 1, pan = 0, loop = false, offset = 0, dur = 0, filter = 0 } = {}) {
    if (!this.ready || this.muted) return null;
    const b = this.buf[name];
    if (!b) return null;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = b;
    src.loop = loop;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = vol;
    let node = src;
    if (filter > 0) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      src.connect(f);
      node = f;
    }
    node.connect(g);
    this._out(g, pan);
    const t = c.currentTime;
    const off = clamp(offset, 0, Math.max(0, b.duration - 0.05));
    try {
      if (dur > 0) src.start(t, off, Math.min(dur, b.duration - off));
      else src.start(t, off);
    } catch (_) {
      return null;
    }
    this.diag.nodes += 2;
    return src;
  }

  /**
   * 常驻的海面环境：真实海浪 + 海鸥，循环。
   * 它挂在 depthFilter 后面 —— 潜得越深，头顶那片海越闷、越远。
   */
  startSurfaceBed() {
    if (!this.ready || this.surfLoop || !this.buf.waves) return false;
    const c = this.ctx;
    const b = this.buf.waves;
    const src = c.createBufferSource();
    src.buffer = b;
    src.loop = true;
    const g = c.createGain();
    g.gain.value = 0.10;
    src.connect(g);
    const p = this._panner(0);
    if (p) {
      g.connect(p);
      p.connect(this.depthFilter);
    } else {
      g.connect(this.depthFilter);
    }
    src.start(0, this._rnd() * b.duration);
    this.surfLoop = { src, gain: g };
    this.diag.nodes += 3;
    return true;
  }

  // ---------------------------------------------------------
  //  搭图
  // ---------------------------------------------------------

  /**
   * 必须在用户手势里调（iOS 的规矩，主游戏 Sound 已经处理过一次手势窗口）。
   * 返回是否建成；建不成（ctx 还没醒）就等下一次手势再来。
   */
  init() {
    if (this.ready) return true;
    const s = this.snd;
    if (!s || !s.ready || !s.ctx) return false;
    const c = s.ctx;

    this.ctx = c;

    // 总出口 → 主游戏的 master（静音键因此对整篇有效）
    this.out = c.createGain();
    this.out.gain.value = 0.85;
    // 混响叠多路会顶到削波，压一下比事后一处处调音量稳
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.22;
    this.out.connect(this.comp);
    this.comp.connect(s.master);

    this.in = c.createGain();
    this.in.gain.value = 1;

    // 深度低通：所有声音都要先过它，包括混响的输入。
    // 放的位置很重要 —— 放混响之后就只是"闷"，放在之前才是"水里的闷"。
    this.depthFilter = c.createBiquadFilter();
    this.depthFilter.type = 'lowpass';
    this.depthFilter.frequency.value = 16000;
    this.depthFilter.Q.value = 0.35;

    this.dry = c.createGain();
    this.dry.gain.value = 0.82;
    this.wet = c.createGain();
    this.wet.gain.value = 0.2;

    this.conv = c.createConvolver();
    this.conv.normalize = true;
    this.conv.buffer = this._makeIR(3.4, 3.0);

    this.in.connect(this.depthFilter);
    this.depthFilter.connect(this.dry);
    this.dry.connect(this.out);
    this.depthFilter.connect(this.conv);
    this.conv.connect(this.wet);
    this.wet.connect(this.out);

    this.diag.nodes = 5;

    this._startBed();
    this.ready = true;
    this.setDepth(this.depth, true);
    return true;
  }

  /**
   * 水下混响的脉冲响应：滤波噪声 + 指数衰减。
   * 关键在于**先低通再衰减** —— 直接拿白噪声衰减，尾音会"嘶"一下，
   * 听感立刻变成空房间而不是水。这是这一篇最容易做错的地方。
   */
  _makeIR(sec, decay) {
    const c = this.ctx;
    const n = Math.floor(c.sampleRate * sec);
    const buf = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      const k = ch ? 0.78 : 0.74;
      // 早期反射：两三个离散回声，给"这片空间里有东西"的暗示。
      // 完全光滑的混响听起来像真空，真实水体总有岩壁、船体、冰盖。
      const er = [
        [Math.floor(c.sampleRate * 0.031), 0.5],
        [Math.floor(c.sampleRate * 0.067), 0.33],
        [Math.floor(c.sampleRate * 0.118), 0.22],
      ];
      for (let i = 0; i < n; i++) {
        const t = i / n;
        lp = lp * k + (this._rnd() * 2 - 1) * (1 - k);
        d[i] = lp * Math.pow(1 - t, decay);
      }
      for (const [off, amp] of er) {
        const i = off + (ch ? 137 : 0);
        if (i < n) d[i] += amp * (ch ? -1 : 1);
      }
    }
    return buf;
  }

  _makeNoise(sec) {
    const c = this.ctx;
    const n = Math.floor(c.sampleRate * sec);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = this._rnd() * 2 - 1;
    return buf;
  }

  /** 常驻环境床：低频涌动 + 水流噪声。这两层不需要"播放"，建好就一直在。 */
  _startBed() {
    const c = this.ctx;

    // 1) 低频涌动：三个微失谐的正弦，听不出音高，只感觉"水压在身上"
    this.drone = c.createGain();
    this.drone.gain.value = 0.026;
    this.droneFilter = c.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 180;
    this.droneFilter.Q.value = 0.5;
    this.droneFilter.connect(this.drone);
    this.drone.connect(this.in);

    // 只留 41.2 与它自己的八度：61.7 和 41.2 差 20.5Hz，会产生拍频，
    // 听感就是持续的"咚咚咚"——那不是水压，是两只正弦在打架。
    for (const [f, g] of [[41.2, 0.5], [82.4, 0.1]]) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const gg = c.createGain();
      gg.gain.value = g;
      o.connect(gg);
      gg.connect(this.droneFilter);
      o.start();
    }

    // 2) 水流：循环噪声 + 极慢的带通摆动（0.07Hz，比呼吸还慢）
    const src = c.createBufferSource();
    src.buffer = this._makeNoise(2.6);
    src.loop = true;
    this.flowFilter = c.createBiquadFilter();
    this.flowFilter.type = 'bandpass';
    this.flowFilter.frequency.value = 760;
    this.flowFilter.Q.value = 0.55;
    const fg = c.createGain();
    fg.gain.value = 0.042;
    const lfo = c.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lg = c.createGain();
    lg.gain.value = 0.016;
    lfo.connect(lg);
    lg.connect(fg.gain);
    src.connect(this.flowFilter);
    this.flowFilter.connect(fg);
    fg.connect(this.in);
    src.start();
    lfo.start();

    this.diag.nodes += 4;
  }

  // ---------------------------------------------------------
  //  深度
  // ---------------------------------------------------------

  setDepth(d, instant = false) {
    this.depth = clamp(d, 0, 1);
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    // 18kHz → 420Hz：潜到最深处，连自己的鲸歌都听不清了 —— 这是刻意的
    const f = logLerp(18000, 420, this.depth);
    const wetv = lerp(0.16, 0.66, this.depth);
    const r = instant ? 'setValueAtTime' : 'setTargetAtTime';
    const tc = instant ? undefined : 0.32;
    this.depthFilter.frequency[r](f, now, ...(instant ? [] : [tc]));
    this.wet.gain[r](wetv, now, ...(instant ? [] : [0.36]));
    this.droneFilter.frequency[r](lerp(210, 78, this.depth), now, ...(instant ? [] : [0.4]));
    this.flowFilter.frequency[r](lerp(980, 240, this.depth), now, ...(instant ? [] : [0.4]));
    this.drone.gain[r](lerp(0.024, 0.048, this.depth), now, ...(instant ? [] : [0.5]));
    // 头顶那片海：越深越远。这是玩家判断"自己离呼吸还有多远"的听觉标尺。
    if (this.surfLoop) {
      this.surfLoop.gain.gain.setTargetAtTime(lerp(0.10, 0.010, this.depth), now, 0.5);
    }
  }

  // ---------------------------------------------------------
  //  基础发声（带声像，走自己的总线）
  // ---------------------------------------------------------

  _panner(pan) {
    const c = this.ctx;
    if (!c.createStereoPanner) return null;
    const p = c.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }

  _out(node, pan) {
    const p = this._panner(pan);
    if (p) {
      node.connect(p);
      p.connect(this.in);
    } else {
      node.connect(this.in);
    }
  }

  _tone({ freq, freq2 = null, type = 'sine', dur = 0.2, vol = 0.2, delay = 0, attack = 0.01, pan = 0 }) {
    const c = this.ctx;
    const t = c.currentTime + 0.012 + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, freq), t);
    if (freq2) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this._out(g, pan);
    o.start(t);
    o.stop(t + dur + 0.03);
    this.diag.voices++;
    return o;
  }

  _burst({ dur = 0.08, vol = 0.12, type = 'bandpass', freq = 1400, q = 1.0, delay = 0, sweepTo = null, pan = 0 }) {
    const c = this.ctx;
    const t = c.currentTime + 0.012 + delay;
    const src = c.createBufferSource();
    src.buffer = this.snd.noiseBuf || this._makeNoise(1.2);
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
    this._out(g, pan);
    src.start(t);
    src.stop(t + dur + 0.03);
    this.diag.voices++;
  }

  // ---------------------------------------------------------
  //  鲸歌
  // ---------------------------------------------------------

  /**
   * 座头鲸的一句歌。
   * 不是"哔"一声：真实的鲸歌是缓慢上滑 → 顶点 → 下滑收尾的长句，
   * 再叠两三个谐波才有一点"体积"。单正弦听着像手机提示音，这是最常犯的错。
   *
   * @param base  基频（远处听到的是低的，近处的同类可以高一些）
   * @param reach 0~1，"够到多高"。0.0 时顶点只到 1.55 倍 —— 永远差一点。
   */
  call({ pan = 0, base = 168, dur = 2.0, vol = 0.14, reach = 1 } = {}) {
    if (!this.ready || this.muted) return;
    const c = this.ctx;
    const t = c.currentTime + 0.02 + this._rnd() * 0.05;
    const p = this._panner(pan);

    const peak = base * (1.5 + reach * 0.42);
    const tail = base * (1.02 + this._rnd() * 0.08);

    const harm = [[1, 1], [2, 0.34], [3, 0.13]];
    const stopAt = t + dur + 0.08;
    const master = c.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.55, dur * 0.3));
    master.gain.exponentialRampToValueAtTime(vol * 0.82, t + dur * 0.62);
    master.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    master.connect(p || this.in);
    if (p) p.connect(this.in);

    for (const [mul, amp] of harm) {
      const o = c.createOscillator();
      o.type = mul === 1 ? 'sine' : 'triangle';
      o.frequency.setValueAtTime(base * mul, t);
      o.frequency.exponentialRampToValueAtTime(peak * mul, t + dur * 0.52);
      o.frequency.exponentialRampToValueAtTime(tail * mul, t + dur);
      // 颤音很慢很浅：快了就变电子音
      const lfo = c.createOscillator();
      lfo.frequency.value = 4.2 + this._rnd() * 1.4;
      const lg = c.createGain();
      lg.gain.value = 4 + this._rnd() * 3;
      lfo.connect(lg);
      lg.connect(o.detune);
      const g = c.createGain();
      g.gain.value = amp;
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(stopAt);
      lfo.start(t);
      lfo.stop(stopAt);
    }
    this.diag.calls++;
    this.diag.voices += 3;
  }

  // ---------------------------------------------------------
  //  发声 / 回声（玩家的唯一动作）
  // ---------------------------------------------------------

  /**
   * 玩家发声。
   * 必须像"喊"，不能像"扫描" —— 所以基频是往下掉的，像一句话的尾音，
   * 而不是雷达那种上扬的 ping。它什么都推不开，只是把空间照亮一秒。
   */
  echo({ pan = 0 } = {}) {
    if (!this.ready || this.muted) return;
    const c = this.ctx;
    const t = c.currentTime + 0.012;
    // 嘴边的气声
    this._burst({ dur: 0.055, vol: 0.1, type: 'highpass', freq: 2600, pan });
    // 主体：300 → 128Hz，尾音下沉
    const o = this._tone({ freq: 300, freq2: 128, type: 'sine', dur: 0.62, vol: 0.2, pan, attack: 0.02 });
    // 第二谐波让"喊"有喉咙感
    this._tone({ freq: 600, freq2: 256, type: 'triangle', dur: 0.5, vol: 0.07, pan, attack: 0.02 });
    // 水下的第一次反射
    this._tone({ freq: 300, freq2: 128, type: 'sine', dur: 0.58, vol: 0.075, delay: 0.19, pan: -pan * 0.6 });
    this.diag.echoes++;
    // 在管风琴管里加一个缓慢的滤波扫动，模拟"声音撞到东西又回来"
    if (o) {
      try {
        const f = c.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(900, t);
        f.frequency.exponentialRampToValueAtTime(320, t + 0.7);
        f.Q.value = 1.2;
        // 只是建立节点，实际增益很小，主要给"声源在移动"的错觉
        f.connect(this.in);
      } catch (_) {}
    }
  }

  /**
   * 回声碰到东西返回来那一下。
   * delay 就是距离：越远越晚、越闷、越轻。这是玩家判断"前面有没有东西"的唯一依据，
   * 也是这一篇最像"仪器"的地方 —— 但它听起来必须还是个声音，不是滴滴声。
   */
  returnPing({ delay = 0.3, pan = 0, hard = 0.5 } = {}) {
    if (!this.ready || this.muted) return;
    const v = 0.11 * clamp(hard, 0, 1);
    const f = lerp(520, 190, clamp(delay / 1.2, 0, 1));
    this._tone({ freq: f, freq2: f * 0.72, type: 'sine', dur: 0.42, vol: v, delay, pan, attack: 0.006 });
    this._burst({ dur: 0.09, vol: v * 0.5, type: 'bandpass', freq: f * 2.2, q: 1.6, delay, pan });
    this.diag.returns++;
  }

  // ---------------------------------------------------------
  //  环境事件（由 update 驱动，不挂定时器）
  // ---------------------------------------------------------

  /** 气泡：短促上扬，越多说明越浅（深处没有气泡） */
  bubbles(n = 3) {
    if (!this.ready || this.muted) return;
    for (let i = 0; i < n; i++) {
      const f = 240 + this._rnd() * 420;
      this._tone({
        freq: f,
        freq2: f * 2.6,
        type: 'sine',
        dur: 0.05 + this._rnd() * 0.05,
        vol: 0.03 + this._rnd() * 0.03,
        delay: i * (0.05 + this._rnd() * 0.12),
        pan: (this._rnd() * 2 - 1) * 0.7,
        attack: 0.004,
      });
    }
    this.diag.events++;
  }

  /** 沉船的金属呻吟：锯齿波慢滑 + 长混响，是深处唯一"不是水"的声音 */
  hull() {
    if (!this.ready || this.muted) return;
    const base = 62 + this._rnd() * 26;
    this._tone({ freq: base, freq2: base * 1.16, type: 'sawtooth', dur: 1.9, vol: 0.055, attack: 0.4, pan: (this._rnd() * 2 - 1) * 0.5 });
    this._tone({ freq: base * 2.7, freq2: base * 2.2, type: 'triangle', dur: 1.5, vol: 0.022, attack: 0.35 });
    this.diag.events++;
  }

  /** 海面：只有接近水面才听得到的碎浪 */
  surface() {
    if (!this.ready || this.muted) return;
    // 真实录音优先：从 38 秒的海浪里随机抠一段，每次都不一样。
    // 合成的碎浪只能是"噪声过带通"，听两次就露馅。
    const b = this.buf.waves;
    if (b) {
      this._playBuf('waves', {
        vol: 0.20,
        rate: 0.94 + this._rnd() * 0.12,
        pan: (this._rnd() * 2 - 1) * 0.55,
        offset: this._rnd() * Math.max(0.5, b.duration - 3),
        dur: 2.4,
      });
      this.diag.events++;
      return;
    }
    this._burst({ dur: 1.5, vol: 0.035, type: 'bandpass', freq: 1100, q: 0.4, sweepTo: 520, pan: (this._rnd() * 2 - 1) * 0.4 });
    this.diag.events++;
  }

  /** 心跳：氧气见底时唯一还规律的鼓点 */
  heartbeat() {
    if (!this.ready || this.muted) return;
    const v = 0.085;
    this._tone({ freq: 58, freq2: 40, type: 'sine', dur: 0.2, vol: v, attack: 0.008 });
    this._tone({ freq: 52, freq2: 36, type: 'sine', dur: 0.24, vol: v * 0.7, delay: 0.19, attack: 0.01 });
    this.diag.events++;
  }

  /** 换气：跃出海面那一下 */
  breath() {
    if (!this.ready || this.muted) return;
    // 破水必须是真水：合成的"哗"永远像有人在旁边撕纸
    const b = this.buf.splash;
    if (b) {
      this._playBuf('splash', {
        vol: 0.34,
        rate: 0.9 + this._rnd() * 0.2,
        pan: (this._rnd() * 2 - 1) * 0.3,
        offset: this._rnd() * Math.max(0.3, b.duration - 1.6),
        dur: 1.25,
      });
      this.diag.events++;
      return;
    }
    this._burst({ dur: 0.7, vol: 0.13, type: 'bandpass', freq: 700, q: 0.5, sweepTo: 2600 });
    this._burst({ dur: 0.5, vol: 0.08, type: 'highpass', freq: 2200, delay: 0.1 });
    this.diag.events++;
  }

  /**
   * 声呐。不是警报 —— 是机器在找东西。
   * 1200Hz 短促一下、尾巴拖半秒，再补一声；冷、准、不带情绪。
   * 合成比采样更对：真实的军用声呐就是这种近乎纯音的脉冲。
   */
  sonar({ pan = 0 } = {}) {
    if (!this.ready || this.muted) return;
    const c = this.ctx;
    const t0 = c.currentTime + 0.01;
    const ping = (at, vol) => {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(1240, at);
      o.frequency.exponentialRampToValueAtTime(880, at + 0.22);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.6);
      o.connect(g);
      this._out(g, pan);
      o.start(at);
      o.stop(at + 0.66);
    };
    ping(t0, 0.13);
    ping(t0 + 0.92, 0.055);
    this.diag.events += 2;
  }

  /**
   * 「跃」的三音动机。
   * 三个音往上走，但第三个永远差半个音够不到 —— 这是整篇的音乐签名。
   * 全篇只出现几次，不要当 BGM 循环：它是"记得"的东西，不是"背景"。
   */
  /**
   * 这首歌一共七个音。开局只有三个，而且缺最后一个 ——
   * 「我深情地唱着听不见的歌」：它本来就不完整。
   *
   * 每回应一只同类，多一个音。玩家不需要看进度条：他直接听见歌变长。
   * 这是整局唯一的"变强"，也是唯一值得往下游的东西。
   */
  motif({ pan = 0, vol = 0.075 } = {}) {
    if (!this.ready || this.muted) return;
    const n = clamp(this.voices | 0, 1, THEME.length);
    for (let i = 0; i < n; i++) {
      const [f, d] = THEME[i];
      const a = vol * (i === n - 1 ? 1 : 0.78);   // 最新那个音略突出
      this._tone({ freq: f, type: 'sine', dur: 1.5, vol: a, delay: d, attack: 0.12, pan });
      this._tone({ freq: f * 2, type: 'triangle', dur: 1.1, vol: a * 0.22, delay: d, attack: 0.1, pan });
    }
    this.diag.events++;
  }

  /** 找回来一只：歌多一个音。返回新的声部数。 */
  addVoice() {
    this.voices = Math.min(THEME.length, (this.voices | 0) + 1);
    return this.voices;
  }

  _fireEvent() {
    const d = this.depth;
    const r = this._rnd();
    // 用户实拍反馈："背景里那个'呜'的声音太频繁了"。
    // 上一版 9~18 秒一次、深处 36% 是鲸歌（call 三秒长句 + 长混响），
    // 实际听感是"每隔几秒就有一只鲸在叹口气"—— 环境音一旦有了节奏，
    // 它就从"海"变成"配乐"，而配乐会抢台词的戏。
    // 现在：间隔拉到 13~26 秒，鲸歌概率砍到 14%/22%，音量再降三成。
    // 深处（>0.6）仍然保留更多鲸歌 —— 那是同类的地盘，不该安静得死掉。
    if (d < 0.25) {
      if (r < 0.42) this.surface();
      else this.bubbles(2 + ((this._rnd() * 3) | 0));
    } else if (d < 0.6) {
      if (r < 0.52) this.bubbles(1 + ((this._rnd() * 3) | 0));
      else if (r < 0.86) this.hull();
      else this.call({ pan: (this._rnd() * 2 - 1) * 0.85, base: 120 + this._rnd() * 40, dur: 2.6, vol: 0.030, reach: 0.45 });
    } else {
      if (r < 0.60) this.hull();
      else if (r < 0.88) this.call({ pan: (this._rnd() * 2 - 1) * 0.9, base: 92 + this._rnd() * 24, dur: 3.2, vol: 0.024, reach: 0.3 });
      else this.motif({ pan: (this._rnd() * 2 - 1) * 0.5, vol: 0.042 });
    }
  }

  // ---------------------------------------------------------
  //  每帧驱动
  // ---------------------------------------------------------

  /**
   * @param dt   秒
   * @param st   { depth, oxygen }
   */
  update(dt, st = {}) {
    if (!this.ready) return;
    if (typeof st.depth === 'number') this.setDepth(st.depth);
    if (typeof st.oxygen === 'number') this.oxygen = st.oxygen;

    // 氧气见底 → 心跳加速。这是整篇唯一"催你"的声音，
    // 而且它不是警报，是你自己的身体。
    if (this.oxygen < 0.22) {
      this._hb -= dt;
      if (this._hb <= 0) {
        this.heartbeat();
        const k = clamp(this.oxygen / 0.22, 0, 1);
        this._hb = lerp(1.5, 2.4, k);
      }
    } else {
      this._hb = 0;
    }

    this._t += dt;
    if (this._t >= this._next) {
      this._t = 0;
      this._next = lerp(13, 26, this._rnd());
      this._fireEvent();
    }
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.out) this.out.gain.value = m ? 0 : 0.85;
  }

  /** 离场：停掉常驻床，别让噪声源在后台耗电 */
  stop() {
    if (!this.ready) return;
    try {
      this.out.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.3);
    } catch (_) {}
    this.ready = false;
  }
}
