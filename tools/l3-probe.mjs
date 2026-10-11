// ---------------------------------------------------------
//  关卡试玩机器人：让"会闪避的机器人"从头打到通（或被打死），
//  用来量"难度调完到底还能不能打" —— 冒烟测试只验机制，验不了手感。
//
//  用法：node tools/l3-probe.mjs [关卡号=3] [分钟上限=7] [随机种子=20261011]
//  例子：node tools/l3-probe.mjs 3 8     第三关打 8 分钟
//
//  跑法跟 smoke-test.mjs 保持一致：50ms 一步、定种 RNG，
//  所以"同一条难度曲线"前后两次的成绩是可以对照的。
// ---------------------------------------------------------
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDom } from './dom-stub.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEVEL = Math.max(1, Math.min(10, +(process.argv[2] || 3)));
const MINUTES = Math.max(1, Math.min(30, +(process.argv[3] || 7)));

// 定种 RNG：同一关 + 同一种子每次跑出来的成绩可比。换第 4 个参数就能抽样 ——
// 单看一个种子会被"蝴蝶效应"带偏（改一点点出怪数，后面的奖励抽取全跟着变）。
let seed = (+(process.argv[4] || 20261011)) >>> 0;
const SEED = seed;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { CANVAS, P } = installDom({ width: 390, height: 844, dpr: 3 });
await import(pathToFileURL(path.join(ROOT, 'js', 'main.js')).href);
const H = globalThis.__HBT;
const { game, renderer, cam, STATE } = H;
const { CFG } = await import(pathToFileURL(path.join(ROOT, 'js', 'config.js')).href);
const lv = CFG.levels[LEVEL - 1];

let clock = 0;
function step(dtMs = 16.7) {
  clock += dtMs;
  P.now += dtMs;
  H.frame(clock);
}
function firePointer(type, sx, sy = 500, pid = 1) {
  CANVAS.dispatch(type, {
    preventDefault() {}, stopPropagation() {}, clientX: sx, clientY: sy, pointerId: pid,
  });
}

// ---- 机器人的站位选择：跟 smoke-test 里那套一致 ----
const PICK_ORDER = [
  'damage', 'rateMul', 'bullets', 'pierce', 'crit', 'critMul', 'splash', 'burn',
  'ice', 'pulse', 'bulletSpeedMul', 'maxHp', 'shieldPerWave', 'moveMul', 'heal', 'dropChance',
];
function botTargetX() {
  if (game.gates) {
    const rank = (u) => { const i = PICK_ORDER.indexOf(u.id); return i < 0 ? 99 : i; };
    const wantLeft = rank(game.gates.left) <= rank(game.gates.right);
    return (wantLeft ? -1 : 1) * cam.roadHalf * 0.5;
  }
  const lim = cam.roadHalf - 0.075;
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
    for (const sp of game.spits) {
      const dz = Math.abs(sp.z - game.player.z);
      if (dz > 8) continue;
      const d = Math.abs(sp.x - cx);
      if (d < 0.4) s -= (0.4 - d) * Math.max(0.5, 5 - dz * 0.5) * 1.6;
    }
    for (const wn of game.warns) {
      if (Math.abs(wn.x - cx) < 0.16 + 0.03) s -= 30;
    }
    if (s > bestScore) { bestScore = s; bestX = cx; }
  }
  return bestX;
}

// ---- 开打 ----
console.log(`== 试玩：第 ${LEVEL} 关「${lv.name}」==`);
console.log(`   难度：diff ${lv.diff || 1} × 出怪 ${lv.countDiff || 1}` +
  `${lv.bossEvolve ? ' · BOSS 会进化' : ''} | 上限 ${MINUTES} 分钟 | 种子 ${SEED}\n`);

game.beginLevel(LEVEL - 1);
game.releaseTalk();

const T = (f) => (f * 0.05);
const waves = [];       // 每波：开始时间 / 用时 / 被咬 / 打完时血量
let held = false;
let frames = 0;
let maxWave = 0;
let waveStart = 0;
let hpAtWave = 0;
let killsAtWave = 0;
let diedAt = null;
let doctorAt = null;
let doctorHp0 = 0;
let doctorDead = null;
let strikeSeq = game.strikeSeq;
let strikes = 0;
let minHp = game.player.hp;
let maxCombo = 0;
let wave15Start = null;
const hurtLog = [];   // 每次掉血：谁咬的 / 什么技能（用来判断"是不是被看不见的东西打死"）

