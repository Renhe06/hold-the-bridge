// ============================================================
//  地面平面透视相机
//
//  相机在原点上方 camHeight 处，朝 +z 方向看。
//  世界点 (x, z) -> 屏幕点：
//      scale = focal / z                每世界单位占多少像素
//      screenX = cx + x * scale
//      screenY = horizonY + camHeight * scale
//
//  这样敌人从 z 大处走向 z 小处时，会自然地从地平线上一个小点
//  一边变大一边加速逼近，不需要手写缓动曲线。
// ============================================================

import { CFG } from './config.js';
import { clamp } from './util.js';

export class Camera {
  constructor() {
    this.camZ = 0; // 相机锚点深度（由 game 每帧设成 hero.z - CFG.zNear）
    this.resize(1, 1);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.cx = w / 2;
    this.horizonY = h * CFG.horizonRatio;
    this.playerY = h * CFG.playerRatio;

    // 让 z = zNear 的地面正好投影到 playerY
    const span = (this.playerY - this.horizonY) * CFG.zNear;
    this.focal = span / CFG.camHeight;

    // 战车深处：每世界单位多少像素
    this.scaleNear = this.focal / CFG.zNear;
    // 桥面半宽（世界单位），使桥底占屏宽约 94%
    this.roadHalf = (CFG.roadHalfWidthRatio * w) / this.scaleNear;
  }

  /**
   * 世界 (x, z) -> 屏幕，附带该处的缩放系数
   *
   * camZ 是"相机锚点深度"：英雄能前后移动之后，相机跟着英雄走，
   * 所以世界坐标要先减掉锚点，英雄才永远画在 playerY 上、而世界向后滚。
   */
  project(x, z) {
    const s = this.focal / Math.max(1e-4, z - this.camZ);
    return {
      x: this.cx + x * s,
      y: this.horizonY + CFG.camHeight * s,
      s,
    };
  }

  /** 某个深度的缩放系数（像素/世界单位） */
  scaleAt(z) {
    return this.focal / Math.max(1e-4, z - this.camZ);
  }

  /** 屏幕 x -> 指定深度上的世界 x（用于把手指位置映射成英雄位置） */
  screenXToWorld(sx, z) {
    return ((sx - this.cx) * Math.max(1e-4, z - this.camZ)) / this.focal;
  }

  /** 屏幕 y -> 该处对应的深度（用于调试/点击拾取） */
  zAtScreenY(sy) {
    return this.camZ + (CFG.camHeight * this.focal) / Math.max(1e-3, sy - this.horizonY);
  }

  /** 把世界 x 限制在桥面范围内（留出 margin 的宽度） */
  clampToRoad(x, margin = 0) {
    const lim = Math.max(0, this.roadHalf - margin);
    return clamp(x, -lim, lim);
  }
}
