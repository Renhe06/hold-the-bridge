// ============================================================
//  游戏核心模拟（与渲染、DOM 完全解耦）
//
//  坐标系：x = 横向（世界单位，桥面半宽 = cam.roadHalf）
//          z = 深度（zNear = 英雄基准位，zFar = 出怪处，越大越远）
//          h = 离地高度（世界单位，只用于粒子和特效）
//
//  v2 相对 v1 的三处玩法改动（都来自用户 m00458 的反馈）：
//   1. 战车 → 英雄，并且能前后移动（z 也跟手）
//   2. 清完一波不再弹三选一，改成桥上左右两块"奖励门"，
//      玩家用走位站在左半边/右半边来决定吃哪个
//   3. 僵尸体型整体放大一档
// ============================================================

import { CFG, UPGRADES, WEAPON_TIERS, OFFENSIVE_KEYS, isHordeWave, isBossWave } from './config.js';
import { clamp, rand, sample } from './util.js';

export const STATE = {
  START: 'start',
  PREP: 'prep', // 备战：奖励门滑过来的这段时间
  FIGHT: 'fight',
  OVER: 'over', // 桥头失守
  CLEAR: 'clear', // 第一关通关（结算金币）
};

export class Game {
  constructor(cam, sfx) {
    this.cam = cam;
    this.sfx = sfx;
    this.best = this._loadBest();
    this.coins = this._loadCoins();
    this.clearedLevel = this._loadProgress();
    this.reset();
    this.state = STATE.START;
  }

  // ---------------------------------------------------------
  //  生命周期
  // ---------------------------------------------------------

  reset() {
    this.state = STATE.PREP;
    this.time = 0;
    this.score = 0;
    this.kills = 0;
    this.wave = 0;
    this.prepT = 0;
    this.spawnQueue = [];
    this.spawnT = 0;
    this.spawnGap = CFG.wave.spawnGap;
    this.enemies = [];
    this.bullets = [];
    this.particles = [];
    this.popups = [];
    this.orbs = [];
    this.rings = [];
    this.warns = []; // BOSS 导弹的地面预警圈
    this.nextId = 1;
    this.shake = 0;
    this.flash = 0;
    this.waveBanner = 0;
    this.stacks = {};
    this.offensivePoints = 0;
    this.upgradeSeq = 0;
    this.lastGain = null; // 最近吃到的那块奖励（HUD 弹一条提示用）
    this.gates = null; // 正在滑过来的左右两块奖励门
    this.newBest = false;
    this.lastReward = null; // 本次通关结算（得分/金币）——结算面板用
    this.pulseT = CFG.weapon.pulseInterval;
    this._hitSfxT = 0;
    this.dragging = false;

    // ---- v3：打击感 + 新玩法需要的一堆状态 ----
    this.hitStop = 0; // 击杀顿帧（>0 时把 dt 压慢）
    this.combo = 0; // 连杀数
    this.comboT = 0; // 连杀剩余时间
    this.comboBest = 0;
    this.comboPunch = 0; // 连杀数字弹一下的动画量
    this.comboSeq = 0; // 连杀里程碑序号（音效去重用）
    this.energy = 0; // 空袭充能 0..CFG.charge.max
    this.energyMul = 1;
    this.strikeMul = 1;
    this.strikeSeq = 0; // 每次呼叫空袭 +1（测试与提示用）
    this.corpses = []; // 刚死的尸体（会倒下并淡出）
    this.stains = []; // 桥面上的血泊（这一波留下的痕迹）
    this.spits = []; // 吐酸者的酸液
    this.strikes = []; // 空袭中还在天上飞的导弹
    this.plane = null; // 空袭时横穿夜空的轰炸机
    this.shout = null; // 角色当前喊的那句话（连杀里程碑等）
    this.mod = null; // 本波词条
    this.lastMod = null;
    this.fogMul = 1;

    this.cam.camZ = 0;

    this.player = {
      x: 0,
      targetX: 0,
      z: CFG.zNear,
      targetZ: CFG.zNear,
      hp: CFG.hero.hp,
      maxHp: CFG.hero.hp,
      shield: 0,
      shieldPerWave: 0,
      iframe: 0,
      recoil: 0,
      muzzle: 0,
      hurt: 0,
      moveMul: 1,
      dropChance: 0,
      anim: 0, // 走路动画相位
      moving: 0,
    };

    this.weapon = {
      interval: CFG.weapon.interval,
      rateMul: 1,
      damage: CFG.weapon.damage,
      pierce: CFG.weapon.pierce,
      bullets: CFG.weapon.bullets,
      bulletSpeed: CFG.weapon.bulletSpeed,
      crit: CFG.weapon.crit,
      critMul: CFG.weapon.critMul,
      splash: CFG.weapon.splash,
      ice: 0,
      burn: 0,
      pulse: 0,
      cd: 0,
      tierIdx: 0,
    };
  }

  /** 开始新一局（点击"开始挑战"/"再来一局"时调用） */
  newRun() {
    this.reset();
    this.state = STATE.PREP;
    this.prepT = CFG.wave.prepTime;
    this.pulseT = CFG.weapon.pulseInterval;
    // 第一波之前也给一对奖励门：让玩家在没有任何压力时先学会"走位选奖励"
    this.openGates();
  }

  /** 回主界面（结算面板上的"返回主界面"）：清干净，但不碰存档 */
  backToMenu() {
    this.reset();
    this.state = STATE.START;
  }

  /** 这一关打到第几波了（HUD 显示 n/15 用） */
  get levelWaves() {
    return CFG.level.waves;
  }

  get tier() {
    return WEAPON_TIERS[this.weapon.tierIdx];
  }

  // ---------------------------------------------------------
  //  输入（相对于 canvas 的屏幕坐标）
  //  手指按住任意位置拖动 = 英雄移动，横向 1:1 跟手。
  //  纵向映射到"前进/后退"：往上拖 = 前进。因为相机跟着英雄走，
  //  纵向 1:1 的直接映射会让英雄一直粘在手指下面、画面不动，
  //  所以纵向用"手指位移 → 深度增量"，视觉上是世界在向后滚。
  // ---------------------------------------------------------

  pointerDown(sx, sy) {
    this.dragging = true;
    this._dragSX = sx;
    this._dragSY = sy;
    this._dragWorld = this.player.targetX;
    this._dragWorldZ = this.player.targetZ;
  }

  pointerMove(sx, sy) {
    if (!this.dragging) return;
    const wx = this._dragWorld + (sx - this._dragSX) / this.cam.scaleNear;

    // 纵向：往上拖（sy 变小）= 前进。用英雄所在深度的缩放换算，
    // 但系数打个折（0.62），否则手指动一点点就顶到底/退到底。
    const dz = ((this._dragSY - sy) / this.cam.scaleNear) * CFG.hero.dragZScale;
    const wz = this._dragWorldZ + dz;

    this.player.targetX = this.cam.clampToRoad(wx, CFG.hero.halfWidth);
    this.player.targetZ = clamp(wz, CFG.zNear - CFG.hero.zBack, CFG.zNear + CFG.hero.zFwd);
  }

  pointerUp() {
    this.dragging = false;
  }

  // ---------------------------------------------------------
  //  主循环
  // ---------------------------------------------------------

