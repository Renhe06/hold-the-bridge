// ============================================================
//  生成 PWA 图标（纯 Node，自带 PNG 编码器，不依赖任何第三方库）
//
//  为什么不用 sharp：工作区里那份 sharp 装在 dsh-plugins/prewarm 下，
//  靠绝对路径 require 很脆；而 PNG 只需要 zlib，Node 内置，稳定得多。
//
//  运行：node tools/make-icons.mjs
//  产物：icons/icon-{180,192,512}.png
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'icons');

// ---------------------------------------------------------
//  PNG 编码
// ---------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------
//  极简软光栅（全部在超采样缓冲上操作，靠缩小时做抗锯齿）
// ---------------------------------------------------------

function makeCanvas(n) {
  return { n, px: new Uint8ClampedArray(n * n * 4) };
}

function blend(cv, x, y, r, g, b, a) {
  if (a <= 0) return;
  const { n, px } = cv;
  if (x < 0 || y < 0 || x >= n || y >= n) return;
  const i = (y * n + x) * 4;
  const da = px[i + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  px[i] = (r * a + px[i] * da * (1 - a)) / oa;
  px[i + 1] = (g * a + px[i + 1] * da * (1 - a)) / oa;
  px[i + 2] = (b * a + px[i + 2] * da * (1 - a)) / oa;
  px[i + 3] = oa * 255;
}

const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 竖直渐变铺满整张图 */
function vGradient(cv, stops) {
  const { n } = cv;
  for (let y = 0; y < n; y++) {
    const t = y / (n - 1);
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].at && t <= stops[i + 1].at) {
        a = stops[i];
        b = stops[i + 1];
        break;
      }
    }
    const k = b.at === a.at ? 0 : (t - a.at) / (b.at - a.at);
    const col = [lerp(a.c[0], b.c[0], k), lerp(a.c[1], b.c[1], k), lerp(a.c[2], b.c[2], k)];
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      cv.px[i] = col[0];
      cv.px[i + 1] = col[1];
      cv.px[i + 2] = col[2];
      cv.px[i + 3] = 255;
    }
  }
}

/** 径向辉光 */
function glow(cv, cx, cy, r, c, maxA, power = 2.2) {
  const { n } = cv;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(n - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(n - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d >= 1) continue;
      const a = Math.pow(1 - d, power) * maxA;
      blend(cv, x, y, c[0], c[1], c[2], a);
    }
  }
}

function disc(cv, cx, cy, r, c, alpha = 1) {
  const { n } = cv;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(n - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(n - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) blend(cv, x, y, c[0], c[1], c[2], alpha);
    }
  }
}

function rect(cv, x0, y0, x1, y1, c, alpha = 1) {
  const { n } = cv;
  const ax = Math.max(0, Math.round(x0));
  const bx = Math.min(n - 1, Math.round(x1));
  const ay = Math.max(0, Math.round(y0));
  const by = Math.min(n - 1, Math.round(y1));
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) blend(cv, x, y, c[0], c[1], c[2], alpha);
  }
}

/** 水平方向的逐行梯形填充：halfAt(y) 返回该行的半宽 */
function trapezoid(cv, yFrom, yTo, halfAt, colorAt, alpha = 1) {
  const { n } = cv;
  const ay = Math.max(0, Math.round(yFrom));
  const by = Math.min(n - 1, Math.round(yTo));
  for (let y = ay; y <= by; y++) {
    const hw = halfAt(y);
    if (!(hw > 0)) continue;
    const cx = n / 2;
    const x0 = Math.max(0, Math.round(cx - hw));
    const x1 = Math.min(n - 1, Math.round(cx + hw));
    const c = colorAt(y);
    for (let x = x0; x <= x1; x++) blend(cv, x, y, c[0], c[1], c[2], alpha);
  }
}

/** 盒式缩小（超采样 -> 目标尺寸），顺带完成抗锯齿 */
function downsample(cv, size) {
  const { n, px } = cv;
  const f = n / size;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let cnt = 0;
      const sy0 = Math.floor(y * f);
      const sy1 = Math.min(n, Math.ceil((y + 1) * f));
      const sx0 = Math.floor(x * f);
      const sx1 = Math.min(n, Math.ceil((x + 1) * f));
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * n + sx) * 4;
          const al = px[i + 3] / 255;
          r += px[i] * al;
          g += px[i + 1] * al;
          b += px[i + 2] * al;
          a += al;
          cnt++;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
        out[o + 3] = (a / cnt) * 255;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------
