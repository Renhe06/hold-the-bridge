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

import { CFG, UPGRADES, WEAPON_TIERS, OFFENSIVE_KEYS, isHordeWave, isBossWave, waveKind, waveTuning, specialWave, setLevel, findLevel, isPvz, pvzPlant, heroZRange } from './config.js';
import { clamp, rand, pickWeighted } from './util.js';

export const STATE = {
  START: 'start',
  PREP: 'prep', // 备战：奖励门滑过来的这段时间
  TALK: 'talk', // 第二关的进场对话（看完才开打）
  FIGHT: 'fight',
  OVER: 'over', // 桥头失守
  CLEAR: 'clear', // 通关（结算金币）
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
    // 波型（割草 / 紧张）挂在本波上的临时倍率与横幅文案，见 startWave
    this.waveSpeedMul = 1;
    this.waveTag = null;
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
    this.mines = []; // 第二关的水雷（吃到"布水雷"奖励后每波撒几颗）
    this.mineStacks = 0;
    this.mineSeq = 0;
    this.plane = null; // 空袭时横穿夜空的轰炸机
    this.shout = null; // 角色当前喊的那句话（连杀里程碑等）
    this.mod = null; // 本波词条
    this.lastMod = null;
    this.fogMul = 1;

    // ---- 第三关（疯狂草坪）专属状态 ----
    // lanes：**每一"条"弹道自己的属性**（'' / 'ice' / 'fire'）。
    // 用户 m02771 要求奖励墙的寒冰/炎火"只改变一条弹道"，所以属性必须存在
    // 弹道这一层，而不是像液氮弹/燃烧弹那样挂在武器全局 w.ice/w.burn 上。
    this.lanes = ['', '', '', '', '', ''];
    this.suns = []; // 天上掉下来的阳光（走过去自动捡）
    this.sunT = 0; // 下一个阳光还有多久掉下来
    this.sunSeq = 0; // 掉过多少个了（每 N 个来一个大的）
    this.sunWaveStacks = 0; // "向日葵"奖励：每波开局直接掉几个
    this.sunMul = 1; // "阳光充沛"：一个阳光充多少能量
    this.sunAtk = 0; // 【m02004】阳光的攻击加成（0.06/个，上限 CFG.pvz.sun.atkMax）
    this.cherries = []; // 樱桃炸弹（第三关的大招，取代飞机轰炸）
    this.cherryMul = 1; // "巨型樱桃"：炸开范围倍率
    this.alertT = 0; // 开场"警报 + 3 2 1"还剩多久
    this.alertStep = 0; // 当前喊到的数字（0 = 只有警报，还没开始倒数）
    this._alertSaid = 0; // 上一次响过的数字（换数字才响一声）

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

  /**
   * 开始新一局（点击"开始挑战"/"再来一局"/选关时调用）。
   * levelIdx 省略 = 用当前关卡；主界面"开始挑战"永远传 0（第一关）。
   */
  newRun(levelIdx) {
    this.beginLevel(levelIdx == null ? CFG.levelIndex : levelIdx);
  }

  /**
   * 进某一关：有关卡自己的进场对话（CFG.level.intro）就先停在 STATE.TALK，
   * 玩家点「疯狂水世界 · 启动！」再 releaseTalk() 开打；没有对话的直接进备战。
   * 选关面板、结算面板的「下一关」、主界面「开始挑战」现在都走这一个入口。
   */
  beginLevel(idx) {
    setLevel(idx);
    // 第三关的开场警报只在"这一局第一次进这一关"时放一次。这个标记故意
    // 不放在 reset() 里 —— reset() 每一波都会调，放进去就会波波响警报。
    this._pvzIntroShown = false;
    this._pvzGateWait = false;
    if (CFG.level.intro) {
      this.reset();
      this.state = STATE.TALK;
      return;
    }
    this.startPrep();
  }

  /** 备战：第一波之前也给一对奖励门，让玩家在没压力时先学会"走位选奖励" */
  startPrep() {
    this.reset();
    this.state = STATE.PREP;
    this.prepT = CFG.wave.prepTime;
    this.pulseT = CFG.weapon.pulseInterval;
    // 第三关开场：模仿植物大战僵尸的关卡开场 —— 先拉警报，再喊 3 / 2 / 1。
    // 警报时间会撑进备战时间里，所以玩家听得完也不会被扣时间。
    // 开场这一对奖励门**等倒数喊完再开**：不然两块面板糊在大字 3 上，两边都看不清。
    if (isPvz() && !this._pvzIntroShown) {
      this._pvzIntroShown = true;
      const A = CFG.pvz.alert;
      this.alertT = A.alarm + A.step * 3;
      this.alertStep = 0;
      this._alertSaid = 0;
      this._pvzGateWait = true;
      this.prepT = Math.max(this.prepT, this.alertT + CFG.pvz.alert.calm);
      this.say('警报！僵尸来了！', '#ffd23f', 2.4);
      this.sfx.alarm();
    } else {
      this.openGates();
    }
  }

  /** 进场对话看完 → 照常备战 */
  releaseTalk() {
    if (this.state !== STATE.TALK) return;
    this.startPrep();
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

  /**
   * HUD 上显示的武器称号。
   * 第三关按**弹道数**报植物名（豌豆射手 / 双发射手 / 三线射手 / 机枪豌豆 /
   * 玉米加农炮 —— 用户 m02771："弹道 +1 换双头豌豆射手，以此类推"），
   * 其他关卡还是原来的制式弹/强化弹/等离子/毁灭者。
   */
  get weaponLabel() {
    if (isPvz()) return pvzPlant(this.weapon.bullets).name;
    return this.tier.name;
  }

  /**
   * 【m02004】阳光带来的攻击倍率（1 = 没捡过阳光）。
   * 子弹和 BOSS 血量校准（estimateDps）都走这里 —— 不然"阳光越捡越猛"
   * 会让 BOSS 战变成几秒秒杀，20 秒的消耗战设计就废了。
   */
  atkMul() {
    return 1 + (this.sunAtk || 0);
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
    const [zMin, zMax] = heroZRange();
    this.player.targetZ = clamp(wz, zMin, zMax);
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
      // 第三关开场：警报响完开始喊 3 / 2 / 1（每换一个数字响一声）
      if (this.alertT > 0) {
        const A = CFG.pvz.alert;
        this.alertT = Math.max(0, this.alertT - dt);
        const e = A.alarm + A.step * 3 - this.alertT;
        this.alertStep =
          e < A.alarm ? 0 : Math.max(1, Math.min(3, 4 - Math.ceil((e - A.alarm) / A.step)));
        if (this.alertStep !== this._alertSaid) {
          this._alertSaid = this.alertStep;
          if (this.alertStep > 0) this.sfx.countdown(this.alertStep);
          else this.sfx.alarm();
        }
        // 倒计时喊完（alertT 归零）才把开场那一对奖励门推出来
        if (this.alertT === 0 && this._pvzGateWait) {
          this._pvzGateWait = false;
          this.openGates();
        }
      }
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
      this.updateSuns(dt); // 第三关：阳光往下掉 + 走过去捡
      this.updateCherries(dt); // 第三关：樱桃炸弹的引信
    }
    if (fighting) {
      this.updateEnemies(dt);
      this.updateMines(dt);
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

    // 每 modEvery 波来一个词条（落在每组的第二波上：w % 3 === 2，见 config 的 modPhase）
    this.mod = w % CFG.modEvery === CFG.modPhase ? this.rollMod() : null;
    const M = this.mod;

    // ---- 波型：2 波割草 + 1 波紧张（见 CFG.wave.cycle / mow / tense）----
    // 紧张波落在第 3 / 6 / 9 / 12 / 15 波；词条压在前一波（第 2 / 5 / 8 / 11 / 14 波），
    // 所以三波一组的节奏是"扫草 → 有花样 → 精英带队"。
    const kindName = waveKind(w);
    const T = waveTuning(w); // 这一波的波型参数块（割草 / 紧张）
    const S = specialWave(w); // 关卡专属大场面（第 8 / 13 波）
    // 浓雾：词条"血月浓雾"与第一关专属的"迷雾压桥"都压能见度
    this.fogMul = (S && S.fog) || (M && M.fog) || 1;

    let count = this.waveCount(w);

    // 人海波：铺一片一枪一个的小兵。BOSS 只在最后一波来（见 config 的波型判定），
    // 所以第 5 / 10 波是"割草波"，不夹带 BOSS。
    const hordeWave = isHordeWave(w);
    const bossWave = isBossWave(w);
    // 人海波另外铺一片人海（spawnHorde），所以常规出怪砍到三分之一
    if (hordeWave) count = Math.max(3, Math.round(count * CFG.bossHorde.queueMul));

    // 特殊怪的概率倍率：割草波少出（专心扫小兵）、紧张波多出（精英混编）
    const sm = (T && T.specialMul) || 1;
    const queue = [];
    for (let i = 0; i < count; i++) {
      let kind = 'walker';
      if (S && S.kind) {
        // 专属大场面：这一波就是同一种怪（狂奔潮 / 鲨鱼群 / 铁桶潮…）
        kind = S.kind;
      } else if (M && M.allRunner) {
        // 词条"疾行者"：几乎全是跑步的，节奏立刻变快
        kind = w >= CFG.bruteFrom && Math.random() < 0.14 ? 'brute' : 'runner';
      } else {
        if (w >= CFG.runnerFrom && Math.random() < Math.min(0.4, 0.1 + w * 0.02)) kind = 'runner';
        if (w >= CFG.bruteFrom && Math.random() < Math.min(0.5, Math.min(0.26, 0.05 + w * 0.015) * sm)) kind = 'brute';
        if (w >= CFG.spitterFrom && Math.random() < Math.min(0.5, 0.13 * sm)) kind = 'spitter';
        if (w >= CFG.shieldedFrom && Math.random() < Math.min(0.5, 0.13 * sm)) kind = 'shielded';
        if (w >= CFG.splitterFrom && Math.random() < Math.min(0.5, 0.11 * sm)) kind = 'splitter';
      }
      queue.push(kind);
    }
    // 特殊怪保证有戏份：该出场之后的每一波至少来一只
    // （专属大场面那一波本来就只有一种怪，不加"保底"）
    if (!S && w >= CFG.spitterFrom && !queue.includes('spitter')) queue.push('spitter');
    if (!S && w >= CFG.splitterFrom && !queue.includes('splitter')) queue.push('splitter');

    // BOSS 不走常规出怪队列：它和人海同一帧出场（见下面 spawnHorde），
    // 所以这里不再 queue.push('boss')
    this.spawnQueue = queue;
    this.spawnT = 0;
    // 出怪间隔：基础值随波次缩短，再乘波型倍率（割草来得更快、紧张慢慢压）
    this.spawnGap = Math.max(W.spawnGapMin, W.spawnGap - (w - 1) * W.spawnGapDecay) * ((T && T.gapMul) || 1);
    // 波型的速度倍率（紧张波 1.08：跑得更急），spawnEnemy 里统一乘上
    this.waveSpeedMul = ((T && T.speedMul) || 1) * ((S && S.speedMul) || 1);

    if (this.player.shieldPerWave > 0) {
      this.player.shield = Math.min(6, this.player.shield + this.player.shieldPerWave);
    }

    // 第二关专属玩法：吃到"布水雷"奖励后，每波开局在桥面上撒几颗
    if (CFG.level.skin === 'ocean' && this.mineStacks > 0) this.placeMines();

    // 第三关专属玩法：每波开局把阳光计时清零；吃到"向日葵"就当场多掉几个
    if (isPvz()) {
      this.sunT = CFG.pvz.sun.first;
      for (let i = 0; i < this.sunWaveStacks; i++) this.spawnSun(true, i * 0.4);
    }

    this.state = STATE.FIGHT;
    this.waveBanner = bossWave ? 2.8 : hordeWave ? 2.5 : M ? 2.4 : 2.2;
    this.pulseT = CFG.weapon.pulseInterval;
    // 横幅副标题：一句话说清"这一波是什么"（BOSS / 专属大场面 / 人海 / 精英 / 割草），
    // render 只负责照着画，不再自己按波数判断
    this.waveTag = bossWave
      ? { text: 'BOSS 来袭', color: '#ff5a4a' }
      : S
        ? { text: S.label, desc: S.desc, color: S.color || '#ffd166' }
        : hordeWave
          ? { text: '尸 潮 来 袭', color: '#8bf58b' }
          : kindName === 'tense'
            ? { text: '精 英 波', desc: '皮厚一倍 · 带队一只精英', color: '#ffd166' }
            : { text: '割 草 波', desc: '一枪一个 · 放心扫', color: '#8bf58b' };
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
    // 紧张波：队里压阵的那只"精英"（血厚、体型大、分高，脚下一圈金环）。
    // BOSS 波不另出精英 —— 那一波已经有主角了。
    if (kindName === 'tense' && !bossWave) {
      this.spawnElite(w);
      this.sfx.alarm();
      this.say('精英来了！', '#ffd166');
    }
  }

  /**
   * 紧张波的"领队精英"：一只血厚、体型大、分数高的怪（脚下一圈金环，见 render）。
   * 倍数统一读 CFG.wave.tense，别把 1.9 / 1.18 / 3 这些数字写死在两处。
   * 种类读 CFG.wave.tense.eliteLadder（按波次升级：跑步的 → 巨人）。
   */
  spawnElite(w) {
    const T = CFG.wave.tense;
    const ladder = T.eliteLadder || [[0, 'walker']];
    const kind = (ladder.find(([from]) => w >= from) || [0, 'walker'])[1];
    const e = this.spawnEnemy(kind, null, null, T.eliteHpMul);
    e.elite = true;
    e.size *= T.eliteSizeMul;
    e.halfW *= T.eliteSizeMul;
    e.biteHalfW *= T.eliteSizeMul;
    e.zdepth *= T.eliteSizeMul;
    // 体型大了就站远一点，别糊在玩家脸上；分数按 eliteScoreMul 补上
    e.stopGap += 0.35;
    e.stopZ = CFG.zNear + e.stopGap + e.stopJit;
    e.score = Math.round(e.score * T.eliteScoreMul);
    return e;
  }

  /**
   * 【m02762】"每过一波，怪比上一波更厚 2%"的复利因子（第 1 波 = 1）。
   * 之所以做成方法：人海 / BOSS 崽子（要"一枪一个"）得在 hpScale 里把它约掉，
   * 测试也要按同一个出处核对，不能各写一遍公式。
   */
  hpGrow() {
    return Math.pow(1 + CFG.wave.hpWaveGrow, this.wave - 1);
  }

  /**
   * 某一波的出怪数量。【m02762】关卡可以用 levels[].countPerWave 覆盖"每波加几只"，
   * 用 levels[].countMax / countMaxPerWave 覆盖"单波上限"（第三关的上限也跟着波次涨，
   * 免得第 12 波就顶到 26 这个全局上限、后期只剩血量在涨）。
   * 人海波的"砍到三分之一"在外面做（见 startWave）。
   */
  waveCount(w) {
    const W = CFG.wave;
    const L = CFG.level || {};
    const T = waveTuning(w);
    const S = specialWave(w);
    const per = L.countPerWave || W.countPerWave;
    // 第一波出几只：关卡可以用 levels[].firstCount 单独定（第三关 8）
    const first = L.firstCount || W.firstCount;
    let cap = L.countMax || W.maxCount;
    if (L.countMaxPerWave) cap += (w - 1) * L.countMaxPerWave;
    const M = this.mod;
    // 波型倍率（割草 ×1.45 多而脆、紧张 ×0.78 少而厚）+ 专属大场面自己的倍率
    const mul = ((T && T.countMul) || 1) * ((S && S.countMul) || 1);
    const n = Math.round(Math.min(cap, first + (w - 1) * per) * ((M && M.countMul) || 1) * mul);
    // levels[].countDiff：关卡整体难度里的"出怪量"那一半（第三关 m01503 要 +30%）
    return Math.max(1, Math.round(n * (L.countDiff || 1)));
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
    // 除上 levels[].diff：spawnEnemy 会把 diff 乘回血量，人海要的是"正好 hpTarget 点血"，
    // 所以这里先把它约掉 —— 否则第三关（diff 1.3）的人海就不是一枪一个了。
    // 【m02762】每波的 +2% 复利也一并约掉：人海是给你割草的，不能越到后面越皮厚。
    // 波型的血量倍率（割草 ×0.6）同样约掉：人海永远"正好一枪一个"。
    const T = waveTuning(w);
    const hpScale = H.hpTarget / (baseHp * ((this.mod && this.mod.hpMul) || 1) * ((T && T.hpMul) || 1) * ((CFG.level && CFG.level.diff) || 1) * this.hpGrow());
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

  // ---------------------------------------------------------
  //  第二关专属玩法：水雷 / 河豚
  // ---------------------------------------------------------

  /**
   * 布水雷：吃到"布水雷"奖励后每波开局撒一批（mineStacks 可叠加）。
   * 横向别贴边（贴边玩家绕一下就没用），纵向撒在桥面中段，
   * 让"提前投资"真的有回报：怪物一头撞上来。
   */
  placeMines() {
    const M = CFG.mine;
    const roadHalf = this.cam.roadHalf;
    const n = Math.min(18, M.count * this.mineStacks);
    // 纵向必须撒在英雄"前面的走廊"里：z 比英雄还小的话，
    // 水雷会跑到镜头和英雄之间，一颗浮球能被放大到糊满整个屏幕（踩过）。
    const z0 = Math.max(M.zFrom, this.player.z + 2.4);
    const z1 = Math.max(z0 + 1, M.zTo);
    for (let i = 0; i < n; i++) {
      this.mines.push({
        id: (this.mineSeq += 1),
        x: rand(-0.72, 0.72) * roadHalf,
        z: rand(z0, z1),
        t: 0,
        life: M.live,
        dead: false,
        phase: rand(0, Math.PI * 2),
      });
    }
    this.addPopup(this.player.x, this.player.z + 2.4, '水雷已布好', '#7df9ff', 1.2);
  }

  /** 水雷：谁先踩上来就炸谁（一颗只炸一次），到点没炸就失效 */
  updateMines(dt) {
    if (!this.mines.length) return;
    for (const m of this.mines) {
      if (m.dead) continue;
      m.t += dt;
      if (m.t >= m.life) {
        m.dead = true;
        this.spawnParticles(m.x, m.z, 6, 'spark', '#7df9ff');
        continue;
      }
      for (const e of this.enemies) {
        if (e.dead) continue;
        // 判定做得宽松一点：这是提前投资，不该因为怪恰好擦边而过就白布一颗
        if (Math.abs(e.z - m.z) > 0.5 + e.size * 0.5) continue;
        if (Math.abs(e.x - m.x) > 0.45 + e.size * 0.4) continue;
        m.dead = true;
        this.explodeMine(m);
        break;
      }
    }
    this.mines = this.mines.filter((m) => !m.dead);
  }

  /** 水雷爆炸：一圈水花 + 范围伤害（伤害数值见 CFG.mine） */
  explodeMine(m) {
    const M = CFG.mine;
    this.rings.push({ x: m.x, z: m.z, t: 0, life: 0.45, maxR: M.blastR * 1.5, color: '#7df9ff' });
    this.spawnParticles(m.x, m.z, 18, 'spark', '#7df9ff');
    this.flash = Math.max(this.flash, 0.22);
    this.shake = Math.max(this.shake, 9);
    this.sfx.bomb();
    this.addPopup(m.x, m.z, '水雷命中！', '#7df9ff', 1.15);
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (Math.abs(e.z - m.z) > M.blastR * 1.6 || Math.abs(e.x - m.x) > M.blastR) continue;
      e.hp -= M.damage;
      e.hurtT = 0.12;
      if (e.hp <= 0) this.killEnemy(e);
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
    const nb = Math.min(w.bullets, 6);
    // 【m02503】第三关带寒冰/炎火的那几条弹道会多发一颗效果弹；
    // 【m02633】这颗效果弹只有 30% 伤害（CFG.pvz.laneDmgMul），估算 DPS 按它算 ——
    // 不然 BOSS 血量校准会把冰火当成"火力翻倍"，血量虚高。
    const extra = isPvz() ? Math.min(this._flavoredLanes(), nb) * CFG.pvz.laneDmgMul : 0;
    const perShot = w.damage * crit * (nb + extra) * this.atkMul();
    const shots = 1 / Math.max(0.05, w.interval / w.rateMul);
    let dps = perShot * shots * 0.75; // 折算：BOSS 很大，但散开的弹道不会发发命中
    dps += (w.splash || 0) * 1.6 + (w.burn || 0) * 0.5 + (w.pulse || 0) * 0.4;
    return dps;
  }

  fitBossHp(b) {
    const K = CFG.kinds.boss;
    // levels[].diff 也作用在 BOSS 上（第三关 m01503 的 +30%：BOSS 战要多打 30% 的时间）
    const diff = (CFG.level && CFG.level.diff) || 1;
    const want = Math.round(clamp(this.estimateDps() * K.seconds, K.hpMin, K.hpMax) * diff);
    b.hp = want;
    b.maxHp = want;
    return b;
  }

  spawnBossAdds(boss, count) {
    const K = CFG.kinds.boss;
    const H = CFG.bossHorde;
    // 被动放崽子：僵王 2.2 秒一批，博士 3.2 秒一批（它自己还另有 2.5 秒的技能循环）
    boss.addT = boss.form === 2 ? CFG.pvz.boss2.addEvery : K.spawnEvery;
    // 场上的非 BOSS 怪到 aliveCap 就先不放 —— 但不能"放着不放"：
    // 旧值 22 会被人海（24 只）+ 队列的怪顶死，BOSS 就此哑火（用户 m01023 的"没事做"）。
    const alive = this.enemies.reduce((n, e) => n + (!e.dead && e.kind !== 'boss' ? 1 : 0), 0);
    if (alive >= (H.aliveCap || 22)) return;
    const baseHp = CFG.wave.baseHp + (this.wave - 1) * CFG.wave.hpPerWave;
    // 除上 levels[].diff：这里是"一枪一个"的脆皮崽子，血量要正好落在 hpTarget
    // 【m02762】每波的 +2% 复利同样约掉
    // 波型血量倍率（最后一波是紧张波 ×1.5）也约掉：崽子必须还是一枪一个
    const T = waveTuning(this.wave);
    const hpScale = H.hpTarget / (baseHp * ((CFG.level && CFG.level.diff) || 1) * ((T && T.hpMul) || 1) * this.hpGrow());
    const roadHalf = this.cam.roadHalf;
    const n = Math.max(1, count || K.spawnCount);
    for (let i = 0; i < n; i++) {
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

  // BOSS 必杀：先在"你现在站的地方"画一个预警圈（render 里画），
  // warn 秒后砸下来；落点是开火那一刻定死的，所以走开就是躲开了。
  // 什么时候放见 updateBoss：出场一次、半血一次（用户 m01503）。
  // opts.count > 1 时是"导弹阵"：几颗横向错开、落地时间也错开（stagger），
  // 中间留缝给你钻 —— 站着不动照样死，但挪对方向就能全躲开。
  bossFire(boss, opts) {
    const M = CFG.bossMissile;
    const S = CFG.bossSkill;
    const n = Math.max(1, (opts && opts.count) || 1);
    const spread = (opts && opts.spread) || 0;
    const stagger = (opts && opts.stagger) || 0;
    const pl = this.player;
    const half = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      const dx = (i - half) * spread;
      this.warns.push({
        x: clamp(pl.x + dx, -this.cam.roadHalf, this.cam.roadHalf),
        z: pl.z,
        t: 0,
        life: M.warn + i * stagger,
        fromZ: boss.z,
      });
    }
    this.sfx.missileWarn();
    this.addPopup(boss.x, boss.z - 0.6, n > 1 ? `${n} 连导弹来袭` : '导弹来袭', '#ff5a3a', 1.15);
  }

  /**
   * BOSS 每帧的技能账（用户 m01503），在所有形态下都从 updateEnemies 里调一次：
   *  - 变身演出中（evolveT > 0）：不动、不打、不咬，返回 'frozen' 让调用方 continue；
   *  - 第二形态（僵尸博士）：技能按 boss2.skills 轮着放；
   *  - 第一形态：出场 0.9 秒后放一发（教学），半血再放一发导弹阵（升级），
   *    之后按 every / everyHalf 秒反复放（用户 m01023：别让 BOSS 放完两发就哑火）。
   */
  updateBoss(e, dt) {
    const S = CFG.bossSkill;
    if (e.evolveT > 0) {
      e.evolveT -= dt;
      e.hurtT = Math.max(e.hurtT, 0.05); // 变身期间一直白闪
      // 变身这 1.8 秒调用方会 continue，跳过循环末尾那句 hp<=0 的判定 ——
      // 这里补一次（燃烧/空袭残留伤害还能把它打死，别让它悬在死亡线上不动）
      if (e.hp <= 0) this.killEnemy(e);
      return 'frozen';
    }
    if (e.form === 2) {
      const B = CFG.pvz.boss2;
      e.skillT -= dt;
      if (e.skillT <= 0) {
        e.skillT = B.skillEvery;
        this.bossSkill2(e);
      }
      return 'ok';
    }
    // ---- 第一形态（僵王 / 鲨鱼王）：出场一发教学 → 半血立刻补一发导弹阵 →
    // 之后按 bossSkill.every / everyHalf 反复施压（用户 m01023："更频繁放技能"）。
    // 以前是 casts 数到 2 就彻底哑火，BOSS 战后半段只剩站桩对射，玩家没事做。
    e.skillT -= dt;
    if (e.casts === 0) {
      if (e.skillT <= 0) {
        e.casts = 1;
        e.skillT = S.every;
        this.bossFire(e, { count: S.spawnCount, spread: S.spawnSpread });
      }
      return 'ok';
    }
    // 半血：不管计时器走到哪，立刻升级成导弹阵，并且此后换成更密的节奏
    if (e.casts === 1 && e.hp <= e.maxHp * S.hpAt) {
      e.casts = 2;
      e.skillT = S.everyHalf;
      this.bossFire(e, { count: S.halfCount, spread: S.halfSpread, stagger: S.stagger });
      return 'ok';
    }
    if (e.skillT <= 0) {
      e.casts += 1;
      const half = e.casts >= 2;
      e.skillT = half ? S.everyHalf : S.every;
      this.bossFire(
        e,
        half
          ? { count: S.halfCount, spread: S.halfSpread, stagger: S.stagger }
          : { count: S.spawnCount, spread: S.spawnSpread }
      );
    }
    return 'ok';
  }

  /** 僵尸博士的技能循环：导弹阵 / 召崽子 / 火球齐射（用户 m01503 的"技能更多"） */
  bossSkill2(e) {
    const B = CFG.pvz.boss2;
    const kind = B.skills[e.skillIdx % B.skills.length];
    e.skillIdx += 1;
    if (kind === 'missile') {
      this.bossFire(e, { count: B.missileCount, spread: B.missileSpread, stagger: B.missileStagger });
    } else if (kind === 'summon') {
      for (let i = 0; i < B.summonCount; i++) this.spawnBossAdds(e, CFG.kinds.boss.spawnCount);
      this.sfx.bossSummon();
      this.addPopup(e.x, e.z - 0.6, '召唤尸潮', '#8bf58b', 1.2);
    } else if (kind === 'fireball') {
      this.doctorFireballs(e);
    }
  }

  /** 火球齐射：横铺整条路的一大排火球（速度比酸液慢，看得清、走得开） */
  doctorFireballs(e) {
    const B = CFG.pvz.boss2;
    const n = B.fireballCount;
    const half = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      this.spits.push({
        x: (i - half) * B.fireballGap,
        z: e.z - e.size * 0.25,
        vz: -B.fireballSpeed,
        phase: rand(0, Math.PI * 2),
        color: B.fireballColor,
        hot: true,
        dead: false,
      });
    }
    this.sfx.fireball();
    this.spawnParticles(e.x, e.z - e.size * 0.4, 14, 'spark', B.fireballColor);
    this.addPopup(e.x, e.z - 0.6, '火球齐射', B.fireballColor, 1.2);
  }

  /**
   * 第三关 BOSS 进化（用户 m01503）：第一条血清空 → 不死了，变身成"僵尸博士"。
   * 视觉上它被白光和冲击环推回草坪深处（zFar - 4），然后**只走到一半**就停下：
   * 停线取"变身点 → 英雄"的中点并冻结（frozenStop），所以它永远够不着你，
   * 威胁全部改成技能（导弹阵 / 召唤 / 火球）。第二条血按 boss2.hpMul 重算。
   */
  evolveBoss(e) {
    const B = CFG.pvz.boss2;
    const K = CFG.kinds.boss;
    const pl = this.player;
    e.form = 2;
    e.maxHp = Math.max(1, Math.round(e.maxHp * B.hpMul));
    e.hp = e.maxHp;
    e.size = K.size * B.sizeMul;
    // 【m02128】博士比第一形态再快一点（它只走一半就得停下，得赶紧到岗）
    if (B.speedMul) e.speed *= B.speedMul;
    e.color = B.color;
    e.dark = B.dark;
    e.animal = B.animal;
    e.casts = 0;
    e.skillIdx = 0;
    e.skillT = B.firstSkill;
    e.evolveT = B.evolveTime;
    e.evolveDur = B.evolveTime;
    e.frozenStop = true;
    e.state = 'approach';
    e.atk = 'rest';
    e.addT = B.addEvery;
    // 推回草坪深处，然后只走到一半：停线 = 变身点与英雄位置的中点，之后不再跟着英雄走
    e.z = CFG.zFar - 4;
    e.stopZ = Math.min(CFG.zFar - 4, Math.max(pl.z + K.stopGap, (e.z + pl.z) * B.stopRatio));
    this.bossEvolves = (this.bossEvolves || 0) + 1;
    // 第一条血打完照样算一次"击杀"的战果：分数 + 能量 + 顿帧，玩家不会觉得白打了
    this.score += e.score;
    this.gainEnergy(CFG.charge.perBoss);
    this.hitStop = Math.max(this.hitStop, 0.22);
    this.flash = Math.max(this.flash, 0.9);
    this.shake = Math.max(this.shake, 30);
    for (let i = 0; i < 3; i++) {
      this.rings.push({ x: e.x, z: e.z, t: 0, life: 0.45 + i * 0.16, maxR: 2.2 + i * 1.1, color: i ? '#8bf58b' : '#ffffff' });
    }
    this.spawnParticles(e.x, e.z, 40, 'spark', '#b6ff5a');
    this.spawnParticles(e.x, e.z, 24, 'spark', '#ffffff');
    this.sfx.evolve();
    this.addPopup(e.x, e.z, `${B.name} 进化！`, '#8bf58b', 1.8);
    this.say('BWAHAHA!', '#8bf58b');
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
    // 用户 m02128：必杀技从"打中直接死"改成"打中掉 1 格血"（config hpCost）。
    // 护盾和无敌帧仍然挡不住 —— 它是必杀技，这一发必须躲；但代价只有一格血，
    // 没躲开也还有救，不至于一次失误就结束一整局。连杀照样断（贪和稳的张力不变）。
    if (pl.hp > 0 && Math.abs(pl.x - w.x) < M.radius && Math.abs(pl.z - w.z) < 1.1) {
      pl.hp -= M.hpCost;
      pl.hurt = 1;
      this.combo = 0;
      this.comboT = 0;
      this.flash = 1;
      this.shake = Math.max(this.shake, 22);
      this.addPopup(pl.x, pl.z + 0.7, `被导弹命中 -${M.hpCost}`, '#ff5a3a', 1.5);
      this.sfx.bite();
      if (pl.hp <= 0) this.gameOver();
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
    // levels[].diff：关卡整体的难度倍数（第三关 m01503 要 +30%），打在每只怪的血量上。
    // 人海波的 hpScale 走的是另一条路径（hpTarget / baseHp），所以它不受这里影响 ——
    // 人海仍然"一枪一个"，被加难的只是常规怪和 BOSS。
    const diff = (CFG.level && CFG.level.diff) || 1;
    // 【m02762】每波复利 +2%（见 CFG.wave.hpWaveGrow）：常规怪一起吃
    // 波型血量倍率：割草波 ×0.6（一枪一个才爽）、紧张波 ×1.5（每只都厚）
    const T = waveTuning(w);
    let hp = Math.max(1, Math.round(baseHp * K.hpMul * ((M && M.hpMul) || 1) * ((T && T.hpMul) || 1) * (hpScale || 1) * diff * this.hpGrow()));
    let speed = (W.zombieSpeed + Math.min(W.speedPerWaveMax, (w - 1) * W.speedPerWave)) * K.speedMul * (this.waveSpeedMul || 1);
    if (M && M.speedMul) speed *= M.speedMul;
    // 【m02128】关卡级的 BOSS 速度倍率（第三关的 BOSS 走得太磨蹭）：
    // 只打在 BOSS 身上，小兵的节奏不动。
    if (kind === 'boss' && CFG.level && CFG.level.bossSpeed) speed *= CFG.level.bossSpeed;

    // 每只怪自己的错位（错开站位，免得叠成一坨）。注意：**停下来的那条线
    // 必须是"英雄当前所在位置"往前一点，不能按固定基准位 zNear 算** ——
    // 英雄能前后走 ±(zBack/zFwd)，按 zNear 算的话，你往前走时丧尸就会从你
    // 身边（甚至身后）穿过去，看起来像"凭空出现在面前"（用户实测反馈）。
    //
    // 停多远由"种类"决定：吐酸者在远处喷酸、BOSS 太大要站得更远（贴脸会
    // 占满屏幕，玩家连自己在哪条车道都看不见），其他怪按基础值 + 一点随机。
    const stopGap = K.stopGap != null ? K.stopGap : K.spit ? CFG.spitter.gap : W.stopGap;
    const stopJit = K.spit || K.stopGap != null ? 0 : rand(0, W.stopJitter);

    // 第二关（海洋皮肤）：同一种怪换成"僵尸 + 海洋动物"的融合体 ——
    // 主色/暗色来自该怪海洋配色，animal 决定 render 里追加哪些动物部件
    // （鱼鳍、章鱼触手、蟹钳、鲨鱼背鳍与尖牙、河豚刺、龟壳、水母伞盖）。
    // 第三关（疯狂草坪）：同一套机制换成 PvZ 的僵尸（普通/撑杆/巨人/僵王/
    // 投石车/铁桶/小鬼），render 的 _pvzBits 按 animal 画领带、铁桶、小鬼之类。
    const SK = CFG.level.skin;
    const skin = SK === 'ocean' ? K.ocean || null : SK === 'pvz' ? K.pvz || null : null;

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
      color: skin ? skin.color : K.color,
      dark: skin ? skin.dark : K.dark,
      animal: skin ? skin.animal : null,
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
      // BOSS 的技能（用户 m01503）：出场放一次（casts 0→1）、半血再放一次（1→2）。
      // 以前是 missileFired 布尔量（整场只放一发），现在要放两次，所以改成计数器。
      casts: 0,
      skillT: CFG.bossSkill.onSpawnDelay,
      // 形态：form 1 = 第一条血；form 2 = 第三关进化出来的僵尸博士。
      // 注意**不能存进 e.phase**：那个字段是走路动画的相位（见下面的 updateEnemies）。
      form: 1,
      forms: kind === 'boss' && CFG.level && CFG.level.bossEvolve ? 2 : 1,
      evolveT: 0,
      evolveDur: 0,
      skillIdx: 0,
      frozenStop: false, // 第三关博士：停线冻结，不再跟着英雄往前（永远够不着你）
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
    // 备战时间跟着"下一波"的波型走：割草 1.7s（别断节奏）、紧张 3.0s（喘口气、想站位）
    const nextT = waveTuning(this.wave + 1);
    this.prepT = (nextT && nextT.prep) || CFG.wave.prepTime;
  }

  /**
   * 通关：按得分结算金币（比例见 CFG.level.coinRatio）。
   * 金币是"跨局"的，存在本地，留给主界面的商店花。
   * 第二关通关后 clearedLevel 变成 2，主界面的第三关才会"即将开放"。
   */
  levelClear() {
    const L = CFG.level;
    this.state = STATE.CLEAR;
    this.gates = null;
    this.shake = 20;
    this.flash = 0.9;
    const coins = Math.max(1, Math.round(this.score * L.coinRatio));
    this.coins += coins;
    this.clearedLevel = Math.max(this.clearedLevel, L.id);
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
      level: L.id,
      levelName: L.name,
      nextLevel: findLevel(L.id + 1) ? L.id + 1 : 0, // 下一关 id（没有就是 0）
    };
    this.sfx.victory();
    this.addPopup(0, this.player.z + 3, `${L.name}通关！+${coins} 金币`, '#ffd166', 2.0);
  }

  // ---------------------------------------------------------
  //  奖励门
  // ---------------------------------------------------------

  /** 从可用加成里抽两块，摆在桥的左右半边 */
  openGates() {
    // 关卡专属加成（l2 = 第二关的水雷/鱼雷，l3 = 第三关的寒冰/炎火/阳光）
    // 只在对应那一关的奖励门里出现；通用条目哪一关都在。
    // 第一关的奖励池保持原样，免得一关里突然冒出没见过的水雷/阳光。
    // 【m02503】寒冰/炎火在"所有弹道都带上属性"之后就不再出现 ——
    // 再给也没地方铺（_noteLane 只能去改中间那条），属于白给一次升级。
    const lanesFull = isPvz() && this._flavoredLanes() >= this._laneCount();
    const sk = CFG.level.skin;
    const pool = UPGRADES.filter((u) => {
      if (u.l2) return sk === 'ocean';
      if (u.l3) {
        if (sk !== 'pvz') return false;
        if (lanesFull && (u.id === 'iceLane' || u.id === 'fireLane')) return false;
        return true;
      }
      return true;
    });
    const avail = pool.filter((u) => (this.stacks[u.id] || 0) < u.max);
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
    // 【m02403】加权抽取：条目上的 weight 越大越容易抽中（没写按 1 算）。
    // 现在是给寒冰/炎火 3 倍权重，好让"冰火构筑"在这一关真的抽得出来。
    const left = wantBullets
      ? off.find((u) => u.id === 'bullets')
      : off.length
        ? pickWeighted(off)
        : pickWeighted(avail);
    const rest = avail.filter((u) => u.id !== left.id);
    const right = rest.length ? pickWeighted(rest) : left;
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
    if (a.mine) this.mineStacks += a.mine; // 第二关：每波布水雷

    // 第三关：寒冰/炎火只改【一条】弹道（见 _noteLane）；阳光与樱桃是资源线
    let laneIdx = -1;
    if (a.iceLane) laneIdx = this._noteLane('ice');
    if (a.fireLane) laneIdx = this._noteLane('fire');
    if (a.sunWave) this.sunWaveStacks += a.sunWave;
    if (a.sunMul) this.sunMul *= a.sunMul;
    if (a.cherryR) this.cherryMul *= a.cherryR;
    if (laneIdx >= 0) {
      const isIce = !!a.iceLane;
      const col = isIce ? CFG.pvz.ice.color : CFG.pvz.fire.color;
      this.addPopup(pl.x, pl.z + 3.1, `第 ${laneIdx + 1} 条弹道 · ${isIce ? '寒冰' : '炎火'}（一发两颗）`, col, 1.5);
      this.rings.push({ x: pl.x, z: pl.z + 1.2, t: 0, life: 0.5, maxR: 0.75, color: col });
    }

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

  /**
   * 弹道的"铺属性顺序"（用户 m02128）。
   * 原来是从左往右找第一条空的（0,1,2…），结果寒冰/炎火全堆在左边那几条 ——
   * 屏幕上看着明显偏向一边。现在从**中间那条**开始铺，然后"中间右边 → 中间左边"
   * 一条条往外扩散：3 条弹道是 [中, 右, 左]，4 条是 [中右, 中左, 最右, 最左]。
   * 一样近时右边优先（弹道序号越大越靠右，见 fire() 里的 spread 偏移）。
   */
  laneOrder(n) {
    const mid = (n - 1) / 2;
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    idx.sort((a, b) => {
      const da = Math.abs(a - mid);
      const db = Math.abs(b - mid);
      if (Math.abs(da - db) > 1e-9) return da - db;
      return b - a;
    });
    return idx;
  }

  /** 现在有几条弹道在开火（第三关的寒冰/炎火就是按它铺属性的） */
  _laneCount() {
    return Math.max(1, Math.min(this.lanes.length, Math.round(this.weapon.bullets)));
  }

  /** 已经带上寒冰/炎火的那几条弹道（【m02503】每条都会"一发两颗"） */
  _flavoredLanes() {
    const n = this._laneCount();
    let c = 0;
    for (let i = 0; i < n; i++) if (this.lanes[i]) c++;
    return c;
  }

  /**
   * 给"一条弹道"挂上寒冰 / 炎火（第三关的核心构筑，用户 m02771 要求）。
   * 优先找还没属性的那条（顺序见 laneOrder：中间先亮，再往两边扩）。
   * 【m02503】属性不再是"把这条弹道的子弹换成寒冰"，而是让这条弹道**一发吐两颗**
   * （一颗普通 + 一颗带效果，见 fire()）—— 所以铺满之后奖励门就不再给这两条了
   * （见 openGates 里的 lanesFull）。
   * 返回改的是第几条（0 起），没改到返回 -1。
   */
  _noteLane(kind) {
    const n = this._laneCount();
    const order = this.laneOrder(n);
    for (const i of order) {
      if (!this.lanes[i]) {
        this.lanes[i] = kind;
        return i;
      }
    }
    const lead = order[0];
    if (this.lanes[lead] !== kind) {
      this.lanes[lead] = kind;
      return lead;
    }
    return -1;
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
    const [zMin, zMax] = heroZRange();
    pl.z = clamp(pl.z, zMin, zMax);
    pl.targetZ = clamp(pl.targetZ, zMin, zMax);

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
    const raw = CFG.hero.fwdDamage * Math.max(0, this.player.z - CFG.zNear);
    return 1 + Math.min(raw, CFG.hero.fwdDamageMax);
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

    // 第三关的豌豆：**每条弹道的属性各自决定**（寒冰/炎火/普通绿豌豆）。
    // 其他关卡走原来的全局 w.ice / w.burn（液氮弹、燃烧弹）。
    const pvz = isPvz();

    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * CFG.weapon.spread;
      const lane = pvz ? this.lanes[i] || '' : '';
      // 【m02503】带属性的那条弹道"一发吐两颗"（用户：寒冰/炎火改成每次多吐一颗
      // 效果子弹，等于一次吐两颗）：第一颗还是普通豌豆，第二颗才是寒冰/炎火豌豆。
      // 第二颗往旁边错开一点，不然两颗完全重叠、屏幕上看不出多了一颗。
      const shots = lane ? 2 : 1;
      for (let k = 0; k < shots; k++) {
        const eff = k ? lane : ''; // 只有第二颗带寒冰/炎火
        const isCrit = Math.random() < w.crit;
        const bx = off + (k ? CFG.weapon.spread * 0.45 : 0);
        const bz = z0 + k * 0.06;
        this.bullets.push({
          x: this.cam.clampToRoad(pl.x + bx, 0),
          z: bz,
          pz: bz,
          vz: w.bulletSpeed,
          // 【m02633】效果弹只有正常豌豆的 30% 伤害（用户：不然又无敌了）
          dmg: w.damage * fwd * this.atkMul() * (isCrit ? w.critMul : 1) * (eff ? CFG.pvz.laneDmgMul : 1),
          crit: isCrit,
          pierceLeft: w.pierce,
          splash: Math.max(CFG.weapon.splash, w.splash, tier.splash),
          ice: pvz ? (eff === 'ice' ? 1 : 0) : w.ice,
          burn: pvz ? (eff === 'fire' ? 1 : 0) : w.burn,
          lane: eff, // 渲染器按它决定这颗豌豆的颜色（'' = 绿豌豆）
          hitSet: new Set(),
          dead: false,
          seed: rand(0, Math.PI * 2),
        });
      }
    }

    w.cd = Math.max(0.06, w.interval / w.rateMul);
    pl.recoil = 1;
    pl.muzzle = 1;
    if (pvz) this.sfx.pea();
    else this.sfx.shoot(w.tierIdx);
  }

  bite(e, dmg = 1) {
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

    pl.hp -= dmg;
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

      // BOSS 的技能账（出场一发 / 半血一发 / 博士的技能循环 / 变身演出）。
      // 旧写法把判定塞在"已经站定（attack）"那个分支里，而 BOSS 从 zFar-5 走到
      // 停下线要 10 秒上下，玩家常常在它停稳之前就把它打到 3/4 以下 —— 结果技能
      // 要么晚放、要么一次都不放（用户 m03130 在真机上测到就是这个）。
      // 放到循环开头就与站位无关了；变身演出期间直接 continue（不动不打不咬）。
      if (e.kind === 'boss' && this.updateBoss(e, dt) === 'frozen') continue;

      if (e.state === 'approach') {
        e.z -= e.speed * spd * dt;
        // 停下线跟着英雄走：英雄往前压，怪就在更前面停下，绝不会从身边穿过去。
        // 例外：第三关的博士（frozenStop）停线是变身时定死的，不再跟着英雄往前 ——
        // 用户 m01503 要的就是"走到一半就不再往前移动"。
        if (!e.frozenStop) e.stopZ = pl.z + e.stopGap + e.stopJit;
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
          // BOSS 太大（体型 1.2），所以它不贴身：站得远（stopGap 5）——
          // 真贴到脸上会占满整个屏幕，玩家连自己站在哪条车道都看不见。
          // 它的威胁不是咬人（够不着），而是"尸潮首领"这个身份：
          // 源源不断往身前放小兵，所以你得尽快把它打死。
          // 第三关的博士（frozenStop）：停线冻结，这里连横移都只做很小一点，
          // 免得它挪着挪着又蹭到跟前（用户 m01503：不再往前移动）。
          e.x += dir * W.drift * (e.frozenStop ? 0.18 : 0.35) * spd * dt;
          e.x = clamp(e.x, -this.cam.roadHalf, this.cam.roadHalf);
          if (!e.frozenStop) {
            const bz = pl.z + e.stopGap;
            const bStep = W.drift * spd * dt * 1.6;
            e.z += clamp(bz - e.z, -bStep, bStep);
          }
          e.addT -= dt;
          if (e.addT <= 0) this.spawnBossAdds(e);
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
    // 【用户 m01503】第三关 BOSS 的第一条血清空不是"死"，是进化成僵尸博士。
    // 必须在 e.dead = true 之前拦下来，否则它会先走一遍尸体/血泊/结算的流程。
    if (e.kind === 'boss' && e.form === 1 && e.forms > 1) {
      this.evolveBoss(e);
      return;
    }
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

    // 第二关（海洋皮肤）：吐酸者换成河豚 —— 打爆它会"鼓刺炸开"，
    // 贴脸打死就会连自己一起炸。这是"别站太前"的一条新压力，也是海洋玩法的爽点。
    if (alive && CFG.level.skin === 'ocean' && e.kind === 'spitter') {
      const P = CFG.puffer;
      this.rings.push({ x: e.x, z: e.z, t: 0, life: 0.42, maxR: P.blastR * 1.6, color: '#ffd166' });
      this.spawnParticles(e.x, e.z, 16, 'spark', '#ffd166');
      this.flash = Math.max(this.flash, 0.3);
      this.shake = Math.max(this.shake, 12);
      this.sfx.bomb();
      this.addPopup(e.x, e.z, '河豚炸开！', '#ffd166', 1.2);
      const pl = this.player;
      if (Math.abs(pl.z - e.z) <= P.blastR + 0.45 && Math.abs(pl.x - e.x) <= P.blastR) {
        this.bite(e, P.blastDmg);
      }
      // 顺手把周围的小怪也掀一下（爆炸就该是范围伤害）。
      // 河豚本身不参与连锁（否则一群河豚会互相引爆，瞬间雪崩）。
      for (const o of this.enemies) {
        if (o.dead || o === e || o.kind === 'spitter') continue;
        if (Math.abs(o.z - e.z) > P.blastR * 1.2 || Math.abs(o.x - e.x) > P.blastR * 0.8) continue;
        o.hp -= 1;
        o.hurtT = 0.12;
        if (o.hp <= 0) this.killEnemy(o);
      }
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
      this.addPopup(
        this.player.x,
        this.player.z + 2.2,
        isPvz() ? '樱桃炸弹就绪 · 点右下角' : '空袭就绪 · 点右下角',
        '#8bf58b',
        1.4,
      );
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

    // 第三关：大招不是空袭，而是植物大战僵尸里那个樱桃炸弹
    if (isPvz()) return this.triggerCherry();

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

  /**
   * 第三关的大招：樱桃炸弹（用户 m02771 要的 PvZ 味道）。
   * 不学空袭"从远到近犁一遍"，而是把一颗超大樱桃直接扔进**人堆中心**，
   * 引信 0.45 秒后炸开：范围比空袭宽得多，代价是只能炸一处、且要等引信。
   */
  triggerCherry() {
    const C = CFG.pvz.cherry;
    const live = this.enemies.filter((e) => !e.dead);
    let tx = this.player.x;
    let tz = this.player.z + 3.4;
    if (live.length) {
      tx = live.reduce((s, e) => s + e.x, 0) / live.length;
      tz = live.reduce((s, e) => s + e.z, 0) / live.length;
    }
    const r = C.radius * this.cherryMul;
    const zR = C.zRadius * this.cherryMul;
    this.cherries.push({
      x: clamp(tx, -this.cam.roadHalf, this.cam.roadHalf),
      z: clamp(tz, this.player.z + 0.9, CFG.zFar + 2),
      t: 0,
      fuse: C.fuse,
      r,
      zR,
      dmg: (C.damage + this.wave * 0.7) * this.strikeMul,
      phase: 0,
      dead: false,
    });
    this.sfx.whoosh();
    this.shake = Math.max(this.shake, 6);
    this.say('歪比巴布！', '#ff5a4a');
    this.addPopup(this.player.x, this.player.z + 5, '樱 桃 炸 弹', '#ff8a6a', 1.6);
    return true;
  }

  /** 樱桃炸弹：引信烧完就炸。落在哪炸哪，范围由 cherryMul 决定 */
  updateCherries(dt) {
    for (const c of this.cherries) {
      if (c.dead) continue;
      c.t += dt;
      c.phase += dt * 6;
      if (c.t >= c.fuse) {
        c.dead = true;
        this.explodeCherry(c);
      }
    }
    this.cherries = this.cherries.filter((c) => !c.dead);
  }

  explodeCherry(c) {
    this.rings.push({ x: c.x, z: c.z, t: 0, life: 0.6, maxR: c.r * 1.9, color: '#ff5a4a' });
    this.rings.push({ x: c.x, z: c.z, t: 0, life: 0.36, maxR: c.r, color: '#ffe0d2' });
    this.spawnParticles(c.x, c.z, 30, 'spark', '#ff7a4a');
    this.spawnParticles(c.x, c.z, 14, 'blood', '#7d1a1a');
    this.flash = Math.max(this.flash, 0.6);
    this.shake = Math.max(this.shake, 18);
    this.sfx.cherry();
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (Math.abs(e.z - c.z) > c.zR || Math.abs(e.x - c.x) > c.r) continue;
      e.hp -= c.dmg;
      e.hurtT = 0.14;
      e.z += 0.2; // 炸得往后一掀
      if (e.hp <= 0) this.killEnemy(e);
    }
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

  // ---------------------------------------------------------
  //  第三关：阳光（走过去捡，充能给樱桃炸弹）
  // ---------------------------------------------------------

  /**
   * 掉一个阳光。delay 是"过多少秒才开始落"（向日葵奖励一次掉几个时错开）。
   * byWave = 这一波开局直接掉的（不是天上自然飘下来的）。
   */
  spawnSun(byWave = false, delay = 0) {
    const S = CFG.pvz.sun;
    this.sunSeq += 1;
    const big = this.sunSeq % S.bigEvery === 0; // 每 5 个来一个大的
    this.suns.push({
      x: rand(-0.72, 0.72) * this.cam.roadHalf,
      z: this.sunZ(),
      t: -delay,
      fall: 1.25,
      live: S.live,
      big,
      byWave: !!byWave,
      phase: rand(0, Math.PI * 2),
      hold: S.hold, // 落地后的亮相停顿，停完开始吸附
      fly: 0, // 吸附进度 0→1（渲染用：抬起来飞进怀里）
      dead: false,
    });
  }

  /**
   * 阳光落在哪条 z 上。
   *
   * 【用户实测 bug】以前是 `player.z + rand(3.0, 8.5)`：英雄前后只能走
   * 1.8 / 2.8 世界单位，阳光却落在 3 米开外，屏幕上明明看得见，走到最前面
   * 还差着好几米 —— "阳光根本捡不到"。
   *
   * 现在只从 [英雄走得到的区间] 里挑点，并且离英雄至少 S.gap：
   * 理想是落在前面 1.8~3.6，夹到边界变成"贴脸"时（人已经在最前面/最后面），
   * 就改落在另一侧，保证每个阳光都要挪一两步才捡得到（走位 = 收益）。
   */
  sunZ() {
    const S = CFG.pvz.sun;
    const [zMin, zMax] = heroZRange();
    const lo = zMin + 0.35;
    const hi = zMax - 0.35;
    const pl = this.player.z;
    let z = clamp(pl + rand(S.aheadMin, S.aheadMax), lo, hi);
    if (Math.abs(z - pl) < S.gap) {
      // 夹完之后离人太近（站在区间两头就会这样）：掉到另一侧，逼你转身走两步
      z = pl > (lo + hi) / 2 ? clamp(pl - rand(S.gap + 0.6, S.gap + 1.6), lo, hi)
                             : clamp(pl + rand(S.gap + 0.6, S.gap + 1.6), lo, hi);
    }
    return z;
  }

  updateSuns(dt) {
    // 不是第三关就一个都不留（切关卡时可能还剩着上一关的）
    if (!isPvz()) {
      if (this.suns.length) this.suns = [];
      return;
    }
    const S = CFG.pvz.sun;
    // 自然掉落只在真正开打时走：备战、暂停、结算都不该攒阳光
    if (this.state === STATE.FIGHT) {
      this.sunT -= dt;
      if (this.sunT <= 0) {
        this.sunT = S.every;
        this.spawnSun();
      }
    }

    const pl = this.player;
    for (const s of this.suns) {
      s.t += dt;
      s.phase += dt * 2.2;
      if (s.t < 0) continue; // 还没开始落
      if (s.t < s.fall) {
        s.x += Math.sin(s.phase) * S.drift * dt; // 边落边飘
      } else if (s.hold > 0) {
        s.hold -= dt; // 【m01729】刚落地的亮相停顿
      } else {
        // 【用户 m01729】"阳光还是捡不到" → 改成落地自动吸附：
        // 停完就朝英雄飞，不再要求玩家把手指对准它（手机上根本对不准）。
        const ax = pl.x - s.x;
        const az = pl.z - s.z;
        const ad = Math.hypot(ax, az);
        if (ad > 1e-4) {
          const mv = Math.min(ad, S.magnet * dt);
          s.x += (ax / ad) * mv;
          s.z += (az / ad) * mv;
        }
        s.fly = Math.min(1, s.fly + dt * 3.4);
      }
      s.live -= dt;

      const dx = pl.x - s.x;
      const dz = pl.z - s.z;
      // 捡到的两种方式：① 人自己走过去踩上（老手感保留，抢在吸附前也能捡）
      //               ② 被吸附到身上（S.magnetPick 的距离之内就算到手）
      const onFoot = Math.abs(dx) < S.pickX && Math.abs(dz) < S.pickZ;
      const sucked = s.fly > 0 && Math.hypot(dx, dz) <= S.magnetPick;
      if (onFoot || sucked) {
        s.dead = true;
        const big = s.big ? S.bigMul : 1;
        const gain = S.charge * big * this.sunMul;
        this.gainEnergy(gain);
        // 【m02004】阳光 = 攻击加成：每捡一个永久 +S.atk（大的 ×bigMul），封顶 S.atkMax。
        // 这是"第 6 波打不过去"的解法：撑到中盘攻击力翻倍，越打越顺。
        const atkGain = S.atk * big * this.sunMul;
        this.sunAtk = Math.min(S.atkMax, this.sunAtk + atkGain);
        this.addPopup(s.x, s.z, `☀ 攻击 +${Math.round(atkGain * 100)}%`, '#ffe066', s.big ? 1.5 : 1.15);
        this.spawnParticles(s.x, s.z, s.big ? 12 : 6, 'spark', '#ffe066');
        this.sfx.sun();
      } else if (s.live <= 0) {
        s.dead = true;
      }
    }
    this.suns = this.suns.filter((s) => !s.dead);
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
