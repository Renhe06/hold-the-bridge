// ============================================================
//  无浏览器冒烟测试
//
//  这个项目全是 ES module + Canvas，没有构建步骤，
//  所以真正的风险是"某个方法名写错""某个字段 undefined"这类运行时错误——
//  而这些错误只有真跑一遍才暴露。
//
//  做法：用最小 DOM / Canvas 桩把 js/main.js 真的 import 进来，
//  用虚拟时钟手动驱动 RAF 帧、模拟点击与拖动、让一个"会闪避的机器人"
//  真的去打，把 16 种升级全选一遍，最后强制结算。
//
//  运行：node tools/smoke-test.mjs
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 固定随机源：升级三选一、出怪位置、暴击都走 Math.random，
// 种死之后"调参前 / 调参后"的机器人成绩才是可比的。
// 加 --smart 则换一种会挑升级的机器人，用来验证"认真玩能不能打深"——
// 如果连会挑升级的玩家都卡在第 6 波，那是数值经济坏了，不是玩家菜。
const SMART = process.argv.includes('--smart');
// `--seed=123456` 换一颗种子：单次成绩会被随机流带着跑（多一次 rand 调用就整体平移），
// 想判断"难度是不是真的变了"要多跑几颗种子看分布，不能只看一次。
const SEED_ARG = process.argv.find((a) => a.startsWith('--seed='));
const SEED = SEED_ARG ? Number(SEED_ARG.slice('--seed='.length)) : 20240613;
const PICK_ORDER = [
  'damage', 'rateMul', 'bullets', 'pierce', 'crit', 'critMul', 'splash', 'burn',
  'ice', 'pulse', 'bulletSpeedMul', 'maxHp', 'shieldPerWave', 'moveMul', 'heal', 'dropChance',
];
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = makeRng(SEED);

// ---------------------------------------------------------
//  Canvas 2D 上下文桩
//  只实现 render.js 真正会用到的方法；一旦它调用了不存在的方法，
//  就会抛 "xxx is not a function"，这正是我们想抓的错误。
// ---------------------------------------------------------

// ---------------------------------------------------------
//  DOM / Canvas / 全局桩
//  与出图夹具 viz/shot.mjs 共用同一份实现（tools/dom-stub.mjs），
//  否则会出现"冒烟测试过了、出图夹具崩"这种形状不一致的假信号。
// ---------------------------------------------------------

import { installDom } from './dom-stub.mjs';

const { ELS, DOC, CANVAS, APP, WINDOW_LISTENERS, P, def } = installDom({
  width: 390, height: 844, dpr: 3,
});

// ---------------------------------------------------------
//  断言
// ---------------------------------------------------------

let failures = 0;
const notes = [];