  update(dtRaw) {
    let dt = Math.min(dtRaw, 0.05);
    // 击杀顿帧：把时间流速压到 22%，持续 40~140ms。
    // 打击"爽感"里最便宜也最有效的一招（子弹时间那一下）。
    // 用真实 dtRaw 递减，否则顿帧会把自己也拖长。
    if (this.hitStop > 0) {
      this.hitStop -= dtRaw;
      dt *= 0.22;
    }
    this.time += dt;

    const fighting = this.state === STATE.FIGHT;
    const active = fighting || this.state === STATE.PREP;

    if (this.state === STATE.PREP) {
      this.prepT -= dt;
      if (this.prepT <= 0) this.startWave();
    } else if (fighting) {
      this.updateSpawning(dt);
      this.updatePulse(dt);
      this.updateFiring(dt);
    }

    if (active) {
      this.updatePlayer(dt);
      this.updateGates(dt);
      this.updateSpits(dt);
      this.updateStrikes(dt);
    }
    if (fighting) {
      this.updateEnemies(dt);
    }

    // 连杀断链
    if (this.combo > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 0;
    }
    this.comboPunch = Math.max(0, this.comboPunch - dt / CFG.combo.punch);
    if (this.shout) {
      this.shout.t += dt;
      if (this.shout.t >= this.shout.life) this.shout = null;
    }

    this.updateBullets(dt);
    this.updateOrbs(dt);
    this.updateCorpses(dt);
    this.updateParticles(dt);
    this.updatePopups(dt);
    this.updateRings(dt);
    this.updateWarns(dt);

    const pl = this.player;
    pl.iframe = Math.max(0, pl.iframe - dt);
    pl.hurt = Math.max(0, pl.hurt - dt * 3.2);
    pl.recoil = Math.max(0, pl.recoil - dt * 9);
    pl.muzzle = Math.max(0, pl.muzzle - dt * 14);
    this.shake *= Math.exp(-dt * 9);
    if (this.shake < 0.15) this.shake = 0;
    this.flash = Math.max(0, this.flash - dt * 2.4);
    this.waveBanner = Math.max(0, this.waveBanner - dt);
    this._hitSfxT = Math.max(0, this._hitSfxT - dt);

    // 波次清空判定必须在敌人数组清理之后。
    // 这里重新读一遍 state 而不是用上面那个 fighting 快照：
    // 玩家可能就在这一帧的 updateEnemies 里被咬死（state 已经变成 OVER），
    // 快照还是 true 的话，最后一波刚好被清空就会触发 onWaveClear 把游戏"救活"。
    if (this.state === STATE.FIGHT && this.spawnQueue.length === 0 && this.enemies.length === 0) {
      this.onWaveClear();
    }
  }

  // ---------------------------------------------------------
  //  波次
  // ---------------------------------------------------------

  /** 抽一个本波词条（不和上一波重复） */
  rollMod() {
    const pool = CFG.mods.filter((m) => !this.lastMod || m.id !== this.lastMod.id);
    const m = pool[Math.floor(Math.random() * pool.length)] || null;
    this.lastMod = m;
    return m;
  }

  startWave() {
    const W = CFG.wave;
    this.wave += 1;
    const w = this.wave;

    // 每 modEvery 波来一个词条：让每一局的中段节奏都不一样
    this.mod = w % CFG.modEvery === 0 ? this.rollMod() : null;
    this.fogMul = this.mod && this.mod.fog ? this.mod.fog : 1;
    const M = this.mod;

    let count = Math.round(Math.min(W.maxCount, W.firstCount + (w - 1) * W.countPerWave) * ((M && M.countMul) || 1));

    // 人海波：铺一片一枪一个的小兵。BOSS 只在最后一波来（见 config 的波型判定），
    // 所以第 5 / 10 波是"割草波"，不夹带 BOSS。
    const hordeWave = isHordeWave(w);
    const bossWave = isBossWave(w);
    // 人海波另外铺一片人海（spawnHorde），所以常规出怪砍到三分之一
    if (hordeWave) count = Math.max(3, Math.round(count * CFG.bossHorde.queueMul));

    const queue = [];
    for (let i = 0; i < count; i++) {
      let kind = 'walker';
      if (M && M.allRunner) {
        // 词条"疾行者"：几乎全是跑步的，节奏立刻变快
        kind = w >= CFG.bruteFrom && Math.random() < 0.14 ? 'brute' : 'runner';
      } else {
        if (w >= CFG.runnerFrom && Math.random() < Math.min(0.4, 0.1 + w * 0.02)) kind = 'runner';
        if (w >= CFG.bruteFrom && Math.random() < Math.min(0.26, 0.05 + w * 0.015)) kind = 'brute';
        if (w >= CFG.spitterFrom && Math.random() < 0.13) kind = 'spitter';
        if (w >= CFG.shieldedFrom && Math.random() < 0.13) kind = 'shielded';
        if (w >= CFG.splitterFrom && Math.random() < 0.11) kind = 'splitter';
      }
      queue.push(kind);
    }
    // 特殊怪保证有戏份：该出场之后的每一波至少来一只
    if (w >= CFG.spitterFrom && !queue.includes('spitter')) queue.push('spitter');
    if (w >= CFG.splitterFrom && !queue.includes('splitter')) queue.push('splitter');

    // BOSS 不走常规出怪队列：它和人海同一帧出场（见下面 spawnHorde），
    // 所以这里不再 queue.push('boss')
    this.spawnQueue = queue;
    this.spawnT = 0;
    this.spawnGap = Math.max(W.spawnGapMin, W.spawnGap - (w - 1) * W.spawnGapDecay);

    if (this.player.shieldPerWave > 0) {
      this.player.shield = Math.min(6, this.player.shield + this.player.shieldPerWave);
    }

    this.state = STATE.FIGHT;
    this.waveBanner = bossWave ? 2.8 : hordeWave ? 2.5 : M ? 2.4 : 2.2;
    this.pulseT = CFG.weapon.pulseInterval;
    this.sfx.waveStart(w);
    if (hordeWave) {
      // 这一波开场就要是这个画面：桥面最前面铺满密密麻麻的小兵，
      // 玩家抬手一梭子扫倒一片。所以人海不走出怪队列，直接一次性生成。
      this.spawnHorde(w);
    }
    if (bossWave) {
      // 最后一波：人海之后再压上那个巨大的 BOSS（人海更靠近玩家）。
      this.fitBossHp(this.spawnEnemy('boss', null, CFG.zFar - 5, 1));
      this.sfx.bossSpawn();
      this.say('BRING IT ON!', '#ff6b4a');
    }
  }

  /**
   * 人海波的"人海"：一次性把一群脆皮小兵铺在桥面上（最前一排离你 zFrom）。
   * 横向 N 条车道铺满桥宽、纵向 M 排，全部当场生成（不走 spawnQueue），
   * 这样开场就是"密密麻麻一片"而不是稀稀拉拉一个个走出来。
   */
  spawnHorde(w) {
    const H = CFG.bossHorde;
    const W = CFG.wave;
    const ro = W.hordeEvery;
    const level = Math.max(0, Math.floor((w - ro) / ro)); // 第几个"人海波"（5→0、10→1、15→2）
    const n = Math.min(H.maxCount, H.base + level * H.perLevel);
    const roadHalf = this.cam.roadHalf;
    const lanes = H.lanes;
    // 这一群小兵的血量按"目标血量"给，不按这一刻的基础血量乘系数：
    // 乘法会让第 5 波的小兵变成 2 血（基础武器 1 伤/0.3s，16 只砍 10s，
    // 结果是一群脆皮围着你咬），而这一波要的是"一枪一个"的割草爽感，
    // 所以直接反算倍率，让它们正好 H.hpTarget 点血（词条倍率仍会作用于它）。
    const baseHp = W.baseHp + (w - 1) * W.hpPerWave;
    const hpScale = H.hpTarget / baseHp;
    for (let i = 0; i < n; i++) {
      const lane = i % lanes;
      const rank = Math.floor(i / lanes);
      // 车道均匀铺开：-1 / -1/3 / +1/3 / +1（lanes = 4）
      const lf = lanes === 1 ? 0 : (lane / (lanes - 1)) * 2 - 1;
      const x = clamp(lf * roadHalf * H.spread + rand(-0.02, 0.02), -roadHalf, roadHalf);
      const z = CFG.zFar - H.zFrom - rank * H.zStep + rand(-0.4, 0.4);
      // 人海：统一减速 + 停在"挤成一堵墙但够不着你"的位置（见 config 注释）
      const e = this.spawnEnemy('walker', x, z, hpScale);
      e.speed *= H.speedScale;
      e.stopGap = rand(H.stopFrom, H.stopTo);
      e.stopJit = 0;
    }
    // 一片"尸潮"落地扬尘 + 提示，让玩家知道这是设计好的场面而不是卡出来的
    for (let i = 0; i < 14; i++) {
      this.particles.push({
        x: rand(-roadHalf, roadHalf),
        z: CFG.zFar - H.zFrom - rand(0, 8),
        h: rand(0.02, 0.16),
        vx: rand(-0.2, 0.2),
        vz: rand(-0.3, 0.3),
        vh: rand(0.3, 0.9),
        life: rand(0.35, 0.8),
        size: rand(0.006, 0.014),
        color: '#9aa7bd',
        add: false,
      });
    }
  }

