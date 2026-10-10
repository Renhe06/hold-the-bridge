// ============================================================
//  数值经济探针（不进游戏，只算账）
//
//  冒烟测试里的机器人只能告诉你"能不能打"，不能告诉你"为什么打不动"。
//  这个脚本按 config.js 的公式把每一波的「血量总量 / 出怪窗口 / 到位时刻」
//  算出来，再和玩家在那一波大概能有的 DPS 对比，看数值是否自洽。
//
//  运行：node tools/balance-probe.mjs
// ============================================================

import { CFG, isHordeWave, isBossWave } from '../js/config.js';

const W = CFG.wave;
const G = CFG.weapon;

const fmt = (n, d = 1) => n.toFixed(d).padStart(6);

// 玩家在"打完第 w-1 波"时大概累计拿到多少次升级：每清一波给一次三选一。
// 用一个中等偏上的模型：40% 点伤害（+1/层）、30% 点射速（×1.18/层），
// 剩下 30% 是弹道/暴击类，折算成约 +12% 有效输出/层。
function playerDps(picks) {
  const dmgPicks = picks * 0.4;
  const ratePicks = picks * 0.3;
  const miscPicks = picks * 0.3;
  const dmg = G.damage + dmgPicks;
  const interval = G.interval / Math.pow(1.18, ratePicks);
  return (dmg / interval) * (1 + 0.12 * miscPicks);
}

console.log('== 守桥 · 数值经济 ==\n');
console.log(
  '  波次  数量   单只HP   总HP    出怪窗口  最后一只到位   需要DPS   估计DPS   余量'
);

let firstBad = null;
for (let w = 1; w <= 18; w++) {
  const count = Math.min(W.maxCount, W.firstCount + (w - 1) * W.countPerWave);
  // 波型判定统一走 config 里的两个函数：人海波（第 5/10/15 波）多一片脆皮小兵，
  // BOSS 只在最后一波。别在这里另写一份 % 5 的算法。
  const hordeWave = isHordeWave(w);
  const bossWave = isBossWave(w);
  const baseHp = W.baseHp + (w - 1) * W.hpPerWave;
  const walkerHp = Math.max(1, Math.round(baseHp));
  const bossHp = Math.max(1, Math.round(baseHp * CFG.kinds.boss.hpMul));
  // 人海波：常规出怪砍到 queueMul，另外铺一片"一枪一个"的小兵
  const queueCount = hordeWave ? Math.max(3, Math.round(count * CFG.bossHorde.queueMul)) : count;
  const hordeLevel = hordeWave ? Math.max(0, Math.floor((w - W.hordeEvery) / W.hordeEvery)) : 0;
  const hordeN = hordeWave
    ? Math.min(CFG.bossHorde.maxCount, CFG.bossHorde.base + hordeLevel * CFG.bossHorde.perLevel)
    : 0;

  // 混合了 runner/brute 之后的期望血量：按 spawnEnemy 里的出现概率估算
  const pRunner = w >= CFG.runnerFrom ? Math.min(0.4, 0.1 + w * 0.02) : 0;
  const pBrute = w >= CFG.bruteFrom ? Math.min(0.26, 0.05 + w * 0.015) : 0;
  const mixHp =
    walkerHp * (1 - pRunner - pBrute) +
    Math.max(1, Math.round(baseHp * CFG.kinds.runner.hpMul)) * pRunner +
    Math.max(1, Math.round(baseHp * CFG.kinds.brute.hpMul)) * pBrute;

  // 总血量 = 常规队列（人海波已砍到 queueMul）× 混合血量
  //        + 人海（hordeN 只、每只正好 hpTarget 点血，一枪一个）
  //        + 最后一波的 BOSS
  const totalHp = mixHp * queueCount + hordeN * CFG.bossHorde.hpTarget + (bossWave ? bossHp : 0);

  const gap = Math.max(W.spawnGapMin, W.spawnGap - (w - 1) * W.spawnGapDecay);
  // 人海是同一帧一次性生成的，所以出怪窗口按"常规队列"算（人海不占队列时间）
  const spawnWindow = gap * (Math.max(1, queueCount) - 1);
  const speed = W.zombieSpeed + Math.min(W.speedPerWaveMax, (w - 1) * W.speedPerWave);
  const travel = (CFG.zFar - (CFG.zNear + W.stopGap)) / speed;
  const lastArrive = travel + spawnWindow;

  // 从第一只到位到全部到位，玩家真正能"顺手打"的时间窗
  const window = Math.max(1, lastArrive - travel + travel * 0.5);
  const needDps = totalHp / window;
  const haveDps = playerDps(w - 1);
  const ratio = haveDps / needDps;

  const flag = ratio < 1 ? '  ✗ 打不完' : ratio < 1.5 ? '  ⚠ 很紧' : '';
  if (ratio < 1 && firstBad === null) firstBad = w;

  const tag = bossWave ? ' BOSS' : hordeWave ? ' 人海' : '';
  console.log(
    `  ${String(w).padStart(3)}  ${String(queueCount + hordeN + (bossWave ? 1 : 0)).padStart(4)}  ` +
      `${fmt(walkerHp)}  ${fmt(totalHp)}  ${fmt(spawnWindow)}s  ${fmt(lastArrive)}s  ` +
      `${fmt(needDps)}  ${fmt(haveDps)}  ${fmt(ratio, 2)}×${flag}${tag}`
  );
}

console.log(
  `\n  窗口 = 从"最后一只到位"往前算的一段可输出时间（含一半路程的重叠），` +
    `是个粗略但同向的估计。\n  余量 = 估计 DPS / 需要 DPS，< 1 表示这一波在数值上清不完。`
);
if (firstBad !== null) {
  console.log(`\n  第一波清不完：第 ${firstBad} 波。`);
} else {
  console.log('\n  18 波之内每一波在数值上都清得完。');
}