function ok(cond, msg) {
  if (cond) notes.push(`  ✓ ${msg}`);
  else { failures++; notes.push(`  ✗ ${msg}`); }
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function checkNumbers(game, label) {
  const bad = [];
  if (!finite(game.player.x)) bad.push('player.x');
  if (!finite(game.score)) bad.push('score');
  for (const e of game.enemies) if (!finite(e.x) || !finite(e.z) || !finite(e.hp)) bad.push(`enemy#${e.id}`);
  for (const b of game.bullets) if (!finite(b.x) || !finite(b.z)) bad.push('bullet');
  if (bad.length) {
    failures++;
    notes.push(`  ✗ ${label}: 出现 NaN/Infinity -> ${bad.slice(0, 6).join(', ')}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------
//  导入 main.js
// ---------------------------------------------------------

let H;
try {
  await import(pathToFileURL(path.join(ROOT, 'js', 'main.js')).href);
  H = globalThis.__HBT;
} catch (err) {
  console.error('导入 main.js 失败：');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}

console.log('== 守桥 · 冒烟测试 ==\n');

ok(!!H, 'main.js 正常导入并挂载 __HBT');
if (!H) {
  console.log(notes.join('\n'));
  process.exit(1);
}

const { game, renderer, cam, fit, STATE } = H;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let clock = 0;
function step(dtMs = 16.7) {
  clock += dtMs;
  P.now += dtMs;
  H.frame(clock);
}

function tap(id, ev = {}) {
  const el = ELS.get(id) || DOC.getElementById(id);
  return el.dispatch('pointerdown', {
    preventDefault() {}, stopPropagation() {}, clientX: 195, clientY: 400, pointerId: 1, ...ev,
  });
}

function firePointer(type, sx, sy = 500, pid = 1) {
  CANVAS.dispatch(type, {
    preventDefault() {}, stopPropagation() {}, clientX: sx, clientY: sy, pointerId: pid,
  });
}

// -- 1. 开始界面空转 --
try {
  for (let i = 0; i < 30; i++) step();
  ok(game.state === STATE.START, '初始状态是 START');
  ok(renderer.w === 390 && renderer.h === 844, `渲染尺寸 = ${renderer.w}x${renderer.h}（CSS 像素）`);
  ok(renderer.canvas.width === 780, `canvas 物理宽 = ${renderer.canvas.width}（dpr 封顶 2）`);
  ok(renderer.safeTop > 0, `safeTop 已由顶部 HUD 量出 = ${renderer.safeTop}`);
} catch (err) {
  failures++;
  notes.push(`  ✗ 开始界面空转抛异常: ${err && err.message}`);
}

// -- 1b. 使用说明弹窗：第一次自动弹、之后只能手动开 --
try {
  const gEl = ELS.get('guideOverlay');
  ok(gEl.classList.contains('show'), '第一次进来，使用说明弹窗自动弹出');
  ok(localStorage.getItem('hold-the-bridge:guide') === '1', '弹过之后写下了「已看过」标记');
  tap('guideClose');
  step();
  ok(!gEl.classList.contains('show') && game.state === STATE.START, '点「知道了」收起说明，而且不会顺手开局');
  tap('guideBtn');
  step();
  ok(gEl.classList.contains('show'), '首页的「使用说明」按钮能再打开');
  // 弹窗是盖在开始界面之上的（z-index 由 CSS 保证，这里至少确认两层同时显示）
  ok(ELS.get('startOverlay').classList.contains('show'), '说明弹窗背后仍留着开始界面');
  // m02878：使用说明里那个「开始守桥」按钮被用户点名删掉，这里直接核对源码
  // （桩 DOM 是按需现造的，抓不到"按钮已经不存在"这件事）。
  ok(!/guidePlay/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')), '使用说明里已经没有「开始守桥」按钮');
  tap('guideClose');
  // 回到开始界面，给下一段用
  game.state = STATE.START;
  step();
} catch (err) {
  failures++;
  notes.push(`  ✗ 使用说明弹窗抛异常: ${err && err.message}`);
}

// -- 2. 点开始 --
try {
  // 用户 m03061：整块遮罩不再"按下即开局"，只有「开 始 挑 战」按钮算。
  tap('startOverlay');
  step();
  ok(game.state === STATE.START, '主界面空白处按下去不会开局（只有按钮算）');

  tap('startBtn');
  step();
  ok(game.state === STATE.PREP, `点「开 始 挑 战」后才进入备战（当前 ${game.state}）`);
} catch (err) {
  failures++;
  notes.push(`  ✗ 开始流程抛异常: ${err && err.message}`);
}

// ---------------------------------------------------------
//  一个"会闪避的机器人"：用来验证走位/射击循环真的闭合，
//  同时顺便量一下难度（不被咬死能撑多少波）
// ---------------------------------------------------------
//
//  策略：有敌人贴到桥头（或正在蓄力）时往反方向躲；
//  没有贴脸威胁时，对准最近的一只敌人开火。

const LIMIT = () => cam.roadHalf - 0.075;

//  候选站位打分：站得开火机会多、贴脸威胁少的位置。
//  "开火"= 有敌人在这条射线上且还没贴到桥头；"危险"= 贴到桥头的敌人离这个站位太近。
function botTargetX() {
  // 有奖励门滑过来时，优先站到"更想吃的"那半边——顺便验证左右结算
  if (game.gates) {
    const rank = (u) => { const i = PICK_ORDER.indexOf(u.id); return i < 0 ? 99 : i; };
    const wantLeft = rank(game.gates.left) <= rank(game.gates.right);
    return (wantLeft ? -1 : 1) * cam.roadHalf * 0.5;
  }
  const lim = LIMIT();
  let bestX = 0;
  let bestScore = -1e9;
  for (let k = -4; k <= 4; k++) {
    const cx = (lim * k) / 4;
    let s = 0;
    for (const e of game.enemies) {
      const dx = Math.abs(e.x - cx);
      const atHead = e.z <= e.stopZ + 1.2;
      if (atHead) {
        const near = Math.max(0, 1 - dx / 0.5);
        s -= near * (e.atk === 'rest' ? 3 : 7);
      } else {
        const worth = 3 / (1 + e.z * 0.04);
        s += Math.max(0, 1 - dx / 0.13) * worth;
      }
    }
    // 躲酸球：站在酸球飞来的那条线上会被扣分（不然机器人会被吐死）
    let spit = 0;
    for (const sp of game.spits) {
      const dz = Math.abs(sp.z - game.player.z);
      if (dz > 8) continue;
      const d = Math.abs(sp.x - cx);
      if (d < 0.4) spit += (0.4 - d) * Math.max(0.5, 5 - dz * 0.5);
    }
    s -= spit * 1.6;
    // 躲 BOSS 的必杀导弹（m03096）：圈里直接死，所以圈内站位一律重罚。
    // 落点就是它开火那一刻你站的位置（半径 0.16，见 CFG.bossMissile.radius），
    // 只要横向挪出圈就安全 —— 这里用字面量是为了不把 config 提到模块顶部。
    for (const wn of game.warns) {
      if (Math.abs(wn.x - cx) < 0.16 + 0.03) s -= 30;
    }
    if (s > bestScore) { bestScore = s; bestX = cx; }
  }
  return bestX;
}

// -- 3. 自动战斗（跨波次）--
let sawGates = false;      // 奖励门出现过
let diedAt = null;
let botStats = null;
let bites = 0;
const waveLog = [];
const rewardLog = [];      // 每次吃到奖励：走位选到的是哪一块
let prevWave = 0;
let waveStartFrame = 0;
let bitesAtWave = 0;
let lastSeq = game.upgradeSeq;
let prevStrikeSeq = game.strikeSeq;
let strikesFired = 0;      // 空袭按钮被真正点响了几次
let maxCombo = 0;
let comboPopups = 0;       // "N 连杀！"飘字（应该只有每 5 连一次）
let sawSpit = false;
let sawShielded = false;
let sawSplitter = false;
let corpsesSeen = 0;
const modsSeen = new Set();
// 机器人统计"被咬了几口"用的计数器：**必须把 dmg 原样传下去**。
// 这里踩过一次坑：写成 (e) => { bites++; origBite(e) } 之后，
// 后面所有走 bite(e, dmg) 的调用（河豚爆裂的 2 点伤害）都会被悄悄改成 1 点，
// 而且包装一直留在实例上，让"伤害是否正确"的断言失真。
const botOrigBite = game.bite.bind(game);
game.bite = (e, dmg) => { bites++; return botOrigBite(e, dmg); };

try {
  let held = false;
  let frames = 0;
  let clearedLogged = false;
  for (let i = 0; i < 9000; i++) {
    frames++;

    // 吃到奖励：门在英雄面前结算，upgradeSeq 会 +1
    if (game.upgradeSeq !== lastSeq) {
      lastSeq = game.upgradeSeq;
      rewardLog.push({
        wave: game.wave,
        side: game.player.x < 0 ? '左' : '右',
        id: game.lastGain && game.lastGain.id,
        name: game.lastGain && game.lastGain.name,
      });
    }
    if (game.gates) sawGates = true;

    // v3 新东西的覆盖统计
    if (game.combo > maxCombo) maxCombo = game.combo;
    if (game.spits.length) sawSpit = true;
    if (game.corpses.length > corpsesSeen) corpsesSeen = game.corpses.length;
    if (game.mod) modsSeen.add(game.mod.id);
    for (const e of game.enemies) {
      if (e.maxShield > 0) sawShielded = true;
      if (e.split > 0) sawSplitter = true;
    }
    for (const p of game.popups) if (p.text && p.text.indexOf('连杀！') >= 0) comboPopups++;

    // 上一波打完：记一波明细（wave 在 startWave 里 +1）
    if (game.wave > prevWave) {
      if (prevWave > 0) {
        waveLog.push({
          wave: prevWave,
          t: +((frames - waveStartFrame) * 0.05).toFixed(1),
          bites: bites - bitesAtWave,
          hp: game.player.hp,
        });
      }
      prevWave = game.wave;
      waveStartFrame = frames;
      bitesAtWave = bites;
    }

    if (game.state === STATE.OVER) {
      diedAt = frames * 0.05;
      waveLog.push({
        wave: prevWave,
        t: +((frames - waveStartFrame) * 0.05).toFixed(1),
        bites: bites - bitesAtWave,
        hp: game.player.hp,
        died: true,
      });
      break;
    }

    // 最后一波（BOSS 波）打完不会再有"下一波"，所以上面按波次递增记的那段日志抓不到它。
    // 这里单独补一条，用来量"BOSS 消耗战"到底打了多久（翻倍血量之后尤其要看这个数）。
    if (!clearedLogged && game.state === STATE.CLEAR && prevWave > 0) {
      clearedLogged = true;
      waveLog.push({
        wave: prevWave,
        t: +((frames - waveStartFrame) * 0.05).toFixed(1),
        bites: bites - bitesAtWave,
        hp: game.player.hp,
        cleared: true,
      });
    }

    // 按住不放，每帧用真实输入通道算出想要的手指位置
    if (!held) { firePointer('pointerdown', 195); held = true; }
    const want = botTargetX();
    const sx = 195 + (want - game._dragWorld) * cam.scaleNear;
    firePointer('pointermove', sx);

    // v3：能量满了就"用另一根手指"点右下角空袭。
    // 走真实输入通道（main.js 的 pointerdown + 渲染器给的命中框），顺便验证
    // "一根手指按着走位、另一根手指点按钮"这个真机上的实际姿势。
    if (game.canStrike() && renderer.strikeBtn) {
      const sb = renderer.strikeBtn;
      firePointer('pointerdown', sb.x, sb.y, 2);
      firePointer('pointerup', sb.x, sb.y, 2);
      if (game.strikeSeq !== prevStrikeSeq) { prevStrikeSeq = game.strikeSeq; strikesFired++; }
    }

    step(50);
  }

  ok(prevWave >= 1, `战斗推进到第 ${prevWave} 波（机器人 ${diedAt === null ? '没死' : `活了 ${diedAt.toFixed(1)}s`}）`);
  ok(sawGates && rewardLog.length >= 2, `奖励门流程闭合（滑动 + 左右结算 + 生效），共吃到 ${rewardLog.length} 块`);
  ok(game.kills > 0, `击杀计数在动 = ${game.kills}`);
  ok(game.score > 0, `分数在涨 = ${game.score}`);
  ok(corpsesSeen > 0 || game.kills === 0, `击杀留下尸体/血泊（尸体峰值 ${corpsesSeen} 具）`);
  ok(maxCombo >= 2, `连杀计数在动（最高 ${maxCombo} 连杀）`);
  ok(strikesFired > 0 || game.kills < 12, `空袭按钮被点响 ${strikesFired} 次（另一根手指点，不打断走位）`);
  notes.push(
    `  · 这一局里见到的：词条 ${[...modsSeen].join('/') || '无'} | 吐酸者 ${sawSpit ? '有' : '无'} | ` +
      `铁盾兵 ${sawShielded ? '有' : '无'} | 分裂者 ${sawSplitter ? '有' : '无'} | 连杀飘字 ${comboPopups} 帧`
  );
  ok(checkNumbers(game, '长时间战斗'), '长时间战斗无 NaN');
  botStats = { maxWave: prevWave, kills: game.kills, score: game.score, diedAt, hp: game.player.hp, bites, waveLog, rewardLog, maxCombo, strikesFired, mods: [...modsSeen] };
} catch (err) {
  failures++;
  notes.push(`  ✗ 战斗循环抛异常: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
}
game.bite = botOrigBite; // 统计用的包装到此为止，后面的段落要测真实伤害

// ---------------------------------------------------------
// -- 3b. v3 新系统逐个点名（连杀 / 空袭 / 三种新怪 / 五种词条）--
//  上面那段是"放任机器人打"，能覆盖到多少取决于它活多久；
//  这一段用直接调用 + 真实输入通道，把每个新系统单独按一遍。
// ---------------------------------------------------------
try {
  const { CFG, UPGRADES: UPS } = await import(pathToFileURL(path.join(ROOT, 'js', 'config.js')).href);
  game.state = STATE.FIGHT;
  // 这一段的机制断言不能受"机器人刚才打到第几波"影响：机器人现在能一路打到第 15 波，
  // 那样 game.wave 就是 15，下面任何一次 update() 只要敌人数组和出怪队列都空着，
  // 真实状态机就会判成"清完最后一波"→ levelClear() → state = CLEAR，
  // 之后所有依赖 FIGHT/PREP 的断言（空袭等）都会连锁失败。所以这里把波次钉在中段。
  game.wave = 3;
  game.spawnQueue.length = 0;
  game.mod = null;
  game.enemies.length = 0;
  game.spits.length = 0;
  game.strikes.length = 0;
  game.corpses.length = 0;
  game.stains.length = 0;
  game.combo = 0; game.comboT = 0; game.comboSeq = 0; game.energy = 0;
  game.player.hp = 50;
  game.player.iframe = 0;
  game.player.shield = 0;

  const mk = (kind, dz = 3) => {
    game.spawnEnemy(kind, 0, game.player.z + dz, 1);
    return game.enemies[game.enemies.length - 1];
  };

  // (a) 连杀 + 分数倍率 + 顿帧 + 尸体/血泊 + 充能
  game.score = 0; game.kills = 0;
  const e1 = mk('walker');
  const base1 = e1.score;
  game.killEnemy(e1);
  ok(game.kills === 1 && game.combo === 1, `击杀后 kills=${game.kills} combo=${game.combo}`);
  for (let i = 0; i < 4; i++) game.killEnemy(mk('walker'));
  ok(game.combo === 5, `连杀累到 ${game.combo}`);
  ok(game.comboSeq >= 1, `每 5 连给一次连杀提示（comboSeq=${game.comboSeq}）`);
  ok(game.score > base1 * 5, `连杀倍率让分数滚起来：${game.score} > 单只 ${base1} × 5`);
  ok(game.hitStop > 0, `击杀触发顿帧 hitStop=${game.hitStop.toFixed(3)}`);
  ok(game.corpses.length >= 5 && game.stains.length >= 5, `留下 ${game.corpses.length} 具尸体 / ${game.stains.length} 摊血泊`);
  ok(game.energy > 0, `击杀充能 energy=${Math.round(game.energy)}`);

  // (a2) 角色台词：每 5 连喊一句英文，10 连是 "PERFECT!"（用户点名要的）
  ok(game.shout && game.shout.text === 'NICE!', `5 连时英雄喊了一句：${game.shout && game.shout.text}`);
  for (let i = 0; i < 5; i++) game.killEnemy(mk('walker'));
  ok(game.combo === 10 && !!game.shout && game.shout.text === 'PERFECT!',
    `10 连喊的是 ${game.shout && game.shout.text}`);
  ok(CFG.shouts.length >= 5 && CFG.shouts.every((s) => /^[A-Z! ]+$/.test(s.text)),
    `台词表 ${CFG.shouts.length} 条，全是英文短句`);
  // 台词会自己到期消失（不能一直挂在头上）
  game.shout.t = game.shout.life;
  game.update(0.05);
  ok(!game.shout, '台词到时自动消失');

  // (b) 被咬一口断连杀
  const hp0 = game.player.hp;
  game.bite({ x: game.player.x, z: game.player.z });
  ok(game.combo === 0 && game.comboT === 0, '被咬断连杀');
  ok(game.player.hp === hp0 - 1, `被咬掉 1 血（${hp0}→${game.player.hp}）`);
  game.player.iframe = 0;
  game.player.hp = 50;

  // (c) 分裂者：死后裂成两只
  const nBefore = game.enemies.length;
  const sp = mk('splitter');
  ok(sp.split === CFG.kinds.splitter.split, `分裂者 split=${sp.split}`);
  game.killEnemy(sp);
  ok(game.enemies.length >= nBefore + 2, `分裂者死后裂出 ${game.enemies.length - nBefore} 只（含它自己那具）`);

  // (c1) 用户反馈"僵尸会突然出现在面前"：分裂小兵不能原地冒出来。
  //      必须在后方出生 + 有孵化期（孵化期内不咬人）。
  const kids = game.enemies.slice(-2);
  ok(
    kids.length === 2 && kids.every((k) => k.birth > 0),
    `分裂小兵有孵化期（birth=${kids[0] && kids[0].birth}）`
  );
  ok(
    kids.every((k) => k.z > sp.z + 1),
    `分裂小兵在后方出生（z=${kids.map((k) => k.z.toFixed(1)).join('/')} > 本体 ${sp.z.toFixed(1)}+1）`
  );
  step(1); // 走一帧，让渲染器真的画一次"孵化中"的小兵（配色/缩放写错会在这里炸）
  for (const k of kids) game.enemies.splice(game.enemies.indexOf(k), 1);

  // (c2) 停下线必须跟着英雄：英雄压到最前时，怪不能在身后站定
  const zFwdAbs = CFG.zNear + CFG.hero.zFwd;
  game.player.z = zFwdAbs;
  game.player.targetZ = zFwdAbs;
  const appr = mk('walker', 6);
  appr.state = 'approach';
  appr.z = zFwdAbs + 0.2; // 摆在"英雄前方一点点"，模拟它正走过来
  // 这一段是手搓出来的敌人，前面几步的 kill/splice 会把敌人数组清空，
  // 真实的状态机就会当成"清完一波"切到 PREP，而 updateEnemies 只在 FIGHT 里跑。
  // 所以这里先把状态按回 FIGHT，测的才是"停下线跟着英雄走"这一件事。
  game.state = STATE.FIGHT;
  step(1);
  ok(
    appr.stopZ >= game.player.z + CFG.wave.stopGap - 1e-6,
    `停下线跟着英雄走（stopZ=${appr.stopZ.toFixed(2)} ≥ 英雄 ${game.player.z.toFixed(2)}+${CFG.wave.stopGap}；state=${game.state} 在数组里=${game.enemies.includes(appr)}）`
  );
  game.enemies.splice(game.enemies.indexOf(appr), 1);
  game.player.z = CFG.zNear;
  game.player.targetZ = CFG.zNear;
  step(1);

  // (d) 铁盾兵：正面吃三下才破盾，破盾前伤害减半
  const sh = mk('shielded');
  ok(sh.maxShield === CFG.kinds.shielded.shield, `铁盾兵盾量 ${sh.maxShield}`);
  const shp0 = sh.hp;
  game.damageEnemy(sh, 10, null, false);
  ok(sh.shield === sh.maxShield - 1, `打一下掉一层盾（${sh.maxShield}→${sh.shield}）`);
  ok(Math.abs(shp0 - sh.hp - 5) < 1e-6, `带盾时伤害减半：10 → ${shp0 - sh.hp}`);
  game.damageEnemy(sh, 10, null, false);
  game.damageEnemy(sh, 10, null, false);
  ok(sh.shield === 0, `三下破盾（shield=${sh.shield}）`);
  const hpAfterShield = sh.hp;
  game.damageEnemy(sh, 10, null, false);
  ok(hpAfterShield - sh.hp === 10, `破盾后吃满伤害（${hpAfterShield}→${sh.hp}）`);

  // (e) 吐酸者：停在远处、吐酸、酸球命中掉血
  game.enemies.length = 0; game.spits.length = 0;
  const spitter = mk('spitter');
  spitter.atkT = 0;
  let threw = 0;
  for (let i = 0; i < 40; i++) {
    game.updateEnemies(0.05);
    if (game.spits.length > threw) threw = game.spits.length;
  }
  ok(spitter.stopZ > game.player.z + 2, `吐酸者停在远处（stopZ=${spitter.stopZ.toFixed(1)}，玩家在 ${game.player.z.toFixed(1)}）`);
  ok(threw > 0, `吐酸者吐出 ${threw} 个酸球`);
  if (game.spits.length) {
    const s = game.spits[0];
    s.x = game.player.x; s.z = game.player.z; // 摆到脸上，验命中
    const hpB = game.player.hp;
    game.updateSpits(0.05);
    ok(game.player.hp === hpB - 1, `酸球命中玩家掉血（${hpB}→${game.player.hp}）`);
  }
  game.player.iframe = 0;
  game.player.hp = 50;

  // (f) 空袭：能量满 → 落点从远处一路铺到桥头 → 炸伤敌人 → 能量清零
  game.enemies.length = 0; game.strikes.length = 0;
  for (let i = 0; i < 8; i++) mk('brute', 2 + i * 1.6);
  game.energy = CFG.charge.max;
  ok(game.canStrike(), '能量满时可以呼叫空袭');
  ok(game.triggerStrike(), 'triggerStrike() 被接受');
  ok(game.energy === 0 && game.strikes.length === CFG.strike.count, `能量清零、${game.strikes.length} 发导弹在空中`);
  ok(!!game.plane, `轰炸机已起飞（方向 ${game.plane.dir > 0 ? '左→右' : '右→左'}，航线 y=${game.plane.y.toFixed(2)}）`);
  ok(game.strikes.every((s) => !s.launched), '导弹先挂在机上（还没投下来）');
  const zs = game.strikes.map((s) => s.z);
  ok(Math.min(...zs) < game.player.z + 3, `最后一发落在桥头附近（最近 ${Math.min(...zs).toFixed(1)}，最远 ${Math.max(...zs).toFixed(1)}）`);
  const aliveBefore = game.enemies.filter((e) => !e.dead).length;
  for (let i = 0; i < 60; i++) { game.updateStrikes(0.05); game.updateEnemies(0.05); }
  ok(game.strikes.length === 0, '导弹全部落地');
  // 飞机横穿完会自己消失（不能一直停在画面上）
  let planeSteps = 0;
  while (game.plane && planeSteps++ < 120) game.updateStrikes(0.05);
  ok(!game.plane, `飞机横穿完自动消失（约 ${(planeSteps * 0.05).toFixed(1)}s）`);
  const aliveAfter = game.enemies.filter((e) => !e.dead).length;
  const damaged = game.enemies.filter((e) => !e.dead && e.hp < e.maxHp).length;
  ok(aliveAfter < aliveBefore || damaged > 0, `空袭犁到人堆：炸死 ${aliveBefore - aliveAfter} 只、另有 ${damaged} 只残血`);
  ok(game.flash > 0 || game.rings.length > 0, '空袭有闪光/冲击环反馈');

  // (g) 五种词条都能挂上，而且不产生 NaN
  const seenMods = [];
  for (const m of CFG.mods) {
    game.enemies.length = 0;
    game.mod = m;
    game.lastMod = m.id;
    game.player.hp = 50;
    game.state = STATE.FIGHT;
    game.startWave();
    game.update(0.05);
    seenMods.push(m.id);
    if (!checkNumbers(game, `词条 ${m.id}`)) throw new Error(`词条 ${m.id} 出现 NaN`);
  }
  ok(seenMods.length === CFG.mods.length, `五种词条全部能挂上：${seenMods.join('/')}`);
  for (let i = 0; i < 3; i++) game.update(0.05);
  ok(checkNumbers(game, '词条叠加'), '连续换词条后无 NaN');

  // (h) 空袭按钮的命中框（走 main.js 的真实 pointerdown）
  game.mod = null;
  game.state = STATE.FIGHT;
  game.player.hp = 99; // 后面第 4 段会空跑 700 多帧的战斗，血量给足，别让它中途死掉
  game.enemies.length = 0;
  game.energy = CFG.charge.max;
  step(50); // 让渲染器把 strikeBtn 写出来
  const sb = renderer.strikeBtn;
  ok(!!sb && sb.r > 20, `空袭按钮命中框 = (${Math.round(sb.x)},${Math.round(sb.y)}) r=${Math.round(sb.r)}`);
  const seq0 = game.strikeSeq;
  firePointer('pointerdown', sb.x, sb.y, 3);
  ok(game.strikeSeq === seq0 + 1, '点在按钮上真的能叫到空袭');
  game.energy = CFG.charge.max;
  const seq1 = game.strikeSeq;
  firePointer('pointerdown', sb.x - sb.r - 12, sb.y, 4);
  firePointer('pointerup', sb.x - sb.r - 12, sb.y, 4);
  ok(game.strikeSeq === seq1, '点在按钮外不会误触空袭');
} catch (err) {
  failures++;
  notes.push(`  ✗ v3 新玩法抛异常: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
}

// ---------------------------------------------------------
// -- 3c. 本轮新增：BOSS 人海 / BOSS 血条 / 第 15 波结算金币 / 主界面 --
// ---------------------------------------------------------
try {
  const { CFG: C } = await import(pathToFileURL(path.join(ROOT, 'js', 'config.js')).href);

  // (a) 人海波（第 5 / 10 波）：铺一片"一枪一个"的小兵，但**不夹带 BOSS**
  game.reset();
  game.state = STATE.PREP;
  game.mod = null;
  game.wave = C.wave.hordeEvery - 1; // 下一波就是第一个人海波（第 5 波）
  game.spawnQueue.length = 0;
  game.enemies.length = 0;
  game.gates = null;
  game.startWave();
  const midHorde = game.enemies.filter((e) => e.kind === 'walker');
  ok(
    !game.enemies.some((e) => e.kind === 'boss'),
    `第 ${C.wave.hordeEvery} 波只来人海、没有 BOSS（BOSS 只留给最后一波）`
  );
  ok(midHorde.length >= C.bossHorde.base, `人海波先铺一地小兵（walker ${midHorde.length} 只）`);

  // (a2) BOSS 波 = 关卡最后一波：人海在前，巨大的 BOSS 在后
  game.reset();
  game.state = STATE.PREP;
  game.mod = null;
  game.wave = C.level.waves - 1; // 下一波就是第 15 波（最后一波）
  game.spawnQueue.length = 0;
  game.enemies.length = 0;
  game.gates = null;
  game.startWave();
  const boss = game.enemies.find((e) => e.kind === 'boss');
  const horde = game.enemies.filter((e) => e.kind === 'walker');
  ok(!!boss && horde.length >= C.bossHorde.base, `最后一波：walker ${horde.length} 只 + BOSS 1 只`);
  ok(horde.every((e) => e.hp === 1), `小兵一枪一个（hp=${horde[0] && horde[0].hp}，目标是 ${C.bossHorde.hpTarget}）`);
  const hordeNearest = Math.min(...horde.map((e) => e.z));
  ok(hordeNearest < boss.z, `小兵全在 BOSS 前面（小兵最前 z=${hordeNearest.toFixed(1)} < BOSS z=${boss.z.toFixed(1)}）`);
  ok(
    boss.size === C.kinds.boss.size && boss.size >= C.kinds.walker.size * 4,
    `BOSS 体型 ${boss.size}（小兵的 ${(boss.size / C.kinds.walker.size).toFixed(1)} 倍）`
  );
  ok(boss.speed < C.wave.zombieSpeed, `BOSS 走得更慢（${boss.speed.toFixed(2)} < 小兵 ${C.wave.zombieSpeed}）`);
  ok(
    boss.hp >= C.kinds.boss.hpMin && boss.hp <= C.kinds.boss.hpMax && boss.maxHp === boss.hp,
    `BOSS 血量按玩家 DPS 校准（${boss.hp} 血，目标 ${C.kinds.boss.seconds}s，区间 ${C.kinds.boss.hpMin}~${C.kinds.boss.hpMax}）`
  );
  step(2);
  ok(!!renderer.bossBar && renderer.bossBar.frac > 0.9, `BOSS 血条已显示（${Math.round(renderer.bossBar.w)}x${renderer.bossBar.h}px）`);
  boss.hp = Math.ceil(boss.maxHp * 0.2);
  step(1);
  ok(!!renderer.bossBar && renderer.bossBar.frac < 0.25, `血条跟着掉（剩 ${(renderer.bossBar.frac * 100).toFixed(0)}%）`);

  // (a3) BOSS 必杀导弹（m03096，m03130 修）：只认血量到 3/4，跟它有没有走到停下线无关。
  //      落点 = 开火那一刻你站的位置（不是追踪弹）→ 不挪步必中，中者直接死。
  game.state = STATE.FIGHT;
  game.wave = 1; // 别让它判定成"清完最后一波"
  game.spawnQueue.length = 0;
  game.enemies = [boss];
  game.player.hp = C.hero.hp;
  game.player.shield = 0;
  game.player.iframe = 0;
  game.player.x = -0.2;
  game.player.targetX = -0.2;
  game.player.z = C.zNear;
  game.player.targetZ = C.zNear;
  // 关键：把它按回"刚出场、还在往这边走"的状态 —— 真机上它要走 10 秒才到停下线，
  // 玩家通常在这段时间里已经把它打到 3/4 以下了（这就是 m03130 那个 bug 的现场）。
  boss.z = C.zFar - 5;
  boss.state = 'approach';
  boss.hp = boss.maxHp;
  boss.missileFired = false;
  for (let i = 0; i < 60; i++) step(50); // 3 秒，它还在路上
  const fracNow = boss.hp / boss.maxHp;
  ok(boss.state === 'approach', `BOSS 还在往这边走（state=${boss.state} z=${boss.z.toFixed(1)}）`);
  ok(
    game.warns.length === 0 && boss.missileFired === false,
    `血还没掉到 3/4（现在 ${(fracNow * 100).toFixed(0)}%）时一发都不放（预警圈 ${game.warns.length} 个）`
  );
  // 掉到 3/4 → 下一帧强制开火（此刻它还没站定，也必须放）
  boss.hp = Math.floor(boss.maxHp * C.bossMissile.hpAt);
  step(50);
  ok(
    game.warns.length === 1 && boss.state === 'approach',
    `血量一到 3/4 就放技能（哪怕它还在路上：state=${boss.state} 预警圈 ${game.warns.length} 个 hp=${boss.hp}/${boss.maxHp}）`
  );
  ok(boss.missileFired === true, '这一发整场只有一次（标记已用掉）');
  ok(
    Math.abs(game.warns[0].x - game.player.x) < 1e-6,
    `预警落点 = 开火时你站的位置（x=${game.warns[0].x.toFixed(2)}）`
  );
  for (let i = 0; i < 20; i++) step(50); // 预警 1.5s 还没落地
  ok(game.warns.length === 1 && boss.missileFired === true, '预警期间也不会补第二发');
  for (let i = 0; i < 14; i++) step(50); // 累计 1.7s > 预警
  ok(
    game.player.hp === 0 && game.state === STATE.OVER,
    `站着不动被技能打中直接死（hp=${game.player.hp} state=${game.state}）`
  );
  // 再打一次：这回预警一出现就横向挪开 —— 挪开就活，一个圈不落
  game.state = STATE.FIGHT;
  game.player.hp = C.hero.hp;
  game.player.iframe = 0;
  game.player.shield = 0;
  game.player.x = -0.2;
  game.player.targetX = -0.2;
  boss.hp = Math.floor(boss.maxHp * C.bossMissile.hpAt);
  boss.missileFired = false;
  step(50);
  ok(game.warns.length === 1, `第二次挑战：技能又放了一发（${game.warns.length} 个）`);
  game.player.x = 0.32;
  game.player.targetX = 0.32;
  for (let i = 0; i < 34; i++) step(50);
  ok(
    game.player.hp === C.hero.hp && game.state === STATE.FIGHT,
    `预警期间挪一步就躲开了（血 ${game.player.hp} / 满血 ${C.hero.hp}）`
  );
  game.warns.length = 0;

  // (b) 第 15 波清完 = 第一关通关：按得分比例结算金币并写进存档
  game.enemies.length = 0;
  game.spawnQueue.length = 0;
  game.state = STATE.FIGHT;
  game.wave = C.level.waves;
  game.score = 5000;
  game.kills = 100;
  game.comboBest = 30;
  const scoreAfter = 5000 + C.score.perWave * C.level.waves; // 清波奖励也计入总分
  const wantCoins = Math.max(1, Math.round(scoreAfter * C.level.coinRatio));
  const coinsBefore = Number(localStorage.getItem(C.coinKey) || '0');
  game.onWaveClear();
  ok(game.state === STATE.CLEAR, `第 ${C.level.waves} 波清完直接通关（state=${game.state}）`);
  ok(
    !!game.lastReward && game.lastReward.score === scoreAfter && game.lastReward.coins === wantCoins,
    `按得分比例结算金币（${scoreAfter} × ${C.level.coinRatio} = ${wantCoins}）`
  );
  ok(
    Number(localStorage.getItem(C.coinKey)) === coinsBefore + wantCoins,
    `金币累加进存档（${coinsBefore} → ${localStorage.getItem(C.coinKey)}）`
  );
  ok(localStorage.getItem(C.progressKey) === '1', '通关进度已记录');
  step(2);
  ok(ELS.get('clearOverlay').classList.contains('show'), '通关结算面板已弹出');
  ok(String(ELS.get('clearCoins').textContent) === String(wantCoins), `面板上的金币 = ${ELS.get('clearCoins').textContent}`);

  // (c) 返回主界面：金币要跟着显示出来
  for (let i = 0; i < 45; i++) step(20); // 等过 600ms 误触保护
  tap('clearMenu');
  step(2);
  ok(game.state === STATE.START, `点「返回主界面」回到主界面（state=${game.state}）`);
  ok(ELS.get('startOverlay').classList.contains('show'), '主界面已显示');
  ok(
    String(ELS.get('startCoins').textContent) === String(coinsBefore + wantCoins),
    `主界面显示金币 ${ELS.get('startCoins').textContent}`
  );

  // (d) 四个入口：这一版只预留按钮，点了只提示、不实装、也不许误触发开局
  const st0 = game.state;
  for (const id of ['menuRole', 'menuWeapon', 'menuShop', 'menuLevel']) tap(id);
  step(2);
  ok(game.state === st0, `四个入口点了只提示（state 仍是 ${game.state}）`);
  ok(ELS.get('startOverlay').classList.contains('show'), '点入口没有误触发「开始挑战」');
  ok(String(ELS.get('gainToast').textContent).includes('该功能未实装'), `入口提示 = ${ELS.get('gainToast').textContent}`);
  ok(
    String(ELS.get('menuHint').textContent).includes('该功能未实装') && ELS.get('menuHint').classList.contains('show'),
    `主界面自己那行提示也亮了（${ELS.get('menuHint').textContent}）`
  );

  // (e) 用户点名：弹道数还不到 3 条时，进攻门必须优先给"弹道 +1"
  game.reset();
  game.newRun();
  const b0 = game.weapon.bullets;
  let tenBullets = 0;
  for (let i = 0; i < 10; i++) {
    game.openGates();
    if (game.gates.left.id === 'bullets') tenBullets += 1;
  }
  ok(
    tenBullets === 10,
    `弹道 ${b0} < ${C.gate.preferBulletsUntil} 时进攻门每扇都是"弹道 +1"（10 抽中 ${tenBullets}）`
  );
  for (let i = b0; i < C.gate.preferBulletsUntil; i++) {
    game.openGates();
    game.applyUpgrade('bullets', 0);
  }
  ok(
    game.weapon.bullets === C.gate.preferBulletsUntil,
    `吃掉 ${C.gate.preferBulletsUntil - b0} 次加成后弹道铺到 ${game.weapon.bullets} 条`
  );
  let stillBullets = 0;
  for (let i = 0; i < 10; i++) {
    game.openGates();
    if (game.gates.left.id === 'bullets') stillBullets += 1;
  }
  ok(
    stillBullets < 10,
    `弹道达标后进攻门恢复随机（10 抽里 ${stillBullets} 次是弹道，不再被锁定）`
  );

  // 收尾：清干净，别影响第 4~8 段
  game.reset();
  game.enemies.length = 0;
  game.spawnQueue.length = 0;
  game.player.hp = 99;
} catch (err) {
  failures++;
  notes.push(`  ✗ 本轮新玩法抛异常: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
}

// ---------------------------------------------------------
// -- 3d. 第二关「疯狂水世界」：进场对话 / 海洋皮肤 / 水雷 / 河豚 --
// ---------------------------------------------------------
try {
  const { CFG: C2, setLevel: setLv } = await import(pathToFileURL(path.join(ROOT, 'js', 'config.js')).href);
  const mk2 = (kind, dz = 4) => {
    game.spawnEnemy(kind, 0, game.player.z + dz, 1);
    return game.enemies[game.enemies.length - 1];
  };
  const wipe = () => {
    game.enemies.length = 0;
    game.spawnQueue.length = 0;
    game.bullets.length = 0;
    game.mines.length = 0;
    game.player.hp = 50;
    game.player.iframe = 0;
    game.player.shield = 0;
  };

  // (a) 进场对话：英雄报"城市守住了" → 司令说海里还有东西 → 英雄要下水
  game.beginLevel(1);
  step();
  ok(game.state === STATE.TALK, '第二关进来先停在对话（state=talk），不直接开打');
  ok(ELS.get('talkOverlay').classList.contains('show'), '进场对话弹窗已弹出');
  ok(!ELS.get('talkActions').classList.contains('show'), '对话没翻完时不显示两个选择按钮');
  const line1 = String(ELS.get('talkText').textContent);
  ok(line1.length > 0, `第一句已经填上：${line1}`);
  // onTap 有 300ms 误触去重：两次点击之间得把时钟推过去，否则第二下会被吞掉
  const tapTalk = () => {
    tap('talkOverlay');
    for (let i = 0; i < 25; i++) step();
  };
  tapTalk();
  ok(String(ELS.get('talkText').textContent) !== line1, '点一下就翻到下一句');
  let guard = 0;
  while (!ELS.get('talkActions').classList.contains('show') && guard++ < 6) tapTalk();
  ok(ELS.get('talkActions').classList.contains('show'), `翻完全部台词才出按钮（共点了 ${guard + 2} 下）`);
  ok(String(ELS.get('talkStamp').textContent).includes('03 / 03'), `对话进度 03 / 03（实际 ${ELS.get('talkStamp').textContent}）`);
  ok(!!ELS.get('talkStart') && !!ELS.get('talkMenu'), '两个按钮都在 DOM 里：启动 / 返回主界面');
  tap('talkStart');
  step();
  ok(game.state === STATE.PREP, '点「疯狂水世界 · 启动！」直接进备战');
  ok(!ELS.get('talkOverlay').classList.contains('show'), '进场后对话弹窗收起');
  ok(C2.level.skin === 'ocean' && C2.level.id === 2, `当前关卡切到了第 2 关（${C2.level.name}）`);
  ok(C2.theme.skyDeco === 'bubbles', '当前主题换成海洋版（天上冒气泡）');

  // (b) 海洋皮肤：七种怪全都挂上动物部件 + ocean 配色
  game.state = STATE.FIGHT;
  wipe();
  const oceanKinds = [];
  for (const kind of ['walker', 'runner', 'brute', 'spitter', 'shielded', 'splitter', 'boss']) {
    const e = mk2(kind, 4 + oceanKinds.length * 1.2);
    const skin = C2.kinds[kind].ocean;
    if (e.animal === skin.animal && e.color === skin.color && e.dark === skin.dark) oceanKinds.push(kind);
  }
  ok(oceanKinds.length === 7, `七种怪都换了海洋动物（walker=鱼/runner=鱿/brute=蟹/boss=鲨/spitter=河豚/shielded=龟/splitter=水母）`);

  // (c) 奖励池：l2 专属（水雷/鱼雷）只在第二关出现
  const drawGates = (n) => {
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      game.stacks = {};
      game.openGates();
      seen.add(game.gates.left.id);
      seen.add(game.gates.right.id);
    }
    return seen;
  };
  const l2seen = drawGates(60);
  ok(l2seen.has('mine') && l2seen.has('torpedo'), `第二关抽得到 l2 专属奖励（${[...l2seen].filter((x) => ['mine', 'torpedo', 'deepSea', 'current', 'coralArmor', 'bubbleShield'].includes(x)).join('/')}）`);
  setLv(0);
  const l1seen = drawGates(60);
  ok(!l1seen.has('mine') && !l1seen.has('torpedo') && !l1seen.has('deepSea'),
    '第一关抽不到 l2 专属奖励（池子里没有没见过的水雷/鱼雷）');

  // (d) 水雷：一层升级每波 3 颗，布在英雄前面，怪踩上去就炸
  setLv(1);
  game.reset();
  game.state = STATE.FIGHT;
  game.player.z = 10;
  game.player.x = 0;
  game.mineStacks = 2;
  game.placeMines();
  ok(game.mines.length === C2.mine.count * 2, `吃到两层「布水雷」后一波撒 ${game.mines.length} 颗`);
  ok(game.mines.every((m) => m.z > game.player.z + 2), '水雷全在英雄前面（不会跑到镜头和英雄之间挡住画面）');
  const victim = mk2('walker', 4);
  victim.hp = 20;
  victim.maxHp = 20;
  victim.x = game.mines[0].x;
  victim.z = game.mines[0].z;
  const one = game.mines[0];
  game.mines = [one]; // 只留一颗，免得同时踩响两颗（判定半径有 0.6 那么宽松）
  game.updateMines(0.016);
  ok(victim.hp === 20 - C2.mine.damage, `怪踩上去扣 ${C2.mine.damage} 血（20 → ${victim.hp}）`);
  ok(game.mines.length === 0, '炸过的那颗从场上消失');

  // (e) 河豚：第二关的吐酸者死了会炸，第一关不会
  game.reset();
  game.state = STATE.FIGHT;
  wipe();
  game.player.hp = 4;
  const puffer = mk2('spitter', 0.2);
  puffer.x = 0;
  game.killEnemy(puffer);
  ok(game.player.hp === 4 - C2.puffer.blastDmg,
    `河豚贴脸炸开，玩家扣 ${C2.puffer.blastDmg} 血（4 → ${game.player.hp}）`);
  setLv(0);
  game.reset();
  game.state = STATE.FIGHT;
  wipe();
  game.player.hp = 4;
  const sp2 = mk2('spitter', 0.2);
  sp2.x = 0;
  game.killEnemy(sp2);
  ok(game.player.hp === 4, '第一关的吐酸者死了不会炸伤玩家（河豚机制只在第二关）');

  // (f) 切回第一关，皮肤和玩法都复原
  wipe();
  const back = mk2('walker', 4);
  ok(back.animal === null && back.color === C2.kinds.walker.color, '切回第一关，小兵的颜色和部件复原');
  ok(game.mineStacks === 0 || C2.level.skin !== 'ocean', '第一关不再布水雷');

  // 收尾：回到第一关的开局状态，别影响第 4~8 段
  game.newRun(0);
  game.enemies.length = 0;
  game.spawnQueue.length = 0;
  game.mines.length = 0;
} catch (err) {
  failures++;
  notes.push(`  ✗ 第二关（疯狂水世界）抛异常: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
}

// -- 4. 全部升级逐个生效 --
try {
  game.state = STATE.PREP;
  game.player.hp = 99; // 空跑 720 帧，别中途被咬死（死了结算面板就会被提前写一遍）
  const { UPGRADES } = await import(pathToFileURL(path.join(ROOT, 'js', 'config.js')).href);
  for (const u of UPGRADES) {
    game.applyUpgrade(u.id);
    for (let i = 0; i < 40; i++) step(50);
  }
  ok(true, `${UPGRADES.length} 种升级全部生效（含 4 档武器质变 ${game.tier.name}）`);
  ok(checkNumbers(game, '升级后'), '选完所有升级后无 NaN');
} catch (err) {
  failures++;
  notes.push(`  ✗ 升级分支抛异常: ${err && err.message}`);
}

// -- 5. 尺寸变化（旋转 / 地址栏伸缩 / 切后台）--
try {
  APP.clientWidth = 844;
  APP.clientHeight = 390;
  def('devicePixelRatio', 1);
  fit();
  for (let i = 0; i < 20; i++) step();
  ok(renderer.w === 844, `旋转后重新适配到 ${renderer.w}x${renderer.h}`);

  Object.defineProperty(DOC, 'hidden', { value: true, configurable: true });
  (WINDOW_LISTENERS.visibilitychange || []).forEach((fn) => fn());
  Object.defineProperty(DOC, 'hidden', { value: false, configurable: true });
  (WINDOW_LISTENERS.visibilitychange || []).forEach((fn) => fn());
  for (let i = 0; i < 20; i++) step();
  ok(true, '旋转 + 切后台/回前台无异常');
} catch (err) {
  failures++;
  notes.push(`  ✗ 尺寸变化抛异常: ${err && err.message}`);
}

// -- 6. 结算 --
let expectedBest = 0;
try {
  // 先离开 OVER 态，保证 gameOver() 一定会触发一次"状态变化"，
  // 这样结算面板才会被真正重画一遍（否则只是沿用上一局的数字）。
  // 注意必须放一帧过去：main.js 是靠"每帧比对状态"来决定要不要重画面板的，
  // 同一 tick 里 FIGHT→OVER 连着设，它根本没看见中间那个 FIGHT。
  if (game.state === STATE.OVER) {
    game.state = STATE.FIGHT;
    step();
  }
  // 机器人在第 3 段可能已经刷了很高的分，所以"这一局的分数"要取
  // "比历史最高还高一点"，才能顺带验到"刷新纪录"这条路径
  const bestBefore = Number(localStorage.getItem('hold-the-bridge:best') || '0');
  game.score = Math.max(game.score, bestBefore + 1234, 12345);
  expectedBest = game.score;
  game.kills = 77;
  game.gameOver();
  for (let i = 0; i < 10; i++) step();
  ok(game.state === STATE.OVER, '游戏结束状态正确');
  ok(game.newBest === true, '刷新最高分被标记为新纪录');
  ok(String(ELS.get('overScore').textContent) === String(game.score), `结算面板分数 = ${ELS.get('overScore').textContent}（game.score=${game.score}）`);
  ok(String(ELS.get('overKills').textContent) === '77', `结算面板击杀 = ${ELS.get('overKills').textContent}`);
  ok(ELS.get('newBest').classList.contains('show'), '新纪录徽章已显示');
  ok(ELS.get('overOverlay').classList.contains('show'), '结束遮罩已显示');
} catch (err) {
  failures++;
  notes.push(`  ✗ 结算流程抛异常: ${err && err.message}`);
}

// -- 7. 重开（要等过 600ms 误触保护）--
try {
  for (let i = 0; i < 60; i++) step(20); // 1.2s
  const n = tap('againBtn');
  ok(n > 0, '「再来一局」按钮已绑定');
  step();
  ok(game.state === STATE.PREP, `点"再来一局"回到备战（当前 ${game.state}）`);
  ok(game.score === 0 && game.kills === 0, '重开后分数/击杀归零');
  ok(ELS.get('overOverlay').classList.contains('show') === false, '结束遮罩已收起');
  ok(localStorage.getItem('hold-the-bridge:best') === String(expectedBest), `最高分已写入 localStorage = ${expectedBest}`);
} catch (err) {
  failures++;
  notes.push(`  ✗ 重开流程抛异常: ${err && err.message}`);
}

// -- 8. 静音按钮 --
try {
  tap('muteBtn');
  ok(localStorage.getItem('hold-the-bridge:muted') === '1', '静音按钮已绑定并持久化');
} catch (err) {
  failures++;
  notes.push(`  ✗ 静音按钮抛异常: ${err && err.message}`);
}

// ---------------------------------------------------------

console.log(notes.join('\n'));
if (botStats) {
  console.log(
    `\n机器人表现（50ms 步长模拟）：最大波次 ${botStats.maxWave} | ` +
      `击杀 ${botStats.kills} | 分数 ${botStats.score} | 被咬 ${botStats.bites} 次 | ` +
      `最高 ${botStats.maxCombo} 连杀 | 空袭 ${botStats.strikesFired} 次 | ` +
      `词条 ${botStats.mods.join('/') || '无'} | ` +
      (botStats.diedAt === null
        ? botStats.waveLog.some((r) => r.cleared)
          ? `打完第 ${botStats.waveLog.find((r) => r.cleared).wave} 波通关（BOSS 战 ${botStats.waveLog.find((r) => r.cleared).t}s）`
          : '没被咬死（跑满 450s 没打完）'
        : `撑了 ${botStats.diedAt.toFixed(1)}s 后阵亡（剩余 ${botStats.hp} 血）`)
  );
  console.log('  每波明细：');
  for (const r of botStats.waveLog) {
    console.log(
      `    第 ${r.wave} 波  耗时 ${r.t}s  本波被咬 ${r.bites}  打完剩 ${r.hp} 血${r.died ? '  ← 死在这' : ''}${r.cleared ? '  ← 通关' : ''}`
    );
  }
  console.log('  吃到的奖励：');
  for (const r of botStats.rewardLog) {
    console.log(`    第 ${r.wave} 波途中  站${r.side}半场  →  ${r.name}（${r.id}）`);
  }
}
console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
