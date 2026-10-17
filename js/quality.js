// ---------------------------------------------------------------------------
//  画质自适应（用户 m02901："频发卡顿掉帧，优化底层架构，提升运行速度"）
//
//  为什么是"自适应"而不是"把画质一刀切降下来"：
//  真机性能差异极大（三年前的中端安卓 vs 新款 iPhone），我在电脑上也没法代替
//  真机测帧率。既然猜不准，就盯着**真实帧时间**自己调：连续一小段时间偏慢就
//  降一档（降 DPR + 关几层全屏叠加效果），长时间很流畅再升回去。
//
//  三档控制的东西：
//    dpr       —— 画布物理像素倍率。手机真正的大头是填充率（全屏叠好几层半透明），
//                 DPR 从 2 降到 1.5 就少画 44% 的像素，这是最立竿见影的一刀。
//    haze/fog  —— 两层全屏渐变叠加（雾、水汽）
//    vignette  —— 丧尸逼近时的全屏红晕
//    motes     —— 空气浮尘的密度倍率
//    marks     —— 桥面痕迹（裂缝/补丁/血渍）的密度倍率
//    particles —— 粒子池上限
//
//  滞回（避免画质来回跳）：慢要连续 40 帧（约 0.7s）才降，快也要连续 300 帧
//  （约 5s）才升；每档切换后有一小段"热身期"不判断。
//
//  注意：auto 默认 false —— 只有 main.js 打开它。bench/shot 这类离线渲染工具
//  故意不打开，否则它们的合成帧时间（被 @napi-rs/canvas 的 CPU 尖峰污染）
//  会把画质打到最低，导致基准数字失去可比性。
// ---------------------------------------------------------------------------

const KEY = 'hold-the-bridge:quality';

export const LEVELS = [
  // 【用户 m10372】"勇者和花仙子在游戏里都很模糊，角色界面不是很清晰吗"
  // 角色界面是浏览器直接画 640×960 的图，而 canvas 的物理分辨率被 high 档的 dpr 封顶了：
  // 3x 屏手机只画 2x，整张画面被拉大 1.5 倍 → 立绘边缘发虚。
  // high 档放到 3x（= 跟屏幕 1:1），真的慢的话自适应照样会降到 mid/low。
  { name: 'high', dpr: 3, haze: true, fog: true, vignette: true, motes: 1, marks: 1, particles: 420 },
  { name: 'mid', dpr: 2, haze: true, fog: false, vignette: true, motes: 0.5, marks: 0.5, particles: 300 },
  { name: 'low', dpr: 1.5, haze: false, fog: false, vignette: false, motes: 0, marks: 0.25, particles: 200 },
];

function load() {
  try {
    const v = parseInt(window.localStorage.getItem(KEY) || '0', 10);
    return v >= 0 && v < LEVELS.length ? v : 0;
  } catch (e) {
    return 0;
  }
}

function save(i) {
  try {
    window.localStorage.setItem(KEY, String(i));
  } catch (e) {
    /* 隐私模式之类的读不到存储：不影响玩，只是下次进游戏要重新自适应 */
  }
}

export const QUALITY = {
  auto: false,
  level: load(),
  dirty: false, // 档位变了、需要重新 fit()（dpr 变了）
  slow: 0,
  fast: 0,
  warmup: 120, // 开头这一段（加载字体、首波生成）不判断
  changes: 0,

  get prop() {
    return LEVELS[this.level];
  },

  set(i) {
    const n = Math.max(0, Math.min(LEVELS.length - 1, i | 0));
    if (n === this.level) return false;
    this.level = n;
    this.dirty = true;
    this.changes++;
    this.warmup = 60;
    this.slow = 0;
    this.fast = 0;
    save(n);
    return true;
  },

  /** 每帧喂一次真实帧时间（毫秒）。只有 auto 打开时才动作。 */
  sample(ms) {
    if (!this.auto || !(ms > 0)) return;
    if (this.warmup > 0) {
      this.warmup--;
      return;
    }
    if (ms > 24) {
      this.slow++;
      this.fast = 0;
    } else if (ms < 15) {
      this.fast++;
      this.slow = 0;
    } else {
      // 16.7ms 上下（60Hz 正常帧）：既不算慢也不算快 —— 留在原地
      if (this.slow > 0) this.slow--;
      if (this.fast > 0) this.fast--;
    }
    if (this.slow >= 40 && this.level < LEVELS.length - 1) this.set(this.level + 1);
    else if (this.fast >= 300 && this.level > 0) this.set(this.level - 1);
  },

  /** 手动切档（设置界面 / 测试用）；返回是否真的变了 */
  force(i) {
    return this.set(i);
  },

  reset() {
    this.level = 0;
    this.dirty = true;
    this.changes = 0;
    this.slow = 0;
    this.fast = 0;
    this.warmup = 120;
    save(0);
  },
};
