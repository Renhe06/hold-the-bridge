// ============================================================
//  共享的 DOM / 全局桩
//
//  两个用途：
//   1) tools/smoke-test.mjs —— 假 canvas，只跑逻辑，验证不抛异常
//   2) viz/shot.mjs        —— 真 canvas（@napi-rs/canvas），出 PNG 看画面
//
//  之所以抽出来共用：这两条路的 DOM 形状必须完全一致，否则会出现
//  "冒烟测试过了但出图夹具崩" 这种假阳性/假阴性。
//
//  原则：只实现代码真正会用到的方法。一旦有代码调了不存在的方法，
//  就抛 "xxx is not a function"——这正是要抓的错误。
// ============================================================

export const GRADIENT = { addColorStop() {} };

export const CTX_METHODS = [
  'save', 'restore', 'scale', 'rotate', 'translate', 'transform', 'setTransform', 'resetTransform',
  'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'bezierCurveTo', 'quadraticCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect',
  'fill', 'stroke', 'clip', 'fillText', 'strokeText', 'drawImage', 'setLineDash', 'putImageData',
];

export function makeCtx(canvas) {
  const ctx = { canvas };
  for (const m of CTX_METHODS) ctx[m] = () => {};
  ctx.createLinearGradient = () => GRADIENT;
  ctx.createRadialGradient = () => GRADIENT;
  ctx.createConicGradient = () => GRADIENT;
  ctx.createPattern = () => null;
  ctx.measureText = (t) => ({ width: String(t).length * 8 });
  ctx.getLineDash = () => [];
  ctx.getImageData = (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
  ctx.createImageData = (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
  ctx.isPointInPath = () => false;
  return ctx;
}

export class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}

export function makeStyle() {
  return {
    setProperty(k, v) { this[k] = v; },
    removeProperty(k) { delete this[k]; },
    getPropertyValue(k) { return this[k] || ''; },
  };
}

export function makeEl(tag, id) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: id || '',
    children: [],
    parent: null,
    style: makeStyle(),
    classList: new FakeClassList(),
    textContent: '',
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0,
    _ctx: null,
    _listeners: {},
  };
  el.addEventListener = (type, fn) => { (el._listeners[type] ||= []).push(fn); };
  el.removeEventListener = () => {};
  el.dispatch = (type, ev) => {
    const list = el._listeners[type] || [];
    for (const fn of list) fn(ev || {});
    return list.length;
  };
  el.appendChild = (c) => { el.children.push(c); c.parent = el; return c; };
  el.removeChild = (c) => { el.children = el.children.filter((x) => x !== c); return c; };
  el.setAttribute = () => {};
  el.getAttribute = () => null;
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  el.focus = () => {};
  el.blur = () => {};
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 44, width: 390, height: 44 });
  el.getContext = () => (el._ctx ||= makeCtx(el));
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.children.length = 0; },
  });
  return el;
}

/**
 * 装上全局桩。
 * @param {object} opts
 * @param {number} [opts.width=390]   CSS 视口宽
 * @param {number} [opts.height=844]  CSS 视口高
 * @param {number} [opts.dpr=3]       devicePixelRatio
 * @param {() => any} [opts.makeCanvas] 提供真 canvas（出图夹具用）。给了它，
 *        #game 与 document.createElement('canvas') 就都返回真 canvas。
 * @param {number} [opts.perf0=1000]  虚拟时钟起点
 */
export function installDom(opts = {}) {
  const {
    width = 390, height = 844, dpr = 3,
    makeCanvas = null,
    hostname = 'localhost',
    href = 'http://localhost/',
    perf0 = 1000,
  } = opts;

  const ELS = new Map();
  const RAF = [];
  const WINDOW_LISTENERS = {};
  const P = { now: perf0 };

  /** 真 canvas 也要能当元素用（render.js 会往它上面挂 ctx / 读 width） */
  function realCanvasEl() {
    const c = makeCanvas();
    c.addEventListener = () => {};
    c.removeEventListener = () => {};
    c.setPointerCapture = () => {};
    c.releasePointerCapture = () => {};
    c.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height });
    if (!c.style) c.style = makeStyle();
    if (!c.classList) c.classList = new FakeClassList();
    c.setAttribute = () => {};
    c.getAttribute = () => null;
    return c;
  }

  const APP = makeEl('div', 'app');
  APP.clientWidth = width;
  APP.clientHeight = height;
  ELS.set('app', APP);

  const CANVAS = makeEl('canvas', 'game');
  CANVAS.clientWidth = width;
  CANVAS.clientHeight = height;
  CANVAS.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height });
  ELS.set('game', CANVAS);

  // 出图模式：#game 的 width/height/getContext 全部代理到真 canvas，
  // 这样 render.js 里 `canvas.width = cssW*dpr` 会真的重建位图。
  if (makeCanvas) {
    const real = makeCanvas();
    Object.defineProperty(CANVAS, 'width', { get: () => real.width, set: (v) => { real.width = v; }, configurable: true });
    Object.defineProperty(CANVAS, 'height', { get: () => real.height, set: (v) => { real.height = v; }, configurable: true });
    CANVAS.getContext = (...a) => real.getContext(...a);
    CANVAS._real = real;
  }

  const DOC = {
    hidden: false,
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById(id) {
      if (!ELS.has(id)) ELS.set(id, makeEl('div', id));
      return ELS.get(id);
    },
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas' && makeCanvas) return realCanvasEl();
      return makeEl(tag);
    },
    addEventListener() {},
    removeEventListener() {},
  };

  function def(name, value) {
    try {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    } catch (_) {
      globalThis[name] = value;
    }
  }

  def('document', DOC);
  def('navigator', { userAgent: 'dom-stub', serviceWorker: undefined });
  def('location', { hostname, protocol: 'http:', href });
  def('devicePixelRatio', dpr);
  def('innerWidth', width);
  def('innerHeight', height);
  def('visualViewport', undefined);
  def('performance', { now: () => P.now, timeOrigin: 0 });
  def('requestAnimationFrame', (cb) => { RAF.push(cb); return RAF.length; });
  def('cancelAnimationFrame', () => {});
  def('addEventListener', (t, fn) => { (WINDOW_LISTENERS[t] ||= []).push(fn); });
  def('removeEventListener', () => {});
  def('localStorage', (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
    };
  })());
  def('window', globalThis);

  // def 也返回出去：测试里要中途改 devicePixelRatio / innerWidth 来模拟旋转
  return { ELS, DOC, CANVAS, APP, RAF, WINDOW_LISTENERS, P, def, width, height, dpr };
}
