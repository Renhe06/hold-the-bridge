// ---------------------------------------------------------------------------
//  第五关 · 上篇「跃」—— 水下场景渲染
//
//  设计前提（和第四关的陆地层完全不同）：
//    1) Canvas 2D 没有着色器，做不了真折射/真体积光。手机上 high 档是 1170×2532
//       ≈ 296 万像素，每帧最多承受 5 次全屏填充。所以"精致"只能来自烘焙：
//       焦散、光柱、暗角、沉船剪影全部一次性烘到离屏 canvas，每帧只 drawImage。
//    2) 水是最宽容的介质。真实水下镜头的精致几乎全部来自焦散与悬浮物 ——
//       观众看到的是光，不是纹理。所以在水里堆模型细节是浪费预算。
//    3) 座头鲸的"精致"来自解剖对不对，不来自线多：长胸鳍、喉腹褶、宽尾鳍带缺刻、
//       头部瘤突。四十个控制点画对了就够，画多了反而是线稿。
//    4) 画面下半必须有地形。只有"越往下越黑"不会读成深海，只会读成没画完 ——
//       海床是这个场景的底座，它一到位，上半的空才成立。
//
//  填充预算（high）：
//    水体 1 + 海床 1 + 光柱 1 + 焦散 1 + 海雪 2 + 暗角 1 = 7 次，其中光柱/焦散只铺上半屏，
//    海床只铺下半 55%；另有 20 张 32px 的柔光点（浮游生物），单次 drawImage 极小。
//    low 档直接切"剪影风"：关掉光柱/焦散/海雪，加强对比与轮廓光 —— 不是残缺版，
//    是另一套成立的画风。
// ---------------------------------------------------------------------------

import { clamp, lerp, mix, rgba, mulberry32 } from './util.js';
import { QUALITY } from './quality.js';

const TAU = Math.PI * 2;

export class SeaRenderer {
  constructor(canvas, opt = {}) {
    this.canvas = canvas;
    // 主画布要不透明（alpha:false 更快）；烘焙单只角色用的临时画布必须透明，
    // 否则贴图抠不出来 —— 所以做成可选。
    this.ctx = canvas.getContext('2d', { alpha: !!opt.alpha });
    this.w = 390;
    this.h = 844;
    this.dpr = 1;
    this.time = 0;
    this.surface = 0.16;   // 水面在屏幕上的基准位置（占画面高度）
    this._grads = new Map();
    this._whaleGrads = new Map();
    this._lgc = new Map();   // 鲸身上的局部渐变（受光面/腹部/胸鳍），按 L 取整缓存
    this._pats = null;
    // 斑驳与生物荧光的位置：固定种子，写死一次。每帧再摇一遍会跳点。
    const rs = mulberry32(31337);
    this._spots = [];
    for (let i = 0; i < 9; i++) {
      this._spots.push({
        x: -0.30 + rs() * 0.70,
        y: -0.135 + rs() * 0.17,
        rx: 0.018 + rs() * 0.048,
        ry: 0.010 + rs() * 0.028,
        rot: rs() * Math.PI,
        a: rs(),
      });
    }
    const rb = mulberry32(9182);
    this._bio = [];
    for (let i = 0; i < 24; i++) this._bio.push({ x: -0.30 + rb() * 0.74, y: -0.130 + rb() * 0.110 });
    // 浮游生物：深海里的冷光颗粒，从下往上缓慢漂。
    // 它同时解决两件事 —— 中下段的空间填充，和"这片水是活的"。
    // 数量必须少（20 个）：再多就变成星空，而深海不该有星空。
    const rd = mulberry32(20231);
    this._plankton = [];
    for (let i = 0; i < 20; i++) {
      this._plankton.push({
        x: rd(),
        y: rd(),
        r: 1.6 + rd() * 2.6,
        sp: 4 + rd() * 9,
        ph: rd() * TAU,
      });
    }
    this._caustics = null;
    this._rays = null;
    this._snow = null;
    this._vignette = null;
    this._ship = null;
    this._seabed = null;
    this._dot = null;
    this._sky = null;
    this._ready = false;
  }

  // ---------------------------------------------------------
  //  尺寸 / 烘焙
  // ---------------------------------------------------------

  resize(cssW, cssH, dpr) {
    this.w = cssW;
    this.h = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._grads.clear();
    this._whaleGrads.clear();
    // 纹理重烘了，绑定在上面的 pattern 必须一起丢，否则会继续用旧的离屏画布
    this._pats = null;
    this._lgc.clear();
    this._bakeAll();
    this._ready = true;
  }