  /**
   * BOSS 的"放崽子"：每隔 spawnEvery 秒往它身前扔几只一枪一个的小兵。
   * 这样它虽然站得远、够不着你，依然是这一波真正的压力来源
   * （也是你该优先把它打死的理由）。场上小兵太多时会先停手，
   * 免得玩家站着不动被无尽的崽子堆死。
   */
  // BOSS 战时长校准（用户要"打 BOSS 大约 15~30 秒"）。
  // 玩家构筑的 DPS 差异太大，固定血量倍数做不到这个区间，所以开打时
  // 按玩家当前 DPS 反推血量：血量 = 估算 DPS × CFG.kinds.boss.seconds。
  estimateDps() {
    const w = this.weapon;
    const crit = 1 + w.crit * (w.critMul - 1);
    const perShot = w.damage * crit * Math.min(w.bullets, 6);
    const shots = 1 / Math.max(0.05, w.interval / w.rateMul);
    let dps = perShot * shots * 0.75; // 折算：BOSS 很大，但散开的弹道不会发发命中
    dps += (w.splash || 0) * 1.6 + (w.burn || 0) * 0.5 + (w.pulse || 0) * 0.4;
    return dps;
  }

  fitBossHp(b) {
    const K = CFG.kinds.boss;
    const want = Math.round(clamp(this.estimateDps() * K.seconds, K.hpMin, K.hpMax));
    b.hp = want;
    b.maxHp = want;
    return b;
  }

  spawnBossAdds(boss) {
    const K = CFG.kinds.boss;
    const H = CFG.bossHorde;
    boss.addT = K.spawnEvery;
    const alive = this.enemies.reduce((n, e) => n + (!e.dead && e.kind !== 'boss' ? 1 : 0), 0);
    if (alive >= 22) return;
    const baseHp = CFG.wave.baseHp + (this.wave - 1) * CFG.wave.hpPerWave;
    const hpScale = H.hpTarget / baseHp;
    const roadHalf = this.cam.roadHalf;
    for (let i = 0; i < K.spawnCount; i++) {
      const x = clamp(boss.x + rand(-0.8, 0.8) * roadHalf, -roadHalf, roadHalf);
      const z = boss.z + rand(0.5, 1.8);
      // birth 0.4：新鲜出炉的崽子有一小段"爬起来"的时间，看得见它们是怎么来的
      const e = this.spawnEnemy('walker', x, z, hpScale, 0.4);
      e.speed *= H.speedScale;
      e.stopGap = rand(H.stopFrom, H.stopTo);
      e.stopJit = 0;
    }
    // 一圈红色的"首领在生"提示环，别让玩家以为是凭空冒出来的
    this.rings.push({ x: boss.x, z: boss.z + 0.7, t: 0, life: 0.5, maxR: 0.55, color: '#ff7a4a' });
  }

  // BOSS 导弹：先在"你现在站的地方"画一个预警圈（render 里画），
  // warn 秒后砸下来；落点是开火那一刻定死的，所以走开就是躲开了。
  bossFire(boss) {
    const M = CFG.bossMissile;
    const pl = this.player;
    this.warns.push({ x: pl.x, z: pl.z, t: 0, life: M.warn, fromZ: boss.z });
    this.sfx.missileWarn();
    this.addPopup(boss.x, boss.z - 0.6, '导弹来袭', '#ff5a3a', 1.15);
  }

  updateWarns(dt) {
    for (const w of this.warns) w.t += dt;
    const landed = this.warns.filter((w) => w.t >= w.life);
    this.warns = this.warns.filter((w) => w.t < w.life);
    for (const w of landed) this.missileLand(w);
  }

  missileLand(w) {
    const M = CFG.bossMissile;
    const pl = this.player;
    // 爆炸用现成的冲击环 + 火花，不另做一套特效
    this.rings.push({ x: w.x, z: w.z, t: 0, life: 0.5, maxR: M.radius * 2.6, color: '#ff7a3a' });
    this.rings.push({ x: w.x, z: w.z, t: 0, life: 0.32, maxR: M.radius * 1.3, color: '#fff0c0' });
    this.spawnParticles(w.x, w.z, 20, 'spark', '#ffb060');
    this.shake = Math.max(this.shake, 14);
    this.sfx.missileBoom();
    // 复用咬人的结算（护盾抵挡 / 无敌帧 / 断连杀 / 掉血都跟被咬一致）
    if (Math.abs(pl.x - w.x) < M.radius && Math.abs(pl.z - w.z) < 1.1) {
      this.bite({ x: w.x, z: w.z });
    }
  }

  updateSpawning(dt) {
    if (this.spawnQueue.length === 0) return;
    this.spawnT -= dt;
    let guard = 0;
    while (this.spawnT <= 0 && this.spawnQueue.length > 0 && guard++ < 20) {
      this.spawnEnemy(this.spawnQueue.shift());
      this.spawnT += this.spawnGap;
    }
  }

