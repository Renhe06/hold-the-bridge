// ---------------------------------------------------------------------------
//  第五关 · 上篇「跃」—— 玩法层
//
//  这不是"第四关换个皮"，是另一套游戏的语法。前四关的所有规矩在这里全部作废：
//
//    没有桥     → 只有一根竖直的水柱
//    没有枪     → 唯一能做的动作是"唱"，而唱只会暴露自己
//    没有血条   → 伤害不扣血，只是"泄漏"；泄漏会招来海鸥
//    没有杀敌   → 网、钩、塑料、船，一个都杀不掉，只能穿过去或者躲开
//    没有关卡   → 不分波次，一局到底，深度由玩家自己掌握
//
//  ---------------------------------------------------------------------------
//  为什么不是"七波"（这一版推翻的东西）
//
//  七波 = 七次独立下潜，每波氧气重置、同类固定、动作相同。它读起来是
//  "换个壁纸再做一遍同一件事"，而且节奏是系统派给你的，不是你自己呼吸出来的。
//  所以这里改成**一根连续的水柱，一局到底**：
//
//    · 世界只有一个，深度 0 → 1.2，所有东西按世界深度钉死，游到哪就看见哪
//    · 氧气只有一条，从满到空 55 秒，中途**不重置**
//    · 同类 = 你的氧气。找到它、回应它 → 它回唱，给你 42% 的气，然后沉下去
//    · 上浮到海面能回满气，但整个海面都在看着你
//
//  于是节奏不再由系统给，而是玩家自己下的赌注：
//      再往下找一只（可能白跑），还是现在就上去（可能白跑一趟上浮）。
//  每两层要做一次这个决定 —— 这就是「跃」的意义：换气不是动作，是代价。
//
//  三处故意不给同类的地方，是这一局的三个重音：
//      0.60 附近  白跑一层：这里只有鱼钩和血，没有回应
//      0.86       油污封住水面：上不去了，只能往下
//      1.18       最后一个在极限之外：算得出来的回不去
// ---------------------------------------------------------------------------

import { clamp, lerp, mulberry32 } from './util.js';

const TAU = Math.PI * 2;

/** 横向坐标 lat ∈ [-1,1] → 屏幕 x 的映射比例。 */
const SX = 0.42;

/** 四种垃圾的长宽比。瓶子是竖长的，泡沫块是横宽的 —— 形状不同才像"杂"。 */
const LITTER_SHAPE = {
  bag:    { w: 1.00, h: 1.00 },
  bottle: { w: 0.52, h: 1.10 },
  can:    { w: 0.62, h: 0.86 },
  foam:   { w: 0.94, h: 0.76 },
};

/** 两条界线的深度。海面界以上能呼吸，深渊界以下船看不见你。 */
const SURFACE_D = 0.14;
const ABYSS_D = 0.62;

/** 玩家能达到的最大深度。最后一个同类在 1.18 —— 永远差一截。 */
const MAX_DEPTH = 1.0;
/**
 * 最小深度是负数：水面之上。
 * 「我时而跃出海面」不是修辞 —— 玩家真的能把头探出去，看见月亮、海平线、
 * 远处的船和灯。这是这一关唯一"抬头"的时刻，也是氧气唯一能回满的地方。
 */
const MIN_DEPTH = -0.30;
/**
 * 「跃」本身不设门槛 —— 鲸想上去就上去。
 *
 * 鱼缸不是物理的。水面没有盖子，玩家随时能把头探出去看月亮。
 * 真正把他按在水下的是代价：每一次破水都会被看见，而海面上全是船。
 * 所以这里只留一个极浅的皮（0.018），用来判断"身体出水了没有"，
 * 不做任何阻挡 —— 难的是猎杀，不是动作。
 */
const SURFACE_SKIN = 0.018;

/**
 * 一口气的长度（秒）。
 *
 * 一层大约要 12 秒：听两三声歌、判断方向、游过去、停下来唱完一句。
 * 34 秒 ≈ 三层。七层要走完，必须上浮两次 —— 也就是整局的节奏：
 *   下潜三层 → 跃上去换气 → 下潜三层 → 跃上去 → 最后一层，不回来。
 *
 * 这个数字是全关的节拍器，改它等于改整局的长度。
 */
const OXY_SEC = 34;

/**
 * 歌词的七段，现在不是七关，而是**一根水柱上的七段深度**。
 *
 * 所有内容按世界深度一次性生成（见 _buildWorld），游到哪一段就看见哪一段，
 * 没有"进入下一关"这种切换。这样玩家看见的是一条连续变坏的路，
 * 而不是七个换了背景的房间。
 *
 *   d      这一段从多深开始
 *   mate   这一段有没有同类（null = 白跑）
 *   name   歌词原句
 *   line   这一段的一句话（只在 HUD 顶部出现，不打断操作）
 */
export const SEA_STRATA = [
  { d: 0.00, mate: [0.17, 0.00], name: '海洋静谧依旧', line: '洋流是暖的。它推着你走。' },
  { d: 0.22, mate: [0.33, 0.30], name: '乳白色蜉蝣', line: '它不会腐朽，也不会走开。' },
  { d: 0.42, mate: [0.50, -0.28], name: '是那沉没的舰', line: '又是这艘船。它比上次更深。' },
  { d: 0.58, mate: null, name: '血引来了海鸥', line: '这一层没有回应。只有钩子。' },
  { d: 0.70, mate: [0.74, 0.22], name: '唱贪婪的盛宴', line: '网在收。它在网里面。' },
  { d: 0.82, mate: [0.88, -0.14], name: '看冰山在崩裂', line: '水面已经封死了。只能往下。' },
  { d: 0.94, mate: [1.18, 0.00], name: '唱给书里的图鉴', line: '最后一个在下面。你算得出来。' },
];

/** 兼容旧引用：外部只拿它当"一共有几段"。 */
export const SEA_WAVES = SEA_STRATA;

export class SeaGame {
  constructor(renderer, audio, whaleArt) {
    this.R = renderer;
    this.sea = audio;
    this.art = whaleArt;
    this.reset();
  }

  reset() {
    this.mode = 'play';      // play | vision | endA | endB
    this.t = 0;
    // waveT 是历史名字，渲染层和旧的实体绘制都还在读它。它就是"世界时间"。
    this.waveT = 0;
    this.depth = 0.02;
    this.aimDepth = 0.02;
    this.lat = 0;
    this.aimLat = 0;
    this.vD = 0;
    this.vL = 0;
    this.oxy = 1;
    this.exposure = 0;
    this.held = false;
    this.heldT = 0;
    this.singing = false;
    this.singT = 0;
    this.echo = 0;
    this.mate = null;        // 最近的那一只：HUD 与方向提示用
    this.mates = [];
    this.kit = [];
    this.endT = 0;
    this.dark = 0;
    this.surfaceT = 0;
    this.breathFlash = 0;
    this.wallHit = 0;
    this.wallX = 0;
    this.bump = 0;
    this.hint = '';
    // 献祭：整局只有一件东西可以丢
    this.necklace = true;
    this.sacrificeT = 0;
    this.sacrificing = false;
    this.codex = [];          // 图鉴：每回应一只记一页
    this.lost = 0;            // 交给海的那一些（项链、来不及的）
    this.dives = 0;           // 换过几次气。上浮不是失败，但也不是免费的
    // 歌本来就缺音：开局只有一个音，找回一只多一个。
    // 六只同类 + 自己那个音 = 七个音。整局唯一"变大"的数字。
    this.voices = 1;
    this._motifIn = 0;
    this.lastT = 0;
    this.endedAt = 0;
    // 幻象花园：结局不是黑屏，是"我看见 最美丽的花园"
    this.visionT = 0;
    this.visionK = 0;
    this.blood = [];           // 血雾：受伤的证据，海鸥看的方向
    this.maxDepth = 0;
    this.rnd = mulberry32(4021);
    this.gulls = [];
    this.fish = [];
    this._litter = null;
    this._coral = {};
    this._buildWorld();
    this._seedFish();
  }

