// ============================================================
//  《守桥》启动器
//  职责：尺寸/DPR 适配、输入接管、RAF 主循环、DOM 与游戏状态同步
// ============================================================

import { Camera } from './camera.js';
import { Sound } from './audio.js';
import { Game, STATE } from './game.js';
import { Renderer, TAG_COLOR } from './render.js';
import { CFG, isHordeWave, isBossWave, findLevel, levelIndexOf, HEROES, HERO_KEY } from './config.js';
import { QUALITY } from './quality.js';
import { I18N } from './i18n.js';
import { CHANGELOG } from './changelog.js';

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  canvas: $('game'),
  hudTop: $('hudTop'),
  hudMid: $('hudMid'),
  score: $('score'),
  waveLabel: $('waveLabel'),
  bestLabel: $('bestLabel'),
  tierLabel: $('tierLabel'),
  prepLabel: $('prepLabel'),
  gainToast: $('gainToast'),
  muteBtn: $('muteBtn'),
  startOverlay: $('startOverlay'),
  startBtn: $('startBtn'),
  startBest: $('startBest'),
  startCoins: $('startCoins'),
  menuRole: $('menuRole'),
  menuWeapon: $('menuWeapon'),
  menuShop: $('menuShop'),
  menuLevel: $('menuLevel'),
  menuLevelNote: $('menuLevelNote'),
  guideOverlay: $('guideOverlay'),
  guideBtn: $('guideBtn'),
  guideClose: $('guideClose'),
  menuHint: $('menuHint'),
  langBtn: $('langBtn'),
  logBtn: $('logBtn'),
  logOverlay: $('logOverlay'),
  logList: $('logList'),
  logClose: $('logClose'),
  overOverlay: $('overOverlay'),
  overTitle: $('overTitle'),
  newBest: $('newBest'),
  overScore: $('overScore'),
  overBest: $('overBest'),
  overWave: $('overWave'),
  overKills: $('overKills'),
  overTier: $('overTier'),
  againBtn: $('againBtn'),
  clearOverlay: $('clearOverlay'),
  clearCoins: $('clearCoins'),
  clearScore: $('clearScore'),
  clearKills: $('clearKills'),
  clearCombo: $('clearCombo'),
  clearTotal: $('clearTotal'),
  clearAgain: $('clearAgain'),
  clearMenu: $('clearMenu'),
  clearNext: $('clearNext'),
  clearTitle: $('clearTitle'),
  talkOverlay: $('talkOverlay'),
  talkPortrait: $('talkPortrait'),
  talkName: $('talkName'),
  talkText: $('talkText'),
  talkStamp: $('talkStamp'),
  talkMore: $('talkMore'),
  talkActions: $('talkActions'),
  talkStart: $('talkStart'),
  // 选关面板：第 1~3 关真能进，第 4~10 关是灰按钮（点了只提示未实装）
  levelOverlay: $('levelOverlay'),
  levelGrid: $('levelGrid'),
  levelHint: $('levelHint'),
  levelClose: $('levelClose'),
  lv1: $('lv1'),
  lv2: $('lv2'),
  lv3: $('lv3'),
  lv4: $('lv4'),
  lv5: $('lv5'),
  lv6: $('lv6'),
  lv7: $('lv7'),
  lv8: $('lv8'),
  lv9: $('lv9'),
  lv10: $('lv10'),
  // 角色面板（用户 m04749）：勇者 / 花仙子，只在第四关生效
  heroOverlay: $('heroOverlay'),
  heroGrid: $('heroGrid'),
  heroHint: $('heroHint'),
  heroClose: $('heroClose'),
  heroKnight: $('heroKnight'),
  heroFairy: $('heroFairy'),
  // 局内左下角：返回主界面 / 暂停；以及暂停面板
  ingameBtns: $('ingameBtns'),
  backBtn: $('backBtn'),
  pauseBtn: $('pauseBtn'),
  pauseOverlay: $('pauseOverlay'),
  resumeBtn: $('resumeBtn'),
  pauseMenu: $('pauseMenu'),
  // 暂停面板上的音效自检那一行（用户说"经常没声音"，得让他能一眼看出是哪一种）
  audioState: $('audioState'),
};

// ---------------------------------------------------------
//  中英双语（用户 m02901）
//  按钮上永远写"另一种语言"：中文界面显示 English，英文界面显示 中文
// ---------------------------------------------------------
function syncLangBtn() {
  if (!el.langBtn) return;
  el.langBtn.textContent = I18N.isEn() ? '中文' : 'English';
  el.langBtn.setAttribute('aria-label', I18N.isEn() ? '切换到中文' : 'Switch to English');
}

if (el.langBtn) {
  el.langBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    I18N.toggle(); // set() 内部会重扫一遍 DOM
    syncLangBtn();
    document.documentElement.setAttribute('data-lang', I18N.isEn() ? 'en' : 'zh');
  });
}
document.documentElement.setAttribute('data-lang', I18N.isEn() ? 'en' : 'zh');

// ---------------------------------------------------------
//  核心对象
// ---------------------------------------------------------

const cam = new Camera();
const sfx = new Sound();
const game = new Game(cam, sfx);
const renderer = new Renderer(el.canvas, cam, game);

// ---------------------------------------------------------
//  尺寸适配
//  - 相机与渲染都用 CSS 像素坐标，渲染器内部再乘 dpr 到物理像素
//  - dpr 封顶 2：iPhone 是 3，按 3 渲染像素量是 2 倍时的 2.25 倍，
//    而本游戏全是矢量图，2 倍已经很干净，能省一大截填充率
// ---------------------------------------------------------

const MUTE_KEY = 'hold-the-bridge:muted';

function measureTopHud() {
  // canvas 上画的心形血量要排在 DOM 顶部 HUD 的正下方，所以量出来交给渲染器
  const r = el.hudTop.getBoundingClientRect();
  renderer.safeTop = Math.round(r.bottom) + 4;
}

function fit() {
  const w = Math.max(1, el.app.clientWidth || window.innerWidth);
  const h = Math.max(1, el.app.clientHeight || window.innerHeight);
  // 【用户 m02901】DPR 上限跟画质档走：真机上"全屏半透明叠好几层"是填充率大头，
  // 2 → 1.5 就少画 44% 的像素。档位由 QUALITY 盯着真实帧时间自动调。
  const dpr = Math.min(window.devicePixelRatio || 1, QUALITY.prop.dpr);
  cam.resize(w, h);
  renderer.resize(w, h, dpr);
  measureTopHud();
}

let fitPending = false;
function scheduleFit() {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(() => {
    fitPending = false;
    fit();
  });
}

// ---------------------------------------------------------
//  输入
//  用 Pointer Events（iOS 13+ Safari 全支持），比 touch 更省心；
//  配合 CSS 的 touch-action:none，不会触发双击缩放和橡皮筋
// ---------------------------------------------------------

let activePointer = null;

function canvasX(e) {
  const r = el.canvas.getBoundingClientRect();
  return e.clientX - r.left;
}

function canvasY(e) {
  const r = el.canvas.getBoundingClientRect();
  return e.clientY - r.top;
}

