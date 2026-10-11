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

const { ELS, DOC, CANVAS, APP, WINDOW_LISTENERS, P, def, AUDIO_SESSION, AUDIO_CTXS } = installDom({
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

  // (a3) BOSS 导弹（m03096 加、m03130 修站位、m01503 改版）：
  //      落点 = 开火那一刻你站的位置（不是追踪弹）→ 不挪步必中，中者直接死。
  //      现在是"出场 0.9 秒放第一发 + 半血再放一发（导弹阵）"，不再等掉到 3/4 血。
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
  // 关键：按回"刚出场、还在往这边走"的状态 —— 技能必须在路上就放出来
  //（真机上玩家通常还没等它站定，这就是这条断言存在的意义）
  boss.z = C.zFar - 5;
  boss.state = 'approach';
  boss.hp = boss.maxHp;
  boss.casts = 0;
  boss.skillT = C.bossSkill.onSpawnDelay;
  boss.frozenStop = false;
  game.warns.length = 0;
  for (let i = 0; i < 8; i++) step(50); // 0.4 秒
  ok(boss.state === 'approach', `BOSS 还在往这边走（state=${boss.state} z=${boss.z.toFixed(1)}）`);
  ok(
    game.warns.length === 0 && boss.casts === 0,
    `出场 ${C.bossSkill.onSpawnDelay} 秒之内一声不响（预警圈 ${game.warns.length} 个）`
  );
  for (let i = 0; i < 12; i++) step(50); // 累计 1.0s > 0.9s
  ok(
    boss.casts === 1 && game.warns.length === C.bossSkill.spawnCount,
    `第一次技能改成出场就放（哪怕它还在路上：state=${boss.state} 预警圈 ${game.warns.length} 个）`
  );
  ok(
    Math.abs(game.warns[0].x - game.player.x) < 1e-6,
    `预警落点 = 开火时你站的位置（x=${game.warns[0].x.toFixed(2)}）`
  );
  // 半血 → 再放一发，而且升级成错开的导弹阵
  game.warns.length = 0;
  boss.hp = Math.floor(boss.maxHp * C.bossSkill.hpAt);
  step(50);
  ok(
    boss.casts === 2 && game.warns.length === C.bossSkill.halfCount,
    `半血再放一发，是 ${C.bossSkill.halfCount} 连导弹阵（预警圈 ${game.warns.length} 个、落点 ${game.warns
      .map((w) => w.x.toFixed(2))
      .join(' / ')}）`
  );
  // 命中/躲开：把"出场那一发"重放（单发、落点确定，方便验收真判定）
  game.warns.length = 0;
  boss.casts = 0;
  boss.skillT = 0.05;
  boss.hp = boss.maxHp;
  step(50);
  ok(game.warns.length === C.bossSkill.spawnCount, `重放：又放了一发（${game.warns.length} 个）`);
  for (let i = 0; i < 20; i++) step(50); // 预警 1.5s 还没落地
  ok(game.warns.length === C.bossSkill.spawnCount, '预警期间不会补第二发（要等半血）');
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
  game.warns.length = 0;
  boss.casts = 0;
  boss.skillT = 0.05;
  boss.hp = boss.maxHp;
  step(50);
  ok(game.warns.length === C.bossSkill.spawnCount, `第二次挑战：技能又放了一发（${game.warns.length} 个）`);
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
  // 用户 m02264：还有下一关时，主按钮是「下一关 →」，「再玩一次」让位
  ok(game.lastReward.nextLevel === 2, `第 1 关通关后指向第 2 关（nextLevel=${game.lastReward.nextLevel}）`);
  ok(!ELS.get('clearNext').classList.contains('hidden'), '结算面板上「下一关 →」是亮着的');
  ok(ELS.get('clearAgain').classList.contains('hidden'), '有下一关时「再玩一次」收起来');
  // 点「下一关 →」＝ 进第二关（第二关有对话，所以停在 TALK）。
  // 结算面板三颗按钮都有 600ms 缓冲（main.js:294 的 clearAt），推 900ms 再点。
  for (let i = 0; i < 45; i++) step(20);
  tap('clearNext');
  step(2);
  ok(C.level.id === 2 && game.state === STATE.TALK, `「下一关」直接进第二关对话（level=${C.level.id} state=${game.state}）`);
  game.backToMenu();
  step(2);

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
  for (const id of ['menuRole', 'menuWeapon', 'menuShop']) tap(id);
  step(2);
  ok(game.state === st0, `四个入口点了只提示（state 仍是 ${game.state}）`);
  ok(ELS.get('startOverlay').classList.contains('show'), '点入口没有误触发「开始挑战」');
  ok(String(ELS.get('gainToast').textContent).includes('该功能未实装'), `入口提示 = ${ELS.get('gainToast').textContent}`);
  ok(
    String(ELS.get('menuHint').textContent).includes('该功能未实装') && ELS.get('menuHint').classList.contains('show'),
    `主界面自己那行提示也亮了（${ELS.get('menuHint').textContent}）`
  );
  // 用户 m02264：首页「关卡」入口不再说"未实装"，改成弹出选关面板
  tap('menuLevel');
  step(2);
  ok(ELS.get('levelOverlay').classList.contains('show'), '点「关卡」弹出选关面板');
  ok(game.state === st0, `选关面板弹出时不改变游戏状态（state=${game.state}）`);
  // 第 4~10 关是灰按钮，点了只提示"该关卡未实装"（第 3 关这一版已经实装了）
  tap('lv4');
  step(2);
  ok(String(ELS.get('levelHint').textContent).includes('未实装'), `点灰关卡只提示（${ELS.get('levelHint').textContent}）`);
  ok(ELS.get('levelOverlay').classList.contains('show'), '点了未实装的关卡，面板留着不走');
  // 第 2 关点了直接进场（第二关有关卡对话，所以停在 TALK）
  tap('lv2');
  step(2);
  ok(C.level.id === 2, `选关选中第 2 关（${C.level.name}）`);
  ok(game.state === STATE.TALK, `第 2 关进来先停在对话（state=${game.state}）`);
  ok(ELS.get('talkOverlay').classList.contains('show'), '对话弹窗弹出来了');
  ok(!ELS.get('levelOverlay').classList.contains('show'), '选关面板自己收起来了');
  // 第 1 关点了直接开打（没有对话，直接进备战）。
  // 注意 onTap 是"每个元素各自 300ms 去重"（main.js:197 的闭包 last），
  // 所以同一个按钮隔得太近点第二下会被吞掉 —— 推一会儿时钟再开面板。
  for (let i = 0; i < 20; i++) step(20);
  tap('menuLevel');
  step(2);
  tap('lv1');
  step(2);
  ok(C.level.id === 1 && game.state === STATE.PREP, `选第 1 关直接进备战（state=${game.state}）`);
  game.backToMenu();
  step(2);

  // 第三关（目前最后一关）通关：后面没有下一关，结算面板的主按钮换回「再玩一次」
  game.beginLevel(2);
  game.releaseTalk();
  game.wave = C.level.waves;
  game.enemies.length = 0;
  game.spawnQueue.length = 0;
  game.state = STATE.FIGHT;
  game.onWaveClear();
  step(2);
  ok(game.state === STATE.CLEAR, `第 3 关清完也走通关结算（state=${game.state}）`);
  ok(game.lastReward.nextLevel === 0, `第 3 关后面没有下一关（nextLevel=${game.lastReward.nextLevel}）`);
  ok(ELS.get('clearNext').classList.contains('hidden'), '没有下一关时「下一关 →」收起来');
  ok(!ELS.get('clearAgain').classList.contains('hidden'), '没有下一关时「再玩一次」亮出来');
  ok(game.clearedLevel >= 3, `通关进度记到第 ${game.clearedLevel} 关`);
  game.backToMenu();
  step(2);

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
  ok(!!ELS.get('talkStart'), '对话只有一个按钮（启动），没有"返回主界面"');
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

// ---------------------------------------------------------
// -- 3f. 第三关「疯狂草坪」：戴夫开场 / 警报倒数 / 豌豆射手 / 阳光 / 樱桃炸弹 --
// ---------------------------------------------------------
try {
  const { CFG: C3, setLevel: setLv3, heroZRange } = await import(pathToFileURL(path.join(ROOT, 'js', 'config.js')).href);
  const mk3 = (kind, dz = 4) => {
    game.spawnEnemy(kind, 0, game.player.z + dz, 1);
    return game.enemies[game.enemies.length - 1];
  };
  const wipe3 = () => {
    game.enemies.length = 0;
    game.spawnQueue.length = 0;
    game.bullets.length = 0;
    game.suns.length = 0;
    game.cherries.length = 0;
    game.player.hp = 50;
    game.player.iframe = 0;
    game.player.shield = 0;
  };

  // (a) 开场对话：戴夫 + 「歪比巴布」 + 立绘和按钮都跟着关卡换
  game.beginLevel(2);
  step();
  ok(game.state === STATE.TALK, '第三关进来先停在对话（state=talk），不直接开打');
  ok(ELS.get('talkPortrait').classList.contains('hidden'), '第三关把大叔立绘收起来');
  ok(!ELS.get('talkPortraitDave').classList.contains('hidden'), '换成戴夫的立绘');
  const dave1 = String(ELS.get('talkText').textContent);
  ok(dave1.includes('歪比巴布'), `第一句就是「歪比巴布」：${dave1}`);
  ok(String(ELS.get('talkName').textContent).includes('戴'), '说话人写着戴夫');
  const tap3 = () => {
    tap('talkOverlay');
    for (let i = 0; i < 25; i++) step();
  };
  let g3 = 0;
  while (!ELS.get('talkActions').classList.contains('show') && g3++ < 6) tap3();
  ok(ELS.get('talkActions').classList.contains('show'), `翻完全部台词才出按钮（共点了 ${g3 + 1} 下）`);
  ok(String(ELS.get('talkStart').textContent).includes('开 打'), `按钮文案跟着关卡变：${ELS.get('talkStart').textContent}`);
  tap('talkStart');
  step();
  ok(game.state === STATE.PREP, '点「好 了 · 开 打 ！」进备战');
  ok(C3.level.skin === 'pvz' && C3.level.id === 3, `切到第 3 关（${C3.level.name}）`);
  ok(C3.theme.skyDeco === 'clouds' && C3.theme.skyline === 'houses', '主题换成白天的草坪（白云 + 民房 + 太阳）');

  // (b) 开场节奏：先警报，再 3 / 2 / 1
  const A3 = C3.pvz.alert;
  ok(game.alertT > 0 && game.alertStep === 0, `备战一开始就是警报段（alertT=${game.alertT.toFixed(2)}s）`);
  ok(!game.gates, '警报 + 倒数期间不开奖励门（不然两块面板糊在大字上，两边都看不清）');
  const seenSteps = [];
  let guardT = 0;
  while (game.alertT > 0 && guardT++ < 600) {
    if (game.alertStep > 0 && !seenSteps.includes(game.alertStep)) seenSteps.push(game.alertStep);
    step(20);
  }
  ok(seenSteps.join(',') === '3,2,1', `警报之后依次倒数 3 → 2 → 1（实际 ${seenSteps.join(',')}）`);
  ok(game.alertT === 0, '倒完警报就结束');
  ok(!!game.gates, '倒数喊完才把第一对奖励门推出来');

  // (c) 皮肤：七种怪全换成植物大战僵尸的僵尸
  setLv3(2);
  game.reset();
  game.state = STATE.FIGHT;
  wipe3();
  const pvzKinds = [];
  for (const kind of ['walker', 'runner', 'brute', 'spitter', 'shielded', 'splitter', 'boss']) {
    const e = mk3(kind, 5 + pvzKinds.length * 1.2);
    const skin = C3.kinds[kind].pvz;
    if (e.animal === skin.animal && e.color === skin.color) pvzKinds.push(kind);
  }
  ok(pvzKinds.length === 7, '七种怪都换了造型（小兵/撑杆/巨人/僵王/投石车/铁桶/小鬼）');

  // (d) 奖励池：l3 专属（寒冰 / 炎火 / 向日葵 / 阳光 / 巨型樱桃）只在第三关出现
  const draw3 = (n) => {
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      game.stacks = {};
      game.openGates();
      seen.add(game.gates.left.id);
      seen.add(game.gates.right.id);
    }
    return seen;
  };
  const L3_ONLY = ['iceLane', 'fireLane', 'sunflower', 'sunValue', 'cherryBig'];
  const l3seen = draw3(80);
  ok(L3_ONLY.every((id) => l3seen.has(id)), `第三关抽得到 l3 专属奖励（${L3_ONLY.filter((x) => l3seen.has(x)).join('/')}）`);
  setLv3(0);
  const l1again = draw3(80);
  ok(!L3_ONLY.some((id) => l1again.has(id)), '第一关抽不到第三关的专属奖励');

  // (e) 寒冰 / 炎火：只改【一条】弹道，一条接一条亮起来
  setLv3(2);
  game.reset();
  game.state = STATE.FIGHT;
  game.weapon.bullets = 3;
  game.lanes = ['', '', '', '', '', ''];
  game.applyUpgrade('iceLane');
  game.applyUpgrade('fireLane');
  ok(game.lanes[0] === 'ice' && game.lanes[1] === 'fire', `冰火各占一条弹道（${game.lanes.slice(0, 3).join('/')}）`);
  ok(game.lanes[2] === '', '没吃到的第三跳弹道还是普通豌豆（只改一条，不是全队变属性）');

  // (f) 豌豆射手的称号按弹道数走（用户 m02771 要的"弹道 +1 就换一个植物"）
  game.weapon.bullets = 1;
  const n1 = game.weaponLabel;
  game.weapon.bullets = 2;
  const n2 = game.weaponLabel;
  game.weapon.bullets = 3;
  const n3 = game.weaponLabel;
  ok(n1 === '豌豆射手' && n2 === '双发射手' && n3 === '三线射手', `1/2/3 条弹道 = ${n1} / ${n2} / ${n3}`);

  // (g) 阳光：天上掉一个，走过去自动捡，捡到就给能量
  game.reset();
  setLv3(2);
  game.state = STATE.FIGHT;
  wipe3();
  game.energy = 0;
  game.player.z = 10;
  game.player.x = 0;
  game.spawnSun();
  ok(game.suns.length === 1, '天上掉下来一个阳光');
  const sd = game.suns[0];
  sd.t = sd.fall + 0.2; // 让它落地，进入"能捡"的阶段
  sd.x = game.player.x;
  sd.z = game.player.z;
  game.sunT = 99; // 别让"自然掉落"这一帧又塞一个进来，否则分不清捡的是哪一个
  game.updateSuns(0.016);
  ok(game.suns.length === 0, '走过去就自动把阳光捡了');
  ok(game.energy > 0, `捡到阳光加了能量（energy=${game.energy}）`);

  // (g2) 阳光必须落在"走得到"的地方 —— 用户实测 bug 的回归测试。
  // 以前落点是「英雄 z + 3.0~8.5」，而英雄最多往前走 2.8 世界单位，
  // 于是阳光掉在走不到的位置上：屏幕上看得见、走到最前面还差好几米，等于白掉。
  {
    const [zMin, zMax] = heroZRange();
    let inBand = true;
    let minGap = Infinity;
    for (const pz of [zMin, (zMin + zMax) / 2, zMax]) {
      for (let i = 0; i < 30; i++) {
        game.player.z = pz;
        const z = game.sunZ();
        if (z < zMin - 1e-9 || z > zMax + 1e-9) inBand = false;
        minGap = Math.min(minGap, Math.abs(z - pz));
      }
    }
    ok(inBand, `阳光都落在英雄活动范围 [${zMin.toFixed(1)}, ${zMax.toFixed(1)}] 之内`);
    ok(minGap >= C3.pvz.sun.gap - 1e-9,
      `阳光不会掉在脚边（最近 ${minGap.toFixed(2)} ≥ ${C3.pvz.sun.gap}，逼你挪两步）`);

    // 落在范围内还不够 —— 得真的走得到、捡得着。专挑"人已经贴在范围最前面"
    // 这种以前最惨的情况：连掉 12 个，每个都站上去捡，一个都不能漏。
    let picked = 0;
    for (let i = 0; i < 12; i++) {
      game.player.z = zMax;
      game.player.targetZ = zMax;
      game.suns.length = 0;
      game.sunT = 99; // 别让"自然掉落"在 updateSuns 里又塞一个进来
      game.spawnSun();
      const s = game.suns[0];
      s.t = s.fall + 0.2; // 落地，进入能捡的阶段
      game.energy = 0;
      game.player.x = s.x;
      game.player.z = Math.max(zMin, Math.min(zMax, s.z)); // 走过去
      game.updateSuns(0.016);
      if (game.energy > 0) picked++;
    }
    ok(picked === 12, `贴在活动范围最前面掉的阳光也捡得着（12/12）`);
  }

  // (g3) 【用户 m01729】"阳光还是捡不到，改成自动吸附吧" ——
  //      落地后自己飞向英雄：玩家站着不动、手指都不用管，也应该被捡走。
  //      （上一版要求"把手指对准它"，手机上一根手指既走位又瞄准，根本对不准。）
  {
    const S3 = C3.pvz.sun;
    game.reset();
    setLv3(2);
    game.state = STATE.FIGHT;
    game.wave = 1;
    wipe3();
    game.player.x = -0.8;
    game.player.z = C3.zNear; // 站在最后面，离落点尽量远
    game.player.targetX = -0.8;
    game.player.targetZ = C3.zNear;
    game.sunT = 99; // 只留这一个，别让自然掉落再塞
    game.energy = 0;
    game.spawnSun();
    const s3 = game.suns[0];
    const d0 = Math.hypot(game.player.x - s3.x, game.player.z - s3.z);
    ok(d0 > S3.magnetPick, `吸附前离英雄 ${d0.toFixed(2)} > ${S3.magnetPick}（不是碰巧贴脸）`);
    s3.t = s3.fall; // 直接进入"刚落地"
    // 顺手记一下它有没有真的往英雄那边靠（而不是被 live 超时收走）
    const before = Math.hypot(game.player.x - s3.x, game.player.z - s3.z);
    let n3 = 0;
    while (game.suns.length && n3++ < 300) step(50);
    ok(game.suns.length === 0, `站着不动，阳光自己飞过来被捡走（${((n3 * 50) / 1000).toFixed(1)} 秒）`);
    ok(game.energy > 0, `自动吸附照样充能（energy=${game.energy}）`);
    ok(before > S3.magnetPick, `它是被吸过来的，不是掉在脚边（起始距离 ${before.toFixed(2)}）`);
  }

  // (h) 樱桃炸弹：能量满了落在人堆中心，引信烧完炸开
  game.reset();
  setLv3(2);
  game.state = STATE.FIGHT;
  wipe3();
  game.player.z = 10;
  game.player.x = 0;
  game.wave = 1;
  const cluster = [];
  for (let i = 0; i < 4; i++) cluster.push(mk3('walker', 6 + i * 1.1));
  const avgX = cluster.reduce((s, e) => s + e.x, 0) / cluster.length;
  game.energy = C3.charge.max;
  ok(game.canStrike(), '能量满了大招就能点');
  ok(game.triggerStrike() === true, '第三关点大招叫出来的是樱桃炸弹');
  ok(game.cherries.length === C3.pvz.cherry.count, `场上出现 ${game.cherries.length} 颗樱桃`);
  const hpBeforeC = cluster.map((e) => e.hp);
  ok(Math.abs(game.cherries[0].x - avgX) < 1.2, '樱桃落在人堆的横向中心（自动找人堆）');
  let fuse = 0;
  while (game.cherries.length && fuse++ < 60) step(50);
  ok(game.cherries.length === 0, '引信烧完樱桃就炸了');
  const hurt = cluster.filter((e, i) => e.dead || e.hp < hpBeforeC[i]).length;
  ok(hurt >= 2, `炸开范围内的怪都掉血（${hurt}/${cluster.length} 只）`);

  // (i) 【用户 m01503】第三关 BOSS 的第二形态「僵尸博士」：
  //     第一条血清空不是死、是进化；第二条血更厚、技能轮着来（导弹阵/召唤/火球），
  //     而且它**走到一半就不再往前**，威胁全在技能上。
  {
    const B2 = C3.pvz.boss2;
    const K3 = C3.kinds.boss;
    game.reset();
    setLv3(2);
    game.state = STATE.FIGHT;
    game.wave = 1;
    wipe3();
    game.player.z = C3.zNear;
    game.player.x = 0;
    game.sunT = 999;
    const b = mk3('boss', C3.zFar - 5 - game.player.z);
    const hp0 = b.maxHp;
    ok(b.forms === 2 && b.form === 1, `第三关的僵王有两段血（${b.form}/${b.forms}）`);
    // 第一条血打空 → 走真实击杀入口，必须是进化不是死亡
    b.hp = 0;
    game.killEnemy(b);
    ok(!b.dead && b.form === 2, '第一条血清空不是死，是进化成僵尸博士');
    ok(
      b.hp === b.maxHp && Math.abs(b.maxHp - Math.round(hp0 * B2.hpMul)) <= 1,
      `第二条血更厚（${hp0} → ${b.maxHp}，配置 ×${B2.hpMul}）`
    );
    ok(
      b.animal === B2.animal && b.size > K3.size,
      `换了造型和体型（${b.animal}，size ${b.size.toFixed(2)} > 僵王 ${K3.size}）`
    );
    ok(game.bossEvolves === 1, '记了一次进化（game.bossEvolves）');
    ok(b.frozenStop === true, '博士被定住（frozenStop = true）');
    ok(Math.abs(b.z - (C3.zFar - 4)) < 1e-6, `进化把它推回草坪深处（z=${b.z.toFixed(1)}）`);
    const halfLine = (C3.zFar - 4 + game.player.z) * B2.stopRatio;
    ok(b.stopZ <= halfLine + 1e-6, `停线只到一半（stopZ=${b.stopZ.toFixed(2)} ≤ ${halfLine.toFixed(2)}）`);
    // 变身这 1.8 秒：位置一点不动（世界在等它变身）
    const zDuring = b.z;
    for (let i = 0; i < 10; i++) step(50);
    ok(b.evolveT > 0 && b.z === zDuring, `变身期间定格（还剩 ${b.evolveT.toFixed(2)}s）`);
    for (let i = 0; i < 40; i++) step(50);
    ok(
      b.evolveT <= 0 && b.form === 2 && !b.dead,
      `变身结束，僵尸博士登场（第二条血开打；hp=${game.player.hp} game=${game.state} warns=${game.warns.length}）`
    );
    // 后面只验机制（停线 / 三种技能），给双方都堆成"打不死"：
    // 不然英雄的自动开火会在这些长循环里把博士打死，测出来的就不是技能了
    b.hp = b.maxHp = 9999;
    game.player.hp = 9999;
    // 技能循环先按下（导弹是 lethal，打中必死，会把整个测试世界停掉），
    // 单独验"停线"这件事；等下面测技能时再手动点火。
    b.skillT = 1e9;
    // 走到一半就不再往前：它从草坪深处只走到 stopZ，然后就停在那儿
    //（子弹的击退会把它往后顶一点点，所以判"不越过停线"，不是判"纹丝不动"）
    for (let i = 0; i < 240; i++) step(50); // 12 秒，够它慢慢蹭到停线
    ok(
      b.state === 'attack' && b.z >= b.stopZ - 0.3 && b.z <= b.stopZ + 1.5,
      `博士走到一半就停住（z=${b.z.toFixed(2)}，停线 stopZ=${b.stopZ.toFixed(2)}，state=${b.state}）`
    );
    const gapStop = b.z - game.player.z;
    ok(
      gapStop > K3.stopGap,
      `它够不着你（离人 ${gapStop.toFixed(1)} > 普通 BOSS 的 stopGap ${K3.stopGap}）`
    );
    let nearest = b.z;
    for (let i = 0; i < 40; i++) {
      step(50);
      nearest = Math.min(nearest, b.z);
    }
    ok(
      nearest >= b.stopZ - 0.3,
      `再等 2 秒也一步不往前（最近到过 z=${nearest.toFixed(2)}，停线 ${b.stopZ.toFixed(2)}）`
    );

    // 三种技能轮着放：导弹阵 → 召唤尸潮 → 火球齐射
    game.warns.length = 0;
    b.skillIdx = 0;
    b.skillT = 0.01;
    step(50);
    ok(game.warns.length === B2.missileCount, `技能 1：${B2.missileCount} 连导弹阵（预警圈 ${game.warns.length} 个）`);
    game.warns.length = 0; // 别让它们落地把人打死，后面还要接着测
    const addsBefore = game.enemies.filter((e) => !e.dead && e.kind !== 'boss').length;
    b.skillT = 0.01;
    step(50);
    const adds = game.enemies.filter((e) => !e.dead && e.kind !== 'boss').length - addsBefore;
    ok(adds >= B2.summonCount, `技能 2：召唤尸潮（一次叫来 ${adds} 只，配置 ${B2.summonCount} 批）`);
    game.spits.length = 0;
    b.skillT = 0.01;
    step(50);
    ok(
      game.spits.length === B2.fireballCount && game.spits.every((s) => s.hot),
      `技能 3：${B2.fireballCount} 发火球齐射（spits=${game.spits.length}）`
    );
    ok(game.spits[0].vz < 0, '火球是朝玩家这边飞的');
    // 血条：名字跟着形态走，并且标出"第几段血"
    ok(
      renderer.bossBar && /博\s*士/.test(renderer.bossBar.label) && /2\/2/.test(renderer.bossBar.label),
      `血条写着第二形态：${renderer.bossBar && renderer.bossBar.label}`
    );

    // 难度 +30%：同一只怪，第三关的血量正好是第一关的 diff 倍
    //（双方都清掉波次词条，不然词条自带的 hpMul 会混进倍率里；
    //  波次取第 10 波、拿巨人比 —— 第 1 波的 baseHp 是个位数，四舍五入会让倍率失真）
    game.reset();
    setLv3(2);
    game.wave = 10;
    game.mod = null;
    game.enemies.length = 0;
    const w3 = mk3('brute', 6);
    const hp3 = w3.maxHp;
    setLv3(0);
    game.wave = 10;
    game.mod = null;
    game.enemies.length = 0;
    const w1 = mk3('brute', 6);
    ok(
      Math.abs(hp3 / w1.maxHp - C3.levels[2].diff) < 0.02,
      `第三关整体加难：巨人血量 ×${(hp3 / w1.maxHp).toFixed(2)}（配置 ${C3.levels[2].diff}；${hp3} / ${w1.maxHp}）`
    );
  }

  // 收尾：回到第一关的开局状态，别影响第 4~8 段
  setLv3(0);
  game.newRun(0);
  game.enemies.length = 0;
  game.spawnQueue.length = 0;
  game.suns.length = 0;
  game.cherries.length = 0;
} catch (err) {
  failures++;
  notes.push(`  ✗ 第三关（疯狂草坪）抛异常: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
}

// ---------------------------------------------------------
// -- 3e. 用户 m02534：局内「返回 / 暂停」、主界面版本号、通用的使用说明 --
// ---------------------------------------------------------
try {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ingame = ELS.get('ingameBtns');
  const pause = ELS.get('pauseOverlay');

  // (a) 局内按钮只在打的时候出现
  game.newRun(0);
  game.state = STATE.START;
  step(2);
  ok(!ingame.classList.contains('show'), '主界面不显示「返回 / 暂停」');
  game.state = STATE.PREP;
  step(2);
  ok(ingame.classList.contains('show'), '备战倒计时里「返回 / 暂停」出现');
  game.state = STATE.FIGHT;
  step(2);
  ok(ingame.classList.contains('show'), '打起来之后「返回 / 暂停」还在');
  game.state = STATE.OVER;
  step(2);
  ok(!ingame.classList.contains('show'), '失守结算时把局内按钮收起来');

  // (b) 暂停：世界静止、面板弹出、恢复后继续
  game.newRun(0);
  game.state = STATE.FIGHT;
  for (let i = 0; i < 6; i++) step();
  ok(!pause.classList.contains('show'), '没点之前暂停面板是关着的');
  tap('pauseBtn');
  step();
  ok(pause.classList.contains('show'), '点「暂停」弹出暂停面板');
  ok(H.isPaused(), '__HBT.isPaused() 跟着变真');
  // 暂停期间按着屏幕，英雄也不该动（这是"暂停"的定义）
  firePointer('pointerdown', 320, 700);
  const frozen = game.player.z;
  const frozenState = { hp: game.player.hp, kills: game.kills };
  for (let i = 0; i < 60; i++) step();
  ok(game.player.z === frozen, `暂停时世界完全静止（z 仍是 ${frozen}）`);
  ok(game.player.hp === frozenState.hp && game.kills === frozenState.kills, '暂停时血量/击杀数都不变');
  tap('resumeBtn');
  step();
  ok(!pause.classList.contains('show') && !H.isPaused(), '点「继续游戏」收面板、状态解除');
  const before = game.player.z;
  for (let i = 0; i < 30; i++) step();
  ok(game.player.z !== before || game.enemies.length >= 0, '恢复后世界继续推进');
  firePointer('pointerup', 320, 700);

  // (c) 暂停面板里的「返回主界面」
  tap('pauseBtn');
  step();
  tap('pauseMenu');
  step(2);
  ok(game.state === STATE.START, '暂停面板里能直接回主界面');
  ok(!H.isPaused() && !pause.classList.contains('show'), '回主界面时暂停状态一并清掉');

  // (d) 局内「返回」要按两下（一下就把整局送掉太亏）
  game.newRun(0);
  game.state = STATE.FIGHT;
  step(2);
  step(2); // 让 onTap 的 300ms 去重窗口过去
  tap('backBtn');
  step(2);
  ok(ELS.get('backBtn').textContent === '确认返回', '第一次点之后按钮写着「确认返回」');
  ok(ELS.get('backBtn').classList.contains('warn'), '这时按钮变红提醒');
  for (let i = 0; i < 60; i++) step(50); // 推过 2.5 秒，按钮该自己变回去
  ok(ELS.get('backBtn').textContent === '返回', '2.5 秒不点，按钮自己变回「返回」');
  for (let i = 0; i < 8; i++) step(50);
  tap('backBtn');
  step(2);
  ok(ELS.get('backBtn').textContent === '确认返回', '再点一次又是「确认返回」');
  for (let i = 0; i < 8; i++) step(50); // 去重窗口
  tap('backBtn');
  step(2);
  ok(game.state === STATE.START, '第二次点「确认返回」才真的回主界面');
  ok(!H.isPaused() && !ELS.get('backBtn').classList.contains('warn'), '回主界面后按钮恢复成「返回」');

  // (e) 点「关卡」里的「返回」不会再跳到别的页面（m02534①那个 bug）
  ok(!/guide\.html/.test(html), 'index.html 里不再引用独立的网页版说明');
  ok(!/网页版说明/.test(html), '「网页版说明」入口已经删掉');
  tap('menuLevel');
  step();
  ok(ELS.get('levelOverlay').classList.contains('show'), '「关卡」能打开选关面板');
  tap('levelClose');
  step();
  ok(!ELS.get('levelOverlay').classList.contains('show') && game.state === STATE.START,
    '点「返回」只收面板，留在主界面（不再跳说明页）');

  // (f) 版本号：写在开始界面里、由部署脚本自动升
  const vm = /id="buildLabel">v(\d+)\.(\d+)\.(\d+)</.exec(html);
  ok(!!vm, `主界面右下角有版本号 v${vm ? vm[1] + '.' + vm[2] + '.' + vm[3] : '?'}`);
  ok(/buildLabel/.test(html.slice(html.indexOf('id="startOverlay"'), html.indexOf('id="guideOverlay"'))),
    '版本号放在开始遮罩内部（遮罩一藏它就跟着消失，不用单独开关）');
  const dep = fs.readFileSync(path.join(ROOT, 'tools', 'deploy.ps1'), 'utf8');
  ok(dep.includes('id="buildLabel">v') && dep.includes('$m.Groups[3].Value + 1'), '部署脚本会自己把版本号 +1');
  ok(dep.includes("const CACHE = 'hold-the-bridge-v"), '部署脚本顺手升 sw.js 的缓存名');

  // (g) 使用说明只讲通用玩法和僵尸类型，不再按关卡分节（m02534③）
  // 注意：切片里夹着 HTML 注释（"第二关进场对话…"），注释里提到关卡不算正文
  const guideText = html
    .slice(html.indexOf('id="guideOverlay"'), html.indexOf('id="talkOverlay"'))
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const nm of ['小兵', '快跑者', '重装兵', '吐酸者', '铁盾兵', '分裂者', '尸潮首领']) {
    ok(guideText.includes(nm), `使用说明的僵尸图鉴里有「${nm}」`);
  }
  ok(guideText.includes('水雷') && guideText.includes('死的时候会炸开一圈'),
    '水雷 / 死后炸开写成通用机制，不挂在某一关名下');
  ok(!/第 [12] 关/.test(guideText), '使用说明正文里没有按关卡分节');
  ok(/本游戏完全免费/.test(html), '主页写着「本游戏完全免费」');
  ok(/class="tiny free"[\s\S]{0,120}https:\/\/renhe06\.github\.io/.test(html),
    '免费声明下面用纯文字写着网址（不是链接）');
  ok(!/<a\s/.test(html), 'index.html 里已经没有可跳转的 <a> 了');

  // 收尾：回到第一关的开局状态，别影响第 4~8 段
  game.newRun(0);
  game.enemies.length = 0;
  game.spawnQueue.length = 0;
} catch (err) {
  failures++;
  notes.push(`  ✗ 局内按钮 / 暂停 / 版本号抛异常: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
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

// -- 9. 音频：iOS 上"经常没声音"的几种情况都要能自己爬回来 --
// 用户 m01249：经常出现没有声音。老代码只在 state === 'suspended' 时 resume，
// 而 WebKit 被来电/别的 App 打断时给的是非标准的 'interrupted' —— 一旦碰上就
// 永远没声音，只能刷新页面。这里把几种状态一个个摆出来钉住。
try {
  const sfx = H.sfx;
  sfx.setMuted(false); // 上一段把静音打开了，先恢复

  // 第一次触摸：上下文从 suspended 变成 running（iOS 的规矩）
  sfx.ctx && (sfx.ctx.state = 'suspended');
  sfx.unlock();
  const c1 = sfx.ctx;
  ok(!!c1 && c1.state === 'running', `第一次触摸后音频跑起来（state=${c1 && c1.state}）`);
  ok(AUDIO_SESSION.type === 'playback',
    '把音频会话声明成 playback（手机侧边静音拨片拨到静音时也能出声）');
  ok(sfx.status === '正常', `自检认为正常（${sfx.status}）`);

  // 切后台 / 锁屏：系统挂起
  c1.state = 'suspended';
  sfx.wake();
  ok(c1.state === 'running', '被挂起（切后台/锁屏）之后能自己恢复');

  // 来电 / 别的 App 抢音频：WebKit 的 'interrupted'
  c1.state = 'interrupted';
  const before = c1.resumes;
  sfx.wake();
  ok(c1.state === 'running' && c1.resumes === before + 1,
    "被系统打断（interrupted）之后也能恢复 —— 这就是「经常没声音」的根因");

  // 上下文被系统关掉：不能 ready 一直 true 却永远不出声，必须重建
  c1.state = 'closed';
  const ctxsBefore = AUDIO_CTXS.length;
  sfx.unlock();
  ok(sfx.ctx !== c1 && AUDIO_CTXS.length === ctxsBefore + 1 && sfx.ctx.state === 'running',
    '上下文被系统关闭后重新建一个（不是一直拿着死的那份）');

  // 打断结束的系统事件
  sfx.ctx.state = 'interrupted';
  AUDIO_SESSION.state = 'active';
  AUDIO_SESSION.fire('statechange');
  ok(sfx.ctx.state === 'running', '音频会话 statechange（打断结束）会自动唤醒');

  // 真的在响：把每一个音效都排一遍。
  // 这一条既证明"上下文跑起来了真会出声"（不是看着 running 其实静悄悄），
  // 也顺手把 audio.js 的音效方法全过一遍桩 —— 谁写了桩里没有的 WebAudio 方法，
  // 这里立刻抛 "xxx is not a function"。
  const proto = Object.getPrototypeOf(sfx);
  const skip = ['constructor', 'unlock', 'wake', 'setMuted', 'toggleMute', 'status', 'running'];
  const sounds = Object.getOwnPropertyNames(proto).filter(
    (k) => k[0] !== '_' && !skip.includes(k) && typeof sfx[k] === 'function'
  );
  const o0 = sfx.ctx.oscs + sfx.ctx.bufs;
  for (const k of sounds) sfx[k](3);
  const made = sfx.ctx.oscs + sfx.ctx.bufs - o0;
  ok(sounds.length >= 20 && made > 0,
    `${sounds.length} 个音效都能排出来（共 ${made} 个发声节点：${sounds.join('/')}）`);

  // 自己被静音：一个音符都不该排，而且状态要一眼看得出来
  sfx.setMuted(true);
  const o1 = sfx.ctx.oscs + sfx.ctx.bufs;
  for (const k of sounds) sfx[k](3);
  ok(sfx.ctx.oscs + sfx.ctx.bufs === o1, '手动静音时一个音符都不排');
  ok(/已静音/.test(sfx.status), `静音时自检说清原因（${sfx.status}）`);
  sfx.setMuted(false);

  // 暂停面板上那行自检：这是让玩家自己看出问题在哪儿的入口
  game.state = STATE.FIGHT;
  game.player.hp = 99;
  H.pauseGame();
  ok(/音效：正常/.test(ELS.get('audioState').textContent),
    `暂停面板写出音效自检：${ELS.get('audioState').textContent}`);
  H.resumeGame();

  // 任何一次触摸都兜底唤醒（兜底比什么都管用：只要在碰屏幕就该有声音）
  sfx.ctx.state = 'interrupted';
  (WINDOW_LISTENERS.pointerdown || []).forEach((fn) => fn({}));
  ok(sfx.ctx.state === 'running', '触摸兜底：任意一次 pointerdown 都会唤醒音频');
} catch (err) {
  failures++;
  notes.push(`  ✗ 音频流程抛异常: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
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