  /**
   * 一根水柱，一次性生成到底。
   *
   * 没有"进入下一层"这种切换：所有东西都按世界深度钉死，游到哪就看见哪。
   * 玩家看见的是一条连续变坏的路 —— 上面是丝绸一样的蓝，下面是塑料、钩子、
   * 沉船、拖网、油污，最后什么都没有。
   */
  _buildWorld() {
    const rnd = this.rnd;

    // ---- 同类：歌词的七段里，有六段有回应。0.58 那一段故意是空的 ----
    this.mates = [];
    SEA_STRATA.forEach((S, i) => {
      if (!S.mate) return;
      this.mates.push({
        idx: i,
        depth: S.mate[0],
        lat: S.mate[1],
        lat0: S.mate[1],
        drift: 0,
        found: false,
        resp: 0,
        nextCall: 1.2 + rnd() * 2.6,
        glow: 0,
      });
    });

    const out = [];

    // 「总是陪我徜徉渐暖的洋流」—— 唯一会替你走路的东西。不伤人，只是不问。
    out.push({ type: 'current', d: 0.09, h: 0.15, dir: 1, sp: 0.10, ph: rnd() * TAU });
    out.push({ type: 'current', d: 0.37, h: 0.18, dir: -1, sp: 0.13, ph: rnd() * TAU });
    out.push({ type: 'current', d: 0.67, h: 0.13, dir: 1, sp: 0.07, ph: rnd() * TAU });

    // 「乳白色蜉蝣」—— 越往下越多，而且不会腐朽。这是全关唯一"只增不减"的东西。
    const kinds = ['bag', 'bottle', 'foam', 'can', 'bag', 'bottle', 'foam', 'can', 'bottle', 'bag'];
    for (let i = 0; i < kinds.length; i++) {
      const k = i / (kinds.length - 1);
      out.push({
        type: 'plastic',
        kind: kinds[i],
        depth: 0.26 + k * 0.64 + (rnd() - 0.5) * 0.04,
        lat: -0.82 + rnd() * 1.64,
        r: 0.075 + rnd() * 0.05,
        ph: rnd() * TAU,
        hit: 0,
      });
    }

    // 「是那沉没的舰」「是那盏灯塔在忽明忽灭」
    out.push({ type: 'wreck', depth: 0.48 });
    out.push({ type: 'lighthouse', lat: 0.70, d: 0.52, ph: 1.2, on: true, k: 1 });

    // 「当泛滥的鱼钩」—— 从 0.54 开始，越往下越密
    for (let i = 0; i < 15; i++) {
      const k = i / 14;
      out.push({
        type: 'hook',
        lat: -0.9 + rnd() * 1.8,
        depth: 0.54 + k * 0.44 + (rnd() - 0.5) * 0.03,
        ph: rnd() * TAU,
        sp: 0.5 + rnd() * 0.5,
        hit: 0,
      });
    }

    // 「血引来了海鸥」：它们只在有血的地方出现，见 _gull
    out.push({ type: 'gull' });

    // 「海上谁领唱满载而去的歌」—— 船队只在海面上，从不下来
    for (let i = 0; i < 5; i++) {
      out.push({
        type: 'fleet',
        lat: -0.9 + (i + 0.5) * (1.8 / 5) + (rnd() - 0.5) * 0.1,
        scale: 0.5 + rnd() * 0.75,
        ph: rnd() * TAU,
      });
    }

    // 「网」是墙：从水面垂下来，只挡到 bottom。上浮时这两道帘子会拦住你。
    // 网的底沿只到 0.46 / 0.54 —— 再往下就没有"挂着的网"这回事了，
    // 那是一条从水面垂到海底的纱帘，画面上会占掉整屏。真实流网就是几米深。
    // 加宽是因为太窄的网在竖屏上像两条飘带，不像一块布。
    out.push({ type: 'net', lat: -0.32, w: 0.30, bottom: 0.46, ph: rnd() * TAU, hit: 0, gap: 0.06 });
    out.push({ type: 'net', lat: 0.38, w: 0.26, bottom: 0.54, ph: rnd() * TAU, hit: 0, gap: 0.10 });

    // 「看沥青在蔓延」—— 水面那一层已经不能换气了。它只盖住最上面一截。
    out.push({ type: 'slick', top: -0.04, bottom: 0.05, ph: rnd() * TAU });

    // 「看冰山在崩裂」「高楼大厦车水马龙」—— 都在水面，只有跃出去才看得见
    out.push({ type: 'berg', lat: -0.62, w: 0.32, ph: rnd() * TAU });
    out.push({ type: 'city', ph: rnd() * TAU });

    // 声呐：船在找鲸。不伤人，但让你被找到。
    out.push({ type: 'sonar', t: 6, gap: 8 });

    this.kit = out;
  }

  /** 「鱼群翩翩舞动」——它们不参与玩法，但水里有没有活物是两回事。 */
  _seedFish() {
    this.fish = [];
    for (let i = 0; i < 26; i++) {
      this.fish.push({
        lat: (this.rnd() - 0.5) * 1.9,
        depth: 0.04 + this.rnd() * 0.60,
        vlat: 0,
        vdepth: 0,
        ph: this.rnd() * TAU,
        sp: 0.5 + this.rnd() * 0.9,
        size: 0.5 + this.rnd() * 0.8,
      });
    }
  }

  /**
   * 生命密度：随**玩家所在深度**变，不是随关卡。
   * 浅处满海是活的，深处一条鱼都没有 —— 玩家每往下 0.1，
   * 周围就少一点东西。这不是提示，是"万物正在被消灭"的体感。
   */
  get life() {
    return clamp(1 - this.depth * 0.92, 0.08, 1);
  }

  /**
   * 世界阶段（0~4）。**这是这一关真正的进度条。**
   *
   * 不再看找到了几只 —— 看你呼吸了几次、潜了多深。
   * 每上来换一口气，海面就更坏一档：船更多、灯更亮、冰山开始崩、
   * 水开始浑。玩家不需要读任何数字，每次跃出海面看见的就是答案：
   * 上一次还是星星和两艘远船，这一次已经是满海灯火。
   *
   * 潜过 0.6 也算一档 —— 「唱给这世界在慢慢下潜」：
   * 不只是你下去了，是整个海在下去。
   */
  get stage() {
    return Math.min(4, this.dives + (this.maxDepth > 0.6 ? 1 : 0));
  }

  /** 浑浊度（0~1）：水从藏蓝丝绸变成褐绿的汤。 */
  get murk() {
    return clamp(this.stage / 4, 0, 1);
  }

  /** 珊瑚的健康度：1 = 彩色家园，0 = 白骨。幻象时强制回到 1。 */
  get coralHealth() {
    return this.visionK > 0 ? Math.max(1 - this.murk, this.visionK) : 1 - this.murk;
  }

  /** 当前深度属于哪一段歌词。 */
  get cur() {
    let out = SEA_STRATA[0];
    for (const S of SEA_STRATA) if (this.depth >= S.d - 0.03) out = S;
    return out;
  }

  // ---------------------------------------------------------
  //  输入
  // ---------------------------------------------------------

  down(x, y) {
    this.held = true;
    this.heldT = 0;
    this._pt = { x, y };
  }

  move(x, y) {
    if (!this.held || !this._pt) return;
    const w = this.R.w;
    const h = this.R.h;
    const dx = x - this._pt.x;
    const dy = y - this._pt.y;
    this._pt.x = x;
    this._pt.y = y;
    this.aimDepth = clamp(this.aimDepth - (dy / h) * 1.25, MIN_DEPTH, MAX_DEPTH);
    const nl = this.aimLat + (dx / w) * 2.1;
    // 隐形边界：撞上去会被水推回来，不是硬停。硬停读作"bug"，推回读作"墙"。
    if (Math.abs(nl) > 1) {
      this.wallHit = 1;
      this.wallX = Math.sign(nl);
      this.aimLat = Math.sign(nl) * 1;
    } else {
      this.aimLat = nl;
    }
  }

  up() {
    this.held = false;
    this.heldT = 0;
    this.singing = false;
    this.singT = 0;
    this.sacrificing = false;
    this.sacrificeT = 0;
  }

  // ---------------------------------------------------------
  //  每帧
  // ---------------------------------------------------------

  update(dt) {
    this.t += dt;
    this.waveT = this.t;

    // ---- 幻象花园：氧气归零不是黑屏，是死前看见的那一版海 ----
    // 「珊瑚在海底蜿蜒　我看见 最美丽的花园」：它只出现在结束的路上。
    // 渐入 1.5 秒 → 停 4.5 秒 → 渐出 2 秒。之后世界才真的暗下去。
    if (this.mode === 'vision') {
      this.visionT += dt;
      this.visionK = Math.min(1, this.visionT / 1.5) * clamp((8 - this.visionT) / 2, 0, 1);
      // 幻象里鱼群回来了，绕着你转 —— 和第一层一模一样
      if (this.visionT < 1.6 && this.fish.length < 18) {
        this.fish.push({
          lat: this.lat + (this.rnd() - 0.5) * 0.9,
          depth: clamp(this.depth + (this.rnd() - 0.5) * 0.3, 0.02, 0.72),
          vlat: 0, vdepth: 0, ph: this.rnd() * TAU,
          sp: 0.6 + this.rnd() * 0.8, size: 0.5 + this.rnd() * 0.8,
        });
      }
      this._fish(dt);
      if (this.visionT > 8.4) {
        this.mode = 'endB';
        this.visionK = 0;
        this._endFade();
      }
      return;
    }

    if (this.mode === 'endA' || this.mode === 'endB') {
      this.endT += dt;
      if (this.mode === 'endB') {
        // 氧气归零不是"死亡动画"：画面不黑，只是越来越暗，歌声停了。
        // 停在 0.72 深度 / 0.4 压暗 —— 再往下水本身就没有一丝光了。
        this.dark = Math.min(0.4, this.dark + dt * 0.14);
        this.aimDepth = Math.min(0.72, this.aimDepth + dt * 0.025);
        this.depth = lerp(this.depth, this.aimDepth, Math.min(1, dt * 1.2));
      }
      this.echo = Math.max(0, this.echo - dt / 1.3);
      return;
    }

    this.echo = Math.max(0, this.echo - dt / 1.3);
    this.breathFlash = Math.max(0, this.breathFlash - dt * 1.4);
    // 血雾：散开、变淡、往上飘。它不伤害任何人，只是标记你
    for (const b of this.blood) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx *= 0.985;
      b.life -= dt * 0.34;
    }
    this.blood = this.blood.filter((b) => b.life > 0);
    this.wallHit = Math.max(0, this.wallHit - dt * 1.8);
    this.bump = Math.max(0, this.bump - dt * 1.5);
    this.strataFlash = Math.max(0, (this.strataFlash || 0) - dt * 0.8);
    if (this.held) this.heldT += dt;
    this.singing = this.held && this.heldT > 0.3;

    this._move(dt);
    this._breath(dt);
    this._sing(dt);
    this._sacrifice(dt);
    this._mate(dt);
    this._fish(dt);
    this._gull(dt);
    this._kit(dt);

    if (this.depth > this.maxDepth) this.maxDepth = this.depth;

    // 回应之后，把整首歌放一遍。用计时器而不是 setTimeout：
    // 页面一停，它也跟着停，不会在后台响一声。
    if (this._motifIn > 0) {
      this._motifIn -= dt;
      if (this._motifIn <= 0) this.sea.motif({ vol: 0.055 });
    }

    // 跨入新的一段：换一句提示。这一段有没有同类，必须说清楚 ——
    // 玩家不该靠"游了半天什么都没遇到"自己猜。
    const si = SEA_STRATA.indexOf(this.cur);
    if (si !== this._strataIdx) {
      this._strataIdx = si;
      // 屏幕中间那行已经显示这一段的句子了，底部就别重复一遍 ——
      // 底部永远只回答一个问题："我现在该做什么"。
      this.hint = this.cur.mate ? '往下，找到它。' : '这一段没有回应。往下。';
      this.strataFlash = 1;
      if (!this.cur.mate) this.sea.hull();
    }

    // 收手：**跃出水面**并停住。注意它和换气不是同一个位置 ——
    // 把头探出水面（0 ~ 0.14）只是呼吸，整个身体跃出去（< -0.14）才是离开。
    // 这两件事必须分开，否则玩家每次回气都会被系统判成"游戏结束"。
    const canLeave = this.codex.length >= 5;
    if (canLeave && this.depth < -0.14) {
      this.surfaceT += dt;
      if (this.surfaceT > 3.0) this._end('A');
    } else {
      this.surfaceT = 0;
    }