  /**
   * 敌人出场。atX/atZ/hpScale 给分裂者用（在原地裂出小兵），birth 是"孵化"时间。
   * 词条（mod）在这里统一作用到血量/速度/分数上。
   */
  spawnEnemy(kind, atX, atZ, hpScale, birth) {
    const K = CFG.kinds[kind] || CFG.kinds.walker;
    const W = CFG.wave;
    const w = this.wave;
    const M = this.mod;
    const baseHp = W.baseHp + (w - 1) * W.hpPerWave;
    let hp = Math.max(1, Math.round(baseHp * K.hpMul * ((M && M.hpMul) || 1) * (hpScale || 1)));
    let speed = (W.zombieSpeed + Math.min(W.speedPerWaveMax, (w - 1) * W.speedPerWave)) * K.speedMul;
    if (M && M.speedMul) speed *= M.speedMul;

    // 每只怪自己的错位（错开站位，免得叠成一坨）。注意：**停下来的那条线
    // 必须是"英雄当前所在位置"往前一点，不能按固定基准位 zNear 算** ——
    // 英雄能前后走 ±(zBack/zFwd)，按 zNear 算的话，你往前走时丧尸就会从你
    // 身边（甚至身后）穿过去，看起来像"凭空出现在面前"（用户实测反馈）。
    //
    // 停多远由"种类"决定：吐酸者在远处喷酸、BOSS 太大要站得更远（贴脸会
    // 占满屏幕，玩家连自己在哪条车道都看不见），其他怪按基础值 + 一点随机。
    const stopGap = K.stopGap != null ? K.stopGap : K.spit ? CFG.spitter.gap : W.stopGap;
    const stopJit = K.spit || K.stopGap != null ? 0 : rand(0, W.stopJitter);

    this.enemies.push({
      id: this.nextId++,
      kind,
      body: K.body || 'normal',
      x: atX != null ? atX : kind === 'boss' ? rand(-0.05, 0.05) : rand(-0.86, 0.86) * this.cam.roadHalf,
      z: atZ != null ? atZ : CFG.zFar + rand(0, 3),
      hp,
      maxHp: hp,
      speed,
      size: K.size,
      color: K.color,
      dark: K.dark,
      halfW: K.size * 0.32,
      // 能"咬到"你的宽度。默认跟体型走，但 BOSS 体型太大（1.2 → 0.38）
      // 会盖满整条桥，所以它单独给一个窄值：身体很大很好打，想咬你只有中间一小段
      biteHalfW: K.biteHalfW != null ? K.biteHalfW : K.size * 0.32,
      // 能咬到你的纵向距离。**故意和 stopGap 解耦**：站在哪 vs 够不够得着是两件事 ——
      // 人海站在 2.6~4.2（一堵尸墙）够不着你，BOSS 站在 7 更够不着，
      // 它们的伤害来源分别是"被割"和"放崽子"，不是咬人。
      biteReach: W.stopGap + 0.6,
      zdepth: K.size * 0.45,
      score: Math.round(K.score * ((M && M.scoreMul) || 1)),
      stopJit,
      stopGap,
      stopZ: CFG.zNear + stopGap + stopJit,
      addT: K.spawnEvery || 0,
      missileT: kind === 'boss' ? CFG.bossMissile.every : 0,
      birth: birth || 0,
      birthDur: birth || 1,
      spit: !!K.spit,
      split: K.split || 0,
      shield: K.shield || 0,
      maxShield: K.shield || 0,
      state: 'approach',
      phase: rand(0, Math.PI * 2),
      slowT: 0,
      slowMulValue: 1,
      burnT: 0,
      burnDps: 0,
      hurtT: 0,
      atk: 'rest',
      atkT: rand(0.05, 0.7),
      lungeDir: 1,
      biteCd: 0,
      dead: false,
    });
    // 返回刚生成的这一只，方便调用方拿到它再改点什么（人海就是靠它统一减速的）
    return this.enemies[this.enemies.length - 1];
  }

  onWaveClear() {
    // 死了就是死了：不能因为同帧清掉最后一波就把状态掰回备战（那样会"复活"）
    if (this.state !== STATE.FIGHT) return;
    const bonus = CFG.score.perWave * this.wave;
    this.score += bonus;
    this.addPopup(0, this.player.z + 3, `第 ${this.wave} 波清除  +${bonus}`, '#7df9ff', 1.25);
    // 打满 15 波 = 第一关通关：不再开奖励门，直接结算发金币
    if (this.wave >= CFG.level.waves) {
      this.levelClear();
      return;
    }
    this.openGates();
    this.state = STATE.PREP;
    this.prepT = CFG.wave.prepTime;
  }

  /**
   * 第一关通关：按得分结算金币（比例见 CFG.level.coinRatio）。
   * 金币是"跨局"的，存在本地，留给以后主界面的商店花。
   */
  levelClear() {
    this.state = STATE.CLEAR;
    this.gates = null;
    this.shake = 20;
    this.flash = 0.9;
    const coins = Math.max(1, Math.round(this.score * CFG.level.coinRatio));
    this.coins += coins;
    this.clearedLevel = Math.max(this.clearedLevel, 1);
    this._saveCoins();
    this._saveProgress();
    if (this.score > this.best) {
      this.best = this.score;
      this.newBest = true;
      this._saveBest();
    } else {
      this.newBest = false;
    }
    this.lastReward = {
      score: this.score,
      coins,
      total: this.coins,
      kills: this.kills,
      combo: this.comboBest,
      wave: this.wave,
    };
    this.sfx.victory();
    this.addPopup(0, this.player.z + 3, `第一关通关！+${coins} 金币`, '#ffd166', 2.0);
  }

  // ---------------------------------------------------------
  //  奖励门
  // ---------------------------------------------------------

  /** 从可用加成里抽两块，摆在桥的左右半边 */
  openGates() {
    const avail = UPGRADES.filter((u) => (this.stacks[u.id] || 0) < u.max);
    if (avail.length === 0) {
      this.gates = null;
      return;
    }
    // 左门一定从"进攻类"里抽：保证每波都有变强的路，
    // 不会运气不好两扇门都是生存增益、越打越打不动
    const off = avail.filter((u) => OFFENSIVE_KEYS.includes(u.id));
    // 弹道数还不到 preferBulletsUntil（3）条时，进攻门优先给"弹道 +1"：
    // 基础武器只有一条弹道，前期清那一片人海全靠"一发一条线"，
    // 先把弹道铺到 3 条，割草的爽感才立得住。达标后（或已经抽满）恢复随机。
    const wantBullets =
      this.weapon.bullets < CFG.gate.preferBulletsUntil && off.some((u) => u.id === 'bullets');
    const left = wantBullets
      ? off.find((u) => u.id === 'bullets')
      : off.length
        ? sample(off, 1)[0]
        : sample(avail, 1)[0];
    const rest = avail.filter((u) => u.id !== left.id);
    const right = rest.length ? sample(rest, 1)[0] : left;
    this.gates = { z: CFG.gate.zStart, left, right };
  }

  /** 两块门并排往英雄这边滑，滑到面前按"人站在哪半边"结算 */
  updateGates(dt) {
    const g = this.gates;
    if (!g) return;
    g.z -= CFG.gate.speed * dt;
    if (g.z <= this.player.z + CFG.gate.resolveGap) {
      this.gates = null;
      const u = this.player.x < 0 ? g.left : g.right;
      this.applyUpgrade(u.id, g.z);
    }
  }

  /** 吃到一块奖励。atZ 给了就在那个深度飘一条字 */
  applyUpgrade(id, atZ) {
    const u = UPGRADES.find((x) => x.id === id);
    if (!u) return;

    this.stacks[u.id] = (this.stacks[u.id] || 0) + 1;
    const a = u.apply;
    const w = this.weapon;
    const pl = this.player;

    if (a.damage) w.damage += a.damage;
    if (a.rateMul) w.rateMul *= a.rateMul;
    if (a.pierce) w.pierce += a.pierce;
    if (a.bullets) w.bullets = Math.min(6, w.bullets + a.bullets);
    if (a.crit) w.crit = Math.min(0.85, w.crit + a.crit);
    if (a.critMul) w.critMul += a.critMul;
    if (a.splash) w.splash = Math.min(0.22, w.splash + a.splash);
    if (a.ice) w.ice += a.ice;
    if (a.burn) w.burn += a.burn;
    if (a.bulletSpeedMul) w.bulletSpeed *= a.bulletSpeedMul;
    if (a.moveMul) pl.moveMul *= a.moveMul;
    if (a.maxHp) {
      pl.maxHp += a.maxHp;
      pl.hp = pl.maxHp; // 描述里写了"并回满生命"
    }
    if (a.heal) pl.hp = Math.min(pl.maxHp, pl.hp + a.heal);
    if (a.shieldPerWave) pl.shieldPerWave += a.shieldPerWave;
    if (a.dropChance) pl.dropChance += a.dropChance;
    if (a.pulse) {
      w.pulse += a.pulse;
      this.pulseT = CFG.weapon.pulseInterval;
    }
    if (a.chargeMul) this.energyMul *= a.chargeMul;
    if (a.strikeMul) this.strikeMul *= a.strikeMul;

    if (OFFENSIVE_KEYS.includes(u.id)) this.offensivePoints += 1;
    this.updateTier();

    this.lastGain = { id: u.id, name: u.name, tag: u.tag, op: u.op, amt: u.amt, short: u.short };
    this.upgradeSeq += 1;
    this.sfx.upgrade();
    if (atZ != null) {
      this.addPopup(0, atZ, `${u.op}${u.amt} ${u.short}`, '#ffe9a8', 1.35);
      this.rings.push({ x: this.player.x, z: atZ, t: 0, life: 0.45, maxR: 0.5, color: '#ffe9a8' });
    }
  }

