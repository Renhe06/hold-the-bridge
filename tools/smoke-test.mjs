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

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 固定随机源：升级三选一、出怪位置、暴击都走 Math.random，
// 种死之后"调参前 / 调参后"的机器人成绩才是可比的。
// 加 --smart 则换一种会挑升级的机器人，用来验证"认真玩能不能打深"——
// 如果连会挑升级的玩家都卡在第 6 波，那是数值经济坏了，不是玩家菜。
const SMART = process.argv.includes('--smart');
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
Math.random = makeRng(20240613);

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

// -- 2. 点开始 --
try {
  // 开始界面底部挂了一个「使用说明」链接。遮罩整体是"按下即开局"的，
  // 如果 onTap 不把链接放行，preventDefault 会把跳转吞掉 —— 这里锁住这个行为。
  tap('startOverlay', { target: { closest: (s) => (s === 'a' ? {} : null) } });
  step();
  ok(game.state === STATE.START, '点在「使用说明」链接上不会顺手开局（点击让给浏览器）');

  tap('startOverlay');
  step();
  ok(game.state === STATE.PREP, `点开始后进入备战（当前 ${game.state}）`);
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
{
  const origBite = game.bite.bind(game);
  game.bite = (e) => { bites++; origBite(e); };
}
try {
  let held = false;
  let frames = 0;
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

// ---------------------------------------------------------
// -- 3b. v3 新系统逐个点名（连杀 / 空袭 / 三种新怪 / 五种词条）--
//  上面那段是"放任机器人打"，能覆盖到多少取决于它活多久；
//  这一段用直接调用 + 真实输入通道，把每个新系统单独按一遍。
// ---------------------------------------------------------
try {
  const { CFG, UPGRADES: UPS } = await import(pathToFileURL(path.join(ROOT, 'js', 'config.js')).href);
  game.state = STATE.FIGHT;
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

  // (b) 被咬一口断连杀
  const hp0 = game.player.hp;
  game.bite({ x: game.player.x, z: game.player.z });
  ok(game.combo === 0 && game.comboT === 0, '被咬断连杀');
  ok(game.player.hp === hp0 - 1, `被咬掉 1 血（${hp0}→${game.player.hp}）`);
  game.player.iframe = 0;
  game.player.hp = 50;

  // (c) 分裂者：死后原地裂成两只
  const nBefore = game.enemies.length;
  const sp = mk('splitter');
  ok(sp.split === CFG.kinds.splitter.split, `分裂者 split=${sp.split}`);
  game.killEnemy(sp);
  ok(game.enemies.length >= nBefore + 2, `分裂者死后裂出 ${game.enemies.length - nBefore} 只（含它自己那具）`);

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
  ok(game.energy === 0 && game.strikes.length === CFG.strike.count, `能量清零、${game.strikes.length} 发炮弹在空中`);
  const zs = game.strikes.map((s) => s.z);
  ok(Math.min(...zs) < game.player.z + 3, `最后一发落在桥头附近（最近 ${Math.min(...zs).toFixed(1)}，最远 ${Math.max(...zs).toFixed(1)}）`);
  const aliveBefore = game.enemies.filter((e) => !e.dead).length;
  for (let i = 0; i < 60; i++) { game.updateStrikes(0.05); game.updateEnemies(0.05); }
  ok(game.strikes.length === 0, '炮弹全部落地');
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
      (botStats.diedAt === null ? '没被咬死' : `撑了 ${botStats.diedAt.toFixed(1)}s 后阵亡（剩余 ${botStats.hp} 血）`)
  );
  console.log('  每波明细：');
  for (const r of botStats.waveLog) {
    console.log(
      `    第 ${r.wave} 波  耗时 ${r.t}s  本波被咬 ${r.bites}  打完剩 ${r.hp} 血${r.died ? '  ← 死在这' : ''}`
    );
  }
  console.log('  吃到的奖励：');
  for (const r of botStats.rewardLog) {
    console.log(`    第 ${r.wave} 波途中  站${r.side}半场  →  ${r.name}（${r.id}）`);
  }
}
console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