    // 终局：能找的都找到了，你也下到了自己的极限 1.00 ——
    // 最后一个在 1.18，永远差那一点。这不是"失败"，是"你到了"。
    // 没有这个判定，玩家会在底部无限循环换气，游戏没有终点。
    if (this.codex.length >= this.mates.length - 1 && this.depth > 0.97) {
      this.lastT += dt;
      if (this.lastT > 3.2) this._end('B');
    } else {
      this.lastT = 0;
    }

    if (this.oxy <= 0) {
      this.oxy = 0;
      this._end('B');
    }
  }

  _move(dt) {
    // w 是临界阻尼的刚度。7.2 的时候鲸在水里像块石头：手一划就到头，
    // 根本没有"下潜"这件事。2.6 才有水阻 —— 想停会滑一段，想转向要顶一下，
    // 一层 0.14 的深度要游将近一秒。节奏的一半来自这里。
    // 「我时而跃出海面，我时而脸抚深渊」—— 这两个动作的时间感不一样。
    // 下去是慢的（水压、重量、要看清下面有什么），上来是一跃。
    // 所以刚度不是常数：向上 4.4，向下 2.2。这是节奏里最便宜也最有效的一刀。
    const wv = this.aimDepth < this.depth - 0.004 ? 4.4 : 2.2;
    const w = 2.6;
    // 洋流：不直接改位置（那样像指针失灵），改"你想去的那个点"。
    for (const t of this.kit) {
      if (t.type === 'current' && Math.abs(this.depth - t.d) < t.h * 0.5) {
        this.aimLat = clamp(this.aimLat + t.dir * t.sp * dt * 0.55, -1, 1);
      }
    }
    this.vD += ((this.aimDepth - this.depth) * wv * wv - this.vD * 2 * wv) * dt;
    this.depth = clamp(this.depth + this.vD * dt, MIN_DEPTH, MAX_DEPTH);
    this.vL += ((this.aimLat - this.lat) * w * w - this.vL * 2 * w) * dt;
    this.lat += this.vL * dt;
    this.lat = clamp(this.lat, -1, 1);
  }

  /** 鱼群：绕着浅处慢慢转，玩家一靠近就散开。深处看不见它们。 */
  _fish(dt) {
    for (const f of this.fish) {
      const dx = this.lat - f.lat;
      const dy = this.depth - f.depth;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.24) {
        f.vlat -= dx * dt * 3.4;
        f.vdepth -= dy * dt * 3.4;
      } else {
        f.vlat += Math.cos(this.waveT * f.sp * 2 + f.ph) * dt * 0.06;
        f.vdepth += Math.sin(this.waveT * f.sp * 1.6 + f.ph) * dt * 0.05;
        f.vdepth += (0.3 - f.depth) * dt * 0.006;
      }
      f.vlat *= 0.98;
      f.vdepth *= 0.98;
      f.lat = clamp(f.lat + f.vlat, -1.2, 1.2);
      f.depth = clamp(f.depth + f.vdepth, 0.02, 0.72);
    }
  }

  /** 海鸥的数量 = 你的暴露度。它们不咬人，只是证明你被看见了。 */
  _gull(dt) {
    const want = Math.round(clamp(this.exposure - 0.22, 0, 1) * 8);
    while (this.gulls.length < want) {
      this.gulls.push({
        lat: (this.rnd() - 0.5) * 1.7,
        ph: this.rnd() * TAU,
        r: 0.14 + this.rnd() * 0.12,
        sp: 0.5 + this.rnd() * 0.5,
      });
    }
    while (this.gulls.length > want) this.gulls.pop();
    for (const g of this.gulls) g.ph += dt * 0.7 * g.sp;
  }

  /**
   * 双界。这是整关的心脏。
   *
   * 上浮到 SURFACE_D 以上：气在涨，但你在月光下最亮 —— 暴露度跟着涨，
   * 海鸥和船都看得见你。下潜到 ABYSS_D 以下：没人看得见你，
   * 但水压在吃气，而且四周全黑，连同类在哪都只能靠听。
   *
   * 氧气**不重置**。整局只有这一条曲线，所以每一次上浮都是玩家自己做的决定，
   * 而不是"这一关结束，系统给你满上"。
   */
  _breath(dt) {
    // 油污**不封住换气**。这一点很关键：海面是整局唯一的补给点，
    // 把它锁死等于让所有人必死。油污的代价是"你在油里最显眼" ——
    // 能呼吸，但每一次呼吸都在被看着。见 _kit 里的 slick 分支。
    const above = this.depth < SURFACE_D;

    if (above) {
      const wasDeep = this._wasDeep;
      this.oxy = Math.min(1, this.oxy + dt * 0.55);
      this.exposure = Math.min(1, this.exposure + dt * 0.34);
      // 从深处第一次冒出水面 = 一次"跃"。给一次呼吸音和一道月光闪。
      if (wasDeep) {
        this.dives += 1;
        this.breathFlash = 1;
        this.sea.breath();
        this.sea.surface();
        if (this.depth < 0) {
          this.bump = 1;
          this.exposure = Math.min(1, this.exposure + 0.30);
        }
        // 上来一趟不是免费的：没回应的那些会游走，你刚才记的方向作废。
        this._driftMates();
      }
      this._wasDeep = false;
    } else {
      // 锁存：只要这一趟真的深过，就记住。不能每帧重算 ——
      // 上浮经过 0.15 的时候它会被算成 false，"跃"于是永远不会被记一次。
      if (this.depth > SURFACE_D + 0.08) this._wasDeep = true;
      let drain = 1 / OXY_SEC;
      if (this.singing) drain *= 1.7;
      // 水压：越深越费气。这是"回不去"唯一诚实的算法 ——
      // 不是有人拦你，是你算一下就知道气不够。
      if (this.depth > ABYSS_D) drain *= 1 + (this.depth - ABYSS_D) * 3.2;
      // 在同类身边耗得慢：它替你分担了一点。这是「为寻一次相拥」的机制写法。
      if (this._nearMate > 0) drain *= 0.66;
      // 浅处不急：第一层是教学，不该被氧气追着跑。
      if (this.depth < 0.26) drain *= 0.55;
      this.oxy -= dt * drain;
      if (this.depth > ABYSS_D) this.exposure = Math.max(0, this.exposure - dt * 0.16);
    }

    if (this.singing) this.exposure = Math.min(1, this.exposure + dt * 0.5);
    else if (!above) this.exposure = Math.max(0, this.exposure - dt * 0.08);
  }

  _sing(dt) {
    if (!this.singing) {
      this.singT = 0;
      return;
    }
    this.singT += dt;
    if (this.singT > 1.15) {
      this.singT = 0;
      this.echo = 1;
      this.sea.echo({ pan: this.lat * 0.5 });
      for (const m of this.mates) if (m.found && !m.answered) m.glow = 1;
    }
    // 回应要"唱够"：不是路过按一下，是在它旁边停住、唱完一整句。
    const m = this.mate;
    if (m && m.found && !m.answered) {
      m.resp += dt;
      if (m.resp > 1.8) this._answer(m);
    }
  }

  /**
   * 它回应了你。
   *
   * 它**不给氧气** —— 气只从海面来，同类不是氧气罐，那样写既不通生理也不通感情。
   * 它给的是一个音：这首歌本来只有三个音，还缺最后那个。
   * 每回应一只，就补上一个。整局唯一的"得到"，是听见的歌越来越完整。
   *
   * 「有谁回应了我被遗忘的歌」——回应这件事本身，就是奖励。
   */
  _answer(m) {
    m.answered = true;
    m.resp = 0;
    this.voices = this.sea.addVoice ? this.sea.addVoice() : Math.min(7, this.voices + 1);
    this.codex.push({ name: SEA_STRATA[m.idx].name, depth: m.depth, voice: this.voices });
    this.hint = `第 ${this.voices} 个音回来了。`;
    this.sea.call({
      pan: clamp((m.lat - this.lat) * 0.9, -1, 1),
      base: 96, dur: 3.2, vol: 0.16, reach: 1,
    });
    // 等这一声"回应"响完，再把整首歌从头放一遍 ——
    // 玩家会立刻听出来：它比刚才长了，而且刚才那个缺口补上了。
    this._motifIn = 2.0;
    // 沉下去 = 它不会再唱第二遍。图鉴多一页，海里少一只。
    this.mate = null;
  }

  _driftMates() {
    for (const m of this.mates) {
      if (m.answered) continue;
      m.lat0 = clamp(m.lat0 + (this.rnd() - 0.5) * 0.34, -0.88, 0.88);
    }
  }

  /**
   * 献祭：整局只有一件东西可以交出去 —— 海底项链。
   * 交出去换一次完整的呼吸，代价是图鉴永远少一页。
   */
  _sacrifice(dt) {
    const can = this.necklace && this.oxy < 0.22 && this.depth > 0.45 && this.heldT > 0.3;
    if (!can) {
      this.sacrificeT = Math.max(0, this.sacrificeT - dt * 2);
      return;
    }
    this.sacrificing = this.heldT > 1.4;
    this.sacrificeT = clamp(this.heldT / 1.4, 0, 1);
    if (this.sacrificing) {
      this.necklace = false;
      this.sacrificing = false;
      this.oxy = 1;
      this.exposure = 0;
      this.lost += 1;
      this.hint = '你把它交出去了。它没有回来。';
      this.sea.call({ pan: 0, base: 74, dur: 3.4, vol: 0.13, reach: 0.1 });
      this.sea.hull();
    }
  }

  /**
   * 同类：它们不会主动来找你（除了第一只，那是教学）。
   * 你只能听见：一声歌，一个方位，没有距离。
   */
  _mate(dt) {
    let best = null;
    let bestD = 9;
    this._nearMate = 0;
    for (const m of this.mates) {
      m.glow = Math.max(0, m.glow - dt * 0.8);
      if (m.answered) continue;
      // 它会缓慢横游：位置不是坐标，是"刚才大概在那个方向"。
      m.lat = clamp(m.lat0 + Math.sin(this.waveT * 0.11 + m.idx * 1.7) * 0.045, -1, 1);

      const dd = Math.abs(m.depth - this.depth);
      const dl = Math.abs(m.lat - this.lat);
      const dist = Math.hypot(dd * 1.6, dl);
      if (dist < bestD) { bestD = dist; best = m; }

      // 第一只靠得近一点：新手要先体验一次"找到"是什么感觉
      const touch = m.idx === 0 ? 0.075 : 0.055;
      const touchL = m.idx === 0 ? 0.20 : 0.16;
      if (!m.found && dd < touch && dl < touchL) {
        m.found = true;
        m.resp = 0;
        this.hint = '长按 · 回应它';
        this.sea.call({ pan: clamp((m.lat - this.lat) * 0.9, -1, 1), base: 132, dur: 1.4, vol: 0.14, reach: 1 });
      }
      if (m.found && dd < touch * 1.7 && dl < touchL * 1.7) this._nearMate = 1;

      m.nextCall -= dt;
      if (m.nextCall <= 0) {
        m.nextCall = 3.6 + this.rnd() * 2.4;
        const vol = clamp(0.085 - dist * 0.05, 0.014, 0.085);
        this.sea.call({
          pan: clamp((m.lat - this.lat) * 0.9, -1, 1),
          base: 116 + (1 - clamp(m.depth, 0, 1)) * 48,
          dur: 1.8 + this.rnd() * 0.5,
          vol,
          reach: clamp(1 - dist * 0.45, 0.12, 1),
        });
        m.glow = 0.5;
      }
    }
    this.mate = best;
  }

  _kit(dt) {
    const px = this.lat;
    const py = this.depth;

    for (const t of this.kit) {
      t.hit = Math.max(0, (t.hit || 0) - dt * 1.6);

      if (t.type === 'net') {
        // 网是墙：从海面垂下来，只挡到 t.bottom。可以从下面绕，也可以
        // 从上面"跃过去"。它只会慢慢收，不会追。
        const open = 0.5 + Math.sin(this.waveT * 0.42 + t.ph) * 0.5;
        const half = t.w * 0.5 * (0.86 + open * 0.14);
        const inX = Math.abs(px - t.lat) < half + 0.08;
        const inY = py < t.bottom;
        if (inX && inY) this._leak(t, dt, 0.5);
      } else if (t.type === 'hook') {
        const hx = t.lat + Math.sin(this.waveT * t.sp + t.ph) * 0.055;
        if (Math.abs(px - hx) < 0.07 && Math.abs(py - t.depth) < 0.05) {
          this._leak(t, dt, 0.45);
        }
      } else if (t.type === 'plastic') {
        // 塑料：缠住 = 游不动 + 持续耗气。它不会消失。
        if (Math.abs(px - t.lat) < t.r + 0.05 && Math.abs(py - t.depth) < t.r + 0.035) {
          this._leak(t, dt, 0.35);
          this.aimDepth = clamp(this.aimDepth + dt * 0.06, MIN_DEPTH, MAX_DEPTH);
        }
      } else if (t.type === 'slick') {
        if (py < t.bottom) this.exposure = Math.min(1, this.exposure + dt * 0.16);
      } else if (t.type === 'sonar') {
        t.t -= dt;
        if (t.t <= 0) {
          t.t = t.gap;
          this.sea.sonar({ pan: (this.rnd() * 2 - 1) * 0.55 });
          // 被扫到就是被知道了。没有伤害，只有暴露。
          if (this.depth < 0.55) this.exposure = Math.min(1, this.exposure + 0.2);
        }
      } else if (t.type === 'lighthouse') {
        // 「忽明忽灭」：亮的那一下，光柱扫过你，就是被点名
        const k = Math.sin(this.waveT * 1.55 + t.ph);
        t.on = k > 0.12;
        t.k = clamp(k * 1.35, 0, 1);
        if (t.on && Math.abs(px - t.lat) < 0.35 && Math.abs(py - t.d) < 0.3) {
          this.exposure = Math.min(1, this.exposure + dt * 0.46);
        }
      }
    }
  }

  _leak(t, dt, amount) {
    if (t.hit > 0.2) return;
    t.hit = 1.6;
    this.exposure = Math.min(1, this.exposure + amount * 0.5);
    this.oxy = Math.max(0, this.oxy - amount * 0.055);
    // 血引来了海鸥：泄漏的反馈不是红屏，是身后散开的一团红
    // 和海鸥转向它的那一秒。声音只是配的。
    for (let i = 0; i < 10; i++) {
      this.blood.push({
        x: this.lat + (this.rnd() - 0.5) * 0.04,
        y: this.depth + (this.rnd() - 0.5) * 0.03,
        vx: (this.rnd() - 0.5) * 0.10 - this.vL * 0.3,
        vy: (this.rnd() - 0.5) * 0.05 + 0.02,
        life: 1,
        r: 1.5 + this.rnd() * 3,
      });
    }
    this.sea.hull();
  }

  _end(kind) {
    if (this.mode !== 'play') return;
    this.endedAt = this.depth;
    this.endT = 0;
    this.hint = '';
    if (kind === 'A') {
      this.mode = 'endA';
      this.sea.call({ pan: 0, base: 92, dur: 3.4, vol: 0.1, reach: 0.2 });
    } else {
      // 先幻象，后结束。这不是"死亡动画"，是这首歌最后一个画面。
      this.mode = 'vision';
      this.visionT = 0;
      this.sea.motif({ vol: 0.07 });
    }
  }

  /** 幻象走完、世界真正暗下去的那一下。 */
  _endFade() {
    this.endT = 0;
    this.sea.call({ pan: 0, base: 92, dur: 3.4, vol: 0.1, reach: 0.2 });
  }

  screenX(lat) {
    return this.R.w * (0.5 + lat * SX);
  }

  /**
   * 海洋垃圾贴图（128×128，每种只烘一次）。
   *
   * 为什么是四种而不是一种：一片水里漂着八个一模一样的白袋子，读起来是
   * "游戏里的一种收集物"，不是"垃圾"。垃圾的本质是杂 —— 袋子、瓶子、
   * 易拉罐、泡沫块，被同一股洋流推着走，谁也不会腐朽。
   *
   * 为什么是贴图：一帧十块，每块一个 createLinearGradient 就是十个新对象，
   * 而路径画法只能画圆润闭合形 —— 那就是"鹅卵石"的由来。
   */
  _litterTex(kind) {
    if (!this._litter) this._litter = {};
    if (this._litter[kind]) return this._litter[kind];
    const S = 128;
    const c = S * 0.5;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    const noCtx = !g;
    if (noCtx) return (this._litter[kind] = cv);

    if (kind === 'bottle') {
      // 塑料瓶：肩、颈、盖。竖着漂，被水泡得发灰
      g.fillStyle = 'rgba(226, 238, 232, 0.52)';
      g.beginPath();
      g.roundRect ? g.roundRect(c - 17, c - 6, 34, 56, 7) : g.rect(c - 17, c - 6, 34, 56);
      g.fill();
      // 肩部收窄
      g.beginPath();
      g.moveTo(c - 17, c - 6);
      g.quadraticCurveTo(c - 14, c - 26, c - 7, c - 34);
      g.lineTo(c + 7, c - 34);
      g.quadraticCurveTo(c + 14, c - 26, c + 17, c - 6);
      g.closePath();
      g.fill();
      // 瓶盖
      g.fillStyle = 'rgba(180, 200, 196, 0.62)';
      g.fillRect(c - 8, c - 46, 16, 13);
      // 标签：一条褪色的色带。有标签才看得出是"商品"，也才看得出被丢掉了
      g.fillStyle = 'rgba(120, 168, 186, 0.34)';
      g.fillRect(c - 17, c + 8, 34, 18);
      // 高光
      g.strokeStyle = 'rgba(255, 255, 250, 0.42)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(c - 11, c + 2);
      g.lineTo(c - 11, c + 48);
      g.stroke();
    } else if (kind === 'can') {
      // 易拉罐：一个圆柱，凹进去的腰。它比塑料更"人造"
      g.fillStyle = 'rgba(198, 212, 208, 0.50)';
      g.beginPath();
      g.ellipse(c, c - 30, 16, 5, 0, 0, TAU);
      g.fill();
      g.fillRect(c - 16, c - 30, 32, 60);
      g.beginPath();
      g.ellipse(c, c + 30, 16, 5, 0, 0, TAU);
      g.fill();
      // 腰
      g.fillStyle = 'rgba(150, 172, 174, 0.34)';
      g.fillRect(c - 16, c - 2, 32, 16);
      // 拉环口
      g.fillStyle = 'rgba(96, 116, 122, 0.5)';
      g.beginPath();
      g.ellipse(c, c - 30, 7, 2.6, 0, 0, TAU);
      g.fill();
      g.strokeStyle = 'rgba(255, 255, 252, 0.34)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(c - 10, c - 24);
      g.lineTo(c - 10, c + 24);
      g.stroke();
    } else if (kind === 'foam') {
      // 泡沫块：不规则、有孔。渔具和包装的碎块，海上最多的一种
      g.fillStyle = 'rgba(240, 242, 232, 0.44)';
      g.beginPath();
      g.moveTo(c - 38, c - 16);
      g.lineTo(c - 20, c - 32);
      g.lineTo(c + 14, c - 28);
      g.lineTo(c + 36, c - 6);
      g.lineTo(c + 26, c + 26);
      g.lineTo(c - 8, c + 32);
      g.lineTo(c - 34, c + 14);
      g.closePath();
      g.fill();
      // 孔洞：这块"看起来能捏碎"，但捏不碎
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 7; i++) {
        const a = i * 2.399;
        const rr = 4 + (i % 3) * 2.6;
        g.beginPath();
        g.arc(c + Math.cos(a) * (8 + i * 3), c + Math.sin(a) * (6 + i * 2.4), rr, 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = 'rgba(255, 255, 250, 0.26)';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(c - 34, c + 14);
      g.lineTo(c - 20, c - 32);
      g.stroke();
    } else {
      // 塑料袋（bag）：一块被揉过的、四角不齐的薄片
      g.beginPath();
      g.moveTo(c - 40, c - 20);
      g.quadraticCurveTo(c - 26, c - 44, c + 4, c - 40);
      g.quadraticCurveTo(c + 38, c - 36, c + 42, c - 2);
      g.quadraticCurveTo(c + 46, c + 30, c + 12, c + 40);
      g.quadraticCurveTo(c - 24, c + 50, c - 38, c + 20);
      g.quadraticCurveTo(c - 48, c - 2, c - 40, c - 20);
      g.closePath();
      const gr = g.createLinearGradient(c - 44, c - 44, c + 44, c + 44);
      gr.addColorStop(0, 'rgba(246, 250, 244, 0.62)');
      gr.addColorStop(0.42, 'rgba(206, 220, 216, 0.28)');
      gr.addColorStop(1, 'rgba(250, 253, 247, 0.52)');
      g.fillStyle = gr;
      g.fill();

      g.strokeStyle = 'rgba(255, 255, 252, 0.34)';
      g.lineWidth = 1.6;
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(c - 32, c - 12);
      g.quadraticCurveTo(c - 6, c + 2, c + 22, c - 18);
      g.moveTo(c - 26, c + 18);
      g.quadraticCurveTo(c + 4, c + 6, c + 34, c + 16);
      g.moveTo(c - 4, c - 34);
      g.quadraticCurveTo(c + 2, c - 4, c - 12, c + 26);
      g.stroke();

      g.strokeStyle = 'rgba(244, 250, 244, 0.46)';
      g.lineWidth = 2.4;
      g.beginPath();
      g.ellipse(c - 13, c - 38, 7, 4.4, -0.25, Math.PI * 0.05, Math.PI * 1.55);
      g.stroke();
      g.beginPath();
      g.ellipse(c + 13, c - 36, 7, 4.4, 0.22, Math.PI * 1.45, Math.PI * 2.95);
      g.stroke();

      g.globalCompositeOperation = 'destination-out';
      g.beginPath();
      g.moveTo(c + 20, c + 30);
      g.quadraticCurveTo(c + 36, c + 22, c + 44, c + 38);
      g.lineTo(c + 30, c + 46);
      g.closePath();
      g.fill();
    }

    this._litter[kind] = cv;
    return cv;
  }

  /**
   * 珊瑚层（1024×256，两版只烘一次）。
   *
   * 「珊瑚在海底蜿蜒」是「曾是我纯洁的家园」的直接物证 ——
   * 所以它必须存在，而且必须**会褪色**：同一颗种子画两遍，
   * 一遍是活的（暖橙、玫红、青），一遍是白化的（灰白）。
   * 世界每坏一档，活的那张就淡一分，白的那张就浓一分。
   * 玩家第二次经过同一片礁石，认得出来 —— 这比任何台词都狠。
   */
  _coralTex(alive) {
    if (!this._coral) this._coral = {};
    const key = alive ? 1 : 0;
    if (this._coral[key]) return this._coral[key];
    const W = 1024;
    const H = 256;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    if (!g) return (this._coral[key] = cv);
    // 同一颗种子：白化版和活版的形状完全一样，变的只有颜色
    const rnd = mulberry32(4242);
    const PAL = alive
      ? ['rgba(232,130,98,0.88)', 'rgba(226,104,132,0.82)', 'rgba(240,180,98,0.82)', 'rgba(112,192,172,0.72)']
      : ['rgba(212,216,212,0.50)', 'rgba(198,204,200,0.46)', 'rgba(220,224,220,0.46)', 'rgba(194,200,196,0.40)'];

    // 底礁
    g.fillStyle = alive ? 'rgba(24,48,54,0.92)' : 'rgba(28,38,42,0.92)';
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 64) g.lineTo(x, H - 16 - rnd() * 22);
    g.lineTo(W, H);
    g.closePath();
    g.fill();

    // 枝状珊瑚：递归分叉。白化的枝子和活的枝子长在同一个位置
    const branch = (x, y, ang, len, w0, dep, color) => {
      if (dep <= 0 || len < 3) return;
      const x2 = x + Math.cos(ang) * len;
      const y2 = y + Math.sin(ang) * len;
      g.strokeStyle = color;
      g.lineWidth = w0;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x2, y2);
      g.stroke();
      branch(x2, y2, ang - 0.48 - rnd() * 0.3, len * 0.72, w0 * 0.68, dep - 1, color);
      branch(x2, y2, ang + 0.48 + rnd() * 0.3, len * 0.72, w0 * 0.68, dep - 1, color);
    };
    for (let i = 0; i < 14; i++) {
      const x = rnd() * W;
      const y = H - 14 - rnd() * 10;
      branch(x, y, -Math.PI / 2 + (rnd() - 0.5) * 0.6, 24 + rnd() * 16, 4.5 + rnd() * 3, 5, PAL[i % 4]);
    }

    // 管海绵：圆头柱，顶部一个暗口
    for (let i = 0; i < 8; i++) {
      const x = rnd() * W;
      const y = H - 12 - rnd() * 8;
      const hh = 20 + rnd() * 26;
      const ww = 7 + rnd() * 5;
      g.fillStyle = PAL[(i + 1) % 4];
      g.beginPath();
      if (g.roundRect) g.roundRect(x - ww / 2, y - hh, ww, hh, ww / 2);
      else g.fillRect(x - ww / 2, y - hh, ww, hh);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.beginPath();
      g.ellipse(x, y - hh, ww * 0.3, 2.2, 0, 0, TAU);
      g.fill();
    }

    this._coral[key] = cv;
    return cv;
  }

  _slickTex() {
    if (this._slick) return this._slick;
    const cv = document.createElement('canvas');
    cv.width = 8;
    cv.height = 256;
    const g = cv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 256);
    // 顶部必须渐入：从 0 直接到 0.66 会在屏幕上方切出一条硬直线，
    // 那条线读起来是"渲染错误"，不是"油污边界"。
    gr.addColorStop(0, 'rgba(24,14,12,0)');
    gr.addColorStop(0.16, 'rgba(24,14,12,0.62)');
    gr.addColorStop(0.52, 'rgba(34,18,14,0.40)');
    gr.addColorStop(1, 'rgba(34,18,14,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 8, 256);
    this._slick = cv;
    return cv;
  }

  _iridTex() {
    if (this._irid) return this._irid;
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 4;
    const g = cv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 256, 0);
    gr.addColorStop(0, '#7a3f4a');
    gr.addColorStop(0.5, '#3f6a74');
    gr.addColorStop(1, '#6a4a3a');
    g.fillStyle = gr;
    g.fillRect(0, 0, 256, 4);
    this._irid = cv;
    return cv;
  }

  drawEntities(ctx, R) {
    const w = R.w;
    const h = R.h;
    const cam = this.depth;
    const sy = (d) => R.screenYof(d, cam);

    // ---- 珊瑚：浅层的礁盘。世界坏一档，它白化一分 ----
    // 幻象时 coralHealth 被强制拉回 1 —— 花园回来了，然后熄灭。
    {
      const top = sy(0.04);
      const bot = sy(0.24);
      if (bot > 0 && top < h) {
        const health = this.coralHealth;
        const cw = w * 1.34;
        const ch = Math.max(2, bot - top);
        if (health > 0.03) {
          ctx.globalAlpha = health;
          ctx.drawImage(this._coralTex(true), -w * 0.17, top, cw, ch);
        }
        if (health < 0.97) {
          ctx.globalAlpha = 1 - health;
          ctx.drawImage(this._coralTex(false), -w * 0.17, top, cw, ch);
        }
        ctx.globalAlpha = 1;
      }
    }

    // ---- 血雾：受伤的证据。它往上飘，海鸥看得见 ----
    if (this.blood.length) {
      ctx.save();
      for (const b of this.blood) {
        const x = this.screenX(b.x);
        const y = sy(b.y);
        if (y < -20 || y > h + 20) continue;
        ctx.globalAlpha = b.life * 0.34;
        ctx.fillStyle = 'rgba(148,42,38,1)';
        ctx.beginPath();
        ctx.arc(x, y, b.r * (w / 390) * (2.1 - b.life), 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    // =====================================================================
    //  海面之上：城市、冰山、灯塔、船队
    //
    //  这一整块只有"跃出海面"时才会进入画面 —— 它是另一个世界。
    //  玩家在水下待得越久，越容易忘记上面还有东西；而上面那些东西，
    //  正是让他没法安心待在水下的原因。
    // =====================================================================
    const seaY = sy(0);
    if (seaY > -h * 0.12) {
    // ---- 油污：水面被盖住。这不是障碍，是把"呼吸"这条路堵死 ----
    const slick = this.kit.find((t) => t.type === 'slick');
    if (slick) {
      const y0 = sy(slick.top);
      const y1 = sy(slick.bottom);
      if (y1 > -40 && y0 < h + 40) {
        ctx.drawImage(this._slickTex(), 0, y0, w, Math.max(1, y1 - y0));
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.05 + Math.sin(this.waveT * 0.8 + slick.ph) * 0.02;
        ctx.drawImage(this._iridTex(), 0, y0, w, 26);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }

      // ---- 城市：海平线尽头。海和城只隔一条线 ----
      for (const t of this.kit) {
        if (t.type !== 'city') continue;
        const base = Math.max(seaY, -h * 0.05);
        const rnd = mulberry32(8811);
        ctx.save();
        for (let i = 0; i < 16; i++) {
          const bw = w * (0.035 + rnd() * 0.05);
          const bx = (w * i) / 16 - w * 0.02 + rnd() * w * 0.02;
          const bh = h * (0.016 + rnd() * 0.05);
          ctx.fillStyle = 'rgba(3,7,11,0.94)';
          ctx.fillRect(bx, base - bh, bw, bh);
          // 窗灯：极稀。密密麻麻的灯会把"远处的城"变成"电路板"
          if (rnd() < 0.45) {
            ctx.fillStyle = 'rgba(255,206,140,0.42)';
            ctx.fillRect(bx + bw * 0.24, base - bh * 0.68, 1.2, 1.2);
            ctx.fillRect(bx + bw * 0.62, base - bh * 0.38, 1.2, 1.2);
          }
        }
        ctx.restore();
      }

      // ---- 冰山：上面只露一角，下面才是体积 ----
      for (const t of this.kit) {
        if (t.type !== 'berg') continue;
        const x = this.screenX(t.lat);
        const bw = t.w * w * SX * 2;
        ctx.save();
        // 水下部分：更暗、更蓝
        ctx.fillStyle = 'rgba(38,84,102,0.40)';
        ctx.beginPath();
        ctx.moveTo(x - bw * 0.5, seaY);
        ctx.lineTo(x - bw * 0.38, seaY + bw * 0.34);
        ctx.lineTo(x + bw * 0.20, seaY + bw * 0.42);
        ctx.lineTo(x + bw * 0.48, seaY + bw * 0.06);
        ctx.closePath();
        ctx.fill();
        // 水上部分
        ctx.fillStyle = 'rgba(206,226,234,0.78)';
        ctx.beginPath();
        ctx.moveTo(x - bw * 0.5, seaY);
        ctx.lineTo(x - bw * 0.30, seaY - bw * 0.34);
        ctx.lineTo(x - bw * 0.06, seaY - bw * 0.50);
        ctx.lineTo(x + bw * 0.17, seaY - bw * 0.27);
        ctx.lineTo(x + bw * 0.39, seaY - bw * 0.07);
        ctx.lineTo(x + bw * 0.48, seaY);
        ctx.closePath();
        ctx.fill();
        // 一道裂缝：没有它，冰山就是一块白三角
        ctx.strokeStyle = 'rgba(118,160,180,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - bw * 0.11, seaY - bw * 0.42);
        ctx.lineTo(x + bw * 0.02, seaY - bw * 0.15);
        ctx.stroke();
        ctx.restore();
      }

      // ---- 灯塔：岸上的那一盏。忽明忽灭，是这条海岸线唯一的坐标 ----
      for (const t of this.kit) {
        if (t.type !== 'lighthouse') continue;
        const x = this.screenX(t.lat);
        const y = seaY;
        ctx.save();
        // 礁石
        ctx.fillStyle = 'rgba(3,8,12,0.96)';
        ctx.beginPath();
        ctx.moveTo(x - 38, y + 10);
        ctx.quadraticCurveTo(x - 20, y - 12, x + 4, y - 5);
        ctx.quadraticCurveTo(x + 26, y + 1, x + 42, y + 10);
        ctx.closePath();
        ctx.fill();
        // 塔身
        ctx.beginPath();
        ctx.moveTo(x - 7, y - 4);
        ctx.lineTo(x - 4, y - h * 0.125);
        ctx.lineTo(x + 4, y - h * 0.125);
        ctx.lineTo(x + 7, y - 4);
        ctx.closePath();
        ctx.fill();
        const ly = y - h * 0.135;
        if (t.on) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = 'rgba(255,238,190,1)';
          for (let i = 3; i >= 1; i--) {
            ctx.globalAlpha = 0.05 * t.k;
            ctx.beginPath();
            ctx.arc(x, ly, 5 + i * 10, 0, TAU);
            ctx.fill();
          }
          // 扫过海面的光柱：它照的是水上，照不到你
          ctx.globalAlpha = 0.05 * t.k;
          ctx.beginPath();
          ctx.moveTo(x, ly);
          ctx.lineTo(x - w * 0.36, y + h * 0.02);
          ctx.lineTo(x - w * 0.30, y + h * 0.06);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 0.88 * t.k;
          ctx.beginPath();
          ctx.arc(x, ly, 3.2, 0, TAU);
          ctx.fill();
        } else {
          ctx.globalAlpha = 0.34;
          ctx.fillStyle = 'rgba(130,120,96,1)';
          ctx.beginPath();
          ctx.arc(x, ly, 2.1, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
      }

      // ---- 船队：满载而去 ----
      // 渔船在夜里是灯火通明的：一排渔灯把海面照成橙色，灯火倒在水里。
      // 越到后期船越多、灯越亮 —— 「海上谁领唱满载而去的歌」。
      //
      // **不能等距同高**：第一版是 8 艘同 y、同间隔、每艘 6 盏灯排成一行，
      // 在手机屏上读起来是"一排亮着窗的楼房"，不是船队。真实夜海里的船队是
      // 错落的 —— 近的船大、压得低、亮；远的船只剩几点灯，几乎贴着海平线。
      // 所以每艘船的三件事都带抖动：纵向位置、大小、灯的个数。
      const stage = this.stage;
      const boatN = Math.min(9, 3 + Math.round(stage * 1.5));
      const lampA = 0.5 + stage * 0.14;
      const fleet = this.kit.filter((k) => k.type === 'fleet');
      // 稳定哈希：同一个 bi 每帧得到同一个值，船不会抖成癫痫
      const H = (n) => {
        const v = Math.sin((n + 1) * 12.9898 + 4.1414) * 43758.5453;
        return v - Math.floor(v);
      };
      for (let bi = 0; bi < boatN; bi++) {
        const t = fleet[bi % Math.max(1, fleet.length)];
        if (!t) break;
        const dk = H(bi * 3.7);              // 0 = 最远，1 = 最近
        const far = dk < 0.34;               // 远处的船：只给灯，不给船体
        // 横向：均匀铺开后加抖动，别排成栅栏
        const baseLat = -0.94 + (bi + 0.5) * (1.88 / boatN);
        const lat = baseLat + (H(bi * 7.1) - 0.5) * (0.9 / boatN) + Math.sin(this.waveT * 0.10 + t.ph) * 0.012;
        const x = this.screenX(lat);
        // 远的靠上（贴海平线），近的压下来；这是唯一能读出纵深的线索
        const y = seaY + h * (0.004 + dk * 0.020);
        const s = t.scale * (w / 390) * (0.40 + stage * 0.035) * (0.70 + dk * 0.52);
        if (y > h + 90 || y < -h * 0.32) continue;

        ctx.save();
        ctx.globalAlpha = 0.55 + dk * 0.42;
        // 每艘船微微歪一点：一排完全水平的船也是"楼房"感的来源
        ctx.translate(x, y);
        ctx.rotate((H(bi * 5.3) - 0.5) * 0.035);
        ctx.translate(-x, -y);

        if (!far) {
          // 船体：深蓝而不是纯黑 —— 纯黑剪影像纸板，被灯照着的船一定带一点颜色。
          // 船首要抬起来（一艘平顶平底的方盒子，怎么画都是驳船/楼房）。
          ctx.fillStyle = 'rgba(10,20,30,0.96)';
          ctx.beginPath();
          ctx.moveTo(x - 34 * s, y - 4 * s);
          ctx.quadraticCurveTo(x - 8 * s, y + 9 * s, x + 18 * s, y + 5 * s);
          ctx.lineTo(x + 36 * s, y - 2 * s);      // 船首：更高、更尖
          ctx.lineTo(x + 30 * s, y - 13 * s);
          ctx.lineTo(x - 20 * s, y - 16 * s);      // 甲板线往船首翘
          ctx.closePath();
          ctx.fill();
          // 驾驶楼
          ctx.fillRect(x - 12 * s, y - 27 * s, 18 * s, 13 * s);
          // 上缘月光
          ctx.strokeStyle = 'rgba(158,198,218,0.28)';
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(x + 36 * s, y - 4 * s);
          ctx.lineTo(x + 26 * s, y - 14 * s);
          ctx.lineTo(x - 24 * s, y - 14 * s);
          ctx.stroke();
          // 桅杆 + 吊臂
          ctx.strokeStyle = 'rgba(10,20,30,0.96)';
          ctx.lineWidth = 1.1 * s;
          ctx.beginPath();
          ctx.moveTo(x - 3 * s, y - 27 * s);
          ctx.lineTo(x - 7 * s, y - 54 * s);
          ctx.moveTo(x + 4 * s, y - 14 * s);
          ctx.lineTo(x + 30 * s, y - 34 * s);
          ctx.stroke();
        }

        // ---- 灯。渔船夜里不是一盏灯，是一串 ----
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(255,224,170,1)';
        if (!far) {
          // 桅顶灯
          ctx.globalAlpha = 0.9 * lampA;
          ctx.beginPath();
          ctx.arc(x - 6 * s, y - 53 * s, 1.6 * s, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 0.18 * lampA;
          ctx.beginPath();
          ctx.arc(x - 6 * s, y - 53 * s, 7 * s, 0, TAU);
          ctx.fill();
          // 驾驶楼窗灯
          ctx.globalAlpha = 0.75 * lampA;
          ctx.fillStyle = 'rgba(255,214,150,1)';
          ctx.fillRect(x - 9 * s, y - 24 * s, 3 * s, 2.4 * s);
          ctx.fillRect(x - 4 * s, y - 24 * s, 3 * s, 2.4 * s);
          ctx.fillStyle = 'rgba(255,224,170,1)';
        }
        // 船舷渔灯：**不是一排等距亮点**。
        // 上一版每艘船 6 盏灯等距排开 + 每盏下面 4 段等长倒影，在 390pt 的屏上
        // 就是"楼房的窗格"。真实夜里的渔船是 2~3 点灯 + 水面一团晕开的光。
        const lampN = far ? 1 : 2 + Math.round(H(bi * 9.1) * 2);
        for (let li = 0; li < lampN; li++) {
          const spread = far ? 5 * s : 34 * s;
          const lx = x - spread * 0.5 + (li * spread) / Math.max(1, lampN - 1) + (H(bi * 13 + li) - 0.5) * 4 * s;
          const ly = y - (far ? 2 : 10) * s + (H(bi * 11 + li) - 0.5) * 3 * s;
          ctx.globalAlpha = 0.95 * lampA * (far ? 0.7 : 1);
          ctx.beginPath();
          ctx.arc(lx, ly, (far ? 1.8 : 2.4) * s, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 0.14 * lampA;
          ctx.beginPath();
          ctx.arc(lx, ly, (far ? 4 : 6.5) * s, 0, TAU);
          ctx.fill();
        }
        // 水面倒影：整艘船一条晕开的暖光，长度不齐 —— 比一排等长的小方块真。
        // 有倒影，灯才"在水上"，而不是贴在船舷上。
        const rw = (far ? 6 : 22) * s;
        ctx.globalAlpha = 0.085 * lampA;
        ctx.fillStyle = 'rgba(255,206,140,1)';
        ctx.beginPath();
        ctx.ellipse(x, y + 9 * s, rw, 5 * s, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 0.20 * lampA;
        for (let ri = 0; ri < 3; ri++) {
          const rwid = rw * (0.8 - ri * 0.2) * (0.7 + H(bi * 17 + ri) * 0.6);
          ctx.fillRect(x - rwid * 0.5, y + (5 + ri * 5) * s, rwid, (1.8 - ri * 0.35) * s);
        }
        ctx.restore();
      }

      // ---- 冰山消融：第三阶段起，它裂了。碎冰漂走，回不来了 ----
      if (stage >= 3) {
        for (const t of this.kit) {
          if (t.type !== 'berg') continue;
          const bx = this.screenX(t.lat);
          const bw = t.w * w * SX * 2;
          ctx.save();
          // 碎冰：两块，随时间慢慢漂远、下沉
          for (let ci = 0; ci < 2; ci++) {
            const off = (ci + 1) * (bw * 0.55 + this.waveT * 2.2 * (ci + 1));
            const cx = bx + bw * 0.55 + off * 0.35;
            const cy = seaY + Math.sin(this.waveT * 0.4 + ci) * 2;
            ctx.fillStyle = 'rgba(196,220,230,0.66)';
            ctx.beginPath();
            ctx.moveTo(cx - 7, cy);
            ctx.lineTo(cx - 2, cy - 9 - ci * 3);
            ctx.lineTo(cx + 5, cy - 3);
            ctx.lineTo(cx + 8, cy);
            ctx.closePath();
            ctx.fill();
          }
          // 本体缺口：从裂缝那侧削掉一块
          ctx.globalCompositeOperation = 'destination-out';
          ctx.beginPath();
          ctx.moveTo(bx + bw * 0.0, seaY - bw * 0.5);
          ctx.lineTo(bx + bw * 0.2, seaY - bw * 0.2);
          ctx.lineTo(bx + bw * 0.3, seaY - bw * 0.45);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }

      // ---- 城市：车水马龙。第二阶段起，楼群里有了移动的光 ----
      if (stage >= 2) {
        const base = Math.max(seaY, -h * 0.05);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let ci = 0; ci < 3; ci++) {
          // 车灯：一对（白前灯 + 红尾灯），沿海平线上方一条路往返
          const period = 9 + ci * 5;
          const ph = (this.waveT / period + ci * 0.37) % 1;
          const cx = w * (ph < 0.5 ? ph * 1.6 : (1 - ph) * 1.6) + w * 0.06 * ci;
          const cy = base - h * 0.012;
          const dir = ph < 0.5 ? 1 : -1;
          ctx.globalAlpha = 0.6;
          ctx.fillStyle = 'rgba(255,240,200,1)';
          ctx.fillRect(cx, cy - 1.2, 2.6, 1.6);
          ctx.fillStyle = 'rgba(255,120,90,1)';
          ctx.fillRect(cx - 3.4 * dir, cy - 1.2, 2.2, 1.6);
          ctx.globalAlpha = 0.12;
          ctx.beginPath();
          ctx.arc(cx, cy, 5, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // ---- 洋流：横向流动的水带。它不挡路，它只是不问你同不同意 ----
    for (const t of this.kit) {
      if (t.type !== 'current') continue;
      const yc = sy(t.d);
      const hh = t.h * h * 2;
      const y0 = yc - hh * 0.5;
      if (y0 > h || y0 + hh < 0) continue;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 2.1;
      // 用虚线滚动做"流动"，比画一堆粒子便宜，而且方向一定读得对
      ctx.setLineDash([70, 210]);
      ctx.lineDashOffset = -this.waveT * 62 * t.dir;
      for (let i = 0; i < 5; i++) {
        const yy = y0 + (hh * (i + 0.5)) / 5;
        const a = 0.085 * (1 - Math.abs(i - 2) / 3);
        ctx.strokeStyle = `rgba(126,206,228,${a})`;
        ctx.beginPath();
        ctx.moveTo(-20, yy);
        ctx.lineTo(w + 20, yy);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- 船：它从来不下来。它只在上面 ----
    for (const t of this.kit) {
      if (t.type !== 'boat') continue;
      const x = this.screenX(t.lat + Math.sin(this.waveT * 0.15 + t.ph) * 0.05);
      // 水面跑到画面外时，船影仍然贴着画面顶部露一点。
      // 从水下抬头，船是头顶的一块暗影 —— 看不见反而像"船凭空消失了"。
      const y = Math.max(sy(0), -h * 0.055);
      if (y > h + 90) continue;
      ctx.save();
      ctx.fillStyle = 'rgba(3,8,12,0.96)';
      ctx.beginPath();
      ctx.moveTo(x - w * 0.19, y - h * 0.010);
      ctx.quadraticCurveTo(x, y + h * 0.026, x + w * 0.19, y - h * 0.010);
      ctx.lineTo(x + w * 0.152, y - h * 0.046);
      ctx.lineTo(x - w * 0.152, y - h * 0.046);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - w * 0.048, y - h * 0.084, w * 0.096, h * 0.038);
      ctx.strokeStyle = 'rgba(3,8,12,0.96)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x - w * 0.02, y - h * 0.084);
      ctx.lineTo(x - w * 0.055, y - h * 0.19);
      ctx.stroke();
      // 吊臂：网和钩就是从这根东西上放下来的
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.03, y - h * 0.07);
      ctx.lineTo(x + w * 0.13, y - h * 0.028);
      ctx.stroke();
      ctx.restore();
    }

    // ---- 网：墙。只画到它真正挡住的那个深度 ----
    // 上一版是"一个大矩形 + 横竖正交网格"，在手机屏上就是一张方格纸：
    // 玩家读到的是辅助线，不是网。真实流网是三件事：菱形网目、下缘兜成一条弧、
    // 越往上越淡（水越深的地方才有光）。三样都补上，它才像块布挂在水里。
    for (const t of this.kit) {
      if (t.type !== 'net') continue;
      const open = 0.5 + Math.sin(this.waveT * 0.42 + t.ph) * 0.5;
      const half = t.w * 0.5 * (0.86 + open * 0.14);
      const x0 = this.screenX(t.lat - half);
      const x1 = this.screenX(t.lat + half);
      const ww = x1 - x0;
      if (ww < 8) continue;
      // 顶沿压在水面线以下：相机跃出水面时，网会在海平线上方露出一截，
      // 那看起来就是"渔网飘在天上"。网是从船上放进水里的，它永远不高于水面。
      const seaY = sy(0);
      const yTop = Math.max(sy(-0.02), seaY);   // y 向下增大：取大的那个才是"在水面以下"
      const yBot = sy(t.bottom);
      if (yBot < 0 || yTop > h) continue;
      const sag = 8 + open * 10;          // 下缘兜下去的那一点
      const cx = (x0 + x1) * 0.5;

      ctx.save();
      // 网的形状：上宽下收、底下兜一条弧。clip 之后所有线条都不会铺出网外。
      ctx.beginPath();
      ctx.moveTo(x0, yTop);
      ctx.lineTo(x1, yTop);
      ctx.lineTo(x1, yBot);
      ctx.quadraticCurveTo(cx, yBot + sag * 2, x0, yBot);
      ctx.closePath();
      ctx.clip();

      // 网面只留一层极薄的暗：实心一铺就变成黑布帘
      ctx.fillStyle = 'rgba(8,20,26,0.13)';
      ctx.fill();

      // 上缘的浮纲 + 浮子：一条亮绳。没有它，网就是"从天上垂下来的纱"；
      // 有了它，玩家立刻明白"这是船上放下来的"。这是整块网最便宜的一笔。
      const fy = yTop + 5;
      ctx.strokeStyle = 'rgba(210,206,180,0.34)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x0, fy);
      ctx.quadraticCurveTo(cx, fy + 4, x1, fy);
      ctx.stroke();
      ctx.fillStyle = 'rgba(232,196,120,0.55)';
      for (let i = 1; i < 4; i++) {
        const k = i / 4;
        const bx = (1 - k) * (1 - k) * x0 + 2 * (1 - k) * k * cx + k * k * x1;
        const by = (1 - k) * (1 - k) * fy + 2 * (1 - k) * k * (fy + 4) + k * k * fy;
        ctx.beginPath();
        ctx.arc(bx, by, 2.6, 0, TAU);
        ctx.fill();
      }

      const cell = 13 * (w / 390);
      const slope = 0.62;                  // 约 58°，接近真实网目的夹角
      const yA = Math.max(yTop, -60);
      const yB = Math.min(yBot + sag * 2, h + 60);
      const span = yB - yA;
      if (span > 0) {
        // 菱形网目：两组斜线，一左一右。斜线读成"网"，正交读成"格"。
        // 一条 path 一次 stroke —— 两张网一帧也就六次绘制。
        // 分三段画是为了上缘淡出（主循环里不新建渐变对象）。
        for (let band = 0; band < 3; band++) {
          const ya = yA + (span * band) / 3;
          const yb = yA + (span * (band + 1)) / 3;
          const sh = yb - ya;
          ctx.strokeStyle = `rgba(158,196,210,${0.09 + band * 0.075})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let x = x0 - span * slope; x < x1 + span * slope; x += cell) {
            ctx.moveTo(x, ya);
            ctx.lineTo(x + sh * slope, yb);
            ctx.moveTo(x, ya);
            ctx.lineTo(x - sh * slope, yb);
          }
          ctx.stroke();
        }

        // 下缘的纲绳：网得有重量，不然像浮着的纱
        ctx.strokeStyle = 'rgba(12,26,32,0.88)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x0, yBot);
        ctx.quadraticCurveTo(cx, yBot + sag * 2, x1, yBot);
        ctx.stroke();
        // 坠子：沿纲绳挂一串
        ctx.fillStyle = 'rgba(10,24,30,0.92)';
        for (let i = 1; i < 6; i++) {
          const k = i / 6;
          // 二次贝塞尔在 k 处的点
          const px = (1 - k) * (1 - k) * x0 + 2 * (1 - k) * k * cx + k * k * x1;
          const py = (1 - k) * (1 - k) * yBot + 2 * (1 - k) * k * (yBot + sag * 2) + k * k * yBot;
          ctx.beginPath();
          ctx.arc(px, py, 2.2, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // ---- 鱼钩：线细到几乎看不见，只留一点反光 ----
    // 上一版把整根线从水面画到钩子：15 根贯穿全屏的直线，在竖屏上就是一张
    // 方格纸的经线（截图里最刺眼的那层网格就是它）。真实的长线在水里只有
    // 紧挨钩子的那一小截被光照到，往上一米就沉进黑里。
    // 所以只画 1.5 屏内的一小段，并且越往上越淡 —— 剩下的是黑，不是线。
    for (const t of this.kit) {
      if (t.type !== 'hook') continue;
      const x = this.screenX(t.lat + Math.sin(this.waveT * t.sp + t.ph) * 0.055);
      const y = sy(t.depth);
      if (y < -40 || y > h + 60) continue;
      const seg = Math.min(132, h * 0.16);
      for (let i = 0; i < 3; i++) {
        const y1 = y - 12 - (seg * i) / 3;
        const y2 = y - 12 - (seg * (i + 1)) / 3;
        ctx.strokeStyle = `rgba(170,206,216,${0.19 - i * 0.055})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y1);
        // 一点微弯：直线太硬，会像标尺
        ctx.quadraticCurveTo(
          x + Math.sin(this.waveT * 0.6 + t.ph + i) * 1.6,
          (y1 + y2) * 0.5,
          x, y2
        );
        ctx.stroke();
      }
      // 钩子本体
      ctx.strokeStyle = 'rgba(196,224,232,0.44)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - 12);
      ctx.lineTo(x, y - 4);
      ctx.arc(x - 5, y - 4, 5, 0, Math.PI, false);
      ctx.stroke();
    }

    // ---- 垃圾：乳白色蜉蝣。它不会腐朽，也不会走开 ----
    // 四种混着漂：袋子、瓶子、罐子、泡沫块。全是人类丢的，全都不烂。
    for (const t of this.kit) {
      if (t.type !== 'plastic') continue;
      const x = this.screenX(t.lat + Math.sin(this.waveT * 0.5 + t.ph) * 0.02);
      const y = sy(t.depth);
      const pr = t.r * w * SX * 1.75;
      const L = LITTER_SHAPE[t.kind] || LITTER_SHAPE.bag;
      const hw = pr * L.w;
      const hh = pr * L.h;
      if (y < -hh * 2 || y > h + hh * 2) continue;
      const fog = clamp(1 - (t.depth - 0.3) * 0.62, 0.26, 1);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(this.waveT * 0.4 + t.ph) * 0.35 + t.ph);
      // 瓶子罐子会慢慢翻身：它们不甘心一直朝着一个方向
      ctx.globalAlpha = 0.58 * fog;
      ctx.drawImage(this._litterTex(t.kind), -hw, -hh, hw * 2, hh * 2);
      ctx.restore();
    }

    // ---- 鱼群：不参与玩法，但水里有没有活物是两回事 ----
    if (this.fish.length) {
      ctx.save();
      ctx.fillStyle = 'rgba(146,204,222,0.55)';
      ctx.beginPath();
      for (const f of this.fish) {
        const x = this.screenX(f.lat);
        const y = sy(f.depth);
        if (y < -24 || y > h + 24 || x < -30 || x > w + 30) continue;
        const s = f.size * (w / 390) * 3.4;
        // 身 + 尾合成一条路径，一次 fill；22 条鱼也只算一次绘制
        ctx.moveTo(x + s * 1.6, y);
        ctx.ellipse(x, y, s * 1.6, s * 0.66, 0, 0, TAU);
        ctx.moveTo(x - s * 1.4, y);
        ctx.lineTo(x - s * 2.3, y - s * 0.68);
        ctx.lineTo(x - s * 2.3, y + s * 0.68);
        ctx.closePath();
      }
      ctx.fill();
      ctx.restore();
    }

    // ---- 海鸥：数量等于你的暴露度。它们不咬人，只证明你被看见了 ----
    if (this.gulls.length) {
      const wy = sy(0);
      if (wy > -60 && wy < h + 60) {
        ctx.save();
        ctx.fillStyle = 'rgba(5,12,18,0.9)';
        for (const g of this.gulls) {
          const x = this.screenX(g.lat + Math.sin(g.ph) * 0.05);
          const y = wy - 14 - Math.sin(g.ph * 1.3) * 9;
          const s = g.r * w * 0.15;
          const flap = Math.sin(g.ph * 4) * 0.5 + 0.5;
          ctx.beginPath();
          ctx.moveTo(x - s, y);
          ctx.quadraticCurveTo(x - s * 0.5, y - s * 0.55 * flap, x, y + s * 0.1);
          ctx.quadraticCurveTo(x + s * 0.5, y - s * 0.55 * flap, x + s, y);
          ctx.quadraticCurveTo(x + s * 0.5, y - s * 0.25 * flap, x, y + s * 0.22);
          ctx.quadraticCurveTo(x - s * 0.5, y - s * 0.25 * flap, x - s, y);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // ---- 同类：另外那些鲸。不发声时只是一团轮廓 ----
    // 只画听得见的那一只（dist < 0.42）。远处的同类一笔都不给 ——
    // 这篇的规则是"听见才有方向"，不是"地图上有个点"。
    for (const m of this.mates) {
      if (m.answered) continue;
      const y = sy(m.depth);
      if (y < -h * 0.35 || y > h * 1.35) continue;
      const dist = Math.hypot((m.depth - this.depth) * 1.6, m.lat - this.lat);
      if (dist > 0.30) continue;
      const x = this.screenX(m.lat);
      const vis = clamp(1.1 - dist * 1.1, 0.06, 1) * (0.26 + this.echo * 0.58 + m.glow * 0.44);
      ctx.save();
      if (this.art && this.art.ready) {
        this.art.draw(ctx, x, y, R.w * 0.42, {
          time: R.time,
          phase: R.time * 2.4 + 1.1,
          echo: this.echo * 0.6,
          tilt: 0.02,
          flip: true,
          depth: clamp(m.depth, 0, 1),
          screenH: h,
          mouth: 0.22,
          alpha: clamp(vis, 0, 0.52),
        });
      } else {
        R.drawWhale(x, y, R.w * 0.42, {
          tilt: 0.02,
          phase: R.time * 2.4 + 1.1,
          depth: clamp(m.depth, 0, 1),
          echo: this.echo * 0.6,
          silhouette: true,
        });
      }
      ctx.restore();
    }

    // 方位：只给最近那一只，只给方向不给距离。
    // 它就在屏幕里的时候不画 —— 看得见的东西不需要箭头。
    const gm = this.mate;
    if (gm && !gm.answered && (gm.depth - this.depth > 0.22 || Math.abs(gm.lat - this.lat) > 0.28)) {
      const y = sy(gm.depth);
      const cx = w * 0.5;
      const cy = h * 0.52;
      const dx = (gm.lat - this.lat) * w * SX;
      const dy = y - cy;
      const ang = Math.atan2(dy, dx);
      const rad = Math.min(w, h) * 0.34;
      const pulse = 0.5 + Math.sin(R.time * 2.4) * 0.5;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(150,226,246,${0.16 + pulse * 0.22})`;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(cx, cy, rad + pulse * 8, ang - 0.24, ang + 0.24);
      ctx.stroke();
      ctx.fillStyle = `rgba(170,236,252,${0.3 + pulse * 0.26})`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, 2.8, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // ---- 水面撞回来：一道横向的白痕，就是"鱼缸的盖子" ----
    if (this.bump > 0.02) {
      const y = sy(SURFACE_SKIN);
      if (y > -40 && y < h + 40) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 3; i++) {
          const k = this.bump - i * 0.22;
          if (k <= 0) continue;
          ctx.strokeStyle = `rgba(180,226,240,${k * 0.32})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(w * 0.5, y, w * (0.12 + i * 0.14), 5 + i * 4, 0, 0, TAU);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // ---- 隐形边界：撞上去的那一下，水会皱起来 ----
    if (this.wallHit > 0.01) {
      const x = this.wallX > 0 ? w * 0.94 : w * 0.06;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const k = (this.wallHit - i * 0.18) / 1;
        if (k <= 0) continue;
        ctx.strokeStyle = `rgba(150,210,230,${k * 0.28})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(x, h * 0.52, 8 + i * 9, h * 0.4, 0, -Math.PI * 0.32, Math.PI * 0.32);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ---------------------------------------------------------
  //  HUD
  // ---------------------------------------------------------

  hud() {
    const S = this.cur;
    // 气不够的时候，叙事文案必须让位给"现在该干什么"。
    let hint = this.hint;
    if (this.mode === 'play') {
      const m = this.mate;
      if (this.bump > 0.45) hint = '你被看见了。';
      else if (this.surfaceT > 0.5) hint = '别动。就这样回去。';
      else if (this.codex.length >= 5 && this.depth < SURFACE_D - 0.02) hint = '停在这里 —— 你可以回去。';
      else if (m && m.found && !m.answered) hint = '长按 · 回应它';
      else if (this.oxy < 0.30) hint = '气不够了。浮上去。';
      // 不能写 !m —— mate 是"最近的那一只"，没更新前是 null，
      // 会对着有同类的层也喊"没有回应"。要判的是"附近到底有没有还没回应的"。
      else if (!this.mates.some((x) => !x.answered && Math.abs(x.depth - this.depth) < 0.30)) {
        hint = '这一段没有回应。往下。';
      }
    }
    return {
      mode: this.mode,
      // 深度就是进度条：没有"第几波"，只有"你现在多深"
      depth: this.depth,
      depthMax: MAX_DEPTH,
      strata: S.name,
      strataIdx: SEA_STRATA.indexOf(S) + 1,
      strataAll: SEA_STRATA.length,
      oxygen: clamp(this.oxy, 0, 1),
      oxySec: Math.ceil(clamp(this.oxy, 0, 1) * OXY_SEC),
      exposure: this.exposure,
      band: this.depth < SURFACE_D ? 'surface' : this.depth > ABYSS_D ? 'abyss' : 'mid',
      singing: this.singing,
      voices: this.voices,
      voicesAll: 7,
      mateFound: !!(this.mate && this.mate.found && !this.mate.answered),
      mateResp: this.mate ? clamp(this.mate.resp / 1.8, 0, 1) : 0,
      sacrifice: this.sacrificeT,
      canSacrifice: this.necklace && this.oxy < 0.22 && this.depth > 0.45,
      necklace: this.necklace,
      codex: this.codex.length,
      dives: this.dives,
      endedAt: this.endedAt,
      reached: this.depth > 0.97,
      hint,
      dark: this.dark,
      life: this.life,
      // 世界阶段：海面有多坏、水有多浑、珊瑚白了没，全由它一个数决定
      stage: this.stage,
      murk: this.murk,
      vision: this.visionK,
      visionMode: this.mode === 'vision',
      blood: this.blood.length,
    };
  }
}