  updateTier() {
    let idx = 0;
    for (let i = 0; i < WEAPON_TIERS.length; i++) {
      if (this.offensivePoints >= WEAPON_TIERS[i].at) idx = i;
    }
    if (idx !== this.weapon.tierIdx) {
      this.weapon.tierIdx = idx;
      this.addPopup(this.player.x, this.player.z + 2.5, `武器进化 · ${WEAPON_TIERS[idx].name}`, '#ff7df2', 1.45);
      this.flash = 0.7;
      this.shake = Math.max(this.shake, 8);
    }
  }

  // ---------------------------------------------------------
  //  玩家
  // ---------------------------------------------------------

  updatePlayer(dt) {
    const pl = this.player;
    const kx = Math.min(1, dt * CFG.hero.speed * pl.moveMul);
    const kz = Math.min(1, dt * CFG.hero.zSpeed * pl.moveMul);
    pl.x += (pl.targetX - pl.x) * kx;
    pl.z += (pl.targetZ - pl.z) * kz;
    pl.x = this.cam.clampToRoad(pl.x, CFG.hero.halfWidth);
    pl.z = clamp(pl.z, CFG.zNear - CFG.hero.zBack, CFG.zNear + CFG.hero.zFwd);

    // 走路动画：有位移才摆腿
    const dx = pl.targetX - pl.x;
    const dz = pl.targetZ - pl.z;
    const want = Math.abs(dx) + Math.abs(dz) > 0.004 ? 1 : 0;
    pl.moving += (want - pl.moving) * Math.min(1, dt * 9);
    if (want) pl.anim += dt * 11;

    // 相机跟人走：英雄永远画在 playerY 上，世界往后滚
    this.cam.camZ = pl.z - CFG.zNear;
  }

  /** 越靠前打得越疼：把"前进"变成一个真实的取舍，而不是纯风险 */
  forwardBonus() {
    return 1 + CFG.hero.fwdDamage * Math.max(0, this.player.z - CFG.zNear);
  }

  updateFiring(dt) {
    const w = this.weapon;
    w.cd -= dt;
    if (w.cd > 0) return;
    if (this.enemies.length === 0 && this.spawnQueue.length === 0) return;
    this.fire();
  }

  fire() {
    const w = this.weapon;
    const pl = this.player;
    const tier = WEAPON_TIERS[w.tierIdx];
    const n = w.bullets;
    const z0 = pl.z + 0.12;
    const fwd = this.forwardBonus();

    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * CFG.weapon.spread;
      const isCrit = Math.random() < w.crit;
      this.bullets.push({
        x: this.cam.clampToRoad(pl.x + off, 0),
        z: z0,
        pz: z0,
        vz: w.bulletSpeed,
        dmg: w.damage * fwd * (isCrit ? w.critMul : 1),
        crit: isCrit,
        pierceLeft: w.pierce,
        splash: Math.max(CFG.weapon.splash, w.splash, tier.splash),
        ice: w.ice,
        burn: w.burn,
        hitSet: new Set(),
        dead: false,
        seed: rand(0, Math.PI * 2),
      });
    }

