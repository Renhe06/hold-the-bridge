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

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
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
    this.cam = camera;
    this.game = game;
    this.dpr = 1;
    this.glowCache = new Map();
    this._list = [];
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
    return this;
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
    this.time += dt;
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

    this._drawBackdrop(ctx, w, h);
    this._drawPlane(ctx, game);
    this._drawWater(ctx, w, h);
    this._drawDeck(ctx);
    this._drawGround(ctx, game);
    this._drawSuns(ctx, game);
    this._drawHaze(ctx, w);
    if (game.state === STATE.START) this._drawAttract(ctx, game);
    this._drawEntities(ctx, game);
    this._drawCherries(ctx, game);
    this._drawMissiles(ctx, game);
    this._drawFog(ctx, w);
    this._drawRings(ctx, game);
    this._drawWarns(ctx, game);
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
    const span = 62;
    for (const a of this._attract) {
      // 慢慢走近；越过镜头就从远端重新进场。
      // 距离刻意压在 z 56~118 这一段：开始界面的大面板会盖住屏幕中下部，
      // 只有地平线附近那条窄带是露出来的，丧尸必须待在那儿才看得见。
      const z = (((a.z0 + 6 - this.time * a.spd) % span) + span) % span + 56;
      const kind = a.giant ? 'brute' : a.fast ? 'runner' : 'walker';
      const K = CFG.kinds[kind];
      const skin = ocean ? K.ocean : pvz ? K.pvz : null;
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

  _drawWater(ctx, w, h) {
    const T = CFG.theme;
    const horizon = this.cam.horizonY;
    const g = ctx.createLinearGradient(0, horizon, 0, h);
    g.addColorStop(0, T.sea[0]);
    g.addColorStop(0.35, T.sea[1]);
    g.addColorStop(1, T.sea[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, w, h - horizon);

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

    // 伸缩缝（给纵深提供参照物）
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

    // 中央虚线
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
    for (let i = 0; i < 46; i++) {
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
    const T = CFG.theme;
    const horizon = this.cam.horizonY;
    const bottom = horizon + this.h * 0.30;
    const g = ctx.createLinearGradient(0, horizon - 4, 0, bottom);
    g.addColorStop(0, T.haze[0]);
    g.addColorStop(0.45, T.haze[1]);
    g.addColorStop(1, T.haze[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon - 4, w, bottom - horizon + 4);
  }

  /** 浓雾：盖在远景丧尸身上，让他们"从雾里走出来"（水世界里这层是水汽） */
  _drawFog(ctx, w) {
    const T = CFG.theme;
    const horizon = this.cam.horizonY;
    const bottom = horizon + this.h * CFG.fogTo;
    const g = ctx.createLinearGradient(0, horizon - 6, 0, bottom);
    g.addColorStop(0, T.fog[0]);
    g.addColorStop(0.3, T.fog[1]);
    g.addColorStop(0.7, T.fog[2]);
    g.addColorStop(1, T.fog[3]);
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon - 6, w, bottom - horizon + 6);
  }

  // ---------------------------------------------------------
  //  实体（按深度从远到近排序）
  // ---------------------------------------------------------

  _drawEntities(ctx, game) {
    const list = this._list;
    list.length = 0;
    for (const e of game.enemies) if (!e.dead) list.push({ z: e.z, k: 0, o: e });
    for (const b of game.bullets) if (!b.dead) list.push({ z: b.z, k: 1, o: b });
    for (const o of game.orbs) list.push({ z: o.z, k: 2, o });
    if (game.gates) list.push({ z: game.gates.z, k: 3, o: game.gates });
    for (const s of game.spits) list.push({ z: s.z, k: 4, o: s });
    list.sort((a, b) => b.z - a.z);

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

  _drawSpit(ctx, s) {
    const cam = this.cam;
    const p = cam.project(s.x, s.z);
    // hot（僵尸博士的火球）：同一套飞行物，画得更大更烫
    const r = Math.max(2, (s.hot ? 0.05 : 0.022) * p.s);
    const wob = 1 + Math.sin(s.phase) * 0.18;
    if (s.hot) {
      const c = s.color || '#ff7a1f';
      this._drawGlow(p.x, p.y - r * 0.7, r * 4.2, c, 0.9);
      ctx.fillStyle = '#ffe9a8';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y - r * 0.7, r * wob, r * 1.15 * wob, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(p.x + r * 0.2, p.y - r * 1.0, r * 0.5, 0, TAU);
      ctx.fill();
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
      this._drawGlow(p.x, p.y - H * 0.52, H * 0.3, '#ffd666', (0.3 + 0.16 * puls) * fade);
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

    this._zombieBody(ctx, H, col, dark, e.phase, e.kind, isWind, e.id || 0);

    // 第二关：挂上海洋动物的部件（鱼鳍 / 触手 / 蟹钳 / 背鳍 / 河豚刺 / 龟壳 / 水母伞）
    // 第三关：换成植物大战僵尸那几种僵尸的招牌部件（桶 / 电线杆 / 撑杆 / 投石机…）
    if (e.animal) {
      if (CFG.level.skin === 'pvz') this._pvzBits(ctx, H, e, col, dark);
      else this._oceanBits(ctx, H, e, col, dark);
    }

    // 背上的鼓包：吐酸者的酸囊
    if (e.spit) {
      const sacY = -0.86 * H;
      this._drawGlow(0, sacY, H * 0.16, '#b6ff5a', 0.5);
      ctx.fillStyle = '#a8e04a';
      ctx.beginPath();
      ctx.ellipse(0, sacY, H * 0.15, H * 0.12, 0, 0, TAU);
      ctx.fill();
    }

    // 铁盾兵：正面一块盾牌，破盾后留裂纹
    if (e.maxShield > 0 && e.shield > 0) {      const w = H * 0.62;
      const hh = H * 0.62;
      const top = -0.78 * H;
      const g = ctx.createLinearGradient(-w / 2, top, w / 2, top + hh);
      g.addColorStop(0, '#c9cdb8');
      g.addColorStop(0.45, '#7f8471');
      g.addColorStop(1, '#4c5044');
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

  /** 在"脚底为原点、头在 -H"的局部坐标里画人形剪影 */
  _zombieBody(ctx, H, col, dark, phase, kind, isWind, seed = 0) {
    const swing = Math.sin(phase);
    const bob = Math.abs(Math.cos(phase)) * 0.016 * H; // 迈步时上下颠一点
    const hipY = -0.42 * H;
    const shY = -0.70 * H;
    const broad = kind === 'brute' || kind === 'boss';

    // 硬朗描边风：先用"比暗面更黑"的颜色把所有形状放大一圈描一遍，再填颜色。
    // 一屏几十只挤在一起时，靠的就是这圈描边把它们分开。
    const outline = mix(dark, '#07070a', 0.62);
    const light = mix(col, '#ffffff', 0.3);
    const shade = mix(dark, '#000000', 0.22);
    const o = Math.max(0.65, H * 0.024);
    // 细节开关：屏幕高不到 30px 的丧尸（远处那一大堆）不画牙/头发/手指/血迹，
    // 反正看不清 —— 省下来的时间留给近处那几只。中低端手机上这一条最关键。
    const detail = H > 30;
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
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? dark : outline;
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
      ctx.fillStyle = outline;
      ctx.beginPath();
      ctx.ellipse(L.footX, L.footY + 0.012 * H, 0.06 * H + o, 0.03 * H + o * 0.6, 0, 0, TAU);
      ctx.fill();
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
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? col : outline;
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
      ctx.fillStyle = outline;
      ctx.beginPath();
      ctx.arc(A.handX, A.handY, hr + o * 0.8, 0, TAU);
      ctx.fill();
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
    ctx.save();
    torsoPath();
    ctx.clip();
    // 受光面（左上到中间）
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.moveTo(-shoulder * 1.1, shY - 0.06 * H);
    ctx.lineTo(shoulder * 0.05, shY - 0.06 * H);
    ctx.lineTo(-shoulder * 0.12, hipY);
    ctx.lineTo(-shoulder * 1.1, hipY);
    ctx.closePath();
    ctx.fill();
    // 暗面（右侧）
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.moveTo(shoulder * 0.36, shY - 0.06 * H);
    ctx.lineTo(shoulder * 1.1, shY - 0.06 * H);
    ctx.lineTo(shoulder * 1.1, hipY);
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
    ctx.restore();
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
    for (const s of [-1, 1]) {
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

    const DARK = '#16222f';
    const COAT = '#35618f';
    const COAT_D = '#1e3a56';
    const RIM = '#a8d8ff';
    // 和丧尸同一套语言：全身上下都裹一圈近黑的硬描边，站在血色雾气里也不糊
    const OL = '#080d14';
    const o = Math.max(0.7, H * 0.02);

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
  _heroPlant(ctx, game, H, sw, pl) {
    const n = Math.max(1, Math.min(5, Math.round(game.weapon.bullets)));
    const plant = pvzPlant(n);
    const recoil = pl.muzzle;
    const t = this.time * 2.2;

    // 茎 + 两片叶子（站在草坪上的植物）
    const OL = mix(plant.dark, '#0b1a08', 0.55);
    const o = Math.max(0.7, H * 0.02);
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

    const OL = '#1a1013';
    const o = Math.max(0.7, H * 0.02);
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

      // 一圈尖芒（慢慢转）
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(s.phase * 0.18);
      ctx.fillStyle = L.sun;
      for (let i = 0; i < 8; i++) {
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.6);
        ctx.lineTo(r * 0.34, -r * 1.5);
        ctx.lineTo(-r * 0.34, -r * 1.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = L.sunCore;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.7 * pulse, 0, TAU);
      ctx.fill();
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
      ctx.strokeStyle = '#2f7a1c';
      ctx.lineWidth = Math.max(1.4, r * 0.19);
      ctx.beginPath();
      ctx.moveTo(p.x, cy - r * 0.5);
      ctx.quadraticCurveTo(p.x + r * 0.5, cy - r * 1.5, p.x + r * 0.15, cy - r * 1.9);
      ctx.stroke();
      for (const sx of [-1, 1]) {
        ctx.fillStyle = bodyCol;
        ctx.beginPath();
        ctx.arc(p.x + sx * r * 0.5, cy, r * 0.66, 0, TAU);
        ctx.fill();
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
    for (const m of this._motes) {
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
    if (near < 3.6 && game.state !== 'over') {
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
    ctx.fillStyle = CFG.theme.panel || 'rgba(10,14,22,0.72)';
    roundRect(ctx, 10, baseY - 13, plateW, 26, 13);
    ctx.fill();
    ctx.strokeStyle = danger ? 'rgba(255,90,74,0.55)' : 'rgba(160,200,240,0.16)';
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
      // 外框
      ctx.strokeStyle = 'rgba(255,255,255,0.24)';
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
      const nm = boss.form === 2 ? CFG.pvz.boss2.name : CFG.level.skin === 'pvz' ? CFG.kinds.boss.pvz.name : '尸潮首领';
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
      const cy2 = safeTop + fs * 0.72;
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
    const accent = pvz ? '#ff6a4a' : '#8bf58b';
    const accentSoft = pvz ? 'rgba(255,150,120,' : 'rgba(160,255,170,';

    const charge = clamp(game.energy / CFG.charge.max, 0, 1);
    const full = charge >= 1;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 5.2);

    if (full) {
      this._drawGlow(cx, cy, R * 2.5, accent, 0.28 + pulse * 0.22);
    }

    ctx.fillStyle = full ? (pvz ? 'rgba(56,20,14,0.86)' : 'rgba(24,52,30,0.86)') : 'rgba(10,16,22,0.7)';
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
    if (pvz) {
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
    ctx.fillStyle = full ? accent : 'rgba(200,208,220,0.7)';
    ctx.fillText(full ? '点我' : `${Math.floor(charge * 100)}%`, cx, cy + R * 0.46);
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
