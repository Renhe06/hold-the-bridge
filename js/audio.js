// ============================================================
//  WebAudio 程序化音效合成器（零音频素材）
//
//  iOS 限制：AudioContext 必须在用户手势里创建/resume。
//  【用户 m04749】"频繁出现没有声音"的复现描述是"随机、没规律、有时刚进来就静音"，
//  所以这里不再只在画布 pointerdown 上解锁，改成：
//    1) 任何一次用户手势（pointerdown / touchstart / touchend / click / keydown）
//       都叫一次 unlock —— iOS 历来只认 touchend/click 那类"完成态"手势，
//       只挂 pointerdown 的话首局经常会碰上一个"建好了但一直 suspended"的上下文；
//    2) 回到前台 / pageshow / focus / RAF 每秒兜一次 wake()；
//    3) 上下文被系统打断后"叫不醒"超过 2.5 秒就整个重建一次（见 _watchStuck）；
//    4) diag 记数，出问题时能一眼看出是"没建起来"还是"被挂起"还是"被静音"。
// ============================================================

const nowMs = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.muted = false;
    this.ready = false;
    this._sessionHooked = false;
    this._seed = 0x9e3779b9; // 音效自己的随机数种子（见 _rnd）
    // 【用户 m04749】自愈用的簿记：出问题时 diag 能还原"到底卡在哪一步"
    this.diag = { wakes: 0, resumes: 0, rebuilds: 0, gestures: 0, lastPlay: 0, plays: 0 };
    this._stuckSince = 0;
    this._rebuildAt = 0;
    this._gesturesHooked = false;
    // 【用户 m10795】"切回来没声，点屏幕也不恢复，只有刷新才好" 的两个开关：
    //   _inGesture  —— 当前这次调用是不是发生在用户手势里（重建只在手势里做）
    //   _needRebuild—— 已经判定这个上下文叫不醒了，等下一次手势把它整个换掉
    this._inGesture = false;
    this._needRebuild = false;
    this._createCount = 0;
    this._deadReason = '';
    this._hookGestures();
  }

  /**
   * 【用户 m04749】把手势/前台事件都挂上。
   * 构造函数里就挂（早于任何 unlock），这样"第一次点击"也不会漏。
   */
  _hookGestures() {
    if (this._gesturesHooked || typeof window === 'undefined') return;
    this._gesturesHooked = true;
    const kick = () => {
      this.diag.gestures++;
      // 手势窗口：只有在这段里允许"重建 AudioContext"（原因见 _rebuild）
      this._inGesture = true;
      try {
        this.unlock();
      } finally {
        this._inGesture = false;
      }
    };
    // pointerdown/touchstart 是"最早"的手势；touchend/click 才是 iOS 认的解锁手势。
    // 两类都收 —— unlock() 幂等，重复调用只是顺手 wake 一下。
    for (const ev of ['pointerdown', 'touchstart', 'touchend', 'click', 'keydown']) {
      try {
        window.addEventListener(ev, kick, { capture: true, passive: true });
      } catch (_) {
        try { window.addEventListener(ev, kick, true); } catch (__) {}
      }
    }
    // 切后台 / 锁屏 / 来电结束后立刻叫醒（不等下一次触摸）
    try {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) this.wake();
        });
      }
      window.addEventListener('pageshow', () => this.wake());
      window.addEventListener('focus', () => this.wake());
    } catch (_) {}
  }

  /**
   * 把音频上下文叫醒。iOS 上 AudioContext 被系统挂起之后，state 有两种可能：
   *   - 'suspended'：切后台 / 锁屏 / 没在用户手势里创建（标准状态）
   *   - 'interrupted'：来电、闹钟、别的 App 抢走音频（WebKit 的私有状态）
   * 老代码只判 'suspended'，所以一旦被打断（最典型：打游戏时来条微信语音/接个电话）
   * 就再也发不出声音，只能刷新页面 —— 用户说的"经常没有声音"就是这个。
   * 现在统一按"只要不是 running 就 resume"处理，什么状态都能自己爬回来。
   */
  wake() {
    const c = this.ctx;
    if (!c) return;
    this.diag.wakes++;
    try {
      if (c.state !== 'running' && typeof c.resume === 'function') {
        this.diag.resumes++;
        const p = c.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (_) {}
    // 真的跑起来就把"连着失败了几次"清零：这是连续失败的预算，不是终身额度
    if (c.state === 'running') {
      this.diag.rebuilds = 0;
      this._deadReason = '';
    }
    this._watchStuck();
  }

  /**
   * 【用户 m04749】"叫不醒的上下文"兜底。
   * WebKit 偶发：AudioContext 被来电/切后台打断后一直停在 suspended，
   * 之后 resume() 永远返回 pending（既不 resolve 也不 reject）——
   * 症状就是玩家说的"一直没声音，退回桌面再进来才好"。
   * 这里盯着：没在跑超过 2.5 秒就整个重建一个（后台里不重建，怕白折腾）。
   */
  _watchStuck() {
    const c = this.ctx;
    if (!c || c.state === 'running' || this.muted) {
      this._stuckSince = 0;
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) return;
    // 已经判定叫不醒、正在等下一次手势：不再计时，也别去建上下文
    if (this._needRebuild) return;
    const t = nowMs();
    if (!this._stuckSince) {
      this._stuckSince = t;
      return;
    }
    // 1.2s 就想办法；原来 2.5s 对玩家来说已经是一整波怪没声音了
    if (t - this._stuckSince < 1200) return;
    if (t - this._rebuildAt < 2000 || this.diag.rebuilds >= 3) return;
    this._rebuildAt = t;
    this._stuckSince = 0;
    this._rebuild();
  }

  /**
   * 丢掉被系统关死/叫不醒的上下文，原地重建一个（不用刷新页面）。
   *
   * 【用户 m10795】"浏览器里切回来没声、点屏幕也不恢复、只有刷新才有声"——
   * 根因是原来允许在**手势之外**重建：
   *   1) iOS：手势外 new AudioContext() 建出来必然 suspended，等于白建；
   *   2) Chrome/Edge：每个页面只允许 6 个 AudioContext，反复重建会把额度烧光，
   *      之后 new 一次抛一次（unlock 里 catch 掉、静默返回）——
   *      于是点屏幕也再建不回来，只能刷新，症状和用户报的一模一样。
   * 现在：判定叫不醒就挂个 _needRebuild，等下一次用户手势再一次性换掉。
   */
  _rebuild() {
    const old = this.ctx;
    if (!this._inGesture) {
      this._needRebuild = true;
      return;
    }
    if (this.diag.rebuilds >= 3) {
      // 连续三次重建都没救回来：别再烧上下文额度了，把话说明白交给玩家
      this._deadReason = 'create';
      return;
    }
    this._needRebuild = false;
    this.diag.rebuilds++;
    try {
      if (old && typeof old.close === 'function') old.close();
    } catch (_) {}
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.ready = false;
    this.unlock();
    if (!this.ctx) this._deadReason = 'create';
  }

  unlock() {
    // 已经判定叫不醒（_needRebuild）→ 这次手势就把它整个换掉，不再尝试 resume
    // 那份"resume 永远 pending"的上下文（WebKit 上再调多少次都没用）。
    if (this._needRebuild) {
      const dead = this.ctx;
      this._needRebuild = false;
      try {
        if (dead && typeof dead.close === 'function') dead.close();
      } catch (_) {}
      this.ctx = null;
      this.master = null;
      this.noiseBuf = null;
      this.ready = false;
    }
    // 上下文被系统关掉（内存吃紧时 WebKit 会这么干）→ 丢掉重来。
    // 不重来的话 ready 一直是 true，却永远不出声，而且再也修不回来。
    if (this.ctx && this.ctx.state === 'closed') {
      this.ctx = null;
      this.master = null;
      this.ready = false;
    }
    if (this.ctx) {
      this.wake();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    // 每个页面能建的 AudioContext 数量有限（Chrome 是 6 个），烧光之后
    // new 一次抛一次。到这里就别再试了，让 status 直接告诉玩家刷新。
    if (this._createCount >= 4) {
      this._deadReason = 'create';
      return;
    }
    try {
      this.ctx = new AC();
      this._createCount++;
      this._deadReason = '';
    } catch (e) {
      this._deadReason = 'create';
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.34;
    this.master.connect(this.ctx.destination);
    this.noiseBuf = this._makeNoise(1.2);
    this.ready = true;
    this._hookSession();
    this.wake();
  }

  /**
   * iOS 16.4+ 的音频会话（navigator.audioSession）。
   * 声明成 'playback' 有两个用：
   *  1) 手机侧边那颗静音拨片拨到静音时，Safari 默认把 WebAudio 一起静掉
   *     （这是"有时候就是没声音"的一大来源），playback 会话才会照常出声；
   *  2) 能收到 statechange，被来电打断结束时第一时间自己恢复。
   */
  _hookSession() {
    if (this._sessionHooked) return;
    try {
      const s = navigator.audioSession;
      if (!s) return;
      if (typeof s.addEventListener === 'function') {
        this._sessionHooked = true;
        s.addEventListener('statechange', () => {
          // 'interrupted' 是"现在被抢着"，等它变成别的再醒过来
          if (s.state !== 'interrupted') this.wake();
        });
      }
      s.type = 'playback';
    } catch (_) {}
  }

  /** 音频到底出没出声：给暂停面板上那行自检用（见 status） */
  get running() {
    return !!(this.ctx && this.ctx.state === 'running' && !this.muted);
  }

  /**
   * 给玩家看的自检结果。用户说"经常没声音"，而 iOS 上没声音的原因有好几种
   * （静音拨片 / 切后台被挂起 / 被来电打断 / 自己点过静音 / 上下文被关），
   * 光靠猜查不出来，索性把状态直接摆到暂停面板上。
   */
  get status() {
    if (this.muted) return '已静音（点右上角 🔊 打开）';
    if (this._deadReason === 'create') return '声音卡死 · 请刷新页面';
    if (!this.ctx || !this.ready) return '未启动（在画面上点一下）';
    const st = this.ctx.state;
    if (st === 'running') return '正常';
    if (st === 'interrupted') return '被系统打断 · 点一下画面';
    if (st === 'closed') return '被系统关闭 · 要刷新页面';
    return '被挂起 · 点一下画面';
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.34;
    // 【用户 m04749】取消静音时顺手叫醒一次：静音期间可能已经被系统挂起，
    // 否则玩家会以为"点了音量键还是没声音"。
    if (!m) this.wake();
  }

  /** 自愈簿记（调试用：__HBT.sfx.diagText） */
  get diagText() {
    const d = this.diag;
    const st = !this.ctx ? 'no-ctx' : this.ctx.state;
    return `state=${st} ready=${this.ready} muted=${this.muted} plays=${d.plays} wakes=${d.resumes} gestures=${d.gestures} rebuilds=${d.rebuilds} lastPlay=${
      d.lastPlay ? Math.round(nowMs() - d.lastPlay) + 'ms ago' : 'never'
    }`;
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * 音效自己的随机数。
   * 刻意不用 Math.random()：冒烟测试里 Math.random 被换成定种 RNG 给游戏逻辑用，
   * 音效要是也去抽签（每次开枪一次、建噪声缓冲一次要抽近万个），
   * 就会把那条流冲掉，机器人跑分立刻变得不可复现 —— 而"跑分没变"正是调参的参照系。
   * 音效这点随机（气流的沙沙、枪声的微走音）本来也不需要和游戏共用一条流。
   */
  _rnd() {
    this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
    return this._seed / 4294967296;
  }

  _makeNoise(sec) {
    const n = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = this._rnd() * 2 - 1;
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
    // 【用户 m04749】挂起时把音排进队列，只会在恢复的一瞬间"哗"出一堆迟到音；
    // 索性丢掉这一次，同时顺手叫醒（下一次发声就是正常的）。
    if (c.state !== 'running') { this.wake(); return; }
    this.diag.plays++;
    this.diag.lastPlay = nowMs();
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
    if (c.state !== 'running') { this.wake(); return; } // 同上：挂起时不排队，等叫醒
    this.diag.plays++;
    this.diag.lastPlay = nowMs();
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
    // 老版本是一声 660~940Hz 的方波，听着像玩具激光枪（用户反馈"没有爽感"）。
    // 真枪的听感是三层叠出来的：低频推力 + 中频炸裂 + 高频尖啸。
    const det = 1 + (this._rnd() - 0.5) * 0.12;
    const base = [210, 190, 172, 156][Math.min(tier, 3)] * det;
    this.tone({ freq: base, freq2: base * 0.22, type: 'triangle', dur: 0.085, vol: 0.16 });
    this.burst({ dur: 0.06, vol: 0.17, type: 'bandpass', freq: 2800 * det, q: 0.7, sweepTo: 420 });
    this.burst({ dur: 0.022, vol: 0.08, type: 'highpass', freq: 5200 });
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

  // ---------------- 第三关：疯狂草坪（PvZ 味道）----------------

  /** 开场警报：两声长笛一样的下滑警笛（听到就知道这一关换风格了） */
  alarm() {
    for (let i = 0; i < 2; i++) {
      this.tone({ freq: 780, freq2: 420, type: 'sawtooth', dur: 0.42, vol: 0.16, delay: i * 0.5 });
      this.tone({ freq: 390, freq2: 210, type: 'triangle', dur: 0.44, vol: 0.1, delay: i * 0.5 });
    }
  }

  /** 开场倒数 3 / 2 / 1：数字越小音越高，最后一声是"开打" */
  countdown(n = 1) {
    const f = n >= 3 ? 520 : n === 2 ? 660 : 880;
    this.tone({ freq: f, type: 'square', dur: 0.16, vol: 0.16 });
    if (n <= 1) this.tone({ freq: f * 2, type: 'triangle', dur: 0.4, vol: 0.14, delay: 0.12 });
  }

  /** 豌豆：一声"噗"，比枪声软、频率低，连射起来是"噗噗噗" */
  pea() {
    const det = 1 + (this._rnd() - 0.5) * 0.12;
    this.tone({ freq: 420 * det, freq2: 240, type: 'sine', dur: 0.06, vol: 0.11 });
    this.burst({ dur: 0.035, vol: 0.05, type: 'bandpass', freq: 1200, q: 1.1, sweepTo: 500 });
  }

  /** 捡阳光：PvZ 那个"叮"（两个纯音，亮、短） */
  sun() {
    this.tone({ freq: 1046.5, type: 'sine', dur: 0.1, vol: 0.14 });
    this.tone({ freq: 1567.98, type: 'sine', dur: 0.16, vol: 0.12, delay: 0.06 });
  }

  /** 樱桃炸弹：比普通爆炸更"脆"的一下，前面还有一声引信的嘶声 */
  cherry() {
    this.burst({ dur: 0.16, vol: 0.09, type: 'highpass', freq: 3400, sweepTo: 900 });
    this.tone({ freq: 260, freq2: 42, type: 'sawtooth', dur: 0.62, vol: 0.3 });
    this.burst({ dur: 0.55, vol: 0.28, type: 'lowpass', freq: 1800, sweepTo: 110 });
  }

  /** 戴夫那句"歪比巴布"：两个下滑音，故意听起来很蠢 */
  dave() {
    this.tone({ freq: 300, freq2: 200, type: 'triangle', dur: 0.16, vol: 0.16 });
    this.tone({ freq: 220, freq2: 150, type: 'triangle', dur: 0.22, vol: 0.14, delay: 0.16 });
    this.tone({ freq: 190, freq2: 120, type: 'sawtooth', dur: 0.18, vol: 0.1, delay: 0.34 });
  }

  // ---------------- v3 新增（打击感 / 新玩法）----------------

  /** BOSS 导弹预警：两声急促的上滑警报（听到就准备挪位） */
  missileWarn() {
    this.tone({ freq: 520, freq2: 900, type: 'square', dur: 0.16, vol: 0.12 });
    this.tone({ freq: 700, freq2: 1180, type: 'square', dur: 0.18, vol: 0.11, delay: 0.22 });
  }

  /** BOSS 导弹落地：闷响 + 低频冲击 */
  missileBoom() {
    this.tone({ freq: 150, freq2: 38, type: 'sawtooth', dur: 0.5, vol: 0.26 });
    this.burst({ dur: 0.45, vol: 0.22, type: 'lowpass', freq: 1100, sweepTo: 110 });
  }

  /** 吐酸者喷吐：湿滑的向上滑音 */
  spit() {
    this.tone({ freq: 300, freq2: 720, type: 'sawtooth', dur: 0.16, vol: 0.075 });
    this.burst({ dur: 0.14, vol: 0.07, type: 'bandpass', freq: 900, q: 2.2, sweepTo: 2100 });
  }

  /**
   * BOSS 进化成僵尸博士（用户 m01503）：低频上冲 + 金属变形 + 一声闷雷。
   * 这是整场最"重"的一声，要让玩家抬头看屏幕。
   */
  evolve() {
    this.tone({ freq: 60, freq2: 320, type: 'sawtooth', dur: 1.5, vol: 0.34 });
    this.tone({ freq: 180, freq2: 90, type: 'square', dur: 1.6, vol: 0.16, delay: 0.1 });
    this.burst({ dur: 1.3, vol: 0.24, type: 'lowpass', freq: 260, sweepTo: 2400 });
    this.tone({ freq: 880, freq2: 220, type: 'triangle', dur: 0.7, vol: 0.14, delay: 0.75 });
  }

  /** 博士召唤尸潮：一串下行的黏腻音（配合"爬出来"的动画） */
  bossSummon() {
    this.tone({ freq: 420, freq2: 120, type: 'triangle', dur: 0.42, vol: 0.16 });
    this.burst({ dur: 0.36, vol: 0.14, type: 'bandpass', freq: 700, q: 1.1, sweepTo: 180 });
    this.tone({ freq: 240, freq2: 90, type: 'sawtooth', dur: 0.5, vol: 0.12, delay: 0.18 });
  }

  /** 博士的火球齐射：一道炙热的"呼"声 */
  fireball() {
    this.tone({ freq: 160, freq2: 520, type: 'sawtooth', dur: 0.34, vol: 0.16 });
    this.burst({ dur: 0.4, vol: 0.15, type: 'bandpass', freq: 500, q: 0.9, sweepTo: 1800 });
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

  /**
   * 空袭：轰炸机轰鸣着横穿夜空。
   * 老版本是"呼叫音 + 六声落地炸响"，现在落地炸响由真正的爆炸（explode → bomb）
   * 负责，这里只留飞机本身：两层错开的低频锯齿出"多引擎"的拍频轰鸣，
   * 加一层气流噪声，听感上就是"飞机从头顶压过去"。
   */
  strike() {
    const dur = 2.3;
    this.tone({ freq: 96, freq2: 72, type: 'sawtooth', dur, vol: 0.11, attack: 0.35 });
    this.tone({ freq: 88, freq2: 66, type: 'sawtooth', dur, vol: 0.09, attack: 0.42, delay: 0.05 });
    this.burst({ dur, vol: 0.1, type: 'lowpass', freq: 520, q: 0.8, sweepTo: 240 });
    this.burst({ dur: 0.9, vol: 0.07, type: 'bandpass', freq: 1500, q: 0.6, sweepTo: 700, delay: 1.05 });
  }

  /** 导弹下落：由高到低的呼啸 */
  whoosh() {
    this.burst({ dur: 0.5, vol: 0.1, type: 'bandpass', freq: 2600, q: 1.1, sweepTo: 380 });
    this.tone({ freq: 1200, freq2: 180, type: 'sine', dur: 0.46, vol: 0.045 });
  }

  /**
   * 通关（第一关 15 波打完）：一段往上冲的号角 + 金币落袋的叮当。
   * 要跟"被咬死"的 gameOver 明显分得开，所以走大调琶音而不是下坠音。
   */
  victory() {
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => this.tone({ freq: f, type: 'triangle', dur: 0.26, vol: 0.15, delay: i * 0.11 }));
    // 收尾的和弦：两个八度一起按下去
    this.tone({ freq: 1046.5, type: 'triangle', dur: 0.9, vol: 0.13, delay: 0.46, attack: 0.02 });
    this.tone({ freq: 1318.5, type: 'sine', dur: 1.0, vol: 0.1, delay: 0.46, attack: 0.02 });
    this.burst({ dur: 0.6, vol: 0.08, type: 'highpass', freq: 3600, delay: 0.46 });
    // 金币：三声清脆的叮
    [0.62, 0.74, 0.86].forEach((d, i) => {
      this.tone({ freq: 1760 + i * 220, type: 'sine', dur: 0.14, vol: 0.09, delay: d });
    });
  }

  /** 角色喊话：一小段上扬的"喊"音型，跟屏幕上那句台词配合 */
  voice(pitch = 0) {
    const base = 320 + Math.min(pitch, 8) * 26;
    this.tone({ freq: base, freq2: base * 1.85, type: 'sawtooth', dur: 0.13, vol: 0.09 });
    this.tone({ freq: base * 1.4, freq2: base * 2.5, type: 'square', dur: 0.17, vol: 0.055, delay: 0.06 });
    this.burst({ dur: 0.14, vol: 0.05, type: 'bandpass', freq: 1300, q: 1.5, sweepTo: 2400 });
  }
}
