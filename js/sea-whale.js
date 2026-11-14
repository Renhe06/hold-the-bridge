// ---------------------------------------------------------------------------
//  第五关上篇「跃」· 鲸的贴图层
//
//  沿用的是项目里已经定过案的「身体 + 可动件」两层法（见 js/render.js 4139 行起，
//  用户 m09695 关于花仙子翅膀的决策），只是鲸多了一个可动件，所以是三层：
//    whale-body（本体 + 可动件的拖影版） → whale-fluke（尾鳍） → whale-fin（胸鳍）
//
//  画序：尾鳍 → 远侧胸鳍 → 身体 → 近侧胸鳍 → 头（可选张嘴件）。
//  尾鳍画在身体之前，是为了让尾柄盖住它的根部 —— 转起来才不会有缝。
//
//  为什么不用切片变形（这条我算过账，写在这里免得以后又试一遍）：
//    鲸体长 1100px、尾摆振幅 3.2% 体长、波长 0.9 体长 → 位移斜率 0.22px/px。
//    27px 宽的切片之间会差 6px，屏幕上就是一道看得见的台阶。
//    要压到 1px 以内得切 240 条，每帧 240 次 drawImage，手机直接掉帧。
//    所以形变改用**剪切（skewY）+ 分件旋转**：数学上连续，零接缝，一次 drawImage。
//
//  性能：源图 1536 宽、显示约 1000 宽，逐帧重采样太贵（花仙子那条经验是 +18ms/帧），
//  所以按显示尺寸烘一层缓存，正常帧只做小尺寸 blit。尺寸变了才重烘。
// ---------------------------------------------------------------------------

import { clamp, mulberry32 } from './util.js';

/** 本文件里画伤痕要用到整圈；sea-game 里那份常量不跨模块，这里自带一个。 */
const TAU = Math.PI * 2;

export class SeaWhale {
  constructor() {
    this.parts = null;
    this.ready = false;
    this.kind = 'none'; // 'img' | 'mock' | 'none'
    // 归一化枢轴（画布宽高的 0~1）。图上标了就用图上的，没标先用这组默认值。
    this.pivots = {
      // 尾柄：alpha 列剖面扫出来的。尾鳍在 x 0.13~0.28 只有 140px 高（两片薄叶片），
      // 身体从 x 0.31 起一下子粗到 280px —— 转折点就是尾柄。
      // 枢轴要落在**身体内部**（0.35），不能正好压在挖空带上：
      // 压在挖空带上时，尾巴一转头就落在空地上，露出残影，屏幕上就是"尾柄断裂"。
      fluke: [0.35, 0.44],
      fin: [0.545, 0.545],
      neck: [0.760, 0.470],
    };
    // 尾鳍裁切带（横向渐变，不是硬切）：0.28 之前全算尾鳍，0.34 之后全算身体。
    // 右端必须小于枢轴，否则枢轴周围没有身体兜住尾根。
    this.tailCut = [0.28, 0.34];
    this._baked = null;
  }

  /** 单张图加载；失败返回 null，不抛 —— 缺件必须能降级，不能把角色整个弄丢 */
  _img(url) {
    return new Promise((res) => {
      if (typeof Image === 'undefined') return res(null);
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = url;
    });
  }

  /**
   * 加载分层图。整图缺失但有本体也能用；本体也缺就返回 false，调用方退回矢量占位。
   * @param dir 目录，默认 './img/sea/'
   */
  async load(dir = './img/sea/') {
    // 允许 png / webp 两种后缀：AI 出图和白底抠图产出的都是 png，
    // 而项目里其它资源是 webp —— 谁先找到用谁，找不到的静默跳过（缺件要能降级）。
    const pick = async (base) => {
      for (const ext of ['png', 'webp']) {
        const im = await this._img(dir + base + '.' + ext);
        if (im) return im;
      }
      return null;
    };
    const [full, body, fluke, fin, finFar, mouth] = await Promise.all([
      pick('whale'),
      pick('whale-body'),
      pick('whale-fluke'),
      pick('whale-fin'),
      pick('whale-fin-far'),
      pick('whale-mouth'),
    ]);
    if (!full && !body) return false;
    this.parts = {
      full: full || body,
      body: body || full,
      // 缺分件就留 null：尾鳍/胸鳍的摆动会自动跳过，其余动态照常
      fluke: fluke || null,
      fin: fin || null,
      finFar: finFar || null,
      mouth: mouth || null,
    };
    this.ready = true;
    this.kind = 'img';
    this._baked = null;
    return true;
  }

  /** 直接接管一张现成的图（canvas 或 Image）。给 ?sprite=mock 和以后的内嵌资源用。 */
  adopt(src) {
    this.parts = { full: src, body: src, fluke: null, fin: null, finFar: null, mouth: null };
    this.ready = true;
    this.kind = 'mock';
    this._baked = null;
    return true;
  }