el.canvas.addEventListener('pointerdown', (e) => {
  // 遮罩打开时不接受拖动
  if (game.state !== STATE.PREP && game.state !== STATE.FIGHT) return;
  sfx.unlock();

  // 先判右下角的空袭按钮：命中就不算走位拖动。
  // 判定半径在渲染器里比画出来的圆大一圈（手指比鼠标粗）。
  // 注意这一判要放在 activePointer 检查之前：手机上是"一根手指一直按着走位"，
  // 这时候只能用另一根手指去点空袭；被 activePointer 挡住的话就永远点不出来。
  const bx = canvasX(e);
  const by = canvasY(e);
  const sb = renderer.strikeBtn;
  if (sb && game.canStrike() && Math.hypot(bx - sb.x, by - sb.y) <= sb.r) {
    if (game.triggerStrike()) {
      e.preventDefault();
      return;
    }
  }

  if (activePointer !== null) return;
  activePointer = e.pointerId;
  try { el.canvas.setPointerCapture(e.pointerId); } catch (_) {}
  game.pointerDown(bx, by);
  e.preventDefault();
}, { passive: false });

el.canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== activePointer) return;
  game.pointerMove(canvasX(e), canvasY(e));
  e.preventDefault();
}, { passive: false });

function endPointer(e) {
  if (e.pointerId !== activePointer) return;
  activePointer = null;
  game.pointerUp();
}

el.canvas.addEventListener('pointerup', endPointer);
el.canvas.addEventListener('pointercancel', endPointer);
el.canvas.addEventListener('lostpointercapture', endPointer);

// 双指缩放 / 双击放大 / 长按菜单 全部掐掉
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/** 绑定"按下即响应"的点击（比 click 快，且不会触发 iOS 的延迟） */
function onTap(node, fn) {
  // 用 -Infinity 而不是 0：performance.now() 在页面刚打开时接近 0，
  // 初始值若为 0 会把加载后 300ms 内的第一次点击吞掉
  let last = -Infinity;
  node.addEventListener('pointerdown', (e) => {
    const now = performance.now();
    if (now - last < 300) return;
    last = now;
    e.preventDefault();
    e.stopPropagation();
    fn(e);
  }, { passive: false });
}

