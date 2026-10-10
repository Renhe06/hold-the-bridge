// ============================================================
//  程序化渲染层：整座桥、夜空、丧尸、战车、特效全部用 Canvas 路径画出来
//
//  性能约定（手机上很关键）：
//   - 完全不用 ctx.shadowBlur（移动端极慢）
//   - 发光效果预先烘焙成 64×64 精灵图，之后靠 drawImage 缩放贴
//   - 星空 / 城市剪影烘焙成离屏 canvas，只在 resize 时重算
//   - 径向渐变只在上面那两种烘焙里创建，主循环里不新建渐变对象
// ============================================================

import { CFG, WEAPON_TIERS, isHordeWave, isBossWave } from './config.js';
import { clamp, mulberry32, mix, rgba } from './util.js';

const TAU = Math.PI * 2;
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, system-ui, sans-serif';

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

    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#04060c');
    sky.addColorStop(0.5, '#0a1019');
    sky.addColorStop(0.82, '#151727');
    sky.addColorStop(1, '#2a1c22');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // 地平线城市光污染
    const pollute = g.createRadialGradient(w * 0.5, h, 0, w * 0.5, h, w * 0.72);
    pollute.addColorStop(0, 'rgba(255,150,90,0.20)');
    pollute.addColorStop(0.45, 'rgba(180,90,110,0.09)');
    pollute.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = pollute;
    g.fillRect(0, 0, w, h);

    const rnd = mulberry32(20260416);
    // 星星
    for (let i = 0; i < 150; i++) {
      const x = rnd() * w;
      const y = rnd() * (h - 14) * 0.92;
      const a = 0.15 + rnd() * 0.7;
      const r = 0.4 + rnd() * 1.05;
      g.fillStyle = `rgba(220,235,255,${a * (1 - y / h) + 0.06})`;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }

    // 月亮
    const mx = w * 0.72;
    const my = h * 0.34;
    const mr = Math.max(13, w * 0.055);
    const halo = g.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 5.2);
    halo.addColorStop(0, 'rgba(210,225,240,0.20)');
    halo.addColorStop(0.4, 'rgba(170,195,225,0.07)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = halo;
    g.fillRect(mx - mr * 5.2, my - mr * 5.2, mr * 10.4, mr * 10.4);

    g.fillStyle = '#cfd9e2';
    g.beginPath();
    g.arc(mx, my, mr, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(120,135,150,0.30)';
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

    this._drawBackdrop(ctx, w, h);
    this._drawPlane(ctx, game);
    this._drawWater(ctx, w, h);
    this._drawDeck(ctx);
    this._drawGround(ctx, game);
    this._drawHaze(ctx, w);
    this._drawEntities(ctx, game);
    this._drawMissiles(ctx, game);
    this._drawFog(ctx, w);
    this._drawRings(ctx, game);
    this._drawHero(ctx, game);
    this._drawShout(ctx, game);
    this._drawScreenFx(ctx, game, w, h);
    ctx.translate(-ox, -oy);
    this._drawPopups(ctx, game);
    this._drawHudCanvas(ctx, game, w, h);
  }

  _drawBackdrop(ctx, w, h) {
    const horizon = this.cam.horizonY;
    ctx.drawImage(this.skyCanvas, 0, 0, w, this.skyH);
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, w, 0);
    // 城市剪影，底部贴地平线
    ctx.drawImage(this.cityCanvas, 0, horizon - this.cityH + 3, w, this.cityH);
    // 地平线霓虹底光
    const g = ctx.createLinearGradient(0, horizon - 26, 0, horizon + 12);
    g.addColorStop(0, 'rgba(255,120,80,0)');
    g.addColorStop(0.65, 'rgba(255,110,70,0.16)');
    g.addColorStop(1, 'rgba(255,80,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon - 26, w, 38);
  }

  _drawWater(ctx, w, h) {
    const horizon = this.cam.horizonY;
    const g = ctx.createLinearGradient(0, horizon, 0, h);
    g.addColorStop(0, '#0d1420');
    g.addColorStop(0.35, '#080c15');
    g.addColorStop(1, '#03050a');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, w, h - horizon);

    // 水面碎光
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
      g2.addColorStop(0, 'rgba(255,150,90,0)');
      g2.addColorStop(0.5, `rgba(255,170,110,${a})`);
      g2.addColorStop(1, 'rgba(255,150,90,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(cx - cw / 2, yy, cw, 1.5);
    }
    ctx.restore();
  }

  _drawDeck(ctx) {
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
    g.addColorStop(0, '#0f1218');
    g.addColorStop(0.25, '#1b1f26');
    g.addColorStop(0.6, '#262b33');
    g.addColorStop(1, '#30363f');
    ctx.fillStyle = g;
    ctx.fill();

    // 伸缩缝（给纵深提供参照物）
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
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
    ctx.fillStyle = 'rgba(226,206,140,0.30)';
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
      eg.addColorStop(0, 'rgba(180,150,70,0.10)');
      eg.addColorStop(0.5, 'rgba(226,196,110,0.34)');
      eg.addColorStop(1, 'rgba(240,214,130,0.5)');
      ctx.fillStyle = eg;
      ctx.fill();
    }

    // 护栏：立柱 + 顶部横栏（强透视线，是"桥"的关键视觉）
    const railH = 0.085;
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
      ctx.strokeStyle = 'rgba(96,106,120,0.85)';
      ctx.lineWidth = Math.max(0.8, cam.scaleNear * 0.012);
      ctx.stroke();

      // 立柱（世界等距，远处自然压缩）
      for (let z = zN; z < 78; z += 2.2) {
        const p = cam.project(xs, z);
        const top = p.y - railH * p.s;
        const wdt = Math.max(0.7, 0.014 * p.s);
        if (p.y - top < 0.7) continue;
        ctx.fillStyle = 'rgba(80,88,100,0.9)';
        ctx.fillRect(p.x - wdt / 2, top, wdt, p.y - top);
        // 锈迹高光
        ctx.fillStyle = 'rgba(150,110,80,0.5)';
        ctx.fillRect(p.x - wdt / 2, top, wdt, Math.max(0.6, (p.y - top) * 0.22));
      }
    }
  }

  /** 淡淡的空气感，压在地平线附近 */
  _drawHaze(ctx, w) {
    const horizon = this.cam.horizonY;
    const bottom = horizon + this.h * 0.30;
    const g = ctx.createLinearGradient(0, horizon - 4, 0, bottom);
    g.addColorStop(0, 'rgba(20,24,34,0.72)');
    g.addColorStop(0.45, 'rgba(18,22,32,0.30)');
    g.addColorStop(1, 'rgba(16,20,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon - 4, w, bottom - horizon + 4);
  }

  /** 浓雾：盖在远景丧尸身上，让他们"从雾里走出来" */
  _drawFog(ctx, w) {
    const horizon = this.cam.horizonY;
    const bottom = horizon + this.h * CFG.fogTo;
    const g = ctx.createLinearGradient(0, horizon - 6, 0, bottom);
    g.addColorStop(0, 'rgba(26,30,40,0.96)');
    g.addColorStop(0.3, 'rgba(24,28,38,0.80)');
    g.addColorStop(0.7, 'rgba(22,26,36,0.34)');
    g.addColorStop(1, 'rgba(20,24,34,0)');
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
    const cam = this.cam;

    // 血泊（这一波留下的，越打越脏）
    for (const s of game.stains) {
      const p = cam.project(s.x, s.z);
      ctx.globalAlpha = s.a * 0.75;
      ctx.fillStyle = '#3d0808';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, s.r * p.s * 0.5, s.r * p.s * 0.2, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = s.a * 0.5;
      ctx.fillStyle = '#8d1010';
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
      this._zombieBody(ctx, H, mix(c.color, '#2a1a1a', 0.35 + fall * 0.3), c.dark, c.phase, c.kind, false);
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
    const r = Math.max(2, 0.022 * p.s);
    const wob = 1 + Math.sin(s.phase) * 0.18;
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

  _drawBullet(ctx, game, b) {
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
      // 太远：画一个小点，省性能也避免糊成一团
      ctx.globalAlpha = fade * 0.75;
      this._drawGlow(p.x, p.y - H * 0.5, Math.max(0.9, H * 0.7), '#ff5a3c', 0.6);
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

    this._zombieBody(ctx, H, col, dark, e.phase, e.kind, isWind);

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
    if (e.maxShield > 0 && e.shield > 0) {
      const w = H * 0.62;
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

  /** 在"脚底为原点、头在 -H"的局部坐标里画人形剪影 */
  _zombieBody(ctx, H, col, dark, phase, kind, isWind) {
    const swing = Math.sin(phase);
    const hipY = -0.42 * H;
    const shY = -0.70 * H;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 腿
    ctx.strokeStyle = dark;
    ctx.lineWidth = 0.115 * H;
    for (const s of [-1, 1]) {
      const footX = s * 0.085 * H - s * swing * 0.13 * H;
      ctx.beginPath();
      ctx.moveTo(0, hipY);
      ctx.lineTo(footX, -0.03 * H);
      ctx.stroke();
    }

    // 手臂
    ctx.strokeStyle = col;
    ctx.lineWidth = 0.082 * H;
    for (const s of [-1, 1]) {
      const handX = s * 0.20 * H + s * swing * 0.15 * H;
      const handY = -0.34 * H + Math.abs(swing) * 0.03 * H;
      ctx.beginPath();
      ctx.moveTo(s * 0.14 * H, shY + 0.02 * H);
      ctx.lineTo(handX, handY);
      ctx.stroke();
    }
    // BOSS 多两条小手臂
    if (kind === 'boss') {
      ctx.lineWidth = 0.07 * H;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.12 * H, -0.52 * H);
        ctx.lineTo(s * 0.30 * H, -0.44 * H + swing * 0.04 * H);
        ctx.stroke();
      }
    }

    // 躯干
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-0.145 * H, hipY);
    ctx.lineTo(-0.17 * H, shY);
    ctx.lineTo(0.17 * H, shY);
    ctx.lineTo(0.145 * H, hipY);
    ctx.closePath();
    ctx.fill();
    // 破衣服的下摆
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(-0.145 * H, hipY - 0.04 * H);
    ctx.lineTo(0.145 * H, hipY - 0.04 * H);
    ctx.lineTo(0.12 * H, hipY + 0.03 * H);
    ctx.lineTo(-0.11 * H, hipY + 0.02 * H);
    ctx.closePath();
    ctx.fill();

    // 头
    const headY = -0.815 * H;
    const headR = 0.11 * H;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, TAU);
    ctx.fill();
    // 下巴/口部暗面
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.arc(0.012 * H, headY + headR * 0.34, headR * 0.62, 0, TAU);
    ctx.fill();

    if (kind === 'boss') {
      ctx.strokeStyle = dark;
      ctx.lineWidth = 0.05 * H;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * headR * 0.7, headY - headR * 0.5);
        ctx.lineTo(s * headR * 1.9, headY - headR * 1.7);
        ctx.stroke();
      }
    }

    // 眼睛（唯一的高饱和亮点，小屏上辨识度靠它）
    const eyeR = Math.max(0.6, headR * (kind === 'boss' ? 0.30 : 0.22));
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
    ctx.save();
    ctx.translate(p.x, feet - rec);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const DARK = '#16222f';
    const COAT = '#35618f';
    const COAT_D = '#1e3a56';
    const RIM = '#a8d8ff';

    // 腿
    ctx.strokeStyle = '#243a52';
    ctx.lineWidth = H * 0.105;
    for (const s of [-1, 1]) {
      const fx = s * H * 0.065 + s * sw * H * 0.10;
      ctx.beginPath();
      ctx.moveTo(s * H * 0.05, -H * 0.44);
      ctx.lineTo(fx, -H * 0.02);
      ctx.stroke();
    }

    // 背包（背影视角最认得出来的部件）
    roundRect(ctx, -H * 0.105, -H * 0.72, H * 0.21, H * 0.26, H * 0.05);
    ctx.fillStyle = '#22384e';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,180,220,0.35)';
    ctx.lineWidth = Math.max(0.8, H * 0.012);
    ctx.stroke();

    // 躯干
    ctx.beginPath();
    ctx.moveTo(-H * 0.115, -H * 0.44);
    ctx.lineTo(-H * 0.13, -H * 0.74);
    ctx.lineTo(H * 0.13, -H * 0.74);
    ctx.lineTo(H * 0.115, -H * 0.44);
    ctx.closePath();
    const cg = ctx.createLinearGradient(0, -H * 0.74, 0, -H * 0.42);
    cg.addColorStop(0, COAT);
    cg.addColorStop(1, COAT_D);
    ctx.fillStyle = cg;
    ctx.fill();
    // 肩线高光
    ctx.strokeStyle = RIM;
    ctx.lineWidth = Math.max(1, H * 0.016);
    ctx.beginPath();
    ctx.moveTo(-H * 0.105, -H * 0.735);
    ctx.lineTo(H * 0.105, -H * 0.735);
    ctx.stroke();

    // 双臂：左手垂着，右手端枪
    ctx.strokeStyle = COAT_D;
    ctx.lineWidth = H * 0.062;
    ctx.beginPath();
    ctx.moveTo(-H * 0.115, -H * 0.70);
    ctx.lineTo(-H * 0.175, -H * 0.44 + sw * H * 0.03);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(H * 0.115, -H * 0.70);
    ctx.lineTo(H * 0.135, -H * 0.52);
    ctx.stroke();

    // 枪（朝前的短枪管）
    const gunY = -H * 0.52;
    ctx.fillStyle = DARK;
    roundRect(ctx, H * 0.03, gunY - H * 0.022, H * 0.20, H * 0.045, H * 0.02);
    ctx.fill();
    ctx.fillStyle = 'rgba(150,180,200,0.4)';
    ctx.fillRect(H * 0.03, gunY - H * 0.022, H * 0.20, H * 0.012);

    // 头 + 头盔
    const headY = -H * 0.845;
    const headR = H * 0.098;
    ctx.fillStyle = '#c9d6e2';
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, TAU);
    ctx.fill();
    // 头盔（盖住上半 + 后颈）
    ctx.fillStyle = '#26405a';
    ctx.beginPath();
    ctx.arc(0, headY - headR * 0.08, headR * 1.12, Math.PI * 1.02, Math.PI * 1.98);
    ctx.lineTo(headR * 0.9, headY + headR * 0.25);
    ctx.lineTo(-headR * 0.9, headY + headR * 0.25);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(168,216,255,0.55)';
    ctx.lineWidth = Math.max(0.7, H * 0.011);
    ctx.beginPath();
    ctx.arc(0, headY - headR * 0.08, headR * 1.12, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    // 头盔后灯
    this._drawGlow(0, headY + headR * 0.05, headR * 0.5, '#7df9ff', 0.5);

    // 枪口火光
    if (pl.muzzle > 0) {
      const mx = H * 0.23;
      const mr = H * (0.10 + pl.muzzle * 0.16);
      this._drawGlow(mx, gunY, mr, '#ffc86a', pl.muzzle);
      this._drawGlow(mx, gunY, mr * 0.45, '#fff3d0', pl.muzzle);
    }

    ctx.restore();

    // 护盾
    if (pl.shield > 0) {
      ctx.strokeStyle = `rgba(125,249,255,${0.30 + 0.16 * Math.sin(this.time * 5)})`;
      ctx.lineWidth = Math.max(1.2, H * 0.02);
      ctx.beginPath();
      ctx.ellipse(p.x, feet - H * 0.5, H * 0.34, H * 0.60, 0, 0, TAU);
      ctx.stroke();
    }

    // 受击白闪
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
      pg.addColorStop(0.55, 'rgba(10,14,22,0.72)');
      pg.addColorStop(1, rgba(col, active ? 0.28 : 0.14));
      ctx.fillStyle = pg;
      ctx.fill();
      ctx.strokeStyle = rgba(col, active ? 0.95 : 0.5);
      ctx.lineWidth = Math.max(1.2, ph * 0.022);
      ctx.stroke();

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

  // ---------------------------------------------------------
  //  屏幕特效 / 飘字 / HUD
  // ---------------------------------------------------------

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

    // 心
    for (let i = 0; i < pl.maxHp; i++) {
      const x = 18 + i * 20;
      const on = i < pl.hp;
      this._drawHeart(ctx, x, baseY, 7.4, on);
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
      // BOSS 只在最后一波；第 5/10 波只来人海，横幅要说清楚区别
      if (bossWave) {
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
      const label = '尸 潮 首 领';
      ctx.strokeText(label, bx, by - bh * 0.9);
      ctx.fillText(label, bx, by - bh * 0.9);
      ctx.textAlign = 'right';
      const hpTxt = `${Math.max(0, Math.ceil(boss.hp))} / ${boss.maxHp}`;
      ctx.strokeText(hpTxt, bx + bw, by - bh * 0.9);
      ctx.fillText(hpTxt, bx + bw, by - bh * 0.9);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      // 给测试留一个可读的落点（跟空袭按钮同一个套路）
      this.bossBar = { x: bx, y: by, w: bw, h: bh, frac, hp: boss.hp, maxHp: boss.maxHp };
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

    const charge = clamp(game.energy / CFG.charge.max, 0, 1);
    const full = charge >= 1;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 5.2);

    if (full) {
      this._drawGlow(cx, cy, R * 2.5, '#8bf58b', 0.28 + pulse * 0.22);
    }

    ctx.fillStyle = full ? 'rgba(24,52,30,0.86)' : 'rgba(10,16,22,0.7)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = full ? `rgba(160,255,170,${0.6 + pulse * 0.4})` : 'rgba(150,160,175,0.5)';
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
    ctx.strokeStyle = full ? '#8bf58b' : '#ffd166';
    ctx.beginPath();
    ctx.arc(cx, cy, R - lw * 0.5, -Math.PI / 2, -Math.PI / 2 + TAU * charge);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(R * 0.52)}px ${FONT}`;
    ctx.fillStyle = full ? '#eaffe6' : 'rgba(233,236,240,0.72)';
    ctx.fillText('空袭', cx, cy - R * 0.06);
    ctx.font = `700 ${Math.round(R * 0.3)}px ${FONT}`;
    ctx.fillStyle = full ? '#8bf58b' : 'rgba(200,208,220,0.7)';
    ctx.fillText(full ? '点我' : `${Math.floor(charge * 100)}%`, cx, cy + R * 0.42);
    ctx.textBaseline = 'alphabetic';
  }

  _drawHeart(ctx, cx, cy, r, filled) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, r * 0.75);
    ctx.bezierCurveTo(-r * 1.5, -r * 0.18, -r * 0.6, -r * 1.25, 0, -r * 0.42);
    ctx.bezierCurveTo(r * 0.6, -r * 1.25, r * 1.5, -r * 0.18, 0, r * 0.75);
    ctx.closePath();
    if (filled) {
      ctx.fillStyle = '#ff4d5e';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,180,190,0.85)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(60,64,72,0.6)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(140,146,158,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }
}