  /**
   * 按显示尺寸烘一层缓存。键里带取整后的宽度 —— 屏幕转一下就会重烘，
   * 但不转的时候一帧都不重采样。
   */
  _bake(L) {
    const key = Math.round(L);
    if (this._baked && this._baked.key === key) return this._baked;
    const src = this.parts.body;
    const w = Math.max(8, key);
    const h = Math.max(8, Math.round(w * (src.height / src.width)));
    const make = (img) => {
      if (!img) return null;
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const g = cv.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, w, h);
      return cv;
    };
    // 三层结构（顺序就是画序，见下面 paint）：
    //   residue（压暗的旧尾鳍，填住尾鳍转开后留下的空位）
    //   → fluke（可动尾鳍，绕尾柄转）
    //   → body（挖掉尾鳍的身体，盖住尾鳍根部）
    // body 一定要挖空：不挖会看到"两条尾巴"——一条在转，一条钉在原地。
    const fullBody = make(this.parts.body);
    const b = {
      key,
      w,
      h,
      // full 是不挖尾的整图：伤痕层要拿它做遮罩（尾巴上的塑料袋不能被挖掉）
      full: fullBody,
      body: this._cutTail(fullBody),
      residue: this._tailResidue(fullBody),
      // 给了独立尾鳍图就用它；没给（AI 出图的常态）就从整图自己裁一片
      fluke: this.parts.fluke ? make(this.parts.fluke) : this._cropTail(fullBody),
      fin: make(this.parts.fin),
      finFar: make(this.parts.finFar),
      mouth: make(this.parts.mouth),
      glow: null,
      deep: null,
    };
    // 光晕用未挖空的整图，轮廓才完整
    b.glow = this._bakeGlow(fullBody);
    // 污染层：整条鲸慢慢变脏的那一层（连续量，画的时候只改 alpha）
    b.grime = this._bakeGrime(fullBody, w, h);
    // 深处版本：按水下雾化模型预烘一档"最深"，画的时候用 alpha 交叉淡入。
    // 不做实时 filter —— 移动端 Canvas 2D 的 filter 极慢，而且 iOS 16.4 以下根本不支持。
    const DEEP = 0.92;
    b.deep = {
      body: this._depthGrade(b.body, DEEP),
      residue: this._depthGrade(b.residue, DEEP),
      fluke: this._depthGrade(b.fluke, DEEP),
      fin: this._depthGrade(b.fin, DEEP),
      finFar: this._depthGrade(b.finFar, DEEP),
      mouth: this._depthGrade(b.mouth, DEEP),
    };
    this._baked = b;
    return b;
  }

  /**
   * 水下雾化。物理模型：C = C物体 × T + C水 × (1 − T)，T 随深度指数衰减。
   *
   * 为什么不能用"叠一层半透明蓝"（上一版就是这么干的，结果像贴纸）：
   * 叠色只能压暗，压不掉对比度 —— 鲸身上的亮斑和深蓝仍然差 200 个色阶，
   * 所以它在暗水里依然是"高饱和剪影"。真实的水下，远处物体的细节是被水色**吃掉**的，
   * 表现为整体向水色收敛、明暗差被压缩。这个模型天然做到这一点。
   *
   * 只在烘焙时跑一次（尺寸变化才重跑），不是每帧。
   */
  _depthGrade(cv, k) {
    if (!cv) return null;
    const out = document.createElement('canvas');
    out.width = cv.width;
    out.height = cv.height;
    const g = out.getContext('2d');
    g.drawImage(cv, 0, 0);
    let id;
    try {
      id = g.getImageData(0, 0, out.width, out.height);
    } catch (_) {
      return out; // 跨域污染时静默降级，别把角色整个弄丢
    }
    const d = id.data;
    const T = Math.exp(-2.0 * k);   // 透射率：k=0 → 1（无水），k=1 → 0.14
    const inv = 1 - T;
    const wr = 16, wg = 58, wb = 82; // 水的颜色（深青），也是远处物体的最终归宿
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      d[i] = d[i] * T + wr * inv;
      d[i + 1] = d[i + 1] * T + wg * inv;
      d[i + 2] = d[i + 2] * T + wb * inv;
    }
    g.putImageData(id, 0, 0);
    return out;
  }

  /**
   * 回声照亮用的光晕：烘一次，别每帧 shadowBlur（移动端 Canvas 2D 上极慢）。
   * 叠两遍是为了让光晕实一点，不然加色叠出来偏灰。
   */
  _bakeGlow(body) {
    if (!body) return null;
    const pad = Math.max(6, Math.round(body.width * 0.05));
    const cv = document.createElement('canvas');
    cv.width = body.width + pad * 2;
    cv.height = body.height + pad * 2;
    const g = cv.getContext('2d');
    g.shadowColor = 'rgba(150,232,255,0.95)';
    g.shadowBlur = pad * 1.7;
    g.drawImage(body, pad, pad);
    g.drawImage(body, pad, pad);
    return { cv, pad };
  }

  /**
   * 尾鳍裁切。不用矩形硬切 —— 硬切的边上会留一条清晰的身体碎片，
   * 尾鳍一转那条碎片跟着转，屏幕上就是"尾巴撕裂"。
   * 改用横向渐变（0.30 → 0.36）做柔和过渡：切下来的边是半透明的，
   * 旋转时和新位置的身体自然叠合，看不出接缝。
   */
  _tailFade(g, w, h) {
    const x0 = this.tailCut[0] * w;
    const x1 = this.tailCut[1] * w;
    const lg = g.createLinearGradient(x0, 0, x1, 0);
    lg.addColorStop(0, 'rgba(0,0,0,1)');
    lg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lg;
    g.fillRect(0, 0, x1, h);
  }

  /** 只留尾鳍（给可动件用） */
  _cropTail(src) {
    const cv = document.createElement('canvas');
    cv.width = src.width;
    cv.height = src.height;
    const g = cv.getContext('2d');
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    this._tailFade(g, cv.width, cv.height);
    return cv;
  }

  /** 挖掉尾鳍（给身体用，防止尾鳍和身体重影） */
  _cutTail(src) {
    const cv = document.createElement('canvas');
    cv.width = src.width;
    cv.height = src.height;
    const g = cv.getContext('2d');
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    this._tailFade(g, cv.width, cv.height);
    return cv;
  }

  /**
   * 尾鳍残影：尾鳍转开之后，原来那个位置不能是空的 —— 空就等于尾巴断开。
   * 留一条压暗的旧尾鳍在底下，读作运动模糊；这是花仙子翅膀那条决策
   * （render.js:4143「底层必须含拖影版」）在鲸身上的延续。
   */
  _tailResidue(src) {
    const cv = document.createElement('canvas');
    cv.width = src.width;
    cv.height = src.height;
    const g = cv.getContext('2d');
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    this._tailFade(g, cv.width, cv.height);

    // 必须真的糊掉。只压暗不模糊的话，那条旧尾鳍在屏幕上是"第二个清晰的尾巴"，
    // 读作重影/穿模；糊到认不出轮廓才读作运动模糊。
    // 缩小 1/10 再放大回来是廉价近似高斯，比 ctx.filter='blur()' 便宜得多，
    // 而且 iOS 16.4 以下的 Safari 根本不支持 canvas filter。
    const sw = Math.max(1, Math.round(cv.width / 10));
    const sh = Math.max(1, Math.round(cv.height / 10));
    const tmp = document.createElement('canvas');
    tmp.width = sw;
    tmp.height = sh;
    const tg = tmp.getContext('2d');
    tg.imageSmoothingEnabled = true;
    tg.drawImage(cv, 0, 0, sw, sh);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, cv.width, cv.height);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(tmp, 0, 0, cv.width, cv.height);

    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(6, 30, 46, 0.62)';
    g.fillRect(0, 0, cv.width, cv.height);
    return cv;
  }

  /**
   * 污染层：整条鲸"脏了"的那一层。
   *
   * 用户实拍："鲸鱼的污染程度太快了，过渡也不明显。"
   * 前半句是数值（见 game 里的 soil 模型），后半句是**这个函数存在的理由**：
   * 伤痕和病变是离散的 —— 它们只能"第 3 道口子出现了"，
   * 两次出现之间身体没有任何变化，读起来像卡住了。
   * 这一层是连续的：0.02 和 1.00 之间是一条不间断的曲线，
   * 玩家在水里会看见自己慢慢变成别的颜色。
   *
   * 做法上只烘一次（尺寸变了才重烘），画的时候只改 alpha。
   * 脏的东西有三样，颜色全不一样，混在一起才不会读成"蒙了一层灰"：
   *   藻绿（浮游生物）+ 褐黑（油和泥）+ 尾部的拖痕（脏东西顺着水流往后挂）
   */
  _bakeGrime(full, w, h) {
    if (!full) return null;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return null;
    const rnd = mulberry32(9137);

    // 1) 底子：整条鲸**均匀地**脏一档。没有这一层，斑点会浮在干净的皮肤上，
    //    读作"花纹"；有了它，那些斑才是"脏东西积在皮上"。
    g.fillStyle = 'rgba(46,50,36,0.30)';
    g.fillRect(0, 0, w, h);

    // 2) 斑：小而多。上一版是 54 颗大斑（0.018~0.074w），在手机上读作
    //    "迷彩/豹纹" —— 那是图案，不是污渍。真污渍的颗粒永远比你想的小。
    for (let i = 0; i < 120; i++) {
      const x = w * (0.16 + rnd() * 0.74);
      const y = h * (0.26 + rnd() * 0.56);
      const r = Math.max(2.5, w * (0.007 + rnd() * 0.020));
      // 三色：藻绿 / 泥褐 / 近乎黑的焦油。饱和度都压得很低。
      const c = i % 5 === 0 ? '78,82,54' : (i % 3 === 0 ? '52,46,36' : '34,32,26');
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${c},${0.12 + rnd() * 0.14})`);
      gr.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }

    // 3) 背脊一条更深的带：脏东西是顺着水流往背上积的（背上最先被晒到、最先脏）
    for (let i = 0; i < 26; i++) {
      const x = w * (0.24 + i * 0.022);
      const y = h * (0.34 + (i % 3) * 0.012 + rnd() * 0.02);
      const r = w * (0.014 + rnd() * 0.018);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(30,30,24,${0.16 + rnd() * 0.12})`);
      gr.addColorStop(1, 'rgba(30,30,24,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }

    // 4) 尾部拖痕：脏东西往后挂，越靠尾柄越密
    for (let i = 0; i < 14; i++) {
      const x = w * (0.24 + i * 0.005);
      const y = h * (0.44 + rnd() * 0.22);
      const r = w * (0.012 + rnd() * 0.018);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(38,36,28,${0.16 + rnd() * 0.12})`);
      gr.addColorStop(1, 'rgba(38,36,28,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }

    // 遮罩：只留在身体上（和伤痕层同一条规矩）
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(full, 0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    return cv;
  }

  /**
   * 伤痕层：血痕 / 核变异 / 塑料缠绕。
   *
   * 用户要的三件事，本质是同一件：**这片海在它身上留证据**。
   * 所以它们不是"受击特效"（打完就消失），而是烘在身体上的疤 ——
   * 这一局里永远在，换气、跃出水面、沉底都还在。
   *
   * 关键实现：画完用整图（不是挖了尾的那张）做 destination-in 遮罩。
   * 不遮的话，血痕会飘在身体轮廓外的水里 —— 那是"贴上去的贴纸"，
   * 不是"长在皮上的疤"。尾巴上的塑料袋尤其需要整图：尾鳍那张是挖空的。
   *
   * 缓存键里带三个计数：状态不变就一次都不重画，最多 6×4×5=120 种组合，
   * 实际上玩家一局只会走过其中几条。
   */
  _marks(b, scars, mut, rings) {
    if (!scars && !mut && !rings) return null;
    const key = b.key + '|' + scars + '|' + mut + '|' + rings;
    if (!this._markCache) this._markCache = new Map();
    const hit = this._markCache.get(key);
    if (hit !== undefined) return hit;

    const cv = document.createElement('canvas');
    cv.width = b.w;
    cv.height = b.h;
    const g = cv.getContext('2d');
    if (!g || !b.full) return null;
    const W = b.w;
    const H = b.h;

    // ---- 1) 血痕 ----
    // 位置钉死在一张表上：同样的伤，每次都在同一个地方 ——
    // 玩家能认出"这道是上次被钩子挂的"。随机位置只会变成花纹。
    // 位置是按插画本体量的：这张图的鲸体是一条从右下（头）到左上（尾）的斜带，
    // 背侧深蓝区的上缘大致是 y = 0.52 − 0.30·(x − 0.45)。血痕全落在这条带里，
    // 上一版有三道掉在白肚皮外侧的水里 —— 遮罩会把它裁掉，等于白写。
    // 六道伤要**分开长**：挤在一条斜线上的六道短线，在手机上读作"一撮稻草"。
    // 这一版把它们摊到尾柄、体侧、胸鳍上方、眼下、肩背，各自的倾角也不同 ——
    // 伤是陆续来的，位置本来就不该排队。
    // 用户两次实拍："血痕不够明显" → "加明显加多数量范围"。
    //
    // 上一版是「深红粗线 + 全白描边」，在手机屏幕上读作一根根**红色小棒**：
    // 宽度均匀、两端齐平、还有一圈发亮的高光边 —— 那是记号笔，不是伤口。
    // 真正的撕裂伤有三个特征，这一版一条一条补上：
    //   ① 两端**收尖**（宽度沿长度按 sin 收），中间才最宽；
    //   ② 走向**不是直线**（中段被肌肉拉开，会偏出去一小段）；
    //   ③ 边缘**不干净**（三两处小豁口），中间露出颜色更浅的肉。
    // 长度和宽度也不再统一：同一条鲸身上不会有十道一样长的伤。
    const SPOTS = [
      // [x, y, 倾角, 长度系数]
      [0.335, 0.470, -0.62, 0.84], [0.398, 0.506, 0.22, 1.06],
      [0.452, 0.524, -0.28, 0.72], [0.505, 0.468, 0.58, 1.16],
      [0.558, 0.496, -0.44, 0.92], [0.614, 0.548, 0.26, 1.02],
      [0.666, 0.428, -0.12, 0.78], [0.712, 0.474, 0.66, 1.10],
      [0.758, 0.390, -0.34, 0.88], [0.796, 0.346, 0.72, 0.98],
    ];

    // 一道伤：沿一条微弯的曲线铺一条**两端收尖**的带子。
    const gash = (x, y, ang, scl, seed) => {
      // 细长比调了两次：0.088/0.019 在手机上是一根**红辣椒**（太短太粗）。
      // 真正的划伤是长的：长度 +25%、宽度 -40%，变成"被什么划了一道"。
      const len = W * 0.106 * scl;
      const wid = Math.max(1.4, W * 0.0115 * scl);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      // 中段偏离量：正负交替，免得十道伤弯向同一边（那会变成"梳子"）
      const bend = len * 0.11 * (seed % 2 ? 1 : -1);
      const N = 11;
      const pts = [];
      for (let k = 0; k <= N; k++) {
        const t = k / N;
        const s0 = Math.sin(t * Math.PI);
        pts.push({
          x: x + ca * len * (t - 0.5) - sa * bend * s0,
          y: y + sa * len * (t - 0.5) + ca * bend * s0,
          w: wid * Math.pow(Math.sin(t * Math.PI), 0.62),
          t,
        });
      }
      // 轮廓：正向走一半、反向走回来。带一点毛边（每段宽窄抖一下），
      // 齐整的椭圆边就是"贴纸"和"伤"的分界线。
      g.beginPath();
      for (let k = 0; k <= N; k++) {
        const q = pts[k];
        const jitter = 0.62 + ((k * 37 + seed * 13) % 11) / 16;
        const px = q.x - sa * q.w * 0.5 * jitter;
        const py = q.y + ca * q.w * 0.5 * jitter;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      for (let k = N; k >= 0; k--) {
        const q = pts[k];
        const jitter = 0.62 + ((k * 53 + seed * 7) % 13) / 20;
        g.lineTo(q.x + sa * q.w * 0.5 * jitter, q.y - ca * q.w * 0.5 * jitter);
      }
      g.closePath();
      g.fillStyle = 'rgba(98,20,24,0.82)';
      g.fill();
      // 伤口深处：一道更亮的窄线，只走中段。整道线都亮就回到"小棒"了。
      g.beginPath();
      for (let k = 2; k <= N - 2; k++) {
        const q = pts[k];
        const u = (k - 2) / (N - 4);
        const off = Math.sin(u * Math.PI) * q.w * 0.12;
        if (k === 2) g.moveTo(q.x - sa * off, q.y + ca * off);
        else g.lineTo(q.x - sa * off, q.y + ca * off);
      }
      g.strokeStyle = 'rgba(216,126,116,0.56)';
      g.lineWidth = Math.max(0.7, wid * 0.22);
      g.lineCap = 'round';
      g.stroke();
      // 边缘的豁口：两三个小三角，让轮廓"被撕开过"
      g.fillStyle = 'rgba(96,12,18,0.78)';
      for (let k = 0; k < 3; k++) {
        const q = pts[3 + ((k * 3 + seed) % (N - 5))];
        const side = (k + seed) % 2 ? 1 : -1;
        g.beginPath();
        g.arc(q.x + sa * q.w * 0.42 * side, q.y - ca * q.w * 0.42 * side, wid * 0.20, 0, TAU);
        g.fill();
      }
      // 血：伤口一头会渗出来一小团，不是两端各一颗对称的点
      const tail = pts[N - 1];
      g.fillStyle = 'rgba(138,22,26,0.66)';
      g.beginPath();
      g.ellipse(tail.x + ca * wid * 0.5, tail.y + sa * wid * 0.5, wid * 0.62, wid * 0.42, ang, 0, TAU);
      g.fill();
    };

    for (let i = 0; i < Math.min(scars, SPOTS.length); i++) {
      const [nx, ny, ang, scl] = SPOTS[i];
      gash(nx * W, ny * H, ang, scl, i + 1);
    }

    // ---- 2) 核污染变异：从头部往后长 ----
    // 头在右边（尾鳍裁切带在 0.13~0.34，见 tailCut）。所以变异从 0.88 起，
    // 一级一级往回啃：1 级只在吻端，3 级已经啃到胸鳍。
    if (mut > 0) {
      let seed = 20261108;
      const rr = () => {
        seed = (seed * 1664525 + 1013904223) & 0xffffffff;
        return ((seed >>> 8) & 0xffffff) / 0xffffff;
      };
      // 上一版 33 个 r≈0.046W 的斑叠在一起，把整颗头糊成一颗紫气球 ——
      // "明显"不等于"糊满"。这一版斑更少、更小，但每颗都有**暗边 + 亮心**：
      // 读作"皮肤上烂了几个洞"，不是"整块染了色"。
      // 铺开比涂满重要：上一版把 21 颗斑全堆在吻端 0.2W 里，屏幕上是"紫葡萄"。
      // 现在往回铺到 0.43W（背脊一半），单颗更小 —— 读作"从头往身上蔓延"。
      const back = 0.16 + mut * 0.09;
      const n = 7 + mut * 5;             // 1 级 12 颗，3 级 22 颗
      for (let i = 0; i < n; i++) {
        const nx = 0.885 - rr() * back;
        const ny = 0.285 + rr() * 0.165;
        const r = W * (0.0085 + rr() * 0.0195);
        // 底：暗紫的坏死斑
        g.fillStyle = `rgba(84,52,102,${0.26 + rr() * 0.20})`;
        g.beginPath();
        g.ellipse(nx * W, ny * H, r * 1.45, r, rr() * TAU, 0, TAU);
        g.fill();
        // 边：一圈更深的口子，病灶才有"深度"
        g.strokeStyle = `rgba(52,22,78,${0.24 + rr() * 0.18})`;
        g.lineWidth = Math.max(1, W * 0.0035);
        g.stroke();
        // 上：一点点发亮的病灶中心（读作"在变异"，不是"脏了"）
        g.fillStyle = `rgba(214,164,246,${0.26 + rr() * 0.18})`;
        g.beginPath();
        g.arc(nx * W, ny * H, r * 0.52, 0, TAU);
        g.fill();
      }
      // 头顶一层很淡的紫雾：变异要读作"从里面渗出来的"，不是"围了一圈腮红"。
      // 上一版画了一个椭圆描边，落在吻端直接变成一张脸 —— 删掉，只留弥散。
      const mist = g.createRadialGradient(W * 0.80, H * 0.33, 0, W * 0.80, H * 0.33, W * 0.15);
      mist.addColorStop(0, `rgba(132,92,158,${0.07 + mut * 0.035})`);
      mist.addColorStop(1, 'rgba(138,92,170,0)');
      g.fillStyle = mist;
      g.fillRect(0, 0, W, H);
    }

    // ---- 3) 尾巴上的塑料袋：每碰一次多一圈 ----
    // 上一版整条带子都画在"会被遮罩裁掉"的层里，而且只有 8px 宽 ——
    // 手机上等于没画（用户两次说"塑料缠身不够明显"）。
    // 现在拆成两半：
    //   a) **缠在尾柄上的带子**画在这里（跟着身体走，必须被遮罩裁）；
    //   b) **垂下来的一截空袋**画在遮罩之后（它本来就漂在水里，裁掉就没了）。
    for (let i = 0; i < Math.min(rings, 5); i++) {
      // 位置必须落在 **0.28 以右**：0.28~0.34 是尾巴被"挖走"后交给可动尾鳍的接缝，
      // 0.28 以左的那块每帧都在摆 —— 塑料袋画在那儿会跟着原地不动、尾巴摆走。
      // 量过贴图透明度剖面：0.31 处身体是 0.35~0.70，尾柄根部就在这里。
      const cx = W * (0.310 + i * 0.024);
      const cy = H * 0.525;
      const half = W * 0.0165;            // 带子的半宽
      const reach = H * 0.190;            // 上下伸出体外，由遮罩裁齐
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.16 + i * 0.055);
      // 膜：横跨尾柄的一条带子（两侧边微弯，读作"勒进去"）
      g.beginPath();
      g.moveTo(-half, -reach);
      g.quadraticCurveTo(half * 0.40, 0, -half, reach);
      g.lineTo(half, reach);
      g.quadraticCurveTo(-half * 0.40, 0, half, -reach);
      g.closePath();
      // 冷白塑料压在白色肚皮上等于隐形（上一版就是这样）。
      // 超市袋是**暖灰**的，边缘再压一层暗影，才从身体上"浮"出来。
      g.save();
      g.translate(W * 0.004, H * 0.004);
      g.fillStyle = 'rgba(10,22,28,0.34)';
      g.fill();
      g.restore();
      g.fillStyle = 'rgba(226,220,198,0.34)';
      g.fill();
      g.strokeStyle = 'rgba(250,248,238,0.58)';
      g.lineWidth = Math.max(1.1, W * 0.0028);
      g.stroke();
      // 褶皱：三道横向短痕。塑料的褶是**横向**的，纵向的会读成布。
      g.strokeStyle = 'rgba(246,255,255,0.34)';
      g.lineWidth = Math.max(0.9, W * 0.0024);
      for (let k = -1; k <= 1; k++) {
        g.beginPath();
        g.moveTo(-half * 0.85, k * reach * 0.26);
        g.quadraticCurveTo(0, k * reach * 0.26 + half * 0.5, half * 0.85, k * reach * 0.26);
        g.stroke();
      }
      g.restore();
    }

    // 遮罩：只留在身体上
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(b.full, 0, 0, W, H);
    g.globalCompositeOperation = 'source-over';

    // ---- 4) 垂在体外的塑料袋：**画在遮罩之后** ----
    // 它不是长在皮上的，是被尾柄挂住、顺水漂着的一截。
    // 上一版把它画在遮罩之前，于是整截都被裁掉 —— 屏幕上只剩几道几乎看不见的亮边。
    for (let i = 0; i < Math.min(rings, 5); i++) {
      // 垂下来那截挂在尾柄下缘（0.70 是那里的身体下界），所以它在水里
      // 五只袋子必须**散开**：上一版间距 0.024W、直径 0.048W，
      // 四只叠在一起变成一簇皂泡 —— 传的不是"缠住了"，是"贴了一串气球"。
      const cx = W * (0.300 + i * 0.038);
      const cy = H * (0.700 + (i % 2) * 0.018);
      const ww = W * (0.032 + (i % 2) * 0.008);
      g.save();
      g.translate(cx, cy);
      // 袋口在左、袋身在右下：被水推着，所以不是垂直的
      g.rotate(0.22 + Math.sin(i * 1.7) * 0.22);
      // 形状：不是椭圆。塑料被水鼓起来是**不规则的**——
      // 上一版四个圆润的水滴排成一排，看着像一串贝壳。
      // 这里按 8 个顶点、半径 0.66~1.24 抖动，再用二次曲线连接，
      // 得到"被撑开又塌下去"的袋形。
      const pts = [];
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * TAU;
        const jr = 0.66 + (((k * 41 + i * 17) % 23) / 23) * 0.58;
        pts.push({
          x: Math.cos(ang) * ww * jr * 1.05,
          y: Math.sin(ang) * ww * jr + ww * 0.30,
        });
      }
      const bagPath = () => {
        g.beginPath();
        const last = pts[7];
        const first = pts[0];
        g.moveTo((last.x + first.x) * 0.5, (last.y + first.y) * 0.5);
        for (let k = 0; k < 8; k++) {
          const p0 = pts[k];
          const p1 = pts[(k + 1) % 8];
          g.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);
        }
        g.closePath();
      };
      bagPath();
      g.save();
      g.translate(ww * 0.05, ww * 0.05);
      g.fillStyle = 'rgba(10,22,28,0.30)';
      g.fill();
      g.restore();
      g.fillStyle = 'rgba(230,226,210,0.34)';
      g.fill();
      g.strokeStyle = 'rgba(248,246,236,0.62)';
      g.lineWidth = Math.max(1.1, W * 0.0030);
      g.stroke();
      // 袋里的褶：两道横弧 —— 塑料的褶是横向的
      g.strokeStyle = 'rgba(240,254,254,0.24)';
      g.lineWidth = Math.max(0.8, W * 0.0020);
      for (let k = 0; k < 2; k++) {
        g.beginPath();
        g.moveTo(-ww * 0.26, ww * (0.24 + k * 0.34));
        g.quadraticCurveTo(0, ww * (0.38 + k * 0.34), ww * 0.28, ww * (0.20 + k * 0.36));
        g.stroke();
      }
      g.restore();
    }

    this._markCache.set(key, cv);
    // 键会随状态增长，但一局最多几十种；超过 200 就清一次，别让它一直涨
    if (this._markCache.size > 200) this._markCache.clear();
    return cv;
  }

  /** 绕归一化枢轴旋转一块 */
  _piece(ctx, img, w, h, px, py, ang) {
    const cx = (px - 0.5) * w;
    const cy = (py - 0.5) * h;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.translate(-cx, -cy);
    ctx.drawImage(img, -w / 2, -h / 2);
    ctx.restore();
  }

  /**
   * 画一帧。
   * @param L 体长（屏幕像素）
   * @param o { time, phase, echo, tilt, flip, screenH, alpha }
   */
  draw(ctx, x, y, L, o = {}) {
    if (!this.ready) return;
    const b = this._bake(L);
    const t = o.time || 0;
    const ph = o.phase != null ? o.phase : t * 2.62;
    const echo = o.echo || 0;
    // 整体透明度：远处的同类要靠它淡进水里。
    // 内部 paint() 会把 globalAlpha 写死成 1，所以必须从这里乘进去，
    // 在外面套 ctx.globalAlpha 是无效的。
    const A = o.alpha == null ? 1 : o.alpha;

    // 浮力 4.6s / 呼吸 6.2s：两个周期故意不整除，避免同相变成机械抖动
    const buoy = Math.sin(t * 1.366) * 0.011 * (o.screenH || 800);
    const breath = 1 + 0.012 * (0.5 + 0.5 * Math.sin(t * 1.013));

    ctx.save();
    ctx.translate(x, y - buoy);
    if (o.flip) ctx.scale(-1, 1);
    if (o.tilt) ctx.rotate(o.tilt);
    ctx.scale(breath, breath);

    // 剪切：以颈线为不动点，越往尾端位移越大 —— 头不晃，身子才像在游
    const shear = Math.sin(ph) * 0.062;
    const nx = (this.pivots.neck[0] - 0.5) * b.w;
    ctx.translate(nx, 0);
    ctx.transform(1, shear, 0, 1, 0, 0);
    ctx.translate(-nx, 0);

    // 三个可动件各算一次角度，浅色版和深处版共用 —— 不然两层会错位
    // 尾摆幅度：0.4 rad ≈ 23°。座头鲸尾鳍的摆幅很大，给小了像"纸片晃"。
    // 有残影兜底，转开的位置不会露空，所以敢开大。
    const angFluke = Math.sin(ph + 0.62) * 0.4;
    const angFinFar = Math.sin(ph + 1.75) * 0.2;
    const angFin = Math.sin(ph + 0.92) * 0.23;
    const P = this.pivots;

    // 按同一套变换画一整组图层。浅色一版、深处一版，靠 alpha 交叉淡入。
    const paint = (set, alpha) => {
      ctx.globalAlpha = alpha;
      // 残影在最底下：跟着尾鳍转**一半**角度。
      // 留在原位不动的话，它和转开的尾鳍离得太远，看起来像一团烟；
      // 跟一半正好落在扫过的轨迹中间，才读作运动模糊。
      if (set.residue) {
        ctx.globalAlpha = alpha * 0.7; // 再压一层，避免在暗水里变成一团灰雾
        this._piece(ctx, set.residue, b.w, b.h, P.fluke[0], P.fluke[1], angFluke * 0.55);
        ctx.globalAlpha = alpha;
      }
      // 尾鳍在身体之前（尾柄要盖住它的根）
      if (set.fluke) this._piece(ctx, set.fluke, b.w, b.h, P.fluke[0], P.fluke[1], angFluke);
      if (set.finFar) this._piece(ctx, set.finFar, b.w, b.h, P.fin[0], P.fin[1], angFinFar);
      ctx.drawImage(set.body, -b.w / 2, -b.h / 2);
      if (set.fin) this._piece(ctx, set.fin, b.w, b.h, P.fin[0], P.fin[1], angFin);
      ctx.globalAlpha = 1;
    };

    paint(b, A);
    const dk = clamp(o.depth || 0, 0, 1);
    // 0.95 而不是 1.15：按 1.15 时 depth=0.5 就混了 57% 的"最深"版本，
    // 角色在中层水里已经糊成一片 —— 玩家看不清自己控制的角色是硬伤。
    // 雾化应该"浅处几乎不生效、深处才彻底吃掉"，而不是线性地一路变暗。
    if (dk > 0.02) paint(b.deep, Math.min(1, dk * 0.95) * A);

    // 污染层：画在伤痕**之前** —— 脏是底子，伤是皮上的口子，口子必须在脏的上面。
    // 0.06 以下是干净的（刚下水不该一脸泥），0.06~0.75 之间线性加深，
    // 之后压到 0.86 封顶：再往上就吃掉贴图本身的明暗，读成"另一只鲸"了。
    const grime = clamp(o.grime || 0, 0, 1);
    if (grime > 0.06 && b.grime) {
      ctx.globalAlpha = A * Math.min(0.86, (grime - 0.06) * 1.16);
      ctx.drawImage(b.grime, -b.w / 2, -b.h / 2);
      ctx.globalAlpha = 1;
    }

    // 伤痕层：**画在雾化层之后**。
    // 上一版画在之前，depth=0.5 时会被 47% 的水色盖掉一半 ——
    // 结果玩家越往下（越该看清自己受了什么伤）伤反而越淡，
    // 这跟"这片海在它身上留证据"正好相反。现在只随深度轻微减弱。
    const marks = this._marks(b, o.scars | 0, o.mut | 0, o.rings | 0);
    if (marks) {
      ctx.globalAlpha = A * (1 - dk * 0.42);
      ctx.drawImage(marks, -b.w / 2, -b.h / 2);
      ctx.globalAlpha = 1;
    }

    // 张嘴件：只在发声那一秒露出，靠 alpha 过渡，别硬切
    const mo = Math.min(1, echo * 1.6);
    if (b.mouth && mo > 0.02) {
      ctx.globalAlpha = mo * A;
      ctx.drawImage(b.mouth, -b.w / 2, -b.h / 2);
      ctx.globalAlpha = 1;
    }

    // 回声照亮：加色叠预烘的光晕
    if (echo > 0.01 && b.glow) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * echo * A;
      ctx.drawImage(b.glow.cv, -b.w / 2 - b.glow.pad, -b.h / 2 - b.glow.pad);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.restore();
  }
}
