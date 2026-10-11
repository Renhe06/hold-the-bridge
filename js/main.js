// ============================================================
//  《守桥》启动器
//  职责：尺寸/DPR 适配、输入接管、RAF 主循环、DOM 与游戏状态同步
// ============================================================

import { Camera } from './camera.js';
import { Sound } from './audio.js';
import { Game, STATE } from './game.js';
import { Renderer, TAG_COLOR } from './render.js';
import { CFG, isHordeWave, isBossWave, findLevel } from './config.js';

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  canvas: $('game'),
  hudTop: $('hudTop'),
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
  overOverlay: $('overOverlay'),
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
  talkMenu: $('talkMenu'),
};

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
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
    // 遮罩里放了 <a>（开始界面底部的「使用说明」）。这里的 preventDefault
    // 会把链接的跳转一起吞掉，所以命中链接时直接放行给浏览器。
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('a')) return;
    const now = performance.now();
    if (now - last < 300) return;
    last = now;
    e.preventDefault();
    e.stopPropagation();
    fn(e);
  }, { passive: false });
}

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

// ---- 第二关进场对话 ----
// 用户 m01451：进第二关要有一段简短对话（英雄报告城市守住了 → 说明海洋还有僵尸威胁），
// 然后弹「疯狂水世界启动！」或「返回主界面」。台词就三句，点一下翻一句，翻完才出按钮。
const TALK_LINES = [
  { who: '英 雄', text: '司令 —— 城市守住了！桥还在我们手里，清理工作已经收尾。' },
  { who: '司 令', text: '干得好。可海面上不太平：声呐里全是心跳，它们从海里爬上来了。' },
  { who: '英 雄', text: '……那就下水。把我的鱼叉枪修好，我这就去码头。' },
];
let talkIdx = 0;

function renderTalk() {
  const line = TALK_LINES[Math.min(talkIdx, TALK_LINES.length - 1)];
  setText(el.talkName, 'tkN', line.who);
  setText(el.talkText, 'tkT', line.text);
  setText(el.talkStamp, 'tkS', `${String(Math.min(talkIdx + 1, TALK_LINES.length)).padStart(2, '0')} / 0${TALK_LINES.length}`);
  const done = talkIdx >= TALK_LINES.length;
  el.talkMore.classList.toggle('hidden', done);
  el.talkActions.classList.toggle('show', done);
}

function talkNext() {
  if (talkIdx >= TALK_LINES.length) return; // 翻完了，后面的按钮自己接事件
  sfx.unlock();
  sfx.uiClick();
  talkIdx += 1;
  renderTalk();
}
onTap(el.talkOverlay, talkNext);

onTap(el.talkStart, (e) => {
  e.stopPropagation();
  sfx.uiClick();
  game.releaseTalk();
});
onTap(el.talkMenu, (e) => {
  e.stopPropagation();
  sfx.uiClick();
  game.backToMenu();
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
  game.newRun(0);
});
onTap(el.clearMenu, () => {
  if (performance.now() - clearAt < 600) return;
  sfx.uiClick();
  game.backToMenu();
});
// 「疯狂水世界 →」：进第二关（先进对话，对话看完才开打）
onTap(el.clearNext, () => {
  if (performance.now() - clearAt < 600) return;
  const next = (game.lastReward && game.lastReward.nextLevel) || 1;
  sfx.uiClick();
  game.beginLevel(next);
});

// ---- 主界面四个入口 ----
// 现在只预留按钮：点下去给一条"即将开放"的提示，不做任何功能。
// 以后分别接：角色切换 / 武器切换 / 商店购买 / 关卡选择。
const MENU_ENTRIES = [
  [el.menuRole, '角色'],
  [el.menuWeapon, '武器'],
  [el.menuShop, '商店'],
  [el.menuLevel, '关卡'],
];
for (const [node, name] of MENU_ENTRIES) {
  onTap(node, (e) => {
    sfx.unlock();
    sfx.uiClick();
    // 提示词给到"未实装"，而且不能只靠 #gainToast —— 它在画布 HUD 层，
    // 被开始遮罩压着看不见，玩家点了会以为按钮坏了。
    showHint(`${name} · 该功能未实装`, '#7df9ff');
    setText(el.menuHint, 'menuHint', `${name} · 该功能未实装`);
    el.menuHint.classList.add('show');
    e.stopPropagation();
  });
}

onTap(el.muteBtn, (e) => {
  const m = sfx.toggleMute();
  el.muteBtn.textContent = m ? '🔇' : '🔊';
  el.muteBtn.style.opacity = m ? '0.55' : '1';
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch (_) {}
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
  // 有下一关就顶一个主按钮出来，把「再玩一次」降级成次要按钮
  const nl = findLevel(r.nextLevel);
  el.clearNext.classList.toggle('hidden', !nl);
  el.clearNext.textContent = nl ? `${nl.name} →` : '';
  el.clearAgain.className = nl ? 'btn ghost' : 'btn primary';
  clearAt = performance.now();
}

let lastState = null;

function syncState() {
  const st = game.state;

  if (st !== lastState) {
    if (st === STATE.OVER) showGameOver();
    if (st === STATE.CLEAR) showClear();
    if (st === STATE.TALK) {
      talkIdx = 0;
      renderTalk();
    }
    if (st === STATE.START) {
      setText(el.startBest, 'sB', String(game.best));
      setText(el.startCoins, 'sC', String(game.coins));
      // 关卡入口显示进度（通关第一关后主界面能看出来第二关解锁了）
      setText(el.menuLevelNote, 'mL', game.clearedLevel >= 1 ? '第二关 · 已解锁' : '第一关 · 15 波');
    }

    el.startOverlay.classList.toggle('show', st === STATE.START);
    el.overOverlay.classList.toggle('show', st === STATE.OVER);
    el.clearOverlay.classList.toggle('show', st === STATE.CLEAR);
    el.talkOverlay.classList.toggle('show', st === STATE.TALK);
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

  // 武器质变等级
  const ti = game.weapon.tierIdx;
  setText(el.tierLabel, 'tn', game.tier.name);
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

function frame(now) {
  if (!last) last = now;
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1; // 切回前台 / 首帧跳变

  game.update(dt);
  renderer.draw(game, dt);
  syncState();
  syncHud();
  syncGain(dt);

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------
//  启动
// ---------------------------------------------------------

// 静音偏好
try {
  if (localStorage.getItem(MUTE_KEY) === '1') {
    sfx.setMuted(true);
    el.muteBtn.textContent = '🔇';
    el.muteBtn.style.opacity = '0.55';
  }
} catch (_) {}

// 使用说明：只有第一次打开才自动弹（之后点首页的「使用说明」按钮才显示）
try {
  if (localStorage.getItem(GUIDE_KEY) !== '1') showGuide();
} catch (_) {
  showGuide();
}

window.addEventListener('resize', scheduleFit);
window.addEventListener('orientationchange', scheduleFit);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', scheduleFit);
}
document.addEventListener('visibilitychange', () => {
  // 回到前台时重置计时基准，避免一帧跳掉一大段时间
  if (!document.hidden) last = 0;
});

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

requestAnimationFrame(frame);

// 调试/自测钩子：给自动化冒烟测试留一个入口（对玩家无副作用）
window.__HBT = { game, cam, sfx, renderer, fit, frame, STATE, showGuide, hideGuide };
