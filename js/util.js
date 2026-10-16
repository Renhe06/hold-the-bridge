// 通用小工具

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** 从数组里随机取 n 个不重复元素（Fisher-Yates 部分洗牌） */
export function sample(arr, n) {
  const pool = arr.slice();
  const out = [];
  const k = Math.min(n, pool.length);
  for (let i = 0; i < k; i++) {
    const j = Math.floor(Math.random() * pool.length);
    out.push(pool[j]);
    pool.splice(j, 1);
  }
  return out;
}

/** 按权重随机取一个：元素上的 .weight 越大越容易被抽中（没写就当 1）
 *  【m02403】奖励门用它给寒冰/炎火加权，好让冰火构筑抽得出来 */
export function pickWeighted(arr) {
  let total = 0;
  for (const it of arr) total += it.weight || 1;
  let r = Math.random() * total;
  for (const it of arr) {
    r -= it.weight || 1;
    if (r <= 0) return it;
  }
  return arr[arr.length - 1];
}

/** 带种子的伪随机，用于生成星空/城市轮廓这种"每次一样"的东西 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------
//  颜色工具：全部带缓存
//
//  【用户 m02901 性能】这三个函数在渲染里每帧被调用上千次（每只丧尸、
//  每颗粒子都要算），原来每次都要：
//  ① new 一个 {r,g,b} 对象 ② 拼一个模板字符串 —— 50 只丧尸 + 300 粒子
//  就是每秒几万次分配，Node 上实测每 19 帧触发一次 700ms 的 major GC，
//  手机上就是"时不时卡一下"。现在：
//  · hexToRgb 结果缓存（颜色集合本来就有界）
//  · rgba / mix 按"颜色 + 量化后的透明度/混合系数"缓存字符串
//    （量化到 1/64，肉眼看不出，但缓存命中率从"几乎不中"变成"几乎全中"）
//  输出的字符串与原实现一致（量化误差 ≤ 1/64）。
// ---------------------------------------------------------

const RGB_CACHE = new Map();
/** #rrggbb -> {r,g,b}（带缓存，返回的对象不要再改） */
export function hexToRgb(hex) {
  let c = RGB_CACHE.get(hex);
  if (c !== undefined) return c;
  const h = hex.replace('#', '');
  c = {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
  if (RGB_CACHE.size > 1024) RGB_CACHE.clear();
  RGB_CACHE.set(hex, c);
  return c;
}

const RGBA_CACHE = new Map();
export function rgba(hex, a) {
  const A = Math.round(a * 64) / 64;
  const key = hex + '|' + A;
  let s = RGBA_CACHE.get(key);
  if (s !== undefined) return s;
  const c = hexToRgb(hex);
  s = `rgba(${c.r},${c.g},${c.b},${A})`;
  if (RGBA_CACHE.size > 8192) RGBA_CACHE.clear();
  RGBA_CACHE.set(key, s);
  return s;
}

const MIX_CACHE = new Map();
/** 两个十六进制颜色按 t 混合（t 量化到 1/64 后缓存） */
export function mix(hexA, hexB, t) {
  const T = Math.round(t * 64) / 64;
  const key = hexA + hexB + T;
  let s = MIX_CACHE.get(key);
  if (s !== undefined) return s;
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const r = Math.round(lerp(a.r, b.r, T));
  const g = Math.round(lerp(a.g, b.g, T));
  const bl = Math.round(lerp(a.b, b.b, T));
  s = `rgb(${r},${g},${bl})`;
  if (MIX_CACHE.size > 8192) MIX_CACHE.clear();
  MIX_CACHE.set(key, s);
  return s;
}