// 点一下就收起来的面板（选关、暂停、主界面）有个坑：pointerdown 里把面板 display:none
// 之后，手指抬起时浏览器还会补一个 click —— 这时候面板已经不在，click 就落到下面那层
// 的元素上。用户实测：选关面板的「返回」正好压在首页那条文字上，于是点返回却跳走了。
// 所以凡是"按下就收面板"的按钮，收完顺手把这 500ms 内的 click 吞掉。
let swallowClickUntil = 0;
function guardClick() {
  swallowClickUntil = performance.now() + 500;
}
document.addEventListener(
  'click',
  (e) => {
    if (performance.now() < swallowClickUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);

// 开始：只认「开 始 挑 战」这一个按钮。
// 用户 m03061 反馈：整块遮罩"按下即开局"会导致随手双击屏幕就进游戏
// （想点四个入口却点偏、想点使用说明却点歪，全都直接开局）。
// 所以遮罩空白处不再响应，只有按钮算。
function startGame() {
  sfx.unlock();
  sfx.uiClick();
  hideGuide();
  game.newRun(0); // 主界面的「开始挑战」永远从第一关开始
}
onTap(el.startBtn, startGame);

// ---- 三关的进场对话 ----
// 用户 m01451：进第二关要有一段简短对话（英雄报告城市守住了 → 说明海洋还有僵尸威胁）。
// 用户 m02771：第三关是植物大战僵尸，开场必须是戴夫那句「歪比巴布」。
// 用户 m02399：① 每句都标"谁在说"，头像跟着说话人换（以前一整段只有一个头像，
//   司令说话时却挂着英雄的照片，看着莫名其妙）；② 补上第一关的交代，
//   让三关在剧情上接得上：守桥 → 城市保住了但海里爬上来 → 桥面长草、僵王来了；
//   ③ 每段的最后一句都把"要干什么"讲清楚。
// 头像文件在 hold-the-bridge/img/portrait-*.png（viz/portraits.mjs 生成）。
const TALKS = {
  city: {
    start: '守 住 大 桥 ！',
    lines: [
      { p: 'cmd', who: '司 令', text: '这座桥是城里最后一条退路。桥断了，后面的人一个都走不掉。' },
      { p: 'hero', who: '英 雄', text: '明白。给我弹药和路障，我站在桥头。' },
      { p: 'cmd', who: '司 令', text: '它们会一波接一波地来，最后那只是大家伙。守满 15 波 —— 一秒都别退。' },
    ],
  },
  ocean: {
    start: '疯 狂 水 世 界 · 启 动 ！',
    lines: [
      { p: 'uncle', who: '大 叔', text: '报告司令 —— 城市守住了，桥还在我们手里，清理已经收尾。' },
      { p: 'cmd', who: '司 令', text: '干得好。可海面不太平：声呐里全是心跳，它们从水里爬上来了。' },
      { p: 'uncle', who: '大 叔', text: '……那就下水。把我的鱼叉枪修好，码头就交给我。' },
    ],
  },
  dave: {
    start: '好 了 · 开 打 ！',
    lines: [
      { p: 'dave', who: '戴 夫', text: '歪比巴布！！……咳，我是说：歪、比、巴、布。' },
      { p: 'dave', who: '戴 夫', text: '看见没？桥面已经全是草坪了。草坪 + 僵尸 = 热闹，你懂我意思吧。' },
      { p: 'dave', who: '戴 夫', text: '甭慌 —— 你有豌豆，天上掉的阳光记得捡，攒满了扔樱桃。' },
    ],
  },
  // 【用户 m04749】第四关「穿越异世界」的开场：哥布林袭击村庄 → 勇者前去清剿。
  // 【用户 m06012】说话人不再用"村长"这张手绘头像（和用户给的立绘放一起太丑），
  // 改成 p: 'self'（玩家当前选的角色）/ p: 'ally'（另一个伙伴）——
  // 立绘直接用用户给的全身图裁出来的头肩像，谁上场头像就是谁。台词写成中性的，
  // 换成花仙子当主角时也不会出戏。
  fantasy: {
    start: '出 发 · 清 剿 ！',
    lines: [
      { p: 'ally', who: 'ally', text: '哥布林天刚亮就冲进村子了 —— 牲口全被赶走，麦田也点了火。' },
      { p: 'self', who: 'self', text: '先把大伙撤进教堂。剩下的交给我，一步都不退。' },
      { p: 'ally', who: 'ally', text: '往东就是它们的巢穴……听说那头恶龙也醒了，会喷火，还会召哥布林。' },
    ],
  },
};
let talkSet = TALKS.city;
let talkIdx = 0;
let portraitKey = ''; // 当前 <img> 里是哪张立绘（避免重复写 src 触发重新解码）

// ---------------------------------------------------------
// 【用户 m04749】"对话头像需要等一会才能加载出来"
// 原来立绘是在 renderTalk() 里才第一次设 src —— 图就在那一刻才去
// 取文件 + 解码（手机上尤其明显：对话弹出来先是一个空框，过一会儿才出人）。
// 现在启动时就把所有出场过的立绘预热好，再进对话就是"插上就有"。
// 名单从 TALKS 里自动收集（以后加说话人不用记得改这里）。
// ---------------------------------------------------------
const PORTRAIT_KEYS = (() => {
  const set = new Set(['hero', 'knight', 'fairy']); // 第四关两个角色（用户给的立绘）
  for (const t of Object.values(TALKS)) {
    for (const l of t.lines || []) {
      if (l.p === 'self' || l.p === 'ally') continue; // 运行时才决定是谁，两张都预热了
      set.add(l.p || 'hero');
    }
  }
  return [...set];
})();
// 【用户 m08343】两张第四关头肩立绘换 webp（220KB→37KB、239KB→36KB），
// 老的四张（hero/cmd/dave/uncle）本来就是 40KB 左右，没必要动。
const WEBP_PORTRAITS = { knight: 1, fairy: 1 };
const portraitSrc = (p) => `./img/portrait-${p}.${WEBP_PORTRAITS[p] ? 'webp' : 'png'}`;

function warmPortraits() {
  for (const p of PORTRAIT_KEYS) {
    const im = new Image();
    im.decoding = 'async';
    im.src = portraitSrc(p);
    // decode() 会把"取文件"推进到"解码完"——只设 src 的话第一帧还是要等解码
    if (typeof im.decode === 'function') {
      const pr = im.decode();
      if (pr && typeof pr.catch === 'function') pr.catch(() => {});
    }
  }
}
// 首屏先让渲染跑起来，空闲了再预热（不然 4 张立绘会跟首帧抢带宽）
if (typeof requestIdleCallback === 'function') requestIdleCallback(warmPortraits, { timeout: 1500 });
else setTimeout(warmPortraits, 600);

// ---------------------------------------------------------
// 【用户 m06896】启动加载动画 + "先保证游戏体验，不用执着离线"
//   只等"进主界面马上要用"的东西：几张对话立绘（每张几十 KB）。
//   两张第四关全身立绘（~800KB）**故意不在这里等**——那是玩到第四关才要的，
//   首开等它只会更卡；改成进第四关对话时再悄悄预热（见 warmHeroArt）。
//   兜底两条：最多等 2.6 秒、点一下屏幕立刻进。绝不把玩家卡在加载页上。
// ---------------------------------------------------------
const BOOT_MAX_MS = 2600;
const BOOT_MIN_MS = 480; // 太快的机器上也不能一闪而过（会像页面抖了一下）
let bootClosed = false;

function closeBoot() {
  if (bootClosed) return;
  bootClosed = true;
  // 给自动化留个数（viz/probe-boot.mjs 用它量"玩家被拦住多久"，
  // 页面自己的时钟才准：外面量进去还得算上无头浏览器启动那 1 秒）
  try {
    if (!window.__HBT_BOOT_MS) window.__HBT_BOOT_MS = Math.round(performance.now());
  } catch (_) { /* 无 window 的桩环境 */ }
  // 【用户 m08593】"加载页就是为了后台提前加载啊，为什么进角色页面还要等图片加载"
  //   —— 说得对：角色页那两张立绘现在只有 430KB（webp），不该等到点开才下。
  //   加载页一收就在后台预热（玩家这时正在看主页），等点「角色」时图已经在内存里解完码，
  //   面板直接开、连加载页都不用再盖一层。
  startHeroPanelWarmup();
  const el = document.getElementById('bootOverlay');
  if (!el) return;
  el.classList.add('done');
  // 【用户 m07770】节点**不再删除**：进关卡前还要复用这块加载页（showLoader），
  // 现成节点已经带品牌注释和翻译好的标题，重建一套反而要再写一份文案。
  // .boot.done 是 opacity:0 + pointer-events:none，留着也吃不到点击。
}

function runBootLoader() {
  const el = document.getElementById('bootOverlay');
  if (!el) return;
  // 无浏览器环境（tools/smoke-test.mjs 的 document 桩）：没有 rAF 就当加载完了
  if (typeof requestAnimationFrame !== 'function') {
    el.classList.add('done');
    if (el.parentNode) el.parentNode.removeChild(el);
    bootClosed = true;
    return;
  }
  const bar = document.getElementById('bootBar');
  const t0 = performance.now();
  let ready = false;
  let raf = 0;
  const finish = () => {
    ready = true;
    cancelAnimationFrame(raf);
    if (bar) bar.style.width = '100%';
    // 太快的机器上也不能一闪而过（会像页面抖了一下）
    setTimeout(closeBoot, Math.max(0, BOOT_MIN_MS - (performance.now() - t0)));
  };
  // 点一下就走（加载页永远是可跳过的）
  el.addEventListener('pointerdown', closeBoot);
  setTimeout(closeBoot, BOOT_MAX_MS);
  // 【用户 m06896】这里**不再等立绘**：外壳（html/css/js/字体）到这一步其实已经好了，
  // 真正要等的是"第一帧画出来"。立绘全部交给下面的空闲预热（warmPortraits），
  // 不占玩家的等待时间 —— 之前等 6 张立绘（约 630KB）要 1.5 秒，那才是"打开就卡"。
  // 进度条用一条时间斜坡撑住动效（最长 0.65s 爬到 90%），首帧一到立刻满格。
  let frames = 2;
  const tick = () => {
    frames -= 1;
    if (frames > 0) requestAnimationFrame(tick);
    else finish();
  };
  // 进度条走一条"渐近"曲线：0.65s 到 ~41%、2s 到 ~75%、5s 到 ~89%，永远在动但永远不装满分。
  // （原来 0.65s 就冲到 90% 然后干等 —— 冷启动要 3 秒多，看着像卡死了。）
  const ramp = () => {
    if (ready) return;
    const ms = performance.now() - t0;
    const p = Math.min(90, 90 * (1 - Math.exp(-ms / 1100)));
    if (bar) bar.style.width = `${p.toFixed(1)}%`;
    raf = requestAnimationFrame(ramp);
  };
  raf = requestAnimationFrame(ramp);
  requestAnimationFrame(tick);
}

// 第四关的全身立绘（两张共 ~800KB）只在"真的要打那关"时才取：
// 对话一弹出来就开始预热，等玩家读完三句点「出 发」时图早就到了，
// 开打不会出现"先一个手绘小人、过一会才换成立绘"。
let warmHeroArtKey = '';
function warmHeroArt(id) {
  const key = id === 'fairy' ? 'fairy' : 'knight';
  if (warmHeroArtKey === key) return;
  warmHeroArtKey = key;
  if (typeof Image === 'undefined') return; // 冒烟测试的桩环境没有 Image
  const im = new Image();
  im.decoding = 'async';
  im.src = `./img/hero-${key}.webp`;
  if (typeof im.decode === 'function') {
    const pr = im.decode();
    if (pr && typeof pr.catch === 'function') pr.catch(() => {});
  }
}

// ---------------------------------------------------------
// 【用户 m07770】"进页面或关卡前先进入加载页面后台加载需要的资源"
//   启动那块（runBootLoader）只等外壳，按需求补一张"进关卡前"的加载页：
//   素材在后台下完再开局，玩家就不会看到"人先到、图后到"。
//   第四关两张全身立绘现在已经 1.7MB，以后素材只会更多，这张表就是挂载点。
//   复用 #bootOverlay（品牌名 + 进度条，且标题在启动时已翻译过），不新增文案。
// ---------------------------------------------------------
const LEVEL_ART = {
  fantasy: [
    './img/hero-knight.webp',
    './img/hero-fairy.webp',
    './img/portrait-knight.webp',
    './img/portrait-fairy.webp',
  ],
};

function preloadAll(urls) {
  if (typeof Image === 'undefined') return Promise.resolve();
  return Promise.all(urls.map((u) => new Promise((res) => {
    const im = new Image();
    im.decoding = 'async';
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    im.onload = () => {
      if (typeof im.decode === 'function') im.decode().then(fin).catch(fin);
      else fin();
    };
    im.onerror = fin;
    setTimeout(fin, 9000); // 网络再差也不能把玩家按在加载页上
    im.src = u;
  })));
}

let loaderOpen = false;
let loaderRaf = 0;

function showLoader() {
  const el = document.getElementById('bootOverlay');
  if (!el || loaderOpen) return;
  loaderOpen = true;
  bootClosed = false;
  el.classList.remove('done');
  const bar = document.getElementById('bootBar');
  const t0 = performance.now();
  if (bar) bar.style.width = '4%';
  if (typeof requestAnimationFrame !== 'function') return;
  const tick = () => {
    if (!loaderOpen) return;
    if (bar) {
      const p = Math.min(93, 93 * (1 - Math.exp(-(performance.now() - t0) / 900)));
      bar.style.width = `${p.toFixed(1)}%`;
    }
    loaderRaf = requestAnimationFrame(tick);
  };
  loaderRaf = requestAnimationFrame(tick);
}

function hideLoader() {
  if (!loaderOpen) return;
  loaderOpen = false;
  if (loaderRaf) cancelAnimationFrame(loaderRaf);
  const bar = document.getElementById('bootBar');
  if (bar) bar.style.width = '100%';
  // 至少亮 260ms：本地几毫秒就下完，闪一下比不闪还难受
  setTimeout(closeBoot, 260);
}

/** 开局入口：有素材就先过加载页，没有就直接开 */
function startLevel(idx) {
  const lv = (CFG.levels && CFG.levels[idx]) || {};
  const urls = (lv.skin && LEVEL_ART[lv.skin]) || [];
  // 桩环境（tools/smoke-test.mjs 的 document 桩）没有 Image：直接开局，
  // 不然 beginLevel 会被推到一个微任务之后，测试里的同步断言就全错位了
  if (!urls.length || typeof Image === 'undefined') { game.beginLevel(idx); return; }
  showLoader();
  preloadAll(urls).then(() => { hideLoader(); game.beginLevel(idx); });
}

// 立刻开始等（外壳已经由 Service Worker 缓存优先返回了，这里主要是几张立绘）
runBootLoader();

function renderTalk() {
  const lines = talkSet.lines;
  const line = lines[Math.min(talkIdx, lines.length - 1)];
  // 【用户 m06012】说话人可以是 'self'（玩家当前选的角色）或 'ally'（另一个伙伴），
  // 这样第四关的对话头像就是用户给的立绘，谁上场就是谁。
  const heroId = (game.heroId === 'fairy') ? 'fairy' : 'knight';
  const otherId = heroId === 'fairy' ? 'knight' : 'fairy';
  const heroName = (HEROES.find((h) => h.id === heroId) || HEROES[0]).name;
  const otherName = (HEROES.find((h) => h.id === otherId) || HEROES[0]).name;
  const who = (p) => (p === 'self' ? heroName : p === 'ally' ? otherName : p);
  const portrait = (p) => (p === 'self' ? heroId : p === 'ally' ? otherId : (p || 'hero'));
  // 【用户 m06896】第四关的全身立绘在对话这一屏预热：等玩家读完三句，
  // 开打时贴图已经在缓存里，不会出现"先手绘小人、随后忽然换人"的跳变。
  if (CFG.level && CFG.level.skin === 'fantasy') warmHeroArt(heroId);
  setText(el.talkName, 'tkN', who(line.who));
  setText(el.talkText, 'tkT', line.text);
  setText(el.talkStamp, 'tkS', `${String(Math.min(talkIdx + 1, lines.length)).padStart(2, '0')} / 0${lines.length}`);
  setText(el.talkStart, 'tkStart', talkSet.start);
  // 【用户 m02399】头像跟着说话人换（每个说话人一张立绘）
  // 【用户 m04749】说话人没变就别再写 src：重复赋值会让浏览器重新解码一遍
  if (el.talkPortrait) {
    const p = portrait(line.p);
    if (portraitKey !== p) {
      portraitKey = p;
      el.talkPortrait.src = portraitSrc(p);
    }
    el.talkPortrait.alt = who(line.who);
  }
  const done = talkIdx >= lines.length;
  el.talkMore.classList.toggle('hidden', done);
  el.talkActions.classList.toggle('show', done);
}

function talkNext() {
  if (talkIdx >= talkSet.lines.length) return; // 翻完了，后面的按钮自己接事件
  sfx.unlock();
  sfx.uiClick();
  talkIdx += 1;
  renderTalk();
}
onTap(el.talkOverlay, talkNext);

// 进场对话只有一个按钮（用户 m02264：进了第二关的对话就只留「疯狂水世界 · 启动！」）
onTap(el.talkStart, (e) => {
  e.stopPropagation();
  sfx.uiClick();
  game.releaseTalk();
});

// ---- 使用说明弹窗 ----
// 第一次进来自动弹一次（本地记一笔），之后只能从首页的「使用说明」按钮打开
const GUIDE_KEY = 'hold-the-bridge:guide';

function showGuide() {
  el.guideOverlay.classList.add('show');
  try { localStorage.setItem(GUIDE_KEY, '1'); } catch (_) {}
}

function hideGuide() {
  el.guideOverlay.classList.remove('show');
}

onTap(el.guideBtn, () => {
  sfx.unlock();
  sfx.uiClick();
  showGuide();
});
onTap(el.guideClose, () => {
  sfx.uiClick();
  hideGuide();
});

// ---- 更新说明弹窗（用户 m04486：版本号左边的那个小按钮） ----
// 条目写在 js/changelog.js，这里只管排序和渲染。
// 排序按日期倒序 —— 打开第一眼看到的就是最新那条。
// 写进去的是纯中文文本节点，界面上的字典机制会照当前语言翻成英文，
// 所以新增条目时要一起往 js/i18n.js 的 EN 表补英文（否则守卫会红）。
function logTime(row) {
  // 'YY/MM/DD' → 可直接比大小的数字；格式不对的条目排到最后（不丢弃，免得"写了却看不到"）
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(String(row.date || ''));
  return m ? (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]) : -1;
}

function renderChangelog() {
  if (!el.logList) return;
  el.logList.textContent = '';
  for (const row of CHANGELOG.slice().sort((a, b) => logTime(b) - logTime(a))) {
    const card = document.createElement('div');
    card.className = 'log-item';
    const head = document.createElement('div');
    head.className = 'log-head';
    const date = document.createElement('span');
    date.className = 'log-date';
    date.textContent = row.date;
    const ver = document.createElement('span');
    ver.className = 'log-ver';
    ver.textContent = `v${row.version}`;
    head.appendChild(date);
    head.appendChild(ver);
    const ul = document.createElement('ul');
    ul.className = 'log-ul';
    for (const line of row.items) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    card.appendChild(head);
    card.appendChild(ul);
    el.logList.appendChild(card);
  }
}

function showLog() {
  renderChangelog();
  el.logOverlay.classList.add('show');
}

function hideLog() {
  el.logOverlay.classList.remove('show');
}

// 先在页面上放好（不显示），这样 MutationObserver 有机会把它们翻成当前语言
renderChangelog();

onTap(el.logBtn, () => {
  sfx.unlock();
  sfx.uiClick();
  showLog();
});
onTap(el.logClose, () => {
  sfx.uiClick();
  hideLog();
});

// 三条命没了不能一点就重开（玩家可能正在猛戳屏幕走位）
let overAt = 0;
let clearAt = 0;
onTap(el.againBtn, () => {
  if (performance.now() - overAt < 600) return;
  sfx.uiClick();
  game.newRun();
});

// 通关结算：同样留 600ms 缓冲（最后一波刚清完玩家手还在屏幕上）
onTap(el.clearAgain, () => {
  if (performance.now() - clearAt < 600) return;
  sfx.uiClick();
  game.newRun(); // 不带参数 = 重打刚打完的这一关（第二关通关后也重打第二关）
});
onTap(el.clearMenu, () => {
  if (performance.now() - clearAt < 600) return;
  sfx.uiClick();
  game.backToMenu();
});
// 「下一关 →」：按 lastReward 给的下一关 id 进场（有进场对话的会先停在对话）
onTap(el.clearNext, () => {
  if (performance.now() - clearAt < 600) return;
  const nextId = (game.lastReward && game.lastReward.nextLevel) || 0;
  if (!nextId) return;
  sfx.uiClick();
  startLevel(levelIndexOf(nextId));
});

// ---- 主界面四个入口 ----
// 「角色」已经接好了（用户 m04749）；武器 / 商店还是占位提示。
const MENU_ENTRIES = [
  [el.menuWeapon, '武器'],
  [el.menuShop, '商店'],
];
for (const [node, name] of MENU_ENTRIES) {
  onTap(node, (e) => {
    sfx.unlock();
    sfx.uiClick();
    // 提示词给到"未实装"，而且不能只靠 #gainToast —— 它在画布 HUD 层，
    // 被开始遮罩压着看不见，玩家点了会以为按钮坏了。
    const tip = `${name} · 该功能未实装`;
    showHint(tip, '#7df9ff');
    setText(el.menuHint, 'menuHint', tip);
    el.menuHint.classList.add('show');
    e.stopPropagation();
  });
}

// ---- 角色面板（首页「角色」入口，用户 m04749）----
// 默认「勇者」，可换「花仙子」（免费解锁）。两个角色**只在第四关生效**，
// 前三关保持原来的主角 —— 选择存在 localStorage 的 HERO_KEY 里。
function loadHero() {
  let id = '';
  try { id = localStorage.getItem(HERO_KEY) || ''; } catch (_) {}
  if (!HEROES.some((h) => h.id === id)) id = HEROES[0].id;
  game.heroId = id;
}

const HERO_PANEL_ART = [
  './img/hero-knight.webp',
  './img/hero-fairy.webp',
  './img/portrait-knight.webp',
  './img/portrait-fairy.webp',
];
let heroPanelArtReady = false;

/**
 * 【用户 m08143】角色面板的体感问题：点开先看到加载页，加载页收掉后又是主页，
 * 过几秒面板才冒出来，而且两张立绘还是"从上往下刷"。
 * 原因有两个：
 *   ① 面板是 hideLoader 之后才 show 的，而 hideLoader 里有 260ms 最小时长 + 420ms 淡出，
 *      中间这段时间露出来的就是主页；
 *   ② 面板里的 <img> 是把自己的 src 指向同一张图，浏览器要**重新解码**，
 *      解码没完之前就会一段一段往下刷。
 * 现在改成：面板先摆好（藏在加载页后面）→ 等面板里这几张 <img> 自己 decode 完 →
 * 再收加载页。这样"露出来的第一眼"就是画完的面板。
 */
function panelImgReady(img) {
  if (!img) return Promise.resolve();
  if (!img.getAttribute('src') && img.getAttribute('data-src')) img.setAttribute('src', img.getAttribute('data-src'));
  if (typeof Image === 'undefined' || typeof img.decode !== 'function') return Promise.resolve();
  if (img.complete && img.naturalWidth > 0) {
    // 已经解码过的图再 decode() 会很快返回
    return img.decode().catch(() => {});
  }
  return new Promise((res) => {
    const fin = () => {
      if (typeof img.decode === 'function') img.decode().then(res).catch(res);
      else res();
    };
    img.addEventListener('load', fin, { once: true });
    img.addEventListener('error', fin, { once: true });
    setTimeout(res, 9000);
  });
}

/** 面板里那两张全身立绘的 <img>（冒烟测试的 DOM 桩没有 querySelectorAll，要容错） */
function heroPanelImgs() {
  if (typeof document.querySelectorAll !== 'function') return [];
  return Array.prototype.slice.call(document.querySelectorAll('.lv.hero .hero-art img'));
}

let heroPanelWarm = null;
/**
 * 【用户 m08593】加载页一收就在后台把角色页的图备好：
 *   - 面板那两张 <img> 直接把 src 挂上并 decode()（面板本身是隐藏的，不占画面）；
 *   - 对话用的头肩立绘用 new Image() 预热，不阻塞任何东西。
 * 做完把 heroPanelArtReady 置真，之后点「角色」是零等待、连加载页都不出现。
 */
function startHeroPanelWarmup() {
  if (heroPanelWarm || heroPanelArtReady) return heroPanelWarm || Promise.resolve();
  const jobs = heroPanelImgs().map(panelImgReady);
  if (typeof Image !== 'undefined') {
    for (const u of HERO_PANEL_ART.slice(2)) {
      const im = new Image();
      im.decoding = 'async';
      im.src = u;
      if (typeof im.decode === 'function') {
        const pr = im.decode();
        if (pr && typeof pr.catch === 'function') pr.catch(() => {});
      }
    }
  }
  heroPanelWarm = Promise.all(jobs).then(() => {
    heroPanelArtReady = true;
  });
  return heroPanelWarm;
}

function openHeroes() {
  // 常见情况：开机预热早做完了 —— 直接开面板，一层加载页都不盖
  if (heroPanelArtReady) {
    heroPanelShow();
    return;
  }
  // 极端情况：开机 0.x 秒就点进来了，图还没备好。面板先摆好 + 加载页兜一下。
  heroPanelShow();
  showLoader();
  startHeroPanelWarmup().then(() => hideLoader());
}

function heroPanelShow() {
  for (const h of HEROES) {
    const node = el['hero' + h.id.charAt(0).toUpperCase() + h.id.slice(1)];
    if (!node) continue;
    node.classList.toggle('sel', game.heroId === h.id);
    node.classList.toggle('done', game.heroId === h.id);
    // 【用户 m06012】全身立绘用 data-src 挂着，打开面板时才真正去取 ——
    // 不然每个进首页的玩家都要先拖 800KB 立绘，没进第四关的人白付这笔带宽。
    const img = node.querySelector && node.querySelector('img[data-src]');
    if (img && !img.getAttribute('src')) img.setAttribute('src', img.getAttribute('data-src'));
  }
  setText(el.heroHint, 'heroHint', CFG.level && CFG.level.skin === 'fantasy'
    ? '当前就在第 4 关 · 换完立刻生效'
    : '只在第 4 关「穿越异世界」生效 · 前三关沿用原主角');
  el.heroOverlay.classList.add('show');
}

function hideHeroes() {
  el.heroOverlay.classList.remove('show');
}

function pickHero(id) {
  if (!HEROES.some((h) => h.id === id)) return;
  game.heroId = id;
  try { localStorage.setItem(HERO_KEY, id); } catch (_) {}
  openHeroes();
}

onTap(el.menuRole, (e) => {
  sfx.unlock();
  sfx.uiClick();
  openHeroes();
  e.stopPropagation();
});
onTap(el.heroKnight, (e) => { sfx.uiClick(); pickHero('knight'); e.stopPropagation(); });
onTap(el.heroFairy, (e) => { sfx.uiClick(); pickHero('fairy'); e.stopPropagation(); });
onTap(el.heroClose, (e) => { sfx.uiClick(); hideHeroes(); guardClick(); e.stopPropagation(); });

// ---- 选关面板（首页「关卡」入口）----
// 第 1~3 关真的能进；第 4~10 关是灰按钮，点了只提示"该关卡未实装"。
function openLevels() {
  // 已经通关过的关卡打个「已通关」记号；按钮里的两行字是 index.html 写死的，
  // 这里只加 class，别用 textContent 写，否则会把「第 1 关 / 血色大桥」两行抹掉。
  for (let i = 1; i <= 10; i++) {
    const node = el['lv' + i];
    if (!node) continue;
    const lv = findLevel(i);
    node.classList.toggle('done', !!lv && game.clearedLevel >= i);
  }
  setText(el.levelHint, 'lvH', game.clearedLevel >= 3 ? '第 4 关已解锁 · 选一关开打' : game.clearedLevel >= 2 ? '第 1~4 关都能进 · 选一关开打' : game.clearedLevel >= 1 ? '第 2~4 关已解锁 · 选一关开打' : '先打第 1 关 · 第 2~4 关也可以直接进');
  el.levelOverlay.classList.add('show');
}

function hideLevels() {
  el.levelOverlay.classList.remove('show');
}

onTap(el.menuLevel, (e) => {
  sfx.unlock();
  sfx.uiClick();
  openLevels();
  e.stopPropagation();
});
onTap(el.levelClose, (e) => {
  sfx.uiClick();
  hideLevels();
  guardClick();
  e.stopPropagation();
});
for (let i = 1; i <= 10; i++) {
  const node = el['lv' + i];
  if (!node) continue;
  onTap(node, (e) => {
    sfx.unlock();
    e.stopPropagation();
    const lv = findLevel(i);
    if (!lv) {
      // 占位关：只说一句，面板不关（玩家可以接着点别的）
      sfx.uiClick();
      setText(el.levelHint, 'lvH', `第 ${i} 关 · 该关卡未实装`);
      showHint(`第 ${i} 关 · 该关卡未实装`, '#7df9ff');
      return;
    }
    sfx.uiClick();
    hideLevels();
    guardClick(); // 收面板的那一下别让落空的 click 打到下面那层
    startLevel(levelIndexOf(i));
  });
}

// ---- 局内左下角：返回主界面 / 暂停 ----
// 用户 m02534：打着打着想回主界面或喘口气，原来只能靠刷新页面。
let paused = false;
let backAt = 0; // 第一次点「返回」的时间戳（0 = 没在等确认）
const BACK_WINDOW = 2500; // 秒数换算用毫秒比较，2.5 秒内再点一下才算确认

function resetBack() {
  backAt = 0;
  setText(el.backBtn, 'bk', '返回');
  el.backBtn.classList.remove('warn');
}

/**
 * 右上角那颗音量键的样子。静音时除了换成 🔇，还要挂个 .off：
 * 只靠"透明度降到 0.55"太不显眼了 —— 玩家很容易以为游戏坏了（没声音），
 * 其实是自己上次误点了一下，而且这个偏好还被存进了 localStorage。
 */
function applyMuteUI(m) {
  el.muteBtn.textContent = m ? '🔇' : '🔊';
  el.muteBtn.classList.toggle('off', !!m);
  el.muteBtn.setAttribute('aria-label', m ? '音效已关，点一下打开' : '音效已开，点一下关闭');
}

function pauseGame() {
  // 只有真正在打的时候能暂停：主界面/结算/失守界面上按暂停没有意义
  if (paused) return;
  if (game.state !== STATE.PREP && game.state !== STATE.FIGHT) return;
  paused = true;
  // 丢掉正按着的那根手指：否则恢复时英雄会朝那个旧坐标窜一下
  activePointer = null;
  game.pointerUp();
  resetBack();
  el.pauseOverlay.classList.add('show');
  syncAudioState();
}

/**
 * 暂停面板上那行「音效：xxx」。
 * 用户 m01157：经常没声音，不知道什么问题 —— iOS 上没声音有好几种原因，
 * 与其在聊天里来回猜，不如把答案写在暂停面板上，一看就知道该点哪儿。
 */
function syncAudioState() {
  if (!el.audioState) return;
  const s = sfx.status;
  if (syncAudioState._last === s) return; // 每帧都会调，状态没变就一个字都别写
  syncAudioState._last = s;
  setText(el.audioState, 'au', `音效：${s}`);
  el.audioState.classList.toggle('warn', s !== '正常');
}

function resumeGame() {
  if (!paused) return;
  paused = false;
  el.pauseOverlay.classList.remove('show');
  last = 0; // 计时基准归零：暂停这段时间不算进去，否则恢复瞬间画面会跳一大步
}

onTap(el.pauseBtn, () => {
  sfx.uiClick();
  pauseGame();
});

onTap(el.resumeBtn, () => {
  sfx.uiClick();
  guardClick();
  resumeGame();
});

onTap(el.pauseMenu, () => {
  sfx.uiClick();
  guardClick();
  resumeGame();
  game.backToMenu();
});

// 「返回」要点两下：第一下变成「确认返回」，2.5 秒不点就自己变回去。
// 它就蹲在左下角，打起来拇指很容易蹭到，一下就把整局送掉太亏。
onTap(el.backBtn, () => {
  sfx.uiClick();
  const now = performance.now();
  if (backAt && now - backAt <= BACK_WINDOW) {
    resetBack();
    resumeGame();
    guardClick();
    game.backToMenu();
    return;
  }
  backAt = now;
  setText(el.backBtn, 'bk', '确认返回');
  el.backBtn.classList.add('warn');
});

onTap(el.muteBtn, (e) => {
  sfx.unlock(); // 这一下本身就是用户手势，顺手把上下文建起来/叫醒
  const m = sfx.toggleMute();
  applyMuteUI(m);
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch (_) {}
  syncAudioState();
  e.stopPropagation();
});

// ---------------------------------------------------------
//  吃到奖励的提示条
//  v1 这里是"三选一卡片弹窗"。用户反馈不要弹窗（参考视频里玩家
//  是撞上桥边的物件直接吃加成），所以加成改成桥上左右两块门，
//  这里只负责吃到之后飘一条提示，让玩家确认自己拿到了什么。
// ---------------------------------------------------------

let lastSeq = -1;
let gainT = 0;

/**
 * 【用户 m04749】"频繁出现没有声音"。
 * 音频自愈在 frame() 里每秒跑一次，但玩家不一定知道"没声音"是可以点一下救回来的。
 * 进局时如果确认没在出声（既不是静音、也不是"还没启动"），就用提示条说一句 ——
 * 一个会话只提一次，避免每次开局都刷屏；点过音量键或自己修好了就不再提。
 */
let audioHinted = false;
function audioHintCheck() {
  if (audioHinted) return;
  if (game.state !== STATE.PREP && game.state !== STATE.FIGHT) return;
  if (sfx.muted || !sfx.ready || sfx.running) return;
  audioHinted = true;
  showHint('音效没开 · 点一下画面', '#ffd166');
}

function syncGain(dt) {
  if (game.upgradeSeq !== lastSeq) {
    lastSeq = game.upgradeSeq;
    const g = game.lastGain;
    if (g) {
      setText(el.gainToast, 'gain', `${g.op}${g.amt}  ${g.name}`);
      el.gainToast.style.setProperty('--c', TAG_COLOR[g.tag] || '#ffd166');
      gainT = 1.7;
    }
  }
  if (gainT > 0) gainT -= dt;
  const on = gainT > 0;
  if (cache.gainOn !== on) {
    cache.gainOn = on;
    el.gainToast.classList.toggle('show', on);
  }
}

// ---------------------------------------------------------
//  DOM 同步（只在内容变化时写，避免每帧触发重排）
// ---------------------------------------------------------

const cache = {};

function setText(node, key, val) {
  if (cache[key] === val) return;
  cache[key] = val;
  node.textContent = val;
}

function showGameOver() {
  // 【用户 m04749】第三关（植物大战僵尸那套皮）失守不用「桥头失守」，
  // 换成 PvZ 名场面：僵尸吃掉了你的脑子。类名 .pvz 顺带把面板/背景
  // 切成草坪配色（见 styles.css 的「第三关失守」一段）。
  // 中英各一份文案，写在下面的常量里，双语守卫跟着一起查。
  const pvz = !!(CFG.level && CFG.level.skin === 'pvz');
  el.overOverlay.classList.toggle('pvz', pvz);
  setText(el.overTitle, 'oTitle', pvz ? '你的脑子被僵尸吃掉了' : '桥 头 失 守');
  setText(el.overScore, 'oS', String(game.score));
  setText(el.overBest, 'oB', String(game.best));
  setText(el.overWave, 'oW', String(game.wave));
  setText(el.overKills, 'oK', String(game.kills));
  setText(el.overTier, 'oT', game.tier.name);
  el.newBest.classList.toggle('show', !!game.newBest);
  overAt = performance.now();
}

/** 通用提示条：主界面的四个入口点下去就用它提示"即将开放" */
function showHint(text, color = '#ffd166') {
  setText(el.gainToast, 'gain', text);
  el.gainToast.style.setProperty('--c', color);
  gainT = 1.6;
}

/** 通关结算面板（第一关 / 第二关共用，按钮按"有没有下一关"变） */
function showClear() {
  const r = game.lastReward || { score: game.score, coins: 0, total: game.coins, kills: game.kills, combo: game.comboBest };
  setText(el.clearTitle, 'cTi', `${r.levelName || '本 关'} · 通 关`);
  setText(el.clearCoins, 'cC', String(r.coins));
  setText(el.clearScore, 'cS', String(r.score));
  setText(el.clearKills, 'cK', String(r.kills));
  setText(el.clearCombo, 'cX', String(r.combo || 0));
  setText(el.clearTotal, 'cT', String(r.total));
  // 有下一关就顶一个主按钮出来（「下一关 →」），没有下一关才给「再玩一次」
  const nl = findLevel(r.nextLevel);
  el.clearNext.classList.toggle('hidden', !nl);
  el.clearAgain.classList.toggle('hidden', !!nl);
  clearAt = performance.now();
}

let lastState = null;
let lastSkin = null;

function syncState() {
  const st = game.state;

  // 【用户 m06012】「从这关开始 UI 等视觉效果必须全面提升」：
  // 第四关（skin=fantasy）的对话面板换成幻想绘卷皮肤 —— 立绘放大成半身胸像、金绿描边。
  // 同时给 <body> 挂 skin-fantasy，让顶部 HUD / 返回暂停按钮 / 提示气泡也跟着换皮
  // （画布那部分在 render.js 的 _drawHudCanvas 里按皮肤分支）。
  // 只在皮肤真的换了才碰 DOM（这个函数每帧都跑）。
  const skin = (CFG.level && CFG.level.skin) || 'city';
  if (skin !== lastSkin) {
    lastSkin = skin;
    el.talkOverlay.classList.toggle('fantasy', skin === 'fantasy');
    document.body.classList.toggle('skin-fantasy', skin === 'fantasy');
  }

  if (st !== lastState) {
    if (st === STATE.OVER) showGameOver();
    if (st === STATE.CLEAR) showClear();
    if (st === STATE.TALK) {
      // 按这一关的 intro 选对话（city = 第一关守桥 / ocean = 大叔下水 / dave = 戴夫）
      talkSet = TALKS[CFG.level.intro] || TALKS.city;
      talkIdx = 0;
      renderTalk();
    }
    if (st === STATE.START) {
      setText(el.startBest, 'sB', String(game.best));
      setText(el.startCoins, 'sC', String(game.coins));
      // 关卡入口显示进度（通关第一关后主界面能看出来第二关解锁了）
      // 「关卡」那格的角标：点开是选关面板，所以这里只说到"能选几关"
      // 【用户 m04749】第 4 关上线后，四关都能直接进（选关面板里的提示也这么说）
      setText(el.menuLevelNote, 'mL', game.clearedLevel >= 1 ? '第 1~4 关 可选' : '第 1 关 可打');
    }

    el.startOverlay.classList.toggle('show', st === STATE.START);
    el.overOverlay.classList.toggle('show', st === STATE.OVER);
    el.clearOverlay.classList.toggle('show', st === STATE.CLEAR);
    el.talkOverlay.classList.toggle('show', st === STATE.TALK);
    // 左下角的「返回 / 暂停」只在打的时候出现（备战倒计时 + 开打），
    // 主界面/对话/结算/失守时收起来，免得挡着面板或者点出界
    const playing = st === STATE.PREP || st === STATE.FIGHT;
    el.ingameBtns.classList.toggle('show', playing);
    // 顶部/中部 HUD 只在打的时候露脸：开始界面、说明、对话、结算都是半透明面板，
    // 底下的分数 / 波次 / 档位透出来会像两套 UI 叠在一起。
    // 用 opacity（.hide）而不是 display:none —— measureTopHud() 要靠 .hud-top 的
    // 实际高度来定位画布上那排心形，元素从布局里拿掉会让测量结果变 0。
    el.hudTop.classList.toggle('hide', !playing);
    el.hudMid.classList.toggle('hide', !playing);
    if (!playing) {
      // 死了、通关了、回主界面了：暂停状态跟着解除，否则暂停面板会一直卡在画面上
      resumeGame();
      resetBack();
    }
    if (st !== STATE.START) hideLevels(); // 开局了就把选关面板收掉，别压在画面上
    lastState = st;
  }
}

function syncHud() {
  const st = game.state;

  setText(el.score, 'sc', String(game.score));
  setText(el.bestLabel, 'sb', String(game.best));
  setText(
    el.waveLabel,
    'wv',
    game.wave > 0 && st !== STATE.START ? `${game.wave}/${CFG.level.waves}` : `0/${CFG.level.waves}`
  );

  // 武器质变等级（第三关还挂上"阳光攒出来的攻击加成"，让成长看得见）
  const ti = game.weapon.tierIdx;
  const sunAtk = game.sunAtk || 0;
  setText(
    el.tierLabel,
    'tn',
    sunAtk > 0.001 ? `${game.tier.name} · 攻+${Math.round(sunAtk * 100)}%` : game.tier.name
  );
  if (cache.tc !== ti) {
    cache.tc = ti;
    el.tierLabel.className = 'tier' + (ti > 0 ? ' t' + (ti + 1) : '');
  }

  // 备战提示：有奖励门的时候提示走位，没有就只是倒计时
  if (st === STATE.PREP && st !== STATE.START) {
    if (game.gates) {
      setText(el.prepLabel, 'pp', `← 走位吃奖励 →`);
    } else {
      const nw = game.wave + 1;
      const tag = isBossWave(nw) ? 'BOSS ' : isHordeWave(nw) ? '尸潮 ' : '';
      setText(
        el.prepLabel,
        'pp',
        `第 ${nw}/${CFG.level.waves} 波 ${tag}来袭 · ${Math.max(0, Math.ceil(game.prepT))}`
      );
    }
    el.prepLabel.classList.add('on');
  } else {
    el.prepLabel.classList.remove('on');
  }
}

// ---------------------------------------------------------
//  主循环
// ---------------------------------------------------------

let last = 0;
let audioKickAt = 0; // 上一次"音频自愈"的时间戳（RAF 的 now，和 performance.now 同源）

function frame(now) {
  if (!last) last = now;
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1; // 切回前台 / 首帧跳变

  // 【用户 m02901】画质自适应：把真实帧时间喂给守门员；档位一变（DPR 变了）就地重新 fit
  if (QUALITY.auto) {
    QUALITY.sample(dt * 1000);
    if (QUALITY.dirty) {
      QUALITY.dirty = false;
      fit();
    }
  }

  // 「返回」等确认的 2.5 秒过了就自己变回「返回」
  // （用 performance.now() 对齐 onTap 里记的时间戳：RAF 的 now 起点跟它不是一个基准）
  if (backAt && performance.now() - backAt > BACK_WINDOW) resetBack();

  if (paused) {
    // 暂停：世界完全静止（dt=0），但画布照画 —— 暂停面板底下还能看见战场
    renderer.draw(game, 0);
    syncState();
    syncHud();
    syncAudioState();
    syncGain(0);
    requestAnimationFrame(frame);
    return;
  }

  game.update(dt);
  renderer.draw(game, dt);
  syncState();
  syncHud();
  syncGain(dt);

  // 音频自愈：iOS 会在后台、来电、锁屏之后把 AudioContext 挂起，
  // 而光靠"下一次触摸"不一定能碰上（比如玩家一直按着屏幕不动）。
  // 这里每秒顺手叫一次，resume 不需要用户手势时就能自己爬回来；
  // 要是这次被系统拒了也不影响：下一次触摸还会再叫。
  if (sfx.ready && !sfx.muted && !document.hidden && !sfx.running && now - audioKickAt > 1000) {
    audioKickAt = now;
    sfx.wake();
  }
  audioHintCheck();

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------
//  启动
// ---------------------------------------------------------

// 静音偏好
try {
  if (localStorage.getItem(MUTE_KEY) === '1') {
    sfx.setMuted(true);
    applyMuteUI(true);
  } else {
    applyMuteUI(false);
  }
} catch (_) {
  applyMuteUI(false);
}

// 使用说明：只有第一次打开才自动弹（之后点首页的「使用说明」按钮才显示）
try {
  if (localStorage.getItem(GUIDE_KEY) !== '1') showGuide();
} catch (_) {
  showGuide();
}

// 角色（用户 m04749）：把玩家上次选的角色读回来（不合法就回落成勇者）
loadHero();

window.addEventListener('resize', scheduleFit);
window.addEventListener('orientationchange', scheduleFit);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', scheduleFit);
}
document.addEventListener('visibilitychange', () => {
  // 回到前台时重置计时基准，避免一帧跳掉一大段时间；
  // 顺便把音频叫醒：切后台 / 锁屏回来 AudioContext 是被系统挂起的
  // （这是"玩着玩着就没声音了"最常见的一种）
  if (!document.hidden) {
    last = 0;
    sfx.wake();
  }
});

// 任何一次触摸都顺手唤醒一次音频。iOS 只认"用户手势里的 resume"，
// 所以这条兜底比什么都管用：不管前面被切后台还是被来电打断，
// 玩家下一次碰屏幕就该有声音。
window.addEventListener('pointerdown', () => sfx.wake(), true);
window.addEventListener('touchstart', () => sfx.wake(), { passive: true });
window.addEventListener('focus', () => sfx.wake());
window.addEventListener('pageshow', () => sfx.wake());

fit();
syncState();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!isLocal) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
}