  _off(w, h) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w));
    cv.height = Math.max(1, Math.round(h));
    return cv;
  }

  _bakeAll() {
    this._caustics = this._bakeCaustics(256);
    this._rays = this._bakeRays();
    this._snow = this._bakeSnow(192);
    this._vignette = this._bakeVignette();
    this._ship = this._bakeShip();
    this._seabed = this._bakeSeabed();
    this._dot = this._bakeGlowDot(32);
    this._sky = this._bakeSky();
    this._surface = this._bakeSurface();
  }

  /**
   * 水面辉光：从水下抬头看到的那块"发光的天花板"。
   * 上下两端都渐隐到 0，这样它落进画面时不会有任何一条硬边 ——
   * 第一版直接在 surfaceY 处开始叠光柱，结果画面中间出现一条笔直的接缝。
   */
  _bakeSurface() {
    const H = Math.round(this.h * 0.36);
    const cv = this._off(this.w, H);
    const g = cv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, 'rgba(150,214,240,0)');
    gr.addColorStop(0.42, 'rgba(164,222,246,0.09)');
    gr.addColorStop(0.76, 'rgba(198,238,255,0.30)');
    gr.addColorStop(0.90, 'rgba(210,244,255,0.17)');
    gr.addColorStop(1, 'rgba(210,244,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, this.w, H);
    // 水面波纹：几条横向亮线，越靠下越密（透视把远处的波纹压扁了）
    g.globalCompositeOperation = 'lighter';
    const rnd = mulberry32(5511);
    for (let i = 0; i < 13; i++) {
      const y = H * (0.70 + rnd() * 0.28);
      const a = 0.05 + rnd() * 0.11;
      g.strokeStyle = `rgba(228,250,255,${a})`;
      g.lineWidth = 0.7 + rnd() * 1.5;
      const amp = H * (0.004 + rnd() * 0.016);
      const f = 1.2 + rnd() * 1.6;
      const phase = rnd() * TAU;
      g.beginPath();
      for (let x = 0; x <= this.w; x += 10) {
        const yy = y + Math.sin((x / this.w) * TAU * f + phase) * amp;
        if (x === 0) g.moveTo(x, yy);
        else g.lineTo(x, yy);
      }
      g.stroke();
    }
    return cv;
  }

  /**
   * 焦散带：一条"上浓下淡"的宽带，只做**横向**平铺。
   *
   * 第一版做的是全屏可平铺纹理 + clip 一条带 —— 结果底部出现一条笔直的分界线，
   * 而且图案被放大成 130px 的大光斑，像失焦的灯而不是水。
   * 现在把纵向渐隐直接烘进纹理、把频率提到 6~13 个周期（网眼约 60px），
   * 填充时完全不用 clip，既没有缝，尺寸也对。
   *
   * 不用 Voronoi：一次要算 512×N 个点，手机上太贵；正弦叠加在缓慢横移时
   * 有"水在晃"的感觉，比静态 Voronoi 更像真焦散。u 方向用整数频率保证无缝。
   */
  _bakeCaustics(size) {
    const W = 512;
    const H = Math.max(180, Math.round(this.h * 0.60));
    const cv = this._off(W, H);
    const g = cv.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      const v = y / H;
      // 纵向渐隐：顶部最亮，到 78% 处彻底归零 —— 这就是那条"缝"的解药
      const fade = Math.max(0, 1 - v / 0.78);
      const soft = fade * fade;
      for (let x = 0; x < W; x++) {
        const u = x / W;
        let s = 0;
        s += Math.sin((u * 9 + v * 4) * TAU);
        s += Math.sin((u * 6 - v * 7) * TAU + 1.7);
        s += Math.sin((u * 13 + v * 5) * TAU + 3.1) * 0.6;
        s += Math.sin((u * 4 - v * 11) * TAU + 4.9) * 0.6;
        const t = Math.max(0, (s / 3.24 + 1) * 0.5);
        const a = Math.pow(t, 5) * 255 * soft;
        const i = (y * W + x) * 4;
        d[i] = 196;
        d[i + 1] = 236;
        d[i + 2] = 255;
        d[i + 3] = a;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  /**
   * 自上而下的光柱。烘焙时用 blur 是允许的（只做一次），
   * 每帧再 blur 会直接把帧率打死 —— 移动端 Canvas 2D 的 filter 极慢。
   */
  _bakeRays() {
    const W = Math.round(this.w * 0.6);
    const H = Math.round(this.h * 0.82);
    const cv = this._off(W, H);
    const g = cv.getContext('2d');
    const rnd = mulberry32(20261107);
    g.clearRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 11; i++) {
      const x0 = W * (0.02 + rnd() * 0.96);
      const topW = W * (0.010 + rnd() * 0.040);
      const botW = topW * (2.4 + rnd() * 2.8);
      const len = H * (0.58 + rnd() * 0.42);
      const gr = g.createLinearGradient(0, 0, 0, len);
      const a = 0.07 + rnd() * 0.11;
      gr.addColorStop(0, `rgba(196,238,255,${a})`);
      gr.addColorStop(0.42, `rgba(158,218,246,${a * 0.52})`);
      gr.addColorStop(1, 'rgba(120,190,230,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(x0 - topW * 0.5, 0);
      g.lineTo(x0 + topW * 0.5, 0);
      g.lineTo(x0 + botW * 0.5, len);
      g.lineTo(x0 - botW * 0.5, len);
      g.closePath();
      g.fill();
    }
    // 上下两端渐隐到 0：光柱贴到水面/消失在深处时都不能出现硬边
    const fade = this._off(W, H);
    const fg = fade.getContext('2d');
    const fgr = fg.createLinearGradient(0, 0, 0, H);
    fgr.addColorStop(0, 'rgba(0,0,0,0)');
    fgr.addColorStop(0.11, 'rgba(0,0,0,1)');
    fgr.addColorStop(0.68, 'rgba(0,0,0,1)');
    fgr.addColorStop(1, 'rgba(0,0,0,0)');
    fg.fillStyle = fgr;
    fg.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(fade, 0, 0);
    g.globalCompositeOperation = 'source-over';
    // 一次性柔化（只做一次，每帧 blur 会直接把帧率打死）
    try {
      const out = this._off(W, H);
      const og = out.getContext('2d');
      og.filter = 'blur(6px)';
      og.drawImage(cv, 0, 0);
      return out;
    } catch (_) {
      return cv;
    }
  }

  /** 海雪：可平铺的细颗粒。两层不同速度就是"视差 + 深度"。 */
  _bakeSnow(size) {
    const cv = this._off(size, size);
    const g = cv.getContext('2d');
    const rnd = mulberry32(77031);
    g.clearRect(0, 0, size, size);
    for (let i = 0; i < 620; i++) {
      const x = rnd() * size;
      const y = rnd() * size;
      // 颗粒必须小。第一版半径最大 2px，放大到 2 倍屏就是一团团虚斑，
      // 看起来不是"水里的碎屑"，是"镜头脏了"。
      const r = 0.22 + rnd() * 0.78;
      const a = 0.08 + rnd() * 0.34;
      g.fillStyle = `rgba(206,236,255,${a})`;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }
    return cv;
  }

  _bakeVignette() {
    const cv = this._off(this.w, this.h);
    const g = cv.getContext('2d');
    const cx = this.w * 0.5;
    const cy = this.h * 0.46;
    const gr = g.createRadialGradient(cx, cy, Math.min(this.w, this.h) * 0.22, cx, cy, Math.max(this.w, this.h) * 0.78);
    gr.addColorStop(0, 'rgba(0,6,10,0)');
    gr.addColorStop(1, 'rgba(0,6,10,0.78)');
    g.fillStyle = gr;
    g.fillRect(0, 0, this.w, this.h);
    return cv;
  }

  /** 沉船剪影：远景地标。烘焙一次，之后只负责飘过去。 */
  _bakeShip() {
    const W = Math.round(this.w * 1.5);
    const H = Math.round(this.w * 0.52);
    const cv = this._off(W, H);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    const rnd = mulberry32(4242);
    // 船体：倾斜 22°，像侧躺沉在海底
    g.save();
    g.translate(W * 0.5, H * 0.6);
    g.rotate(-0.19);
    g.fillStyle = 'rgba(6,17,25,0.96)';
    g.beginPath();
    g.moveTo(-W * 0.34, -H * 0.10);
    g.lineTo(W * 0.30, -H * 0.14);
    g.quadraticCurveTo(W * 0.39, -H * 0.06, W * 0.36, H * 0.10);
    g.lineTo(-W * 0.30, H * 0.14);
    g.quadraticCurveTo(-W * 0.37, H * 0.02, -W * 0.34, -H * 0.10);
    g.closePath();
    g.fill();
    // 锈迹：铁是有年龄的。纯黑剪影读起来像纸板，锈色才让它"沉了很多年"
    g.save();
    g.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 9; i++) {
      g.fillStyle = `rgba(92,46,32,${0.10 + rnd() * 0.16})`;
      g.beginPath();
      g.ellipse(
        -W * 0.30 + rnd() * W * 0.62, -H * 0.12 + rnd() * H * 0.24,
        W * (0.015 + rnd() * 0.05), H * (0.015 + rnd() * 0.04),
        rnd() * TAU, 0, TAU
      );
      g.fill();
    }
    g.restore();
    // 上缘的月光：整艘船唯一被照亮的地方
    g.strokeStyle = 'rgba(126,172,194,0.22)';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(-W * 0.34, -H * 0.10);
    g.lineTo(W * 0.30, -H * 0.14);
    g.stroke();
    // 上层建筑
    g.fillRect(-W * 0.10, -H * 0.30, W * 0.16, H * 0.20);
    g.fillRect(W * 0.02, -H * 0.24, W * 0.07, H * 0.12);
    // 桅杆 + 吊臂：断的，斜插进水里
    g.strokeStyle = 'rgba(6,17,25,0.96)';
    g.lineWidth = Math.max(1.2, W * 0.006);
    g.beginPath();
    g.moveTo(-W * 0.05, -H * 0.30);
    g.lineTo(-W * 0.20, -H * 0.60);
    g.stroke();
    g.lineWidth = Math.max(1, W * 0.004);
    g.beginPath();
    g.moveTo(W * 0.06, -H * 0.24);
    g.lineTo(W * 0.22, -H * 0.44);
    g.stroke();
    g.restore();
    // 破口：几处镂空，别让它像一块实心铁
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 7; i++) {
      const x = W * (0.24 + rnd() * 0.52);
      const y = H * (0.42 + rnd() * 0.30);
      g.beginPath();
      g.ellipse(x, y, W * (0.012 + rnd() * 0.03), H * (0.02 + rnd() * 0.05), rnd() * TAU, 0, TAU);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    return cv;
  }

  /**
   * 海床：远景地形剪影，给画面一个底座。
   *
   * 没有它的时候，画面下半 40% 是一路渐黑的空场 —— 观众读到的不是"深海"，
   * 是"渲染没画完"。但海底又不能画实：真水下二十米之外只有轮廓，任何石头纹理
   * 都会立刻把水变成"雾天的山景"。所以这里只做三件事：
   *   1) 三层山脊，越近越黑，层与层只靠明度差分开；
   *   2) 每层上缘一线极淡的散射光（光从上面来，海底只可能在上缘反光）；
   *   3) 最底下一层青蓝底光，模拟远处水体散射 —— 不然纯黑会咬掉一切。
   *
   * 宽度做到 1.7 屏：只做 ±5% 的慢漂，不做循环平铺。循环会在接缝处出现
   * 一条笔直的垂直切线，水里的东西不该有直线。
   */
  _bakeSeabed() {
    const W = Math.round(this.w * 1.7);
    const H = Math.round(this.h * 0.55);
    const cv = this._off(W, H);
    const g = cv.getContext('2d');
    const rnd = mulberry32(60517);

    // 底光先铺：山脊要"从光里长出来"，不是贴在黑纸上。
    const lg = g.createLinearGradient(0, H * 0.14, 0, H);
    lg.addColorStop(0, 'rgba(30,94,116,0)');
    lg.addColorStop(0.52, 'rgba(28,88,108,0.11)');
    lg.addColorStop(1, 'rgba(14,50,66,0.24)');
    g.fillStyle = lg;
    g.fillRect(0, 0, W, H);

    const layers = [
      { base: 0.20, amp: 0.060, fill: 'rgba(11,41,55,0.70)', edge: 'rgba(112,196,216,0.14)', lw: 1.6 },
      { base: 0.33, amp: 0.085, fill: 'rgba(5,20,29,0.90)',  edge: 'rgba(82,162,186,0.10)',  lw: 2.0 },
      { base: 0.44, amp: 0.110, fill: 'rgba(2,9,14,0.97)',   edge: 'rgba(56,124,148,0.06)',  lw: 2.4 },
    ];

    for (const L of layers) {
      // 用三条低频正弦叠加，而不是随机控制点。
      // 随机控制点即使做贝塞尔平滑，也会在相邻点落差大的地方留下一个折角 ——
      // 放大到手机上看就是"低多边形山"。正弦叠加大保证曲线处处可导，
      // 而且低/中/高三个频率正好对应"大起伏 / 中坡 / 小梁"三种尺度。
      const f1 = 0.7 + rnd() * 0.5, p1 = rnd() * TAU;
      const f2 = 2.0 + rnd() * 1.1, p2 = rnd() * TAU;
      const f3 = 4.4 + rnd() * 2.0, p3 = rnd() * TAU;
      const ridgePath = () => {
        g.beginPath();
        for (let x = 0; x <= W; x += 5) {
          const u = x / W;
          const w1 = 0.52 + Math.sin(u * 1.7 + p1) * 0.14;   // 低频权重自己也在缓慢起伏
          const y = H * L.base - H * L.amp * (
            w1 * Math.sin(u * f1 * TAU + p1) +
            0.30 * Math.sin(u * f2 * TAU + p2) +
            0.16 * Math.sin(u * f3 * TAU + p3)
          );
          if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
      };
      ridgePath();
      g.lineTo(W, H);
      g.lineTo(0, H);
      g.closePath();
      g.fillStyle = L.fill;
      g.fill();
      // 上缘光：同一条曲线再描一次，但绝不闭合到底边，否则海底会镶一圈边。
      ridgePath();
      g.strokeStyle = L.edge;
      g.lineWidth = L.lw;
      g.lineJoin = 'round';
      g.stroke();
    }

    // 沉在海底的碎石：极少量，只在最前一层上面露一点头，提供"尺度"参照。
    // 不能多 —— 三块是地形，十块就是装饰。
    g.fillStyle = 'rgba(1,6,10,0.9)';
    for (let i = 0; i < 3; i++) {
      const x = W * (0.18 + i * 0.29 + rnd() * 0.08);
      const y = H * (0.60 + rnd() * 0.06);
      g.beginPath();
      g.ellipse(x, y, W * (0.012 + rnd() * 0.018), H * (0.030 + rnd() * 0.035), rnd() * 0.5 - 0.25, 0, TAU);
      g.fill();
    }

    return cv;
  }

  /**
   * 柔光点：浮游生物的单个发光体。
   * 直接画实心圆在任何画质下都是一个"贴纸圆点"——尤其是 low 档没有海雪做掩护，
   * 圆点会硬得像屏幕坏点。烘一张径向渐变，每帧只缩放 drawImage。
   */
  _bakeGlowDot(size) {
    const cv = this._off(size, size);
    const g = cv.getContext('2d');
    const r = size * 0.5;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(214,246,255,1)');
    gr.addColorStop(0.26, 'rgba(152,224,242,0.60)');
    gr.addColorStop(0.60, 'rgba(116,198,224,0.16)');
    gr.addColorStop(1, 'rgba(100,180,210,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, size, size);
    return cv;
  }

  // ---------------------------------------------------------
  //  缓存渐变
  // ---------------------------------------------------------

  /**
   * 水面之上的夜空。
   *
   * 这不是"贴一张背景板"——它是上半篇的另一半世界。只有浮到水面附近才看得见，
   * 而且看得见就代表你暴露在月光下。玩家每一次"跃"换来的氧气，
   * 代价就是把自己放到这片光里。
   *
   * 月亮不给满月：满月太亮、太甜。给一个偏黄的、边缘有点毛的，像隔着水汽看。
   */
  _bakeSky() {
    // 高度取 1.08 屏：玩家跃出水面时水面会压到画面底部，天空必须能铺满整屏，
    // 否则头顶会露出一条"水体色"的边 —— 那一眼就穿帮。
    const H = Math.round(this.h * 1.08);
    const cv = this._off(this.w, H);
    const g = cv.getContext('2d');

    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#01030a');
    gr.addColorStop(0.55, '#061019');
    gr.addColorStop(0.86, '#0d1d2b');
    gr.addColorStop(1, '#152a3a');
    g.fillStyle = gr;
    g.fillRect(0, 0, this.w, H);

    // 星星：位置固定死。每帧摇一次的星空会暴露"这是程序画的"。
    // 星星集中在下半部分（0.45~0.95）：整张天空图只有底部一截会出现在屏幕里，
    // 撒在顶部的星星永远是画给谁看的都不知道。
    // 星星：**要看得见**。第一版最亮只有 0.78 alpha、半径 1.4px，在手机屏上
    // 只像一层噪点。夜海的情绪有一半在星上，该亮就得亮。
    const rnd = mulberry32(77123);
    for (let i = 0; i < 150; i++) {
      const x = rnd() * this.w;
      const y = H * (0.45 + rnd() * 0.50);
      // 越靠近水面越稀疏：空气里的水汽把低处的星吃掉
      const fade = clamp(1 - (y - H * 0.45) / (H * 0.55), 0.42, 1);
      const big = rnd() < 0.16;
      const r = (big ? 1.1 : 0.45) + rnd() * (big ? 0.9 : 0.85);
      const a = (big ? 0.72 : 0.26) + rnd() * 0.28;
      g.fillStyle = `rgba(224,240,255,${a * fade})`;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
      if (big) {
        // 十字光芒：只给最大的那几颗，撒多了会像雪花
        g.strokeStyle = `rgba(206,230,255,${0.20 * fade})`;
        g.lineWidth = 0.8;
        g.beginPath();
        g.moveTo(x - r * 3.4, y); g.lineTo(x + r * 3.4, y);
        g.moveTo(x, y - r * 3.4); g.lineTo(x, y + r * 3.4);
        g.stroke();
      }
    }

    // 月亮：偏黄、带光晕，落在右上方（不压画面正中）
    const mx = this.w * 0.74;
    // 月亮放在 0.84：贴近水面，任何深度的跃出都看得见
    const my = H * 0.84;
    const mr = Math.min(this.w, H) * 0.048;
    // 光晕分两层：一层近而亮（贴着月盘），一层远而淡（照亮周围的海雾）。
    // 一层光晕在深色天空里会读成"贴了个圆"，两层才有光往外溢的感觉。
    const halo = g.createRadialGradient(mx, my, mr * 0.8, mx, my, mr * 9.5);
    halo.addColorStop(0, 'rgba(255,246,214,0.40)');
    halo.addColorStop(0.18, 'rgba(252,240,206,0.16)');
    halo.addColorStop(0.52, 'rgba(238,226,196,0.055)');
    halo.addColorStop(1, 'rgba(238,226,196,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, this.w, H);
    const halo2 = g.createRadialGradient(mx, my, mr * 0.94, mx, my, mr * 2.1);
    halo2.addColorStop(0, 'rgba(255,250,226,0.42)');
    halo2.addColorStop(1, 'rgba(255,250,226,0)');
    g.fillStyle = halo2;
    g.fillRect(0, 0, this.w, H);
    // 月盘：接近纯白，边缘略微偏暖
    g.fillStyle = 'rgba(255,252,238,1)';
    g.beginPath();
    g.arc(mx, my, mr, 0, TAU);
    g.fill();
    // 月面的一点点凹凸：纯圆读起来是"灯泡"
    g.fillStyle = 'rgba(232,220,194,0.26)';
    g.beginPath();
    g.arc(mx - mr * 0.28, my - mr * 0.22, mr * 0.26, 0, TAU);
    g.arc(mx + mr * 0.34, my + mr * 0.18, mr * 0.18, 0, TAU);
    g.fill();

    return cv;
  }

  /** 水面线：一条会呼吸的亮边。有它，"上面"和"下面"才真的分开。 */
  _drawWaterline(ctx, y, w) {
    if (y < -6 || y > this.h + 6) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(176,224,242,0.42)';
    ctx.beginPath();
    for (let x = 0; x <= w; x += 10) {
      const yy = y
        + Math.sin(x * 0.021 + this.time * 1.3) * 3.2
        + Math.sin(x * 0.053 - this.time * 2.0) * 1.5;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(140,200,226,0.10)';
    ctx.stroke();
    ctx.restore();
  }

  _waterGrad(depth) {
    const k = Math.round(clamp(depth, 0, 1) * 20) / 20;
    const key = 'w' + k;
    let g = this._grads.get(key);
    if (g) return g;
    const T = ['#3a8fae', '#17566f', '#0a2c3d', '#05161f'];
    // 最深一档不能真的到 #000204：玩家在第 7 波会一路潜到底，
    // 全黑会让"氧气没了"和"游戏崩了"长得一模一样。留一层极深的蓝，
    // 暗才有层次，结局也才读成"光没了"而不是"画面没了"。
    const D = ['#0a2a38', '#04141d', '#03101a', '#02090f'];
    g = this.ctx.createLinearGradient(0, 0, 0, this.h);
    for (let i = 0; i < 4; i++) g.addColorStop(i / 3, mix(T[i], D[i], k));
    this._grads.set(key, g);
    return g;
  }

  _whaleGrad(L, depth) {
    const k = Math.round(clamp(depth, 0, 1) * 10) / 10;
    const key = Math.round(L) + '|' + k;
    let g = this._whaleGrads.get(key);
    if (g) return g;
    const lit = lerp(1, 0.52, k);
    g = this.ctx.createLinearGradient(0, -0.17 * L, 0, 0.12 * L);
    g.addColorStop(0, mix('#16232f', '#0a121a', 1 - lit));
    g.addColorStop(0.34, mix('#33495c', '#1a2836', 1 - lit));
    g.addColorStop(0.72, mix('#7d95a6', '#3d505f', 1 - lit));
    g.addColorStop(1, mix('#b9c9d3', '#5f7280', 1 - lit));
    this._whaleGrads.set(key, g);
    return g;
  }

  /**
   * 平铺填充：优先用 CanvasPattern + setTransform 一次填满。
   * 不支持（老 Safari 没有 pattern.setTransform）就返回 false，让调用方退回循环绘制。
   * 这是"精致但不掉帧"的关键一步：一层焦散从二十多次 drawImage 变成一次 fillRect。
   */
  _fillTile(key, src, sc, ox, oy, x, y, w, h) {
    const ctx = this.ctx;
    if (!this._pats) this._pats = new Map();
    let p = this._pats.get(key);
    if (p === undefined) {
      try {
        p = ctx.createPattern(src, 'repeat');
      } catch (_) {
        p = null;
      }
      this._pats.set(key, p);
    }
    if (!p || typeof p.setTransform !== 'function' || typeof DOMMatrix === 'undefined') return false;
    try {
      p.setTransform(new DOMMatrix([sc, 0, 0, sc, ox, oy]));
    } catch (_) {
      return false;
    }
    ctx.fillStyle = p;
    ctx.fillRect(x, y, w, h);
    return true;
  }

  /** 只横向平铺（焦散带用）：纵向不平铺，所以纹理底部的渐隐不会被接回来 */
  _fillTileX(key, src, ox, y, w, h) {
    const ctx = this.ctx;
    if (!this._pats) this._pats = new Map();
    let p = this._pats.get(key);
    if (p === undefined) {
      try {
        p = ctx.createPattern(src, 'repeat-x');
      } catch (_) {
        p = null;
      }
      this._pats.set(key, p);
    }
    if (!p || typeof p.setTransform !== 'function' || typeof DOMMatrix === 'undefined') return false;
    try {
      p.setTransform(new DOMMatrix([1, 0, 0, 1, ox, 0]));
    } catch (_) {
      return false;
    }
    ctx.fillStyle = p;
    ctx.fillRect(0, y, w, h);
    return true;
  }

  // ---------------------------------------------------------
  //  主循环
  // ---------------------------------------------------------

  /**
   * 世界深度 → 屏幕 y。
   * 玩法层的网、钩、声呐环必须用这一条线换算，否则它们会和沉船、海床
   * 走在两套投影上 —— 表现就是"东西浮在水里不跟着镜头走"。
   */
  screenYof(worldDepth, camDepth = 0) {
    return this.h * 0.28 + (worldDepth - camDepth) * this.h * 2.0;
  }

  /**
   * @param dt 秒
   * @param st { camDepth, whale:{x,y,tilt,phase}, echo:0..1, echoT, reveal }
   */
  frame(dt, st) {
    if (!this._ready) return;
    this.time += dt;
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const q = QUALITY.prop;
    // 相机深度允许为负 —— 负值代表"跃出水面"，水面会压到画面下方，头顶全是夜空。
    // rawDepth 用来算投影，depth 只用于"水的颜色/雾化"这类非负量。
    const rawDepth = st.camDepth ?? 0;
    const depth = clamp(rawDepth, 0, 1);
    const light = !!q.haze;      // 光柱
    const caust = !!q.fog;       // 焦散（只 high）
    const snow = q.motes > 0;    // 海雪
    // 生命密度（0~1）：世界在往下死。海雪、浮游生物、光柱都跟着它一起少。
    // 不传就是满值，单测/截图不受影响。
    const life = clamp(st.life ?? 1, 0, 1);
    // 浑浊（0~1）：呼吸的次数越多，海越是一锅褐绿的汤。
    // 它不改变任何机制，只改变"这还是不是那片藏蓝色丝绸"。
    const murk = clamp(st.murk ?? 0, 0, 1);
    // 幻象（0~1）：结局的花园。水变清变亮、光柱回来、一切回到第一层的样子，
    // 然后熄灭。它是「我看见 最美丽的花园」的全部画面。
    const vision = clamp(st.vision ?? 0, 0, 1);

    // 统一的世界深度投影：屏幕 y = 画面中心 + (世界深度 - 相机深度) × K。
    // 相机在水下，世界深度 0 = 水面。K 取 2.0h，一幅屏幕正好装 0.5 个深度单位，
    // 往下潜一格就"越过"一格东西 —— 沉船、地形都按这条线走，不会各走各的。
    const K = h * 2.0;
    const surfaceY = h * 0.28 - rawDepth * K;
    // 基准必须和水面线一致（0.28h）：以前这里写 0.5h，水面和所有实体之间
    // 差了 0.22 屏 —— 玩家在深处看不到水面所以没暴露，一浮上来船就沉进水里了。
    const screenYof = (worldDepth) => h * 0.28 + (worldDepth - rawDepth) * K;

    // 1) 水体
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = this._waterGrad(depth * (1 - vision * 0.72));
    ctx.fillRect(0, 0, w, h);
    // 浑浊：一层低不透明度的褐绿。幻象时被冲掉 —— 花园里没有人类的颜色
    if (murk > 0.02 && vision < 0.98) {
      ctx.globalAlpha = murk * (1 - vision) * 0.34;
      ctx.fillStyle = '#3e4a26';
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    // 幻象的亮：不是加白，是加"浅水的颜色"。整个画面往回走。
    if (vision > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = vision * 0.20;
      ctx.fillStyle = '#7ec8dc';
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // 1.5) 水面之上：夜空。
    //      它不是背景板，是另一个世界 —— 只有浮上去才存在，而浮上去就等于
    //      站在月光底下被看见。整关"呼吸 vs 安全"的对立在画面上就是这一条线。
    if (this._sky && surfaceY > -4) {
      const skyA = clamp(surfaceY / (h * 0.06), 0, 1);
      if (skyA > 0.01) {
        ctx.globalAlpha = skyA;
        ctx.drawImage(this._sky, 0, surfaceY - this._sky.height, w, this._sky.height);
        ctx.globalAlpha = 1;
        this._drawWaterline(ctx, surfaceY, w);
      }
    }

    // 2) 水面辉光 + 远景
    //    先铺水面：它上下都渐隐，落在画面任何位置都不会出现硬边
    // 幻象时光柱一定在：哪怕你在最深处，花园里也有光。
    const shaftA = clamp((surfaceY + h * 0.85) / (h * 0.85), 0, 1)
      * clamp(1 - murk * 0.55, 0, 1) + vision * 0.85;
    if (this._surface && shaftA > 0.01) {
      const sh = this._surface.height;
      const sy0 = surfaceY + h * 0.04 - sh;
      if (sy0 < h) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = clamp(shaftA * 1.05, 0, 1);
        ctx.drawImage(this._surface, 0, sy0, w, sh);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    // 2.5) 海床：画面底座。
    //    它锚在"相机下方固定距离"而不是某个世界深度 —— 海底是无限大的平面，
    //    给它一个深度值会让它在下潜时从头顶飞过去。所以这里用两件事表达深度：
    //    浅水看不见（alpha 跟 depth 走），越深越往上顶（位置跟 depth 走）。
    if (this._seabed && st.bed !== false) {
      const bh = h * 0.55;
      const bedA = clamp((depth - 0.08) / 0.40, 0, 1) * (light ? 0.95 : 0.88);
      if (bedA > 0.01) {
        const by = h - bh * 0.62 + (0.45 - depth) * h * 0.26;
        const drift = Math.sin(this.time * 0.043) * w * 0.05;
        ctx.globalAlpha = bedA;
        ctx.drawImage(this._seabed, -w * 0.35 + drift, by, w * 1.7, bh);
        ctx.globalAlpha = 1;

        // 浮游体的冷光：20 张预烘的柔光点，缩放后叠加。
        // 用 lighter —— 它是"自己发光的"，不是"被照亮的灰"。
        if (this._plankton && this._dot) {
          const top = h * 0.40;
          const span = h * 0.62;
          const ps = w / 390;
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.38 * bedA;
          // 生物荧光也在跟着世界一起死：第 7 波只剩一两颗
          const pn = Math.round(this._plankton.length * life);
          for (let i = 0; i < pn; i++) {
            const m = this._plankton[i];
            const y = top + (((m.y * span - this.time * m.sp) % span) + span) % span;
            const x = m.x * w + Math.sin(this.time * 0.37 + m.ph) * w * 0.016;
            const d = m.r * ps * 3.4;
            ctx.drawImage(this._dot, x - d * 0.5, y - d * 0.5, d, d);
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }
      }
    }

    // 沉船：世界深度 0.62 —— 下潜到中段才真正看清它，再往深它就从头顶过去了。
    // 这是这一篇唯一的地标，也是"这里死过东西"的证据。
    if (this._ship) {
      const sw = w * 1.38;
      const sh = sw * 0.347;
      const sy = screenYof(0.62) - sh * 0.55;
      if (sy < h + sh && sy > -sh * 1.4) {
        const bob = Math.sin(this.time * 0.32) * h * 0.005;
        // 越远越淡：雾化的程度跟它离相机多远走
        const dist = Math.abs(screenYof(0.62) - h * 0.5) / (h * 1.2);
        // shipBoost：第 3 波「是那沉没的舰」时抬亮。它在那一段是主角，
        // 不是背景板 —— 按默认透明度，深水里就是一块看不见的黑。
        const boost = st.shipBoost || 0;
        // 0.80 起：0.62 的时候它在 0.48 深度几乎和背景同色，
        // 玩家从旁边游过去也认不出那是"那艘沉没的舰"。
        ctx.globalAlpha = clamp(0.80 - dist * 0.34 - depth * 0.10 + boost * 0.24, 0.10, 0.95);
        ctx.drawImage(this._ship, w * 0.5 - sw * 0.5 + w * 0.05, sy + bob, sw, sh);
        ctx.globalAlpha = 1;
      }
    }

    // 3) 光柱：透明度直接跟着水面在屏幕上的位置走 —— 水面一离开画面，
    //    光就自然消失，不需要另写一套"深度阈值"。
    if (light && shaftA > 0.01) {
      const lh = Math.min(h - surfaceY, h * 1.3);
      if (lh > 0) {
        ctx.globalCompositeOperation = 'screen';
        const sway = Math.sin(this.time * 0.22) * w * 0.03;
        ctx.globalAlpha = shaftA * (0.38 + life * 0.62);
        ctx.drawImage(this._rays, sway - w * 0.15, surfaceY, w * 1.35, lh);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    // 4) 焦散：一条上浓下淡的带，只横向平铺。渐隐烘进纹理，所以不用 clip ——
    //    第一版是"全屏可平铺 + clip 一条带"，屏幕上必然出现一条笔直的切边。
    if (caust && shaftA > 0.01 && this._caustics) {
      const band = this._caustics;
      const bh = band.height;
      if (surfaceY < h && surfaceY + bh > 0) {
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = clamp(shaftA * 1.0, 0, 1);
        const ox = ((this.time * 9) % band.width + band.width) % band.width;
        if (!this._fillTileX('caustics', band, ox, surfaceY, w, bh)) {
          for (let x = -band.width; x < w + band.width; x += band.width) {
            ctx.drawImage(band, x + ox, surfaceY);
          }
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    // 5) 海雪：两层视差，同样用 pattern 一次填满
    if (snow) {
      ctx.globalCompositeOperation = 'lighter';
      const base = 1.55 * (w / 390);
      for (let layer = 0; layer < 2; layer++) {
        const sc = base * (layer ? 1.45 : 1);
        const tw = this._snow.width * sc;
        const th = this._snow.height * sc;
        const ox = ((layer * 97 + this.time * (layer ? 13 : 5)) % tw + tw) % tw;
        const oy = ((layer * 53 + this.time * (layer ? 19 : 8)) % th + th) % th;
        ctx.globalAlpha = (layer ? 0.3 : 0.52) * clamp(1 - depth * 0.55, 0.2, 1) * (0.28 + life * 0.72);
        if (!this._fillTile('snow', this._snow, sc, ox, oy, 0, 0, w, h)) {
          ctx.globalAlpha = 0;
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // 6) 鲸
    // lateWhale = 玩家在水面之上：这时候它必须画在海面那一层（城市、船）**之后**，
    // 否则远处的楼会盖在它身上 —— 跃出水面的一瞬间看起来像嵌在楼群里。
    const drawPlayerWhale = () => {
      const wh = st.whale || {};
      const L = wh.L ?? Math.min(w * 0.92, h * 0.5);
      const wx = wh.x ?? w * 0.5;
      const wy = wh.y ?? h * 0.48;
      if (st.sprite && st.sprite.ready) {
        // 贴图路线：一张插画 + 分件旋转 + 剪切形变
        st.sprite.draw(ctx, wx, wy, L, {
          time: this.time,
          phase: wh.phase,
          echo: st.echo || 0,
          tilt: wh.tilt ?? 0,
          flip: !!wh.flip,
          depth,
          screenH: h,
        });
      } else {
        // 没图就走矢量占位（形状是准的，但不精致）
        this.drawWhale(wx, wy, L, {
          tilt: wh.tilt ?? 0,
          phase: wh.phase ?? 0,
          depth,
          echo: st.echo || 0,
          silhouette: false,   // 兜底也要有颜色：纯黑一团会被当成贴图丢了
        });
      }
    };
    if (st.whale !== false && !st.lateWhale) drawPlayerWhale();

    // 6.5) 前景海雪：画在角色之后，粒子从角色前面飘过。
    // 这一步是"贴纸感"的解药 —— 只要有一层东西盖在角色上，它就从"贴在画面上"
    // 变成"真的泡在水里"。放大 3.4 倍让颗粒变成虚的大颗（近处失焦），
    // 移动速度给到背景那层的 2.5 倍做视差。
    if (snow) {
      const scN = 3.4 * (this.w / 390);
      const twN = this._snow.width * scN;
      const thN = this._snow.height * scN;
      const oxN = ((this.time * 26) % twN + twN) % twN;
      const oyN = ((this.time * 37) % thN + thN) % thN;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.22 * clamp(1 - depth * 0.35, 0.4, 1);
      if (!this._fillTile('snowNear', this._snow, scN, oxN, oyN, 0, 0, w, h)) {
        // createPattern 不可用时直接跳过，别退化成满屏 drawImage
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // 7) 回声环
    this._drawEchoRings(st, h);

    // 7.5) 实体层：网、钩、声呐、海鸥、同类。由玩法层回调，画在暗角之前 ——
    //      暗角代表镜头，实体必须也在镜头里，否则它们会像贴纸浮在最上面。
    if (typeof st.entities === 'function') st.entities(ctx, this);

    // 7.6) 跃出水面的玩家：现在它已经在水面那一层之上了
    if (st.whale !== false && st.lateWhale) drawPlayerWhale();

    // 8) 暗角
    if (this._vignette) {
      ctx.globalAlpha = 1;
      ctx.drawImage(this._vignette, 0, 0, w, h);
    }

    // 8.5) 缺氧：视野从四周往中间收。
    //      不是 UI 元素，是身体的感觉 —— 玩家先看见"看不太清了"，才去看氧气数字。
    const panic = clamp(st.panic || 0, 0, 1);
    if (panic > 0.01 && this._vignette) {
      ctx.globalAlpha = panic * 0.95;
      ctx.drawImage(this._vignette, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // 9) 结局压暗：不是黑屏，是"越来越暗"。
    //    强度上限 0.45 —— 全黑会读成"游戏崩了"，留一半才读成"光没了"。
    const dim = clamp(st.dim || 0, 0, 1);
    if (dim > 0.01) {
      ctx.globalAlpha = dim * 0.9;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------
  //  回声可视化
  // ---------------------------------------------------------

  _drawEchoRings(st, h) {
    const e = st.echo || 0;
    if (e <= 0.01) return;
    const ctx = this.ctx;
    const w = this.w;
    const ox = (st.whale && st.whale.x) ?? w * 0.5;
    const oy = (st.whale && st.whale.y) ?? h * 0.48;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const p = clamp(e - i * 0.16, 0, 1);
      if (p <= 0) continue;
      const r = p * Math.max(w, h) * 0.62;
      const a = (1 - p) * (1 - p) * 0.34;
      ctx.strokeStyle = `rgba(150,226,255,${a})`;
      ctx.lineWidth = Math.max(0.8, 3.4 * (1 - p));
      ctx.beginPath();
      ctx.arc(ox, oy, r, 0, TAU);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------
  //  鲸
  // ---------------------------------------------------------

  _lg(key, make) {
    let g = this._lgc.get(key);
    if (!g) {
      g = make();
      this._lgc.set(key, g);
    }
    return g;
  }

  /** 左上打下来的受光面 */
  _whaleLightGrad(L, k) {
    return this._lg('lit' + Math.round(L) + '|' + k, () => {
      const a = 0.20 * (1 - k * 0.55);
      const g = this.ctx.createLinearGradient(-0.32 * L, -0.17 * L, 0.18 * L, 0.10 * L);
      g.addColorStop(0, `rgba(202,230,248,${a})`);
      g.addColorStop(0.5, `rgba(202,230,248,${a * 0.28})`);
      g.addColorStop(1, 'rgba(202,230,248,0)');
      return g;
    });
  }

  /** 腹部反光（焦散打上来的冷青） */
  _whaleBellyGrad(L, bel) {
    return this._lg('bel' + Math.round(L) + '|' + Math.round(bel * 8), () => {
      const g = this.ctx.createLinearGradient(0, 0.02 * L, 0, 0.115 * L);
      g.addColorStop(0, 'rgba(120,206,226,0)');
      g.addColorStop(1, `rgba(132,216,236,${0.16 * bel})`);
      return g;
    });
  }

  /** 胸鳍：根部亮、翼尖暗，靠这点明暗差把它从身体上分出来 */
  _whaleFinGrad(L, k) {
    return this._lg('fin' + Math.round(L) + '|' + k, () => {
      const g = this.ctx.createLinearGradient(0.22 * L, 0.05 * L, 0.06 * L, 0.30 * L);
      g.addColorStop(0, mix('#2b3e50', '#16242f', k));
      g.addColorStop(1, mix('#16242f', '#0a141c', k));
      return g;
    });
  }

  /**
   * 座头鲸。局部坐标：L = 全长，x 从 -0.5（尾鳍尖）到 +0.5（吻），y 向下为正。
   *
   * 第一版的教训：身体画成椭圆、尾鳍单独贴在左边、胸鳍只剩一根细条 —— 结果像潜艇。
   * 真正让它"是鲸"的是四件事：
   *   ① 尾柄必须明显收窄（体深 0.058L，最大体深 0.265L），否则就是个纺锤；
   *   ② 尾鳍要和尾柄重叠一段，不能是贴上去的三角形；
   *   ③ 胸鳍要占体长三成，前缘还得有瘤突（座头鲸的指纹）；
   *   ④ 嘴线从吻端一直后拉到眼下 —— 鲸脸的辨识度几乎全在这一条线上。
   */
  drawWhale(x, y, L, o) {
    const ctx = this.ctx;
    const sil = !!o.silhouette;
    const echo = o.echo || 0;
    const ph = o.phase || 0;
    const k = Math.round(clamp(o.depth || 0, 0, 1) * 10) / 10;

    ctx.save();
    ctx.translate(x, y);
    if (o.tilt) ctx.rotate(o.tilt);

    const sway = Math.sin(ph) * 0.026 * L;

    // ---- 尾鳍：两片带深缺刻；与尾柄重叠 0.02L，接缝藏在身体底下 ----
    ctx.save();
    ctx.translate(-0.318 * L, 0.002 * L);
    ctx.rotate(Math.sin(ph) * 0.14);
    ctx.fillStyle = sil ? '#04090d' : mix('#22313f', '#0e1a24', 0.45);
    ctx.beginPath();
    ctx.moveTo(0.030 * L, -0.044 * L);
    ctx.quadraticCurveTo(-0.080 * L, -0.108 * L, -0.182 * L, -0.150 * L);
    ctx.quadraticCurveTo(-0.158 * L, -0.070 * L, -0.104 * L, -0.004 * L);
    ctx.lineTo(-0.086 * L, 0.010 * L);
    ctx.quadraticCurveTo(-0.156 * L, 0.066 * L, -0.182 * L, 0.136 * L);
    ctx.quadraticCurveTo(-0.078 * L, 0.086 * L, 0.030 * L, 0.040 * L);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ---- 身体轮廓 ----
    const body = new Path2D();
    body.moveTo(-0.335 * L, -0.028 * L + sway);
    body.bezierCurveTo(-0.255 * L, -0.060 * L, -0.150 * L, -0.126 * L + sway * 0.6, -0.020 * L, -0.147 * L);
    body.bezierCurveTo(0.100 * L, -0.161 * L, 0.240 * L, -0.146 * L, 0.335 * L, -0.114 * L);
    body.bezierCurveTo(0.410 * L, -0.089 * L, 0.462 * L, -0.057 * L, 0.490 * L, -0.026 * L);
    body.quadraticCurveTo(0.508 * L, -0.004 * L, 0.494 * L, 0.016 * L);
    body.bezierCurveTo(0.466 * L, 0.042 * L, 0.386 * L, 0.069 * L, 0.276 * L, 0.085 * L);
    body.bezierCurveTo(0.156 * L, 0.102 * L, 0.026 * L, 0.105 * L, -0.094 * L, 0.095 * L);
    body.bezierCurveTo(-0.204 * L, 0.086 * L, -0.290 * L, 0.058 * L, -0.335 * L, 0.030 * L);
    body.closePath();

    ctx.fillStyle = sil ? '#04090d' : this._whaleGrad(L, k);
    ctx.fill(body);

    if (!sil) {
      ctx.save();
      ctx.clip(body);

      // 受光面：从左上打下来的一道光
      ctx.fillStyle = this._whaleLightGrad(L, k);
      ctx.fillRect(-0.55 * L, -0.2 * L, 1.1 * L, 0.36 * L);

      // 斑驳：几块低对比暗斑，破掉渐变的塑料感。位置用固定种子，不会每帧跳
      for (const s of this._spots) {
        ctx.fillStyle = `rgba(8,20,28,${0.045 + s.a * 0.05})`;
        ctx.beginPath();
        ctx.ellipse(s.x * L, s.y * L, s.rx * L, s.ry * L, s.rot, 0, TAU);
        ctx.fill();
      }

      // 腹部反光：焦散打上来的冷青色，只在接近水面时明显
      const bel = clamp(1 - k * 1.5, 0, 1);
      if (bel > 0.02) {
        ctx.fillStyle = this._whaleBellyGrad(L, bel);
        ctx.fillRect(-0.5 * L, 0, 1.02 * L, 0.13 * L);
      }

      // 喉腹褶：座头鲸的签名。八道顺着腹部弧线，从下颌拉到胸鳍后面
      ctx.strokeStyle = `rgba(10,24,32,${0.20 + 0.15 * (1 - k)})`;
      ctx.lineWidth = Math.max(0.5, 0.0032 * L);
      for (let i = 0; i < 8; i++) {
        const t = i / 7;
        const y0 = lerp(0.050, 0.099, t) * L;
        ctx.beginPath();
        ctx.moveTo(0.450 * L, y0 - 0.018 * L);
        ctx.bezierCurveTo(0.30 * L, y0 + 0.008 * L, 0.10 * L, y0 + 0.008 * L, -0.078 * L, y0 - 0.014 * L);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- 轮廓光：只勾上缘。整圈描会立刻变成贴纸 ----
    ctx.strokeStyle = sil ? 'rgba(160,226,255,0.6)' : `rgba(196,232,255,${0.22 + 0.22 * (1 - k)})`;
    ctx.lineWidth = Math.max(0.7, 0.005 * L);
    ctx.beginPath();
    ctx.moveTo(-0.335 * L, -0.028 * L + sway);
    ctx.bezierCurveTo(-0.255 * L, -0.060 * L, -0.150 * L, -0.126 * L + sway * 0.6, -0.020 * L, -0.147 * L);
    ctx.bezierCurveTo(0.100 * L, -0.161 * L, 0.240 * L, -0.146 * L, 0.335 * L, -0.114 * L);
    ctx.bezierCurveTo(0.410 * L, -0.089 * L, 0.462 * L, -0.057 * L, 0.488 * L, -0.027 * L);
    ctx.stroke();

    // ---- 背鳍：小、向后钩，长在驼峰上 ----
    ctx.fillStyle = sil ? '#04090d' : mix('#1a2836', '#0c1720', 0.4);
    ctx.beginPath();
    ctx.moveTo(-0.008 * L, -0.150 * L);
    ctx.quadraticCurveTo(-0.048 * L, -0.181 * L, -0.076 * L, -0.157 * L);
    ctx.quadraticCurveTo(-0.042 * L, -0.147 * L, -0.028 * L, -0.139 * L);
    ctx.closePath();
    ctx.fill();

    // ---- 近侧胸鳍：长刀形，约占体长三成；前缘带瘤突 ----
    const fw = Math.sin(ph + 0.8) * 0.010 * L;
    ctx.fillStyle = sil ? '#050b10' : this._whaleFinGrad(L, k);
    ctx.beginPath();
    ctx.moveTo(0.232 * L, 0.044 * L);
    ctx.bezierCurveTo(0.176 * L, 0.104 * L + fw, 0.104 * L, 0.198 * L + fw, 0.064 * L, 0.286 * L);
    ctx.quadraticCurveTo(0.046 * L, 0.320 * L, 0.026 * L, 0.304 * L);
    ctx.bezierCurveTo(0.042 * L, 0.234 * L, 0.080 * L, 0.144 * L, 0.110 * L, 0.068 * L);
    ctx.quadraticCurveTo(0.156 * L, 0.058 * L, 0.232 * L, 0.044 * L);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `rgba(180,216,236,${0.14 + 0.14 * (1 - k)})`;
    ctx.lineWidth = Math.max(0.5, 0.0034 * L);
    ctx.stroke();

    if (!sil) {
      // 前缘瘤突
      ctx.fillStyle = 'rgba(164,196,214,0.26)';
      for (let i = 0; i < 6; i++) {
        const t = 0.10 + i * 0.15;
        const px = lerp(0.176 * L, 0.030 * L, t);
        const py = lerp(0.104 * L, 0.296 * L, t) + fw * t;
        ctx.beginPath();
        ctx.arc(px - 0.006 * L, py, 0.0072 * L, 0, TAU);
        ctx.fill();
      }

      // 嘴线：从吻端后拉到眼下方。鲸脸能不能认出来，八成靠这一条
      ctx.strokeStyle = `rgba(6,16,22,${0.48 + 0.2 * (1 - k)})`;
      ctx.lineWidth = Math.max(0.7, 0.0042 * L);
      ctx.beginPath();
      ctx.moveTo(0.494 * L, 0.016 * L);
      ctx.bezierCurveTo(0.44 * L, 0.042 * L, 0.372 * L, 0.056 * L, 0.318 * L, 0.060 * L);
      ctx.stroke();
      // 下颌线：更浅一层，提示嘴是张着的结构
      ctx.strokeStyle = 'rgba(140,176,196,0.16)';
      ctx.lineWidth = Math.max(0.4, 0.0022 * L);
      ctx.beginPath();
      ctx.moveTo(0.486 * L, 0.026 * L);
      ctx.bezierCurveTo(0.43 * L, 0.050 * L, 0.372 * L, 0.064 * L, 0.330 * L, 0.068 * L);
      ctx.stroke();

      // 眼：小而黑，一点高光就是"活物"和"石头"的分界
      const ex = 0.302 * L;
      const ey = 0.020 * L;
      ctx.fillStyle = 'rgba(3,9,13,0.94)';
      ctx.beginPath();
      ctx.ellipse(ex, ey, 0.0092 * L, 0.0080 * L, 0.25, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(214,242,255,0.7)';
      ctx.beginPath();
      ctx.arc(ex + 0.0024 * L, ey - 0.0022 * L, 0.0024 * L, 0, TAU);
      ctx.fill();

      // 呼吸孔
      ctx.fillStyle = 'rgba(8,20,28,0.42)';
      ctx.beginPath();
      ctx.ellipse(0.348 * L, -0.104 * L, 0.011 * L, 0.0048 * L, -0.22, 0, TAU);
      ctx.fill();

      // 吻瘤：沿吻背的几个小凸起
      ctx.fillStyle = 'rgba(150,184,204,0.20)';
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        ctx.beginPath();
        ctx.arc(lerp(0.408 * L, 0.486 * L, t), lerp(-0.090 * L, -0.030 * L, t), 0.0055 * L, 0, TAU);
        ctx.fill();
      }

      // 生物荧光：只有深处才亮，靠 sin 缓慢明灭
      const bio = clamp(k * 1.5 - 0.35, 0, 1);
      if (bio > 0.02) {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < this._bio.length; i++) {
          const p = this._bio[i];
          const tw = 0.45 + 0.55 * Math.sin(this.time * 1.7 + i * 1.31);
          const a = bio * tw * 0.5;
          if (a < 0.02) continue;
          ctx.fillStyle = `rgba(126,238,214,${a})`;
          ctx.beginPath();
          ctx.arc(p.x * L, p.y * L, 0.0032 * L + 0.0022 * L * tw, 0, TAU);
          ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    // ---- 回声揭示：发声的那一秒，轮廓被"照亮" ----
    if (echo > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(168,236,255,${0.7 * echo})`;
      ctx.lineWidth = Math.max(1, 0.008 * L);
      ctx.stroke(body);
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.restore();
  }
}