const MAX_ITER = Math.round((MINUTES * 60) / 0.05);
for (let i = 0; i < MAX_ITER; i++) {
  frames++;
  if (game.wave > maxWave) {
    if (maxWave > 0) {
      waves.push({
        wave: maxWave, t: +(T(frames) - waveStart).toFixed(1),
        bites: Math.max(0, hpAtWave - game.player.hp), hp: game.player.hp,
        kills: game.kills - killsAtWave,
      });
    }
    maxWave = game.wave;
    waveStart = T(frames);
    hpAtWave = game.player.hp;
    killsAtWave = game.kills;
    if (maxWave === 15) wave15Start = T(frames);
  }
  if (game.bossEvolves > 0 && doctorAt === null) {
    doctorAt = T(frames);
    const b = game.enemies.find((e) => e.kind === 'boss');
    doctorHp0 = b ? b.maxHp : 0;
    console.log(`   ⚡ ${T(frames).toFixed(1)}s：第一条血清空 → 僵尸博士进化（第二条血 ${doctorHp0}）`);
  }
  if (game.state === STATE.OVER) { diedAt = T(frames); break; }
  if (game.state === STATE.CLEAR) break;

  if (!held) { firePointer('pointerdown', 195); held = true; }
  firePointer('pointermove', 195 + (botTargetX() - game._dragWorld) * cam.scaleNear);
  if (game.canStrike() && renderer.strikeBtn) {
    const sb = renderer.strikeBtn;
    firePointer('pointerdown', sb.x, sb.y, 2);
    firePointer('pointerup', sb.x, sb.y, 2);
    if (game.strikeSeq !== strikeSeq) { strikeSeq = game.strikeSeq; strikes++; }
  }
  if (game.player.hp < minHp) minHp = game.player.hp;
  if (game.combo > maxCombo) maxCombo = game.combo;
  const hpBefore = game.player.hp;
  const px = game.player.x;
  const pz = game.player.z;
  step(50);
  if (game.player.hp < hpBefore) {
    const near = game.enemies
      .filter((e) => Math.abs(e.x - px) < 0.9 && Math.abs(e.z - pz) < 1.6)
      .map((e) => `${e.kind}@${e.z.toFixed(1)}`);
    hurtLog.push({
      t: +T(frames).toFixed(1), wave: maxWave, dmg: hpBefore - game.player.hp,
      near: near.join(',') || '无（远程/爆炸）',
      warns: game.warns.length, spits: game.spits.length,
    });
    if (hurtLog.length > 10) hurtLog.shift();
  }
}

// ---- 战报 ----
console.log('\n  波次明细（用时 / 被咬掉的血 / 这一波击杀）：');
for (const w of waves) {
  console.log(`   ${String(w.wave).padStart(3)}  用时 ${String(w.t).padStart(6)}s   掉血 ${String(w.bites).padStart(2)}   击杀 ${String(w.kills).padStart(3)}   打完时血量 ${w.hp}`);
}
const tail = `血 ${game.player.hp}/${game.player.maxHp}`;
console.log('\n== 结果 ==');
console.log(`  最大波次 ${maxWave} | 用时 ${T(frames).toFixed(1)}s | 击杀 ${game.kills} | 分数 ${game.score}`);
console.log(`  结局：${game.state === STATE.CLEAR ? '通关 ✅' : diedAt !== null ? `第 ${maxWave} 波被打死（${diedAt.toFixed(1)}s）` : '到时间没打完'}`);
console.log(`  最低血量 ${minHp} | 结束血量 ${tail} | 连杀最高 ${maxCombo} | 空袭 ${strikes} 次`);
if (hurtLog.length) {
  console.log('\n  受伤记录（最后几次）：');
  for (const h of hurtLog) {
    console.log(`   ${String(h.t).padStart(6)}s 第${h.wave}波  掉 ${h.dmg} 血   身边：${h.near}   预警圈 ${h.warns}  酸球 ${h.spits}`);
  }
}
if (maxWave === 15) {
  console.log(`  BOSS 波：${(T(frames) - wave15Start).toFixed(1)}s` +
    (doctorAt !== null ? ` | 博士进化于 ${doctorAt.toFixed(1)}s（第二条血 ${doctorHp0}）` : ' | 没打到进化'));
  const b = game.enemies.find((e) => e.kind === 'boss');
  console.log(`  博士：${b ? (b.dead ? '被击杀' : `还活着（${Math.round(b.hp)}/${b.maxHp}，form ${b.form}/${b.forms}，技能 ${b.casts} 次）`) : '场上已经没有 BOSS'}`);
}