//  图标画面
// ---------------------------------------------------------

const C = {
  bgTop: hex('#04060b'),
  bgMid: hex('#0a1220'),
  bgLow: hex('#060a12'),
  moon: hex('#ff5340'),
  deckFar: hex('#39445a'),
  deckNear: hex('#5c6a86'),
  rail: hex('#8c9dbe'),
  dash: hex('#ffd166'),
  tankTop: hex('#7d8e63'),
  tankBot: hex('#1d2319'),
  edge: hex('#c3d6a3'),
  flame: hex('#ffae2e'),
  zombie: hex('#080c12'),
  eye: hex('#ff3a1f'),
};

function treeAt(t) {
  return Math.pow(clamp01(t), 1.35);
}

function renderIcon(size) {
  const SS = 4;
  const n = size * SS;
  const cv = makeCanvas(n);
  const N = n;

  // 1. 背景
  vGradient(cv, [
    { at: 0, c: C.bgTop },
    { at: 0.42, c: C.bgMid },
    { at: 1, c: C.bgLow },
  ]);

  const yHorizon = 0.5 * N;

  // 2. 月光辉光 + 月亮（远处的威胁，压在桥的尽头）
  glow(cv, 0.5 * N, 0.2 * N, 0.4 * N, C.moon, 0.22, 2.6);
  disc(cv, 0.5 * N, 0.2 * N, 0.079 * N, C.moon, 1);
  disc(cv, 0.5 * N, 0.2 * N, 0.079 * N, [255, 220, 180], 0.2);
  glow(cv, 0.5 * N, yHorizon, 0.24 * N, hex('#8fb4ff'), 0.1, 2.0);

  // 3. 桥面（由远及近张开的梯形）—— 特意不铺满屏宽，
  //    底部两侧留出黑水，才读得出是"桥"而不是"公路"
  const hwFar = 0.042 * N;
  const hwNear = 0.292 * N;
  const halfAt = (y) => {
    const t = (y - yHorizon) / (N - yHorizon);
    return hwFar + (hwNear - hwFar) * treeAt(t);
  };
  const deckAt = (y) => {
    const t = clamp01((y - yHorizon) / (N - yHorizon));
    return [
      lerp(C.deckFar[0], C.deckNear[0], t),
      lerp(C.deckFar[1], C.deckNear[1], t),
      lerp(C.deckFar[2], C.deckNear[2], t),
    ];
  };
  trapezoid(cv, yHorizon, N - 1, halfAt, deckAt, 1);

  // 护栏：沿两条边线叠一条亮边
  const railAt = (y) => {
    const t = clamp01((y - yHorizon) / (N - yHorizon));
    return [lerp(C.rail[0], C.rail[0] * 1.1, t), lerp(C.rail[1], C.rail[1] * 1.1, t), lerp(C.rail[2], C.rail[2] * 1.1, t)];
  };
  for (let y = Math.round(yHorizon); y < N; y++) {
    const hw = halfAt(y);
    const t = clamp01((y - yHorizon) / (N - yHorizon));
    const th = Math.max(1, (0.006 + 0.016 * t) * N);
    const c = railAt(y);
    const cx = N / 2;
    for (let d = 0; d < th; d++) {
      blend(cv, Math.round(cx - hw + d), y, c[0], c[1], c[2], 0.85);
      blend(cv, Math.round(cx + hw - d), y, c[0], c[1], c[2], 0.85);
    }
  }

  // 4. 中央虚线
  for (const t of [0.1, 0.28, 0.48, 0.7, 0.9]) {
    const y = yHorizon + t * (N - yHorizon);
    const w = (0.005 + 0.016 * t) * N;
    const h = (0.012 + 0.032 * t) * N;
    rect(cv, N / 2 - w / 2, y, N / 2 + w / 2, y + h, C.dash, 0.5);
  }

  // 5. 三只丧尸（远、中、近，红眼是唯一亮点）
  const walkers = [
    { t: 0.06, s: 0.05, x: -0.42 },
    { t: 0.15, s: 0.06, x: 0.52 },
    { t: 0.26, s: 0.076, x: 0.66 },
  ];
  for (const w of walkers) {
    const y = yHorizon + w.t * (N - yHorizon);
    const hw = halfAt(y);
    const x = N / 2 + w.x * hw;
    const h = w.s * N;
    const zc = C.zombie;
    rect(cv, x - h * 0.17, y - h * 0.12, x + h * 0.17, y + h * 0.62, zc, 1); // 躯干
    rect(cv, x - h * 0.28, y + h * 0.02, x - h * 0.16, y + h * 0.1, zc, 0.95); // 左臂
    rect(cv, x + h * 0.16, y + h * 0.02, x + h * 0.28, y + h * 0.1, zc, 0.95); // 右臂
    rect(cv, x - h * 0.15, y + h * 0.62, x - h * 0.03, y + h * 1.0, zc, 1); // 左腿
    rect(cv, x + h * 0.03, y + h * 0.62, x + h * 0.15, y + h * 1.0, zc, 1); // 右腿
    disc(cv, x, y - h * 0.3, h * 0.22, zc, 1); // 头
    disc(cv, x - h * 0.09, y - h * 0.32, h * 0.045, C.eye, 1);
    disc(cv, x + h * 0.09, y - h * 0.32, h * 0.045, C.eye, 1);
  }

  // 6. 战车（近景主体）
  const bodyHalfTop = 0.098 * N;
  const bodyHalfBot = 0.152 * N;
  const bodyTopY = 0.812 * N;
  const bodyBotY = 0.938 * N;
  trapezoid(
    cv,
    bodyTopY,
    bodyBotY,
    (y) => {
      const t = (y - bodyTopY) / (bodyBotY - bodyTopY);
      return lerp(bodyHalfTop, bodyHalfBot, t);
    },
    (y) => {
      const t = (y - bodyTopY) / (bodyBotY - bodyTopY);
      return [
        lerp(C.tankTop[0], C.tankBot[0], Math.pow(t, 0.7)),
        lerp(C.tankTop[1], C.tankBot[1], Math.pow(t, 0.7)),
        lerp(C.tankTop[2], C.tankBot[2], Math.pow(t, 0.7)),
      ];
    },
    1
  );
  // 顶部棱线高光：暗背景里拉出轮廓
  rect(cv, N / 2 - bodyHalfTop * 0.92, bodyTopY, N / 2 + bodyHalfTop * 0.92, bodyTopY + 0.016 * N, C.edge, 0.62);

  // 履带
  rect(cv, N / 2 - bodyHalfBot * 1.02, 0.902 * N, N / 2 - bodyHalfBot * 0.66, 0.95 * N, hex('#12160f'), 1);
  rect(cv, N / 2 + bodyHalfBot * 0.66, 0.902 * N, N / 2 + bodyHalfBot * 1.02, 0.95 * N, hex('#12160f'), 1);

  // 炮塔 + 炮管
  trapezoid(cv, 0.776 * N, 0.82 * N, (y) => 0.098 * N - ((y - 0.776 * N) / (0.044 * N)) * 0.018 * N, () => hex('#4c5a3d'), 1);
  rect(cv, N / 2 - 0.016 * N, 0.706 * N, N / 2 + 0.016 * N, 0.786 * N, hex('#39442d'), 1);
  rect(cv, N / 2 - 0.023 * N, 0.694 * N, N / 2 + 0.023 * N, 0.712 * N, hex('#2c3524'), 1);

  // 炮口火光（整张图的视觉焦点）
  glow(cv, N / 2, 0.694 * N, 0.092 * N, C.flame, 0.72, 2.4);
  disc(cv, N / 2, 0.69 * N, 0.02 * N, [255, 244, 200], 1);

  // 尾灯
  disc(cv, N / 2 - bodyHalfBot * 0.82, 0.9 * N, 0.011 * N, hex('#ff2d1a'), 0.95);
  disc(cv, N / 2 + bodyHalfBot * 0.82, 0.9 * N, 0.011 * N, hex('#ff2d1a'), 0.95);

  // 7. 暗角
  const vg = cv.px;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x - N / 2) / (N / 2);
      const dy = (y - N / 2) / (N / 2);
      const d = clamp01(Math.hypot(dx, dy) / 1.42);
      const a = Math.pow(d, 2.6) * 0.42;
      if (a <= 0.002) continue;
      const i = (y * N + x) * 4;
      vg[i] *= 1 - a;
      vg[i + 1] *= 1 - a;
      vg[i + 2] *= 1 - a;
    }
  }

  return downsample(cv, size);
}

// ---------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });

for (const size of [180, 192, 512]) {
  const rgba = renderIcon(size);
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, encodePNG(size, size, rgba));
  console.log(`icon-${size}.png  ${fs.statSync(file).size} bytes`);
}

// 顺便给个 512 的 favicon 方便浏览器用
console.log('done ->', OUT);
