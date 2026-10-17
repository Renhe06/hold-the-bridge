// ============================================================
//  程序化渲染层：整座桥、夜空、丧尸、战车、特效全部用 Canvas 路径画出来
//
//  性能约定（手机上很关键）：
//   - 完全不用 ctx.shadowBlur（移动端极慢）
//   - 发光效果预先烘焙成 64×64 精灵图，之后靠 drawImage 缩放贴
//   - 星空 / 城市剪影烘焙成离屏 canvas，只在 resize 时重算
//   - 径向渐变只在上面那两种烘焙里创建，主循环里不新建渐变对象
// ============================================================

import { CFG, WEAPON_TIERS, isHordeWave, isBossWave, pvzPlant } from './config.js';
import { STATE } from './game.js';
import { clamp, mulberry32, mix, rgba } from './util.js';
import { QUALITY } from './quality.js';
import { I18N } from './i18n.js';

const TAU = Math.PI * 2;
// 画布里的字全用得意黑（子集化的 woff2 在 styles.css 里 @font-face 声明）。
// "Smiley Sans" 已经在 main.js 里等加载完成才开第一帧，不会出现系统字闪一下。
const FONT = '"Smiley Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, system-ui, sans-serif';
// 正文（说明弹窗那种长段落）仍然交给系统字：得意黑只有一个字重，长文会糊成一团
const FONT_BODY = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, system-ui, sans-serif';

/** 加成标签 → 颜色（奖励门和 HUD 提示共用） */
export const TAG_COLOR = {
  伤害: '#ff6b4a',
  射速: '#ffd166',
  弹道: '#7df9ff',
  特效: '#ff7df2',
  机动: '#8bf58b',
  生存: '#6ea8ff',
};

/** 实体深度排序（提到模块级：原来每帧新建一个比较函数闭包） */
const BY_Z_DESC = (a, b) => b.z - a.z;

function roundRect(ctx, x, y, w, h, r) {  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

export class Renderer {
  constructor(canvas, camera, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    // 中英双语（用户 m02901）：画布上所有文字都走 fillText/strokeText，
    // 在这一层装一次查表就够，渲染代码里不用逐句包 t()
    I18N.installCanvas(this.ctx);
    this.cam = camera;
    this.game = game;
    this.dpr = 1;
    this.glowCache = new Map();
    this._list = [];
    this._pool = [];   // 实体排序用的复用对象池（见 _drawEntities）
    this._active = [];
    this.time = 0;
  }

  // ---------------------------------------------------------
  //  尺寸 / 烘焙
  // ---------------------------------------------------------

  resize(cssW, cssH, dpr) {
    this.dpr = dpr;
    this.w = cssW;
    this.h = cssH;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this._bakeSky();
    this._bakeCity();
    this._bakedTheme = CFG.level.theme;
    // 尺寸变了一切烘焙图都失效（静态背景 / 桥面）
    this._bakeKey = '';
    return this;
  }

  /**
   * 【用户 m08839】「打僵尸视觉上会卡顿，尤其是僵尸潮」—— 固定镜头下有两层东西
   * **既不看时间也不看战局**：
   *   · 背景层 `_drawBackdrop`（夜空/城景/地平线光，0 个 this.time 引用）
   *   · 桥面   `_drawDeck`（石砖/苔痕/静态痕迹，0 个 this.time、0 个 game.* 引用，
   *             痕迹走的是 `_deckMarksCache`）—— 石桥一段要画 150+ 个 quad 加描边
   * 这两层各烘焙一张离屏图，每帧只 drawImage 两次；逐像素和原来重画一致。
   * 失效条件：resize、换关卡主题、换皮肤（统一走 `_bakeKey`）。
   * 注意 `_drawDeck` 内部会调 `_drawGlow()`，而它用的是 `this.ctx` —— 烘焙时临时
   * 把 `this.ctx` 指向离屏 context，否则灯的光晕会画到主画布上。
   */
  _syncBaked(w, h) {
    const key = w + 'x' + h + '@' + this.dpr + '|' + CFG.level.theme + '|' + CFG.level.skin;
    if (this._bakeKey === key && this._bgCv && this._deckCv) return;
    this._bakeKey = key;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * this.dpr));
      c.height = Math.max(1, Math.round(h * this.dpr));
      const g = c.getContext('2d');
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      return { c, g };
    };
    // 背景 = 夜空/城景/地平线光 + 海面底色渐变（都在飞机与浮游物下面）
    const bg = mk();
    this._drawBackdrop(bg.g, w, h);
    this._drawWaterBase(bg.g, w, h);
    this._bgCv = bg.c;
    // 桥面 = 石砖/苔痕/静态痕迹（血泊与尸体在 `_drawGround` 里，仍逐帧画在上面）
    const dk = mk();
    const prevCtx = this.ctx;
    this.ctx = dk.g;
    this._drawDeck(dk.g);
    this.ctx = prevCtx;
    this._deckCv = dk.c;
  }

  _glow(color) {
    let c = this.glowCache.get(color);
    if (c) return c;
    const S = 64;
    c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const g2 = c.getContext('2d');
    const g = g2.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.24, color);
    g.addColorStop(0.55, rgba(color, 0.45));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    g2.fillStyle = g;
    g2.fillRect(0, 0, S, S);
    this.glowCache.set(color, c);
    return c;
  }

  _drawGlow(x, y, r, color, alpha = 1) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.drawImage(this._glow(color), x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** 烘焙星空（含月亮），只在 resize 时重做 */
  _bakeSky() {
    const w = this.w;
    const h = Math.ceil(this.h * CFG.horizonRatio) + 8;
    const c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    const g = c.getContext('2d');

    const T = CFG.theme;
    const sky = g.createLinearGradient(0, 0, 0, h);
    const skyStops = [0, 0.5, 0.82, 1];
    T.sky.forEach((c, i) => sky.addColorStop(skyStops[i], c));
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // 地平线光污染（第一关是城市的橙光，水世界是池底漫上来的蓝白水汽）
    const pollute = g.createRadialGradient(w * 0.5, h, 0, w * 0.5, h, w * 0.72);
    pollute.addColorStop(0, T.pollute[0]);
    pollute.addColorStop(0.45, T.pollute[1]);
    pollute.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = pollute;
    g.fillRect(0, 0, w, h);

    const rnd = mulberry32(20260416);
    if (T.skyDeco === 'clouds') {
      // 疯狂草坪（第三关）：白天，天上飘的是一团团的卡通白云。
      // 一朵云 = 五个圆叠出来，边是软的，和夜景的星星形成"完全另一个地方"。
      const L = T.lawn;
      for (let i = 0; i < 10; i++) {
        const x = rnd() * w;
        const y = 4 + rnd() * (h - 26);
        const s = 0.55 + rnd() * 0.85;
        const a = 0.42 + rnd() * 0.3;
        g.fillStyle = `${L.cloud}${a})`;
        const blobs = [
          [-1.5, 0.25, 0.6],
          [-0.5, -0.2, 0.85],
          [0.65, -0.05, 0.72],
          [1.7, 0.28, 0.52],
          [0.1, 0.32, 0.68],
        ];
        for (const [bx, by, br] of blobs) {
          g.beginPath();
          g.arc(x + bx * 24 * s, y + by * 24 * s, br * 24 * s, 0, TAU);
          g.fill();
        }
      }
    } else if (T.skyDeco === 'bubbles') {
      // 水世界：天上飘的是往上冒的气泡（不是星星）
      for (let i = 0; i < 80; i++) {
        const x = rnd() * w;
        const y = rnd() * h;
        const r = 1.4 + rnd() * 5.5;
        const a = 0.1 + rnd() * 0.26;
        g.fillStyle = `${T.bubble}${a})`;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
        g.strokeStyle = `rgba(255,255,255,${a})`;
        g.lineWidth = 1;
        g.stroke();
      }
    } else {
      // 星星
      for (let i = 0; i < 150; i++) {
        const x = rnd() * w;
        const y = rnd() * (h - 14) * 0.92;
        const a = 0.15 + rnd() * 0.7;
        const r = 0.4 + rnd() * 1.05;
        g.fillStyle = `rgba(${T.starRGB},${a * (1 - y / h) + 0.06})`;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
      }
    }

    // 疯狂草坪（第三关）：头顶那颗是**太阳**，不是月亮 —— 白天关卡必须有太阳
    if (T.skyDeco === 'clouds') {
      const L = T.lawn;
      const mx = w * 0.74;
      const my = h * 0.3;
      const mr = Math.max(12, w * 0.05);
      const halo = g.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 6);
      halo.addColorStop(0, 'rgba(255,244,180,0.55)');
      halo.addColorStop(0.35, 'rgba(255,236,150,0.18)');
      halo.addColorStop(1, 'rgba(255,240,170,0)');
      g.fillStyle = halo;
      g.fillRect(mx - mr * 6, my - mr * 6, mr * 12, mr * 12);
      // 十二道光芒
      g.save();
      g.translate(mx, my);
      g.fillStyle = 'rgba(255,246,200,0.5)';
      for (let i = 0; i < 12; i++) {
        g.rotate(TAU / 12);
        g.fillRect(mr * 0.92, -1.6, mr * 0.62, 3.2);
      }
      g.restore();
      g.fillStyle = L.sun;
      g.beginPath();
      g.arc(mx, my, mr, 0, TAU);
      g.fill();
      g.fillStyle = L.sunCore;
      g.beginPath();
      g.arc(mx, my, mr * 0.72, 0, TAU);
      g.fill();
      this.skyCanvas = c;
      this.skyH = h;
      return;
    }

    // 月亮（在水世界里它读作一盏大射灯 / 大气泡）
    const mx = w * 0.72;
    const my = h * 0.34;
    const mr = Math.max(13, w * 0.055);
    const halo = g.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 5.2);
    halo.addColorStop(0, 'rgba(210,225,240,0.20)');
    halo.addColorStop(0.4, 'rgba(170,195,225,0.07)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = halo;
    g.fillRect(mx - mr * 5.2, my - mr * 5.2, mr * 10.4, mr * 10.4);

    g.fillStyle = T.moon;
    g.beginPath();
    g.arc(mx, my, mr, 0, TAU);
    g.fill();
    g.fillStyle = T.moonSpot;
    g.beginPath();
    g.arc(mx - mr * 0.28, my - mr * 0.2, mr * 0.2, 0, TAU);
    g.arc(mx + mr * 0.3, my + mr * 0.26, mr * 0.14, 0, TAU);
    g.arc(mx + mr * 0.05, my - mr * 0.42, mr * 0.1, 0, TAU);
    g.fill();
    // 【用户 m07770】第四关的天空要更"异世界"：
    // 一大一小两颗月亮（原来只有一颗普通的）+ 一颗带环的行星 + 三道极光带。
    // 这些只画在 skyCanvas 里（一次性烘焙），不占每帧开销。
    if (CFG.level.skin === 'fantasy') {
      const F = T.fantasy;
      // ── 极光：三条竖着流的软光带，加色叠加 ──
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        const ax = w * (0.1 + i * 0.24);
        const band = g.createLinearGradient(0, 0, w * 0.5, 0);
        const hue = i % 2 ? '150,255,210' : '176,150,255';
        band.addColorStop(0, `rgba(${hue},0)`);
        band.addColorStop(0.45, `rgba(${hue},0.17)`);
        band.addColorStop(1, `rgba(${hue},0)`);
        g.fillStyle = band;
        g.beginPath();
        g.moveTo(ax - w * 0.16, 0);
        g.quadraticCurveTo(ax, h * 0.5, ax - w * 0.06, h);
        g.lineTo(ax + w * 0.1, h);
        g.quadraticCurveTo(ax + w * 0.2, h * 0.45, ax + w * 0.2, 0);
        g.closePath();
        g.fill();
      }
      g.restore();
      // ── 带环行星（左上方）：本体 + 一圈斜环 ──
      const px = w * 0.24;
      const py = h * 0.3;
      const pr = Math.max(16, w * 0.085);
      const pglow = g.createRadialGradient(px, py, pr * 0.5, px, py, pr * 2.6);
      pglow.addColorStop(0, 'rgba(190,170,255,0.26)');
      pglow.addColorStop(1, 'rgba(150,130,230,0)');
      g.fillStyle = pglow;
      g.fillRect(px - pr * 2.6, py - pr * 2.6, pr * 5.2, pr * 5.2);
      const planet = g.createRadialGradient(px - pr * 0.35, py - pr * 0.4, pr * 0.2, px, py, pr);
      planet.addColorStop(0, '#e9dcff');
      planet.addColorStop(0.55, '#b9a2e8');
      planet.addColorStop(1, '#6b5494');
      g.fillStyle = planet;
      g.beginPath();
      g.arc(px, py, pr, 0, TAU);
      g.fill();
      // 环：一段被本体挡住的感觉靠两笔弧线做出来
      g.save();
      g.translate(px, py);
      g.rotate(-0.42);
      for (const [rr, aw, alpha] of [[pr * 1.55, pr * 0.2, 0.5], [pr * 1.85, pr * 0.12, 0.3]]) {
        g.strokeStyle = `rgba(232,222,255,${alpha})`;
        g.lineWidth = aw;
        g.beginPath();
        g.ellipse(0, 0, rr, rr * 0.3, 0, Math.PI * 0.02, Math.PI * 0.98);
        g.stroke();
        g.beginPath();
        g.ellipse(0, 0, rr, rr * 0.3, 0, Math.PI * 1.02, Math.PI * 1.98);
        g.stroke();
      }
      g.restore();
      // ── 远处一颗小月亮（异世界的第二颗）──
      const mx2 = w * 0.58;
      const my2 = h * 0.17;
      const mr2 = Math.max(7, w * 0.026);
      g.fillStyle = 'rgba(255,214,190,0.16)';
      g.beginPath();
      g.arc(mx2, my2, mr2 * 2.6, 0, TAU);
      g.fill();
      g.fillStyle = F.moon2 || '#ffd9c6';
      g.beginPath();
      g.arc(mx2, my2, mr2, 0, TAU);
      g.fill();
      g.fillStyle = 'rgba(150,110,120,0.3)';
      g.beginPath();
      g.arc(mx2 - mr2 * 0.3, my2 + mr2 * 0.2, mr2 * 0.28, 0, TAU);
      g.fill();
    }

    this.skyCanvas = c;
    this.skyH = h;
  }

  /** 烘焙远景城市剪影 */
  _bakeCity() {
    const w = this.w;
    const h = 150;
    const c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = h;
    const g = c.getContext('2d');
    const rnd = mulberry32(778899);
    const T = CFG.theme;

    // 疯狂草坪（第三关）：远景是郊区民房 + 树 + 白栅栏（PvZ 的"后院"味道）。
    // 白天的远景必须亮，否则整片天空压在一条黑边上会很假。
    // 穿越异世界（第四关）：远景 = 被哥布林袭过的村子 + 远处古堡 + 松林。
    // 颜色全走 T.fantasy 子表（`js/config.js` 的 `CFG.themes.fantasy.fantasy`），
    // 栅栏沿用顶层的 `railBar`/`railPost`，这样路面与远景是同一套木色。
    if (T.skyline === 'village') {
      const F = T.fantasy;
      const base = h - 6;
      // 夜色草地
      g.fillStyle = F.grassB;
      g.fillRect(0, base - 8, w, h - base + 8);
      // 远山：两层三角，远的一层更淡
      for (let layer = 0; layer < 2; layer++) {
        g.fillStyle = layer ? 'rgba(52,42,88,0.75)' : 'rgba(34,27,64,0.9)';
        g.beginPath();
        g.moveTo(-12, base - 10);
        for (let i = 0; i <= 6; i++) {
          const px = -12 + (w + 24) * (i / 6);
          const ph = (layer ? 26 : 42) + rnd() * 24;
          g.lineTo(px, base - 10 - ph);
        }
        g.lineTo(w + 12, base - 10);
        g.closePath();
        g.fill();
      }
      // 【用户 m07770】异世界的"浮空岛"与发光晶簇：山影之后、古堡之前，
      // 让远景一眼就不像人间 —— 一块倒锥的岩体浮在半空，顶上压一层草皮，
      // 底部长着会发光的晶体；古堡旁边再插三根晶柱。
      for (let i = 0; i < 3; i++) {
        const ix = w * (0.58 + i * 0.17) + rnd() * 8;
        const iw = 16 + rnd() * 10;
        const iy = base - 58 - rnd() * 22;
        // 岩体（倒锥）
        g.fillStyle = 'rgba(30,24,54,0.95)';
        g.beginPath();
        g.moveTo(ix - iw, iy);
        g.lineTo(ix + iw, iy);
        g.lineTo(ix + iw * 0.22, iy + iw * 1.15);
        g.lineTo(ix - iw * 0.3, iy + iw * 0.95);
        g.closePath();
        g.fill();
        // 顶上的草皮
        g.fillStyle = F.grassA;
        g.beginPath();
        g.ellipse(ix, iy, iw, iw * 0.28, 0, Math.PI, TAU);
        g.fill();
        // 底部的发光晶体
        for (let k = 0; k < 3; k++) {
          const gx = ix - iw * 0.45 + k * iw * 0.45;
          const gh = iw * (0.3 + rnd() * 0.35);
          g.fillStyle = 'rgba(120,220,255,0.5)';
          g.beginPath();
          g.moveTo(gx, iy + iw * 0.5);
          g.lineTo(gx - gh * 0.34, iy + iw * 0.5 + gh);
          g.lineTo(gx + gh * 0.34, iy + iw * 0.5 + gh);
          g.closePath();
          g.fill();
        }
      }
      // 城堡旁三根晶柱（越高越细，顶端有一团光）
      for (let i = 0; i < 3; i++) {
        const sx = w * (0.15 + i * 0.055);
        const sh = 34 + rnd() * 26;
        const sw2 = 5 + rnd() * 3;
        g.fillStyle = 'rgba(64,52,110,0.9)';
        g.beginPath();
        g.moveTo(sx, base - 28 - sh);
        g.lineTo(sx + sw2, base - 34);
        g.lineTo(sx - sw2, base - 34);
        g.closePath();
        g.fill();
        const tip = g.createRadialGradient(sx, base - 28 - sh, 0, sx, base - 28 - sh, sw2 * 2.4);
        tip.addColorStop(0, 'rgba(178,238,255,0.55)');
        tip.addColorStop(1, 'rgba(120,200,255,0)');
        g.fillStyle = tip;
        g.fillRect(sx - sw2 * 2.4, base - 28 - sh - sw2 * 2.4, sw2 * 4.8, sw2 * 4.8);
      }
      // 古堡：城墙 + 城垛 + 三座尖顶塔 + 暖窗 + 红旗
      const cx = w * 0.30;
      const wallW = 108;
      const wallH = 40;
      g.fillStyle = F.castleDark;
      g.fillRect(cx - wallW / 2, base - 26 - wallH, wallW, wallH + 26);
      g.fillStyle = F.castle;
      g.fillRect(cx - wallW / 2 + 3, base - 26 - wallH, wallW - 6, wallH);
      for (let i = 0; i < 6; i++) {
        g.fillStyle = F.castle;
        g.fillRect(cx - wallW / 2 + 3 + i * (wallW / 6), base - 31 - wallH, wallW / 12, 6);
      }
      const tower = (tx, tw, th) => {
        g.fillStyle = F.castleDark;
        g.fillRect(tx - tw / 2, base - 26 - th, tw, th + 26);
        g.fillStyle = F.castle;
        g.fillRect(tx - tw / 2 + 2, base - 26 - th, tw - 4, th);
        g.fillStyle = F.bannerDark;
        g.beginPath();
        g.moveTo(tx - tw / 2 - 4, base - 26 - th);
        g.lineTo(tx, base - 26 - th - tw * 0.9);
        g.lineTo(tx + tw / 2 + 4, base - 26 - th);
        g.closePath();
        g.fill();
        g.fillStyle = F.castleWin;
        g.globalAlpha = 0.8;
        g.fillRect(tx - 2.5, base - 26 - th * 0.62, 5, 8);
        g.fillRect(tx - 2.5, base - 26 - th * 0.3, 5, 8);
        g.globalAlpha = 1;
        g.fillStyle = F.banner;
        g.fillRect(tx - 1, base - 26 - th - tw * 0.9 - 13, 2, 13);
      };
      tower(cx - wallW / 2 + 4, 30, 62);
      tower(cx + wallW / 2 - 4, 30, 62);
      tower(cx, 38, 78);
      // 村子：古典奇幻的石木民房 —— 下半石砌、上半木构、陡坡石板顶、
      // 菱格窗透暖光、拱形木门、烟囱冒烟（参考：中世纪石桥 + 石木农舍画法）
      const cottage = (x, gy, hw) => {
        const hh = hw * (0.6 + rnd() * 0.24);
        const wallTop = gy - hh;
        const upper = gy - hh * 0.44;
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.fillRect(x + 2.5, wallTop + 2.5, hw, hh);
        // 石砌下半 + 灰缝
        g.fillStyle = '#6b6357';
        g.fillRect(x, upper, hw, gy - upper);
        g.fillStyle = 'rgba(18,14,10,0.34)';
        for (let s = upper + 3.5; s < gy; s += 3.6) g.fillRect(x, s, hw, 1);
        // 木构上半：灰泥 + 外露梁柱
        g.fillStyle = '#8a7156';
        g.fillRect(x, wallTop, hw, upper - wallTop);
        g.fillStyle = '#4a382a';
        g.fillRect(x, wallTop, hw, 1.8);
        g.fillRect(x, upper - 1.4, hw, 1.8);
        const nb = Math.max(2, Math.round(hw / 9));
        for (let b = 0; b <= nb; b++) g.fillRect(x + (hw * b) / nb - 0.6, wallTop, 1.3, upper - wallTop);
        // 陡坡石板顶（近黑紫）+ 檐下阴影 + 瓦垄
        const rh = hw * (0.5 + rnd() * 0.14);
        g.fillStyle = 'rgba(0,0,0,0.4)';
        g.beginPath();
        g.moveTo(x - 5, wallTop + 1.5);
        g.lineTo(x + hw / 2, wallTop - rh + 2);
        g.lineTo(x + hw + 5, wallTop + 1.5);
        g.closePath();
        g.fill();
        g.fillStyle = '#3a2f42';
        g.beginPath();
        g.moveTo(x - 5, wallTop);
        g.lineTo(x + hw / 2, wallTop - rh);
        g.lineTo(x + hw + 5, wallTop);
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.24)';
        g.lineWidth = 1;
        for (let k = 1; k < 5; k++) {
          const ex = x - 5 + ((hw + 10) * k) / 5;
          const vx = x + hw / 2;
          g.beginPath();
          g.moveTo(vx, wallTop - rh + 1.5);
          g.lineTo(ex, wallTop + 0.5);
          g.stroke();
        }
        g.strokeStyle = 'rgba(226,214,240,0.16)';
        g.beginPath();
        g.moveTo(x - 5, wallTop);
        g.lineTo(x + hw / 2, wallTop - rh);
        g.stroke();
        // 菱格窗（窗后先透一团暖光）
        const wy = wallTop + (upper - wallTop) * 0.52;
        const ws = Math.max(3, Math.min(5.5, hw * 0.1));
        const dia = (cx, cy) => {
          g.fillStyle = 'rgba(255,190,110,0.16)';
          g.beginPath();
          g.arc(cx, cy, ws * 2.4, 0, TAU);
          g.fill();
          g.save();
          g.translate(cx, cy);
          g.rotate(Math.PI / 4);
          g.fillStyle = '#ffcf7a';
          g.fillRect(-ws, -ws, ws * 2, ws * 2);
          g.strokeStyle = 'rgba(56,32,18,0.9)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(-ws, 0);
          g.lineTo(ws, 0);
          g.moveTo(0, -ws);
          g.lineTo(0, ws);
          g.stroke();
          g.restore();
        };
        dia(x + hw * 0.3, wy);
        if (hw > 30) dia(x + hw * 0.72, wy);
        // 拱形木门
        const dw = Math.min(9, hw * 0.26);
        const dh = Math.min(15, (gy - upper) * 0.82);
        g.fillStyle = '#37271b';
        g.beginPath();
        g.moveTo(x + hw * 0.5 - dw / 2, gy);
        g.lineTo(x + hw * 0.5 - dw / 2, gy - dh + dw / 2);
        g.arc(x + hw * 0.5, gy - dh + dw / 2, dw / 2, Math.PI, 0);
        g.lineTo(x + hw * 0.5 + dw / 2, gy);
        g.closePath();
        g.fill();
        g.fillStyle = 'rgba(255,190,110,0.35)';
        g.fillRect(x + hw * 0.5 - dw * 0.1, gy - dh * 0.55, dw * 0.2, dh * 0.5);
        // 烟囱 + 一缕烟
        const chx = x + hw * (0.68 + rnd() * 0.16);
        g.fillStyle = '#4a4048';
        g.fillRect(chx, wallTop - rh * 0.6, 4.5, rh * 0.62 + 4);
        g.fillStyle = 'rgba(150,140,170,0.2)';
        g.fillRect(chx, wallTop - rh * 0.6 - 3, 4.5, 3);
        g.fillStyle = 'rgba(210,200,225,0.09)';
        g.beginPath();
        g.ellipse(chx + 2, wallTop - rh * 0.72, 5 + rnd() * 3, 3 + rnd() * 2, 0, 0, TAU);
        g.fill();
      };
      let hx = 2;
      let hi = 0;
      while (hx < w - 10) {
        const hw = 26 + rnd() * 20;
        if (hi === 3) {
          // 偶尔来一座带尖顶的小礼拜堂，把天际线拔高、别一排平顶
          const tw = 16;
          g.fillStyle = 'rgba(0,0,0,0.3)';
          g.fillRect(hx + 2, base - 10 - 34, tw, 34);
          g.fillStyle = '#6b6357';
          g.fillRect(hx, base - 10 - 34, tw, 34);
          g.fillStyle = '#3a2f42';
          g.beginPath();
          g.moveTo(hx - 3, base - 10 - 34);
          g.lineTo(hx + tw / 2, base - 10 - 34 - 26);
          g.lineTo(hx + tw + 3, base - 10 - 34);
          g.closePath();
          g.fill();
          g.fillStyle = 'rgba(226,214,240,0.16)';
          g.beginPath();
          g.moveTo(hx - 3, base - 10 - 34);
          g.lineTo(hx + tw / 2, base - 10 - 34 - 26);
          g.stroke();
          g.fillStyle = '#ffcf7a';
          g.fillRect(hx + tw * 0.5 - 2.5, base - 10 - 30, 5, 7);
          hx += tw + 18 + rnd() * 20;
          hi++;
          continue;
        }
        cottage(hx, base - 10, hw);
        hx += hw + 14 + rnd() * 22;
        hi++;
      }
      // 水车磨坊：一轮子挂在侧面，古典村庄的标志物
      {
        const mx = w * 0.62;
        const gy = base - 10;
        cottage(mx, gy, 30);
        g.save();
        g.translate(mx + 40, gy - 12);
        g.strokeStyle = '#5a4a36';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(0, 0, 13, 0, TAU);
        g.stroke();
        g.lineWidth = 1.2;
        for (let k = 0; k < 8; k++) {
          const a2 = (k / 8) * TAU;
          g.beginPath();
          g.moveTo(0, 0);
          g.lineTo(Math.cos(a2) * 13, Math.sin(a2) * 13);
          g.stroke();
        }
        g.restore();
      }
      // 松林
      for (let i = 0; i < 9; i++) {
        const tx = rnd() * w;
        const th = 20 + rnd() * 26;
        g.fillStyle = '#4a3524';
        g.fillRect(tx - 2, base - 10 - th * 0.35, 4, th * 0.35);
        for (let k = 0; k < 3; k++) {
          const r = th * 0.5 * (1 - k * 0.22);
          g.beginPath();
          g.moveTo(tx, base - 10 - th * (0.34 + k * 0.24));
          g.lineTo(tx - r, base - 10 - th * (0.14 + k * 0.24));
          g.lineTo(tx + r, base - 10 - th * (0.14 + k * 0.24));
          g.closePath();
          g.fillStyle = k === 2 ? F.tree : F.treeDark;
          g.fill();
        }
      }
      // 最前排的石砌矮墙（原来那排木栅栏太"公路"，换成压顶的石墙 + 少量垛口）
      g.fillStyle = '#5f584c';
      g.fillRect(0, base - 13, w, 11);
      g.fillStyle = 'rgba(232,214,182,0.35)';
      g.fillRect(0, base - 13, w, 2);
      g.fillStyle = 'rgba(18,14,10,0.3)';
      for (let wy2 = base - 9; wy2 < base - 2; wy2 += 3.4) g.fillRect(0, wy2, w, 1);
      for (let fx = 3; fx < w; fx += 21) {
        g.fillStyle = '#6c6559';
        g.fillRect(fx, base - 17, 6, 4.5);
      }
      this.cityCanvas = c;
      this.cityH = h;
      return;
    }

    if (T.skyline === 'houses') {
      const L = T.lawn;
      const base = h - 6;
      // 一条绿色的地平线草带
      g.fillStyle = '#4f9c3c';
      g.fillRect(0, base - 6, w, h - base + 6);
      let x = -24;
      while (x < w + 24) {
        const hw = 34 + rnd() * 30;
        const hh = 40 + rnd() * 34;
        g.fillStyle = 'rgba(0,0,0,0.10)';
        g.fillRect(x, base - hh, hw, hh);
        g.fillStyle = L.house;
        g.fillRect(x, base - hh, hw * 0.92, hh);
        // 红屋顶
        g.fillStyle = L.roof;
        g.beginPath();
        g.moveTo(x - 5, base - hh);
        g.lineTo(x + hw / 2, base - hh - hw * 0.42);
        g.lineTo(x + hw + 5, base - hh);
        g.closePath();
        g.fill();
        // 门窗
        g.fillStyle = 'rgba(96,64,40,0.8)';
        g.fillRect(x + hw * 0.38, base - hh * 0.5, hw * 0.26, hh * 0.5);
        g.fillStyle = 'rgba(146,214,240,0.9)';
        g.fillRect(x + hw * 0.08, base - hh * 0.78, hw * 0.22, hh * 0.24);
        g.fillRect(x + hw * 0.66, base - hh * 0.78, hw * 0.22, hh * 0.24);
        x += hw + 14 + rnd() * 30;
      }
      // 树：圆冠 + 树干
      for (let i = 0; i < 7; i++) {
        const tx = rnd() * w;
        const r = 13 + rnd() * 17;
        g.fillStyle = '#6b4a2a';
        g.fillRect(tx - 2.5, base - r * 0.9, 5, r * 0.9);
        g.beginPath();
        g.arc(tx, base - r * 0.9, r * 0.8, 0, TAU);
        g.fillStyle = L.treeDark;
        g.fill();
        g.beginPath();
        g.arc(tx - r * 0.24, base - r * 1.12, r * 0.66, 0, TAU);
        g.fillStyle = L.tree;
        g.fill();
      }
      // 最前排白栅栏
      g.fillStyle = L.fence;
      g.fillRect(0, base - 12, w, 3);
      g.fillRect(0, base - 4, w, 3);
      for (let fx = 4; fx < w; fx += 13) {
        g.fillStyle = L.fenceDark;
        g.fillRect(fx, base - 15, 4, 17);
      }
      this.cityCanvas = c;
      this.cityH = h;
      return;
    }

    // 疯狂水世界：远景是乐园的蓝白格子展墙 + 水草 + 游鱼 + 大气泡。
    // 观感直接抄参考图（摊位立牌）里那块背景：蓝白棋盘格 + 海洋元素。
    if (T.skyline === 'reef') {
      const cell = Math.max(14, Math.round(w / 12));
      for (let j = 0; j * cell < h; j++) {
        for (let i = 0; i * cell < w; i++) {
          const on = (i + j) % 2 === 0;
          g.fillStyle = on ? T.reef.wallA : T.reef.wallB;
          g.globalAlpha = on ? 0.5 : 0.38;
          g.fillRect(i * cell, j * cell, cell + 1, cell + 1);
        }
      }
      g.globalAlpha = 1;
      // 水草：从底部往上长的波浪带
      g.lineCap = 'round';
      for (let i = 0; i < 10; i++) {
        const x = rnd() * w;
        const hh = 40 + rnd() * 90;
        g.strokeStyle = rnd() > 0.5 ? T.reef.weed : T.reef.weedDark;
        g.lineWidth = 3 + rnd() * 4;
        g.beginPath();
        g.moveTo(x, h);
        for (let k = 1; k <= 4; k++) {
          g.lineTo(x + Math.sin(k * 1.3 + i) * 9, h - (hh * k) / 4);
        }
        g.stroke();
      }
      // 游鱼：简笔小鱼剪影（有朝向，像在游）
      for (let i = 0; i < 7; i++) {
        const x = 20 + rnd() * (w - 40);
        const y = 16 + rnd() * (h - 50);
        const s = 7 + rnd() * 11;
        const dir = rnd() > 0.5 ? 1 : -1;
        g.fillStyle = T.reef.fish[i % T.reef.fish.length];
        g.globalAlpha = 0.8;
        g.beginPath();
        g.ellipse(x, y, s, s * 0.55, 0, 0, TAU);
        g.fill();
        g.beginPath();
        g.moveTo(x - dir * s, y);
        g.lineTo(x - dir * s * 1.9, y - s * 0.5);
        g.lineTo(x - dir * s * 1.9, y + s * 0.5);
        g.closePath();
        g.fill();
        g.globalAlpha = 1;
      }
      // 大气泡
      for (let i = 0; i < 14; i++) {
        const x = rnd() * w;
        const y = rnd() * h;
        const r = 4 + rnd() * 12;
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = 1.6;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.stroke();
      }
      // 底部压一层水雾，和地平线接得住
      const wet = g.createLinearGradient(0, h - 90, 0, h);
      wet.addColorStop(0, 'rgba(180,235,250,0)');
      wet.addColorStop(1, 'rgba(150,215,240,0.85)');
      g.fillStyle = wet;
      g.fillRect(0, 0, w, h);

      this.cityCanvas = c;
      this.cityH = h;
      return;
    }

    let x = -20;
    const bars = [];
    while (x < w + 20) {
      const bw = 14 + rnd() * 46;
      const bh = 18 + rnd() * 92;
      bars.push({ x, w: bw, h: bh });
      x += bw + 2 + rnd() * 7;
    }

    for (const b of bars) {
      const y = h - b.h;
      const shade = 8 + Math.floor(rnd() * 10);
      g.fillStyle = `rgb(${shade},${shade + 2},${shade + 7})`;
      g.fillRect(b.x, y, b.w, b.h);
      // 零星亮着的窗
      const cols = Math.max(1, Math.floor(b.w / 6));
      const rows = Math.max(1, Math.floor(b.h / 8));
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          if (rnd() > 0.88) {
            g.fillStyle = rnd() > 0.5 ? 'rgba(255,196,110,0.55)' : 'rgba(150,200,255,0.4)';
            g.fillRect(b.x + 2 + i * 6, y + 3 + j * 8, 2, 3);
          }
        }
      }
    }
    // 顶部一点点天际线雾
    const haze = g.createLinearGradient(0, h - 110, 0, h);
    haze.addColorStop(0, 'rgba(30,34,46,0)');
    haze.addColorStop(1, 'rgba(24,26,36,0.85)');
    g.fillStyle = haze;
    g.fillRect(0, 0, w, h);

    this.cityCanvas = c;
    this.cityH = h;
  }

  // ---------------------------------------------------------
  //  主绘制
  // ---------------------------------------------------------

  draw(game, dt) {
    // dt 兜底：walkthrough 脚本/探针如果 `R.draw(g)` 忘了传 dt，`this.time += undefined`
    // 会把时间戳变成 NaN —— 之后所有按时间算的东西（波浪、呼吸、火花）全废，
    // 而且 NaN 自己恢复不了（NaN + 有限数 = NaN）。缺参数时按 60fps 走。
    this.time += Number.isFinite(dt) ? dt : 1 / 60;
    const ctx = this.ctx;
    const cam = this.cam;
    const w = this.w;
    const h = this.h;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // ---- 屏幕震动 ----
    const sh = game.shake;
    let ox = 0;
    let oy = 0;
    if (sh > 0) {
      ox = (Math.random() - 0.5) * sh;
      oy = (Math.random() - 0.5) * sh;
    }
    ctx.translate(ox, oy);

    // 换关卡（第一关 ↔ 疯狂水世界）时重烘焙天空/远景。
    // 它们只在 resize 时算过，不跟着主题重做的话第二关会顶着第一关的夜空开局。
    if (this._bakedTheme !== CFG.level.theme) {
      this._bakeSky();
      this._bakeCity();
      this._bakedTheme = CFG.level.theme;
    }
    // 【用户 m08839】静态背景 + 桥面各烘焙一张，每帧只贴两次图（见 `_syncBaked`）
    this._syncBaked(w, h);
    if (this._bgCv) {
      ctx.drawImage(this._bgCv, 0, 0, this._bgCv.width, this._bgCv.height, 0, 0, w, h);
    } else {
      this._drawBackdrop(ctx, w, h);
    }
    this._drawPlane(ctx, game);
    this._drawWater(ctx, w, h);
    // 【用户 m08143】"桥两侧近景继续改动"：第四关的岸上摆会发光的晶簇、蘑菇、
    // 刻符石与芦苇，再加两层贴地的雾 —— 让桥两边不再只是一片渐变水色。
    if (CFG.level.skin === 'fantasy') this._drawFantasyBanks(ctx, w, h);
    if (this._deckCv) {
      ctx.drawImage(this._deckCv, 0, 0, this._deckCv.width, this._deckCv.height, 0, 0, w, h);
    } else {
      this._drawDeck(ctx);
    }
    this._drawGround(ctx, game);
    this._drawSuns(ctx, game);
    this._drawHaze(ctx, w);
    if (game.state === STATE.START) this._drawAttract(ctx, game);
    this._drawEntities(ctx, game);
    this._drawCherries(ctx, game);
    this._drawUnicorns(ctx, game);
    this._drawMissiles(ctx, game);
    this._drawFog(ctx, w);
    this._drawRings(ctx, game);
    this._drawWarns(ctx, game);
    this._drawDragonWalls(ctx, game);
    // 【用户 m09695】桥边时不时飞过几只蝴蝶（画在英雄之前：人物永远是焦点）
    this._drawButterflies(ctx, game);
    this._fairyFlowerRing(ctx, game);
    this._drawHero(ctx, game);
    this._drawShout(ctx, game);
    this._drawAmbient(ctx, game);
    this._drawScreenFx(ctx, game, w, h);
    this._drawAlert(ctx, game, w, h);
    ctx.translate(-ox, -oy);
    this._drawPopups(ctx, game);
    // 开始界面背后只留场景（桥 + 吸引模式里的尸群），不画局内 HUD：
    // 菜单面板是半透明的，底下的分数 / 心形 / 空袭按钮透出来会像"两套 UI 叠在一起"。
    if (game.state !== STATE.START) this._drawHudCanvas(ctx, game, w, h);
  }

  /**
   * 开始界面的"吸引模式"：桥上一小队丧尸慢慢朝镜头走，走到底就从头再来。
   * 假数据、不进 game.enemies、不参与任何玩法 —— 只为让第一屏是活的。
   * 颜色跟着当前关卡的皮肤走，所以选第二/三关时背景里的也是鱼人 / PvZ 僵尸。
   */
  _drawAttract(ctx, game) {
    if (!this._attract) {
      const r = mulberry32(0x1a2b3c4d);
      const list = [];
      for (let i = 0; i < 16; i++) {
        list.push({
          x: (r() * 2 - 1) * 0.62,
          z0: 56 + r() * 48,
          spd: 0.32 + r() * 0.6,
          ph: r() * 6.28,
          giant: r() < 0.16,
          fast: r() < 0.3,
        });
      }
      this._attract = list;
    }
    const ocean = CFG.level.skin === 'ocean';
    const pvz = CFG.level.skin === 'pvz';
    // 第四关（穿越异世界）：菜单背景里晃的是哥布林 / 郊狼 / 兽人
    const fantasy = CFG.level.skin === 'fantasy';
    const span = 62;
    for (const a of this._attract) {
      // 慢慢走近；越过镜头就从远端重新进场。
      // 距离刻意压在 z 56~118 这一段：开始界面的大面板会盖住屏幕中下部，
      // 只有地平线附近那条窄带是露出来的，丧尸必须待在那儿才看得见。
      const z = (((a.z0 + 6 - this.time * a.spd) % span) + span) % span + 56;
      const kind = a.giant ? 'brute' : a.fast ? 'runner' : 'walker';
      const K = CFG.kinds[kind];
      const skin = ocean ? K.ocean : pvz ? K.pvz : fantasy ? K.fantasy : null;
      const col = (skin && skin.color) || K.color;
      const dark = (skin && skin.dark) || K.dark;
      const p = this.cam.project(a.x, z);
      const H = K.size * p.s;
      if (H < 9) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 1, H * 0.19, H * 0.055, 0, 0, TAU);
      ctx.fill();
      ctx.save();
      ctx.translate(p.x, p.y);
      this._zombieBody(ctx, H, col, dark, this.time * 2.1 + a.ph, kind, false, a.ph * 1000);
      ctx.restore();
    }
  }

  _drawBackdrop(ctx, w, h) {
    const T = CFG.theme;
    const horizon = this.cam.horizonY;
    ctx.drawImage(this.skyCanvas, 0, 0, w, this.skyH);
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, w, 0);
    // 城市剪影 / 水世界展墙，底部贴地平线
    ctx.drawImage(this.cityCanvas, 0, horizon - this.cityH + 3, w, this.cityH);
    // 地平线底光（第一关是霓虹，水世界是水汽）
    const g = ctx.createLinearGradient(0, horizon - 26, 0, horizon + 12);
    g.addColorStop(0, T.horizon[0]);
    g.addColorStop(0.65, T.horizon[1]);
    g.addColorStop(1, T.horizon[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon - 26, w, 38);
  }

  /**
   * 海面底色（三段渐变）。固定镜头下不随时间变，所以在 `_syncBaked()` 里烘焙进
   * 背景图；`_drawWater()` 只留会动的碎光。拆两半是为了烘焙与动画能各取所需。
   */
  _drawWaterBase(ctx, w, h) {
    const T = CFG.theme;
    const horizon = this.cam.horizonY;
    const g = ctx.createLinearGradient(0, horizon, 0, h);
    g.addColorStop(0, T.sea[0]);
    g.addColorStop(0.35, T.sea[1]);
    g.addColorStop(1, T.sea[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, w, h - horizon);
  }

  _drawWater(ctx, w, h) {
    const T = CFG.theme;
    const horizon = this.cam.horizonY;
    // 底色已经烘焙在背景图里（`_syncBaked`）；这里只在没有烘焙图时兜底重画一次
    if (!this._bgCv) this._drawWaterBase(ctx, w, h);

    // 水面碎光（第一关是橙色反光，水世界是白色浪花）
    const t = this.time;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i++) {
      const yy = horizon + 6 + i * ((h - horizon) / 16);
      const sway = Math.sin(t * 0.7 + i * 1.7) * 0.5 + 0.5;
      const a = (0.05 + 0.05 * sway) * (1 - i / 17);
      const cw = w * (0.22 + 0.34 * sway);
      const cx = w * 0.5 + Math.sin(t * 0.35 + i * 0.9) * w * 0.16;
      const g2 = ctx.createLinearGradient(cx - cw / 2, 0, cx + cw / 2, 0);
      g2.addColorStop(0, T.foam[0]);
      g2.addColorStop(0.5, `${T.foam[1]}${a})`);
      g2.addColorStop(1, T.foam[2]);
      ctx.fillStyle = g2;
      ctx.fillRect(cx - cw / 2, yy, cw, 1.5);
    }
    ctx.restore();
  }

  /**
   * 【用户 m08143】「桥两侧近景继续改动」：第四关两岸摆上发光晶簇、发光蘑菇、
   * 刻符石与芦苇，再叠两层贴地雾，让桥两边不再只是一片渐变水色。
   * 位置用固定种子生成一次（存 this._bankProps），之后每帧只做投影绘制 ——
   * 场景稳定、不会每帧抖动，也不会每帧 new 对象。
   */
  _drawFantasyBanks(ctx, w, h) {
    const cam = this.cam;
    const horizon = cam.horizonY;
    if (!this._bankProps) {
      let seed = 20241;
      const rnd2 = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const list = [];
      const zNear = CFG.deckNearZ + 1.5;
      const zFar = CFG.deckFarZ * 0.72;
      for (let i = 0; i < 34; i++) {
        const side = i % 2 ? 1 : -1;
        const kindR = rnd2();
        list.push({
          x: side * (cam.roadHalf * (1.3 + rnd2() * 2.8)),
          z: zNear + rnd2() * (zFar - zNear),
          kind: kindR < 0.4 ? 'crystal' : kindR < 0.66 ? 'mushroom' : kindR < 0.85 ? 'stone' : 'reed',
          s: 0.55 + rnd2() * 0.75,
          phase: rnd2() * TAU,
          warm: rnd2() < 0.5,
        });
      }
      list.sort((a, b) => b.z - a.z); // 远的先画
      this._bankProps = list;
    }
    const t = this.time;
    for (const p of this._bankProps) {
      const pr = cam.project(p.x, p.z);
      if (pr.y < horizon + 1 || pr.y > h + 60) continue;
      const S = pr.s * p.s;
      const px = pr.x;
      const py = pr.y;
      if (p.kind === 'crystal') {
        // 晶簇：3 根长短不一的尖晶，加色发光
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        this._drawGlow(px, py - S * 0.06, S * 0.22, p.warm ? '#ff9ad8' : '#8fe0ff', 0.34);
        for (let i = 0; i < 3; i++) {
          const hh = S * (0.1 + i * 0.03) * (1 + 0.08 * Math.sin(t * 2 + p.phase + i));
          const dx = (i - 1) * S * 0.042;
          const ww2 = S * 0.026;
          const gC = ctx.createLinearGradient(px + dx, py - hh, px + dx, py);
          gC.addColorStop(0, p.warm ? 'rgba(255,214,240,0.95)' : 'rgba(214,244,255,0.95)');
          gC.addColorStop(1, p.warm ? 'rgba(214,90,168,0.5)' : 'rgba(80,150,220,0.45)');
          ctx.fillStyle = gC;
          ctx.beginPath();
          ctx.moveTo(px + dx, py - hh);
          ctx.lineTo(px + dx + ww2, py - hh * 0.28);
          ctx.lineTo(px + dx, py);
          ctx.lineTo(px + dx - ww2, py - hh * 0.28);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      } else if (p.kind === 'mushroom') {
        // 发光蘑菇：暖色伞盖 + 一点伞下光
        const capR = S * 0.05;
        const capY = py - S * 0.075;
        ctx.fillStyle = 'rgba(24,18,30,0.85)';
        ctx.fillRect(px - capR * 0.22, capY, capR * 0.44, S * 0.075);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        this._drawGlow(px, capY, capR * 2.6, '#ffb3d9', 0.26);
        ctx.restore();
        ctx.fillStyle = p.warm ? '#ff9ecb' : '#c9a6ff';
        ctx.beginPath();
        ctx.ellipse(px, capY, capR, capR * 0.72, 0, Math.PI, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,246,255,0.85)';
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(px + (i - 1) * capR * 0.45, capY - capR * 0.16, Math.max(0.6, capR * 0.12), 0, TAU);
          ctx.fill();
        }
      } else if (p.kind === 'stone') {
        // 刻符石：暗石头 + 青色符纹
        const R = S * 0.07;
        ctx.fillStyle = 'rgba(34,28,52,0.92)';
        ctx.beginPath();
        ctx.ellipse(px, py - R * 0.35, R * 0.9, R * 0.72, 0, 0, TAU);
        ctx.fill();
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.35 * Math.sin(t * 1.6 + p.phase);
        ctx.strokeStyle = '#8fe0ff';
        ctx.lineWidth = Math.max(0.8, R * 0.13);
        ctx.beginPath();
        ctx.moveTo(px - R * 0.3, py - R * 0.62);
        ctx.lineTo(px, py - R * 0.3);
        ctx.lineTo(px - R * 0.18, py - R * 0.12);
        ctx.stroke();
        ctx.restore();
      } else {
        // 芦苇/枯草：几根细线，随风轻摆
        ctx.strokeStyle = 'rgba(58,86,60,0.9)';
        ctx.lineWidth = Math.max(0.7, S * 0.006);
        for (let i = 0; i < 5; i++) {
          const bx = px + (i - 2) * S * 0.016;
          const bend = Math.sin(t * 1.4 + p.phase + i * 0.6) * S * 0.012;
          ctx.beginPath();
          ctx.moveTo(bx, py);
          ctx.quadraticCurveTo(bx + bend * 0.5, py - S * 0.05, bx + bend, py - S * (0.085 + i * 0.006));
          ctx.stroke();
        }
      }
    }
    // 贴地雾：两层从地平线下压的淡紫/淡青薄雾
    ctx.save();
    const fogH = Math.min(h - horizon, 260);
    for (let i = 0; i < 2; i++) {
      const fy = horizon + i * fogH * 0.34;
      const fg = ctx.createLinearGradient(0, fy, 0, fy + fogH * 0.7);
      const tint = i ? '150,255,210' : '176,150,255';
      fg.addColorStop(0, `rgba(${tint},${0.1 - i * 0.03})`);
      fg.addColorStop(1, `rgba(${tint},0)`);
      ctx.fillStyle = fg;
      ctx.fillRect(0, fy, w, fogH * 0.7);
    }
    ctx.restore();
  }

  _drawDeck(ctx) {
    const T = CFG.theme;
    const cam = this.cam;
    // 近端画到 deckNearZ（比英雄能退到的最深处还近），否则英雄脚底下会露黑边
    const zN = CFG.deckNearZ;
    const zF = CFG.deckFarZ;
    const RH = cam.roadHalf;

    const nl = cam.project(-RH, zN);
    const nr = cam.project(RH, zN);
    const fl = cam.project(-RH, zF);
    const fr = cam.project(RH, zF);

    // 桥面
    ctx.beginPath();
    ctx.moveTo(nl.x, nl.y + 4);
    ctx.lineTo(nr.x, nr.y + 4);
    ctx.lineTo(fr.x, fr.y);
    ctx.lineTo(fl.x, fl.y);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, fl.y, 0, nl.y);
    g.addColorStop(0, T.deck[0]);
    g.addColorStop(0.25, T.deck[1]);
    g.addColorStop(0.6, T.deck[2]);
    g.addColorStop(1, T.deck[3]);
    ctx.fillStyle = g;
    ctx.fill();

    // 疯狂草坪（第三关）：桥面是草皮 —— 铺一层深浅交替的横条纹，
    // 一眼就是"草坪"而不是柏油/木板（PvZ 的草坪就是条纹的）
    if (T.lawn) {
      const L = T.lawn;
      let k = 0;
      for (let z = zN; z < 110; z += 1.6, k++) {
        if (k % 2) continue;
        const a2 = cam.project(-RH, z);
        const b2 = cam.project(RH, z);
        const c2 = cam.project(RH, z + 1.6);
        const d2 = cam.project(-RH, z + 1.6);
        if (a2.y - d2.y < 0.1) continue;
        ctx.beginPath();
        ctx.moveTo(a2.x, a2.y + 4);
        ctx.lineTo(b2.x, b2.y + 4);
        ctx.lineTo(c2.x, c2.y);
        ctx.lineTo(d2.x, d2.y);
        ctx.closePath();
        ctx.fillStyle = k % 4 === 0 ? L.stripeA : L.stripeB;
        ctx.globalAlpha = 0.5;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // ---- 【用户 m08343】第四关：古典奇幻的石砌桥面 ----
    // 一排排错缝石板：每排 4 块、奇数排错半块，石板之间留缝让底色当"灰浆"透出来，
    // 少量石板压一层青苔。远近视差天然产生纵深感，比原来那条公路虚线"异世界"得多。
    const fDeck = CFG.level.skin === 'fantasy';
    if (fDeck) {
      const F = (CFG.theme && CFG.theme.fantasy) || {};
      const pal = F.stoneDeck || ['#4b463d', '#565048', '#605a50', '#6a6357'];
      const moss = F.stoneMoss || 'rgba(58,88,46,0.42)';
      const NCOL = 4;
      const cell = (2 * RH) / NCOL;
      let row = 0;
      for (let z = zN; z < Math.min(zF + 8, 96); z += 1.15, row++) {
        const z1 = z + 1.15;
        const off = row % 2 ? cell * 0.5 : 0;
        for (let i = -1; i <= NCOL; i++) {
          const xaRaw = -RH + i * cell + off;
          const xbRaw = xaRaw + cell;
          const ca = Math.max(xaRaw, -RH);
          const cb = Math.min(xbRaw, RH);
          if (cb - ca < 0.004) continue;
          // 石板内缩一点，缝就是底色（灰浆）
          const gi = 0.0016;
          const x0 = Math.max(-RH, ca + gi);
          const x1 = Math.min(RH, cb - gi);
          if (x1 - x0 < 0.002) continue;
          const za = z + 0.006;
          const zb = z1 - 0.006;
          const p1 = cam.project(x0, za);
          const p2 = cam.project(x1, za);
          const p3 = cam.project(x1, zb);
          const p4 = cam.project(x0, zb);
          if (p1.y - p4.y < 0.14) continue;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y + 3);
          ctx.lineTo(p2.x, p2.y + 3);
          ctx.lineTo(p3.x, p3.y);
          ctx.lineTo(p4.x, p4.y);
          ctx.closePath();
          const h = ((row * 7 + i * 13 + 5) * 2654435761) >>> 0;
          ctx.fillStyle = pal[h % pal.length];
          ctx.fill();
          // 靠镜头那条边打一条极淡的亮边：石头有厚度、不像贴纸
          if (x1 - x0 > 0.05) {
            ctx.strokeStyle = 'rgba(255,238,208,0.07)';
            ctx.lineWidth = Math.max(0.5, p1.y - p4.y > 40 ? 1.2 : 0.7);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y + 3);
            ctx.lineTo(p2.x, p2.y + 3);
            ctx.stroke();
          }
          // 青苔：贴外侧（靠护栏那半）长的更常见
          if (h % 7 === 0) {
            const outer = Math.abs((x0 + x1) / 2) > RH * 0.45;
            ctx.globalAlpha = outer ? 0.9 : 0.35;
            ctx.fillStyle = moss;
            ctx.beginPath();
            ctx.moveTo(p4.x, p4.y);
            ctx.lineTo(p3.x, p3.y);
            ctx.lineTo((p3.x + p4.x) / 2 + (p2.x - p1.x) * 0.1, (p3.y + p4.y) / 2);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1;
          }
        }
      }
      // 中间那条被车马磨亮的走道（不打虚线了，用磨损带代替公路标线）
      const wa = cam.project(-RH * 0.09, zN);
      const wb = cam.project(RH * 0.09, zN);
      const wc = cam.project(RH * 0.09, Math.min(zF, 92));
      const wd = cam.project(-RH * 0.09, Math.min(zF, 92));
      ctx.beginPath();
      ctx.moveTo(wa.x, wa.y + 4);
      ctx.lineTo(wb.x, wb.y + 4);
      ctx.lineTo(wc.x, wc.y);
      ctx.lineTo(wd.x, wd.y);
      ctx.closePath();
      const wg = ctx.createLinearGradient(0, wc.y, 0, wa.y);
      wg.addColorStop(0, 'rgba(255,238,206,0.03)');
      wg.addColorStop(0.55, 'rgba(255,238,206,0.09)');
      wg.addColorStop(1, 'rgba(255,232,196,0.05)');
      ctx.fillStyle = wg;
      ctx.fill();
    }

    // 伸缩缝（给纵深提供参照物）；石桥用排缝代替，这里跳过
    if (!fDeck) {
      ctx.fillStyle = T.seam;
      for (let z = zN + 1.2; z < 96; z += 2.2) {
        const a = cam.project(-RH, z);
        const b = cam.project(RH, z);
        const c = cam.project(RH, z + 0.09);
        const d = cam.project(-RH, z + 0.09);
        if (a.y - d.y < 0.12) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 中央虚线（石桥不画公路标线）
    if (!fDeck) {
      ctx.fillStyle = T.dash;
      for (let z = zN + 1.4; z < 92; z += 3.1) {
        const z2 = z + 1.55;
        const a = cam.project(-0.013, z);
        const b = cam.project(0.013, z);
        const c = cam.project(0.013, z2);
        const d = cam.project(-0.013, z2);
        if (a.y - d.y < 0.1) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 两侧边线
    for (const s of [-1, 1]) {
      const x1 = s * (RH - 0.016);
      const x2 = s * (RH - 0.001);
      const a = cam.project(x1, zN);
      const b = cam.project(x2, zN);
      const c = cam.project(x2, zF);
      const d = cam.project(x1, zF);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y + 4);
      ctx.lineTo(b.x, b.y + 4);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      const eg = ctx.createLinearGradient(0, c.y, 0, a.y);
      eg.addColorStop(0, T.edge[0]);
      eg.addColorStop(0.5, T.edge[1]);
      eg.addColorStop(1, T.edge[2]);
      ctx.fillStyle = eg;
      ctx.fill();
    }

    // ---- 桥面细节（视觉升级）：裂缝 / 补丁 / 血渍 ----
    // 位置一次性按定种生成、缓存在 _deckMarksCache 里，每帧只做投影 + 变换，
    // 既不花随机数也不会"抖"；远到看不清（半径不到 1.2px）直接跳过。
    const marks = this._deckMarksCache || (this._deckMarksCache = this._makeDeckMarks());
    for (const m of marks) {
      if (m.z < zN - 1 || m.z > zF + 8) continue;
      const p = cam.project(m.x, m.z);
      const rad = m.r * p.s;
      if (rad < 1.2) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(1, 0.42); // 透视：桥面上的斑块在画面里是压扁的
      ctx.rotate(m.rot);
      if (m.kind === 'crack') {
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = Math.max(0.6, rad * 0.16);
        ctx.beginPath();
        ctx.moveTo(-rad, 0);
        ctx.lineTo(-rad * 0.3, rad * 0.3);
        ctx.lineTo(rad * 0.2, -rad * 0.22);
        ctx.lineTo(rad, rad * 0.14);
        ctx.stroke();
      } else if (m.kind === 'patch') {
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        roundRect(ctx, -rad, -rad * 0.7, rad * 2, rad * 1.4, rad * 0.3);
        ctx.fill();
      } else {
        ctx.globalAlpha = m.a;
        ctx.fillStyle = m.dark ? T.stain[0] : T.stain[1];
        ctx.beginPath();
        ctx.ellipse(0, 0, rad, rad * 0.72, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        // 拖尾（血被踩出来的方向）
        ctx.beginPath();
        ctx.ellipse(rad * 0.9, rad * 0.1, rad * 0.7, rad * 0.26, 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    // 护栏：立柱 + 顶部横栏（强透视线，是"桥"的关键视觉）
    if (fDeck) {
      this._drawFantasyParapet(ctx, zN);
      return;
    }
    const railH = 0.085;
    const lampCol = CFG.level.theme === 'water' ? '#7df9ff' : CFG.level.theme === 'lawn' ? '#ffe066' : '#ff9a4a';
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      const xs = s * RH;
      // 横栏（按段采样，因为它是一条双曲线而不是直线）
      ctx.beginPath();
      let started = false;
      for (let z = zN; z < 120; z *= 1.16) {
        const p = cam.project(xs, z);
        const y = p.y - railH * p.s;
        if (!started) {
          ctx.moveTo(p.x, y);
          started = true;
        } else {
          ctx.lineTo(p.x, y);
        }
      }
      ctx.strokeStyle = T.railBar;
      ctx.lineWidth = Math.max(0.8, cam.scaleNear * 0.012);
      ctx.stroke();

      // 立柱（世界等距，远处自然压缩）
      let pk = 0;
      for (let z = zN; z < 78; z += 2.2, pk++) {
        const p = cam.project(xs, z);
        const top = p.y - railH * p.s;
        const wdt = Math.max(0.7, 0.014 * p.s);
        if (p.y - top < 0.7) continue;
        ctx.fillStyle = T.railPost;
        ctx.fillRect(p.x - wdt / 2, top, wdt, p.y - top);
        // 立柱顶上的反光（第一关是锈迹，水世界是救生圈黄圈）
        ctx.fillStyle = T.railTop;
        ctx.fillRect(p.x - wdt / 2, top, wdt, Math.max(0.6, (p.y - top) * 0.22));
        // 每三根柱子上挂一盏灯（视觉升级）：给护栏一排节奏光点，桥的纵深一下就出来了
        if (pk % 3 === 0 && p.s > 6) {
          const wr = Math.max(1.6, p.s * 0.045);
          this._drawGlow(p.x, top - wr * 0.2, wr * 1.8, lampCol, 0.5);
          ctx.fillStyle = '#fff4d8';
          ctx.beginPath();
          ctx.arc(p.x, top - wr * 0.2, wr * 0.36, 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  /**
   * 【用户 m08343】第四关的"女儿墙"：中世纪石桥那种低矮石护栏 + 垛口 + 铁艺灯笼。
   * 采样方式与原来的木栅栏一致（按透视缩放），只是从"一根横栏 + 立柱"变成有厚度的墙体。
   */
  _drawFantasyParapet(ctx, zN) {
    const cam = this.cam;
    const T = CFG.theme;
    const F = (T && T.fantasy) || {};
    const RH = cam.roadHalf;
    const hgt = 0.115; // 女儿墙高度（世界单位）
    const cap = F.parapetTop || 'rgba(232,214,182,0.55)';
    const iron = F.lanternIron || '#2b2622';
    const pA = (F.parapet && F.parapet[0]) || '#6c6559';
    const pB = (F.parapet && F.parapet[1]) || '#574f44';
    const lampCol = '#ffb970';
    for (const s of [-1, 1]) {
      const xs = s * RH;
      const zs = [];
      for (let z = zN; z < 130; z *= 1.13) zs.push(z);
      const bottom = [];
      const top = [];
      for (const z of zs) {
        const p = cam.project(xs, z);
        if (!(p.s > 0.01)) continue;
        bottom.push([p.x, p.y + 3]);
        top.push([p.x, p.y + 3 - hgt * p.s]);
      }
      if (bottom.length < 2) continue;
      // 墙体
      ctx.beginPath();
      ctx.moveTo(bottom[0][0], bottom[0][1]);
      for (let i = 1; i < bottom.length; i++) ctx.lineTo(bottom[i][0], bottom[i][1]);
      for (let i = top.length - 1; i >= 0; i--) ctx.lineTo(top[i][0], top[i][1]);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, top[top.length - 1][1], 0, bottom[0][1]);
      g.addColorStop(0, pA);
      g.addColorStop(1, pB);
      ctx.fillStyle = g;
      ctx.fill();
      // 顶盖：一条亮线，让墙有"石头压顶"的厚度
      ctx.beginPath();
      ctx.moveTo(top[0][0], top[0][1]);
      for (let i = 1; i < top.length; i++) ctx.lineTo(top[i][0], top[i][1]);
      ctx.strokeStyle = cap;
      ctx.lineWidth = Math.max(0.8, cam.scaleNear * 0.006);
      ctx.lineJoin = 'round';
      ctx.stroke();
      // 垛口 + 灯笼
      let k = 0;
      for (let z = zN + (s > 0 ? 0.9 : 0); z < 80; z += 2.0, k++) {
        const p = cam.project(xs, z);
        const wall = hgt * p.s;
        const h = wall * 0.42;
        const w = Math.max(1.2, 0.02 * p.s);
        if (h < 0.8) continue;
        const topY = p.y + 3 - wall;
        ctx.fillStyle = pA;
        ctx.fillRect(p.x - w / 2, topY - h, w, h);
        ctx.fillStyle = cap;
        ctx.fillRect(p.x - w / 2, topY - h, w, Math.max(0.5, h * 0.24));
        if (k % 3 === 1 && p.s > 7) {
          const lr = Math.max(1.8, p.s * 0.045);
          ctx.fillStyle = iron;
          ctx.fillRect(p.x - lr * 0.11, topY - h - lr * 0.95, Math.max(0.7, lr * 0.22), lr * 0.95);
          this._drawGlow(p.x, topY - h - lr * 1.25, lr * 2.1, lampCol, 0.45);
          ctx.fillStyle = '#fff2cf';
          roundRect(ctx, p.x - lr * 0.32, topY - h - lr * 1.62, lr * 0.64, lr * 0.72, lr * 0.16);
          ctx.fill();
        }
      }
    }
  }

  /**
   * 桥面上的"痕迹"：裂缝 / 沥青补丁 / 血渍。
   * 一次性按固定种子生成并缓存 —— 每局都一样、每帧都一样，所以不会闪；
   * 位置全在路面内（|x| < 0.85 * roadHalf），z 铺满 2~96 的视野。
   */
  _makeDeckMarks() {
    const RH = CFG.roadHalf || 0.9;
    let s = 0x2f6e2b1;
    const r = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const out = [];
    // 【用户 m02901】痕迹数量跟画质档走（低档只留四分之一）
    const total = Math.max(6, Math.round(46 * QUALITY.prop.marks));
    for (let i = 0; i < total; i++) {
      const roll = r();
      const kind = roll < 0.28 ? 'crack' : roll < 0.55 ? 'patch' : 'stain';
      out.push({
        kind,
        x: (r() * 2 - 1) * RH * 0.85,
        z: 2 + r() * 94,
        r: kind === 'crack' ? 0.05 + r() * 0.07 : 0.05 + r() * 0.1,
        rot: (r() * 2 - 1) * 0.8,
        dark: r() < 0.5,
        a: 0.16 + r() * 0.22,
      });
    }
    return out;
  }

  /** 淡淡的空气感，压在地平线附近 */
  _drawHaze(ctx, w) {
    if (!QUALITY.prop.haze) return;
    const T = CFG.theme;
    const horizon = this.cam.horizonY;
    const bottom = horizon + this.h * 0.30;
    // 【用户 m02901】渐变按 (h, horizon) 缓存 —— 这两个值只在 resize 时变，
    // 原来每帧新建一次 createLinearGradient 是白花的
    const key = `${Math.round(horizon)}|${Math.round(this.h)}`;
    let g = this._hazeGrad;
    if (!g || this._hazeKey !== key) {
      g = ctx.createLinearGradient(0, horizon - 4, 0, bottom);
      g.addColorStop(0, T.haze[0]);
      g.addColorStop(0.45, T.haze[1]);
      g.addColorStop(1, T.haze[2]);
      this._hazeGrad = g;
      this._hazeKey = key;
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon - 4, w, bottom - horizon + 4);
  }

  /** 浓雾：盖在远景丧尸身上，让他们"从雾里走出来"（水世界里这层是水汽） */
  _drawFog(ctx, w) {
    if (!QUALITY.prop.fog) return;
    const T = CFG.theme;
    const horizon = this.cam.horizonY;
    const bottom = horizon + this.h * CFG.fogTo;
    const key = `${Math.round(horizon)}|${Math.round(this.h)}`;
    let g = this._fogGrad;
    if (!g || this._fogKey !== key) {
      g = ctx.createLinearGradient(0, horizon - 6, 0, bottom);
      g.addColorStop(0, T.fog[0]);
      g.addColorStop(0.3, T.fog[1]);
      g.addColorStop(0.7, T.fog[2]);
      g.addColorStop(1, T.fog[3]);
      this._fogGrad = g;
      this._fogKey = key;
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon - 6, w, bottom - horizon + 6);
  }

  // ---------------------------------------------------------
  //  实体（按深度从远到近排序）
  // ---------------------------------------------------------

  _drawEntities(ctx, game) {
    // 【用户 m02901 性能】原来每帧为每个实体 new 一个 {z,k,o} 再 sort：
    // 50 只丧尸 + 子弹 + 粒子就是每秒上万次分配。现在复用池对象，
    // _active 只存引用（数组本体也复用，只在实体变多时增长一次）。
    const pool = this._pool;
    const list = this._active;
    let n = 0;
    const add = (z, k, o) => {
      let it = pool[n];
      if (it === undefined) { it = { z: 0, k: 0, o: null }; pool[n] = it; }
      it.z = z; it.k = k; it.o = o;
      list[n] = it;
      n++;
    };
    for (const e of game.enemies) if (!e.dead) add(e.z, 0, e);
    for (const b of game.bullets) if (!b.dead) add(b.z, 1, b);
    for (const o of game.orbs) add(o.z, 2, o);
    if (game.gates) add(game.gates.z, 3, game.gates);
    for (const s of game.spits) add(s.z, 4, s);
    list.length = n;
    list.sort(BY_Z_DESC);

    for (const it of list) {
      if (it.k === 0) this._drawZombie(ctx, it.o);
      else if (it.k === 1) this._drawBullet(ctx, game, it.o);
      else if (it.k === 2) this._drawOrb(ctx, it.o);
      else if (it.k === 4) this._drawSpit(ctx, it.o);
      else this._drawGates(ctx, game, it.o);
    }

    // 粒子统一后画：体积小，深度错位看不出来
    for (const p of game.particles) this._drawParticle(ctx, p);
  }

  /**
   * 桥面上的"痕迹"层：血泊、尸体、空袭落点的预警圈。
   * 都贴在桥面上，所以在实体之前画（不参与深度排序）。
   * 这一层是"打击爽感"的一半：打完一波回头一看，桥面全是血和尸体。
   */
  _drawGround(ctx, game) {
    const T = CFG.theme;
    const cam = this.cam;

    // 血泊（这一波留下的，越打越脏）
    for (const s of game.stains) {
      const p = cam.project(s.x, s.z);
      ctx.globalAlpha = s.a * 0.75;
      ctx.fillStyle = T.stain[0];
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, s.r * p.s * 0.5, s.r * p.s * 0.2, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = s.a * 0.5;
      ctx.fillStyle = T.stain[1];
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, s.r * p.s * 0.3, s.r * p.s * 0.12, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 尸体：前 0.5 秒向后倒下（旋转 + 压扁），然后慢慢融进血泊里
    for (const c of game.corpses) {
      const p = cam.project(c.x, c.z);
      const H = c.size * p.s;
      const fall = clamp(c.t / 0.45, 0, 1);
      const fade = clamp(1 - (c.t - 0.9) / 2.7, 0, 1);
      if (fade <= 0.02) continue;
      ctx.save();
      ctx.globalAlpha = 0.9 * fade;
      ctx.translate(p.x, p.y);
      // 倒地：绕脚底旋转到接近水平，同时高度压扁
      ctx.rotate(c.dir * fall * 1.35);
      ctx.scale(1 + fall * 0.15, 1 - fall * 0.55);
      this._zombieBody(ctx, H, mix(c.color, '#2a1a1a', 0.35 + fall * 0.3), c.dark, c.phase, c.kind, false, c.id || 0);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // 空袭落点预警：白热圈 + 中心亮点，越接近落地越亮
    // （导弹的 t 是"发射后经过的时间"，所以还剩多久落地 = delay + dur - t）
    for (const s of game.strikes) {
      const p = cam.project(s.x, s.z);
      const left = s.delay + s.dur - s.t;
      const k = clamp(1 - left / 0.9, 0.12, 1);
      const r = CFG.strike.radius * p.s * (0.35 + k * 0.65);
      this._drawGlow(p.x, p.y, r * 0.9, '#ff9f45', 0.35 + k * 0.4);
      ctx.strokeStyle = `rgba(255,220,150,${0.35 + k * 0.5})`;
      ctx.lineWidth = Math.max(1, 1.2 + k * 2.2);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * 0.38, 0, 0, TAU);
      ctx.stroke();
    }

    // 水雷（第二关升级项"布设水雷"）：一颗浮在桥面上的红色浮球，带触角和呼吸光
    for (const m of game.mines) {
      const p = cam.project(m.x, m.z);
      // 注意：CFG.mine.radius(0.6) 是"踩上来的判定半径"，比桥还宽（桥面半宽才 0.35），
      // 拿它当绘制半径会画出一颗糊满屏幕的红球（踩过），画多大事单独定。
      const r = p.s * CFG.mine.size;
      if (r < 1) continue;
      const pulse = 0.7 + 0.3 * Math.sin(this.time * 6 + m.z);
      this._drawGlow(p.x, p.y - r * 0.5, r * 1.7, '#ff6a4a', 0.3 * pulse);
      // 触角
      ctx.strokeStyle = '#3a1a14';
      ctx.lineWidth = Math.max(1, r * 0.13);
      for (let k = 0; k < 6; k++) {
        const a2 = (k / 6) * TAU + this.time * 0.6;
        ctx.beginPath();
        ctx.moveTo(p.x + Math.cos(a2) * r * 0.88, p.y - r * 0.5 + Math.sin(a2) * r * 0.88);
        ctx.lineTo(p.x + Math.cos(a2) * r * 1.5, p.y - r * 0.5 + Math.sin(a2) * r * 1.5);
        ctx.stroke();
      }
      ctx.fillStyle = '#e8503c';
      ctx.beginPath();
      ctx.arc(p.x, p.y - r * 0.5, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,220,0.9)';
      ctx.lineWidth = Math.max(1, r * 0.22);
      ctx.beginPath();
      ctx.arc(p.x, p.y - r * 0.5, r, Math.PI * 0.18, Math.PI * 0.82);
      ctx.stroke();
    }
  }

  /**
   * 空袭的轰炸机：横穿夜空。
   * 画在背景之后、桥面之前——天上的东西不该被桥挡住。
   * 注意配色：第一版用了接近夜空的深蓝，结果整架飞机"看不见"，
   * 所以机身要有月光渐变 + 亮描边 + 引擎火光，才在夜空里立得住。
   */
  _drawPlane(ctx, game) {
    const p = game.plane;
    if (!p) return;
    const w = this.w;
    const h = this.h;
    const k = clamp(p.t / p.dur, 0, 1);
    // 从画面外进场，飞到画面外为止
    const x = (p.dir > 0 ? -0.18 + 1.36 * k : 1.18 - 1.36 * k) * w;
    // 高度按"地平线的比例"算，不按整屏高度：地平线只在屏幕上方约 1/5 处，
    // 按整屏高度算会把飞机放到水面以下，直接被后面的水/桥面盖掉（踩过的坑）
    const y = Math.max(24, this.cam.horizonY * p.y);
    const S = Math.max(20, w * 0.082); // 半个机身长

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(p.dir, 1); // 机头永远朝 +x，靠镜像决定往哪边飞

    const pulse = 0.8 + Math.sin(p.t * 26) * 0.2;

    // ---- 尾迹：两道细细的、往后拖的白烟（不要画成大椭圆，会变成一块板子）----
    ctx.strokeStyle = 'rgba(200,218,240,0.22)';
    ctx.lineWidth = Math.max(1.5, S * 0.07);
    ctx.lineCap = 'round';
    for (const ey of [S * 0.3, S * 0.62]) {
      ctx.beginPath();
      ctx.moveTo(-S * 1.2, ey);
      ctx.lineTo(-S * (2.6 + 0.3 * pulse), ey + S * 0.12);
      ctx.stroke();
    }

    // ---- 远侧机翼 + 平尾 + 垂直尾（先画，压在机身下面，颜色更暗）----
    ctx.fillStyle = '#182534';
    ctx.beginPath(); // 远侧主翼（往上掠）
    ctx.moveTo(S * 0.2, -S * 0.14);
    ctx.lineTo(-S * 0.5, -S * 1.0);
    ctx.lineTo(-S * 0.16, -S * 1.0);
    ctx.lineTo(S * 0.52, -S * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath(); // 垂直尾翼
    ctx.moveTo(-S * 0.62, -S * 0.12);
    ctx.lineTo(-S * 1.12, -S * 0.92);
    ctx.lineTo(-S * 0.82, -S * 0.92);
    ctx.lineTo(-S * 0.44, -S * 0.12);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath(); // 平尾
    ctx.moveTo(-S * 0.88, -S * 0.05);
    ctx.lineTo(-S * 1.24, -S * 0.34);
    ctx.lineTo(-S * 0.94, -S * 0.34);
    ctx.lineTo(-S * 0.66, -S * 0.05);
    ctx.closePath();
    ctx.fill();

    // ---- 机身：上沿被月光照亮，下沿沉进夜色 ----
    const body = ctx.createLinearGradient(0, -S * 0.17, 0, S * 0.17);
    body.addColorStop(0, '#6f8cae');
    body.addColorStop(0.42, '#33465e');
    body.addColorStop(1, '#0e1622');
    ctx.fillStyle = body;
    roundRect(ctx, -S * 0.96, -S * 0.17, S * 1.85, S * 0.34, S * 0.17);
    ctx.fill();
    ctx.beginPath(); // 机头收成锥形
    ctx.moveTo(S * 0.86, -S * 0.17);
    ctx.lineTo(S * 1.26, S * 0.0);
    ctx.lineTo(S * 0.86, S * 0.17);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath(); // 机尾收细
    ctx.moveTo(-S * 0.9, -S * 0.15);
    ctx.lineTo(-S * 1.3, -S * 0.12);
    ctx.lineTo(-S * 1.3, S * 0.12);
    ctx.lineTo(-S * 0.9, S * 0.15);
    ctx.closePath();
    ctx.fill();

    // ---- 座舱玻璃：几点暖黄，飞机有了"驾驶舱"就一眼认得出 ----
    ctx.fillStyle = 'rgba(255,226,150,0.92)';
    roundRect(ctx, S * 0.34, -S * 0.15, S * 0.2, S * 0.15, S * 0.05);
    ctx.fill();
    roundRect(ctx, S * 0.58, -S * 0.14, S * 0.16, S * 0.13, S * 0.04);
    ctx.fill();

    // ---- 近侧主翼（往下掠，压在最上层）----
    ctx.fillStyle = '#2f4459';
    ctx.beginPath();
    ctx.moveTo(S * 0.24, S * 0.12);
    ctx.lineTo(-S * 0.44, S * 1.0);
    ctx.lineTo(-S * 0.06, S * 1.0);
    ctx.lineTo(S * 0.58, S * 0.1);
    ctx.closePath();
    ctx.fill();
    // 机翼前缘冷光
    ctx.strokeStyle = 'rgba(175,210,245,0.5)';
    ctx.lineWidth = Math.max(1, S * 0.035);
    ctx.beginPath();
    ctx.moveTo(S * 0.24, S * 0.12);
    ctx.lineTo(-S * 0.44, S * 1.0);
    ctx.stroke();

    // ---- 发动机短舱 + 喷口火光（夜空里最亮的东西）----
    for (const [nx, ny] of [[-S * 0.08, S * 0.3], [-S * 0.3, S * 0.66]]) {
      ctx.fillStyle = '#1c2836';
      roundRect(ctx, nx - S * 0.16, ny - S * 0.12, S * 0.32, S * 0.24, S * 0.1);
      ctx.fill();
      this._drawGlow(nx - S * 0.1, ny, S * 0.5 * pulse, '#ffb066', 0.55);
      ctx.fillStyle = `rgba(255,168,70,${0.42 * pulse})`;
      ctx.beginPath();
      ctx.moveTo(nx - S * 0.16, ny - S * 0.07);
      ctx.lineTo(nx - S * (0.6 + 0.24 * pulse), ny);
      ctx.lineTo(nx - S * 0.16, ny + S * 0.07);
      ctx.closePath();
      ctx.fill();
    }

    // ---- 机身上沿轮廓光 ----
    ctx.strokeStyle = 'rgba(200,232,255,0.75)';
    ctx.lineWidth = Math.max(1.2, S * 0.05);
    roundRect(ctx, -S * 0.96, -S * 0.17, S * 1.85, S * 0.34, S * 0.17);
    ctx.stroke();

    // ---- 翼尖航行灯 + 尾部闪灯 ----
    ctx.fillStyle = 'rgba(255,90,90,0.95)';
    ctx.beginPath();
    ctx.arc(-S * 0.5, S * 0.98, Math.max(1.4, S * 0.055), 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(130,255,150,0.95)';
    ctx.beginPath();
    ctx.arc(-S * 0.16, -S * 0.98, Math.max(1.4, S * 0.055), 0, TAU);
    ctx.fill();
    if (Math.sin(p.t * 7) > 0) {
      ctx.fillStyle = 'rgba(255,220,140,0.95)';
      ctx.beginPath();
      ctx.arc(-S * 1.14, -S * 0.86, Math.max(1.2, S * 0.045), 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  /** 空袭的导弹：从天而降，带尾焰与弹道偏移 */
  _drawMissiles(ctx, game) {
    for (const m of game.strikes) {
      const fly = m.t - m.delay;
      if (fly < 0) continue; // 还没投下来
      const k = clamp(fly / m.dur, 0, 1);
      const p = this.cam.project(m.x, m.z);
      // 从画面顶端之外加速落下，末端带一点横向漂移：弹道不是一条条垂直线
      const easeIn = k * k * 0.6 + k * 0.4;
      const y = -40 + (p.y + 40) * easeIn;
      const x = p.x + m.lean * this.w * 0.1 * (1 - k);
      const len = 24 + 44 * k;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(m.lean * 0.35 * (1 - k));
      // 尾焰（在上方，因为导弹头朝下）
      const flame = len * (1.25 + Math.sin(this.time * 42 + m.z) * 0.12);
      const g = ctx.createLinearGradient(0, -flame - len * 0.3, 0, 0);
      g.addColorStop(0, 'rgba(255,150,60,0)');
      g.addColorStop(0.55, 'rgba(255,170,80,0.35)');
      g.addColorStop(1, 'rgba(255,224,160,0.7)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-len * 0.13, 0);
      ctx.lineTo(0, -flame - len * 0.3);
      ctx.lineTo(len * 0.13, 0);
      ctx.closePath();
      ctx.fill();
      // 弹体
      ctx.fillStyle = '#dfe6ef';
      roundRect(ctx, -len * 0.07, -len * 0.45, len * 0.14, len * 0.95, len * 0.07);
      ctx.fill();
      // 弹头 + 高光（越接近落地越亮）
      ctx.fillStyle = '#ffce7a';
      ctx.beginPath();
      ctx.moveTo(-len * 0.07, len * 0.5);
      ctx.lineTo(0, len * 0.72);
      ctx.lineTo(len * 0.07, len * 0.5);
      ctx.closePath();
      ctx.fill();
      this._drawGlow(0, len * 0.4, len * 0.42, '#ff8a3c', 0.4 + k * 0.5);
      ctx.restore();
    }
  }

  /** 角色台词：英雄头顶一个对话气泡（连杀里程碑时冒出来） */
  _drawShout(ctx, game) {
    const s = game.shout;
    if (!s) return;
    const pl = game.player;
    const p = this.cam.project(pl.x, pl.z);
    const H = CFG.hero.size * p.s;
    const pop = clamp(s.t / 0.16, 0, 1);
    const ease = 1 - Math.pow(1 - pop, 3);
    const fade = clamp((s.life - s.t) / 0.32, 0, 1);
    if (fade <= 0.01) return;

    const size = Math.max(15, Math.min(30, this.w * 0.058)) * (0.62 + 0.38 * ease);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.font = `900 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(s.text).width;
    const bw = tw + size * 1.2;
    const bh = size * 1.55;
    const bx = clamp(p.x, bw / 2 + 8, this.w - bw / 2 - 8);
    const by = p.y - H * 1.3 - bh * 0.6 - (1 - ease) * 12;

    // 气泡
    ctx.beginPath();
    ctx.fillStyle = 'rgba(8,12,20,0.84)';
    roundRect(ctx, bx - bw / 2, by - bh / 2, bw, bh, bh * 0.34);
    ctx.fill();
    // 指向英雄的小尖角
    ctx.beginPath();
    ctx.moveTo(bx - size * 0.4, by + bh / 2 - 1);
    ctx.lineTo(bx, by + bh / 2 + size * 0.42);
    ctx.lineTo(bx + size * 0.4, by + bh / 2 - 1);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(1.4, size * 0.085);
    roundRect(ctx, bx - bw / 2, by - bh / 2, bw, bh, bh * 0.34);
    ctx.stroke();

    // 台词：黑描边 + 彩色字
    ctx.lineWidth = Math.max(2, size * 0.16);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(s.text, bx, by);
    ctx.fillStyle = s.color;
    ctx.fillText(s.text, bx, by);
    ctx.restore();
  }

  /**
   * 【用户 m11492】恶龙的火墙 / 风压墙。
   * 同一波的所有列共用同一个 z，所以按 z 分组、把各列的 [x-hitW, x+hitW] 合并成区间，
   * 只在这些区间上画一条幕布 —— 缝在哪里、有多宽，屏幕上就是一眼看得出的那道口子。
   * （逐簇画会在近处糊成一团、远处只剩火星，这也是之前"看不出该往哪躲"的一半原因。）
   */
  _drawDragonWalls(ctx, game) {
    const list = game.spits;
    if (!list || !list.length) return;
    const rw = this.cam.roadHalf * 1.15;
    const groups = new Map();
    for (const s of list) {
      if (!s.wall) continue;
      const key = Math.round(s.z * 10) + '|' + (s.wind ? 'w' : 'f');
      let g = groups.get(key);
      if (!g) {
        g = { z: s.z, wind: !!s.wind, segs: [] };
        groups.set(key, g);
      }
      // 覆盖区间 + 这一波的缝（缝跟着墙一起漂：用当前位移 orig→x 修正）
      const dl = s.x - (s.orig === undefined ? s.x : s.orig);
      g.segs.push([s.x - s.hitW, s.x + s.hitW, (s.hole || 0) + dl, s.holeW || s.hitW]);
    }
    if (!groups.size) return;
    const sorted = [...groups.values()].sort((a, b) => b.z - a.z);
    for (const g of sorted) {
      const cam = this.cam;
      const p = cam.project(0, g.z);
      const S = p.s;
      const merge = [...g.segs].sort((a, b) => a[0] - b[0]);
      const ivs = [];
      for (const seg of merge) {
        const a = Math.max(-rw, seg[0]);
        const b = Math.min(rw, seg[1]);
        if (b <= a) continue;
        const last = ivs[ivs.length - 1];
        if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
        else ivs.push([a, b]);
      }
      // 墙永远铺满整座桥，只在排程给的那条缝上留口子 —— 这样即使墙整体漂到桥外，
      // 桥上也不会出现"靠栏杆站着就安全"的空当（唯一安全的地方就是那条缝）。
      const holes = g.segs.filter((s) => s.length === 4).map((s) => [s[2] - s[3], s[2] + s[3]]);
      ivs.length = 0;
      ivs.push([-rw, rw]);
      for (const [ha, hb] of holes) {
        for (let i = ivs.length - 1; i >= 0; i--) {
          const [a, b] = ivs[i];
          if (hb <= a || ha >= b) continue;
          ivs.splice(i, 1);
          if (ha > a) ivs.push([a, Math.min(ha, b)]);
          if (hb < b) ivs.push([Math.max(hb, a), b]);
        }
      }
      const hgt = (g.wind ? 0.3 : 0.36) * S; // 幕布高度（世界单位 → 屏幕）
      const baseY = p.y;
      const t = this.time * (g.wind ? 6.5 : 8.5) + g.z;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const [a, b] of ivs) {
        const x0 = cam.project(a, g.z).x;
        const x1 = cam.project(b, g.z).x;
        const wpx = x1 - x0;
        if (wpx < 1.5) continue;
        const cx = (x0 + x1) * 0.5;
        // 幕布后面的整体辉光
        // 光晕跟着幕布高度走（不能跟着宽度走：贴到镜头前时 wpx 很大，
        // 那样会糊出一大块橙色板子，把缝和火舌全盖掉）
        this._drawGlow(cx, baseY - hgt * 0.3, hgt * (g.wind ? 0.7 : 0.9),
          g.wind ? 'rgba(200,228,255,0.9)' : 'rgba(255,140,50,0.95)', g.wind ? 0.22 : 0.3);
        // 主体：下沿贴桥面、上沿走一条起伏的焰尖
        const grd = ctx.createLinearGradient(cx, baseY + hgt * 0.06, cx, baseY - hgt);
        if (g.wind) {
          grd.addColorStop(0, 'rgba(206,232,255,0.30)');
          grd.addColorStop(0.55, 'rgba(232,246,255,0.20)');
          grd.addColorStop(1, 'rgba(255,255,255,0)');
        } else {
          grd.addColorStop(0, 'rgba(255,246,214,0.92)');
          grd.addColorStop(0.35, 'rgba(255,178,74,0.86)');
          grd.addColorStop(0.78, 'rgba(255,110,32,0.6)');
          grd.addColorStop(1, 'rgba(255,80,20,0)');
        }
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.moveTo(x0, baseY + hgt * 0.06);
        const n = Math.max(2, Math.round(wpx / 34));
        const step = wpx / n;
        let prevY = baseY - hgt * 0.7;
        for (let i = 0; i <= n; i++) {
          const fx = x0 + step * i;
          const wv = 0.66 + 0.34 * Math.sin(t * 0.9 + i * 1.7);
          const y = baseY - hgt * wv;
          if (i === 0) ctx.lineTo(fx, y);
          else ctx.quadraticCurveTo(fx - step * 0.5, Math.min(prevY, y) - hgt * 0.1, fx, y);
          prevY = y;
        }
        ctx.lineTo(x1, baseY + hgt * 0.06);
        ctx.closePath();
        ctx.fill();
        // 焰舌：几道更亮的高光，让幕布在动
        if (!g.wind) {
          const m = Math.max(1, Math.round(wpx / 40));
          for (let i = 0; i <= m; i++) {
            const fx = x0 + ((wpx * (i + 0.5)) / (m + 1));
            const sw = Math.sin(t * 2.3 + i * 2.1) * 0.16;
            const bw = (wpx / (m + 1)) * 0.34;
            ctx.fillStyle = 'rgba(255,244,204,0.26)';
            ctx.beginPath();
            ctx.moveTo(fx - bw, baseY);
            ctx.quadraticCurveTo(fx - bw * 0.4 + sw * 16, baseY - hgt * 0.55, fx + sw * 26, baseY - hgt * 0.78);
            ctx.quadraticCurveTo(fx + bw * 0.5 + sw * 10, baseY - hgt * 0.34, fx + bw, baseY);
            ctx.closePath();
            ctx.fill();
          }
        }
      }
      // 缝的两侧各点一道更亮的火柱：让"门"在一整面火里一眼可见
      // （否则整面墙颜色均匀，玩家只会觉得"全屏都在烧"，看不出该往哪钻）
      for (const [ha, hb] of holes) {
        for (const hx of [ha, hb]) {
          if (hx < -rw || hx > rw) continue;
          const px = cam.project(hx, g.z).x;
          const hh = hgt * (g.wind ? 0.9 : 1.25);
          const grd2 = ctx.createLinearGradient(px, baseY + 4, px, baseY - hh);
          grd2.addColorStop(0, g.wind ? 'rgba(240,250,255,0.85)' : 'rgba(255,252,232,0.95)');
          grd2.addColorStop(0.5, g.wind ? 'rgba(214,236,255,0.5)' : 'rgba(255,196,92,0.72)');
          grd2.addColorStop(1, 'rgba(255,140,40,0)');
          ctx.fillStyle = grd2;
          const wj = Math.max(3, hgt * 0.16);
          ctx.beginPath();
          ctx.moveTo(px - wj, baseY + 4);
          ctx.quadraticCurveTo(px - wj * 0.5, baseY - hh * 0.6, px + Math.sin(t * 2.4) * wj * 0.6, baseY - hh);
          ctx.quadraticCurveTo(px + wj * 0.8, baseY - hh * 0.5, px + wj, baseY + 4);
          ctx.closePath();
          ctx.fill();
        }
      }
      // 【用户 m11916】"缝后面还有火，让人不敢走"：把缝朝镜头方向延成一条压暗的走廊，
      // 后面那堵墙即使从缝里透出来也会被走廊盖暗 —— 否则玩家看到缝里有橙色，就不敢钻。
      ctx.globalCompositeOperation = 'source-over';
      const hole0 = holes[0];
      if (hole0) {
        const a = cam.project(hole0[0] - hole0[1], g.z);
        const b = cam.project(hole0[0] + hole0[1], g.z);
        const c = cam.project(hole0[0] + hole0[1] * 1.8, g.z - 3.4);
        const d = cam.project(hole0[0] - hole0[1] * 1.8, g.z - 3.4);
        const lane = ctx.createLinearGradient(0, a.y, 0, c.y);
        lane.addColorStop(0, 'rgba(7,5,4,0.66)');
        lane.addColorStop(0.5, 'rgba(7,5,4,0.36)');
        lane.addColorStop(1, 'rgba(7,5,4,0)');
        ctx.fillStyle = lane;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = g.wind ? 'rgba(214,238,255,0.40)' : 'rgba(255,216,155,0.34)';
        ctx.lineWidth = Math.max(1, S * 0.0055);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(d.x, d.y);
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  _drawSpit(ctx, s) {
    const cam = this.cam;
    const p = cam.project(s.x, s.z);
    // hot（僵尸博士的火球）：同一套飞行物，画得更大更烫
    // 【用户 m11492】恶龙的火墙/风压墙是"一整面墙"：单簇必须比火球大一倍，
    // 相邻两簇才会连起来 —— 否则铺满桥面的墙在屏幕上只是几颗小火星，玩家根本看不出哪里是缝。
    // 【用户 m11492】整面墙不再一簇一簇画（那样近处会糊成一团、远处只剩小火星），
    // 交给 _drawDragonWalls 按世界坐标画成一条连续的带子。
    if (s.wall) return;
    const r = Math.max(2, (s.hot ? 0.05 : 0.022) * p.s);
    const wob = 1 + Math.sin(s.phase) * 0.18;
    if (s.hot) {
      // 【用户 m08143】"火球画成更像火焰"：原来是一层光晕 + 一个椭圆 + 一个小圆点，
      // 看着像一颗发光药丸。现在按火焰画：叠加光晕 + 三条随时间扭动的火舌
      // （外焰橙 → 中焰金 → 内焰近白）+ 往上飘的火星；火舌朝后（屏幕上方）甩。
      const c1 = s.color || '#ff7a1f';
      const t = this.time * 9 + (s.phase || 0);
      const fl = 1 + Math.sin(t) * 0.12;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this._drawGlow(p.x, p.y - r * 0.7, r * 5.2, c1, 0.42);
      const cyp = p.y - r * 0.5;
      for (let i = 0; i < 3; i++) {
        // 三条火舌左右错开，轮廓才是"跳动的火"而不是一颗光滑的泪滴
        const off = (i - 1) * r * 0.44;
        const sway = Math.sin(t * 1.3 + i * 2.1) * r * 0.5;
        const len = r * (2.2 + 0.55 * (1 + Math.sin(t * 1.9 + i * 1.3)) * 0.5 - i * 0.18);
        const wdt = r * (0.95 - i * 0.16) * wob * fl;
        const cxp = p.x + off + sway * 0.35;
        const g2 = ctx.createLinearGradient(cxp, cyp - len, cxp, cyp + wdt);
        g2.addColorStop(0, i === 2 ? 'rgba(255,246,208,0)' : 'rgba(255,110,32,0)');
        g2.addColorStop(0.45, i === 2 ? 'rgba(255,248,214,0.85)' : i === 1 ? 'rgba(255,180,80,0.8)' : 'rgba(255,110,32,0.72)');
        g2.addColorStop(1, i === 2 ? 'rgba(255,252,238,0.95)' : i === 1 ? 'rgba(255,216,128,0.9)' : 'rgba(255,150,55,0.88)');
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.moveTo(cxp - wdt, cyp + wdt * 0.15);
        ctx.quadraticCurveTo(cxp - wdt * 1.05, cyp - len * 0.45, cxp + sway * 0.45, cyp - len);
        ctx.quadraticCurveTo(cxp + wdt * 0.95, cyp - len * 0.4, cxp + wdt, cyp + wdt * 0.15);
        ctx.quadraticCurveTo(cxp, cyp + wdt * 1.25, cxp - wdt, cyp + wdt * 0.15);
        ctx.closePath();
        ctx.fill();
      }
      // 焰尖上方一缕淡烟，压住"火球"的球感
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#c9b6d8';
      ctx.beginPath();
      ctx.ellipse(p.x + Math.sin(t * 0.7) * r * 0.5, cyp - r * 3.1, r * 0.75, r * 1.15, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      // 火星：从火球往上飘，越飘越淡
      for (let i = 0; i < 4; i++) {
        const a = ((t * 0.11 + i * 0.27) % 1);
        const sx = p.x + Math.sin(t * 0.9 + i * 2.3) * r * 1.7;
        const sy = p.y - r * (0.9 + a * 3.4);
        ctx.globalAlpha = (1 - a) * 0.75;
        ctx.fillStyle = i % 2 ? '#ffd27a' : '#ff8a3a';
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(0.6, r * 0.18 * (1 - a * 0.5)), 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      return;
    }
    if (s.wave) {
      // 【用户 m11792】振翅改成"冲击波"，不是风墙：一道宽月牙从龙那边扫过来，
      // 形状和勇者的剑气同族（月牙 + 亮边），区别是它慢。
      // 【用户 m12738】"振翅要伤害" —— 画面上的月牙宽度直接跟着判定宽度（hitW）走，
      // 看见多宽就是多宽的伤害范围，不再"看着擦到了其实没掉血"。
      const W = Math.max(7, (s.hitW || 0.1) * 1.35 * p.s);
      const hh = Math.max(6, 0.055 * p.s);
      const t = this.time * 5.5 + (s.phase || 0);
      const a = 0.82 + Math.sin(t) * 0.1;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this._drawGlow(p.x, p.y - hh * 0.4, W * 1.25, 'rgba(198,230,255,0.9)', a * 0.35);
      const cx = p.x;
      const cy = p.y - hh * 2.1;
      // 月牙用"外弧 + 内弧反向"拼，两端自然收成尖 —— 直接 stroke 一段圆弧两端是平的，
      // 看着像两条白眉毛，不像剑气。
      const g2 = ctx.createLinearGradient(cx, cy + W * 0.2, cx, cy - W);
      g2.addColorStop(0, 'rgba(255,255,255,0.95)');
      g2.addColorStop(0.45, 'rgba(214,238,255,0.75)');
      g2.addColorStop(1, 'rgba(160,205,255,0)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(cx, cy, W, Math.PI * 0.14, Math.PI * 0.86);
      ctx.arc(cx, cy, W * 0.84, Math.PI * 0.74, Math.PI * 0.26, true);
      ctx.closePath();
      ctx.fill();
      // 拖在后面的风痕
      ctx.globalAlpha = 0.13;
      ctx.fillStyle = 'rgba(226,242,255,0.9)';
      ctx.beginPath();
      ctx.ellipse(cx, cy - hh * 1.15, W * 0.52, hh * 0.8, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
      return;
    }
    this._drawGlow(p.x, p.y - r * 0.7, r * 3.4, '#a6ff3d', 0.85);
    ctx.fillStyle = '#d8ff7a';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - r * 0.7, r * wob, r * 1.15 * wob, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#6fae2a';
    ctx.beginPath();
    ctx.arc(p.x + r * 0.25, p.y - r * 0.95, r * 0.36, 0, TAU);
    ctx.fill();
  }

  _drawParticle(ctx, p) {
    const cam = this.cam;
    const pr = cam.project(p.x, p.z);
    const y = pr.y - p.h * pr.s;
    const r = Math.max(0.5, p.size * pr.s);
    const a = clamp(p.life / 0.5, 0, 1);
    if (p.add) {
      this._drawGlow(pr.x, y, r * 3.2, p.color, a * 0.75);
    } else {
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(pr.x, y, r, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  _drawOrb(ctx, o) {
    const cam = this.cam;
    const p = cam.project(o.x, o.z);
    const bob = Math.sin(o.phase) * 0.012;
    const y = p.y - (0.05 + bob) * p.s;
    const r = Math.max(2, 0.022 * p.s);
    this._drawGlow(p.x, y, r * 3.4, '#3dff88', 0.85);
    ctx.fillStyle = '#eafff0';
    ctx.beginPath();
    ctx.arc(p.x, y, r * 0.55, 0, TAU);
    ctx.fill();
    // 十字
    ctx.strokeStyle = '#2ee06a';
    ctx.lineWidth = Math.max(1, r * 0.32);
    ctx.beginPath();
    ctx.moveTo(p.x - r * 0.85, y);
    ctx.lineTo(p.x + r * 0.85, y);
    ctx.moveTo(p.x, y - r * 0.85);
    ctx.lineTo(p.x, y + r * 0.85);
    ctx.stroke();
  }

  /**
   * 第三关的子弹：一颗豌豆。
   * 用户 m02771：寒冰/炎火"只改变一条弹道的类型并改变颜色"，所以豌豆的颜色
   * 完全由**这一条弹道自己的属性**决定 —— 屏幕上能同时看到绿、冰蓝、火橙三条线。
   */
  _drawPea(ctx, game, b) {
    const cam = this.cam;
    const L = CFG.theme.lawn;
    const p = cam.project(b.x, b.z);
    const ice = b.lane === 'ice';
    const fire = b.lane === 'fire';
    const core = ice ? CFG.pvz.ice.color : fire ? CFG.pvz.fire.color : L.pea;
    const glow = ice ? CFG.pvz.ice.glow : fire ? CFG.pvz.fire.glow : L.peaDark;
    const r = Math.max(1.3, CFG.weapon.bulletRadius * 1.2 * p.s);

    // 拖尾：跟枪弹一样要有速度感，但更短更"汁水"
    const back = cam.project(b.x, Math.max(game.player.z, b.z - 0.42));
    for (let i = 1; i <= 3; i++) {
      const t = i / 3;
      this._drawGlow(p.x + (back.x - p.x) * t, p.y + (back.y - p.y) * t, r * (1.3 - t * 0.5), glow, (1 - t) * 0.45);
    }
    this._drawGlow(p.x, p.y, r * 2.1, glow, 0.7);
    ctx.fillStyle = b.crit ? '#fffbe8' : core;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.66, 0, TAU);
    ctx.fill();
    // 豌豆的圆头高光（一颗豆子该有的样子）
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.beginPath();
    ctx.arc(p.x - r * 0.22, p.y - r * 0.24, r * 0.24, 0, TAU);
    ctx.fill();
  }

  _drawBullet(ctx, game, b) {
    // 第三关：子弹是豌豆 —— 每条弹道的属性决定颜色（绿 / 冰蓝 / 火橙）
    if (CFG.level.skin === 'pvz') {
      this._drawPea(ctx, game, b);
      return;
    }
    // 第四关：勇者的子弹是"剑气月牙"，花仙子的是"魔法粒子"（用户 m04749）
    if (CFG.level.skin === 'fantasy') {
      this._drawFantasyShot(ctx, game, b);
      return;
    }
    const cam = this.cam;
    const tier = WEAPON_TIERS[game.weapon.tierIdx];
    const p = cam.project(b.x, b.z);
    const r = Math.max(1.1, CFG.weapon.bulletRadius * tier.radiusMul * p.s);

    // 拖尾
    const back = cam.project(b.x, Math.max(game.player.z, b.z - 0.55 * tier.trail));
    const trailR = r * 0.55;
    for (let i = 1; i <= 3; i++) {
      const t = i / 3;
      const tx = p.x + (back.x - p.x) * t;
      const ty = p.y + (back.y - p.y) * t;
      this._drawGlow(tx, ty, trailR * (1.4 - t * 0.5), tier.glow, (1 - t) * 0.5);
    }

    this._drawGlow(p.x, p.y, r * 2.6, tier.glow, 0.95);
    ctx.fillStyle = b.crit ? '#fff6d8' : tier.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.55, 0, TAU);
    ctx.fill();
  }

  /**
   * 第四关的弹道外观（用户 m04749）：
   *   勇者 → 一道横向的剑气月牙（弧口朝后，靠近了才看得出是"剑气"）
   *   花仙子 → 金色星芒芯 + 粉色光点尾迹（整体偏少女风）
   */
  _drawFantasyShot(ctx, game, b) {
    const cam = this.cam;
    const p = cam.project(b.x, b.z);
    const H2 = CFG.fantasy.heroes;
    const fairy = game.heroId === 'fairy';
    const K = fairy ? H2.fairy : H2.knight;
    const tier = WEAPON_TIERS[game.weapon.tierIdx];
    const r = Math.max(1.1, CFG.weapon.bulletRadius * tier.radiusMul * p.s);

    const back = cam.project(b.x, Math.max(game.player.z, b.z - 0.6 * tier.trail));
    const n = fairy ? 5 : 3;
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      const tx = p.x + (back.x - p.x) * k;
      const ty = p.y + (back.y - p.y) * k;
      if (fairy) {
        // 用户 m11097 要求"粉色蝴蝶" → 尾迹也统一成粉色系，不再跟主题强调色走
        const jit = Math.sin(this.time * 26 + i * 2.1) * r * 0.6;
        this._drawGlow(tx + jit, ty, r * (1.5 - k), i % 2 ? '#ff9ed4' : '#ffd6ec', (1 - k) * 0.55);
      } else {
        this._drawGlow(tx, ty, r * (1.2 - k * 0.4), K.spark, (1 - k) * 0.4);
      }
    }

    if (fairy) {
      // 花仙子的子弹 = 一只粉色蝴蝶（用户 m11097：原来那个四角星芒像"闪光的螺丝"）
      // 正对镜头飞过来，所以画成展翅的正面像：上下两对翅 + 身子 + 触角，翅用 flap 扇。
      const flap = 0.55 + 0.45 * Math.sin(this.time * 17 + b.x * 0.9);
      const wS = r * 2.9 * flap;
      const hS = r * 2.3;
      this._drawGlow(p.x, p.y, r * 3.4, '#ff9ed4', 0.85);
      ctx.save();
      ctx.translate(p.x, p.y);
      for (const s of [-1, 1]) {
        // 上翅
        ctx.fillStyle = b.crit ? '#ffffff' : '#ff9ed4';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(s * wS * 0.85, -hS * 1.05, s * wS * 1.3, -hS * 0.22);
        ctx.quadraticCurveTo(s * wS * 0.8, hS * 0.02, 0, hS * 0.12);
        ctx.closePath();
        ctx.fill();
        // 下翅（小一圈，略往后）
        ctx.fillStyle = b.crit ? '#fff2fb' : '#ffd6ec';
        ctx.beginPath();
        ctx.moveTo(0, hS * 0.08);
        ctx.quadraticCurveTo(s * wS * 0.8, hS * 0.45, s * wS * 0.98, hS * 0.92);
        ctx.quadraticCurveTo(s * wS * 0.42, hS * 0.8, 0, hS * 0.34);
        ctx.closePath();
        ctx.fill();
        // 翅脉高光
        ctx.strokeStyle = 'rgba(255,240,252,0.65)';
        ctx.lineWidth = Math.max(0.5, r * 0.16);
        ctx.beginPath();
        ctx.moveTo(0, -hS * 0.05);
        ctx.quadraticCurveTo(s * wS * 0.7, -hS * 0.55, s * wS * 1.18, -hS * 0.25);
        ctx.stroke();
        // 触角
        ctx.strokeStyle = K.edge;
        ctx.lineWidth = Math.max(0.5, r * 0.13);
        ctx.beginPath();
        ctx.moveTo(s * r * 0.12, -hS * 0.28);
        ctx.quadraticCurveTo(s * r * 0.5, -hS * 0.75, s * r * 0.75, -hS * 0.62);
        ctx.stroke();
      }
      // 身子
      ctx.fillStyle = b.crit ? '#ffffff' : '#e04f93';
      ctx.beginPath();
      ctx.ellipse(0, -hS * 0.05, r * 0.19, hS * 0.42, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
      return;
    }

    // 勇者的子弹 = 回旋镖（用户 m11097：不要圆形/月牙，要"扔出去会转的镖"）
    this._drawGlow(p.x, p.y, r * 2.8, K.edge, 0.7);
    const arm = r * (3.6 + tier.radiusMul * 0.4);
    const thick = r * 1.15;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(this.time * 11 + b.x * 0.6);
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.rotate(s * 0.92);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(arm * 0.55, -thick * 0.95, arm * 0.94, -thick * 0.3);
      ctx.quadraticCurveTo(arm * 0.62, thick * 0.5, 0, thick * 0.38);
      ctx.closePath();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = b.crit ? '#ffffff' : '#a8e4ff';
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = b.crit ? '#4aa8d8' : 'rgba(26,74,106,0.75)';
      ctx.lineWidth = Math.max(0.8, r * 0.3);
      ctx.stroke();
      ctx.strokeStyle = K.edge;
      ctx.lineWidth = Math.max(0.5, r * 0.14);
      ctx.stroke();
      // 刃口那道亮线（"钢口"）
      ctx.strokeStyle = 'rgba(235,250,255,0.8)';
      ctx.lineWidth = Math.max(0.5, r * 0.12);
      ctx.beginPath();
      ctx.moveTo(arm * 0.16, -thick * 0.16);
      ctx.quadraticCurveTo(arm * 0.6, -thick * 0.72, arm * 0.9, -thick * 0.26);
      ctx.stroke();
      ctx.restore();
    }
    // 中心轴（转起来才有个"镖心"）
    ctx.fillStyle = K.edge;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.3, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------
  //  丧尸剪影
  // ---------------------------------------------------------

  _drawZombie(ctx, e) {
    const cam = this.cam;
    const p = cam.project(e.x, e.z);
    const H = e.size * p.s;

    // 淡入（刚在雾里生成时几乎透明）；词条"血月浓雾"会把这段距离压短
    const fogMul = this.game && this.game.fogMul ? this.game.fogMul : 1;
    const fade = clamp((CFG.zFar + 4 - e.z) / (9 / fogMul), 0, 1);
    if (fade <= 0.02) return;

    if (H < 1.6) {
      // 太远：画一个小点，省性能也避免糊成一团（精英的点是金的，远远就能认出来）
      ctx.globalAlpha = fade * 0.75;
      this._drawGlow(p.x, p.y - H * 0.5, Math.max(0.9, H * 0.7), e.elite ? '#ffd666' : '#ff5a3c', 0.6);
      ctx.globalAlpha = 1;
      return;
    }

    // 孵化中（分裂者裂出的小兵）：从半截高度长起来 + 一圈紫光，
    // 让"它出现了"看得见，而不是凭空糊在脸上
    const hatch = e.birth > 0 && e.birthDur > 0 ? clamp(1 - e.birth / e.birthDur, 0, 1) : 1;
    if (hatch < 1) {
      // 光晕别太大：太强会把刚出生的小兵糊成一团紫，看不清它们是"人"
      this._drawGlow(p.x, p.y - H * 0.45, H * (0.3 + 0.22 * hatch), '#c89bff', 0.2 + 0.18 * hatch);
    }

    // 颜色叠加：冰冻 / 燃烧 / 受击白闪
    let col = e.color;
    if (e.slowT > 0) col = mix(col, '#5ec8ff', 0.42);
    if (e.burnT > 0) col = mix(col, '#ff8a2b', 0.36);
    if (e.hurtT > 0) col = mix(col, '#ffffff', 0.75);
    const dark = mix(e.dark, col, 0.25);

    const v = (0.9 + ((e.id * 37) % 21) / 105) * (0.42 + 0.58 * hatch); // 每只体型略有差异；孵化期更小
    const isWind = e.atk === 'wind';
    const isLunge = e.atk === 'lunge';
    // 【用户 m02901 性能】三档 LOD：屏幕高 <24px 的（一屏里最多的那批）只画剪影，
    // 24~52px 走精简人形，≥52px 才是全细节。远处的细节本来就看不见，
    // 省下的时间全部还给近处那几只 —— 真机掉帧主要就来自"一屏 40 只全都画全套"。
    // 【用户 m08839】僵尸潮卡顿：这一档是"质量/成本"折中值 —— 比原来的 22/44 略收敛
    // （H 22~24 的碎小怪降级为剪影），但主战场 H≥52 的近景僵尸仍是全细节。
    const lod = H < 24 ? 0 : H < 52 ? 1 : 2;

    ctx.save();
    ctx.globalAlpha = fade;

    // 地面阴影
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, H * 0.27 * v, H * 0.085, 0, 0, TAU);
    ctx.fill();

    // 紧张波的"领队精英"（game.spawnElite）：脚下一圈脉动的金环 + 头顶一道金光。
    // 一屏尸群里必须一眼认出"这只得先打"，所以用金色（和红色预警、白色受击都区分得开）。
    if (e.elite) {
      const puls = 0.5 + 0.5 * Math.sin(e.phase * 2.4 + (this.game ? this.game.time : 0) * 5);
      ctx.strokeStyle = `rgba(255,214,102,${(0.55 + 0.35 * puls) * fade})`;
      ctx.lineWidth = Math.max(2, H * 0.022);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, H * (0.33 + 0.025 * puls) * v, H * (0.115 + 0.008 * puls), 0, 0, TAU);
      ctx.stroke();
      if (lod > 1) this._drawGlow(p.x, p.y - H * 0.52, H * 0.3, '#ffd666', (0.3 + 0.16 * puls) * fade);
    }

    ctx.translate(p.x, p.y);

    // 蓄力下蹲 / 扑击前倾
    let sx = v;
    let sy = v;
    let lean = 0;
    if (isWind) {
      sy *= 0.87;
      sx *= 1.08;
    } else if (isLunge) {
      sx *= 1.16;
      sy *= 0.97;
      lean = e.lungeDir * 0.22;
    }
    ctx.rotate(lean);
    ctx.scale(sx, sy);
    if (e.kind === 'runner') ctx.rotate(-0.10);
    if (e.kind === 'brute') ctx.scale(1.24, 1.0);
    // 体型 1.2 的 BOSS 本来就够宽了，不再额外横向拉 1.3 倍
    //（拉过之后肩宽会超出屏幕、把两侧车道全挡掉）
    // 胖体（吐酸者 / 分裂者）：横向鼓起来，再加一点呼吸般的起伏
    if (e.body === 'fat') ctx.scale(1.22 + Math.sin(e.phase * 0.7) * 0.04, 1.0);
    // 进化演出（用户 m01503）：变身这 1.8 秒里博士从一束白光里"长"出来。
    // 白闪由 game.js 每帧顶住 e.hurtT 实现，这里只补放大。
    if (e.evolveT > 0 && e.evolveDur > 0) {
      const ek = clamp(e.evolveT / e.evolveDur, 0, 1); // 1 → 0
      ctx.scale(1 + 0.3 * ek, 1 + 0.3 * ek);
    }

    // 第四关的四只怪是整只独立重绘的（用户 m11097）：哥布林 / 兽人 / 鹰身女妖 / 郊狼
    // 连骨架都不再沿用僵尸人形，画完就不用再叠 _zombieBody 了。
    const fgOwn = lod > 0 && e.animal && CFG.level.skin === 'fantasy' && this._fantasyBody(ctx, H, e, col, dark);
    if (lod === 0) this._zombieSimple(ctx, H, col, dark, e.phase, e.kind, isWind);
    else if (!fgOwn) this._zombieBody(ctx, H, col, dark, e.phase, e.kind, isWind, e.id || 0, lod);

    // 第二关：挂上海洋动物的部件（鱼鳍 / 触手 / 蟹钳 / 背鳍 / 河豚刺 / 龟壳 / 水母伞）
    // 第三关：换成植物大战僵尸那几种僵尸的招牌部件（桶 / 电线杆 / 撑杆 / 投石机…）
    // 第四关：换成异世界那几种怪（哥布林 / 郊狼 / 兽人 / 鹰身女妖 / 史莱姆 / 恶龙）
    if (e.animal && lod > 0) {
      if (CFG.level.skin === 'pvz') this._pvzBits(ctx, H, e, col, dark);
      else if (CFG.level.skin === 'fantasy') this._fantasyBits(ctx, H, e, col, dark);
      else this._oceanBits(ctx, H, e, col, dark);
    }

    // 用户 m11097：花仙子在场时，兽人头顶会冒粉色爱心；勇者在场时，鹰身女妖冒爱心。
    // （只影响观感，不改数值 —— 是"这只怪被对面那个角色分神了"的意思。）
    if (lod > 0 && e.animal) {
      const hid = this.game ? this.game.heroId : null;
      if ((hid === 'fairy' && e.animal === 'orc') || (hid === 'knight' && e.animal === 'harpy')) {
        this._charmHearts(ctx, H, e);
      }
    }

    // 背上的鼓包：吐酸者的酸囊
    // 第四关的"吐酸者"是鹰身女妖，通用酸囊会在她脸上扣一个亮绿椭圆（出图才发现，
    // 远看像顶了半个西瓜），所以这一关不挂酸囊。
    if (e.spit && lod > 0 && CFG.level.skin !== 'fantasy') {
      const sacY = -0.86 * H;
      this._drawGlow(0, sacY, H * 0.16, '#b6ff5a', 0.5);
      ctx.fillStyle = '#a8e04a';
      ctx.beginPath();
      ctx.ellipse(0, sacY, H * 0.15, H * 0.12, 0, 0, TAU);
      ctx.fill();
    }

    // 铁盾兵：正面一块盾牌，破盾后留裂纹
    if (e.maxShield > 0 && e.shield > 0 && lod > 0) {
      const w = H * 0.62;
      const hh = H * 0.62;
      const top = -0.78 * H;
      // 【用户 m02901 性能】渐变按 H 取整缓存 —— 原来每个带盾丧尸每帧都新建一次
      // createLinearGradient（在真机上这是能明显感觉到的开销）
      const key = Math.round(H / 3);
      let g = this._shieldGrad;
      if (!g || this._shieldGradKey !== key) {
        g = ctx.createLinearGradient(-w / 2, top, w / 2, top + hh);
        g.addColorStop(0, '#c9cdb8');
        g.addColorStop(0.45, '#7f8471');
        g.addColorStop(1, '#4c5044');
        this._shieldGrad = g;
        this._shieldGradKey = key;
      }
      ctx.fillStyle = g;
      roundRect(ctx, -w / 2, top, w, hh, w * 0.16);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,22,16,0.75)';
      ctx.lineWidth = Math.max(1, H * 0.018);
      ctx.stroke();
      // 铆钉
      ctx.fillStyle = 'rgba(230,235,215,0.75)';
      for (const sx2 of [-1, 1]) {
        for (const sy2 of [0.12, 0.5, 0.86]) {
          ctx.beginPath();
          ctx.arc(sx2 * w * 0.32, top + hh * sy2, Math.max(0.7, H * 0.014), 0, TAU);
          ctx.fill();
        }
      }
      // 已经挨过打：加一道裂纹
      if (e.shield < e.maxShield) {
        ctx.strokeStyle = 'rgba(30,20,10,0.85)';
        ctx.lineWidth = Math.max(1, H * 0.02);
        ctx.beginPath();
        ctx.moveTo(-w * 0.34, top + hh * 0.24);
        ctx.lineTo(w * 0.06, top + hh * 0.5);
        ctx.lineTo(-w * 0.2, top + hh * 0.78);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  // ---------------------------------------------------------
  //  第二关：海洋动物部件
  //
  //  用户 m01451："僵尸融合海洋动物形象"。做法是**不重画身体**，只在
  //  _zombieBody 画完的人形上挂几块动物部件（鳍/触手/钳/壳/刺/伞），
  //  这样冰冻结霜、燃烧、受击白闪这些统一作用在身体色上的效果全都还在，
  //  而且远处只看剪影也能一眼认出"这是海里的东西"。
  //  局部坐标和 _zombieBody 一致：脚底是原点，头在 -H，躯干 -0.42H ~ -0.70H。
  // ---------------------------------------------------------

  _oceanBits(ctx, H, e, col, dark) {
    const a = e.animal;
    const headY = -0.815 * H;
    const headR = 0.11 * H;
    const t = this.time * 2.6 + e.phase;
    const fin = mix(col, '#ffffff', 0.32);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (a === 'fish') {
      // 背鳍（头顶）+ 尾鳍（腰后）+ 两腮
      ctx.fillStyle = fin;
      ctx.beginPath();
      ctx.moveTo(-0.02 * H, headY - headR * 0.8);
      ctx.lineTo(0.03 * H, headY - headR * 2.6);
      ctx.lineTo(0.12 * H, headY - headR * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.moveTo(0, -0.40 * H);
      ctx.lineTo(-0.22 * H, -0.48 * H + Math.sin(t) * 0.02 * H);
      ctx.lineTo(0, -0.28 * H);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = dark;
      ctx.lineWidth = 0.022 * H;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * 0.045 * H, -0.6 * H, 0.075 * H, -0.45, 0.75);
        ctx.stroke();
      }
    } else if (a === 'squid') {
      // 尖头 + 四条飘动的触手
      ctx.fillStyle = fin;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.9, headY - headR * 0.5);
      ctx.lineTo(0, headY - headR * 2.9);
      ctx.lineTo(headR * 0.9, headY - headR * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = mix(col, dark, 0.4);
      ctx.lineWidth = 0.035 * H;
      for (let i = 0; i < 4; i++) {
        const x0 = (-0.11 + i * 0.073) * H;
        ctx.beginPath();
        ctx.moveTo(x0, -0.40 * H);
        ctx.quadraticCurveTo(
          x0 + Math.sin(t + i) * 0.04 * H,
          -0.25 * H,
          x0 + Math.sin(t + i * 1.7) * 0.07 * H,
          -0.06 * H
        );
        ctx.stroke();
      }
    } else if (a === 'crab') {
      // 两只大钳子 + 背上的甲壳棱
      ctx.strokeStyle = dark;
      ctx.lineWidth = 0.05 * H;
      for (const s of [-1, 1]) {
        const ax = s * 0.3 * H;
        const ay = -0.56 * H + Math.sin(t + (s > 0 ? 1 : 0)) * 0.02 * H;
        ctx.beginPath();
        ctx.moveTo(s * 0.16 * H, -0.66 * H);
        ctx.lineTo(ax, ay);
        ctx.stroke();
        ctx.fillStyle = mix(col, '#ffffff', 0.15);
        ctx.beginPath();
        ctx.ellipse(ax, ay, 0.075 * H, 0.055 * H, s * 0.5, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(ax + s * 0.05 * H, ay - 0.03 * H);
        ctx.lineTo(ax + s * 0.13 * H, ay - 0.07 * H);
        ctx.lineTo(ax + s * 0.11 * H, ay + 0.01 * H);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = mix(col, '#000000', 0.25);
      ctx.lineWidth = 0.016 * H;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(0, -0.56 * H, (0.1 + i * 0.045) * H, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
    } else if (a === 'shark') {
      // 大背鳍 + 血盆大口 + 三道鳃裂
      ctx.fillStyle = mix(col, '#4a6b80', 0.5);
      ctx.beginPath();
      ctx.moveTo(-0.03 * H, headY - headR * 0.6);
      ctx.lineTo(0.02 * H, headY - headR * 3.6);
      ctx.lineTo(0.22 * H, headY - headR * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = mix(col, '#ffffff', 0.2);
      ctx.lineWidth = 0.012 * H;
      ctx.stroke();
      // 嘴（三排尖牙）
      const my = headY + headR * 0.42;
      ctx.fillStyle = '#f4f7fa';
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.moveTo(i * headR * 0.34 - headR * 0.1, my);
        ctx.lineTo(i * headR * 0.34, my - headR * 0.42);
        ctx.lineTo(i * headR * 0.34 + headR * 0.1, my);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = dark;
      ctx.lineWidth = 0.02 * H;
      for (const s of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(s * 0.06 * H, (-0.68 + i * 0.05) * H);
          ctx.lineTo(s * 0.1 * H, (-0.66 + i * 0.05) * H);
          ctx.stroke();
        }
      }
      // 尾鳍
      ctx.fillStyle = mix(col, '#4a6b80', 0.4);
      ctx.beginPath();
      ctx.moveTo(0, -0.36 * H);
      ctx.lineTo(-0.26 * H, -0.5 * H);
      ctx.lineTo(-0.2 * H, -0.3 * H);
      ctx.closePath();
      ctx.fill();
    } else if (a === 'puffer') {
      // 河豚刺（球形一圈刺）+ 鼓起来的头
      ctx.strokeStyle = mix(dark, '#ffffff', 0.25);
      ctx.lineWidth = 0.02 * H;
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * TAU;
        const cx = Math.cos(ang) * 0.19 * H;
        const cy = -0.55 * H + Math.sin(ang) * 0.16 * H;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx * 1.32, -0.55 * H + (cy + 0.55 * H) * 1.32);
        ctx.stroke();
      }
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * TAU;
        const cx = Math.cos(ang) * headR * 1.05;
        const cy = headY + Math.sin(ang) * headR * 1.05;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx * 1.5, headY + Math.sin(ang) * headR * 1.5);
        ctx.stroke();
      }
    } else if (a === 'turtle') {
      // 龟壳（盖住躯干）+ 两侧鳍肢
      ctx.fillStyle = mix(col, '#2f6b45', 0.55);
      ctx.beginPath();
      ctx.ellipse(0, -0.56 * H, 0.22 * H, 0.19 * H, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,50,35,0.85)';
      ctx.lineWidth = 0.016 * H;
      ctx.stroke();
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.ellipse(0, -0.56 * H, 0.2 * H, 0.17 * H, 0, (i / 4) * TAU, (i / 4) * TAU + 1.1);
        ctx.stroke();
      }
      ctx.fillStyle = mix(col, '#ffffff', 0.2);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * 0.26 * H, -0.42 * H, 0.09 * H, 0.04 * H, s * 0.4, 0, TAU);
        ctx.fill();
      }
    } else if (a === 'jelly') {
      // 水母伞盖（罩在头上）+ 六条长触手
      ctx.fillStyle = mix(col, '#ffffff', 0.22);
      ctx.beginPath();
      ctx.ellipse(0, headY - headR * 0.2, headR * 1.5, headR * 1.15, 0, Math.PI, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 0.012 * H;
      ctx.stroke();
      ctx.strokeStyle = mix(col, dark, 0.35);
      ctx.lineWidth = 0.028 * H;
      for (let i = 0; i < 6; i++) {
        const x0 = (-0.14 + i * 0.056) * H;
        ctx.beginPath();
        ctx.moveTo(x0, -0.30 * H);
        ctx.quadraticCurveTo(
          x0 + Math.sin(t + i * 1.3) * 0.05 * H,
          -0.16 * H,
          x0 + Math.sin(t + i * 1.3) * 0.09 * H,
          -0.02 * H
        );
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * 远处的僵尸（屏幕高 < 22px）只画这个：两条腿 + 一块躯干 + 一个头 + 两点眼睛。
   * 【用户 m02901 性能】一屏 40 只里通常有二十多只属于这一档，它们本来就只有
   * 十几个像素高，画全套细节是纯浪费 —— 剪影加红眼睛在这点尺寸上已经足够认出"是丧尸"。
   */
  _zombieSimple(ctx, H, col, dark, phase, kind, isWind) {
    const swing = Math.sin(phase) * 0.06 * H;
    const bob = Math.abs(Math.cos(phase)) * 0.016 * H;
    const hipY = -0.42 * H;
    const shY = -0.70 * H;
    const broad = kind === 'brute' || kind === 'boss';
    ctx.save();
    ctx.translate(0, -bob);
    // 腿
    ctx.strokeStyle = dark;
    ctx.lineWidth = (broad ? 0.13 : 0.105) * H;
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      const sw = swing * s;
      ctx.beginPath();
      ctx.moveTo(s * 0.03 * H, hipY);
      ctx.lineTo(s * 0.05 * H + sw, 0);
      ctx.stroke();
    }
    // 躯干（上宽下窄的一块，加圆角肩）
    const waist = (broad ? 0.36 : 0.3) * H;
    const shW = (broad ? 0.5 : 0.42) * H;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-shW * 0.5, shY + 0.02 * H);
    ctx.quadraticCurveTo(-shW * 0.2, shY - 0.09 * H, shW * 0.2, shY - 0.09 * H);
    ctx.quadraticCurveTo(shW * 0.5, shY + 0.02 * H, waist * 0.5, hipY + 0.02 * H);
    ctx.lineTo(-waist * 0.5, hipY + 0.02 * H);
    ctx.closePath();
    ctx.fill();
    // 手臂
    ctx.strokeStyle = col;
    ctx.lineWidth = (broad ? 0.12 : 0.095) * H;
    for (const s of [-1, 1]) {
      const sw = -swing * s;
      ctx.beginPath();
      ctx.moveTo(s * shW * 0.42, shY + 0.02 * H);
      ctx.lineTo(s * shW * 0.58 + sw, hipY + 0.02 * H);
      ctx.stroke();
    }
    // 头 + 两点红眼
    const headR = (broad ? 0.2 : 0.175) * H;
    const headY = shY - 0.12 * H;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(0, headY, headR * 0.92, headR, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = kind === 'brute' || kind === 'boss' ? '#ff3a1f' : isWind ? '#fff36b' : '#ff6a3d';
    ctx.beginPath();
    ctx.arc(-headR * 0.36, headY - headR * 0.08, Math.max(0.5, headR * 0.3), 0, TAU);
    ctx.arc(headR * 0.36, headY - headR * 0.08, Math.max(0.5, headR * 0.3), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** 在"脚底为原点、头在 -H"的局部坐标里画人形剪影 */
  _zombieBody(ctx, H, col, dark, phase, kind, isWind, seed = 0, lod = 2) {
    const swing = Math.sin(phase);
    const bob = Math.abs(Math.cos(phase)) * 0.016 * H; // 迈步时上下颠一点
    const hipY = -0.42 * H;
    const shY = -0.70 * H;
    const broad = kind === 'brute' || kind === 'boss';

    // 【用户 m02399】上一版是"硬朗黑描边"，整屏几十只叠在一起时会糊成一片黑。
    // 现在改柔：描边色用身体暗面的加深版（不是近黑），线也细一档，
    // 再补一层顶部受光 —— 靠"明暗 + 一点点轮廓"分开，而不是靠黑色包围线。
    const outline = mix(dark, col, 0.24); // 暗面再往身体色靠一点，别往黑里走
    const light = mix(col, '#ffffff', 0.34);
    const shade = mix(dark, '#000000', 0.18);
    const o = Math.max(0.5, H * 0.015);
    // 细节开关：屏幕高不到 30px 的丧尸（远处那一大堆）不画牙/头发/手指/血迹，
    // 反正看不清 —— 省下来的时间留给近处那几只。中低端手机上这一条最关键。
    // 【用户 m02901 性能】现在改成三档 LOD（由 _drawZombie 按屏幕高度传进来）：
    //   2 = 近处，全细节；1 = 中景，跳过 clip 明暗层 + 描边只走一遍；
    //   0 = 远景（<22px），走 _zombieSimple 的剪影画法（连这里都不进）。
    const detail = lod >= 2;
    // 中远景不画"先描边后填色"的第二遍，也不进 clip 铺明暗 —— 一屏 40 只时这是最大的一笔
    const fast = lod <= 1;
    // 稳定的伪随机：同一只僵尸每帧的"破洞位置/有没有头发"都一样，不会抖
    const rnd = (n) => {
      const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.save();
    ctx.translate(0, -bob);

    // 腿：屈膝 + 两遍走（先描边后填色），落地那条腿踩实、抬起那条腿向前甩
    const legs = [];
    for (const s of [-1, 1]) {
      const lift = s * swing;
      const footX = s * 0.085 * H - lift * 0.14 * H;
      const footY = -0.028 * H - Math.max(0, lift) * 0.05 * H;
      legs.push({ s, footX, footY, kneeX: footX * 0.5, kneeY: hipY * 0.54 });
    }
    const legW = (broad ? 0.132 : 0.108) * H;
    for (let pass = 0; pass < (fast ? 1 : 2); pass++) {
      ctx.strokeStyle = fast ? col : pass ? dark : outline;
      ctx.lineWidth = legW + (pass ? 0 : o * 2);
      for (const L of legs) {
        ctx.beginPath();
        ctx.moveTo(L.s * 0.03 * H, hipY);
        ctx.quadraticCurveTo(L.kneeX, L.kneeY, L.footX, L.footY);
        ctx.stroke();
      }
    }
    // 鞋
    for (const L of legs) {
      ctx.fillStyle = fast ? dark : outline;
      ctx.beginPath();
      ctx.ellipse(L.footX, L.footY + 0.012 * H, 0.06 * H + (fast ? 0 : o), 0.03 * H + (fast ? 0 : o * 0.6), 0, 0, TAU);
      ctx.fill();
      if (fast) continue;
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.ellipse(L.footX, L.footY + 0.012 * H, 0.06 * H, 0.03 * H, 0, 0, TAU);
      ctx.fill();
    }

    // 肩甲（壮汉/僵王肩更宽，加一块暗色垫肩把体型压出来）
    if (broad) {
      ctx.fillStyle = outline;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * 0.155 * H, shY + 0.015 * H, 0.085 * H, 0.062 * H, s * 0.3, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = shade;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * 0.15 * H, shY + 0.008 * H, 0.07 * H, 0.05 * H, s * 0.3, 0, TAU);
        ctx.fill();
      }
    }

    // 手臂：肘部弯一点、手往前伸（僵尸经典姿态），依然是"先描边后填色"
    const armW = (broad ? 0.096 : 0.078) * H;
    const arms = [];
    for (const s of [-1, 1]) {
      const raise = isWind ? 0.13 * H : 0;
      const handX = s * (0.205 + 0.045 * rnd(s > 0 ? 4.5 : 2.5)) * H + s * swing * 0.14 * H;
      const handY = -0.335 * H + Math.abs(swing) * 0.03 * H - raise;
      arms.push({
        s,
        shx: s * 0.135 * H,
        shy: shY + 0.025 * H,
        elbowX: s * 0.215 * H,
        elbowY: (shY + handY) * 0.5 + 0.01 * H,
        handX,
        handY,
      });
    }
    for (let pass = 0; pass < (fast ? 1 : 2); pass++) {
      ctx.strokeStyle = fast ? col : pass ? col : outline;
      ctx.lineWidth = armW + (pass ? 0 : o * 2);
      for (const A of arms) {
        ctx.beginPath();
        ctx.moveTo(A.shx, A.shy);
        ctx.quadraticCurveTo(A.elbowX, A.elbowY, A.handX, A.handY);
        ctx.stroke();
      }
    }
    // 手 + 几根手指
    for (const A of arms) {
      const hr = 0.037 * H;
      ctx.fillStyle = fast ? mix(col, '#ffffff', 0.14) : outline;
      ctx.beginPath();
      ctx.arc(A.handX, A.handY, hr + (fast ? 0 : o * 0.8), 0, TAU);
      ctx.fill();
      if (fast) continue;
      ctx.fillStyle = mix(col, '#ffffff', 0.14);
      ctx.beginPath();
      ctx.arc(A.handX, A.handY, hr, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = outline;
      ctx.lineWidth = Math.max(0.6, H * 0.013);
      if (detail) for (let f = -1; f <= 1; f++) {
        ctx.beginPath();
        ctx.moveTo(A.handX + f * hr * 0.42, A.handY + hr * 0.4);
        ctx.lineTo(A.handX + f * hr * 0.6, A.handY + hr * 1.35);
        ctx.stroke();
      }
    }
    // BOSS 多两条小手臂
    if (kind === 'boss') {
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass ? col : outline;
        ctx.lineWidth = 0.07 * H + (pass ? 0 : o * 2);
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * 0.12 * H, -0.52 * H);
          ctx.quadraticCurveTo(s * 0.26 * H, -0.5 * H, s * 0.3 * H, -0.44 * H + swing * 0.04 * H);
          ctx.stroke();
        }
      }
    }

    // 躯干：先描边、再填色，然后在 clip 里铺受光面 / 暗面 / 破洞
    const shoulder = (broad ? 0.205 : 0.172) * H;
    const waist = 0.142 * H;
    const torsoPath = () => {
      ctx.beginPath();
      ctx.moveTo(-waist * 0.94, hipY);
      ctx.quadraticCurveTo(-shoulder * 1.03, shY + 0.02 * H, -shoulder, shY);
      ctx.quadraticCurveTo(0, shY - 0.05 * H, shoulder, shY);
      ctx.quadraticCurveTo(shoulder * 1.03, shY + 0.02 * H, waist * 0.94, hipY);
      ctx.quadraticCurveTo(0, hipY + 0.035 * H, -waist * 0.94, hipY);
      ctx.closePath();
    };
    torsoPath();
    ctx.strokeStyle = outline;
    ctx.lineWidth = o * 2;
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.fill();
    if (!fast) {
    // 【用户 m08839 僵尸潮卡顿】原来这里用 save()+clip() 把明暗面裁进躯干，
    // 每只僵尸一个图层，30 只就是 30 层，Skia 攒到一定数量会整体 flush 一次
    // （实测周期性 250ms 尖峰，且随像素面积线性放大）。
    // 改成把明暗面画在躯干轮廓内侧一点点，效果肉眼看不出区别，但不产生图层。
    const shIn = shoulder * 0.97;
    // 受光面（左上到中间）
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.moveTo(-shIn, shY - 0.02 * H);
    ctx.lineTo(shoulder * 0.05, shY - 0.02 * H);
    ctx.lineTo(-shoulder * 0.12, hipY);
    ctx.lineTo(-shIn * 0.92, hipY);
    ctx.closePath();
    ctx.fill();
    // 暗面（右侧）
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.moveTo(shoulder * 0.36, shY - 0.02 * H);
    ctx.lineTo(shIn, shY - 0.02 * H);
    ctx.lineTo(shIn * 0.92, hipY);
    ctx.lineTo(shoulder * 0.2, hipY);
    ctx.closePath();
    ctx.fill();
    // 撕开的口子 + 衣服上的褶皱
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = outline;
    for (let i = 0; i < 3; i++) {
      const x = (-0.55 + rnd(3 + i) * 1.1) * waist;
      const y = hipY - 0.03 * H - rnd(8 + i) * 0.18 * H;
      ctx.beginPath();
      ctx.ellipse(x, y, 0.013 * H * (0.7 + rnd(12 + i)), 0.028 * H, 0, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = outline;
    ctx.lineWidth = Math.max(0.6, H * 0.011);
    ctx.beginPath();
    ctx.moveTo(-shoulder * 0.5, shY + 0.06 * H);
    ctx.quadraticCurveTo(-waist * 0.35, hipY - 0.12 * H, -waist * 0.1, hipY - 0.02 * H);
    ctx.stroke();
    ctx.globalAlpha = 1;
    }
    // 破衣服的下摆
    ctx.fillStyle = outline;
    ctx.beginPath();
    ctx.moveTo(-waist * 0.96, hipY - 0.045 * H);
    ctx.lineTo(waist * 0.96, hipY - 0.045 * H);
    ctx.lineTo(waist * 0.7, hipY + 0.035 * H);
    ctx.lineTo(0.02 * H, hipY + 0.005 * H);
    ctx.lineTo(-waist * 0.62, hipY + 0.04 * H);
    ctx.closePath();
    ctx.fill();

    // 头：脖子 → 描边 → 头骨 → 受光/暗面 → 嘴和牙 → 眼窝 → 头发 → 血迹
    const headY = -0.815 * H;
    const headR = 0.11 * H;
    // 脖子（免得头看着是飘在肩膀上的）
    ctx.fillStyle = outline;
    ctx.fillRect(-headR * 0.46, headY + headR * 0.2, headR * 0.92, H * 0.1);
    ctx.fillStyle = shade;
    ctx.fillRect(-headR * 0.36, headY + headR * 0.26, headR * 0.72, H * 0.09);
    // 头的描边层
    ctx.fillStyle = outline;
    ctx.beginPath();
    ctx.arc(0, headY, headR + o, 0, TAU);
    ctx.fill();
    // 头
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, TAU);
    ctx.fill();
    // 头顶受光
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.ellipse(-headR * 0.24, headY - headR * 0.34, headR * 0.58, headR * 0.4, -0.5, 0, TAU);
    ctx.fill();
    // 下颌 / 口部暗面
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(0.012 * H, headY + headR * 0.36, headR * 0.6, 0, TAU);
    ctx.fill();
    // 嘴：张着，露几颗牙（蓄力时张更大）
    const mopen = isWind ? 0.62 : 0.4;
    ctx.fillStyle = outline;
    ctx.beginPath();
    ctx.ellipse(0, headY + headR * (0.24 + mopen * 0.2), headR * 0.46, headR * (0.12 + mopen * 0.24), 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#efe6d0';
    if (detail) for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * headR * 0.24 - headR * 0.075, headY + headR * (0.16 + mopen * 0.1));
      ctx.lineTo(i * headR * 0.24 + headR * 0.075, headY + headR * (0.16 + mopen * 0.1));
      ctx.lineTo(i * headR * 0.24, headY + headR * (0.3 + mopen * 0.3));
      ctx.closePath();
      ctx.fill();
    }
    // 眼窝：先挖两个暗坑，眼睛才像陷在骨头里
    ctx.fillStyle = outline;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * headR * 0.42, headY - headR * 0.06, headR * 0.33, headR * 0.29, 0, 0, TAU);
      ctx.fill();
    }

    // 僵王的角（外黑内亮，看上去是硬的）
    if (kind === 'boss') {
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass ? mix(dark, '#ffffff', 0.25) : outline;
        ctx.lineWidth = 0.05 * H + (pass ? 0 : o * 1.4);
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * headR * 0.68, headY - headR * 0.5);
          ctx.quadraticCurveTo(s * headR * 1.5, headY - headR * 1.1, s * headR * 1.75, headY - headR * 1.85);
          ctx.stroke();
        }
      }
    }

    // 头发（有没有、朝哪边塌，靠 seed 决定 —— 同一只僵尸每帧都一样）
    if (detail && kind !== 'boss' && rnd(11) > 0.5) {
      const lean2 = rnd(3) > 0.5 ? 1 : -1;
      ctx.fillStyle = outline;
      ctx.beginPath();
      ctx.ellipse(0, headY - headR * 0.55, headR * 0.95, headR * 0.5, 0, Math.PI, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(
        lean2 * headR * 0.5,
        headY - headR * 0.78,
        headR * 0.42,
        headR * 0.3,
        lean2 * 0.5,
        0,
        TAU
      );
      ctx.fill();
    }

    // 眼睛（唯一的高饱和亮点，小屏上辨识度靠它）
    const eyeR = Math.max(0.6, headR * (kind === 'boss' ? 0.3 : 0.22));
    const eyeCol = kind === 'brute' || kind === 'boss' ? '#ff3a1f' : isWind ? '#fff36b' : '#ff6a3d';
    // 远处那一堆不画眼睛的光晕（每次都是一次贴图采样，40 只就是 80 次）
    if (detail) for (const s of [-1, 1]) {
      this._drawGlow(s * headR * 0.42, headY - headR * 0.06, eyeR * 3.6, eyeCol, 0.7);
    }
    ctx.fillStyle = eyeCol;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * headR * 0.42, headY - headR * 0.06, eyeR, 0, TAU);
      ctx.fill();
    }
    // 瞳孔：一个小暗点让眼神有方向
    if (detail) {
      ctx.fillStyle = 'rgba(20,0,0,0.55)';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * headR * 0.42, headY - headR * 0.06 + eyeR * 0.15, eyeR * 0.34, 0, TAU);
        ctx.fill();
      }
    }

    // 血迹：几滴甩在衣服/脸上
    ctx.fillStyle = mix('#7a1520', dark, 0.25);
    if (detail) for (let i = 0; i < 3; i++) {
      const bx = (rnd(21 + i) - 0.5) * waist * 1.5;
      const by = shY + 0.04 * H + rnd(31 + i) * 0.28 * H;
      ctx.beginPath();
      ctx.ellipse(bx, by, 0.012 * H * (0.8 + rnd(41 + i)), 0.02 * H, 0, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  // ---------------------------------------------------------
  //  英雄（背影视角的人形）
  //
  //  v1 是战车，用户反馈"把坦克换成英雄"。改成蓝色队的背影小人：
  //  头盔 + 背包 + 枪，腿按 pl.anim 摆，站姿微微前倾。
  // ---------------------------------------------------------

  /**
   * 【用户 m11792】花仙子脚下围一圈花。
   * 门禁和蝴蝶一样是两条：①当前出场的是花仙子 ②在第四关（fantasy 皮肤）——
   * 只是"选过花仙子"不算，必须真的在场上用她。
   */
  _fairyFlowerRing(ctx, game) {
    if (!game || game.heroId !== 'fairy') return;
    if (!CFG.level || CFG.level.skin !== 'fantasy') return;
    const pl = game.player;
    if (!pl) return;
    const p = this.cam.project(pl.x, pl.z);
    const H = Math.max(6, CFG.hero.size * p.s);
    const rx = H * 0.44;
    const ry = H * 0.15;
    const t = this.time;
    // 地面上的一圈暖粉光（很淡，只是让花有个落点）
    this._drawGlow(p.x, p.y + 1, rx * 1.5, 'rgba(255,168,214,0.5)', 0.34);
    const n = 12;
    // 【用户 m11916】"花是一朵一朵的"；【用户 m12738】"高度再高，每朵花高度不一样，最高到膝盖"。
    // 所以每朵单独定高：0.10~0.28H（膝盖约在 0.28H 上下），用序号做个稳定的伪随机，
    // 不随帧跳。茎长什么样、花头多大都跟着这把高度走。
    const list = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU + t * 0.28;
      const depth = Math.sin(ang); // -1 后 → +1 前
      const rnd = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const hMul = 0.10 + Math.abs(rnd) * 0.18; // 0.10H ~ 0.28H，各朵不同
      list.push({ i, ang, depth, hMul, x: p.x + Math.cos(ang) * rx, y: p.y + 2 + depth * ry });
    }
    list.sort((a, b) => a.depth - b.depth); // 后画的在前面：挡在她腿前的花要压住后面的
    for (const f of list) {
      const depth = f.depth;
      const sc = H * (0.019 + 0.011 * (depth + 1) * 0.5) * (0.9 + f.hMul * 2.2);
      const stemH = H * f.hMul; // 每朵自己的高度（最高到膝盖）
      const sway = Math.sin(t * 1.6 + f.i * 1.3) * 0.16;
      ctx.save();
      ctx.translate(f.x, f.y);
      // 茎：从地面往上，带一点弯
      ctx.strokeStyle = 'rgba(74,138,74,0.9)';
      ctx.lineWidth = Math.max(1, sc * 0.26);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(sway * sc * 3, -stemH * 0.55, sway * sc * 5, -stemH);
      ctx.stroke();
      // 一片叶子
      ctx.fillStyle = 'rgba(88,158,86,0.85)';
      ctx.beginPath();
      ctx.ellipse(sc * 0.9, -stemH * 0.42, sc * 0.75, sc * 0.34, -0.5 + sway, 0, TAU);
      ctx.fill();
      // 花头
      ctx.translate(sway * sc * 5, -stemH);
      ctx.rotate(sway * 0.6);
      for (let k = 0; k < 5; k++) {
        const pa = (k / 5) * TAU;
        ctx.fillStyle = k % 2 ? 'rgba(255,214,240,0.96)' : 'rgba(255,176,220,0.96)';
        ctx.beginPath();
        ctx.ellipse(Math.cos(pa) * sc * 0.6, Math.sin(pa) * sc * 0.44, sc * 0.52, sc * 0.36, pa, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,232,160,0.98)';
      ctx.beginPath();
      ctx.ellipse(0, 0, sc * 0.32, sc * 0.26, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  _drawHero(ctx, game) {
    const cam = this.cam;
    const pl = game.player;
    const p = cam.project(pl.x, pl.z);
    const S = p.s;
    const H = Math.max(6, CFG.hero.size * S);
    const feet = p.y;
    const sw = Math.sin(pl.anim) * pl.moving; // 迈腿相位

    // 手里的枪照亮前方桥面（原来战车的车灯）
    const far1 = cam.project(pl.x - 0.10, pl.z + 15);
    const far2 = cam.project(pl.x + 0.10, pl.z + 15);
    ctx.beginPath();
    ctx.moveTo(p.x - H * 0.10, feet - H * 0.55);
    ctx.lineTo(p.x + H * 0.10, feet - H * 0.55);
    ctx.lineTo(far2.x, far2.y);
    ctx.lineTo(far1.x, far1.y);
    ctx.closePath();
    const lg = ctx.createLinearGradient(0, feet - H, 0, far1.y);
    lg.addColorStop(0, 'rgba(255,238,190,0.15)');
    lg.addColorStop(1, 'rgba(255,238,190,0)');
    ctx.fillStyle = lg;
    ctx.fill();

    // 影子
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(p.x, feet + 1, H * 0.19, H * 0.055, 0, 0, TAU);
    ctx.fill();

    const rec = pl.recoil * H * 0.02;
    // 走一步颠一下，站住不动就不颠（背影视角下这一点点起伏就够"活"）
    const walkBob = pl.moving ? -Math.abs(Math.sin(pl.anim)) * H * 0.022 : 0;
    ctx.save();
    ctx.translate(p.x, feet - rec + walkBob);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 第二关（疯狂水世界）换成图片人物主角：照着参考图画的扁平大叔
    if (CFG.level.skin === 'ocean') {
      this._heroWater(ctx, H, sw, pl);
      ctx.restore();
      this._heroShieldAndFlash(ctx, game, p, feet, H);
      return;
    }

    // 第三关（疯狂草坪）主角是豌豆射手：弹道几条就几个头（用户 m02771）
    if (CFG.level.skin === 'pvz') {
      this._heroPlant(ctx, game, H, sw, pl);
      ctx.restore();
      this._heroShieldAndFlash(ctx, game, p, feet, H);
      return;
    }

    // 第四关（穿越异世界）主角按选中的角色切换（用户 m04749）：
    // 勇者挥剑（剑气）或花仙子挥魔法棒（魔法粒子）。game.heroId 由主界面「角色」写入。
    // 【用户 m06010】原来的手绘太简略 —— 现在直接用用户给的全身立绘贴图（hero-knight /
    // hero-fairy），贴图没加载好时退回手绘版兜底。
    if (CFG.level.skin === 'fantasy') {
      const id = game.heroId === 'fairy' ? 'fairy' : 'knight';
      const art = this._heroArt(id);
      if (art) this._heroSprite(ctx, game, H, pl, art, id);
      else if (id === 'fairy') this._heroFairy(ctx, H, sw, pl);
      else this._heroKnight(ctx, H, sw, pl);
      ctx.restore();
      this._heroShieldAndFlash(ctx, game, p, feet, H);
      return;
    }

    const DARK = '#16222f';
    const COAT = '#35618f';
    const COAT_D = '#1e3a56';
    const RIM = '#a8d8ff';
    // 【用户 m02399】原来是近黑的硬描边（'#080d14'），整屏看着发闷。
    // 现在描边色用"深一档的军服蓝"、线也细一档，靠 RIM 冷高光把轮廓托出来。
    const OL = '#1d2c40';
    const o = Math.max(0.5, H * 0.0125);

    // 腿 + 靴子（先描边后填色）
    const legW = H * 0.1;
    const legs = [];
    for (const s of [-1, 1]) {
      const fx = s * H * 0.065 + s * sw * H * 0.10;
      legs.push({ s, fx, fy: -H * 0.03 - Math.max(0, s * sw) * H * 0.035 });
    }
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? '#1d3149' : OL;
      ctx.lineWidth = legW + (pass ? 0 : o * 2);
      for (const L of legs) {
        ctx.beginPath();
        ctx.moveTo(L.s * H * 0.05, -H * 0.44);
        ctx.quadraticCurveTo(L.fx * 0.7, -H * 0.22, L.fx, L.fy);
        ctx.stroke();
      }
    }
    for (const L of legs) {
      ctx.fillStyle = OL;
      ctx.beginPath();
      ctx.ellipse(L.fx, L.fy + H * 0.012, H * 0.055 + o, H * 0.028 + o, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#16222f';
      ctx.beginPath();
      ctx.ellipse(L.fx, L.fy + H * 0.012, H * 0.055, H * 0.028, 0, 0, TAU);
      ctx.fill();
    }

    // 背包（背影视角最认得出来的部件）+ 两个推进器喷口
    roundRect(ctx, -H * 0.105, -H * 0.72, H * 0.21, H * 0.26, H * 0.05);
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 2;
    ctx.stroke();
    ctx.fillStyle = '#22384e';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,180,220,0.35)';
    ctx.lineWidth = Math.max(0.8, H * 0.012);
    ctx.stroke();
    // 喷口（呼吸式微亮，给背影一点"装备感"）
    const vent = 0.35 + 0.25 * Math.sin(this.time * 3.1);
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#0d1620';
      roundRect(ctx, s * H * 0.055 - H * 0.022, -H * 0.50, H * 0.044, H * 0.05, H * 0.014);
      ctx.fill();
      this._drawGlow(s * H * 0.055, -H * 0.475, H * 0.05, '#5fd0ff', vent * 0.5);
    }

    // 躯干
    const torso = () => {
      ctx.beginPath();
      ctx.moveTo(-H * 0.115, -H * 0.44);
      ctx.lineTo(-H * 0.13, -H * 0.74);
      ctx.lineTo(H * 0.13, -H * 0.74);
      ctx.lineTo(H * 0.115, -H * 0.44);
      ctx.closePath();
    };
    torso();
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 2;
    ctx.stroke();
    const cg = ctx.createLinearGradient(0, -H * 0.74, 0, -H * 0.42);
    cg.addColorStop(0, COAT);
    cg.addColorStop(1, COAT_D);
    ctx.fillStyle = cg;
    ctx.fill();
    // 右后侧的暗面（体积）
    ctx.save();
    torso();
    ctx.clip();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#0e2233';
    ctx.beginPath();
    ctx.moveTo(H * 0.03, -H * 0.76);
    ctx.lineTo(H * 0.16, -H * 0.76);
    ctx.lineTo(H * 0.16, -H * 0.42);
    ctx.lineTo(H * 0.02, -H * 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // 肩线高光
    ctx.strokeStyle = RIM;
    ctx.lineWidth = Math.max(1, H * 0.016);
    ctx.beginPath();
    ctx.moveTo(-H * 0.105, -H * 0.735);
    ctx.lineTo(H * 0.105, -H * 0.735);
    ctx.stroke();

    // 双臂：左手垂着，右手端枪（描边 + 肩甲圆点）
    const armW = H * 0.058;
    const armEnds = [
      { x1: -H * 0.115, y1: -H * 0.70, x2: -H * 0.175, y2: -H * 0.44 + sw * H * 0.03 },
      { x1: H * 0.115, y1: -H * 0.70, x2: H * 0.135, y2: -H * 0.52 },
    ];
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? COAT_D : OL;
      ctx.lineWidth = armW + (pass ? 0 : o * 2);
      for (const A of armEnds) {
        ctx.beginPath();
        ctx.moveTo(A.x1, A.y1);
        ctx.quadraticCurveTo((A.x1 + A.x2) / 2 - H * 0.02, (A.y1 + A.y2) / 2, A.x2, A.y2);
        ctx.stroke();
      }
    }

    // 枪：更长的枪身 + 瞄具 + 弹匣（朝前那截最亮，是"火力来源"）
    const gunY = -H * 0.52;
    ctx.fillStyle = OL;
    roundRect(ctx, H * 0.02, gunY - H * 0.028, H * 0.235 + o, H * 0.056 + o * 0.6, H * 0.02);
    ctx.fill();
    ctx.fillStyle = DARK;
    roundRect(ctx, H * 0.03, gunY - H * 0.020, H * 0.205, H * 0.040, H * 0.016);
    ctx.fill();
    ctx.fillStyle = 'rgba(150,180,200,0.4)';
    ctx.fillRect(H * 0.03, gunY - H * 0.020, H * 0.205, H * 0.011);
    // 瞄具
    ctx.fillStyle = '#0d131c';
    roundRect(ctx, H * 0.085, gunY - H * 0.048, H * 0.075, H * 0.024, H * 0.01);
    ctx.fill();
    // 弹匣
    ctx.fillStyle = '#101a26';
    roundRect(ctx, H * 0.055, gunY + H * 0.016, H * 0.035, H * 0.05, H * 0.012);
    ctx.fill();

    // 头 + 头盔
    const headY = -H * 0.845;
    const headR = H * 0.098;
    // 描边层
    ctx.fillStyle = OL;
    ctx.beginPath();
    ctx.arc(0, headY, headR + o, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#c9d6e2';
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, TAU);
    ctx.fill();
    // 后颈的阴影
    ctx.fillStyle = 'rgba(20,35,50,0.45)';
    ctx.beginPath();
    ctx.ellipse(0, headY + headR * 0.55, headR * 0.7, headR * 0.35, 0, 0, TAU);
    ctx.fill();
    // 头盔（盖住上半 + 后颈），先描边再填
    const helmet = () => {
      ctx.beginPath();
      ctx.arc(0, headY - headR * 0.08, headR * 1.12, Math.PI * 1.02, Math.PI * 1.98);
      ctx.lineTo(headR * 0.9, headY + headR * 0.25);
      ctx.lineTo(-headR * 0.9, headY + headR * 0.25);
      ctx.closePath();
    };
    helmet();
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 2;
    ctx.stroke();
    ctx.fillStyle = '#26405a';
    ctx.fill();
    // 头盔顶上的高光弧
    ctx.strokeStyle = 'rgba(168,216,255,0.55)';
    ctx.lineWidth = Math.max(0.7, H * 0.011);
    ctx.beginPath();
    ctx.arc(0, headY - headR * 0.08, headR * 1.12, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    // 头盔侧面的护目镜带
    ctx.fillStyle = '#0f1c2a';
    ctx.fillRect(-headR * 1.05, headY - headR * 0.22, headR * 2.1, headR * 0.3);
    // 头盔后灯 + 天线
    this._drawGlow(0, headY + headR * 0.05, headR * 0.5, '#7df9ff', 0.5);
    ctx.strokeStyle = OL;
    ctx.lineWidth = Math.max(0.7, H * 0.012);
    ctx.beginPath();
    ctx.moveTo(headR * 0.8, headY - headR * 0.78);
    ctx.lineTo(headR * 1.05, headY - headR * 1.2);
    ctx.stroke();
    this._drawGlow(headR * 1.05, headY - headR * 1.2, headR * 0.2, '#ff5a4a', 0.7 + 0.3 * Math.sin(this.time * 6));

    // 枪口火光：中心白热 + 星芒，后坐力越大越猛
    if (pl.muzzle > 0) {
      const mx = H * 0.255;
      const mr = H * (0.10 + pl.muzzle * 0.18);
      this._drawGlow(mx, gunY, mr * 1.6, '#ff8a3c', pl.muzzle * 0.8);
      this._drawGlow(mx, gunY, mr, '#ffc86a', pl.muzzle);
      this._drawGlow(mx, gunY, mr * 0.42, '#fff6e2', pl.muzzle);
      // 【用户 m02399】再往脚下铺一摊枪火反光：开火时地面被照亮，画面更"燃"
      this._drawGlow(mx * 0.7, 0, mr * 3.2, '#ff9a4a', pl.muzzle * 0.3);
      ctx.strokeStyle = `rgba(255,236,180,${0.75 * pl.muzzle})`;
      ctx.lineWidth = Math.max(0.8, H * 0.012);
      for (let i = 0; i < 3; i++) {
        const a = i * (Math.PI * 2 / 3) + Math.PI * 0.35;
        ctx.beginPath();
        ctx.moveTo(mx + Math.cos(a) * mr * 0.45, gunY + Math.sin(a) * mr * 0.45);
        ctx.lineTo(mx + Math.cos(a) * mr * 1.3, gunY + Math.sin(a) * mr * 1.3);
        ctx.stroke();
      }
    }

    ctx.restore();
    this._heroShieldAndFlash(ctx, game, p, feet, H);
  }

  /**
   * 第三关主角：豌豆射手（用户 m02771）。
   * 弹道几条就画几个头 —— 1 条是豌豆射手，2 条双发射手，3 条三线射手……
   * 每个头的颜色跟着**自己那条弹道的属性**走（绿 / 寒冰蓝 / 炎火橙），
   * 所以吃到"寒冰弹道"时，玩家能直接看见某一个头变蓝了，一眼知道哪条线变了。
   */
  /**
   * 第四关主角的立绘贴图（用户 m06010：角色模型要精致精美，用给的全身图）。
   * 懒加载 + 记忆化：第一帧就开始加载，加载好之前先用手绘版顶着。
   */
  _heroArt(id, file) {
    if (typeof Image === 'undefined') return null; // 冒烟测试的 document 桩里没有 Image
    this._arts = this._arts || {};
    let rec = this._arts[id];
    if (!rec) {
      rec = this._arts[id] = { img: null, ok: false, decoding: false };
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => {
        // 【用户 m08143：勇者偶尔没贴图只剩脚下光环】只在 onload 时置 ok 还不够：
        // 图已经 load 完但还没 decode 完的那几帧，drawImage 会画不出东西，
        // 而烘焙缓存一旦把这"空的一帧"烘进去就会一直空着。所以必须等 decode()。
        if (!(im.naturalWidth > 0) || !(im.naturalHeight > 0)) return;
        if (typeof im.decode === 'function') {
          if (rec.decoding) return;
          rec.decoding = true;
          im.decode().then(
            () => { rec.ok = true; },
            () => { rec.ok = true; }, // decode 失败也放行，交给下面的尺寸兜底
          );
        } else {
          rec.ok = true;
        }
      };
      // file 可以让同一套解码/守卫逻辑复用到「立绘分层」那两张图上
      im.src = `./img/${file || `hero-${id}`}.webp`;
      rec.img = im;
    }
    if (!rec.ok) return null;
    const im = rec.img;
    if (!im || !(im.width > 0) || !(im.height > 0)) return null;
    return im;
  }

  /**
   * 立绘贴图版主角。贴图是「正面站立」的全身图，让它活起来的办法：
   * 呼吸缩放 + 走动侧倾 + 开火前倾 + 脚下暖光 + 挥击时一层加色辉光；
   * 花仙子额外撒几颗漂浮的魔法火花（用户 m04749：偏少女风格特效）。
   *
   * 锚点说明：贴图裁出来的矩形包含剑尖/裙摆，人物真正踩地的那条线在高度
   * 的 95.5% 处（量过：勇者 0.961、花仙子 0.941），所以底边要往下压一点点。
   */
  _heroSprite(ctx, game, H, pl, art, id) {
    const ANCHOR = 0.955;
    if (!art || !(art.width > 0) || !(art.height > 0)) return;
    if (!Number.isFinite(H) || H <= 0) return;
    const swing = Math.min(1, pl.muzzle * 3.4);
    // 【用户 m09695】"攻击时法杖要亮光"：光要有"蓄力→出手"的形状，不能只是常亮。
    // 开火后 game.weapon.cd 从满值往回数，charge 0→1 就是这一发的蓄力进度；
    // 出手那一刻由 pl.muzzle 的爆闪接管（两者在绘制时取大）。
    const wp = game && game.weapon;
    let charge = 0;
    if (wp && Number.isFinite(wp.cd) && wp.cd > 0) {
      const full = Math.max(0.06, (wp.interval || 0.3) / (wp.rateMul || 1));
      charge = clamp(1 - wp.cd / full, 0, 1);
    }
    const step = pl.moving ? Math.sin(pl.anim) : 0;
    const breathe = 1 + Math.sin(this.time * 3.1) * 0.008;
    // 【用户 m06896】"老是卡顿"的一个源头就在这三行：
    // 烘焙缓存是按"量化后的高度"取键的，基准高度里一旦含 breathe，
    // 档位会随呼吸在相邻两格之间来回跳 → 每几帧就重烘一张 canvas（可见的顿一下）。
    // 所以烘图只用**不含呼吸**的固定基准，呼吸和挥击都放到逐帧 blit 的 k = h / baked.base 里。
    const hBase = H * 1.12;
    const h = hBase * breathe * (1 + swing * 0.05);
    const w = h * (art.width / art.height);
    const lean = step * 0.05 * pl.moving + swing * -0.07;

    // 脚下一圈暖光：把"照片感"的立绘压进这个手绘夜景里
    const g = ctx.createRadialGradient(0, -H * 0.05, 0, 0, -H * 0.05, H * 0.52);
    g.addColorStop(0, 'rgba(255, 228, 176, 0.26)');
    g.addColorStop(1, 'rgba(255, 228, 176, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, -H * 0.05, H * 0.44, H * 0.5, 0, 0, TAU);
    ctx.fill();

    // 花仙子：身边飘几颗星星（不用状态，纯按时间算，停帧也稳）
    if (id === 'fairy') {
      for (let i = 0; i < 5; i++) {
        const t = this.time * 0.55 + i * 1.9;
        const sx = Math.sin(t) * H * 0.36;
        const sy = -H * (0.14 + ((t * 0.27 + i * 0.31) % 1) * 0.86);
        const r = H * (0.016 + 0.012 * (0.5 + 0.5 * Math.sin(t * 2.3)));
        const a = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.7));
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a;
        ctx.fillStyle = i % 2 ? '#ffd0f0' : '#fff6ff';
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = a * 0.5;
        ctx.fillStyle = '#ff9ad8';
        ctx.beginPath();
        ctx.arc(sx, sy, r * 2.1, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.save();
    ctx.rotate(lean);
    // 【用户 m09695 挥剑 A 档】出手瞬间整体往前"送"一点（往下沉 + 上移），
    // 动作的读感来自重心与刀光，不靠改原画。
    if (swing > 0.02) ctx.translate(0, -h * 0.028 * swing);
    // 开火瞬间补一层暖辉（比逐帧重采样两张全身图便宜得多）
    if (swing > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this._drawGlow(0, -h * 0.56, h * 0.4, id === 'fairy' ? '#ff9ad8' : '#7fd4ff', 0.26 * swing);
      ctx.restore();
    }
    // 【用户 m09695 翅膀扇动】花仙子走「身体 + 翅膀」两层，**画序一定是身体在底、翅膀在顶**：
    // ① 静止姿态：翅膀层在原掩膜位置里就是原图像素，盖在身体上 = 和原图一模一样；
    // ② 扇动时：翅膀转开让出的那条缝里，露出的是身体层同一片翅膀的浓模糊（同色系粉色，
    //    看着像运动残影），不是背景黑洞、也不是灰雾。
    // 反过来先画翅膀就会出问题：身体层虽然 alpha 不变，但翅膀区域的 RGB 被填成了粉色，
    // 盖在翅膀上 = 翅膀整个被盖掉（踩过一次，别再来）。
    // 分层图没到位（老版本缓存 / 只下到了整图）就退回单张，绝不能把人弄丢。
    const wingArt = id === 'fairy' ? this._heroArt('fairy-wings', 'hero-fairy-wings') : null;
    const bodyArt = wingArt && id === 'fairy' ? this._heroArt('fairy-body', 'hero-fairy-body') : null;
    // 逐帧把 427×640 的立绘重采样到屏幕尺寸太贵（CPU 光栅化下实测 +18ms/帧），
    // 所以按尺寸烘一张缓存图（含边缘光），正常帧只做一次小尺寸 blit。
    // 键里带 :body，免得"整图烘出来的缓存"被"分层后的身体"复用（反之亦然）
    const baked = this._heroBake(bodyArt ? `${id}:body` : id, bodyArt || art, hBase);
    if (baked && Number.isFinite(baked.base) && baked.base > 0) {
      const k = h / baked.base;
      ctx.drawImage(baked.cv, -baked.w * k / 2, -h * ANCHOR - baked.pad * k, baked.w * k, baked.h * k);
    } else {
      // 烘焙不可用（尺寸异常 / 画布没拿到 2d 上下文）时直接放大贴一次，
      // 绝不能因为烘图失败把整个人物弄丢（用户 m08143 报的就是"只剩脚下光环"）。
      ctx.drawImage(art, -w / 2, -h * ANCHOR, w, h);
    }
    if (wingArt) {
      // 翅根归一化位置跟着 m10551 的新立绘（1024×1536）重新量的：左 (0.420,0.235) / 右 (0.630,0.235)
      const pivotY = -h * ANCHOR + h * 0.235;
      const flap = Math.sin(this.time * 5.6);
      // ±6.3°：翅膀很大，角度再大就会露出手背那条"让开的缝"（缝里是身体层的粉色残影，
      // 幅度小的时候它读作运动模糊，幅度大就读作糊了）
      const ang = flap * 0.11;
      for (const side of [0, 1]) {
        const fx = side ? 0.630 : 0.420;
        const pieceX = -w / 2 + fx * w;
        const pieceLeft = -w / 2 + (side ? 0.5 : 0) * w;
        const bakedW = this._heroBake(`fairy:wing${side}`, wingArt, hBase,
          { fx0: side ? 0.5 : 0, fx1: side ? 1 : 0.5 });
        if (!bakedW || !(bakedW.base > 0)) continue;
        const k = h / bakedW.base;
        const dx = pieceLeft - bakedW.pad * k;
        const dy = -h * ANCHOR - bakedW.pad * k;
        const pw = bakedW.w * k;
        const ph = bakedW.h * k;
        const rot = side ? -ang : ang; // 左右镜像：同时张开/同时收
        // 拖影：同一片翅膀按"上一时刻的角度"再贴一次，把让开的那条缝用翅膀自己的像素补上
        // （比露粉色残影更像真扇动，代价只是多一次小 blit）
        ctx.save();
        ctx.globalAlpha = 0.32;
        ctx.translate(pieceX, pivotY);
        ctx.rotate(rot * 1.40);
        ctx.translate(-pieceX, -pivotY);
        ctx.drawImage(bakedW.cv, dx, dy, pw, ph);
        ctx.restore();
        ctx.save();
        ctx.translate(pieceX, pivotY);
        ctx.rotate(rot);
        ctx.translate(-pieceX, -pivotY);
        ctx.drawImage(bakedW.cv, dx, dy, pw, ph);
        ctx.restore();
      }
    }
    // 【用户 m09695】花仙子的法杖光压在立绘之上（加色），蓄力时杖头一点点亮起来，
    // 出手瞬间爆一下 —— 立绘本身一个像素都不用改。
    if (id === 'fairy') this._heroWandGlow(ctx, h, swing, charge);
    else if (swing > 0.02) this._heroSlash(ctx, h, swing);
    ctx.restore();
  }

  /**
   * 【用户 m09695 挥剑 · A 档】纯 VFX 的"挥剑"：立绘一张图都不动，
   * 靠剑尖沿剑身甩出的速度拖尾 + 重心前送，把"挥了"读出来。
   *
   * 几何量自 hero-knight.webp（640×960）：
   *   柄 (0.31, 0.49)、尖 (0.72, 0.925) → 换算到"脚踏原点、上为负"的局部坐标：
   *   柄 (-0.127h, -0.465h)、尖 (+0.147h, -0.030h) → 半径 0.514h、起始角 ≈ 57.8°。
   */
  _heroSlash(ctx, h, swing) {
    // 两层：前一层贴着剑身（当前这一挥），后一层往回摆一截（刚划过的路径）——
    // 只看一层像一根白线，两层叠起来才是"挥"的读感。
    this._heroSlashTrail(ctx, h, swing, (swing - 0.5) * 0.22, 1);
    this._heroSlashTrail(ctx, h, swing, -0.20 * swing - 0.04, 0.38);
  }

  _heroSlashTrail(ctx, h, swing, rot, k) {
    const hx = -0.127 * h;
    const hy = -0.465 * h;
    const r = 0.514 * h;
    const a0 = (57.8 * Math.PI) / 180; // 立绘里那把剑自己指的方向
    const dx = Math.cos(a0);
    const dy = Math.sin(a0);
    const pxs = -dy; // 垂直方向
    const pys = dx;
    const reach = 1.02 + 0.34 * swing; // 剑尖再往外甩一点
    const x0 = hx + dx * r * 0.18;
    const y0 = hy + dy * r * 0.18;
    const x1 = hx + dx * r * reach;
    const y1 = hy + dy * r * reach;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const wide = h * (0.046 + 0.078 * swing) * (k > 0.6 ? 1 : 1.3); // 月牙最宽处
    const a = Math.min(1, swing * 1.2) * k;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(hx, hy);
    ctx.rotate(rot);
    ctx.translate(-hx, -hy);
    const g2 = ctx.createLinearGradient(x0, y0, x1, y1);
    g2.addColorStop(0, 'rgba(150,200,255,0)');
    g2.addColorStop(0.42, `rgba(190,226,255,${(a * 0.34).toFixed(3)})`);
    g2.addColorStop(0.82, `rgba(238,248,255,${(a * 0.8).toFixed(3)})`);
    g2.addColorStop(1, `rgba(255,255,255,${Math.min(1, a * 1.05).toFixed(3)})`);
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(mx + pxs * wide, my + pys * wide, x1, y1);
    ctx.quadraticCurveTo(mx + pxs * wide * 0.22, my + pys * wide * 0.22, x0, y0);
    ctx.closePath();
    ctx.fill();
    // 刀尖那一下最亮，另加一团光晕
    if (k > 0.6) this._drawGlow(x1, y1, h * 0.2, '#eaf6ff', a * 0.75);
    ctx.restore();
  }

  /**
   * 【用户 m09695】"攻击时法杖要亮光"。
   * 坐标是从 639×960 的立绘里量出来的（法杖头在归一化 (0.105, 0.175) 处），
   * 换算到"脚底为原点、向上为负"的局部坐标后，和立绘一起受 lean 旋转影响。
   * 全程只有加色贴图 + 小圆点，每帧 5~7 次 drawImage，不新建渐变。
   */
  _heroWandGlow(ctx, h, swing, charge) {
    const RATIO = 1024 / 1536; // 立绘宽高比（用户 m10551 换的 1024×1536 新图）
    const wx = (0.100 - 0.5) * h * RATIO;   // 新图杖头中心 ≈ (0.100, 0.145)
    const wy = h * (0.145 - 0.955);
    // 蓄力和出手都推亮度；再加一条 6.4Hz 的微弱脉动，看起来像"活着的光"
    const lvl = Math.min(1, Math.max(charge, swing));
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 6.4);
    const a = clamp(0.16 + 0.62 * lvl + 0.06 * pulse, 0, 1);

    // 外晕 → 中晕 → 核心（三层，核心小、外晕大而淡）
    this._drawGlow(wx, wy, h * (0.17 + 0.06 * lvl), '#ff8ad8', a * 0.62);
    this._drawGlow(wx, wy, h * (0.075 + 0.02 * lvl), '#ffd0f2', a * 0.85);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#fff4ff';
    ctx.globalAlpha = clamp(0.45 + 0.5 * lvl, 0, 1);
    ctx.beginPath();
    ctx.arc(wx, wy, Math.max(1.1, h * (0.011 + 0.006 * lvl)), 0, TAU);
    ctx.fill();

    // 出手爆闪：一圈扩开的环 + 一下大范围暖光
    if (swing > 0.02) {
      const k = 1 - swing; // 0 → 刚出手，1 → 淡完
      ctx.strokeStyle = `rgba(255,196,242,${(0.55 * swing).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, h * 0.013 * swing);
      ctx.beginPath();
      ctx.arc(wx, wy, h * (0.09 + 0.26 * k), 0, TAU);
      ctx.stroke();
      ctx.restore();
      this._drawGlow(wx, wy, h * 0.46, '#ffb6ec', 0.30 * swing);
    } else {
      ctx.restore();
    }

    // 地面光池：杖光真的照到脚边的桥面（压扁的加色光斑）
    if (lvl > 0.12) {
      ctx.save();
      ctx.translate(0, -h * 0.012);
      ctx.scale(1, 0.26);
      this._drawGlow(0, 0, h * (0.34 + 0.12 * lvl), '#ff9ae0', 0.10 + 0.20 * lvl);
      ctx.restore();
    }

    // 杖头往上飘的光粒（纯按时间算，停帧也稳）
    for (let i = 0; i < 4; i++) {
      const t = this.time * (0.75 + 0.10 * i) + i * 1.7;
      const up = (t * 0.42 + i * 0.27) % 1;
      const px = wx + Math.sin(t * 1.9) * h * 0.05;
      const py = wy + h * 0.015 - up * h * 0.30;
      this._drawGlow(px, py, h * (0.017 + 0.010 * (1 - up)), i % 2 ? '#ffc8ef' : '#fff8ff', (1 - up) * (0.20 + 0.45 * lvl));
    }
  }

  /**
   * 【用户 m09695】"周围时不时飞出几只蝴蝶"。
   * 纯程序化：零素材、零加载、零状态 —— 全部由 this.time 推出来，停帧/回放都稳。
   * 三只各有 11~16 秒的出场周期，每次横穿桥面 6 秒左右，其余时间不画。
   */
  _drawButterflies(ctx, game) {
    // 【用户 m10372】"蝴蝶是和花仙子绑定的，换英雄了就没有"
    // 【用户 m11011】补一条：光是"选了花仙子"不够，**必须她真在场上**。
    // 前三关用的是原版主角（蓝衣英雄/戴夫），花仙子只在第四关（fantasy 皮肤）登场，
    // 所以判定要跟 _drawHero 的分支条件一模一样，否则前三关会凭空飘蝴蝶。
    if (!game || game.heroId !== 'fairy') return;
    if (!CFG.level || CFG.level.skin !== 'fantasy') return;
    const cam = this.cam;
    const t = this.time;
    const fantasy = CFG.level.skin === 'fantasy';
    for (let i = 0; i < 3; i++) {
      const period = 11 + i * 2.6;
      const u = (t + i * 3.9) % period;
      const flight = period * 0.55; // 每次出场飞这么久，剩下时间不出场
      if (u > flight) continue;
      const k = u / flight; // 0→1 横穿进度
      // 桥面中心在 x=0 附近，路面半宽约 0.5 世界单位；蝴蝶只在这条带子里飞
      const z = 10 + i * 4.5 + Math.sin(t * 0.7 + i) * 1.4;
      const x = -0.46 + k * 0.92 + Math.sin(t * 1.3 + i * 2.1) * 0.07;
      const p = cam.project(x, z);
      if (!(p.s > 0) || p.y > this.h || p.y < -40) continue;
      const hgt = 0.12 + 0.07 * Math.sin(t * 0.9 + i * 1.7); // 离桥面高度（世界单位）
      const y = p.y - hgt * p.s;
      const r = Math.max(2.4, 0.024 * p.s);
      const flap = 0.16 + 0.84 * Math.abs(Math.sin(t * 9.5 + i * 2.3));
      const fade = Math.min(1, Math.min(k, 1 - k) * 5); // 出场淡入、走远淡出
      const col = fantasy
        ? (i % 2 ? '#ffc2e2' : '#ffe9a8')
        : (i % 2 ? '#cfe6ff' : '#ffd9a8');
      this._butterfly(ctx, p.x, y, r, flap, col, 0.82 * fade);
    }
  }

  /** 一只蝴蝶：两对椭圆翅（上翅大、下翅小）绕身体中轴做 scaleX 挤压 = 扇翅。 */
  _butterfly(ctx, x, y, r, flap, col, alpha) {
    if (!(alpha > 0.01)) return;
    const a = clamp(alpha, 0, 1);
    // 身后一层极淡的加法雾：远处自然消失，近处才看得见"它自己在发光"
    this._drawGlow(x, y, r * 2.4, col, 0.13 * a);
    ctx.save();
    ctx.globalAlpha = a;
    const squash = 0.26 + 0.74 * flap;
    const rim = 'rgba(74,44,64,0.55)';
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s * squash, 1);
      // 上翅
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.ellipse(r * 0.66, -r * 0.42, r * 0.72, r * 0.54, -0.46, 0, TAU);
      ctx.fill();
      ctx.lineWidth = Math.max(0.5, r * 0.075);
      ctx.strokeStyle = rim;
      ctx.stroke();
      // 下翅（比上翅小一圈、更靠中间）
      ctx.globalAlpha = a * 0.86;
      ctx.beginPath();
      ctx.ellipse(r * 0.44, r * 0.40, r * 0.46, r * 0.38, 0.40, 0, TAU);
      ctx.fill();
      ctx.stroke();
      // 翅根一点暖色高光，让"两片翅膀"读得出来
      ctx.globalAlpha = a * 0.9;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.beginPath();
      ctx.ellipse(r * 0.22, -r * 0.16, r * 0.20, r * 0.16, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    // 身体
    ctx.globalAlpha = a * 0.95;
    ctx.fillStyle = 'rgba(56,38,52,0.95)';
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.7, r * 0.115), r * 0.46, 0, 0, TAU);
    ctx.fill();
    // 触角（太小就不画，免得糊成一团黑点）
    if (r > 4) {
      ctx.strokeStyle = `rgba(56,38,52,${(a * 0.85).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.6, r * 0.055);
      ctx.beginPath();
      ctx.moveTo(x - r * 0.04, y - r * 0.42);
      ctx.quadraticCurveTo(x - r * 0.30, y - r * 0.80, x - r * 0.44, y - r * 0.94);
      ctx.moveTo(x + r * 0.04, y - r * 0.42);
      ctx.quadraticCurveTo(x + r * 0.30, y - r * 0.80, x + r * 0.44, y - r * 0.94);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 把立绘烘成"屏幕尺寸 + 边缘光"的缓存画布。
   * 高度按 4px 量化、且**同一张画布复用**（每帧 new 一个 canvas 会被重烘拖死）；
   * 只有尺寸档位变化（或换角色）时才重烘一次。
   */
  /**
   * 把立绘烘成"屏幕尺寸 + 边缘光"的缓存画布。
   * 高度按 4px 量化、且**同一张画布复用**（每帧 new 一个 canvas 会被重烘拖死）；
   * 只有尺寸档位变化（或换角色）时才重烘一次。
   *
   * 【用户 m09695 翅膀扇动】一张图变成了三块缓存：身体 + 左翅 + 右翅。
   * 翅根是各自的旋转轴，所以两片翅膀必须分开烘（crop = 只烘画面左半/右半）。
   * 缓存按 key 存成一张表，键里带 crop 档位，互不踢对方。
   */
  _heroBake(key, art, h, crop) {
    if (!art || !(art.width > 0) || !(art.height > 0)) return null;
    if (!Number.isFinite(h) || h <= 0) return null;
    const fx0 = crop ? crop.fx0 : 0;
    const fx1 = crop ? crop.fx1 : 1;
    const ck = `${key}|${Math.round(h / 4)}|${fx0.toFixed(3)}`;
    this._heroBaked = this._heroBaked || {};
    // 只有"烘成功过"的缓存才复用它（rec.ok）：否则一次 NaN/空图会把整个人物永久烘没
    const hit = this._heroBaked[ck];
    if (hit && hit.ok) return hit;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    // 【用户 m07770：贴图太糊】烘图必须按**设备像素**（h × dpr）来烘。
    // 以前按 CSS 像素烘一张 230px 高的画布，再被主画布（已经 setTransform(dpr)）
    // 以 230 CSS px 贴回去 —— 手机 DPR=2 时等于把 230px 的图放大到 460px，糊掉一倍。
    const dp = this.dpr && this.dpr > 0 ? this.dpr : 1;
    const ratio = art.width / art.height;
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    const hh = Math.max(2, Math.round(h * dp));
    const ww = Math.max(2, Math.round(hh * ratio * (fx1 - fx0)));
    if (!Number.isFinite(hh) || !Number.isFinite(ww)) return null;
    const pad = Math.max(2, Math.ceil(hh * 0.045));
    let rec = this._heroBaked[ck];
    if (!rec || !rec.cv) {
      const cv = document.createElement('canvas');
      rec = this._heroBaked[ck] = { key: ck, cv, w: 0, h: 0, pad: 0, base: 0, ok: false };
    }
    rec.ok = false; // 先降级，画完确认没问题再置回 true
    try {
      rec.cv.width = ww + pad * 2;
      rec.cv.height = hh + pad * 2;
    } catch {
      return null;
    }
    if (!(rec.cv.width > 0) || !(rec.cv.height > 0)) return null;
    const gg = typeof rec.cv.getContext === 'function' ? rec.cv.getContext('2d') : null;
    if (!gg) return null;
    if ('imageSmoothingQuality' in gg) gg.imageSmoothingQuality = 'high';
    const sx = fx0 * art.width;
    const sw = (fx1 - fx0) * art.width;
    try {
      // 边缘光只给身体：翅膀是半透明的，加边缘光会把它糊成一团
      if (!crop) {
        // 先垫一圈微微放大的加色副本 → 边缘光（夜景里立绘不至于像贴纸）
        gg.globalCompositeOperation = 'lighter';
        gg.globalAlpha = 0.16;
        const rw = Math.round(ww * 1.04);
        const rh = Math.round(hh * 1.04);
        gg.drawImage(art, pad + (ww - rw) / 2, pad + (hh - rh) / 2, rw, rh);
      }
      gg.globalCompositeOperation = 'source-over';
      gg.globalAlpha = 1;
      gg.drawImage(art, sx, 0, sw, art.height, pad, pad, ww, hh);
    } catch {
      gg.globalCompositeOperation = 'source-over';
      gg.globalAlpha = 1;
      return null; // 画不进去就别缓存（下一帧会重新烘）
    }
    rec.key = ck;
    // 对外一律用 CSS 尺寸（主画布已经按 dpr 缩放），内部画布是 dpr 倍分辨率
    rec.w = (ww + pad * 2) / dp;
    rec.h = (hh + pad * 2) / dp;
    rec.pad = pad / dp;
    rec.base = hh / dp;
    if (!Number.isFinite(rec.base) || rec.base <= 0) return null;
    rec.ok = true;
    return rec;
  }

  /**
   * 第四关主角之一：勇者（用户 m04749：默认勇者挥剑，攻击是剑气冲击波）。
   * 背影视角：看到的是披风、头盔和右手的剑；开枪（pl.muzzle）时剑往前挥，
   * 剑刃后面拖一道月牙形的剑气 —— 子弹本身也由 _drawBullet 画成月牙。
   * （立绘贴图加载好之后走 _heroSprite，这个手绘版是兜底。）
   */
  _heroKnight(ctx, H, sw, pl) {
    const OL = '#232c3a';
    const o = Math.max(0.5, H * 0.0125);
    const STEEL = '#cbd7e6';
    const STEEL_D = '#8b9bb2';
    const CLOAK = '#3163ad';
    const CLOAK_D = '#1e3d70';
    const GOLD = '#e9d79a';
    const swing = Math.min(1, pl.muzzle * 3.4); // 开枪后的一小段挥剑进度（1 → 0）

    // ---- 腿 + 铁靴 ----
    const legW = H * 0.095;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? '#2a3f52' : OL;
      ctx.lineWidth = legW + (pass ? 0 : o * 2);
      for (const s of [-1, 1]) {
        const fx = s * H * 0.07 + s * sw * H * 0.09;
        ctx.beginPath();
        ctx.moveTo(s * H * 0.055, -H * 0.42);
        ctx.quadraticCurveTo(fx * 0.7, -H * 0.22, fx, -H * 0.035);
        ctx.stroke();
      }
    }
    for (const s of [-1, 1]) {
      const fx = s * H * 0.07 + s * sw * H * 0.09;
      ctx.fillStyle = STEEL_D;
      ctx.beginPath();
      ctx.ellipse(fx, -H * 0.024, H * 0.056, H * 0.03, 0, 0, TAU);
      ctx.fill();
    }

    // ---- 披风（背影上最显眼的一块）----
    const flare = 0.16 + (pl.moving ? Math.abs(Math.sin(pl.anim)) * 0.03 : 0);
    ctx.beginPath();
    ctx.moveTo(-H * 0.14, -H * 0.74);
    ctx.quadraticCurveTo(-H * (0.14 + flare), -H * 0.42, -H * 0.13, -H * 0.2);
    ctx.lineTo(H * 0.13, -H * 0.2);
    ctx.quadraticCurveTo(H * (0.14 + flare), -H * 0.42, H * 0.14, -H * 0.74);
    ctx.closePath();
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 2;
    ctx.stroke();
    const cg = ctx.createLinearGradient(0, -H * 0.74, 0, -H * 0.2);
    cg.addColorStop(0, CLOAK);
    cg.addColorStop(1, CLOAK_D);
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = Math.max(0.8, H * 0.012);
    ctx.beginPath();
    ctx.moveTo(-H * 0.13, -H * 0.22);
    ctx.lineTo(H * 0.13, -H * 0.22);
    ctx.stroke();

    // ---- 胸甲（披风上端露出来的一截）----
    roundRect(ctx, -H * 0.115, -H * 0.78, H * 0.23, H * 0.22, H * 0.04);
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 2;
    ctx.stroke();
    ctx.fillStyle = STEEL;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = Math.max(0.7, H * 0.01);
    ctx.beginPath();
    ctx.moveTo(-H * 0.08, -H * 0.74);
    ctx.lineTo(H * 0.08, -H * 0.74);
    ctx.stroke();

    // ---- 肩甲 ----
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * H * 0.115, -H * 0.73, H * 0.062, H * 0.05, s * 0.2, 0, TAU);
      ctx.fillStyle = STEEL_D;
      ctx.fill();
      ctx.strokeStyle = OL;
      ctx.lineWidth = o * 1.6;
      ctx.stroke();
    }

    // ---- 头盔（圆顶 + 面甲缝 + 红缨）----
    const hy = -H * 0.86;
    ctx.beginPath();
    ctx.arc(0, hy, H * 0.105, Math.PI, TAU);
    ctx.lineTo(H * 0.105, hy + H * 0.05);
    ctx.lineTo(-H * 0.105, hy + H * 0.05);
    ctx.closePath();
    ctx.fillStyle = STEEL;
    ctx.fill();
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 2;
    ctx.stroke();
    ctx.fillStyle = '#1b2431';
    ctx.fillRect(-H * 0.095, hy - H * 0.005, H * 0.19, H * 0.022);
    ctx.fillStyle = '#7fd4ff';
    ctx.fillRect(-H * 0.085, hy + H * 0.001, H * 0.17, H * 0.009);
    // 红缨：从盔顶往后拖一撮
    ctx.beginPath();
    ctx.moveTo(0, hy - H * 0.1);
    ctx.quadraticCurveTo(-H * 0.02, hy - H * 0.2, H * 0.05, hy - H * 0.24);
    ctx.quadraticCurveTo(H * 0.03, hy - H * 0.14, H * 0.02, hy - H * 0.09);
    ctx.closePath();
    ctx.fillStyle = '#c8402f';
    ctx.fill();
    ctx.strokeStyle = '#7d2018';
    ctx.lineWidth = o;
    ctx.stroke();

    // ---- 右手的剑：站住时斜着垂在身侧，开火时往前挥 ----
    const px = H * 0.13;
    const py = -H * 0.6;
    const ang = 0.5 - swing * 1.75; // 弧度：垂着 → 挥到前上方
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.strokeStyle = '#6b4a2a';
    ctx.lineWidth = H * 0.028;
    ctx.beginPath();
    ctx.moveTo(0, H * 0.03);
    ctx.lineTo(0, H * 0.12);
    ctx.stroke();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = H * 0.022;
    ctx.beginPath();
    ctx.moveTo(-H * 0.045, H * 0.025);
    ctx.lineTo(H * 0.045, H * 0.025);
    ctx.stroke();
    const bl = H * 0.34;
    ctx.beginPath();
    ctx.moveTo(-H * 0.019, H * 0.02);
    ctx.lineTo(-H * 0.013, -bl);
    ctx.lineTo(0, -bl - H * 0.03);
    ctx.lineTo(H * 0.013, -bl);
    ctx.lineTo(H * 0.019, H * 0.02);
    ctx.closePath();
    ctx.fillStyle = '#e8eef7';
    ctx.fill();
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 1.4;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = Math.max(0.6, H * 0.008);
    ctx.beginPath();
    ctx.moveTo(-H * 0.006, 0);
    ctx.lineTo(-H * 0.004, -bl * 0.94);
    ctx.stroke();
    ctx.restore();

    // ---- 剑气残影：挥剑的那一下拖出一道月牙 ----
    if (swing > 0.05) {
      ctx.save();
      ctx.translate(px * 0.4, py + H * 0.02);
      ctx.globalAlpha = 0.5 * swing;
      ctx.strokeStyle = '#bfe9ff';
      ctx.lineWidth = H * 0.05 * swing;
      ctx.beginPath();
      ctx.arc(0, 0, H * 0.3, Math.PI * 1.05, Math.PI * 1.75);
      ctx.stroke();
      ctx.globalAlpha = 0.85 * swing;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = H * 0.016 * swing;
      ctx.beginPath();
      ctx.arc(0, 0, H * 0.31, Math.PI * 1.1, Math.PI * 1.7);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * 第四关主角之二：花仙子（用户 m04749：花仙子 · 魔法棒 · 魔法粒子 · 少女风）。
   * 背影视角：粉发 + 小翅膀 + 紫裙，右手的魔法棒往前伸，开火时星芒炸开一团粒子。
   */
  _heroFairy(ctx, H, sw, pl) {
    const OL = '#3a2a3f';
    const o = Math.max(0.5, H * 0.0125);
    const HAIR = '#ffb6dd';
    const HAIR_D = '#e07bb0';
    const DRESS = '#c9a0ff';
    const DRESS_D = '#8f63d6';
    const SKIN = '#ffe0c8';
    const GLOW = '#ff9ad8';
    const cast = Math.min(1, pl.muzzle * 3.4);

    // ---- 翅膀（先画，在身体后面；半透明 + 随呼吸轻扇）----
    const flap = Math.sin(this.time * 7.5) * 0.16;
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(s * H * 0.05, -H * 0.6);
      ctx.rotate(s * (0.5 + flap));
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#cfeaff';
      ctx.beginPath();
      ctx.ellipse(s * H * 0.13, -H * 0.04, H * 0.115, H * 0.05, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#ffd8f0';
      ctx.beginPath();
      ctx.ellipse(s * H * 0.11, H * 0.05, H * 0.085, H * 0.038, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = Math.max(0.6, H * 0.008);
      ctx.beginPath();
      ctx.ellipse(s * H * 0.13, -H * 0.04, H * 0.115, H * 0.05, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // ---- 腿（细，露一点）----
    ctx.strokeStyle = SKIN;
    ctx.lineWidth = H * 0.045;
    for (const s of [-1, 1]) {
      const fx = s * H * 0.05 + s * sw * H * 0.07;
      ctx.beginPath();
      ctx.moveTo(s * H * 0.04, -H * 0.36);
      ctx.quadraticCurveTo(fx * 0.8, -H * 0.18, fx, -H * 0.03);
      ctx.stroke();
    }
    ctx.strokeStyle = '#7a5bd0';
    ctx.lineWidth = H * 0.022;
    for (const s of [-1, 1]) {
      const fx = s * H * 0.05 + s * sw * H * 0.07;
      ctx.beginPath();
      ctx.moveTo(fx - H * 0.022, -H * 0.02);
      ctx.lineTo(fx + H * 0.022, -H * 0.02);
      ctx.stroke();
    }

    // ---- 裙子（下摆散开、随走路上飘）----
    const sway = Math.sin(pl.anim) * pl.moving * H * 0.012;
    ctx.beginPath();
    ctx.moveTo(-H * 0.1, -H * 0.56);
    ctx.quadraticCurveTo(-H * 0.2 + sway, -H * 0.3, -H * 0.15 + sway, -H * 0.24);
    ctx.quadraticCurveTo(0, -H * 0.2, H * 0.15 + sway, -H * 0.24);
    ctx.quadraticCurveTo(H * 0.2 + sway, -H * 0.3, H * 0.1, -H * 0.56);
    ctx.closePath();
    const dg = ctx.createLinearGradient(0, -H * 0.56, 0, -H * 0.22);
    dg.addColorStop(0, DRESS);
    dg.addColorStop(1, DRESS_D);
    ctx.fillStyle = dg;
    ctx.fill();
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 1.6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = Math.max(0.7, H * 0.01);
    ctx.beginPath();
    ctx.moveTo(-H * 0.14 + sway, -H * 0.25);
    ctx.quadraticCurveTo(0, -H * 0.21, H * 0.14 + sway, -H * 0.25);
    ctx.stroke();

    // ---- 上身 ----
    roundRect(ctx, -H * 0.085, -H * 0.72, H * 0.17, H * 0.18, H * 0.05);
    ctx.fillStyle = DRESS;
    ctx.fill();
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 1.6;
    ctx.stroke();

    // ---- 头 + 粉色头发（背包视角：后脑勺 + 两侧发丝）----
    const hy = -H * 0.83;
    ctx.beginPath();
    ctx.arc(0, hy, H * 0.1, 0, TAU);
    ctx.fillStyle = SKIN;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, hy - H * 0.012, H * 0.104, Math.PI * 0.92, Math.PI * 2.08);
    ctx.fillStyle = HAIR;
    ctx.fill();
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * H * 0.09, hy - H * 0.03);
      ctx.quadraticCurveTo(s * H * 0.15, hy + H * 0.08, s * H * 0.11, hy + H * 0.2);
      ctx.quadraticCurveTo(s * H * 0.07, hy + H * 0.08, s * H * 0.06, hy - H * 0.01);
      ctx.closePath();
      ctx.fillStyle = s < 0 ? HAIR : HAIR_D;
      ctx.fill();
    }
    // 头顶那朵小花（少女风的点睛）
    ctx.fillStyle = '#fff6ff';
    for (let i = 0; i < 5; i++) {
      const a2 = (i / 5) * TAU;
      ctx.beginPath();
      ctx.arc(Math.cos(a2) * H * 0.028, hy - H * 0.1 + Math.sin(a2) * H * 0.028, H * 0.018, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#ffd76a';
    ctx.beginPath();
    ctx.arc(0, hy - H * 0.1, H * 0.014, 0, TAU);
    ctx.fill();

    // ---- 魔法棒：右手往前伸，顶端一颗星 ----
    const wx = H * 0.12;
    const wy = -H * 0.6;
    ctx.strokeStyle = '#f6f0ff';
    ctx.lineWidth = H * 0.018;
    ctx.beginPath();
    ctx.moveTo(wx - H * 0.05, wy + H * 0.14);
    ctx.lineTo(wx + H * 0.03, wy - H * 0.1);
    ctx.stroke();
    const sx = wx + H * 0.035;
    const sy = wy - H * 0.13;
    this._drawGlow(sx, sy, H * 0.1 * (1 + cast * 0.8), GLOW, 0.55 + cast * 0.3);
    ctx.fillStyle = '#fff6ff';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a2 = (i / 10) * TAU - Math.PI / 2;
      const rr = i % 2 ? H * 0.022 : H * 0.055;
      const xx = sx + Math.cos(a2) * rr;
      const yy = sy + Math.sin(a2) * rr;
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.closePath();
    ctx.fill();

    // ---- 施法粒子：开火那一下从星芒里甩出去一串 ----
    if (cast > 0.05) {
      for (let i = 0; i < 5; i++) {
        const a2 = -Math.PI / 2 + (i - 2) * 0.42;
        const rr = H * (0.06 + 0.14 * (1 - cast) + i * 0.012);
        ctx.globalAlpha = 0.85 * cast;
        ctx.fillStyle = i % 2 ? '#ffffff' : GLOW;
        ctx.beginPath();
        ctx.arc(sx + Math.cos(a2) * rr, sy + Math.sin(a2) * rr, H * 0.014, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  _heroPlant(ctx, game, H, sw, pl) {
    const n = Math.max(1, Math.min(5, Math.round(game.weapon.bullets)));
    const plant = pvzPlant(n);
    const recoil = pl.muzzle;
    const t = this.time * 2.2;

    // 茎 + 两片叶子（站在草坪上的植物）
    // 【用户 m02399】描边不再往黑里压，改成"深一档的叶绿"，线细一档。
    const OL = mix(plant.dark, plant.color, 0.22);
    const o = Math.max(0.5, H * 0.013);
    ctx.lineCap = 'round';
    ctx.strokeStyle = OL;
    ctx.lineWidth = Math.max(1.6, H * 0.08) + o * 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -H * 0.02);
    ctx.lineTo(0, -H * 0.46);
    ctx.stroke();
    ctx.strokeStyle = plant.dark;
    ctx.lineWidth = Math.max(1.6, H * 0.08);
    ctx.beginPath();
    ctx.moveTo(0, -H * 0.02);
    ctx.lineTo(0, -H * 0.46);
    ctx.stroke();
    for (const s of [-1, 1]) {
      const lift = Math.sin(t + (s > 0 ? 0 : 1.4)) * H * 0.012;
      const ey = -H * 0.19 + lift - s * sw * H * 0.02;
      // 叶片：先描一圈硬边再填色
      ctx.fillStyle = plant.color;
      ctx.strokeStyle = OL;
      ctx.lineWidth = o * 1.6;
      ctx.beginPath();
      ctx.ellipse(s * H * 0.19, ey, H * 0.21, H * 0.085, s * -0.42, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = plant.dark;
      ctx.beginPath();
      ctx.ellipse(s * H * 0.24, ey + H * 0.025, H * 0.1, H * 0.038, s * -0.42, 0, TAU);
      ctx.fill();
      // 叶脉高光
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = Math.max(1, H * 0.012);
      ctx.beginPath();
      ctx.moveTo(s * H * 0.08, ey - H * 0.03);
      ctx.lineTo(s * H * 0.3, ey - H * 0.05);
      ctx.stroke();
    }

    // 头：几个豌豆头并排，越靠边的越矮一点，看着像一丛花
    const headY = -H * 0.7;
    const gap = H * (n <= 2 ? 0.24 : n === 3 ? 0.2 : 0.165);
    const r = H * (n <= 2 ? 0.2 : n === 3 ? 0.175 : 0.15);
    for (let i = 0; i < n; i++) {
      const k = i - (n - 1) / 2;
      const ox = k * gap;
      const oy = headY - Math.abs(k) * H * 0.05 + Math.sin(t + i * 0.8) * H * 0.008;
      const lane = (game.lanes && game.lanes[i]) || '';
      const col = lane === 'ice' ? CFG.pvz.ice.color : lane === 'fire' ? CFG.pvz.fire.color : plant.color;
      const darkC = lane === 'ice' ? '#1f6f9c' : lane === 'fire' ? '#9c3410' : plant.dark;
      // 带属性的那条弹道在头上挂一层同色辉光，一眼看出哪条是冰 / 火
      if (lane) this._drawGlow(ox, oy, r * 2.1, lane === 'ice' ? '#7df9ff' : '#ff9a3c', 0.3);

      // 头
      ctx.fillStyle = col;
      ctx.strokeStyle = mix(darkC, '#0d1a08', 0.5);
      ctx.lineWidth = o * 1.7;
      ctx.beginPath();
      ctx.arc(ox, oy, r, 0, TAU);
      ctx.fill();
      ctx.stroke();
      // 左上受光
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.beginPath();
      ctx.ellipse(ox - r * 0.34, oy - r * 0.38, r * 0.42, r * 0.3, -0.6, 0, TAU);
      ctx.fill();
      // 底部的暗面（给球体一点体积）
      ctx.fillStyle = darkC;
      ctx.beginPath();
      ctx.arc(ox, oy + r * 0.3, r * 0.9, 0.45, Math.PI - 0.45, true);
      ctx.fill();
      // 炮口（朝前 = 屏幕上方），开火那一下会缩一下
      const mr = r * (0.46 - recoil * 0.16);
      ctx.fillStyle = darkC;
      ctx.strokeStyle = mix(darkC, '#0d1a08', 0.5);
      ctx.lineWidth = o * 1.4;
      ctx.beginPath();
      ctx.ellipse(ox, oy - r * 0.72 - recoil * r * 0.22, mr, r * 0.34, 0, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(ox, oy - r * 0.88 - recoil * r * 0.22, mr * 0.5, r * 0.15, 0, 0, TAU);
      ctx.fill();
      // 眯眼（背影视角只看得到一点点侧脸）
      ctx.strokeStyle = 'rgba(20,40,16,0.75)';
      ctx.lineWidth = Math.max(1, H * 0.012);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(ox + s * r * 0.44, oy + r * 0.06, r * 0.16, -2.6, -1.1);
        ctx.stroke();
      }
    }
  }

  /**
   * 第三关的僵尸部件（植物大战僵尸的招牌家伙们）。
   * 局部坐标和 _zombieBody 一致：脚底是原点，头在 -H，躯干 -0.42H ~ -0.70H。
   * 只加"一眼认得出是谁"的那几笔，身体颜色还是走 col/dark，
   * 这样受击白闪、冻结、燃烧这些统一效果全都还在。
   */
  _pvzBits(ctx, H, e, col, dark) {
    const a = e.animal;
    const headY = -0.815 * H;
    const headR = 0.11 * H;
    const t = this.time * 2.4 + (e.phase || 0);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (a === 'basic') {
      // 破领子 + 红领带 + 往前伸的一只手（PvZ 最经典的那只）
      ctx.fillStyle = '#d8d2c0';
      ctx.beginPath();
      ctx.moveTo(-0.12 * H, -0.72 * H);
      ctx.lineTo(0, -0.58 * H);
      ctx.lineTo(0.12 * H, -0.72 * H);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#c8402f';
      ctx.beginPath();
      ctx.moveTo(0, -0.62 * H);
      ctx.lineTo(-0.035 * H, -0.4 * H);
      ctx.lineTo(0.035 * H, -0.4 * H);
      ctx.closePath();
      ctx.fill();
      // 伸出来的手（在身体一侧，随行走摆）
      const sw2 = Math.sin(t) * 0.03 * H;
      ctx.strokeStyle = mix(col, '#000000', 0.28);
      ctx.lineWidth = 0.055 * H;
      ctx.beginPath();
      ctx.moveTo(0.14 * H, -0.6 * H);
      ctx.quadraticCurveTo(0.26 * H, -0.62 * H + sw2, 0.3 * H, -0.44 * H + sw2);
      ctx.stroke();
      ctx.fillStyle = mix(col, '#ffffff', 0.18);
      ctx.beginPath();
      ctx.arc(0.3 * H, -0.43 * H + sw2, 0.045 * H, 0, TAU);
      ctx.fill();
    } else if (a === 'pole') {
      // 撑杆僵尸：背后斜扛一根长杆 + 红背心
      ctx.strokeStyle = '#b58a4e';
      ctx.lineWidth = 0.032 * H;
      ctx.beginPath();
      ctx.moveTo(-0.2 * H, -0.06 * H);
      ctx.lineTo(0.26 * H, -1.16 * H);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(80,54,24,0.55)';
      ctx.lineWidth = 0.012 * H;
      ctx.beginPath();
      ctx.moveTo(-0.2 * H, -0.06 * H);
      ctx.lineTo(0.26 * H, -1.16 * H);
      ctx.stroke();
      ctx.fillStyle = '#a83a2c';
      ctx.beginPath();
      ctx.moveTo(-0.13 * H, -0.72 * H);
      ctx.lineTo(0.13 * H, -0.72 * H);
      ctx.lineTo(0.1 * H, -0.44 * H);
      ctx.lineTo(-0.1 * H, -0.44 * H);
      ctx.closePath();
      ctx.fill();
    } else if (a === 'gargantuar') {
      // 巨人僵尸：肩膀上扛一根电线杆（差不多有身体两倍高）
      ctx.strokeStyle = '#8d7350';
      ctx.lineWidth = 0.06 * H;
      ctx.beginPath();
      ctx.moveTo(-0.3 * H, -0.5 * H);
      ctx.lineTo(0.16 * H, -1.62 * H);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(60,44,26,0.6)';
      ctx.lineWidth = 0.016 * H;
      for (let i = 0; i < 3; i++) {
        const k = 0.22 + i * 0.26;
        ctx.beginPath();
        ctx.moveTo(-0.3 * H + 0.46 * H * k - 0.03 * H, -0.5 * H - 1.12 * H * k);
        ctx.lineTo(-0.3 * H + 0.46 * H * k + 0.03 * H, -0.5 * H - 1.12 * H * k);
        ctx.stroke();
      }
      // 缠绕的电线
      ctx.strokeStyle = '#2f3a37';
      ctx.lineWidth = 0.014 * H;
      ctx.beginPath();
      ctx.moveTo(-0.32 * H, -0.52 * H);
      ctx.quadraticCurveTo(-0.06 * H, -0.44 * H + Math.sin(t) * 0.02 * H, 0.14 * H, -0.56 * H);
      ctx.stroke();
      // 破背带
      ctx.strokeStyle = 'rgba(200,180,150,0.5)';
      ctx.lineWidth = 0.03 * H;
      ctx.beginPath();
      ctx.moveTo(-0.09 * H, -0.7 * H);
      ctx.lineTo(-0.05 * H, -0.4 * H);
      ctx.stroke();
    } else if (a === 'zomboss') {
      // 僵王博士：玻璃罩 + 红眼睛 + 两块肩甲
      ctx.fillStyle = 'rgba(180,230,255,0.34)';
      ctx.beginPath();
      ctx.arc(0, headY - headR * 0.15, headR * 2.0, Math.PI * 0.02, Math.PI * 0.98, true);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(230,250,255,0.8)';
      ctx.lineWidth = 0.012 * H;
      ctx.beginPath();
      ctx.arc(0, headY - headR * 0.15, headR * 2.0, Math.PI * 1.05, Math.PI * 1.95);
      ctx.stroke();
      this._drawGlow(-headR * 0.42, headY + headR * 0.05, headR * 0.5, '#ff3b2f', 0.85);
      this._drawGlow(headR * 0.42, headY + headR * 0.05, headR * 0.5, '#ff3b2f', 0.85);
      ctx.fillStyle = mix(dark, '#000000', 0.3);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * 0.24 * H, -0.68 * H, 0.09 * H, 0.055 * H, s * 0.28, 0, TAU);
        ctx.fill();
      }
    } else if (a === 'doctor') {
      // 【用户 m01503】僵尸博士（僵王的第二形态）：更大的玻璃罩 + 会亮的能量核心 +
      // 双肩火箭 + 头上一根天线。和第一形态（zomboss）同一套骨架，但部件更"机器"。
      // 玻璃罩（比僵王的更大一号）
      ctx.fillStyle = 'rgba(170,235,255,0.30)';
      ctx.beginPath();
      ctx.arc(0, headY - headR * 0.2, headR * 2.5, Math.PI * 0.02, Math.PI * 0.98, true);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(235,252,255,0.9)';
      ctx.lineWidth = 0.014 * H;
      ctx.beginPath();
      ctx.arc(0, headY - headR * 0.2, headR * 2.5, Math.PI * 1.05, Math.PI * 1.95);
      ctx.stroke();
      // 两只红眼 + 眼里的十字准星（博士的招牌）
      for (const s of [-1, 1]) {
        this._drawGlow(s * headR * 0.45, headY + headR * 0.05, headR * 0.6, '#ff3b2f', 0.95);
        ctx.strokeStyle = 'rgba(255,190,180,0.9)';
        ctx.lineWidth = 0.01 * H;
        ctx.beginPath();
        ctx.moveTo(s * headR * 0.45 - headR * 0.22, headY + headR * 0.05);
        ctx.lineTo(s * headR * 0.45 + headR * 0.22, headY + headR * 0.05);
        ctx.moveTo(s * headR * 0.45, headY + headR * 0.05 - headR * 0.22);
        ctx.lineTo(s * headR * 0.45, headY + headR * 0.05 + headR * 0.22);
        ctx.stroke();
      }
      // 天线 + 顶上闪的红灯
      ctx.strokeStyle = '#c9d6db';
      ctx.lineWidth = 0.012 * H;
      ctx.beginPath();
      ctx.moveTo(0, headY - headR * 2.1);
      ctx.lineTo(-0.02 * H, headY - headR * 3.4);
      ctx.stroke();
      this._drawGlow(-0.02 * H, headY - headR * 3.5, headR * 0.4 * (1 + Math.sin(t * 2.2) * 0.25), '#ff5a3a', 0.9);
      // 胸口的能量核心（呼吸式明灭）
      const core = 0.55 + 0.45 * Math.abs(Math.sin(t * 1.4));
      this._drawGlow(0, -0.52 * H, 0.1 * H * core, '#8bf58b', 0.85);
      ctx.fillStyle = 'rgba(20,30,26,0.85)';
      ctx.beginPath();
      ctx.ellipse(0, -0.52 * H, 0.11 * H, 0.09 * H, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = mix('#8bf58b', '#ffffff', core * 0.5);
      ctx.beginPath();
      ctx.ellipse(0, -0.52 * H, 0.07 * H, 0.055 * H, 0, 0, TAU);
      ctx.fill();
      // 双肩火箭（斜向上的两根发射管）
      for (const s of [-1, 1]) {
        ctx.fillStyle = mix(dark, '#000000', 0.25);
        ctx.beginPath();
        ctx.moveTo(s * 0.2 * H, -0.7 * H);
        ctx.lineTo(s * 0.34 * H, -0.82 * H);
        ctx.lineTo(s * 0.38 * H, -0.72 * H);
        ctx.lineTo(s * 0.23 * H, -0.6 * H);
        ctx.closePath();
        ctx.fill();
        this._drawGlow(s * 0.35 * H, -0.78 * H, 0.02 * H * (1 + Math.sin(t * 3 + s) * 0.3), '#ffb060', 0.8);
      }
    } else if (a === 'catapult') {
      // 投石车僵尸：腰上驮着一台木架子 + 两个轮子
      ctx.strokeStyle = '#a87f46';
      ctx.lineWidth = 0.036 * H;
      ctx.beginPath();
      ctx.moveTo(-0.24 * H, -0.36 * H);
      ctx.lineTo(-0.16 * H, -0.86 * H);
      ctx.lineTo(0.2 * H, -0.86 * H);
      ctx.lineTo(0.28 * H, -0.36 * H);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-0.2 * H, -0.86 * H);
      ctx.lineTo(0.24 * H, -0.36 * H);
      ctx.stroke();
      // 抛臂（转的时候在甩）
      const arm = 0.3 + Math.sin(t * 0.8) * 0.12;
      ctx.strokeStyle = '#8d6a38';
      ctx.lineWidth = 0.028 * H;
      ctx.beginPath();
      ctx.moveTo(0.02 * H, -0.8 * H);
      ctx.lineTo(0.02 * H + Math.cos(arm) * 0.3 * H, -0.8 * H - Math.sin(arm) * 0.3 * H);
      ctx.stroke();
      for (const s of [-1, 1]) {
        ctx.fillStyle = '#5c4426';
        ctx.beginPath();
        ctx.arc(s * 0.2 * H, -0.3 * H, 0.075 * H, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#8d6a38';
        ctx.beginPath();
        ctx.arc(s * 0.2 * H, -0.3 * H, 0.03 * H, 0, TAU);
        ctx.fill();
      }
    } else if (a === 'bucket') {
      // 铁桶僵尸：扣在头上的铁桶，带桶箍和高光
      const bh = 0.19 * H;
      const bw = headR * 1.55;
      ctx.fillStyle = '#9aa3ad';
      ctx.beginPath();
      ctx.moveTo(-bw, headY + bh * 0.5);
      ctx.lineTo(-bw * 0.78, headY - bh * 0.9);
      ctx.lineTo(bw * 0.78, headY - bh * 0.9);
      ctx.lineTo(bw, headY + bh * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#6c757e';
      ctx.beginPath();
      ctx.ellipse(0, headY - bh * 0.9, bw * 0.78, headR * 0.22, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#5b636b';
      ctx.lineWidth = 0.012 * H;
      for (const k2 of [-0.3, 0.2]) {
        ctx.beginPath();
        ctx.moveTo(-bw * (0.93 - k2 * 0.2), headY + bh * k2);
        ctx.lineTo(bw * (0.93 - k2 * 0.2), headY + bh * k2);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(-bw * 0.4, headY - bh * 0.15, bw * 0.12, bh * 0.5, 0.1, 0, TAU);
      ctx.fill();
    } else if (a === 'imp') {
      // 小鬼僵尸：头顶一撮毛 + 两只尖耳朵
      ctx.fillStyle = mix(col, '#000000', 0.3);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * headR * 0.72, headY - headR * 0.3);
        ctx.lineTo(s * headR * 1.7, headY - headR * 1.15);
        ctx.lineTo(s * headR * 0.55, headY - headR * 0.95);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = mix(col, '#000000', 0.45);
      ctx.lineWidth = 0.016 * H;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 0.02 * H, headY - headR * 1.05);
        ctx.quadraticCurveTo(i * 0.05 * H + Math.sin(t) * 0.01 * H, headY - headR * 1.8, i * 0.02 * H + Math.sin(t) * 0.02 * H, headY - headR * 2.0);
        ctx.stroke();
      }
      // 咧开的嘴
      ctx.strokeStyle = 'rgba(30,20,20,0.75)';
      ctx.lineWidth = 0.014 * H;
      ctx.beginPath();
      ctx.arc(0, headY + headR * 0.5, headR * 0.42, 0.35, Math.PI - 0.35);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * 第四关四只怪的**整只重绘**（用户 m11097：给参考图、不要贴图、按形状重构）。
   *
   * 和 _fantasyBits 的"人形骨架 + 挂件"思路不同：哥布林/兽人/鹰身女妖/郊狼
   * 现在连骨架、比例、站姿都对着参考图重画 —— 哥布林是驼背小个子、兽人是
   * 肩宽吓人的大块头、鹰身女妖是鸟腿爪子的女妖、郊狼是**四足**（原来那条
   * 人形躯干 + 狼头 + 尾巴的"狼人"是错得最明显的）。
   *
   * 返回 true 表示整只已经画完，调用方就别再叠 _zombieBody / _fantasyBits 了。
   * 坐标系：原点在脚底，向上是负 y，整体高度≈1.0H。
   */
  _fantasyBody(ctx, H, e, col, dark) {
    const a = e.animal;
    if (a === 'goblin') { this._fgGoblin(ctx, H, e, col, dark); return true; }
    if (a === 'orc') { this._fgOrc(ctx, H, e, col, dark); return true; }
    if (a === 'harpy') { this._fgHarpy(ctx, H, e, col, dark); return true; }
    if (a === 'coyote') { this._fgCoyote(ctx, H, e, col, dark); return true; }
    return false; // 史莱姆 / 恶龙：仍走 _zombieBody + _fantasyBits
  }

  /**
   * 哥布林（参考图：绿皮、招风大耳、咧嘴露尖牙、驼背、破布围裙、锯齿短刃）。
   * 剪影三件套：大耳朵 / 大嘴 / 驼背小个子 —— 40px 高的时候只剩这三样能被认出来。
   */
  _fgGoblin(ctx, H, e, col, dark) {
    const t = this.time * 3.4 + (e.phase || 0);
    const bob = Math.sin(t * 2) * 0.012 * H;
    const armSw = Math.sin(t) * 0.04 * H;
    const skin = col;
    const sh = mix(col, '#000000', 0.32);
    const hi = mix(col, '#ffffff', 0.26);
    const rug = mix(dark, '#000000', 0.15);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.19 * H, 0.05 * H, 0, 0, TAU);
    ctx.fill();

    ctx.translate(0, bob);

    // —— 短粗腿：膝盖外撇，脚大
    for (const s of [-1, 1]) {
      const lx = s * 0.07 * H;
      ctx.fillStyle = s < 0 ? sh : skin;
      ctx.beginPath();
      ctx.moveTo(lx - 0.05 * H, -0.3 * H);
      ctx.quadraticCurveTo(lx - 0.065 * H, -0.16 * H, lx - 0.055 * H, -0.02 * H);
      ctx.lineTo(lx + 0.062 * H, -0.02 * H);
      ctx.quadraticCurveTo(lx + 0.07 * H, -0.17 * H, lx + 0.05 * H, -0.3 * H);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = mix(skin, '#000000', 0.12);
      ctx.beginPath();
      ctx.ellipse(lx + 0.006 * H, -0.02 * H, 0.062 * H, 0.026 * H, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#e8dcc0';
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(lx + i * 0.028 * H, -0.028 * H);
        ctx.lineTo(lx + i * 0.03 * H + 0.01 * H, -0.048 * H);
        ctx.lineTo(lx + i * 0.03 * H + 0.02 * H, -0.026 * H);
        ctx.closePath();
        ctx.fill();
      }
    }

    // —— 破布围裙
    ctx.fillStyle = rug;
    ctx.beginPath();
    ctx.moveTo(-0.105 * H, -0.42 * H);
    ctx.lineTo(0.105 * H, -0.42 * H);
    ctx.lineTo(0.085 * H, -0.27 * H);
    for (let i = 0; i < 4; i++) {
      const x0 = 0.085 * H - i * 0.048 * H;
      ctx.lineTo(x0 - 0.024 * H, -0.33 * H);
      ctx.lineTo(x0 - 0.048 * H, -0.27 * H);
    }
    ctx.lineTo(-0.105 * H, -0.27 * H);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = mix('#6b4a2a', '#000000', 0.12);
    ctx.beginPath();
    ctx.rect(-0.108 * H, -0.445 * H, 0.216 * H, 0.032 * H);
    ctx.fill();

    // —— 驼背躯干（前倾，肩比胯宽）
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.moveTo(-0.1 * H, -0.43 * H);
    ctx.quadraticCurveTo(-0.165 * H, -0.56 * H, -0.115 * H, -0.65 * H);
    ctx.quadraticCurveTo(0.005 * H, -0.715 * H, 0.12 * H, -0.65 * H);
    ctx.quadraticCurveTo(0.165 * H, -0.56 * H, 0.1 * H, -0.43 * H);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.moveTo(0.02 * H, -0.43 * H);
    ctx.quadraticCurveTo(0.15 * H, -0.55 * H, 0.12 * H, -0.65 * H);
    ctx.quadraticCurveTo(0.06 * H, -0.695 * H, 0.03 * H, -0.67 * H);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = hi;
    ctx.globalAlpha = 0.32;
    ctx.beginPath();
    ctx.ellipse(-0.045 * H, -0.57 * H, 0.048 * H, 0.032 * H, -0.3, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    // —— 骨齿项链
    ctx.fillStyle = '#efe6cf';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 0.04 * H, -0.655 * H);
      ctx.lineTo(i * 0.04 * H + 0.011 * H, -0.605 * H);
      ctx.lineTo(i * 0.04 * H + 0.022 * H, -0.655 * H);
      ctx.closePath();
      ctx.fill();
    }

    // —— 左臂：爪子张开往前抓
    ctx.strokeStyle = sh;
    ctx.lineWidth = 0.05 * H;
    ctx.beginPath();
    ctx.moveTo(-0.095 * H, -0.6 * H);
    ctx.quadraticCurveTo(-0.185 * H, -0.545 * H + armSw * 0.5, -0.215 * H, -0.47 * H + armSw);
    ctx.stroke();
    ctx.fillStyle = mix(skin, '#ffffff', 0.1);
    ctx.beginPath();
    ctx.arc(-0.218 * H, -0.465 * H + armSw, 0.03 * H, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#e8dcc0';
    ctx.lineWidth = 0.011 * H;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(-0.222 * H, -0.45 * H + armSw);
      ctx.lineTo(-0.25 * H + i * 0.012 * H, -0.41 * H + armSw);
      ctx.stroke();
    }

    // —— 右臂：攥着锯齿短刃（刀身斜举过肩，握把正好在手里）
    const hx = 0.135 * H;
    const hy = -0.5 * H - armSw * 0.5;
    ctx.strokeStyle = skin;
    ctx.lineWidth = 0.05 * H;
    ctx.beginPath();
    ctx.moveTo(0.095 * H, -0.6 * H);
    ctx.quadraticCurveTo(0.15 * H, -0.56 * H, hx, hy);
    ctx.stroke();
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(-1.15);
    const bl = 0.26 * H;
    const bw = 0.05 * H;
    // 握把
    ctx.fillStyle = '#4a3320';
    ctx.beginPath();
    ctx.rect(-0.075 * H, -bw * 0.32, 0.085 * H, bw * 0.64);
    ctx.fill();
    // 刀身（粗制断刃，刃口有缺口）
    ctx.fillStyle = '#767064';
    ctx.beginPath();
    ctx.moveTo(0.005 * H, -bw * 0.55);
    ctx.lineTo(bl * 0.66, -bw * 0.85);
    ctx.lineTo(bl * 0.78, -bw * 0.35);
    ctx.lineTo(bl * 0.7, bw * 0.1);
    ctx.lineTo(bl * 0.6, -bw * 0.2);
    ctx.lineTo(bl * 0.52, bw * 0.3);
    ctx.lineTo(bl * 0.44, -bw * 0.1);
    ctx.lineTo(bl, bw * 0.35);
    ctx.lineTo(bl * 0.66, bw * 0.95);
    ctx.lineTo(0.005 * H, bw * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(235,232,215,0.45)';
    ctx.lineWidth = 0.009 * H;
    ctx.stroke();
    ctx.restore();

    // —— 头：大、前伸；耳朵向外下方耷拉
    const hcx = 0.035 * H;
    const hcy = -0.76 * H;
    const hr = 0.125 * H;
    for (const s of [-1, 1]) {
      const ex = hcx + s * hr * 0.6;
      const ey = hcy - hr * 0.05;
      ctx.fillStyle = s < 0 ? mix(skin, '#000000', 0.1) : mix(skin, '#ffffff', 0.06);
      ctx.beginPath();
      ctx.moveTo(ex, ey - hr * 0.35);
      ctx.quadraticCurveTo(ex + s * hr * 1.5, ey - hr * 0.75, ex + s * hr * 2.2, ey - hr * 0.2);
      ctx.quadraticCurveTo(ex + s * hr * 1.4, ey + hr * 0.45, ex, ey + hr * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(122,62,62,0.4)';
      ctx.beginPath();
      ctx.moveTo(ex + s * hr * 0.12, ey - hr * 0.22);
      ctx.quadraticCurveTo(ex + s * hr * 1.25, ey - hr * 0.5, ex + s * hr * 1.8, ey - hr * 0.18);
      ctx.quadraticCurveTo(ex + s * hr * 1.1, ey + hr * 0.28, ex + s * hr * 0.12, ey + hr * 0.36);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(hcx, hcy, hr * 0.92, hr, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = hi;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.ellipse(hcx - hr * 0.26, hcy - hr * 0.42, hr * 0.4, hr * 0.24, -0.35, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    // 长鼻
    ctx.fillStyle = mix(skin, '#000000', 0.06);
    ctx.beginPath();
    ctx.moveTo(hcx + hr * 0.08, hcy - hr * 0.05);
    ctx.quadraticCurveTo(hcx + hr * 0.78, hcy + hr * 0.22, hcx + hr * 0.2, hcy + hr * 0.46);
    ctx.closePath();
    ctx.fill();
    // 黄眼 + 竖瞳 + 眉骨
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#ffd45e';
      ctx.beginPath();
      ctx.ellipse(hcx + s * hr * 0.36, hcy - hr * 0.16, hr * 0.18, hr * 0.13, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#221a12';
      ctx.beginPath();
      ctx.ellipse(hcx + s * hr * 0.36, hcy - hr * 0.16, hr * 0.055, hr * 0.11, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = mix(skin, '#000000', 0.45);
      ctx.lineWidth = 0.012 * H;
      ctx.beginPath();
      ctx.moveTo(hcx + s * hr * 0.52, hcy - hr * 0.42);
      ctx.lineTo(hcx + s * hr * 0.18, hcy - hr * 0.3);
      ctx.stroke();
    }
    // 咧嘴 + 尖牙
    const my = hcy + hr * 0.44;
    ctx.fillStyle = '#3a1f1f';
    ctx.beginPath();
    ctx.moveTo(hcx - hr * 0.58, my);
    ctx.quadraticCurveTo(hcx, my + hr * 0.4, hcx + hr * 0.6, my - hr * 0.06);
    ctx.quadraticCurveTo(hcx, my + hr * 0.12, hcx - hr * 0.58, my);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#f2ecd8';
    for (let i = 0; i < 5; i++) {
      const k = i / 4;
      const tx = hcx - hr * 0.46 + k * hr * 0.9;
      const ty = my + hr * (0.15 - 0.19 * Math.sin(k * Math.PI));
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + hr * 0.055, ty + hr * 0.19);
      ctx.lineTo(tx + hr * 0.11, ty - hr * 0.02);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * 兽人（参考图：灰绿巨躯、黑发辫、獠牙、兽毛围脖 + 骷髅肩甲、大石斧）。
   * 剪影靠"肩宽 + 围脖毛边"撑；斧子挎在他右侧（画面左）**不要横过脸**，
   * 第一版就是斧柄从脸前穿过去，远看像脸上贴了根棍子。
   */
  _fgOrc(ctx, H, e, col, dark) {
    const t = this.time * 2.2 + (e.phase || 0);
    const bob = Math.sin(t * 2) * 0.008 * H;
    const swing = Math.sin(t) * 0.03 * H;
    const skin = col;
    const sh = mix(col, '#000000', 0.34);
    const hi = mix(col, '#ffffff', 0.2);
    const fur = '#8d7a5f';
    const furDark = '#5d4f3a';
    const leather = '#4b3524';

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.26 * H, 0.07 * H, 0, 0, TAU);
    ctx.fill();

    ctx.translate(0, bob);

    // —— 腿：粗，毛边靴口
    for (const s of [-1, 1]) {
      const lx = s * 0.115 * H;
      ctx.fillStyle = s < 0 ? sh : skin;
      ctx.beginPath();
      ctx.moveTo(lx - 0.072 * H, -0.4 * H);
      ctx.lineTo(lx + 0.072 * H, -0.4 * H);
      ctx.quadraticCurveTo(lx + 0.064 * H, -0.2 * H, lx + 0.072 * H, -0.04 * H);
      ctx.lineTo(lx - 0.074 * H, -0.04 * H);
      ctx.quadraticCurveTo(lx - 0.08 * H, -0.2 * H, lx - 0.072 * H, -0.4 * H);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = fur;
      ctx.beginPath();
      ctx.moveTo(lx - 0.078 * H, -0.29 * H);
      ctx.lineTo(lx + 0.078 * H, -0.29 * H);
      ctx.lineTo(lx + 0.064 * H, -0.245 * H);
      ctx.lineTo(lx - 0.066 * H, -0.248 * H);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = mix(skin, '#000000', 0.16);
      ctx.beginPath();
      ctx.ellipse(lx, -0.03 * H, 0.084 * H, 0.032 * H, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,16,10,0.45)';
      ctx.lineWidth = 0.008 * H;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(lx + i * 0.032 * H, -0.046 * H);
        ctx.lineTo(lx + i * 0.036 * H, -0.008 * H);
        ctx.stroke();
      }
    }

    // —— 兽毛腰裙 + 宽腰带 + 圆扣
    ctx.fillStyle = furDark;
    ctx.beginPath();
    ctx.moveTo(-0.145 * H, -0.43 * H);
    ctx.lineTo(0.145 * H, -0.43 * H);
    ctx.lineTo(0.115 * H, -0.3 * H);
    ctx.lineTo(-0.115 * H, -0.3 * H);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = fur;
    for (let i = -3; i <= 3; i++) {
      const fx = i * 0.038 * H;
      ctx.beginPath();
      ctx.moveTo(fx - 0.02 * H, -0.31 * H);
      ctx.lineTo(fx, -0.252 * H);
      ctx.lineTo(fx + 0.02 * H, -0.31 * H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = leather;
    ctx.beginPath();
    ctx.rect(-0.15 * H, -0.475 * H, 0.3 * H, 0.05 * H);
    ctx.fill();
    ctx.fillStyle = '#7d7466';
    ctx.beginPath();
    ctx.arc(0, -0.45 * H, 0.036 * H, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#3a352c';
    ctx.lineWidth = 0.008 * H;
    ctx.stroke();

    // —— 巨躯
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.moveTo(-0.155 * H, -0.45 * H);
    ctx.quadraticCurveTo(-0.27 * H, -0.63 * H, -0.3 * H, -0.75 * H);
    ctx.quadraticCurveTo(0, -0.86 * H, 0.3 * H, -0.75 * H);
    ctx.quadraticCurveTo(0.27 * H, -0.63 * H, 0.155 * H, -0.45 * H);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.moveTo(0.03 * H, -0.45 * H);
    ctx.quadraticCurveTo(0.25 * H, -0.6 * H, 0.3 * H, -0.75 * H);
    ctx.quadraticCurveTo(0.16 * H, -0.8 * H, 0.06 * H, -0.78 * H);
    ctx.closePath();
    ctx.fill();
    // 胸肌两块 + 腹肌三道（用形状说"壮"，比涂几道亮条更立得住）
    ctx.fillStyle = mix(skin, '#ffffff', 0.12);
    ctx.globalAlpha = 0.75;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * 0.085 * H, -0.68 * H, 0.075 * H, 0.05 * H, s * 0.18, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(0, -0.6 * H + i * 0.045 * H, 0.055 * H, 0.016 * H, 0, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(30,26,20,0.35)';
    ctx.lineWidth = 0.01 * H;
    ctx.beginPath();
    ctx.moveTo(0, -0.72 * H);
    ctx.lineTo(0, -0.46 * H);
    ctx.stroke();

    // —— 兽毛围脖：一圈毛尖把肩线再撑宽
    ctx.fillStyle = fur;
    ctx.beginPath();
    ctx.moveTo(-0.31 * H, -0.72 * H);
    for (let i = 0; i <= 12; i++) {
      const k = i / 12;
      const x = -0.31 * H + k * 0.62 * H;
      const y = -0.77 * H - Math.sin(k * Math.PI) * 0.06 * H + (i % 2 ? -0.028 * H : 0.004 * H);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(0.31 * H, -0.71 * H);
    ctx.quadraticCurveTo(0, -0.8 * H, -0.31 * H, -0.71 * H);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = furDark;
    ctx.beginPath();
    ctx.moveTo(-0.3 * H, -0.73 * H);
    for (let i = 0; i <= 12; i++) {
      const k = i / 12;
      const x = -0.3 * H + k * 0.6 * H;
      const y = -0.76 * H - Math.sin(k * Math.PI) * 0.045 * H + (i % 2 ? 0.002 * H : -0.016 * H);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(0.3 * H, -0.72 * H);
    ctx.closePath();
    ctx.fill();

    // —— 左肩（画面左）骷髅肩甲：压在围脖上
    ctx.save();
    ctx.translate(-0.235 * H, -0.785 * H);
    ctx.rotate(-0.16);
    ctx.fillStyle = '#e6ddc4';
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.062 * H, 0.072 * H, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#2a2520';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * 0.023 * H, -0.01 * H, 0.016 * H, 0.02 * H, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#d8cfb4';
    ctx.beginPath();
    ctx.moveTo(-0.024 * H, 0.045 * H);
    ctx.lineTo(0.024 * H, 0.045 * H);
    ctx.lineTo(0.01 * H, 0.078 * H);
    ctx.lineTo(-0.01 * H, 0.078 * H);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // —— 手臂
    ctx.strokeStyle = sh;
    ctx.lineWidth = 0.088 * H;
    ctx.beginPath();
    ctx.moveTo(-0.25 * H, -0.69 * H);
    ctx.quadraticCurveTo(-0.33 * H, -0.57 * H, -0.3 * H, -0.47 * H + swing);
    ctx.stroke();
    ctx.strokeStyle = skin;
    ctx.lineWidth = 0.088 * H;
    ctx.beginPath();
    ctx.moveTo(0.25 * H, -0.69 * H);
    ctx.quadraticCurveTo(0.33 * H, -0.58 * H, 0.31 * H, -0.47 * H - swing);
    ctx.stroke();
    ctx.fillStyle = mix(skin, '#000000', 0.1);
    ctx.beginPath();
    ctx.arc(0.31 * H, -0.455 * H - swing, 0.05 * H, 0, TAU);
    ctx.fill();

    // —— 大石斧：挎在画面左，**在身体外侧**，柄从手往斜上方，刃在最高处
    ctx.save();
    ctx.translate(-0.32 * H, -0.47 * H + swing);
    ctx.rotate(0.2);
    ctx.strokeStyle = '#5a4128';
    ctx.lineWidth = 0.034 * H;
    ctx.beginPath();
    ctx.moveTo(0, 0.06 * H);
    ctx.lineTo(-0.06 * H, -0.42 * H);
    ctx.stroke();
    // 缠绳
    ctx.strokeStyle = '#3b2c1c';
    ctx.lineWidth = 0.012 * H;
    for (let i = 0; i < 3; i++) {
      const yy = 0.02 * H - i * 0.05 * H;
      ctx.beginPath();
      ctx.moveTo(-0.038 * H, yy);
      ctx.lineTo(0.014 * H, yy - 0.018 * H);
      ctx.stroke();
    }
    // 半月石刃
    const ax = -0.06 * H;
    const ay = -0.44 * H;
    ctx.fillStyle = '#8b8578';
    ctx.beginPath();
    ctx.moveTo(ax + 0.02 * H, ay - 0.1 * H);
    ctx.quadraticCurveTo(ax - 0.26 * H, ay - 0.03 * H, ax - 0.19 * H, ay + 0.14 * H);
    ctx.quadraticCurveTo(ax - 0.08 * H, ay + 0.02 * H, ax + 0.02 * H, ay + 0.07 * H);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(235,232,220,0.5)';
    ctx.lineWidth = 0.008 * H;
    ctx.stroke();
    ctx.restore();

    // —— 头：相对身体小，黑发 + 两根辫子 + 上扬獠牙
    const hcx = 0.02 * H;
    const hcy = -0.87 * H;
    const hr = 0.1 * H;
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(hcx, hcy, hr * 0.9, hr, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#241f1c';
    ctx.beginPath();
    ctx.ellipse(hcx, hcy - hr * 0.42, hr * 1.08, hr * 0.7, 0, Math.PI * 0.95, Math.PI * 2.05);
    ctx.fill();
    // 两根粗辫子垂到胸前
    ctx.strokeStyle = '#241f1c';
    ctx.lineWidth = 0.026 * H;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(hcx + s * hr * 0.8, hcy - hr * 0.05);
      ctx.quadraticCurveTo(hcx + s * hr * 1.15, hcy + hr * 0.6, hcx + s * hr * 0.85, hcy + hr * 1.25);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffd45e';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(hcx + s * hr * 0.33, hcy - hr * 0.04, hr * 0.16, hr * 0.11, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#221a12';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(hcx + s * hr * 0.33, hcy - hr * 0.04, hr * 0.06, 0, TAU);
      ctx.fill();
    }
    // 下颌
    ctx.fillStyle = mix(skin, '#000000', 0.1);
    ctx.beginPath();
    ctx.ellipse(hcx, hcy + hr * 0.5, hr * 0.62, hr * 0.42, 0, 0, TAU);
    ctx.fill();
    // 獠牙（从下唇往上翘）
    ctx.fillStyle = '#f4eedc';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(hcx + s * hr * 0.26, hcy + hr * 0.62);
      ctx.quadraticCurveTo(hcx + s * hr * 0.4, hcy + hr * 0.2, hcx + s * hr * 0.44, hcy + hr * 0.02);
      ctx.quadraticCurveTo(hcx + s * hr * 0.52, hcy + hr * 0.4, hcx + s * hr * 0.5, hcy + hr * 0.62);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * 鹰身女妖（参考图：长发女相 + 宽羽翼 + 羽臂 + 鸟腿利爪 + 羽毛短裙）。
   * 翅膀第一版画成了几根"触须"—— 因为羽片用的是细长二次曲线，控制点全叠在一起。
   * 现在改成：外缘沿弧线排 5 个羽尖、羽尖之间插内凹点，得到一个**实心扇形**，
   * 再叠一层浅色覆羽，远看就是"一片翅膀"而不是几根毛。
   */
  _fgHarpy(ctx, H, e, col, dark) {
    const t = this.time * 2.6 + (e.phase || 0);
    const flap = Math.sin(t) * 0.18;
    const bob = Math.sin(t * 2) * 0.012 * H;
    // 参考图是金发+暖白皮肤：肤色只吃一点点关卡主色（紫/绿/蓝都试过，
    // 混多了她会变成一团紫泥），其余全靠固定暖色。
    const skinC = mix('#f7e3cd', col, 0.14);
    const wingA = '#c2a887';
    const wingB = '#8a7358';
    const wingC = '#43362a';
    const hairC = '#9d7a42';

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.2 * H, 0.05 * H, 0, 0, TAU);
    ctx.fill();

    ctx.translate(0, bob);

    // —— 翅膀（在身体后面）
    const drawWing = (s, R0, coatCol) => {
      const rootX = s * 0.055 * H;
      const rootY = -0.72 * H;
      // 外缘只放三个大羽尖：羽毛要"少而大"，五个小尖远看就是锯齿
      const angs = [1.16, 0.72, 0.28];
      const tips = angs.map((a, idx) => {
        const R = R0 * (1 + idx * 0.08);
        return [rootX + s * Math.cos(a) * R, rootY - Math.sin(a) * R];
      });
      ctx.fillStyle = coatCol;
      ctx.beginPath();
      ctx.moveTo(rootX, rootY + 0.03 * H);
      ctx.lineTo(tips[0][0], tips[0][1]);
      for (let idx = 1; idx < tips.length; idx++) {
        const px = tips[idx - 1][0];
        const py = tips[idx - 1][1];
        const cx2 = tips[idx][0];
        const cy2 = tips[idx][1];
        ctx.quadraticCurveTo(px + (cx2 - px) * 0.72, py + (cy2 - py) * 0.72, cx2, cy2);
      }
      ctx.quadraticCurveTo(rootX + s * R0 * 0.3, rootY + R0 * 0.5, rootX, rootY + 0.07 * H);
      ctx.closePath();
      ctx.fill();
      // 羽轴
      ctx.strokeStyle = 'rgba(250,244,230,0.16)';
      ctx.lineWidth = 0.008 * H;
      for (let idx = 0; idx < tips.length; idx++) {
        ctx.beginPath();
        ctx.moveTo(rootX, rootY);
        ctx.lineTo(tips[idx][0], tips[idx][1]);
        ctx.stroke();
      }
    };
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(0, 0);
      ctx.translate(s * 0.02 * H, 0);
      ctx.rotate(s * flap * 0.3);
      drawWing(s, 0.36 * H, wingB);
      drawWing(s, 0.25 * H, wingA);
      // 翼前缘亮线
      ctx.strokeStyle = 'rgba(246,238,220,0.28)';
      ctx.lineWidth = 0.012 * H;
      ctx.beginPath();
      ctx.moveTo(s * 0.055 * H, -0.72 * H);
      ctx.quadraticCurveTo(s * 0.24 * H, -0.94 * H, s * 0.4 * H, -0.86 * H);
      ctx.stroke();
      ctx.restore();
    }

    // —— 鸟腿 + 利爪
    for (const s of [-1, 1]) {
      const lx = s * 0.05 * H;
      ctx.strokeStyle = '#c0a468';
      ctx.lineWidth = 0.042 * H;
      ctx.beginPath();
      ctx.moveTo(lx, -0.34 * H);
      ctx.quadraticCurveTo(lx + s * 0.016 * H, -0.2 * H, lx - s * 0.004 * H, -0.055 * H);
      ctx.stroke();
      // 鳞片暗纹
      ctx.strokeStyle = 'rgba(80,60,30,0.35)';
      ctx.lineWidth = 0.006 * H;
      for (let i = 0; i < 3; i++) {
        const yy = -0.28 * H + i * 0.08 * H;
        ctx.beginPath();
        ctx.moveTo(lx - 0.018 * H, yy);
        ctx.lineTo(lx + 0.018 * H, yy - 0.01 * H);
        ctx.stroke();
      }
      // 爪
      ctx.strokeStyle = '#2c2620';
      ctx.lineWidth = 0.014 * H;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(lx - s * 0.004 * H, -0.05 * H);
        ctx.quadraticCurveTo(lx + i * 0.032 * H, -0.035 * H, lx + i * 0.046 * H, -0.002 * H);
        ctx.stroke();
      }
      // 大腿羽
      ctx.fillStyle = wingA;
      ctx.beginPath();
      ctx.moveTo(lx - 0.055 * H, -0.37 * H);
      ctx.quadraticCurveTo(lx - 0.075 * H, -0.26 * H, lx - 0.02 * H, -0.22 * H);
      ctx.quadraticCurveTo(lx + 0.045 * H, -0.26 * H, lx + 0.055 * H, -0.37 * H);
      ctx.closePath();
      ctx.fill();
    }

    // —— 羽毛短裙
    ctx.fillStyle = wingB;
    ctx.beginPath();
    ctx.moveTo(-0.1 * H, -0.5 * H);
    ctx.lineTo(0.1 * H, -0.5 * H);
    ctx.lineTo(0.13 * H, -0.34 * H);
    for (let i = 4; i >= 0; i--) {
      const x = -0.13 * H + (i / 4) * 0.26 * H;
      ctx.lineTo(x + 0.016 * H, -0.27 * H);
      ctx.lineTo(x - 0.016 * H, -0.35 * H);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = wingC;
    for (let i = 0; i < 6; i++) {
      const x = -0.11 * H + (i / 5) * 0.22 * H;
      ctx.beginPath();
      ctx.moveTo(x, -0.48 * H);
      ctx.lineTo(x + 0.032 * H, -0.33 * H);
      ctx.lineTo(x - 0.032 * H, -0.33 * H);
      ctx.closePath();
      ctx.fill();
    }

    // —— 躯干（细腰）
    ctx.fillStyle = skinC;
    ctx.beginPath();
    ctx.moveTo(-0.088 * H, -0.5 * H);
    ctx.quadraticCurveTo(-0.105 * H, -0.62 * H, -0.078 * H, -0.71 * H);
    ctx.quadraticCurveTo(0, -0.755 * H, 0.078 * H, -0.71 * H);
    ctx.quadraticCurveTo(0.105 * H, -0.62 * H, 0.088 * H, -0.5 * H);
    ctx.closePath();
    ctx.fill();
    // 黑羽胸衣
    ctx.fillStyle = wingC;
    ctx.beginPath();
    ctx.moveTo(-0.082 * H, -0.71 * H);
    ctx.quadraticCurveTo(0, -0.66 * H, 0.082 * H, -0.71 * H);
    ctx.quadraticCurveTo(0.062 * H, -0.62 * H, 0, -0.6 * H);
    ctx.quadraticCurveTo(-0.062 * H, -0.62 * H, -0.082 * H, -0.71 * H);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(226,190,120,0.8)';
    ctx.lineWidth = 0.011 * H;
    ctx.beginPath();
    ctx.moveTo(-0.086 * H, -0.52 * H);
    ctx.quadraticCurveTo(0, -0.49 * H, 0.086 * H, -0.52 * H);
    ctx.stroke();
    // 颈饰
    ctx.strokeStyle = 'rgba(226,190,120,0.7)';
    ctx.beginPath();
    ctx.moveTo(-0.03 * H, -0.72 * H);
    ctx.quadraticCurveTo(0, -0.755 * H, 0.03 * H, -0.72 * H);
    ctx.stroke();

    // —— 手臂：上臂裸、前臂羽毛、末端爪
    for (const s of [-1, 1]) {
      const sy = -0.68 * H;
      ctx.strokeStyle = skinC;
      ctx.lineWidth = 0.032 * H;
      ctx.beginPath();
      ctx.moveTo(s * 0.078 * H, sy);
      ctx.quadraticCurveTo(s * 0.155 * H, sy + 0.03 * H, s * 0.19 * H, -0.56 * H);
      ctx.stroke();
      ctx.fillStyle = wingC;
      ctx.beginPath();
      ctx.ellipse(s * 0.196 * H, -0.55 * H, 0.03 * H, 0.052 * H, s * 0.28, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#2c2620';
      ctx.lineWidth = 0.009 * H;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(s * 0.2 * H, -0.518 * H);
        ctx.lineTo(s * (0.21 * H + i * 0.011 * H), -0.485 * H);
        ctx.stroke();
      }
    }

    // —— 头：长发 + 羽耳 + 人相
    const hcx = 0;
    const hcy = -0.79 * H;
    const hr = 0.062 * H;
    // 长发（脑后一团 + 两侧垂到肩的发束）：只有脑后一团时，远看是个"圆脑袋鸡蛋"
    ctx.fillStyle = hairC;
    ctx.beginPath();
    ctx.ellipse(hcx, hcy + hr * 0.62, hr * 1.34, hr * 1.5, 0, 0, TAU);
    ctx.fill();
    for (const s2 of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(hcx + s2 * hr * 0.72, hcy - hr * 0.55);
      ctx.quadraticCurveTo(hcx + s2 * hr * 1.5, hcy + hr * 0.35, hcx + s2 * hr * 1.16, hcy + hr * 1.6);
      ctx.quadraticCurveTo(hcx + s2 * hr * 0.9, hcy + hr * 0.9, hcx + s2 * hr * 0.6, hcy + hr * 0.3);
      ctx.closePath();
      ctx.fill();
    }
    // 脸
    ctx.fillStyle = mix(skinC, '#ffffff', 0.35);
    ctx.beginPath();
    ctx.ellipse(hcx, hcy, hr * 0.82, hr, 0, 0, TAU);
    ctx.fill();
    // 刘海
    ctx.fillStyle = hairC;
    ctx.beginPath();
    ctx.ellipse(hcx, hcy - hr * 0.5, hr * 0.95, hr * 0.66, 0, Math.PI * 0.92, Math.PI * 2.08);
    ctx.fill();
    // 羽耳（两撮向上斜的羽尖）
    ctx.fillStyle = wingC;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(hcx + s * hr * 0.6, hcy - hr * 0.55);
      ctx.quadraticCurveTo(hcx + s * hr * 1.5, hcy - hr * 1.35, hcx + s * hr * 1.62, hcy - hr * 1.05);
      ctx.quadraticCurveTo(hcx + s * hr * 1.05, hcy - hr * 0.6, hcx + s * hr * 0.72, hcy - hr * 0.2);
      ctx.closePath();
      ctx.fill();
    }
    // 眼（琥珀）
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#e0a33c';
      ctx.beginPath();
      ctx.ellipse(hcx + s * hr * 0.31, hcy - hr * 0.02, hr * 0.16, hr * 0.13, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#2a1f18';
      ctx.beginPath();
      ctx.arc(hcx + s * hr * 0.31, hcy - hr * 0.02, hr * 0.065, 0, TAU);
      ctx.fill();
    }
    // 眉 + 嘴角（参考图是那种不太好惹的神情）
    ctx.strokeStyle = 'rgba(120,96,70,0.8)';
    ctx.lineWidth = 0.008 * H;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(hcx + s * hr * 0.12, hcy - hr * 0.3);
      ctx.lineTo(hcx + s * hr * 0.48, hcy - hr * 0.22);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(150,100,90,0.85)';
    ctx.beginPath();
    ctx.moveTo(hcx - hr * 0.14, hcy + hr * 0.42);
    ctx.quadraticCurveTo(hcx, hcy + hr * 0.5, hcx + hr * 0.16, hcy + hr * 0.4);
    ctx.stroke();
    // 小鼻
    ctx.strokeStyle = 'rgba(150,110,90,0.6)';
    ctx.beginPath();
    ctx.moveTo(hcx, hcy + hr * 0.12);
    ctx.lineTo(hcx + hr * 0.06, hcy + hr * 0.28);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * 郊狼（参考图：四足、竖耳、黑尖大尾、琥珀眼）。
   * 原来是"人形躯干 + 狼头 + 尾巴"，最不像；现在整只四足重画。
   * 视角 3/4 正面：躯干在后、头前探、四条腿交替抬。
   * 第二版调了比例 —— 第一版躯干太圆、腿太细，远看像一张"桌子"。
   */
  _fgCoyote(ctx, H, e, col, dark) {
    const t = this.time * 5.2 + (e.phase || 0);
    const bob = Math.abs(Math.sin(t)) * 0.018 * H;
    const fur = col;
    const furD = mix(col, '#000000', 0.34);
    const furL = mix(col, '#ffffff', 0.32);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.27 * H, 0.05 * H, 0, 0, TAU);
    ctx.fill();

    ctx.translate(0, -bob);

    // —— 尾巴：粗、翘起、黑尖
    const wag = Math.sin(t * 0.7) * 0.05 * H;
    ctx.strokeStyle = furD;
    ctx.lineWidth = 0.085 * H;
    ctx.beginPath();
    ctx.moveTo(-0.05 * H, -0.44 * H);
    ctx.quadraticCurveTo(-0.23 * H + wag, -0.46 * H, -0.29 * H + wag * 1.4, -0.6 * H);
    ctx.stroke();
    ctx.fillStyle = '#2b2622';
    ctx.beginPath();
    ctx.ellipse(-0.29 * H + wag * 1.4, -0.605 * H, 0.055 * H, 0.04 * H, 0.55, 0, TAU);
    ctx.fill();

    // —— 后腿：大腿粗、后踝细（两段画，才有"犬科后腿"的折角）
    for (const s of [-1, 1]) {
      const lift = Math.max(0, Math.sin(t + s * 0.6)) * 0.045 * H;
      const hockX = s * 0.2 * H;
      const pawX = s * 0.17 * H;
      ctx.strokeStyle = furD;
      ctx.lineWidth = 0.082 * H;
      ctx.beginPath();
      ctx.moveTo(s * 0.11 * H, -0.44 * H);
      ctx.quadraticCurveTo(s * 0.2 * H, -0.34 * H, hockX, -0.24 * H - lift);
      ctx.stroke();
      ctx.lineWidth = 0.05 * H;
      ctx.beginPath();
      ctx.moveTo(hockX, -0.24 * H - lift);
      ctx.quadraticCurveTo(pawX + s * 0.01 * H, -0.12 * H - lift, pawX, -0.02 * H - lift);
      ctx.stroke();
      ctx.fillStyle = furD;
      ctx.beginPath();
      ctx.ellipse(pawX, -0.018 * H - lift, 0.045 * H, 0.021 * H, 0, 0, TAU);
      ctx.fill();
    }

    // —— 躯干：前胸高、后腰低的斜面（不是正圆）
    ctx.fillStyle = fur;
    ctx.beginPath();
    ctx.moveTo(-0.24 * H, -0.44 * H);
    ctx.quadraticCurveTo(-0.2 * H, -0.58 * H, 0.02 * H, -0.58 * H);
    ctx.quadraticCurveTo(0.22 * H, -0.57 * H, 0.26 * H, -0.44 * H);
    ctx.quadraticCurveTo(0.2 * H, -0.32 * H, 0, -0.32 * H);
    ctx.quadraticCurveTo(-0.2 * H, -0.32 * H, -0.24 * H, -0.44 * H);
    ctx.closePath();
    ctx.fill();
    // 肩胛鼓包
    ctx.fillStyle = mix(fur, '#ffffff', 0.08);
    ctx.beginPath();
    ctx.ellipse(0.08 * H, -0.53 * H, 0.11 * H, 0.075 * H, -0.15, 0, TAU);
    ctx.fill();
    // 背脊深色 + 腹部浅色
    ctx.strokeStyle = furD;
    ctx.lineWidth = 0.035 * H;
    ctx.beginPath();
    ctx.moveTo(-0.14 * H, -0.55 * H);
    ctx.quadraticCurveTo(0.02 * H, -0.585 * H, 0.16 * H, -0.54 * H);
    ctx.stroke();
    ctx.fillStyle = furL;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.ellipse(0.01 * H, -0.37 * H, 0.19 * H, 0.055 * H, -0.02, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    // —— 前腿
    for (const s of [-1, 1]) {
      const lift = Math.max(0, Math.sin(t + s * 0.6 + Math.PI)) * 0.045 * H;
      const pawX = s * 0.13 * H;
      ctx.strokeStyle = fur;
      ctx.lineWidth = 0.072 * H;
      ctx.beginPath();
      ctx.moveTo(s * 0.12 * H, -0.5 * H);
      ctx.quadraticCurveTo(s * 0.16 * H, -0.34 * H, pawX, -0.2 * H - lift);
      ctx.stroke();
      ctx.lineWidth = 0.052 * H;
      ctx.beginPath();
      ctx.moveTo(pawX, -0.2 * H - lift);
      ctx.quadraticCurveTo(pawX - s * 0.004 * H, -0.1 * H - lift, pawX - s * 0.008 * H, -0.02 * H - lift);
      ctx.stroke();
      ctx.fillStyle = fur;
      ctx.beginPath();
      ctx.ellipse(pawX - s * 0.008 * H, -0.018 * H - lift, 0.044 * H, 0.02 * H, 0, 0, TAU);
      ctx.fill();
    }

    // —— 脖子：从胸口往前上探
    ctx.strokeStyle = fur;
    ctx.lineWidth = 0.12 * H;
    ctx.beginPath();
    ctx.moveTo(0.06 * H, -0.52 * H);
    ctx.quadraticCurveTo(0.1 * H, -0.62 * H, 0.09 * H, -0.68 * H);
    ctx.stroke();

    // —— 头（比上一版大一圈：远看"狼头"是整个剪影的关键）
    const hcx = 0.09 * H;
    const hcy = -0.7 * H;
    const hr = 0.105 * H;
    // 竖耳
    for (const s of [-1, 1]) {
      ctx.fillStyle = furD;
      ctx.beginPath();
      ctx.moveTo(hcx + s * hr * 0.4, hcy - hr * 0.55);
      ctx.lineTo(hcx + s * hr * 0.86, hcy - hr * 1.9);
      ctx.lineTo(hcx + s * hr * 1.02, hcy - hr * 0.45);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(235,200,175,0.5)';
      ctx.beginPath();
      ctx.moveTo(hcx + s * hr * 0.5, hcy - hr * 0.6);
      ctx.lineTo(hcx + s * hr * 0.82, hcy - hr * 1.55);
      ctx.lineTo(hcx + s * hr * 0.88, hcy - hr * 0.52);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = fur;
    ctx.beginPath();
    ctx.ellipse(hcx, hcy, hr * 1.05, hr * 0.94, 0, 0, TAU);
    ctx.fill();
    // 吻部
    ctx.fillStyle = furL;
    ctx.beginPath();
    ctx.moveTo(hcx - hr * 0.3, hcy + hr * 0.12);
    ctx.quadraticCurveTo(hcx + hr * 0.26, hcy + hr * 1.2, hcx + hr * 0.66, hcy + hr * 0.88);
    ctx.quadraticCurveTo(hcx + hr * 0.72, hcy + hr * 0.32, hcx + hr * 0.36, hcy + hr * 0.04);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#2b2622';
    ctx.beginPath();
    ctx.ellipse(hcx + hr * 0.55, hcy + hr * 0.85, hr * 0.17, hr * 0.12, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,30,24,0.6)';
    ctx.lineWidth = 0.008 * H;
    ctx.beginPath();
    ctx.moveTo(hcx + hr * 0.52, hcy + hr * 0.96);
    ctx.lineTo(hcx + hr * 0.2, hcy + hr * 1.08);
    ctx.stroke();
    // 眼
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#e8b04a';
      ctx.beginPath();
      ctx.ellipse(hcx + s * hr * 0.42, hcy - hr * 0.08, hr * 0.18, hr * 0.14, s * 0.2, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#241c14';
      ctx.beginPath();
      ctx.ellipse(hcx + s * hr * 0.42, hcy - hr * 0.08, hr * 0.06, hr * 0.12, 0, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * 头顶冒粉色爱心（用户 m11097）。
   *   花仙子在场 → 兽人冒爱心；勇者在场 → 鹰身女妖冒爱心。
   * 做成"升起 → 左右轻晃 → 淡出"的循环，三颗相位错开，永远不会同时出现。
   * 注意：这里用的是当前实体变换（原点在脚底），所以坐标都是相对头顶算的。
   */
  _charmHearts(ctx, H, e) {
    const baseY = e.animal === 'coyote' ? -0.8 * H : e.animal === 'harpy' ? -1.02 * H : -1.0 * H;
    for (let i = 0; i < 3; i++) {
      const ph = (this.time * 0.5 + i * 0.34 + (e.phase || 0)) % 1;
      const a = ph < 0.12 ? ph / 0.12 : ph > 0.7 ? (1 - ph) / 0.3 : 1;
      if (a <= 0.03) continue;
      const x = Math.sin(ph * 6.283 + i * 1.7) * H * 0.06;
      const y = baseY - ph * H * 0.3;
      const s = H * (0.03 + 0.012 * Math.sin(ph * Math.PI));
      ctx.save();
      ctx.globalAlpha = a * 0.95;
      ctx.translate(x, y);
      ctx.scale(s, s);
      ctx.fillStyle = '#ff86c0';
      ctx.beginPath();
      ctx.moveTo(0, 1.0);
      ctx.bezierCurveTo(-1.55, -0.15, -0.8, -1.3, 0, -0.5);
      ctx.bezierCurveTo(0.8, -1.3, 1.55, -0.15, 0, 1.0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,244,250,0.9)';
      ctx.beginPath();
      ctx.ellipse(-0.34, -0.46, 0.2, 0.13, -0.5, 0, 6.283);
      ctx.fill();
      ctx.restore();
    }
    // 一层极淡的粉雾，让"头顶有东西"在远处也看得见
    this._drawGlow(0, baseY - H * 0.12, H * 0.22, '#ff9fd0', 0.16);
  }

  /**
   * 第四关「穿越异世界」的怪物部件（用户 m04749）。
   * 和 _pvzBits / _oceanBits 一样：身体骨架仍由 _zombieBody 画，这里只往
   * 头/背/手上挂"这件事物之所以是它"的部件 ——
   *   goblin 哥布林（walker / shielded）：尖耳 + 木棒（盾兵再加一顶锈铁盔）
   *   coyote 郊狼（runner）：狼吻 + 耳朵 + 大尾巴
   *   orc 兽人（brute）：獠牙 + 肩甲 + 大斧
   *   harpy 鹰身女妖（spitter）：羽毛翅膀 + 喙 + 爪
   *   slime 史莱姆（splitter）：把下半身盖成果冻
   *   dragon 恶龙（boss）：龙翼 + 龙角 + 长吻 + 尾巴
   */
  _fantasyBits(ctx, H, e, col, dark) {
    const a = e.animal;
    // 这四只已经整只重绘（见 _fantasyBody），再叠通用部件就会长出"两对耳朵"。
    if (a === 'goblin' || a === 'orc' || a === 'harpy' || a === 'coyote') return;
    const headY = -0.815 * H;
    const headR = 0.11 * H;
    const t = this.time * 2.4 + (e.phase || 0);
    const F = (CFG.theme && CFG.theme.fantasy) || {};

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (a === 'goblin') {
      // 尖耳朵（哥布林最好认的特征）
      ctx.fillStyle = mix(col, '#000000', 0.24);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * headR * 0.7, headY - headR * 0.15);
        ctx.quadraticCurveTo(s * headR * 2.5, headY - headR * 1.0, s * headR * 2.7, headY - headR * 1.9);
        ctx.quadraticCurveTo(s * headR * 1.5, headY - headR * 0.9, s * headR * 0.5, headY + headR * 0.35);
        ctx.closePath();
        ctx.fill();
      }
      // 木棒：一只手往前抡（随走路摆）。做成"上粗下细 + 三个疙瘩 + 高光"的狼牙棒，
      // 一根等粗的线加一个椭圆近看就是"拿了个苍蝇拍"。
      const sw = Math.sin(t) * 0.05 * H;
      const cx0 = 0.15 * H;
      const cy0 = -0.47 * H + sw;
      const cx1 = 0.3 * H;
      const cy1 = -0.92 * H + sw;
      const wood = F.stoneA || '#7a5a34';
      const cg = ctx.createLinearGradient(cx0 - 0.05 * H, cy0, cx1 + 0.05 * H, cy1);
      cg.addColorStop(0, mix(wood, '#000000', 0.35));
      cg.addColorStop(0.45, wood);
      cg.addColorStop(1, mix(wood, '#ffffff', 0.3));
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.moveTo(cx0 - 0.016 * H, cy0);
      ctx.lineTo(cx1 - 0.042 * H, cy1);
      ctx.quadraticCurveTo(cx1 + 0.005 * H, cy1 - 0.03 * H, cx1 + 0.05 * H, cy1 + 0.01 * H);
      ctx.lineTo(cx0 + 0.016 * H, cy0 + 0.02 * H);
      ctx.closePath();
      ctx.fill();
      // 疙瘩
      ctx.fillStyle = mix(wood, '#000000', 0.15);
      for (let i = 0; i < 3; i++) {
        const k = 0.62 + i * 0.16;
        ctx.beginPath();
        ctx.arc(cx0 + (cx1 - cx0) * k + 0.02 * H, cy0 + (cy1 - cy0) * k - 0.02 * H, 0.017 * H, 0, TAU);
        ctx.fill();
      }
      // 缠绳握把
      ctx.strokeStyle = '#4a3320';
      ctx.lineWidth = 0.012 * H;
      for (let i = 0; i < 3; i++) {
        const k = 0.06 + i * 0.1;
        ctx.beginPath();
        ctx.moveTo(cx0 + (cx1 - cx0) * k - 0.02 * H, cy0 + (cy1 - cy0) * k + 0.012 * H);
        ctx.lineTo(cx0 + (cx1 - cx0) * k + 0.02 * H, cy0 + (cy1 - cy0) * k - 0.012 * H);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,232,190,0.3)';
      ctx.lineWidth = 0.008 * H;
      ctx.beginPath();
      ctx.moveTo(cx0 + 0.008 * H, cy0 - 0.01 * H);
      ctx.lineTo(cx1 + 0.03 * H, cy1 + 0.005 * H);
      ctx.stroke();
      // 破布腰带
      ctx.fillStyle = mix(dark, '#000000', 0.25);
      ctx.beginPath();
      ctx.moveTo(-0.11 * H, -0.42 * H);
      ctx.lineTo(0.11 * H, -0.42 * H);
      ctx.lineTo(0.09 * H, -0.28 * H);
      ctx.lineTo(-0.09 * H, -0.28 * H);
      ctx.closePath();
      ctx.fill();
      if (e.maxShield > 0) {
        // 持盾哥布林：头上一顶锈铁盔
        ctx.fillStyle = '#8a8f7a';
        ctx.beginPath();
        ctx.arc(0, headY - headR * 0.15, headR * 1.22, Math.PI * 1.02, Math.PI * 1.98);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(40,44,30,0.7)';
        ctx.lineWidth = 0.012 * H;
        ctx.stroke();
      }
    } else if (a === 'coyote') {
      // 狼吻 + 尖耳 + 大尾巴
      ctx.fillStyle = mix(col, '#ffffff', 0.1);
      ctx.beginPath();
      ctx.moveTo(-headR * 0.34, headY + headR * 0.1);
      ctx.lineTo(headR * 0.7, headY + headR * 0.28);
      ctx.lineTo(headR * 0.62, headY + headR * 0.62);
      ctx.lineTo(-headR * 0.3, headY + headR * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#2c2420';
      ctx.beginPath();
      ctx.arc(headR * 0.66, headY + headR * 0.32, headR * 0.14, 0, TAU);
      ctx.fill();
      ctx.fillStyle = mix(col, '#000000', 0.3);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * headR * 0.5, headY - headR * 0.7);
        ctx.lineTo(s * headR * 1.0, headY - headR * 1.75);
        ctx.lineTo(s * headR * 1.25, headY - headR * 0.65);
        ctx.closePath();
        ctx.fill();
      }
      // 尾巴：从身后翘起来，随走路左右摆
      const wag = Math.sin(t * 1.2) * 0.06 * H;
      ctx.strokeStyle = mix(col, '#000000', 0.18);
      ctx.lineWidth = 0.07 * H;
      ctx.beginPath();
      ctx.moveTo(-0.1 * H, -0.5 * H);
      ctx.quadraticCurveTo(-0.34 * H, -0.62 * H + wag, -0.3 * H, -0.95 * H + wag);
      ctx.stroke();
      ctx.fillStyle = mix(col, '#ffffff', 0.28);
      ctx.beginPath();
      ctx.arc(-0.3 * H, -0.95 * H + wag, 0.055 * H, 0, TAU);
      ctx.fill();
    } else if (a === 'orc') {
      // 獠牙：从下颌往上翘，带一点牙釉质的高光
      for (const s of [-1, 1]) {
        ctx.fillStyle = '#f2ecd8';
        ctx.beginPath();
        ctx.moveTo(s * headR * 0.28, headY + headR * 0.62);
        ctx.lineTo(s * headR * 0.5, headY + headR * 1.15);
        ctx.lineTo(s * headR * 0.62, headY + headR * 0.55);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        ctx.moveTo(s * headR * 0.3, headY + headR * 0.66);
        ctx.lineTo(s * headR * 0.44, headY + headR * 1.0);
        ctx.lineTo(s * headR * 0.5, headY + headR * 0.66);
        ctx.closePath();
        ctx.fill();
      }
      // 肩甲：圆盖 + 顶面高光 + 两颗铆钉（原来是两块灰方片，近看像贴了两张纸）
      for (const s of [-1, 1]) {
        const px = s * 0.24 * H;
        const py = -0.68 * H;
        const g2 = ctx.createRadialGradient(px - 0.05 * H, py - 0.07 * H, 0.01 * H, px, py, 0.17 * H);
        g2.addColorStop(0, mix(F.stoneB || '#5f6b52', '#ffffff', 0.45));
        g2.addColorStop(0.55, F.stoneB || '#5f6b52');
        g2.addColorStop(1, mix(dark, '#000000', 0.45));
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.ellipse(px, py, 0.135 * H, 0.1 * H, s * 0.22, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = mix(dark, '#000000', 0.55);
        ctx.lineWidth = 0.012 * H;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.beginPath();
        ctx.ellipse(px - 0.02 * H, py - 0.035 * H, 0.075 * H, 0.028 * H, s * 0.22, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(40,36,26,0.7)';
        for (const k of [-0.045, 0.045]) {
          ctx.beginPath();
          ctx.arc(px + k * H, py + 0.045 * H, 0.011 * H, 0, TAU);
          ctx.fill();
        }
      }
      // 大斧：木柄带锥度和缠绳，斧头是月牙刃 + 背刺（第一版是一块方片，远看像举着块牌子）
      const ax = Math.sin(t) * 0.02 * H;
      const handX = 0.0 * H;
      const handY = -0.6 * H + ax;
      const headX = 0.3 * H;
      const headY2 = -1.14 * H + ax;
      ctx.strokeStyle = '#6b4a2a';
      ctx.lineWidth = 0.03 * H;
      ctx.beginPath();
      ctx.moveTo(handX, handY);
      ctx.lineTo(headX, headY2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,225,180,0.28)';
      ctx.lineWidth = 0.01 * H;
      ctx.beginPath();
      ctx.moveTo(handX + 0.012 * H, handY - 0.005 * H);
      ctx.lineTo(headX + 0.012 * H, headY2 + 0.005 * H);
      ctx.stroke();
      // 缠绳
      ctx.strokeStyle = '#4a3320';
      ctx.lineWidth = 0.012 * H;
      for (let i = 0; i < 3; i++) {
        const k = 0.28 + i * 0.1;
        ctx.beginPath();
        ctx.moveTo(handX + (headX - handX) * k - 0.022 * H, handY + (headY2 - handY) * k + 0.012 * H);
        ctx.lineTo(handX + (headX - handX) * k + 0.022 * H, handY + (headY2 - handY) * k - 0.012 * H);
        ctx.stroke();
      }
      // 刃面：金属渐变
      // 出图发现整把斧头（0.23H×0.66H 的亮金属）比兽人本身还抢眼、远看像举着面帆，
      // 所以刃头整体缩到 0.66 倍再画（锚点在斧头根部，缩放不会让它离开斧柄）。
      ctx.save();
      ctx.translate(headX, headY2);
      ctx.scale(0.66, 0.66);
      ctx.translate(-headX, -headY2);
      const mg = ctx.createLinearGradient(headX - 0.16 * H, headY2 + 0.16 * H, headX + 0.06 * H, headY2 - 0.02 * H);
      mg.addColorStop(0, '#f2f7fb');
      mg.addColorStop(0.42, '#b9c6d2');
      mg.addColorStop(0.72, '#7d8b98');
      mg.addColorStop(1, '#4e5a66');
      ctx.fillStyle = mg;
      ctx.beginPath();
      ctx.moveTo(headX - 0.03 * H, headY2 - 0.03 * H);
      ctx.quadraticCurveTo(headX + 0.1 * H, headY2 - 0.14 * H, headX + 0.2 * H, headY2 - 0.05 * H);
      ctx.quadraticCurveTo(headX + 0.23 * H, headY2 + 0.14 * H, headX + 0.22 * H, headY2 + 0.3 * H);
      ctx.quadraticCurveTo(headX + 0.12 * H, headY2 + 0.22 * H, headX + 0.02 * H, headY2 + 0.36 * H);
      ctx.quadraticCurveTo(headX - 0.02 * H, headY2 + 0.14 * H, headX - 0.03 * H, headY2 - 0.03 * H);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(46,56,66,0.85)';
      ctx.lineWidth = 0.012 * H;
      ctx.stroke();
      // 开刃高光：沿刃口一条亮线
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 0.014 * H;
      ctx.beginPath();
      ctx.moveTo(headX + 0.19 * H, headY2 - 0.04 * H);
      ctx.quadraticCurveTo(headX + 0.225 * H, headY2 + 0.14 * H, headX + 0.21 * H, headY2 + 0.29 * H);
      ctx.stroke();
      // 背刺
      ctx.fillStyle = '#5e6a76';
      ctx.beginPath();
      ctx.moveTo(headX - 0.03 * H, headY2 + 0.0 * H);
      ctx.lineTo(headX - 0.15 * H, headY2 + 0.14 * H);
      ctx.lineTo(headX - 0.02 * H, headY2 + 0.2 * H);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(46,56,66,0.8)';
      ctx.lineWidth = 0.01 * H;
      ctx.stroke();
      ctx.restore();
    } else if (a === 'harpy') {
      // 羽毛翅膀（三层羽片）+ 喙 + 爪。
      // 注意：翅膀别画太大 —— 第一版 spread 到 0.94H（左右各一张身高的翅膀），
      // 凑近看像一只挂在天上的紫色滑翔翼；收到 0.62H 并把羽尖往下收才对。
      const flap = Math.sin(t * 1.6) * 0.16;
      for (const s of [-1, 1]) {
        // 指羽：四根扇形排开、越外侧越长越下垂 —— 分成四片才看得出是"羽毛翅膀"，
        // 三层同心弧会糊成一整片紫滑翔翼（第一版就是这样）。
        for (let i = 0; i < 4; i++) {
          const spread = 0.3 + i * 0.1;
          const droop = 0.02 + i * 0.075;
          const w = 0.52 - i * 0.06;
          ctx.fillStyle =
            i === 3
              ? mix(col, '#ffffff', 0.3)
              : i === 2
                ? mix(col, '#ffffff', 0.12)
                : i === 0
                  ? mix(col, '#000000', 0.2)
                  : col;
          ctx.beginPath();
          ctx.moveTo(s * 0.07 * H, -0.72 * H);
          ctx.quadraticCurveTo(
            s * spread * H * w,
            -0.94 * H - flap * 0.5 * H,
            s * spread * H,
            (-0.66 + droop) * H + flap * 0.3 * H,
          );
          ctx.quadraticCurveTo(s * spread * H * 0.4, (-0.7 + droop * 0.5) * H - flap * 0.2 * H, s * 0.06 * H, -0.64 * H);
          ctx.closePath();
          ctx.fill();
        }
        // 覆羽：肩上一小块，把四根羽根盖住
        ctx.fillStyle = mix(col, '#ffffff', 0.2);
        ctx.beginPath();
        ctx.moveTo(s * 0.04 * H, -0.74 * H);
        ctx.quadraticCurveTo(s * 0.2 * H, -0.78 * H, s * 0.2 * H, -0.66 * H);
        ctx.quadraticCurveTo(s * 0.12 * H, -0.6 * H, s * 0.04 * H, -0.62 * H);
        ctx.closePath();
        ctx.fill();
      }
      // 尾羽：几片从腰后往下垂
      ctx.fillStyle = mix(col, '#000000', 0.24);
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 0.05 * H, -0.34 * H);
        ctx.lineTo(i * 0.1 * H + 0.02 * H, -0.06 * H + Math.abs(i) * 0.03 * H);
        ctx.lineTo(i * 0.05 * H + 0.05 * H, -0.32 * H);
        ctx.closePath();
        ctx.fill();
      }
      // 头（正对玩家）：把通用僵尸头整个盖掉，换成鸟头 —— 顶羽 + 面盘 + 钩喙
      // 为什么必须盖：通用头是"圆球 + 两只发光眼"，鹰身女妖凑近看就变成紫色雪人。
      const faceY = headY;
      const hg = ctx.createRadialGradient(-headR * 0.3, faceY - headR * 0.5, headR * 0.1, 0, faceY, headR * 1.7);
      hg.addColorStop(0, mix(col, '#ffffff', 0.3));
      hg.addColorStop(0.6, col);
      hg.addColorStop(1, mix(dark, '#000000', 0.25));
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.ellipse(0, faceY, headR * 1.18, headR * 1.1, 0, 0, TAU);
      ctx.fill();
      // 颈羽：一圈锯齿领子，把头和人身子接上
      ctx.fillStyle = mix(col, '#ffffff', 0.16);
      ctx.beginPath();
      ctx.moveTo(-headR * 1.1, faceY + headR * 0.75);
      for (let i = 0; i < 5; i++) {
        const x0 = -headR * 1.1 + (i + 0.5) * (headR * 2.2 / 5) * 1.0;
        ctx.lineTo(x0, faceY + headR * 1.35);
        ctx.lineTo(x0 + headR * 0.2, faceY + headR * 0.72);
      }
      ctx.lineTo(headR * 1.1, faceY + headR * 0.8);
      ctx.closePath();
      ctx.fill();
      // 顶羽：三根往后翘的羽冠
      ctx.fillStyle = mix(col, '#000000', 0.3);
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i * headR * 0.3, faceY - headR * 0.95);
        ctx.quadraticCurveTo(i * headR * 0.75, faceY - headR * 1.85, i * headR * 0.35, faceY - headR * 2.15);
        ctx.quadraticCurveTo(i * headR * 0.35, faceY - headR * 1.5, i * headR * 0.05, faceY - headR * 0.95);
        ctx.closePath();
        ctx.fill();
      }
      // 面盘：浅色的一圈，鸟脸的味道全在这里
      ctx.fillStyle = mix(col, '#ffffff', 0.45);
      ctx.beginPath();
      ctx.ellipse(0, faceY + headR * 0.12, headR * 0.78, headR * 0.72, 0, 0, TAU);
      ctx.fill();
      // 眼睛：琥珀色 + 竖瞳 + 高光点
      for (const s of [-1, 1]) {
        const ex = s * headR * 0.42;
        const ey = faceY + headR * 0.02;
        ctx.fillStyle = '#2a1a10';
        ctx.beginPath();
        ctx.ellipse(ex, ey, headR * 0.3, headR * 0.27, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#ffc23a';
        ctx.beginPath();
        ctx.ellipse(ex, ey, headR * 0.24, headR * 0.22, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#241409';
        ctx.beginPath();
        ctx.ellipse(ex, ey, headR * 0.09, headR * 0.19, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.arc(ex - headR * 0.09, ey - headR * 0.09, headR * 0.07, 0, TAU);
        ctx.fill();
      }
      // 喙：上喙带钩 + 下喙 + 鼻孔
      ctx.fillStyle = '#f0b02c';
      ctx.beginPath();
      ctx.moveTo(-headR * 0.26, faceY + headR * 0.34);
      ctx.quadraticCurveTo(0, faceY + headR * 0.22, headR * 0.26, faceY + headR * 0.34);
      ctx.lineTo(headR * 0.1, faceY + headR * 0.78);
      ctx.quadraticCurveTo(0, faceY + headR * 1.02, -headR * 0.1, faceY + headR * 0.78);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(122,74,10,0.75)';
      ctx.lineWidth = 0.012 * H;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(-headR * 0.05, faceY + headR * 0.42, headR * 0.1, headR * 0.16, 0.2, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#8a5a12';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * headR * 0.11, faceY + headR * 0.4, headR * 0.035, 0, TAU);
        ctx.fill();
      }
      // 爪：三趾 + 黑色趾甲
      for (let i = -1; i <= 1; i++) {
        const tx = i * 0.055 * H;
        ctx.strokeStyle = '#e0a020';
        ctx.lineWidth = 0.016 * H;
        ctx.beginPath();
        ctx.moveTo(tx, -0.045 * H);
        ctx.lineTo(tx + i * 0.02 * H, -0.005 * H);
        ctx.stroke();
        ctx.fillStyle = '#2a2118';
        ctx.beginPath();
        ctx.moveTo(tx + i * 0.02 * H - 0.011 * H, -0.005 * H);
        ctx.lineTo(tx + i * 0.02 * H + 0.012 * H, -0.002 * H);
        ctx.lineTo(tx + i * 0.02 * H, 0.024 * H);
        ctx.closePath();
        ctx.fill();
      }
    } else if (a === 'slime') {
      // 果冻身体：整个盖住通用身子和头（第一版把头留在外面，看着像"绿果冻里插了个雪人"）
      const wob = Math.sin(t * 1.4) * 0.02 * H;
      const wob2 = Math.sin(t * 1.1 + 1.7) * 0.015 * H;
      const topY = -0.99 * H - wob;
      const halfW = 0.315 * H + wob2 * 0.5;
      const sg = ctx.createLinearGradient(0, topY, 0, 0);
      sg.addColorStop(0, mix(col, '#ffffff', 0.42));
      sg.addColorStop(0.45, col);
      sg.addColorStop(1, mix(col, '#000000', 0.3));
      ctx.globalAlpha = 0.84;
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.moveTo(-halfW, 0);
      // 侧面带一点鼓包，不是标准椭圆
      ctx.bezierCurveTo(-halfW * 1.12, -0.42 * H, -halfW * 0.86, -0.72 * H, -0.12 * H, topY);
      ctx.bezierCurveTo(0.1 * H, topY - 0.03 * H, halfW * 0.8, -0.74 * H, halfW * 0.96, -0.4 * H);
      ctx.bezierCurveTo(halfW * 1.06, -0.18 * H, halfW, -0.05 * H, halfW, 0);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // 底部一圈滴落的小鼓包
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = mix(col, '#000000', 0.12);
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.ellipse(i * 0.16 * H, -0.02 * H, 0.075 * H, 0.035 * H, 0, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // 内部气泡
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = mix(col, '#ffffff', 0.65);
      for (const [bx, by, br] of [
        [-0.12 * H, -0.5 * H, 0.035 * H],
        [0.13 * H, -0.3 * H, 0.026 * H],
        [-0.05 * H, -0.68 * H, 0.02 * H],
      ]) {
        ctx.beginPath();
        ctx.arc(bx + wob * 0.5, by, br, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // 核（史莱姆的"心脏"，也是它分裂的种子）
      ctx.fillStyle = F.slimeCore || '#1f6b5c';
      ctx.beginPath();
      ctx.ellipse(0, -0.36 * H, 0.1 * H, 0.13 * H, 0, 0, TAU);
      ctx.fill();
      // 眼睛：果冻里的两个亮点，凑近看才像生物
      for (const s of [-1, 1]) {
        ctx.fillStyle = 'rgba(14,32,26,0.9)';
        ctx.beginPath();
        ctx.ellipse(s * 0.105 * H, -0.52 * H, 0.045 * H, 0.055 * H, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#eaffe6';
        ctx.beginPath();
        ctx.arc(s * 0.095 * H, -0.545 * H, 0.018 * H, 0, TAU);
        ctx.fill();
      }
      // 高光：左上大 + 右下小（一颗就够，两颗才有"透明"的感觉）
      ctx.globalAlpha = 0.62;
      ctx.fillStyle = mix(col, '#ffffff', 0.75);
      ctx.beginPath();
      ctx.ellipse(-0.14 * H, -0.66 * H, 0.09 * H, 0.055 * H, -0.55, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.34;
      ctx.beginPath();
      ctx.ellipse(0.15 * H, -0.2 * H, 0.035 * H, 0.05 * H, 0.4, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (a === 'dragon') {
      // 恶龙（BOSS）。第一版出图像"南瓜插两根天线"：圆脑袋 + 细角 + 一大坨没有细节的身体。
      // 这里按参考图的思路重画一只低伏前扑的龙：
      //   高扬的膜翅（后缘三个扇贝 + 四根指骨 + 翼尖爪）
      //   → 甩到画面左侧的长尾（带背棘 + 剑状尾锤）
      //   → 桶状胸的躯干（月光左上打光，边缘一圈冷高光）
      //   → 胸腹甲（五片暖金色横板，让"正面一大块暗红"有层次）
      //   → 前伸的粗壮前肢（三根骨爪，离身体有暗缝，不然会糊成一坨）
      //   → 粗脖颈 + 颈背棘刺
      //   → 楔形长吻的头骨（压低的眉骨 + 橙色火光眼 + 鼻孔 + 上下獠牙）
      //   → 后掠的双角（带三道棱）
      const flap = Math.sin(t * 0.9) * 0.22;
      const breathe = 1 + Math.sin(t * 1.5) * 0.012;
      const bone = F.dragonBelly || '#e8c07a';
      const wingCol = F.dragonWing || '#6d2436';
      const fire = F.fire || '#ffb257';
      const fireCore = F.fireCore || '#fff0b0';
      const ink = mix(col, '#000000', 0.62);
      const rim = mix(col, '#cfe4ff', 0.4);

      // ---- 膜翅（在身体后面；要拱到肩膀上方才像翼，垂在身侧会看成"多长了一对手"）----
      for (const s of [-1, 1]) {
        const spread = 1.32;
        const sx0 = s * 0.18 * H;
        const sy0 = -0.92 * H;
        const tipX = s * spread * H;
        const tipY = -1.02 * H + flap * 0.22 * H;
        const wg = ctx.createLinearGradient(sx0, sy0, tipX, tipY);
        wg.addColorStop(0, mix(wingCol, '#000000', 0.42));
        wg.addColorStop(0.45, wingCol);
        wg.addColorStop(1, mix(col, '#ffc2cf', 0.55));
        ctx.fillStyle = wg;
        ctx.beginPath();
        ctx.moveTo(sx0, sy0);
        ctx.quadraticCurveTo(s * spread * H * 0.6, -1.92 * H - flap * 0.3 * H, tipX, tipY);
        ctx.quadraticCurveTo(s * spread * H * 0.8, tipY + 0.26 * H, s * spread * H * 0.54, -0.66 * H + flap * 0.1 * H);
        ctx.quadraticCurveTo(s * spread * H * 0.58, tipY + 0.42 * H, s * spread * H * 0.34, -0.56 * H + flap * 0.08 * H);
        ctx.quadraticCurveTo(s * spread * H * 0.34, tipY + 0.54 * H, s * 0.2 * H, -0.5 * H);
        ctx.closePath();
        ctx.fill();
        // 上缘月光勾边
        ctx.strokeStyle = mix(col, '#ffd9e2', 0.5);
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 0.016 * H;
        ctx.beginPath();
        ctx.moveTo(sx0, sy0);
        ctx.quadraticCurveTo(s * spread * H * 0.6, -1.92 * H - flap * 0.3 * H, tipX, tipY);
        ctx.stroke();
        ctx.globalAlpha = 1;
        // 指骨
        ctx.strokeStyle = mix(bone, '#000000', 0.5);
        ctx.lineWidth = 0.013 * H;
        ctx.lineCap = 'round';
        for (let k = 0; k < 4; k++) {
          const kk = k / 3;
          ctx.beginPath();
          ctx.moveTo(sx0, sy0 + 0.03 * H);
          ctx.quadraticCurveTo(
            s * spread * H * (0.38 + 0.12 * kk),
            -1.5 * H + 0.3 * H * kk - flap * 0.22 * H,
            s * spread * H * (0.58 + 0.4 * kk),
            tipY + (0.2 - 0.3 * kk) * H,
          );
          ctx.stroke();
        }
        // 翼尖爪
        ctx.fillStyle = mix(bone, '#000000', 0.28);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY - 0.03 * H);
        ctx.lineTo(tipX + s * 0.05 * H, tipY - 0.11 * H);
        ctx.lineTo(tipX + s * 0.08 * H, tipY + 0.02 * H);
        ctx.closePath();
        ctx.fill();
      }

      // ---- 长尾（甩到画面左侧，两根背棘 + 剑状尾锤）----
      const tail = Math.sin(t * 0.8) * 0.055 * H;
      ctx.lineCap = 'round';
      ctx.strokeStyle = mix(col, '#000000', 0.28);
      ctx.lineWidth = 0.2 * H;
      ctx.beginPath();
      ctx.moveTo(-0.08 * H, -0.34 * H);
      ctx.quadraticCurveTo(-0.5 * H, -0.42 * H + tail, -0.66 * H, -0.14 * H + tail);
      ctx.stroke();
      ctx.lineWidth = 0.11 * H;
      ctx.beginPath();
      ctx.moveTo(-0.62 * H, -0.18 * H + tail);
      ctx.quadraticCurveTo(-0.88 * H, -0.06 * H + tail, -1.0 * H, -0.3 * H + tail);
      ctx.stroke();
      ctx.fillStyle = mix(col, '#000000', 0.1);
      ctx.beginPath();
      ctx.moveTo(-1.0 * H, -0.32 * H + tail);
      ctx.lineTo(-1.12 * H, -0.46 * H + tail);
      ctx.lineTo(-1.1 * H, -0.2 * H + tail);
      ctx.lineTo(-1.22 * H, -0.3 * H + tail);
      ctx.lineTo(-1.1 * H, -0.1 * H + tail);
      ctx.lineTo(-1.0 * H, -0.2 * H + tail);
      ctx.closePath();
      ctx.fill();

      // ---- 躯干（桶状胸，月光从左上打）----
      const bodyG = ctx.createRadialGradient(-0.22 * H, -1.0 * H, 0.08 * H, 0, -0.72 * H, 0.9 * H);
      bodyG.addColorStop(0, mix(col, '#ffffff', 0.16));
      bodyG.addColorStop(0.45, col);
      bodyG.addColorStop(1, mix(col, '#000000', 0.42));
      ctx.fillStyle = bodyG;
      ctx.beginPath();
      ctx.moveTo(-0.34 * H, -0.06 * H);
      ctx.bezierCurveTo(-0.58 * H, -0.4 * H, -0.62 * H * breathe, -0.78 * H, -0.46 * H, -1.06 * H);
      ctx.bezierCurveTo(-0.24 * H, -1.26 * H, 0.24 * H, -1.26 * H, 0.46 * H, -1.06 * H);
      ctx.bezierCurveTo(0.62 * H * breathe, -0.78 * H, 0.58 * H, -0.4 * H, 0.34 * H, -0.06 * H);
      ctx.closePath();
      ctx.fill();
      // 边缘冷高光（月光勾边）
      ctx.strokeStyle = rim;
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = 0.02 * H;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // ---- 胸腹甲：一条上宽下窄的暖色腹板 + 五道横缝（原先是五片大椭圆，出图像一摞煎饼）----
      const belly = mix(bone, '#000000', 0.12);
      const bg2 = ctx.createLinearGradient(0, -1.02 * H, 0, -0.32 * H);
      bg2.addColorStop(0, mix(bone, '#ffffff', 0.16));
      bg2.addColorStop(0.6, belly);
      bg2.addColorStop(1, mix(belly, '#000000', 0.2));
      ctx.fillStyle = bg2;
      ctx.beginPath();
      ctx.moveTo(-0.3 * H, -1.04 * H);
      ctx.bezierCurveTo(-0.33 * H, -0.7 * H, -0.24 * H, -0.44 * H, -0.12 * H, -0.33 * H);
      ctx.lineTo(0.12 * H, -0.33 * H);
      ctx.bezierCurveTo(0.24 * H, -0.44 * H, 0.33 * H, -0.7 * H, 0.3 * H, -1.04 * H);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = mix(bone, '#000000', 0.5);
      ctx.lineWidth = 0.012 * H;
      for (let i = 0; i < 5; i++) {
        const k = i / 4;
        const y = -0.95 * H + i * 0.13 * H;
        const hw = (0.28 - 0.05 * k) * H;
        ctx.beginPath();
        ctx.moveTo(-hw, y);
        ctx.quadraticCurveTo(0, y + 0.045 * H, hw, y);
        ctx.stroke();
      }
      // ---- 鳞片：肩背到腰的几排月牙，让一大块暗红有肌理（只在够大的时候画）----
      if (H > 40) {
        ctx.lineWidth = 0.012 * H;
        for (let row = 0; row < 4; row++) {
          const y = -0.44 * H - row * 0.15 * H;
          const n = 6 - row;
          const hw = (0.5 - row * 0.05) * H;
          for (let i = 0; i < n; i++) {
            const x = -hw + ((i + 0.5) / n) * hw * 2;
            if (Math.abs(x) < 0.32 * H) continue; // 腹板上不画鳞
            ctx.strokeStyle = mix(col, '#000000', 0.38);
            ctx.beginPath();
            ctx.arc(x, y, 0.055 * H, 0.15 * Math.PI, 0.85 * Math.PI);
            ctx.stroke();
            ctx.strokeStyle = mix(col, '#ffffff', 0.14);
            ctx.beginPath();
            ctx.arc(x, y + 0.008 * H, 0.045 * H, 0.15 * Math.PI, 0.85 * Math.PI);
            ctx.stroke();
          }
        }
        // 下腹一道压暗，让躯干有"肉"的转折，不然是一整块平色
        const shade = ctx.createLinearGradient(0, -0.5 * H, 0, -0.05 * H);
        shade.addColorStop(0, 'rgba(0,0,0,0)');
        shade.addColorStop(1, 'rgba(30,4,12,0.42)');
        ctx.fillStyle = shade;
        ctx.beginPath();
        ctx.moveTo(-0.4 * H, -0.5 * H);
        ctx.bezierCurveTo(-0.5 * H, -0.28 * H, -0.4 * H, -0.1 * H, -0.3 * H, -0.06 * H);
        ctx.lineTo(0.3 * H, -0.06 * H);
        ctx.bezierCurveTo(0.4 * H, -0.1 * H, 0.5 * H, -0.28 * H, 0.4 * H, -0.5 * H);
        ctx.closePath();
        ctx.fill();
      }

      // ---- 前肢：肩 → 肘 → 腕，三根骨爪 ----
      for (const s of [-1, 1]) {
        const shX = s * 0.44 * H;
        const shY = -0.98 * H;
        const elX = s * 0.66 * H;
        const elY = -0.52 * H;
        const wrX = s * 0.6 * H;
        const wrY = -0.2 * H + Math.sin(t * 1.1 + (s > 0 ? 1 : 0)) * 0.012 * H;
        const ag = ctx.createLinearGradient(shX, shY, wrX, wrY);
        ag.addColorStop(0, mix(col, '#ffffff', 0.1));
        ag.addColorStop(0.55, mix(col, '#000000', 0.12));
        ag.addColorStop(1, mix(col, '#000000', 0.3));
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        // 先用深色描一遍更粗的轮廓：胳膊和躯干同色系，不勾边就糊成一坨（出图后返工过）
        ctx.strokeStyle = mix(col, '#000000', 0.62);
        ctx.lineWidth = 0.25 * H;
        ctx.beginPath();
        ctx.moveTo(shX, shY);
        ctx.quadraticCurveTo(elX, elY, wrX, wrY);
        ctx.stroke();
        ctx.strokeStyle = ag;
        ctx.lineWidth = 0.2 * H;
        ctx.beginPath();
        ctx.moveTo(shX, shY);
        ctx.quadraticCurveTo(elX, elY, wrX, wrY);
        ctx.stroke();
        // 爪：三根，中间那根长一点（深色为主、爪尖一点骨色）
        for (let c = 0; c < 3; c++) {
          const cc = (c - 1) * 0.42;
          const cx = wrX + s * 0.07 * H + cc * 0.03 * H;
          const cy = wrY + 0.12 * H;
          const tx = wrX + s * 0.04 * H + cc * 0.05 * H;
          const ty = wrY + (c === 1 ? 0.19 : 0.155) * H;
          ctx.strokeStyle = mix(col, '#000000', 0.5);
          ctx.lineWidth = 0.05 * H;
          ctx.beginPath();
          ctx.moveTo(wrX, wrY);
          ctx.quadraticCurveTo(cx, cy, tx, ty);
          ctx.stroke();
          ctx.strokeStyle = mix(bone, '#000000', 0.3);
          ctx.lineWidth = 0.02 * H;
          ctx.beginPath();
          ctx.moveTo((cx + tx) / 2, (cy + ty) / 2);
          ctx.lineTo(tx, ty);
          ctx.stroke();
        }
      }

      // ---- 脖颈 + 颈背棘刺 ----
      const neckG = ctx.createLinearGradient(-0.2 * H, -1.1 * H, 0.16 * H, -1.44 * H);
      neckG.addColorStop(0, mix(col, '#ffffff', 0.14));
      neckG.addColorStop(1, mix(col, '#000000', 0.2));
      ctx.fillStyle = neckG;
      ctx.beginPath();
      ctx.moveTo(-0.3 * H, -1.0 * H);
      ctx.bezierCurveTo(-0.3 * H, -1.16 * H, -0.24 * H, -1.24 * H, -0.2 * H, -1.3 * H);
      ctx.lineTo(0.2 * H, -1.3 * H);
      ctx.bezierCurveTo(0.24 * H, -1.24 * H, 0.3 * H, -1.16 * H, 0.3 * H, -1.0 * H);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = mix(col, '#000000', 0.5);
      for (let i = 0; i < 4; i++) {
        const y = -1.02 * H - i * 0.075 * H;
        const len = (0.12 - i * 0.012) * H;
        ctx.beginPath();
        ctx.moveTo(-0.03 * H, y);
        ctx.lineTo(-0.02 * H, y - len);
        ctx.lineTo(0.05 * H, y - len * 0.4);
        ctx.closePath();
        ctx.fill();
      }
      // 肩上的背棘，往外翘
      for (const s of [-1, 1]) {
        for (let i = 0; i < 2; i++) {
          const x = s * (0.34 + i * 0.14) * H;
          const y = -1.06 * H + i * 0.1 * H;
          ctx.fillStyle = mix(col, '#000000', 0.44);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + s * 0.06 * H, y - (0.2 - i * 0.04) * H);
          ctx.lineTo(x + s * 0.16 * H, y - 0.02 * H);
          ctx.closePath();
          ctx.fill();
        }
      }

      // ---- 头骨（楔形长吻）----
      const hx = 0;
      const hy = -1.28 * H;
      const hg = ctx.createRadialGradient(hx - 0.07 * H, hy - 0.06 * H, 0.02 * H, hx, hy, 0.34 * H);
      hg.addColorStop(0, mix(col, '#ffffff', 0.24));
      hg.addColorStop(0.55, col);
      hg.addColorStop(1, mix(col, '#000000', 0.38));
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.moveTo(-0.26 * H, hy - 0.02 * H);
      ctx.bezierCurveTo(-0.3 * H, hy - 0.2 * H, -0.16 * H, hy - 0.26 * H, 0, hy - 0.26 * H);
      ctx.bezierCurveTo(0.16 * H, hy - 0.26 * H, 0.3 * H, hy - 0.2 * H, 0.26 * H, hy - 0.02 * H);
      // 吻部两侧收窄
      ctx.bezierCurveTo(0.22 * H, hy + 0.12 * H, 0.16 * H, hy + 0.2 * H, 0.12 * H, hy + 0.24 * H);
      ctx.lineTo(-0.12 * H, hy + 0.24 * H);
      ctx.bezierCurveTo(-0.16 * H, hy + 0.2 * H, -0.22 * H, hy + 0.12 * H, -0.26 * H, hy - 0.02 * H);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.014 * H;
      ctx.stroke();
      // 鼻孔
      ctx.fillStyle = mix(col, '#000000', 0.6);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * 0.055 * H, hy + 0.14 * H, 0.018 * H, 0.013 * H, s * 0.3, 0, TAU);
        ctx.fill();
      }
      // 嘴线 + 上獠牙
      ctx.strokeStyle = mix(col, '#000000', 0.55);
      ctx.lineWidth = 0.016 * H;
      ctx.beginPath();
      ctx.moveTo(-0.12 * H, hy + 0.2 * H);
      ctx.quadraticCurveTo(0, hy + 0.23 * H, 0.12 * H, hy + 0.2 * H);
      ctx.stroke();
      ctx.fillStyle = bone;
      for (const s of [-1, 1]) {
        for (let i = 0; i < 2; i++) {
          const x = s * (0.035 + i * 0.055) * H;
          ctx.beginPath();
          ctx.moveTo(x - 0.017 * H, hy + 0.205 * H);
          ctx.lineTo(x + 0.017 * H, hy + 0.205 * H);
          ctx.lineTo(x, hy + 0.285 * H);
          ctx.closePath();
          ctx.fill();
        }
      }
      // 眉骨 + 烧红的眼睛
      ctx.fillStyle = mix(col, '#000000', 0.5);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.04 * H, hy - 0.1 * H);
        ctx.quadraticCurveTo(s * 0.14 * H, hy - 0.14 * H, s * 0.2 * H, hy - 0.05 * H);
        ctx.quadraticCurveTo(s * 0.14 * H, hy - 0.07 * H, s * 0.04 * H, hy - 0.05 * H);
        ctx.closePath();
        ctx.fill();
      }
      for (const s of [-1, 1]) {
        const ex = s * 0.105 * H;
        const ey = hy - 0.01 * H;
        const eg = ctx.createRadialGradient(ex, ey, 0.005 * H, ex, ey, 0.07 * H);
        eg.addColorStop(0, fireCore);
        eg.addColorStop(0.5, fire);
        eg.addColorStop(1, mix(fire, '#5c1200', 0.75));
        ctx.fillStyle = eg;
        ctx.beginPath();
        ctx.ellipse(ex, ey, 0.062 * H, 0.048 * H, s * 0.12, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#2a0705';
        ctx.beginPath();
        ctx.ellipse(ex + s * 0.004 * H, ey, 0.012 * H, 0.038 * H, s * 0.12, 0, TAU);
        ctx.fill();
        if (H > 60) {
          ctx.globalAlpha = 0.5 + 0.16 * Math.sin(t * 3.1);
          this._drawGlow(ex, ey, 0.1 * H, fire, 0.35);
          ctx.globalAlpha = 1;
        }
      }

      // ---- 后掠双角（带棱）+ 头顶小冠 ----
      for (const s of [-1, 1]) {
        const r0x = s * 0.13 * H;
        const r0y = hy - 0.16 * H;
        ctx.fillStyle = mix(col, '#000000', 0.3);
        ctx.beginPath();
        ctx.moveTo(r0x, r0y);
        ctx.quadraticCurveTo(s * 0.32 * H, r0y - 0.26 * H, s * 0.44 * H, r0y - 0.52 * H);
        ctx.lineTo(s * 0.38 * H, r0y - 0.54 * H);
        ctx.quadraticCurveTo(s * 0.28 * H, r0y - 0.28 * H, r0x + s * 0.06 * H, r0y - 0.02 * H);
        ctx.closePath();
        ctx.fill();
        // 角上的骨色高光，不然是两根黄吸管
        ctx.strokeStyle = mix(bone, '#ffffff', 0.25);
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 0.014 * H;
        ctx.beginPath();
        ctx.moveTo(r0x + s * 0.03 * H, r0y - 0.04 * H);
        ctx.quadraticCurveTo(s * 0.31 * H, r0y - 0.28 * H, s * 0.43 * H, r0y - 0.5 * H);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = mix(col, '#000000', 0.5);
        ctx.lineWidth = 0.012 * H;
        for (let i = 1; i <= 3; i++) {
          const k = i / 4;
          const x = r0x + s * 0.3 * H * (1 - (1 - k) * (1 - k)) * 0.86;
          const y = r0y - 0.52 * H * k * 1.02;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + s * 0.045 * H, y - 0.03 * H);
          ctx.stroke();
        }
      }
      ctx.fillStyle = mix(col, '#000000', 0.34);
      for (let i = 0; i < 3; i++) {
        const y = hy - 0.24 * H - i * 0.05 * H;
        ctx.beginPath();
        ctx.moveTo(-0.03 * H, y);
        ctx.lineTo(0, y - 0.075 * H);
        ctx.lineTo(0.03 * H, y);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /**
   * 第二关主角：照着参考图（摊位立牌上那位大叔）画的扁平背影 ——
   * 秃头 + 两侧络腮胡 + 淡紫灰背心（带污渍）+ 大肚子 + 深色短裤 + 光腿，
   * 手里换成鱼叉枪。用户 m01451 要"人物换成图片人物"，抠图没抠干净（见 viz 记录），
   * 所以游戏内是照着他画的扁平版，照片本身用在进场对话里当立绘。
   */
  _heroWater(ctx, H, sw, pl) {
    const SKIN = '#e8b98f';
    const SKIN_D = '#bd8a61';
    const TANK = '#d7d3e6';
    const TANK_D = '#9d98b5';
    const SHORTS = '#3d2c4a';
    const HAIR = '#8d6a53';

    // 【用户 m02399】描边从近黑 '#1a1013' 换成暖褐（和肤色/背心同一族），线细一档。
    const OL = '#4a3a33';
    const o = Math.max(0.5, H * 0.013);
    ctx.lineCap = 'round';

    // 腿（光腿）：两遍走 —— 先描硬边，再填肉色
    const legPath = () => {
      ctx.beginPath();
      for (const s of [-1, 1]) {
        const fx = s * H * 0.07 + s * sw * H * 0.09;
        ctx.moveTo(s * H * 0.055, -H * 0.4);
        ctx.lineTo(fx, -H * 0.03);
      }
    };
    legPath();
    ctx.strokeStyle = OL;
    ctx.lineWidth = H * 0.115 + o * 1.6;
    ctx.stroke();
    legPath();
    ctx.strokeStyle = SKIN_D;
    ctx.lineWidth = H * 0.115;
    ctx.stroke();
    // 深色短裤
    ctx.fillStyle = SHORTS;
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 1.5;
    roundRect(ctx, -H * 0.14, -H * 0.48, H * 0.28, H * 0.17, H * 0.03);
    ctx.fill();
    ctx.stroke();
    // 大肚子（背心）：躯干 + 一个鼓出来的椭圆
    ctx.fillStyle = TANK;
    ctx.beginPath();
    ctx.moveTo(-H * 0.125, -H * 0.46);
    ctx.lineTo(-H * 0.14, -H * 0.7);
    ctx.lineTo(H * 0.14, -H * 0.7);
    ctx.lineTo(H * 0.125, -H * 0.46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, -H * 0.55, H * 0.155, H * 0.125, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    // 背心的阴影 + 一块污渍（参考图里那件带污迹的背心）
    ctx.fillStyle = TANK_D;
    ctx.beginPath();
    ctx.moveTo(-H * 0.13, -H * 0.47);
    ctx.lineTo(-H * 0.115, -H * 0.6);
    ctx.lineTo(-H * 0.045, -H * 0.58);
    ctx.lineTo(-H * 0.05, -H * 0.47);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(120,90,40,0.35)';
    ctx.beginPath();
    ctx.ellipse(H * 0.06, -H * 0.5, H * 0.035, H * 0.022, 0.4, 0, TAU);
    ctx.fill();

    // 两条胳膊（光膀子）：同样两遍走
    const armPath = () => {
      ctx.beginPath();
      ctx.moveTo(-H * 0.128, -H * 0.68);
      ctx.lineTo(-H * 0.19, -H * 0.44 + sw * H * 0.03);
      ctx.moveTo(H * 0.128, -H * 0.68);
      ctx.lineTo(H * 0.15, -H * 0.52);
    };
    armPath();
    ctx.strokeStyle = OL;
    ctx.lineWidth = H * 0.075 + o * 1.6;
    ctx.stroke();
    armPath();
    ctx.strokeStyle = SKIN;
    ctx.lineWidth = H * 0.075;
    ctx.stroke();

    // 鱼叉枪
    const gy = -H * 0.5;
    ctx.fillStyle = '#2c3b48';
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 1.5;
    roundRect(ctx, H * 0.04, gy - H * 0.021, H * 0.26, H * 0.042, H * 0.018);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#cfd8e0';
    ctx.beginPath();
    ctx.moveTo(H * 0.3, gy);
    ctx.lineTo(H * 0.37, gy - H * 0.032);
    ctx.lineTo(H * 0.37, gy + H * 0.032);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = Math.max(1, H * 0.012);
    ctx.beginPath();
    ctx.moveTo(H * 0.06, gy - H * 0.012);
    ctx.lineTo(H * 0.27, gy - H * 0.012);
    ctx.stroke();

    // 秃头 + 两侧络腮胡
    const headY = -H * 0.8;
    const headR = H * 0.115;
    ctx.fillStyle = SKIN_D; // 脖子
    roundRect(ctx, -headR * 0.5, headY + headR * 0.5, headR, headR * 0.8, headR * 0.2);
    ctx.fill();
    ctx.strokeStyle = OL;
    ctx.lineWidth = o * 1.5;
    ctx.fillStyle = SKIN;
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,240,220,0.5)';
    ctx.beginPath();
    ctx.ellipse(-headR * 0.2, headY - headR * 0.4, headR * 0.42, headR * 0.24, -0.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = HAIR;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * headR * 0.74, headY + headR * 0.16, headR * 0.32, headR * 0.46, s * 0.2, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }

    // 枪口火光
    if (pl.muzzle > 0) {
      const mx = H * 0.37;
      const mr = H * (0.1 + pl.muzzle * 0.16);
      this._drawGlow(mx, gy, mr, '#ffc86a', pl.muzzle);
      this._drawGlow(mx, gy, mr * 0.45, '#fff3d0', pl.muzzle);
      // 【用户 m02399】脚下枪火反光（同第一关主角）
      this._drawGlow(mx * 0.7, 0, mr * 3.2, '#ff9a4a', pl.muzzle * 0.3);
      ctx.strokeStyle = `rgba(255,236,190,${0.75 * pl.muzzle})`;
      ctx.lineWidth = Math.max(1, H * 0.012);
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI * 0.5 + (i - 1) * 0.42;
        ctx.beginPath();
        ctx.moveTo(mx + Math.cos(a) * mr * 0.4, gy + Math.sin(a) * mr * 0.4);
        ctx.lineTo(mx + Math.cos(a) * mr * 1.3, gy + Math.sin(a) * mr * 1.3);
        ctx.stroke();
      }
    }
  }

  /** 护盾圈 + 受击白闪：两套英雄画法（蓝衣士兵 / 水世界大叔）共用 */
  _heroShieldAndFlash(ctx, game, p, feet, H) {
    const pl = game.player;
    if (pl.shield > 0) {
      ctx.strokeStyle = `rgba(125,249,255,${0.30 + 0.16 * Math.sin(this.time * 5)})`;
      ctx.lineWidth = Math.max(1.2, H * 0.02);
      ctx.beginPath();
      ctx.ellipse(p.x, feet - H * 0.5, H * 0.34, H * 0.60, 0, 0, TAU);
      ctx.stroke();
    }
    if (pl.hurt > 0.02) {
      ctx.globalAlpha = pl.hurt * 0.55;
      this._drawGlow(p.x, feet - H * 0.5, H * 0.8, '#ff5040', 1);
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------
  //  奖励门：桥的左半边一块、右半边一块
  //
  //  用户 m00458 要的"奖励不要玩家选，设置成屏幕左右两部分"——就是画面上
  //  两块并排的面板，各带一个 +/×/− 加成，英雄站在哪半边就吃哪一块。
  //  玩家头顶那块会亮起来，提前告诉他"你现在吃的是这个"。
  // ---------------------------------------------------------

  _drawGates(ctx, game, g) {
    const T = CFG.theme;
    const ocean = CFG.level.skin === 'ocean';
    const cam = this.cam;
    const RH = cam.roadHalf;
    const pw = RH * CFG.gate.panelHalfRatio; // 面板半宽（世界单位）
    const p = cam.project(0, g.z);
    const S = p.s;
    const ph = CFG.gate.height * S; // 面板屏幕高
    const pwPx = pw * S;
    const overLeft = game.player.x < 0;

    for (const side of [-1, 1]) {
      const u = side < 0 ? g.left : g.right;
      if (!u) continue;
      const cx = p.x + side * pwPx;
      const col = TAG_COLOR[u.tag] || '#ffd166';
      const active = (side < 0) === overLeft;
      const top = p.y - ph;

      // 落在桥面上的光斑
      ctx.fillStyle = active ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.ellipse(cx, p.y, pwPx * 0.8, ph * 0.10, 0, 0, TAU);
      ctx.fill();

      // 背后的光柱
      ctx.globalCompositeOperation = 'lighter';
      const beam = ctx.createLinearGradient(0, p.y - ph * 1.9, 0, p.y);
      beam.addColorStop(0, rgba(col, 0));
      beam.addColorStop(1, rgba(col, active ? 0.30 : 0.14));
      ctx.fillStyle = beam;
      ctx.fillRect(cx - pwPx * 0.78, p.y - ph * 1.9, pwPx * 1.56, ph * 1.9);
      ctx.globalCompositeOperation = 'source-over';

      // 面板本体
      const pad = pwPx * 0.14;
      roundRect(ctx, cx - pwPx + pad, top, pwPx * 2 - pad * 2, ph, ph * 0.09);
      const pg = ctx.createLinearGradient(0, top, 0, p.y);
      pg.addColorStop(0, rgba(col, active ? 0.42 : 0.24));
      pg.addColorStop(0.55, T.panel);
      pg.addColorStop(1, rgba(col, active ? 0.28 : 0.14));
      ctx.fillStyle = pg;
      ctx.fill();
      ctx.strokeStyle = rgba(col, active ? 0.95 : 0.5);
      ctx.lineWidth = Math.max(1.2, ph * 0.022);
      ctx.stroke();

      // 海洋元素的奖励墙（用户 m01451）：面板上挂一条小鱼 + 冒几颗气泡
      if (ocean) {
        const fs = ph * 0.16;
        const fx = cx + (side < 0 ? -pwPx * 0.62 : pwPx * 0.62);
        const fy = top + ph * 0.16;
        ctx.fillStyle = rgba('#7df9ff', active ? 0.95 : 0.6);
        ctx.beginPath();
        ctx.ellipse(fx, fy, fs, fs * 0.55, 0, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(fx - side * fs, fy);
        ctx.lineTo(fx - side * fs * 2, fy - fs * 0.5);
        ctx.lineTo(fx - side * fs * 2, fy + fs * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#0a2a38';
        ctx.beginPath();
        ctx.arc(fx + side * fs * 0.45, fy - fs * 0.1, Math.max(0.8, fs * 0.14), 0, TAU);
        ctx.fill();
        ctx.strokeStyle = rgba('#ffffff', active ? 0.7 : 0.4);
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(cx - side * pwPx * 0.3, top + ph * (0.24 + i * 0.2), ph * (0.035 + i * 0.012), 0, TAU);
          ctx.stroke();
        }
      }

      // 面板内的一圈内描边，增强"卡片"感
      roundRect(ctx, cx - pwPx + pad * 2, top + ph * 0.08, pwPx * 2 - pad * 4, ph * 0.84, ph * 0.07);
      ctx.strokeStyle = rgba(col, 0.28);
      ctx.lineWidth = 1;
      ctx.stroke();

      // 【用户 m07770】异世界的门卡：顶上一颗会发光的晶体宝石 + 两侧刻符，
      // 让奖励门看着像"石板上挂着的护符"，而不是一张弹窗卡片。
      if (CFG.level.skin === 'fantasy') {
        ctx.strokeStyle = rgba(col, active ? 0.8 : 0.4);
        ctx.lineWidth = Math.max(1, ph * 0.014);
        ctx.lineCap = 'round';
        for (const sx2 of [-1, 1]) {
          for (let i = 0; i < 3; i++) {
            const ry = top + ph * (0.32 + i * 0.16);
            const rx = cx + sx2 * (pwPx - pad * 1.6);
            ctx.beginPath();
            ctx.moveTo(rx - sx2 * ph * 0.045, ry - ph * 0.026);
            ctx.lineTo(rx, ry);
            ctx.lineTo(rx - sx2 * ph * 0.045, ry + ph * 0.026);
            ctx.stroke();
          }
        }
        const gemY = top + ph * 0.13;
        const gs = ph * 0.056;
        ctx.globalCompositeOperation = 'lighter';
        const glow = ctx.createRadialGradient(cx, gemY, 0, cx, gemY, gs * 2.6);
        glow.addColorStop(0, rgba(col, active ? 0.5 : 0.3));
        glow.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(cx - gs * 2.6, gemY - gs * 2.6, gs * 5.2, gs * 5.2);
        ctx.globalCompositeOperation = 'source-over';
        ctx.beginPath();
        ctx.moveTo(cx, gemY - gs * 1.35);
        ctx.lineTo(cx + gs, gemY);
        ctx.lineTo(cx, gemY + gs * 1.35);
        ctx.lineTo(cx - gs, gemY);
        ctx.closePath();
        ctx.fillStyle = rgba(col, active ? 0.95 : 0.6);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,248,234,0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 四角取景框 —— 和 DOM 那边的面板同一套语言（贴着卡片的角，两条边朝里收）
      const ax = pwPx * 0.22;
      const ay = ph * 0.18;
      ctx.strokeStyle = rgba(col, active ? 0.9 : 0.42);
      ctx.lineWidth = Math.max(1.4, ph * 0.022);
      ctx.lineCap = 'round';
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const X = cx + sx * (pwPx - pad * 0.55);
          const Y = sy < 0 ? top + ph * 0.05 : top + ph * 0.95;
          ctx.beginPath();
          ctx.moveTo(X - sx * ax, Y);
          ctx.lineTo(X, Y);
          ctx.lineTo(X, Y - sy * ay);
          ctx.stroke();
        }
      }

      // 你站的那一侧，面板底下压一条会呼吸的光条（"这一块归你"）
      if (active) {
        ctx.fillStyle = rgba(col, 0.5 + 0.34 * Math.sin(this.time * 6));
        roundRect(ctx, cx - pwPx * 0.52, top + ph * 0.94, pwPx * 1.04, Math.max(2, ph * 0.032), ph * 0.02);
        ctx.fill();
      }

      // 字号跟着面板高度走，保证小屏也读得清
      const bigSize = Math.max(11, Math.round(ph * 0.40));
      const opSize = Math.max(10, Math.round(ph * 0.30));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // 运算符号 + 数值（+1 / ×1.18 / −35%）
      const label = `${u.amt}`;
      ctx.font = `800 ${bigSize}px ${FONT}`;
      const amtW = ctx.measureText(label).width;
      ctx.font = `800 ${opSize}px ${FONT}`;
      const opW = ctx.measureText(u.op).width;
      const startX = cx - (opW + amtW) / 2;
      const midY = top + ph * 0.42;

      ctx.textAlign = 'left';
      ctx.font = `800 ${opSize}px ${FONT}`;
      ctx.lineWidth = Math.max(3, bigSize * 0.22);
      ctx.strokeStyle = 'rgba(0,0,0,0.72)';
      ctx.strokeText(u.op, startX, midY);
      ctx.fillStyle = col;
      ctx.fillText(u.op, startX, midY);

      ctx.font = `800 ${bigSize}px ${FONT}`;
      ctx.strokeText(label, startX + opW, midY);
      ctx.fillStyle = '#fff8ea';
      ctx.fillText(label, startX + opW, midY);

      // 说明文字
      ctx.textAlign = 'center';
      ctx.font = `600 ${Math.max(9, Math.round(ph * 0.185))}px ${FONT}`;
      ctx.lineWidth = Math.max(2.5, ph * 0.05);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(u.short, cx, top + ph * 0.74);
      ctx.fillStyle = active ? '#ffffff' : 'rgba(226,232,240,0.9)';
      ctx.fillText(u.short, cx, top + ph * 0.74);
    }
  }


  _drawRings(ctx, game) {
    const cam = this.cam;
    for (const r of game.rings) {
      const k = r.t / r.life;
      const p = cam.project(r.x, r.z);
      const rad = r.maxR * Math.sqrt(k) * p.s;
      const flat = clamp(CFG.camHeight / r.z, 0.06, 0.42);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - k) * 0.85;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1.5, (1 - k) * p.s * 0.012);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rad, rad * flat, 0, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = (1 - k) * 0.35;
      ctx.lineWidth = Math.max(3, (1 - k) * p.s * 0.03);
      ctx.stroke();
      ctx.restore();
    }
  }

  // BOSS 导弹的地面预警：红圈从大缩到小，缩到圈里就要挨打；
  // 最后 40% 再补一道从天而降的亮痕（纯视觉，判定只看落点和半径）。
  // ---------------------------------------------------------
  //  第三关：阳光 / 樱桃炸弹 / 开场警报（植物大战僵尸）
  // ---------------------------------------------------------

  /**
   * 天上掉的阳光：先悬在空中往下落，落地后躺在地上呼吸，
   * 快消失时闪一圈提醒 —— 走位去捡是这一关"多出来的一条收益线"。
   */
  _drawSuns(ctx, game) {
    if (!game.suns || !game.suns.length) return;
    const cam = this.cam;
    const S = CFG.pvz.sun;
    const L = CFG.theme.lawn;
    for (const s of game.suns) {
      if (s.t < 0) continue;
      const k = clamp(s.t / s.fall, 0, 1);
      const p = cam.project(s.x, s.z);
      const flat = clamp(CFG.camHeight / s.z, 0.06, 0.42);
      // 阳光是"贴在草坪上的小图标"，不能跟着透视疯长：它现在就掉在英雄脚边
      // （z 可能只比英雄靠后半个身位），按 p.s 直算是 90px 半径 —— 一整轮太阳
      // 糊在屏幕上，比英雄还大。改成以英雄所在深度为基准、按远近只做轻微缩放。
      const persp = clamp(p.s / cam.scaleNear, 0.52, 1);
      const r = Math.max(3, S.size * cam.scaleNear * persp * (s.big ? S.bigMul : 1));
      const cx = p.x;
      const fly = s.fly || 0;
      // 吸附时往上抬一点（用户 m01729）：贴地滑过去像在"拖"，抬起来才像飞进怀里
      const cy = p.y - (1 - k) * r * 11 - fly * S.flyRise * p.s * 0.55;
      const pulse = 1 + Math.sin(s.phase) * 0.06;

      // 落点影子（越接近落地越实；被吸起来之后就淡掉）
      ctx.save();
      ctx.globalAlpha = 0.22 * k * (1 - fly);
      ctx.fillStyle = 'rgba(40,80,20,0.7)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r * 0.85, r * 0.85 * flat * 2.2, 0, 0, TAU);
      ctx.fill();
      ctx.restore();

      this._drawGlow(cx, cy, r * 3.1 * pulse, '#ffe066', 0.7);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,232,120,0.3)';
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.7 * pulse, 0, TAU);
      ctx.fill();
      ctx.restore();

      // 一圈尖芒（慢慢转）：花瓣也描一圈硬边，跟僵尸/主角统一
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(s.phase * 0.18);
      ctx.fillStyle = L.sun;
      ctx.strokeStyle = mix(L.sun, '#7a4a00', 0.55);
      ctx.lineWidth = Math.max(1, r * 0.12);
      for (let i = 0; i < 8; i++) {
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.6);
        ctx.lineTo(r * 0.34, -r * 1.5);
        ctx.lineTo(-r * 0.34, -r * 1.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = L.sunCore;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.7 * pulse, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fffbe0';
      ctx.beginPath();
      ctx.arc(cx - r * 0.2, cy - r * 0.22, r * 0.28, 0, TAU);
      ctx.fill();

      if (s.live < 4) {
        ctx.save();
        ctx.globalAlpha = (Math.sin(this.time * 12) * 0.5 + 0.5) * 0.55;
        ctx.strokeStyle = '#fff3b0';
        ctx.lineWidth = Math.max(1.4, r * 0.2);
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.15, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /** 樱桃炸弹：引信亮闪 + 把爆炸范围圈出来（玩家能看清"炸哪儿"） */
  /**
   * 第四关的大招演出（用户 m04749）：独角兽从英雄身边一路冲到桥头。
   * 背影跟着它跑，所以画的是"马屁股 + 扬起的尾巴 + 前面露出来的角和鬃毛"，
   * 一路撒粉色尘光 —— 玩家一眼就知道这一路被清了。
   */
  _drawUnicorns(ctx, game) {
    if (!game.unicorns || !game.unicorns.length) return;
    const cam = this.cam;
    const U = CFG.fantasy.unicorn;
    for (const u of game.unicorns) {
      const p = cam.project(u.x, u.z);
      const s = p.s;
      const H = Math.max(8, 0.34 * s); // 独角兽的体高（比主角大一圈）
      const k = clamp(u.t / (u.dur || U.runTime), 0, 1);
      const gallop = Math.sin(this.time * 22);
      const feet = p.y;

      // 彩虹尾迹（【用户 m06470】视觉升级第一步：独角兽空袭特效）
      // 独角兽是匀速跑的（z 按 t 线性插值），所以能直接反推它刚跑过的位置，
      // 沿路铺一条"逐段换色"的飘带 + 贴地粉光 + 四角星。加色混合才像魔法冲锋。
      // 尾巴长度按"世界里的固定长度"算（不用速度折算）：不管跑得快慢，
      // 拖在后面的都是一条彗星尾；用速度折算的话，慢速调试时会缩成一团。
      const N = 9;
      const trailStep = 5.5 / N;
      const RB = ['#ff5d6c', '#ffa14a', '#ffe066', '#7ee787', '#5bc8ff', '#b18cff'];
      const tp = [];
      for (let i = 0; i <= N; i++) {
        const back = cam.project(u.x, u.z - i * trailStep);
        tp.push({
          x: back.x + Math.sin(i * 0.85 + this.time * 5.5) * back.s * 0.014,
          y: back.y,
          s: back.s,
        });
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < N; i++) {
        const a = 1 - i / N;
        const y0 = tp[i].y - H * 0.46 * (tp[i].s / s) * (0.9 + 0.1 * Math.sin(i));
        const y1 = tp[i + 1].y - H * 0.46 * (tp[i + 1].s / s);
        ctx.globalAlpha = 0.3 * a;
        ctx.fillStyle = RB[i % RB.length];
        ctx.beginPath();
        ctx.moveTo(tp[i].x - H * 0.3 * a, y0);
        ctx.lineTo(tp[i].x + H * 0.3 * a, y0);
        ctx.lineTo(tp[i + 1].x + H * 0.3 * (1 - (i + 1) / N), y1);
        ctx.lineTo(tp[i + 1].x - H * 0.3 * (1 - (i + 1) / N), y1);
        ctx.closePath();
        ctx.fill();
      }
      // 贴地粉光：路上留一串越远越淡的光斑
      ctx.globalAlpha = 1;
      for (let i = 1; i <= 4; i++) {
        const q = tp[Math.min(N, i * 2)];
        if (!q) continue;
        this._drawGlow(q.x, q.y, H * 0.5 * (1 - i / 5), U.mane, 0.22 * (1 - i / 5));
      }
      // 星星：尾迹上闪烁的四角星（形状是"四段内凹弧"，比圆点更像魔法火花）
      for (let i = 1; i <= 6; i++) {
        const q = tp[Math.min(N, i)];
        if (!q) continue;
        const tw = 0.5 + 0.5 * Math.sin(this.time * 9 + i * 2.1);
        const r2 = H * (0.05 + 0.04 * tw) * (1 - i / 9);
        if (r2 < 0.7) continue;
        ctx.globalAlpha = 0.6 * tw * (1 - i / 9);
        ctx.fillStyle = i % 2 ? '#fff3ff' : RB[(i * 2) % RB.length];
        const y2 = q.y - H * 0.42 * (q.s / s);
        ctx.beginPath();
        ctx.moveTo(q.x, y2 - r2);
        ctx.quadraticCurveTo(q.x, y2, q.x + r2, y2);
        ctx.quadraticCurveTo(q.x, y2, q.x, y2 + r2);
        ctx.quadraticCurveTo(q.x, y2, q.x - r2, y2);
        ctx.quadraticCurveTo(q.x, y2, q.x, y2 - r2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      ctx.save();
      ctx.translate(p.x, feet);
      // 冲刺时整个身体轻微起伏
      ctx.translate(0, -Math.abs(gallop) * H * 0.03);

      const BODY = U.coat;
      const OL = '#3a2c46';

      // 四条腿（后视只看得见两条后腿 + 两条前腿的远端）
      ctx.strokeStyle = BODY;
      ctx.lineCap = 'round';
      for (const sgn of [-1, 1]) {
        ctx.lineWidth = H * 0.13;
        ctx.beginPath();
        ctx.moveTo(sgn * H * 0.16, -H * 0.42);
        ctx.quadraticCurveTo(sgn * H * 0.2, -H * 0.2, sgn * H * 0.19 + gallop * H * 0.05 * sgn, -H * 0.02);
        ctx.stroke();
        ctx.strokeStyle = mix(BODY, '#000000', 0.18);
        ctx.lineWidth = H * 0.09;
        ctx.beginPath();
        ctx.moveTo(sgn * H * 0.1, -H * 0.44);
        ctx.quadraticCurveTo(sgn * H * 0.12, -H * 0.24, sgn * H * 0.09 - gallop * H * 0.05 * sgn, -H * 0.03);
        ctx.stroke();
        ctx.strokeStyle = BODY;
      }

      // 身体（屁股对着镜头）
      ctx.beginPath();
      ctx.ellipse(0, -H * 0.5, H * 0.26, H * 0.22, 0, 0, TAU);
      ctx.fillStyle = BODY;
      ctx.fill();
      ctx.strokeStyle = OL;
      ctx.lineWidth = Math.max(0.8, H * 0.022);
      ctx.stroke();
      // 屁股上的高光
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.ellipse(-H * 0.08, -H * 0.56, H * 0.08, H * 0.06, -0.3, 0, TAU);
      ctx.fill();

      // 尾巴：粉色的，甩来甩去
      const swish = Math.sin(this.time * 7) * 0.25;
      ctx.strokeStyle = U.mane;
      ctx.lineWidth = H * 0.07;
      ctx.beginPath();
      ctx.moveTo(0, -H * 0.62);
      ctx.quadraticCurveTo(H * 0.06, -H * 0.84, H * (0.02 + swish * 0.1), -H * 1.0);
      ctx.stroke();
      ctx.lineWidth = H * 0.045;
      ctx.strokeStyle = mix(U.mane, '#ffffff', 0.35);
      ctx.beginPath();
      ctx.moveTo(H * 0.02, -H * 0.66);
      ctx.quadraticCurveTo(H * 0.1, -H * 0.86, H * (0.05 + swish * 0.12), -H * 1.02);
      ctx.stroke();

      // 脖子 + 头（往前上方伸）
      ctx.beginPath();
      ctx.moveTo(-H * 0.1, -H * 0.66);
      ctx.quadraticCurveTo(-H * 0.06, -H * 0.92, H * 0.02, -H * 1.0);
      ctx.lineTo(H * 0.14, -H * 0.94);
      ctx.quadraticCurveTo(H * 0.12, -H * 0.78, H * 0.06, -H * 0.62);
      ctx.closePath();
      ctx.fillStyle = BODY;
      ctx.fill();
      ctx.strokeStyle = OL;
      ctx.lineWidth = Math.max(0.8, H * 0.02);
      ctx.stroke();
      // 鬃毛：一撮粉色
      ctx.fillStyle = U.mane;
      ctx.beginPath();
      ctx.moveTo(-H * 0.02, -H * 1.0);
      ctx.quadraticCurveTo(-H * 0.16, -H * 0.9, -H * 0.1, -H * 0.7);
      ctx.quadraticCurveTo(-H * 0.02, -H * 0.84, 0, -H * 0.94);
      ctx.closePath();
      ctx.fill();

      // 独角：金色的角（这一段是这一招的"招牌"，得亮）
      const hornTipX = H * 0.3;
      const hornTipY = -H * 1.2;
      this._drawGlow(H * 0.2, -H * 1.02, H * 0.3, U.horn, 0.75 + 0.2 * Math.sin(this.time * 9));
      ctx.strokeStyle = U.horn;
      ctx.lineWidth = H * 0.055;
      ctx.beginPath();
      ctx.moveTo(H * 0.12, -H * 0.99);
      ctx.lineTo(hornTipX, hornTipY);
      ctx.stroke();
      ctx.strokeStyle = mix(U.horn, '#ffffff', 0.5);
      ctx.lineWidth = H * 0.02;
      ctx.beginPath();
      ctx.moveTo(H * 0.13, -H * 1.0);
      ctx.lineTo(hornTipX - H * 0.02, hornTipY + H * 0.03);
      ctx.stroke();

      // 角尖射出的光束（【用户 m06470】）：一根加色的锥形光 + 尖端亮点，
      // 微微呼吸；这是这一招最该被看见的一笔。
      const beam = 0.72 + 0.28 * Math.sin(this.time * 8);
      const bg = ctx.createLinearGradient(hornTipX, hornTipY, hornTipX + H * 0.75, hornTipY - H * 0.5);
      bg.addColorStop(0, `rgba(255, 246, 214, ${0.5 * beam})`);
      bg.addColorStop(0.45, `rgba(255, 214, 120, ${0.22 * beam})`);
      bg.addColorStop(1, 'rgba(255, 214, 120, 0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(hornTipX - H * 0.02, hornTipY + H * 0.02);
      ctx.lineTo(hornTipX + H * 0.09, hornTipY - H * 0.06);
      ctx.lineTo(hornTipX + H * 0.78, hornTipY - H * 0.46);
      ctx.lineTo(hornTipX + H * 0.66, hornTipY - H * 0.62);
      ctx.closePath();
      ctx.fill();
      this._drawGlow(hornTipX + H * 0.02, hornTipY - H * 0.02, H * 0.22 * beam, '#fff6d6', 0.5 * beam);
      ctx.restore();

      ctx.restore();

      // 刚出场：脚下一团白光 + 几颗星（从"雾里冲出来"的感觉）
      if (k < 0.08) {
        const a0 = 1 - k / 0.08;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        this._drawGlow(p.x, feet - H * 0.42, H * (0.8 + 0.5 * (1 - a0)), U.mane, 0.45 * a0);
        for (let i = 0; i < 5; i++) {
          const a1 = (i / 5) * TAU + 0.4;
          const rr = H * (0.5 + 0.55 * (1 - a0));
          ctx.globalAlpha = 0.5 * a0;
          ctx.fillStyle = i % 2 ? '#fff3ff' : U.horn;
          ctx.beginPath();
          ctx.arc(p.x + Math.cos(a1) * rr, feet - H * 0.4 + Math.sin(a1) * rr * 0.45, Math.max(0.8, H * 0.035), 0, TAU);
          ctx.fill();
        }
        ctx.restore();
      }

      // 冲到桥头：两圈扩散光环 + 放射光条 + 彩虹花瓣（收尾要"炸"一下）
      if (k > 0.94) {
        const a = (1 - k) / 0.06;
        const flat = clamp(CFG.camHeight / Math.max(0.5, u.z), 0.06, 0.42);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a * 0.7;
        this._drawGlow(p.x, feet - H * 0.5, H * 1.25, U.horn, 0.7);
        ctx.globalAlpha = 1;
        for (let i = 0; i < 2; i++) {
          const rr = H * (0.5 + i * 0.45) * (1 + (1 - a) * 0.55);
          ctx.globalAlpha = a * (0.7 - i * 0.25);
          ctx.strokeStyle = i ? U.mane : '#fff6d6';
          ctx.lineWidth = Math.max(1, H * (0.05 - i * 0.02));
          ctx.beginPath();
          ctx.ellipse(p.x, feet - H * 0.06, rr, rr * flat, 0, 0, TAU);
          ctx.stroke();
        }
        // 放射光条：12 根，长短按序号错开，看起来才不呆板
        ctx.lineWidth = Math.max(1, H * 0.035);
        for (let i = 0; i < 12; i++) {
          const ang = (i / 12) * TAU + this.time * 0.8;
          const len = H * (0.5 + 0.42 * ((i % 3) / 2 + 0.5));
          ctx.globalAlpha = a * (i % 2 ? 0.5 : 0.34);
          ctx.strokeStyle = i % 3 === 0 ? '#fff6d6' : (i % 3 === 1 ? U.mane : U.horn);
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(ang) * H * 0.34, feet - H * 0.5 + Math.sin(ang) * H * 0.34 * flat * 1.6);
          ctx.lineTo(p.x + Math.cos(ang) * len, feet - H * 0.5 + Math.sin(ang) * len * flat * 1.6);
          ctx.stroke();
        }
        // 花瓣：8 片，随扩散往外飘
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * TAU + 0.3;
          const rr = H * (0.4 + (1 - a) * 0.7);
          ctx.globalAlpha = a * 0.65;
          ctx.fillStyle = RB[i % RB.length];
          ctx.beginPath();
          ctx.ellipse(
            p.x + Math.cos(ang) * rr,
            feet - H * 0.5 + Math.sin(ang) * rr * flat * 1.6,
            Math.max(0.8, H * 0.055),
            Math.max(0.6, H * 0.03),
            ang, 0, TAU
          );
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  _drawCherries(ctx, game) {
    if (!game.cherries || !game.cherries.length) return;
    const cam = this.cam;
    const C = CFG.pvz.cherry;
    for (const c of game.cherries) {
      const k = clamp(c.t / (c.fuse || C.fuse), 0, 1);
      const p = cam.project(c.x, c.z);
      const flat = clamp(CFG.camHeight / c.z, 0.06, 0.42);
      const r = Math.max(4, 0.16 * p.s);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.2 + 0.45 * k;
      ctx.strokeStyle = '#ff6a4a';
      ctx.lineWidth = Math.max(1.6, p.s * 0.006);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, c.r * p.s, c.r * p.s * flat, 0, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.1 + 0.3 * k;
      ctx.fillStyle = '#ff3b2f';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, c.r * p.s * (0.4 + 0.6 * k), c.r * p.s * flat * (0.4 + 0.6 * k), 0, 0, TAU);
      ctx.fill();
      ctx.restore();

      // 引信越接近越白，闪得越急
      const blink = Math.sin(c.phase * 2.4) * 0.5 + 0.5;
      const bodyCol = k > 0.7 ? mix('#c81f2a', '#fff2c4', blink * 0.8) : '#c81f2a';
      const cy = p.y - r * (1.1 + 0.35 * (1 - k));
      this._drawGlow(p.x, cy, r * 2.6, '#ff7a4a', 0.5 + 0.4 * k);
      // 蒂：先描一圈深绿硬边再填
      ctx.strokeStyle = '#123d0a';
      ctx.lineWidth = Math.max(1.4, r * 0.19) + Math.max(0.8, r * 0.09);
      ctx.beginPath();
      ctx.moveTo(p.x, cy - r * 0.5);
      ctx.quadraticCurveTo(p.x + r * 0.5, cy - r * 1.5, p.x + r * 0.15, cy - r * 1.9);
      ctx.stroke();
      ctx.strokeStyle = '#2f7a1c';
      ctx.lineWidth = Math.max(1.4, r * 0.19);
      ctx.beginPath();
      ctx.moveTo(p.x, cy - r * 0.5);
      ctx.quadraticCurveTo(p.x + r * 0.5, cy - r * 1.5, p.x + r * 0.15, cy - r * 1.9);
      ctx.stroke();
      ctx.strokeStyle = '#4a0d12';
      ctx.lineWidth = Math.max(1.1, r * 0.15);
      for (const sx of [-1, 1]) {
        ctx.fillStyle = bodyCol;
        ctx.beginPath();
        ctx.arc(p.x + sx * r * 0.5, cy, r * 0.66, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath();
        ctx.arc(p.x + sx * r * 0.5 - r * 0.18, cy - r * 0.2, r * 0.2, 0, TAU);
        ctx.fill();
      }
    }
  }

  /**
   * 第三关开场：先红色警报 + 戴夫那句「歪比巴布」，再 3 / 2 / 1 倒数。
   * 数字每换一个会弹一下（pop），和 game.js 里 sfx.countdown 的声音对齐。
   */
  _drawAlert(ctx, game, w, h) {
    if (!game.alertT || game.alertT <= 0) return;
    const A = CFG.pvz.alert;
    const total = A.alarm + A.step * 3;
    const passed = total - game.alertT;
    const step = game.alertStep || 0;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (step <= 0) {
      // 警报段：整屏红光脉冲 + 大字警告
      const pulse = 0.26 + 0.32 * (Math.sin(passed * 14) * 0.5 + 0.5);
      const g = ctx.createRadialGradient(w / 2, h * 0.44, w * 0.1, w / 2, h * 0.44, w * 0.78);
      g.addColorStop(0, 'rgba(220,30,30,0)');
      g.addColorStop(0.6, `rgba(210,24,24,${pulse * 0.5})`);
      g.addColorStop(1, `rgba(255,60,40,${pulse})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const fs = Math.min(w * 0.13, h * 0.1);
      ctx.font = `900 ${fs}px ${FONT}`;
      ctx.lineWidth = Math.max(3, fs * 0.09);
      ctx.strokeStyle = 'rgba(60,0,0,0.85)';
      ctx.strokeText('僵 尸 来 了 ！', w / 2, h * 0.42);
      ctx.fillStyle = '#fff2c4';
      ctx.fillText('僵 尸 来 了 ！', w / 2, h * 0.42);
      ctx.font = `700 ${fs * 0.36}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,240,210,0.92)';
      ctx.fillText('戴夫：歪比巴布 ——', w / 2, h * 0.42 + fs * 0.95);
    } else {
      const local = (passed - A.alarm) / A.step;
      const frac = local - Math.floor(local);
      const pop = 1 + (1 - clamp(frac * 3.2, 0, 1)) * 0.5;
      const fs = Math.min(w * 0.3, h * 0.22) * pop;
      ctx.globalAlpha = 0.35 + 0.65 * (1 - clamp(frac, 0, 1));
      ctx.font = `900 ${fs}px ${FONT}`;
      ctx.lineWidth = Math.max(4, fs * 0.1);
      ctx.strokeStyle = 'rgba(40,70,20,0.8)';
      ctx.strokeText(String(step), w / 2, h * 0.44);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(step), w / 2, h * 0.44);
      ctx.globalAlpha = 1;
      ctx.font = `800 ${Math.min(w * 0.045, h * 0.032)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,250,220,0.9)';
      ctx.fillText('准备迎战', w / 2, h * 0.44 + fs * 0.62);
    }
    ctx.restore();
  }

  _drawWarns(ctx, game) {
    const cam = this.cam;
    const R = CFG.bossMissile.radius;
    for (const w of game.warns) {
      const k = clamp(w.t / w.life, 0, 1);
      const p = cam.project(w.x, w.z);
      const flat = clamp(CFG.camHeight / w.z, 0.06, 0.42);
      const rad = R * p.s * (1.9 - 0.9 * k);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35 + 0.5 * k;
      ctx.strokeStyle = '#ff5a3a';
      ctx.lineWidth = Math.max(2, p.s * (0.006 + 0.008 * k));
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rad, rad * flat, 0, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.1 + 0.22 * k;
      ctx.fillStyle = '#ff3b2f';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rad, rad * flat, 0, 0, TAU);
      ctx.fill();
      // 内圈随时间收缩 —— 一眼看出"还有多久砸下来"
      ctx.globalAlpha = 0.28 + 0.45 * k;
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = Math.max(1.2, p.s * 0.004);
      const ir = 0.35 + 0.65 * (1 - k);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rad * ir, rad * flat * ir, 0, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.4 + 0.5 * k;
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = Math.max(1.2, p.s * 0.003);
      ctx.beginPath();
      ctx.moveTo(p.x - rad * 1.35, p.y);
      ctx.lineTo(p.x - rad * 0.45, p.y);
      ctx.moveTo(p.x + rad * 0.45, p.y);
      ctx.lineTo(p.x + rad * 1.35, p.y);
      ctx.moveTo(p.x, p.y - rad * flat * 1.5);
      ctx.lineTo(p.x, p.y - rad * flat * 0.5);
      ctx.moveTo(p.x, p.y + rad * flat * 0.5);
      ctx.lineTo(p.x, p.y + rad * flat * 1.5);
      ctx.stroke();
      const fall = (k - 0.6) / 0.4;
      if (fall > 0) {
        const len = p.s * 3.4 * (1 - fall);
        ctx.globalAlpha = 0.55 + 0.45 * (1 - fall);
        const g = ctx.createLinearGradient(p.x, p.y - len, p.x, p.y);
        g.addColorStop(0, 'rgba(255,120,60,0)');
        g.addColorStop(1, 'rgba(255,220,160,0.95)');
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(2, p.s * 0.008);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - len);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.fillStyle = '#fff3c4';
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2, p.s * 0.012), 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // ---------------------------------------------------------
  //  屏幕特效 / 飘字 / HUD
  // ---------------------------------------------------------

  /**
   * 空气里的浮尘 / 火星（视觉升级）。
   * 44 颗按定种生成的微粒，各按各的速度慢慢往上飘，飘到顶就从头再来 ——
   * 不用粒子数组、不做碰撞，纯给画面加一层"空气感"和纵深。
   */
  _drawAmbient(ctx, game) {
    const T = CFG.theme;
    // 【用户 m02901】浮尘按画质档取前 N 颗（低档 0 颗 = 整层不画）
    const want = Math.round(44 * QUALITY.prop.motes);
    if (want <= 0) return;
    if (!this._motes) {
      let s = 0x51ed2701;
      const r = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
      const m = [];
      for (let i = 0; i < 44; i++) {
        m.push({
          x: (r() * 2 - 1) * (CFG.roadHalf || 0.9) * 1.35,
          z: 3 + r() * 70,
          spd: 0.045 + r() * 0.11,
          ph: r(),
          sway: 0.1 + r() * 0.5,
          size: 0.6 + r() * 1.9,
          warm: r() < 0.45,
        });
      }
      this._motes = m;
    }
    const t = this.time;
    const list = this._motes;
    const n = Math.min(want, list.length);
    for (let i = 0; i < n; i++) {
      const m = list[i];
      const k = (t * m.spd + m.ph) % 1; // 0 → 1 的生命进度，决定飘多高、多淡
      const z = m.z + Math.sin(t * 0.5 + m.ph * 6.28) * 1.2;
      const p = this.cam.project(m.x + Math.sin(t * m.sway + m.ph * 9) * 0.12, z);
      const y = p.y - k * p.s * 0.5;
      if (y < -20 || y > this.h + 20 || p.s < 6) continue;
      const a = (1 - k) * 0.42 + 0.08;
      const r2 = Math.min(4.2, Math.max(0.5, m.size * (0.35 + p.s * 0.012)));
      ctx.fillStyle = m.warm ? `rgba(255,196,128,${a})` : `rgba(${T.starRGB || '220,235,255'},${a * 0.62})`;
      ctx.beginPath();
      ctx.arc(p.x, y, r2, 0, TAU);
      ctx.fill();
    }
  }

  _drawScreenFx(ctx, game, w, h) {
    // 常驻暗角
    if (!this._vignette || this._vigW !== w || this._vigH !== h) {
      const g = ctx.createRadialGradient(w / 2, h * 0.55, h * 0.25, w / 2, h * 0.55, h * 0.78);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.55)');
      this._vignette = g;
      this._vigW = w;
      this._vigH = h;
    }
    ctx.fillStyle = this._vignette;
    ctx.fillRect(0, 0, w, h);

    // 低血量脉冲
    const lowHp = game.player.hp <= 1 && game.state !== 'over';
    if (lowHp) {
      const pulse = 0.18 + 0.14 * Math.sin(this.time * 6.5);
      const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.72);
      g.addColorStop(0, 'rgba(200,0,0,0)');
      g.addColorStop(1, `rgba(190,0,0,${pulse})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // 受击红闪
    if (game.flash > 0.01) {
      ctx.fillStyle = `rgba(255,40,30,${game.flash * 0.26})`;
      ctx.fillRect(0, 0, w, h);
    }

    // 危险逼近（视觉升级）：最近一只丧尸越近，屏幕四边越红。
    // 比"只剩一格血"更早给到预警 —— 玩家不该靠数血条才知道身后有东西。
    let near = Infinity;
    for (const e of game.enemies) {
      if (e.dead) continue;
      const d = e.z - game.player.z;
      if (d < near) near = d;
    }
    if (near < 3.6 && game.state !== 'over' && QUALITY.prop.vignette) {
      if (!this._dangerGrad || this._dangerW !== w || this._dangerH !== h) {
        const dg = ctx.createRadialGradient(w / 2, h * 0.6, h * 0.2, w / 2, h * 0.6, h * 0.72);
        dg.addColorStop(0, 'rgba(255,20,16,0)');
        dg.addColorStop(0.68, 'rgba(255,24,18,0.1)');
        dg.addColorStop(1, 'rgba(255,34,22,0.62)');
        this._dangerGrad = dg;
        this._dangerW = w;
        this._dangerH = h;
      }
      const k = clamp(1 - (near - 1) / 2.6, 0, 1);
      const beat = 0.55 + 0.45 * Math.sin(this.time * 7.5);
      ctx.globalAlpha = clamp(k * beat, 0, 1) * 0.8;
      ctx.fillStyle = this._dangerGrad;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // 枪口照亮全场的一点点提升
    if (game.player.muzzle > 0.05) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,200,120,${game.player.muzzle * 0.045})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  _drawPopups(ctx, game) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const q of game.popups) {
      const k = q.t / q.life;
      const a = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.5) / 0.5);
      const size = Math.round(15 * q.scale);
      ctx.font = `700 ${size}px ${FONT}`;
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.lineWidth = Math.max(3, size * 0.26);
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(q.text, q.sx, q.sy);
      ctx.fillStyle = q.color;
      ctx.fillText(q.text, q.sx, q.sy);
    }
    ctx.globalAlpha = 1;
  }

  /** 画在 canvas 上的少量 HUD：血条盾牌、波次敌人数、波次横幅 */
  _drawHudCanvas(ctx, game, w, h) {
    const safeTop = this.safeTop || 0;

    // 战车血量做成车上的指示条意义不大，直接用左上角心形
    const pl = game.player;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const baseY = safeTop + 16;

    // 心：一排带底座的"血条胶囊"（视觉升级）—— 空槽也画出来，
    // 玩家一眼能数出自己有几格、还剩几格。只剩 1 格时最右边那颗会脉动报警。
    const danger = pl.hp <= 1;
    const heartR = 7.4;
    const plateW = pl.maxHp * 20 - 6;
    // 【第四关观感】通用 HUD 是冷蓝玻璃，到了异世界要和金/苔绿的面板统一：
    // 血槽换成暖色玻璃 + 金边 + 一层很淡的金色辉光（不抢心形的红）。
    const fskin = CFG.level.skin === 'fantasy';
    if (fskin) this._drawGlow(10 + plateW / 2, baseY, plateW * 0.62, '#ffd98a', 0.1);
    ctx.fillStyle = fskin ? 'rgba(30,19,30,0.74)' : (CFG.theme.panel || 'rgba(10,14,22,0.72)');
    roundRect(ctx, 10, baseY - 13, plateW, 26, 13);
    ctx.fill();
    ctx.strokeStyle = danger ? 'rgba(255,90,74,0.55)' : fskin ? 'rgba(255,223,138,0.34)' : 'rgba(160,200,240,0.16)';
    ctx.lineWidth = 1.2;
    roundRect(ctx, 10, baseY - 13, plateW, 26, 13);
    ctx.stroke();
    const hbeat = danger ? 1 + 0.12 * Math.sin(this.time * 8) : 1;
    for (let i = 0; i < pl.maxHp; i++) {
      const x = 18 + i * 20;
      const on = i < pl.hp;
      const last = i === pl.hp - 1;
      this._drawHeart(ctx, x, baseY, heartR * (last ? hbeat : 1), on, last && danger);
    }
    // 护盾
    if (pl.shield > 0) {
      for (let i = 0; i < pl.shield; i++) {
        const x = 18 + i * 18;
        const y = baseY + 18;
        ctx.fillStyle = 'rgba(125,249,255,0.9)';
        ctx.beginPath();
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x + 7, y - 4);
        ctx.lineTo(x + 7, y + 2);
        ctx.lineTo(x, y + 7);
        ctx.lineTo(x - 7, y + 2);
        ctx.lineTo(x - 7, y - 4);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 波次横幅
    if (game.waveBanner > 0) {
      const bossWave = isBossWave(game.wave);
      const hordeWave = isHordeWave(game.wave);
      const dur = bossWave || hordeWave || game.mod ? 2.5 : 2.2;
      const k = game.waveBanner / dur;
      const a = k > 0.75 ? (1 - k) / 0.25 : Math.min(1, k / 0.25);
      ctx.textAlign = 'center';
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.font = `800 ${Math.round(Math.min(46, w * 0.115))}px ${FONT}`;
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      const txt = `第 ${game.wave} / ${CFG.level.waves} 波`;
      const yy = h * 0.3;
      ctx.strokeText(txt, w / 2, yy);
      ctx.fillStyle = bossWave ? '#ff5a4a' : hordeWave ? '#8bf58b' : '#ffe9a8';
      ctx.fillText(txt, w / 2, yy);
      // 【用户 m10372】"第四关波次说明的文字金色边框太丑了还看不清"
      // 原来这里给异世界皮肤加了一条金色饰线 + 两枚菱角，而且它把 strokeStyle/lineWidth
      // 改成了"金 1.6px"，后面所有副标题的描边就全变成金线 —— 又丑又看不清。
      // 现在饰线整段删掉，描边回到"深色粗描边"，任何背景上都读得清。
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.72)';
      let subY = yy + w * 0.08;
      // 副标题直接读 game.waveTag（在 startWave 里按"这一波是什么"算好的）：
      // BOSS / 专属大场面（带名字和说明）/ 人海 / 精英波 / 割草波。
      // 没有 waveTag 时（老存档 / 测试桩）退回原来的按波数判断。
      const tag = game.waveTag;
      if (tag) {
        ctx.font = `700 ${Math.round(w * 0.05)}px ${FONT}`;
        ctx.strokeText(tag.text, w / 2, subY);
        ctx.fillStyle = tag.color || '#ffe9a8';
        ctx.fillText(tag.text, w / 2, subY);
        subY += w * 0.07;
        if (tag.desc) {
          ctx.font = `600 ${Math.round(w * 0.04)}px ${FONT}`;
          ctx.strokeText(tag.desc, w / 2, subY);
          ctx.fillStyle = 'rgba(232,238,246,0.92)';
          ctx.fillText(tag.desc, w / 2, subY);
          subY += w * 0.058;
        }
      } else if (bossWave) {
        ctx.font = `700 ${Math.round(w * 0.05)}px ${FONT}`;
        ctx.strokeText('BOSS 来袭', w / 2, subY);
        ctx.fillText('BOSS 来袭', w / 2, subY);
        subY += w * 0.07;
      } else if (hordeWave) {
        ctx.font = `700 ${Math.round(w * 0.05)}px ${FONT}`;
        ctx.strokeText('尸 潮 来 袭', w / 2, subY);
        ctx.fillText('尸 潮 来 袭', w / 2, subY);
        subY += w * 0.07;
      }
      // 词条：每 3 波来一个，横幅上直接写清楚这一波变了什么
      if (game.mod) {
        ctx.font = `800 ${Math.round(w * 0.072)}px ${FONT}`;
        ctx.strokeText(game.mod.name, w / 2, subY);
        ctx.fillStyle = game.mod.color;
        ctx.fillText(game.mod.name, w / 2, subY);
        ctx.font = `600 ${Math.round(w * 0.04)}px ${FONT}`;
        ctx.strokeText(game.mod.desc, w / 2, subY + w * 0.058);
        ctx.fillStyle = 'rgba(232,238,246,0.92)';
        ctx.fillText(game.mod.desc, w / 2, subY + w * 0.058);
      }
      ctx.globalAlpha = 1;
    }

    // ---- BOSS 血条（用户要求"血条加厚"）----
    // 摆在"连杀数字"和"波次横幅"之间的空档里，两边都不挡：
    // 连杀数字最高占到 safeTop+50 左右，横幅在 h*0.3。厚度 14~17px，
    // 比普通 UI 线粗一倍，扫一眼就能读出还剩多少。
    const boss = game.enemies ? game.enemies.find((e) => e.kind === 'boss' && !e.dead) : null;
    if (boss) {
      const bw = w * 0.8;
      const bh = Math.max(14, Math.round(w * 0.043));
      const bx = (w - bw) / 2;
      const by = safeTop + 54;
      const frac = clamp(boss.hp / boss.maxHp, 0, 1);
      const low = frac < 0.3;
      // 底槽
      ctx.fillStyle = 'rgba(8,5,7,0.8)';
      roundRect(ctx, bx, by, bw, bh, bh / 2);
      ctx.fill();
      // 血量（低血时变红并脉动）
      const pulse = low ? 0.72 + 0.28 * Math.sin(this.time * 9) : 1;
      const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      g.addColorStop(0, low ? '#ff2f2f' : '#ffb03d');
      g.addColorStop(1, low ? '#ff6a4a' : '#ff3b2f');
      ctx.globalAlpha = pulse;
      ctx.fillStyle = g;
      roundRect(ctx, bx + 2, by + 2, Math.max(2, (bw - 4) * frac), bh - 4, Math.max(1, (bh - 4) / 2));
      ctx.fill();
      ctx.globalAlpha = 1;
      // 【第四关观感】血条顶部加一道高光 + 金边，跟第三关的塑料感拉开
      if (fskin) {
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        roundRect(ctx, bx + 5, by + 3, Math.max(2, (bw - 10) * frac), Math.max(1, bh * 0.2), bh * 0.1);
        ctx.fill();
      }
      // 外框
      ctx.strokeStyle = fskin ? 'rgba(255,215,138,0.62)' : 'rgba(255,255,255,0.24)';
      ctx.lineWidth = 1.5;
      roundRect(ctx, bx, by, bw, bh, bh / 2);
      ctx.stroke();
      // 名字 + 数值
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.round(bh * 0.78)}px ${FONT}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.fillStyle = '#ffd9c9';
      // 名字跟着形态走（用户 m01503）：第三关第一条血是"僵王"，
      // 进化之后换成"僵尸博士"，并把"第几段血"写出来 —— 玩家得知道还有一条。
      // 第四关同理：第一形态"恶龙"，进化之后还是"恶龙"（但换成 boss2 的配色与体型）。
      const nm = boss.form === 2
        ? (CFG.level.skin === 'fantasy' ? CFG.fantasy.boss2.name : CFG.pvz.boss2.name)
        : CFG.level.skin === 'pvz' ? CFG.kinds.boss.pvz.name
          : CFG.level.skin === 'fantasy' ? CFG.kinds.boss.fantasy.name
            : '尸潮首领';
      const pips = boss.forms > 1 ? `  ${boss.form}/${boss.forms}` : '';
      const label = nm.split('').join(' ') + pips;
      ctx.strokeText(label, bx, by - bh * 0.9);
      ctx.fillText(label, bx, by - bh * 0.9);
      ctx.textAlign = 'right';
      const hpTxt = `${Math.max(0, Math.ceil(boss.hp))} / ${boss.maxHp}`;
      ctx.strokeText(hpTxt, bx + bw, by - bh * 0.9);
      ctx.fillText(hpTxt, bx + bw, by - bh * 0.9);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      // 给测试留一个可读的落点（跟空袭按钮同一个套路）
      this.bossBar = {
        x: bx,
        y: by,
        w: bw,
        h: bh,
        frac,
        hp: boss.hp,
        maxHp: boss.maxHp,
        form: boss.form || 1,
        forms: boss.forms || 1,
        label,
      };
    } else {
      this.bossBar = null;
    }

    // 连杀数：屏幕中部偏上，数字弹一下 + 颜色随连杀升高变烫
    if (game.combo >= 2) {
      const punch = game.comboPunch; // 1 → 0
      const scale = 1 + punch * 0.35;
      const heat = clamp(game.combo / 25, 0, 1);
      const col = mix('#ffd166', '#ff3b2f', heat);
      const fs = Math.round(Math.min(34, w * 0.082) * scale);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 ${fs}px ${FONT}`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.66)';
      // 备战期 DOM 的「← 走位吃奖励 →」/倒计时就挂在这一带（styles.css 的 .hud-mid，
      // top: safe-t + 104），连杀数字正压在上面 —— 英文提示更长，两串字糊在一起更明显。
      // 备战期把连杀数字整体让一行下去，两边都不挡（用户 m03096 反馈过同类压字）。
      const cy2 = safeTop + fs * 0.72 + (game.prepT > 0 ? Math.round(fs * 1.05) : 0);
      ctx.strokeText(`${game.combo} 连杀`, w / 2, cy2);
      ctx.fillStyle = col;
      ctx.fillText(`${game.combo} 连杀`, w / 2, cy2);
      // 连杀剩余时间：细条，提醒"再不杀就断了"
      const cw = w * 0.26;
      const t = clamp(game.comboT / CFG.combo.window, 0, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(w / 2 - cw / 2, cy2 + fs * 0.58, cw, 3);
      ctx.fillStyle = col;
      ctx.fillRect(w / 2 - cw / 2, cy2 + fs * 0.58, cw * t, 3);
      ctx.textBaseline = 'alphabetic';
    }

    this._drawStrikeButton(ctx, game, w, h);
  }

  /**
   * 右下角的空袭按钮：击杀充能，满了点它叫轰炸。
   * 按钮位置存在 this.strikeBtn 上，main.js 用它做命中判定
   * （判定半径比画的圆大一圈，手指好按）。
   */
  _drawStrikeButton(ctx, game, w, h) {
    const R = Math.max(27, Math.min(40, w * 0.092));
    const cx = w - R - 20;
    const cy = h - R - 26;
    this.strikeBtn = { x: cx, y: cy, r: R + 12 };

    // 第三关这个大招不是空袭，是【樱桃炸弹】（用户 m02771）：按钮换成樱桃图标 + 暖红配色
    const pvz = CFG.level.skin === 'pvz';
    // 第四关是【独角兽冲锋】（用户 m04749）：粉色 + 金色，还要显示"这一局还剩几次"
    const fantasy = CFG.level.skin === 'fantasy';
    const cap = (fantasy && CFG.level.strikeCap) ? CFG.level.strikeCap + (game.strikeCapBonus || 0) : 0;
    const left = cap ? Math.max(0, cap - (game.strikeUses || 0)) : 0;
    const spent = cap > 0 && left <= 0;
    const accent = fantasy ? '#ffb6e6' : pvz ? '#ff6a4a' : '#8bf58b';
    const accentSoft = fantasy ? 'rgba(255,182,230,' : pvz ? 'rgba(255,150,120,' : 'rgba(160,255,170,';

    const charge = clamp(game.energy / CFG.charge.max, 0, 1);
    const full = charge >= 1 && !spent;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 5.2);

    if (full) {
      this._drawGlow(cx, cy, R * 2.5, accent, 0.28 + pulse * 0.22);
    }

    ctx.fillStyle = full ? (fantasy ? 'rgba(52,24,44,0.86)' : pvz ? 'rgba(56,20,14,0.86)' : 'rgba(24,52,30,0.86)') : 'rgba(10,16,22,0.7)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = full ? `${accentSoft}${0.6 + pulse * 0.4})` : 'rgba(150,160,175,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();

    // 充能环
    const lw = Math.max(3, R * 0.15);
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath();
    ctx.arc(cx, cy, R - lw * 0.5, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = full ? accent : '#ffd166';
    ctx.beginPath();
    ctx.arc(cx, cy, R - lw * 0.5, -Math.PI / 2, -Math.PI / 2 + TAU * charge);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (fantasy) {
      // 独角兽：白马的侧脸 + 金色独角（比写两个字更像这一招）
      const hr = R * 0.52;
      ctx.fillStyle = spent ? 'rgba(220,220,230,0.4)' : '#fdf8ff';
      ctx.beginPath();
      ctx.moveTo(cx - hr * 0.5, cy + hr * 0.55);
      ctx.quadraticCurveTo(cx - hr * 0.62, cy - hr * 0.55, cx + hr * 0.08, cy - hr * 0.5);
      ctx.quadraticCurveTo(cx + hr * 0.78, cy - hr * 0.34, cx + hr * 0.6, cy + hr * 0.14);
      ctx.quadraticCurveTo(cx + hr * 0.34, cy + hr * 0.26, cx + hr * 0.22, cy + hr * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - hr * 0.18, cy - hr * 0.5);
      ctx.lineTo(cx - hr * 0.04, cy - hr * 0.98);
      ctx.lineTo(cx + hr * 0.22, cy - hr * 0.44);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = spent ? 'rgba(255,215,106,0.45)' : '#ffd76a';
      ctx.lineWidth = Math.max(1.6, R * 0.085);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + hr * 0.14, cy - hr * 0.42);
      ctx.lineTo(cx + hr * 0.56, cy - hr * 1.06);
      ctx.stroke();
      ctx.fillStyle = spent ? 'rgba(90,90,100,0.6)' : '#3a2c46';
      ctx.beginPath();
      ctx.arc(cx + hr * 0.2, cy - hr * 0.04, Math.max(1, R * 0.045), 0, TAU);
      ctx.fill();
      // 粉色鬃毛
      ctx.fillStyle = spent ? 'rgba(255,182,230,0.35)' : '#ffb6e6';
      ctx.beginPath();
      ctx.moveTo(cx - hr * 0.3, cy - hr * 0.44);
      ctx.quadraticCurveTo(cx - hr * 0.72, cy - hr * 0.2, cx - hr * 0.5, cy + hr * 0.3);
      ctx.quadraticCurveTo(cx - hr * 0.34, cy - hr * 0.1, cx - hr * 0.16, cy - hr * 0.34);
      ctx.closePath();
      ctx.fill();
    } else if (pvz) {
      // 两颗樱桃（比写两个字更像 PvZ）
      const cr = R * 0.25;
      ctx.strokeStyle = '#2f7a1c';
      ctx.lineWidth = Math.max(1.4, R * 0.07);
      ctx.beginPath();
      ctx.moveTo(cx, cy - R * 0.2);
      ctx.quadraticCurveTo(cx + R * 0.22, cy - R * 0.44, cx + R * 0.08, cy - R * 0.58);
      ctx.stroke();
      for (const sx of [-1, 1]) {
        ctx.fillStyle = full ? '#ff5a4a' : 'rgba(198,58,48,0.72)';
        ctx.beginPath();
        ctx.arc(cx + sx * cr * 0.86, cy - R * 0.08, cr, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.arc(cx - cr * 0.86 - cr * 0.3, cy - R * 0.08 - cr * 0.3, cr * 0.28, 0, TAU);
      ctx.fill();
    } else {
      ctx.font = `800 ${Math.round(R * 0.52)}px ${FONT}`;
      ctx.fillStyle = full ? '#eaffe6' : 'rgba(233,236,240,0.72)';
      ctx.fillText('空袭', cx, cy - R * 0.06);
    }
    ctx.font = `700 ${Math.round(R * 0.3)}px ${FONT}`;
    ctx.fillStyle = full ? accent : spent ? 'rgba(150,150,160,0.65)' : 'rgba(200,208,220,0.7)';
    const sub = spent ? '已用完' : full ? '点我' : `${Math.floor(charge * 100)}%`;
    ctx.fillText(sub, cx, cy + R * 0.46);
    // 第四关：右上角标"这一局还剩几次"（用户 m04749 的一局 2~3 次）
    if (cap > 0) {
      const bx = cx + R * 0.78;
      const by = cy - R * 0.78;
      ctx.fillStyle = spent ? 'rgba(60,60,68,0.85)' : 'rgba(52,24,44,0.92)';
      ctx.beginPath();
      ctx.arc(bx, by, R * 0.3, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = spent ? 'rgba(150,150,160,0.5)' : 'rgba(255,215,106,0.85)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.font = `800 ${Math.round(R * 0.34)}px ${FONT}`;
      ctx.fillStyle = spent ? 'rgba(180,180,190,0.8)' : '#ffd76a';
      ctx.fillText(String(left), bx, by + R * 0.01);
    }
    ctx.textBaseline = 'alphabetic';
  }

  _drawHeart(ctx, cx, cy, r, filled, alarm = false) {
    ctx.save();
    ctx.translate(cx, cy);
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(0, r * 0.75);
      ctx.bezierCurveTo(-r * 1.5, -r * 0.18, -r * 0.6, -r * 1.25, 0, -r * 0.42);
      ctx.bezierCurveTo(r * 0.6, -r * 1.25, r * 1.5, -r * 0.18, 0, r * 0.75);
      ctx.closePath();
    };
    if (filled) {
      if (alarm) this._drawGlow(0, 0, r * 2.6, '#ff3b2f', 0.5);
      // 近黑的描边 + 上亮下暗，和满屏的硬描边风格统一
      path();
      ctx.strokeStyle = '#1a0a0e';
      ctx.lineWidth = Math.max(1.2, r * 0.24);
      ctx.stroke();
      const g = ctx.createLinearGradient(0, -r, 0, r);
      g.addColorStop(0, '#ff6d78');
      g.addColorStop(1, '#d01f36');
      ctx.fillStyle = g;
      ctx.fill();
      // 高光
      ctx.fillStyle = 'rgba(255,220,224,0.8)';
      ctx.beginPath();
      ctx.ellipse(-r * 0.42, -r * 0.5, r * 0.22, r * 0.15, -0.6, 0, TAU);
      ctx.fill();
    } else {
      // 空槽：暗底 + 细描边，看得出是个"凹位"
      path();
      ctx.fillStyle = 'rgba(48,52,62,0.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,158,172,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }
}