// 字体就位再开第一帧：得意黑（184 KB woff2）没加载完就画，第一帧的字会闪一下系统字体。
// 最多等 1.2 秒 —— 字体挂了也不能让游戏卡住。
const fontReady =
  typeof document !== 'undefined' && document.fonts && document.fonts.load
    ? Promise.race([
        Promise.allSettled([
          document.fonts.load('900 40px "Smiley Sans"'),
          document.fonts.load('700 20px "Smiley Sans"'),
        ]),
        new Promise((r) => setTimeout(r, 1200)),
      ])
    : Promise.resolve();
fontReady.then(() => {
  // 语言：先把已有 DOM 翻一遍，再挂上观察器 —— 之后任何界面文案变化都会自动跟着切
  I18N.applyDom();
  I18N.watchDom();
  syncLangBtn();
  syncState();
  // 从这里开始让画质守门员盯真实帧时间（离线渲染工具不会打开这个开关）
  QUALITY.auto = true;
  if (QUALITY.dirty) {
    QUALITY.dirty = false;
    fit();
  }
  requestAnimationFrame(frame);
});

// 调试/自测钩子：给自动化冒烟测试留一个入口（对玩家无副作用）
window.__HBT = {
  game,
  cam,
  sfx,
  renderer,
  fit,
  frame,
  STATE,
  showGuide,
  hideGuide,
  pauseGame,
  resumeGame,
  isPaused: () => paused,
  // 画布文字是运行时翻译的（见 js/i18n.js 的 installCanvas），
  // 版面对齐体检要拿到"真正画出去的那串"来量宽度，所以把翻译器也挂出来
  i18n: I18N,
  // 进关卡的入口（用户 m07770 的加载页）：探针要能直接触发"选关 → 加载 → 开局"
  startLevel,
  LEVEL_ART,
  showLoader,
  hideLoader,
};