    w.cd = Math.max(0.06, w.interval / w.rateMul);
    pl.recoil = 1;
    pl.muzzle = 1;
    this.sfx.shoot(w.tierIdx);
  }

  bite(e) {
    const pl = this.player;
    if (pl.iframe > 0) return;
    pl.iframe = CFG.hero.iframe;
    this.spawnParticles(e.x, e.z, 7, 'spark', '#c9d6a0');

    if (pl.shield > 0) {
      pl.shield -= 1;
      this.shake = Math.max(this.shake, 9);
      this.sfx.hit();
      this.addPopup(e.x, e.z, '护盾抵挡', '#7df9ff', 1.05);
      return;
    }

    pl.hp -= 1;
    pl.hurt = 1;
    this.combo = 0; // 被咬断连杀：贪和稳之间的张力靠这一条
    this.comboT = 0;
    this.flash = 1;
    this.shake = Math.max(this.shake, 17);
    this.sfx.bite();
    if (pl.hp <= 0) this.gameOver();
  }

  gameOver() {
    this.state = STATE.OVER;
    this.shake = 26;
    this.sfx.gameOver();
    if (this.score > this.best) {
      this.best = this.score;
      this.newBest = true;
      this._saveBest();
    } else {
      this.newBest = false;
    }
  }

  // ---------------------------------------------------------
  //  敌人
  // ---------------------------------------------------------

  updateEnemies(dt) {
    const W = CFG.wave;
    const pl = this.player;

    for (const e of this.enemies) {
      if (e.dead) continue;
      if (e.hurtT > 0) e.hurtT -= dt;

      let spd = 1;
      if (e.birth > 0) {
        // "孵化"期：分裂出来 / 刚冒出来的小兵有一小段爬起来的时间，
        // 这段时间里不咬人，配合渲染的放大动画，玩家看得见它是怎么出现的
        e.birth -= dt;
      }
      if (e.slowT > 0) {
        e.slowT -= dt;
        spd = e.slowMulValue;
      }
      if (e.burnT > 0) {
        e.burnT -= dt;
        e.hp -= e.burnDps * dt;
        if (Math.random() < dt * 10) {
          this.particles.push({
            x: e.x + rand(-0.02, 0.02),
            z: e.z + rand(-0.02, 0.02),
            h: rand(0.02, 0.1),
            vx: rand(-0.1, 0.1),
            vz: rand(-0.1, 0.1),
            vh: rand(0.4, 1.1),
            life: rand(0.2, 0.45),
            size: rand(0.004, 0.01),
            color: '#ff8a2b',
            add: true,
          });
        }
      }

      e.phase += dt * (e.state === 'approach' ? e.speed * 0.7 : 3.6);

      if (e.state === 'approach') {
        e.z -= e.speed * spd * dt;
        // 停下线跟着英雄走：英雄往前压，怪就在更前面停下，绝不会从身边穿过去
        e.stopZ = pl.z + e.stopGap + e.stopJit;
        if (e.z <= e.stopZ) {
          e.z = e.stopZ;
          e.state = 'attack';
          e.atk = 'rest';
          e.atkT = rand(0.05, 0.7);
        }
      } else {
        const dx = pl.x - e.x;
        const dist = Math.abs(dx);
        const dir = dx >= 0 ? 1 : -1;

        if (e.spit) {
          // 吐酸者：站在很远的地方喷酸液，只做轻微横移，不扑不咬。
          // 它的存在逼玩家"主动往前走点掉它"，而不是永远缩在桥头，
          // 同时酸液是直线飞来的，横向走位就能躲——这就是新的操作维度。
          e.x += dir * W.drift * 0.3 * spd * dt;
          e.x = clamp(e.x, -this.cam.roadHalf, this.cam.roadHalf);
          const wantZ = pl.z + CFG.spitter.gap;
          const zStepS = W.drift * spd * dt * 1.4;
          e.z += clamp(wantZ - e.z, -zStepS, zStepS);
          e.atkT -= dt;
          if (e.atkT <= 0) {
            e.atkT = CFG.spitter.interval / (0.7 + Math.min(0.6, this.wave * 0.03));
            this.spawnSpit(e);
          }
        } else if (e.kind === 'boss') {
          // BOSS 太大（体型 1.2），所以它不贴身：站得远（stopGap 7）——
          // 真贴到脸上会占满整个屏幕，玩家连自己站在哪条车道都看不见。
          // 它的威胁不是咬人（够不着），而是"尸潮首领"这个身份：
          // 源源不断往身前放小兵，所以你得尽快把它打死。
          e.x += dir * W.drift * 0.35 * spd * dt;
          e.x = clamp(e.x, -this.cam.roadHalf, this.cam.roadHalf);
          const bz = pl.z + e.stopGap;
          const bStep = W.drift * spd * dt * 1.6;
          e.z += clamp(bz - e.z, -bStep, bStep);
          e.addT -= dt;
          if (e.addT <= 0) this.spawnBossAdds(e);
          // 导弹：它够不着你，但能隔着半个桥砸你 —— 有 1.5 秒预警，能躲
          e.missileT -= dt;
          if (e.missileT <= 0) {
            e.missileT = CFG.bossMissile.every;
            this.bossFire(e);
          }
        } else {
          if (e.atk === 'rest') {
            // 慢慢横移贴过来
            e.x += dir * W.drift * spd * dt;
            e.atkT -= dt;
            if (e.atkT <= 0 && dist < W.lungeRange + e.halfW) {
              e.atk = 'wind';
              e.atkT = W.windup;
            }
          } else if (e.atk === 'wind') {
            // 蓄力（给玩家反应窗口）
            e.atkT -= dt;
            if (e.atkT <= 0) {
              e.atk = 'lunge';
              e.atkT = W.lungeTime;
              e.lungeDir = dir;
            }
          } else {
            e.x += e.lungeDir * W.lungeSpeed * spd * dt;
            e.atkT -= dt;
            if (e.atkT <= 0) {
              e.atk = 'rest';
              e.atkT = rand(W.lungeRestMin, W.lungeRestMax);
            }
          }

          // 英雄能前后移动了，所以贴身之后丧尸也要在深度上跟过来：
          // 否则玩家一直后退就永远咬不到。跟得比人慢，所以后退能换来
          // 一点点喘息时间（但不是无限安全，后退幅度只有 1.8 个单位）。
          const wantZ = pl.z + e.stopGap;
          const zStep = W.drift * spd * dt * 2.2;
          const ddz = wantZ - e.z;
          e.z += clamp(ddz, -zStep, zStep);

          e.x = clamp(e.x, -this.cam.roadHalf, this.cam.roadHalf);

          e.biteCd -= dt;
          if (
            e.birth <= 0 &&
            e.biteCd <= 0 &&
            Math.abs(pl.x - e.x) < CFG.hero.halfWidth + e.biteHalfW &&
            Math.abs(pl.z - e.z) < e.biteReach
          ) {
            e.biteCd = W.biteCooldown;
            this.bite(e);
          }
        }
      }

      if (e.hp <= 0) this.killEnemy(e);
    }

    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  killEnemy(e) {
    if (e.dead) return;
    e.dead = true;
    // 死了之后已经在空中的子弹还会打到丧尸，但分数必须冻结在 gameOver 的那一刻，
    // 否则结算面板上的分数（gameOver 时写死的）会和最终分数对不上。
    const alive = this.state === STATE.FIGHT || this.state === STATE.PREP;
    const big = e.kind === 'brute' || e.kind === 'boss';

    let gain = e.score;
    if (alive) {
      // 连杀：越连越加分，断了就归零。鼓励"贪"，和"缩在后面最安全"形成对抗
      this.combo += 1;
      this.comboT = CFG.combo.window;
      this.comboPunch = 1;
      if (this.combo > this.comboBest) this.comboBest = this.combo;
      const mult = 1 + Math.min(CFG.combo.max, (this.combo - 1) * CFG.combo.perScore);
      gain = Math.round(e.score * mult);
      this.score += gain;
      this.kills += 1;

      this.gainEnergy(e.kind === 'boss' ? CFG.charge.perBoss : CFG.charge.perKill);

      // 顿帧 + 震屏：击杀手感的两个主要来源
      this.hitStop = Math.max(this.hitStop, e.kind === 'boss' ? 0.15 : big ? 0.08 : 0.045);

      // 连杀里程碑：每 5 连叫一声，音高随连杀往上爬
      if (this.combo % 5 === 0) {
        this.comboSeq += 1;
        this.sfx.combo(this.combo);
        this.addPopup(e.x, e.z, `${this.combo} 连杀！`, '#ffd166', 1.5);
        this.shake = Math.max(this.shake, 6);
        // 英雄喊一句（配置在 CFG.shouts，越往上越亢奋）
        const line = CFG.shouts.find((s) => s.combo === this.combo);
        if (line) {
          this.say(line.text, line.color);
          this.sfx.voice(this.combo / 5);
        }
      }
    }

    // 尸体 + 血泊：桥面上留下痕迹，让"刚打过一场"看得见
    this.corpses.push({
      x: e.x,
      z: e.z,
      size: e.size,
      color: e.color,
      dark: e.dark,
      kind: e.kind,
      t: 0,
      dir: Math.random() < 0.5 ? -1 : 1,
      phase: e.phase,
    });
    if (this.corpses.length > 42) this.corpses.shift();
    this.stains.push({ x: e.x, z: e.z, r: e.size * (0.3 + Math.random() * 0.16), a: 0.55 });
    if (this.stains.length > 30) this.stains.shift();

    this.spawnParticles(e.x, e.z, e.kind === 'boss' ? 34 : big ? 20 : 13, 'blood', '#7d1a1a');
    this.addPopup(e.x, e.z, `+${gain}${this.combo >= 5 ? ` ×${this.combo}` : ''}`, '#ffd166', big ? 1.2 : 1);
    this.sfx.zombieDie(big);
    this.shake = Math.max(this.shake, e.kind === 'boss' ? 26 : big ? 8 : 4.5);

    // 分裂者：死了裂成两只小兵（血量和体型都打折）。
    // 注意：**小兵不能原地冒出来** —— 分裂者是在贴脸距离被杀的，原地生成等于
    // 僵尸凭空糊在玩家脸上（用户实测反馈"僵尸突然出现在面前"）。改成往后退
    // 1.9 个单位出生 + 0.5s 孵化期（不咬人）+ 一圈紫环提示，玩家能看清它怎么来的。
    if (alive && e.split > 0) {
      for (let i = 0; i < e.split; i++) {
        this.spawnEnemy(
          'walker',
          clamp(e.x + (i ? 0.09 : -0.09), -0.9, 0.9) * this.cam.roadHalf,
          Math.min(CFG.zFar, e.z + 1.9),
          0.5,
          0.5
        );
      }
      this.rings.push({ x: e.x, z: e.z + 1.9, t: 0, life: 0.5, maxR: 0.62, color: '#c89bff' });
      this.spawnParticles(e.x, e.z, 14, 'spark', '#c89bff');
    }

    if (this.player.dropChance > 0 && Math.random() < this.player.dropChance) {
      this.orbs.push({ x: e.x, z: e.z, life: 14, phase: rand(0, Math.PI * 2) });
    }
  }

  // ---------------------------------------------------------
  //  空袭（充能大招）
  // ---------------------------------------------------------

  gainEnergy(n) {
    if (this.energy >= CFG.charge.max) return;
    this.energy = Math.min(CFG.charge.max, this.energy + n * this.energyMul);
    if (this.energy >= CFG.charge.max) {
      this.sfx.chargeReady();
      this.addPopup(this.player.x, this.player.z + 2.2, '空袭就绪 · 点右下角', '#8bf58b', 1.4);
      this.flash = Math.max(this.flash, 0.35);
    }
  }

  canStrike() {
    return this.energy >= CFG.charge.max && (this.state === STATE.FIGHT || this.state === STATE.PREP);
  }

  /** 呼叫空袭：轰炸机横穿夜空，一串导弹从天上砸下来，从远处一路犁到桥头 */
  triggerStrike() {
    if (!this.canStrike()) return false;
    this.energy = 0;
    this.strikeSeq += 1;

    const S = CFG.strike;
    // 瞄准活着的敌人的平均横向位置：空袭要砸在"人堆"上才有快感
    let ax = this.player.x;
    const live = this.enemies.filter((e) => !e.dead);
    if (live.length) {
      ax = live.reduce((s, e) => s + e.x, 0) / live.length;
    }
    const dmg = (S.damage + this.wave * S.damagePerWave) * this.strikeMul;

    // 飞机朝哪边飞由这一发随机决定，航线高度也抖一下，免得每次一样
    this.plane = {
      t: 0,
      dur: S.planeDur,
      dir: Math.random() < 0.5 ? -1 : 1,
      y: S.planeY * (0.86 + Math.random() * 0.3),
    };

    // 落点从远处一路铺到桥头（不是只在最远端炸）：这样无论丧尸挤在哪一段
    // 都会被这一串导弹犁一遍，最后一发正好落在玩家眼前，爽感才到位
    const z0 = CFG.zFar - 3;
    const z1 = this.player.z + 1.6;
    const n = Math.max(2, S.count - 1);
    for (let i = 0; i < S.count; i++) {
      const zz = z0 + ((z1 - z0) * i) / n;
      this.strikes.push({
        // 横向散开一点：否则只是一条细线，人站偏一点就打不到
        x: clamp(ax + rand(-0.34, 0.34), -this.cam.roadHalf, this.cam.roadHalf),
        z: zz,
        t: 0,
        delay: S.firstDelay + i * S.interval,
        dur: S.missileDur,
        lean: rand(-0.5, 0.5), // 下落时的横向偏移量（屏幕比例），让弹道不是一条条垂直线
        dmg,
        launched: false,
        dead: false,
      });
    }
    this.sfx.strike();
    this.shake = Math.max(this.shake, 7);
    this.flash = Math.max(this.flash, 0.25);
    this.say('FIRE!', '#8bf58b');
    this.addPopup(this.player.x, this.player.z + 5, '空 袭', '#8bf58b', 1.7);
    return true;
  }

  updateStrikes(dt) {
    // 飞机：横穿完就消失
    if (this.plane) {
      this.plane.t += dt;
      if (this.plane.t >= this.plane.dur) this.plane = null;
    }

    for (const s of this.strikes) {
      if (s.dead) continue;
      s.t += dt;
      const fly = s.t - s.delay;
      if (fly < 0) continue;
      if (!s.launched) {
        // 第一枚导弹离机时补一声呼啸，玩家才知道"天上有东西下来了"
        s.launched = true;
        this.sfx.whoosh();
      }
      if (fly >= s.dur) {
        s.dead = true;
        this.explode(s.x, s.z, CFG.strike.radius, s.dmg);
      }
    }
    this.strikes = this.strikes.filter((s) => !s.dead);
  }

  /** 角色喊话（屏幕上冒一个对话气泡）。同一条话不会连着刷两遍 */
  say(text, color = '#ffd166', life = 1.7) {
    if (this.shout && this.shout.text === text && this.shout.t < 0.35) return;
    this.shout = { text, color, t: 0, life };
  }

  explode(x, z, r, dmg) {
    // 冲击环画得比伤害范围大一圈：屏幕上要"看得出这一下很大"
    this.rings.push({ x, z, t: 0, life: 0.5, maxR: r * 1.9, color: '#ffd166' });
    this.rings.push({ x, z, t: 0, life: 0.3, maxR: r, color: '#fff3c4' });
    this.spawnParticles(x, z, 22, 'spark', '#ffd166');
    this.spawnParticles(x, z, 10, 'blood', '#7d1a1a');
    this.flash = Math.max(this.flash, 0.45);
    this.shake = Math.max(this.shake, 15);
    this.sfx.bomb();
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (Math.abs(e.z - z) > CFG.strike.zRadius || Math.abs(e.x - x) > r) continue;
      e.hp -= dmg;
      e.hurtT = 0.12;
      e.z += 0.14; // 炸得往后退一点，视觉上"被掀了"
      if (e.hp <= 0) this.killEnemy(e);
    }
  }

  // ---------------------------------------------------------
  //  吐酸者
  // ---------------------------------------------------------

  spawnSpit(e) {
    this.spits.push({
      x: e.x,
      z: e.z - e.size * 0.25,
      vz: -CFG.spitter.speed,
      phase: rand(0, Math.PI * 2),
      dead: false,
    });
    this.sfx.spit();
    this.spawnParticles(e.x, e.z - e.size * 0.3, 3, 'spark', '#b6ff5a');
  }

  updateSpits(dt) {
    const pl = this.player;
    for (const s of this.spits) {
      if (s.dead) continue;
      const z0 = s.z;
      s.z += s.vz * dt;
      s.phase += dt * 14;
      // 直着飞、不追人：所以横向走位就能躲开（这就是它带来的新操作）
      //
      // 命中判定必须用"这一帧飞过的整段路径"，不能只看落点：
      // 酸球速度 15，一帧（dt 上限 0.05）能飞 0.75 个世界单位，
      // 比 0.45 的命中窗口还宽，只看落点会直接穿人而过。
      const inX = Math.abs(s.x - pl.x) < CFG.hero.halfWidth + 0.06;
      const lo = Math.min(z0, s.z);
      const hi = Math.max(z0, s.z);
      if (inX && pl.z + 0.45 >= lo && pl.z - 0.45 <= hi) {
        s.dead = true;
        this.spawnParticles(s.x, pl.z, 10, 'spark', '#b6ff5a');
        this.bite({ x: s.x, z: pl.z });
        continue;
      }
      if (s.z < pl.z - 1.4 || s.z < CFG.deckNearZ) s.dead = true;
    }
    this.spits = this.spits.filter((s) => !s.dead);
  }

  // ---------------------------------------------------------
  //  尸体
  // ---------------------------------------------------------

  updateCorpses(dt) {
    if (this.corpses.length === 0) return;
    for (const c of this.corpses) c.t += dt;
    this.corpses = this.corpses.filter((c) => c.t < 3.6);
  }

  // ---------------------------------------------------------
  //  子弹 / 伤害
  // ---------------------------------------------------------

  updateBullets(dt) {
    const HW = CFG.weapon.hitHalfWidth;
    const zLimit = CFG.zFar + 8;

    for (const b of this.bullets) {
      if (b.dead) continue;
      b.pz = b.z;
      b.z += b.vz * dt;

      const lo = Math.min(b.pz, b.z);
      const hi = Math.max(b.pz, b.z);

      // 扫掠检测：取这一帧子弹扫过的深度区间内的候选敌人，
      // 按 z 由近到远依次穿过，避免高速子弹"穿模"。
      const cand = [];
      for (const e of this.enemies) {
        if (e.dead || b.hitSet.has(e.id)) continue;
        if (e.z < lo - e.zdepth || e.z > hi + e.zdepth) continue;
        if (Math.abs(b.x - e.x) >= HW + e.halfW) continue;
        cand.push(e);
      }
      if (cand.length > 1) cand.sort((a, c) => a.z - c.z);

      for (const e of cand) {
        if (b.dead) break;
        b.hitSet.add(e.id);
        this.damageEnemy(e, b.dmg, b, b.crit);
        if (b.pierceLeft > 0) b.pierceLeft -= 1;
        else b.dead = true;
      }

      if (b.z > zLimit) b.dead = true;
    }

    this.bullets = this.bullets.filter((b) => !b.dead);
  }

  damageEnemy(e, dmg, b, isCrit) {
    // 铁盾兵：正面有盾，前几发伤害减半，盾碎之后才是正常伤害
    if (e.shield > 0) {
      e.shield -= 1;
      dmg *= 0.5;
      this.spawnParticles(b ? b.x : e.x, e.z, 5, 'spark', '#e8eecb');
      if (e.shield <= 0) {
        this.sfx.shieldBreak();
        this.addPopup(e.x, e.z, '破盾', '#ffe9a8', 1.25);
        this.spawnParticles(e.x, e.z, 12, 'spark', '#e8eecb');
        this.shake = Math.max(this.shake, 5);
      }
    }

    e.hp -= dmg;
    e.hurtT = 0.09;
    // 击退：中弹的丧尸会被顶一下，人堆前沿会肉眼可见地晃
    e.z += 0.045;
    this.spawnParticles(b ? b.x : e.x, e.z, isCrit ? 6 : 3, 'blood', '#7d1a1a');

    if (b) {
      if (b.ice > 0) {
        e.slowT = CFG.weapon.iceTime + CFG.weapon.iceTimePerStack * (b.ice - 1);
        e.slowMulValue = 1 - Math.min(CFG.weapon.iceSlowMax, CFG.weapon.iceSlow * b.ice);
      }
      if (b.burn > 0) {
        e.burnT = CFG.weapon.burnTime;
        e.burnDps = CFG.weapon.burnDps * b.burn;
      }
      if (b.splash > 0) this.splashDamage(b);
    }

    if (this._hitSfxT <= 0) {
      this._hitSfxT = 0.045;
      if (isCrit) this.sfx.crit();
      else this.sfx.hit();
    }

    // 伤害飘字：每发子弹都飘会糊屏，所以只有暴击/大伤害才飘，
    // 但暴击的飘字做得大一号、橙色，一眼能看出"这一下很疼"
    if (isCrit) {
      this.addPopup(b ? b.x : e.x, e.z, `暴击 ${Math.round(dmg)}`, '#ff9f45', 1.3);
      this.shake = Math.max(this.shake, 3.2);
    } else if (dmg >= 2) {
      this.addPopup(b ? b.x : e.x, e.z, `${Math.round(dmg)}`, '#ffe9c8', 0.85);
    }

    if (e.hp <= 0) this.killEnemy(e);
  }

  splashDamage(b) {
    const zR = b.splash * 2;
    const xR = b.splash * 1.6;
    for (const e of this.enemies) {
      if (e.dead || b.hitSet.has(e.id)) continue;
      if (Math.abs(e.z - b.z) > zR || Math.abs(e.x - b.x) > xR) continue;
      b.hitSet.add(e.id);
      e.hp -= b.dmg * CFG.weapon.splashDamageMul;
      e.hurtT = 0.07;
      if (e.hp <= 0) this.killEnemy(e);
    }
  }

  updatePulse(dt) {
    if (this.weapon.pulse <= 0) return;
    this.pulseT -= dt;
    if (this.pulseT > 0) return;
    this.pulseT = CFG.weapon.pulseInterval;

    const dmg = CFG.weapon.pulseDamage + CFG.weapon.pulseDamagePerStack * (this.weapon.pulse - 1);
    this.rings.push({ x: this.player.x, z: this.player.z + 1.4, t: 0, life: 0.5, maxR: 0.55, color: '#7df9ff' });
    this.sfx.bomb();
    this.shake = Math.max(this.shake, 12);
    for (const e of this.enemies) {
      if (e.dead) continue;
      e.hp -= dmg;
      e.hurtT = 0.1;
      if (e.hp <= 0) this.killEnemy(e);
    }
  }

  // ---------------------------------------------------------
  //  掉落 / 粒子 / 飘字 / 冲击环
  // ---------------------------------------------------------

  updateOrbs(dt) {
    const pl = this.player;
    // 只有还在打的时候能捡：否则结算界面弹出后，
    // 还在飞的掉落会被继续吸走并加分，结算面板上的分数就不是最终分。
    const canPick = this.state === STATE.FIGHT || this.state === STATE.PREP;
    for (const o of this.orbs) {
      o.life -= dt;
      o.phase += dt * 4;
      const dx = pl.x - o.x;
      const dz = pl.z - o.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) {
        const step = Math.min(dt * 3.4, d);
        o.x += (dx / d) * step;
        o.z += (dz / d) * step;
      }
      if (canPick && Math.abs(dx) < 0.09 && Math.abs(dz) < 0.7) {
        o.life = -1;
        if (pl.hp < pl.maxHp) {
          pl.hp += 1;
          this.addPopup(pl.x, pl.z + 1.2, '+1 生命', '#7dff9b', 1.15);
        } else {
          this.score += 25;
          this.addPopup(pl.x, pl.z + 1.2, '+25', '#7dff9b');
        }
        this.sfx.pickup();
      }
    }
    this.orbs = this.orbs.filter((o) => o.life > 0);
  }

  spawnParticles(x, z, n, kind, color) {
    if (this.particles.length > 420) n = Math.min(n, 3);
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = kind === 'blood' ? rand(0.5, 2.0) : rand(0.3, 1.2);
      this.particles.push({
        x,
        z,
        h: rand(0.02, 0.14),
        vx: Math.cos(a) * sp * 0.5,
        vz: Math.sin(a) * sp * 0.5,
        vh: rand(0.3, 1.7),
        life: rand(0.25, 0.65),
        size: kind === 'blood' ? rand(0.005, 0.012) : rand(0.003, 0.008),
        color,
        add: kind !== 'blood',
      });
    }
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.h += p.vh * dt;
      p.vh -= 6.5 * dt;
      if (p.h < 0) {
        p.h = 0;
        p.vh *= -0.26;
        p.vx *= 0.6;
        p.vz *= 0.6;
      }
      p.vx *= 0.965;
      p.vz *= 0.965;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  addPopup(x, z, text, color, scale = 1) {
    const p = this.cam.project(x, z);
    this.popups.push({ sx: p.x, sy: p.y, t: 0, life: 0.9, text, color, scale });
  }

  updatePopups(dt) {
    for (const q of this.popups) {
      q.t += dt;
      q.sy -= dt * (30 + 22 * q.scale);
    }
    this.popups = this.popups.filter((q) => q.t < q.life);
  }

  updateRings(dt) {
    for (const r of this.rings) r.t += dt;
    this.rings = this.rings.filter((r) => r.t < r.life);
  }

  // ---------------------------------------------------------
  //  存档
  // ---------------------------------------------------------

  _loadBest() {
    try {
      return parseInt(localStorage.getItem(CFG.storageKey) || '0', 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  _saveBest() {
    try {
      localStorage.setItem(CFG.storageKey, String(this.best));
    } catch (e) {
      /* iOS 无痕模式下 localStorage 会抛异常，忽略即可 */
    }
  }

  _loadCoins() {
    try {
      return Math.max(0, parseInt(localStorage.getItem(CFG.coinKey) || '0', 10) || 0);
    } catch (e) {
      return 0;
    }
  }

  _saveCoins() {
    try {
      localStorage.setItem(CFG.coinKey, String(this.coins));
    } catch (e) {}
  }

  /** 已通关到第几关（主界面的"关卡"按钮以后用它做进度） */
  _loadProgress() {
    try {
      return Math.max(0, parseInt(localStorage.getItem(CFG.progressKey) || '0', 10) || 0);
    } catch (e) {
      return 0;
    }
  }

  _saveProgress() {
    try {
      localStorage.setItem(CFG.progressKey, String(this.clearedLevel));
    } catch (e) {}
  }
}
