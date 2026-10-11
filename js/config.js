// ============================================================
//  《守桥》全局配置与升级表
//  所有可调数值集中在这里，方便后面调手感
// ============================================================

export const CFG = {
  // ---- 透视相机（世界单位：1 单位 ≈ 半个桥面宽）----
  // 注意：zFar/zNear 只取 4.6 倍而不是十几倍。原因是真实透视下
  // 近处物体的屏幕速度 ∝ 1/z²，深度比一大，丧尸贴脸时一帧能跨几百像素、
  // 看起来像瞬移，根本来不及反应。压扁深度比之后既有纵深又看得清。
  zNear: 10, // 英雄的基准深度（相机锚点）
  // 42 而不是 50：深度比越小，远处的丧尸在屏幕上越大。
  // 深度比 5 倍时出怪点上的丧尸只有十几像素高，几乎认不出是什么
  // （用户第二次反馈"僵尸还是太小了"，所以压深度 + 整体放大一起做）
  zFar: 42,
  deckFarZ: 400, // 桥面往远处画到哪（延伸进雾里，营造"桥很长"的错觉）
  // 桥面往近处画到哪。必须比英雄能退到的最近处还近，否则英雄脚底下会露出黑边
  // （v1 就是画到 zNear 为止，屏幕最下面 1/5 是空的）
  deckNearZ: 6.2,
  fogFrom: 0.0, // 雾的起始（相对 horizonY 的屏幕高度比例）
  fogTo: 0.16,
  camHeight: 1, // 相机离地高度（世界单位）
  horizonRatio: 0.2, // 地平线在屏幕高度的百分比
  playerRatio: 0.82, // 英雄投影在屏幕高度的百分比
  roadHalfWidthRatio: 0.47, // 桥面半宽 = 该比例 × 屏宽（在英雄所处深度上）

  // ---- 英雄（v1 是战车，用户反馈"换成英雄"，并且要能前后移动）----
  hero: {
    size: 0.21, // 身体高度（世界单位）：比普通丧尸大一档，凸出主角
    halfWidth: 0.075,
    speed: 7.2, // 横移跟手速度
    zSpeed: 5.2, // 前后跟手速度（比横移慢一点，前后是"微调"）
    zBack: 1.8, // 相对基准能后退多少世界单位
    zFwd: 2.8, // 相对基准能前进多少世界单位
    dragZScale: 0.62, // 纵向拖动 → 前后位移的换算折扣（1 = 完全 1:1）
    // 越靠前伤害越高：给"前进"一个理由，也和"靠前更危险"形成取舍
    fwdDamage: 0.07, // 每前进 1 世界单位的伤害加成
    fwdDamageMax: 0.196, // 加成封顶（= 第一关 2.8 × 0.07）。关卡可以给更宽的
    //                     活动范围（见 levels[].roam），但站前排的收益不跟着膨胀
    hp: 4,
    iframe: 0.8, // 被咬后的无敌时间
  },

  // ---- 奖励门 ----
  // 用户反馈：不要弹窗让玩家选。改成桥上左右各一块面板，
  // 各带一个加成（+ / × / − 三种运算），门滑到英雄面前时
  // "你人在桥的左半边就吃左边那块、右半边就吃右边"，用走位做选择。
  gate: {
    zStart: 34, // 从多远处滑过来
    speed: 7.6, // 滑动速度（世界单位/秒），到英雄面前约 3 秒，正好填满备战
    panelHalfRatio: 0.5, // 面板半宽 = 桥面半宽 × 该值（0.5 ⇒ 两块并排正好铺满桥面）
    height: 0.42, // 面板高度（世界单位）
    resolveGap: 0.4, // 滑到英雄前方这么近就结算
    preferBulletsUntil: 3, // 玩家弹道数不到这个值时，进攻门优先给"弹道 +1"（用户 m02668）
  },

  // ---- 主武器（第一版只有一把）----
  weapon: {
    interval: 0.3, // 开火间隔（秒）
    damage: 1, // 单发基础伤害
    pierce: 0, // 穿透次数
    bullets: 1, // 每轮弹道数
    spread: 0.16, // 多弹道时的散射（世界单位）
    bulletSpeed: 40, // 子弹 z 方向速度（世界单位/秒）
    bulletRadius: 0.016, // 子弹视觉半径（世界单位）
    hitHalfWidth: 0.05, // 命中判定的横向半宽（世界单位）
    crit: 0.05, // 基础暴击率
    critMul: 2.0, // 暴击倍率
    splash: 0, // 溅射 z 半范围（世界单位）
    splashDamageMul: 0.55,
    burnDps: 1.5, // 点燃每秒伤害（每层）
    burnTime: 3,
    iceSlow: 0.35, // 冰冻减速比例（每层，总上限见 iceSlowMax）
    iceSlowMax: 0.6,
    iceTime: 1.1,
    iceTimePerStack: 0.5,
    // 过载脉冲（自动 AOE）
    pulseInterval: 6.5,
    pulseDamage: 2,
    pulseDamagePerStack: 1.5,
  },

  // ---- 波次 ----
  wave: {
    firstCount: 5,
    countPerWave: 2,
    maxCount: 26, // 单波最多同时存在的敌人数（体型放大后重新调回 26：一群丧尸挤满桥面才是这个玩法该有的画面，也才有压迫感）
    baseHp: 2,
    hpPerWave: 1.05,
    spawnGap: 0.9, // 出怪间隔基准
    spawnGapMin: 0.16,
    spawnGapDecay: 0.032, // 每波缩短
    // 每几波来一片"人海"（桥面一次铺满一枪一个的小兵）——第 5 / 10 / 15 波。
    // 注意：人海波 ≠ BOSS 波。用户 m02586 问"BOSS 不是最后一波才出来吗"，
    // 所以从这一版起 BOSS 只在关卡最后一波（第 15 波）出场，中间两次只来人海。
    // 判定统一走下面的 isHordeWave() / isBossWave()，别再各自算 % 5。
    hordeEvery: 5,
    prepTime: 2.4, // 波次之间的备战时间
    zombieSpeed: 6.4,
    speedPerWave: 0.13,
    speedPerWaveMax: 2.4,
    // 站在桥头后的行为：慢慢横移追你 -> 蓄力 -> 扑击
    stopGap: 1.15, // 停在英雄前方多远（世界单位）
    stopJitter: 1.5, // 每个敌人的错位，避免重叠成一坨
    drift: 0.5, // 横移追人速度
    windup: 0.22, // 蓄力时间（给玩家反应窗口）
    lungeTime: 0.4, // 扑击持续时间
    lungeSpeed: 1.7, // 扑击横向速度
    lungeRange: 0.24, // 进入这个距离才会扑
    lungeRestMin: 1.3,
    lungeRestMax: 2.4,
    biteCooldown: 0.9,
  },

  // ---- BOSS 波：先在 BOSS 前面铺一片小兵 ----
  // 用户要的是"密密麻麻一大片小怪 + 一个巨大的 BOSS"。
  // 所以 BOSS 波不再只出一个大块头：在 BOSS 前方的桥面上一次性铺满
  // 一群脆皮小兵，一梭子扫倒一片 —— 这是最直接的爽感来源。
  bossHorde: {
    base: 16, // 第一个 BOSS 波的小兵数
    perLevel: 4, // 之后每个 BOSS 波再加几只
    maxCount: 28, // 上限（同屏太多会糊成一团，反而看不清）
    lanes: 4, // 横向几条车道：正好铺满桥宽又几乎不重叠
    spread: 0.86, // 车道铺到桥半宽的百分之多少
    zFrom: 4.5, // 最前面一排离 BOSS 出场位置多远
    zStep: 2.2, // 排与排之间的深度间隔
    // 目标血量（点数），不是倍率：代码里反算倍率让它们正好这么多血。
    // 第一版按倍率打折（基础血量 ×0.3），第 5 波算出来是 2 点血，
    // 基础武器 1 伤/0.3s 砍 16 只要 10 秒，而它们 4 秒就走到脸上 ——
    // 实测结果是被一群小兵围着咬掉 12 口，完全不是"割草"。
    // 固定 1 点血 = 一枪一个，这才是用户要的爽感（词条倍率仍会作用在它上面）。
    hpTarget: 1,
    // 人海走得比普通小兵慢（0.62 折）：它们是一大坨一起挤过来的，
    // 按原速 4 秒就顶到脸上，而"一枪一个"再快也只有 3.3 发/秒（一发只打死一只）。
    speedScale: 0.62,
    // 人海停在离你 2.6~4.2 个单位的地方（普通怪的咬人距离只有 1.75），
    // 也就是"挤成一堵尸墙但够不着你" —— 它们是给你割草的，不是来咬你的。
    // 原因：同屏 20 只小兵如果全都贴脸，玩家 4 颗心是必死的（机器人实测：
    // 一个 BOSS 波被咬 10~12 口直接阵亡），那样就只剩挫败感没有爽感了。
    // 真正咬人的仍然是后面从队列里冲上来的跑步者 / 大块头 / 铁盾兵。
    // （想让小兵也扑上来咬人，把这两个值改成 0 附近即可）
    stopFrom: 2.6,
    stopTo: 4.2,
    queueMul: 0.35, // 常规出怪量只剩三分之一：BOSS 波的主角是"人海"，
    // 队里那些真正会咬人的怪（跑步者/大块头/铁盾兵）留几只当威胁就够，
    // 不然两头一起来，玩家在 BOSS 波会连掉 3~6 点血（实测机器人第 5 波被咬 6 口）
  },

  // ---- 敌人种类 ----
  // 体型放大过两轮：用户两次反馈"僵尸太小了"。第一轮 0.115→0.165（桥头 56→77px），
  // 这一轮再放大到 0.26（桥头约 110px，占屏高 13%），同时把 zFar 从 50 压到 42，
  // 让"刚出怪时"的远处丧尸也不再是一个小点。
  // body 决定渲染用的躯干形状：normal / fat（胖）/ wide（宽肩大块头）
  //
  // 皮肤（skin）：一个 kind 可以挂多套外观，game.js 的 spawnEnemy 按 CFG.level.skin
  // 挑一份挂到实体上（e.color/e.dark/e.animal），渲染器再按 e.animal 画对应部件。
  // ocean = 第二关疯狂水世界的海洋动物；pvz = 第三关疯狂草坪的僵尸种类。
  kinds: {
    walker: { size: 0.26, speedMul: 1.0, hpMul: 1.0, score: 10, body: 'normal', color: '#7e9a52', dark: '#3f5129', ocean: { color: '#5fae9c', dark: '#27564c', animal: 'fish' }, pvz: { color: '#8f9c86', dark: '#3f4a3a', animal: 'basic' } },
    runner: { size: 0.235, speedMul: 1.7, hpMul: 0.6, score: 14, body: 'normal', color: '#b06442', dark: '#5c3121', ocean: { color: '#e08a6a', dark: '#7a4028', animal: 'squid' }, pvz: { color: '#b45a45', dark: '#5c2a20', animal: 'pole' } },
    brute: { size: 0.36, speedMul: 0.62, hpMul: 3.2, score: 26, body: 'wide', color: '#77879b', dark: '#3a4551', ocean: { color: '#8fa8c2', dark: '#3b5470', animal: 'crab' }, pvz: { color: '#7d8a74', dark: '#37402f', animal: 'gargantuar' } },
    // 血量倍数和体型倍数（0.60 / 0.26 ≈ 2.3）对齐；原来写 5 会在第 5 波插一个血量尖峰
    // 用户要求：BOSS 体型再翻一倍（0.6 → 1.2）、血条更厚（hpMul 3.2 → 6.5）、
    // 走得更慢（speedMul 0.46 → 0.38）。
    // 用户 m02765 又要求"血量翻倍"：6.5 → 13（第一关第 15 波 ≈ 16.7 × 13 ≈ 217 血）。
    // 注意：它站在 5 个单位外够不着你，所以血厚只拉长"最后的消耗战"，
    // 不会让你被它咬死；期间它会一直按 spawnEvery 放崽子。
    //
    // stopGap 5：这是实测调出来的关键值。体型 1.2 的 BOSS 如果像普通怪那样贴到
    // 1.15 个单位，屏幕上会有 563px 高、把整条桥和玩家自己全盖住（出图确认过），
    // 那就没法玩了。站到 5 个单位：屏幕高约 420px（老 BOSS 的 1.5 倍、小兵的 4 倍多），
    // 脚正好停在玩家头顶上方，屏幕下方 40% 的"走位区"仍然看得清清楚楚。
    // 它够不着你，威胁相应改成"放崽子"（见 game.js 的 spawnBossAdds）。
    boss: {
      size: 1.2,
      // 速度：m02878 要求"速度变缓"，0.38 → 0.26（比人海小兵还慢，慢慢压过来）
      speedMul: 0.26,
      // 血量：这是"没走校准流程时的兜底倍数"（比如出图夹具直接 spawnEnemy）。
      // 真正的血量由 game.js 的 fitBossHp 按【玩家当前 DPS × seconds】反推 ——
      // 原因：测试机器人不同种子的 DPS 横跨 32~80/秒，固定倍数必然对一半人
      // 太短、对另一半人太长（m02765 要翻倍、m02878 要"打 15~30 秒"）。
      hpMul: 20,
      seconds: 20, // BOSS 战目标时长（秒）：血量 = 估算 DPS × 这个数
      hpMin: 320, // 血量下限（弱构筑也让它像个 BOSS）
      hpMax: 2600, // 血量上限（免得"要磨两分钟"）
      score: 900,
      stopGap: 5,
      spawnEvery: 3.2, // 每 3.2 秒往身前放 spawnCount 只小兵
      spawnCount: 2,
      biteHalfW: 0.17,
      body: 'wide',
      color: '#a2594a',
      dark: '#4c261f',
      // 第二关：鲨鱼王（灰蓝、三角背鳍、血盆大口）
      ocean: { color: '#6f93ab', dark: '#2b4a5e', animal: 'shark' },
      // 第三关：僵王博士（金属机械头 + 玻璃罩 + 红眼）——它的必杀导弹就是"火球"
      pvz: { color: '#8b9490', dark: '#2f3a37', animal: 'zomboss' },
    },
    // 吐酸者：停在远处往桥上喷酸液，逼玩家走位而不是站着对射
    spitter: { size: 0.26, speedMul: 0.9, hpMul: 1.1, score: 24, body: 'fat', spit: true, color: '#8fbe3f', dark: '#42591d', ocean: { color: '#e8c24a', dark: '#7a5f16', animal: 'puffer' }, pvz: { color: '#8d7a5f', dark: '#453a2a', animal: 'catapult' } },
    // 铁盾兵：正面带盾，前 3 发子弹伤害减半并会破盾
    shielded: { size: 0.28, speedMul: 0.8, hpMul: 1.4, score: 26, body: 'normal', shield: 3, color: '#8d8f7a', dark: '#45473a', ocean: { color: '#7fae86', dark: '#37543c', animal: 'turtle' }, pvz: { color: '#8a8f7d', dark: '#40453a', animal: 'bucket' } },
    // 分裂者：死后裂成两只小兵，越打越多，逼你换目标优先级
    splitter: { size: 0.3, speedMul: 0.95, hpMul: 1.7, score: 18, body: 'fat', split: 2, color: '#9a6bb5', dark: '#4a2f5c', ocean: { color: '#c98bd8', dark: '#5d3a6b', animal: 'jelly' }, pvz: { color: '#a2ae97', dark: '#4d5647', animal: 'imp' } },
  },

  // BOSS 的必杀导弹（m02878 加、m03096 改）：落点 = 它开火那一刻你站的位置，
  // 不是追踪弹，所以预警圈出现后横向挪一步就能躲开（圈内才吃伤害）。
  // m03096：不再每隔几秒打一发，改成【血量掉到 3/4 时强制放一次，别的时候不放】，
  // 而且被它打中直接死 —— 整个 BOSS 战就这一道考题，挪开就赢。
  bossMissile: {
    hpAt: 0.75, // 血量掉到 maxHp 的这个比例时强制放一发（整场只放这一发）
    warn: 1.5, // 预警时长：地面红圈从大缩到小，缩到底就砸下来
    radius: 0.16, // 命中半径（世界单位；英雄身位 halfWidth 只有 0.075）
    lethal: true, // 打中直接死（不消耗护盾、不吃无敌帧）
  },

  // ---- 第二关专属机制 ----
  // 用户 m01451：第二关要"玩法更多更爽"。两条新玩法都挂在海洋主题上：
  // ① 水雷（升级项 mine）：每波开始时在你前方布几颗，敌人踩上就炸，
  //    让"往前压"这件事多一层收益（也是唯一一个会自己造伤害的地面物）；
  // ② 河豚爆裂（基础机制）：第二关的吐酸者换成河豚，死了会炸开一片，
  //    所以"先点掉远处的河豚"会带出一串连锁击杀。
  mine: {
    count: 3, // 每层升级每波布几颗
    radius: 0.6, // 触发半径（世界单位，比桥面半宽还宽，故意做宽松）
    size: 0.075, // 画多大（世界单位半径）——别拿 radius 当绘制尺寸
    damage: 3, // 爆炸伤害
    blastR: 0.75, // 伤害范围（横向半径）
    zFrom: 14, // 布在英雄前方 zFrom~zTo 之间（英雄一般在 10 附近，太靠前会把水雷摆到脸上）
    zTo: 30,
    live: 30, // 一颗雷最多活这么久（秒），免得攒满整座桥
  },
  puffer: {
    blastR: 0.6,
    blastDmg: 2,
  },

  // ---- 第三关专属机制：疯狂草坪（植物大战僵尸）----
  // 三样都从 PvZ 搬过来，但都改造成能塞进"守桥"的东西：
  // ① 开场：戴夫喊一句「歪比巴布」→ 警报 → 3 2 1 → 开打（模仿 PvZ 的关卡开场）
  // ② 阳光：天上掉阳光，走过去自动捡，充能给大招；大招不再是飞机轰炸，
  //    改成一颗巨型【樱桃炸弹】——PvZ 里最爽的那个东西。
  // ③ 寒冰 / 炎火：奖励门专属，吃到只改【一条】弹道（不是全队变属性），
  //    所以弹道多了以后能混出"冰火两重天"，这是这一关的构筑乐趣。
  pvz: {
    // 开场节奏：警报响一会儿，然后大字倒数 3 / 2 / 1（每步 0.75 秒）
    // calm = 倒数喊完之后再留多久备战（这段时间里第一对奖励门滑到面前让你挑）
    alert: { alarm: 1.3, step: 0.75, calm: 2.6 },
    // 阳光：隔一会儿掉一个，落地后躺着等你走去捡（走位 = 收益）
    // 【用户实测 bug】以前落点是"英雄当前位置 + 3.0~8.5"，而英雄前后只能走
    // 1.8/2.8 —— 阳光落在走不到的地方，屏幕上看得见、走过去差着半米也捡不着。
    // 现在落点先算"英雄走得到的那条 z 区间"（见 heroZRange），再夹进去。
    sun: {
      first: 3.0,
      every: 6.0,
      live: 16, // 躺多久消失
      drift: 0.22, // 左右飘的速度，别掉成一条直线
      size: 0.052, // 画多大（世界单位）。以前是 0.085：掉得远的时候看着还行，
      //              现在阳光就掉在英雄脚边（近处 scale 更大），0.085 会画成一个
      //              比英雄还大的太阳糊在屏幕上。捡的判定另算（pickX/pickZ）。
      charge: 12, // 捡到一个充多少能量
      bigEvery: 5, // 每 5 个里有一个大的
      bigMul: 1.7, // 大的画多大、充多少（倍率）
      aheadMin: 1.8, // 落点理想上在英雄前面多远（下界）
      aheadMax: 3.6, // 上界；超出活动范围就往回夹
      gap: 1.0, // 至少离英雄这么远 —— 逼你挪两步，不许站着白捡
      pickX: 0.28, // 弯腰捡的判定：左右各多少世界单位
      pickZ: 0.8, // 前后各多少世界单位（手机上给宽一点，别让人怀疑人生）
    },
    // 弹道属性：走 e.slowT / e.burnT 那套现成机制（和升级里的液氮弹/燃烧弹同一套字段）
    ice: { slowMul: 0.45, time: 2.2, color: '#8fe8ff', glow: '#2aa8ff' },
    fire: { dps: 1.6, time: 2.4, color: '#ff9a3c', glow: '#ff4d16' },
    // 樱桃炸弹（大招）：比空袭的散弹大得多的一发，落在你点的地方
    cherry: {
      radius: 1.7, // 横向炸开半径（世界单位）
      zRadius: 2.4, // 纵向判定半径
      damage: 14,
      fuse: 0.45, // 落地到炸开的引信时间
      count: 1,
    },
  },

  // 从第几波开始出现特殊怪
  runnerFrom: 3,
  spitterFrom: 4,
  bruteFrom: 5,
  shieldedFrom: 6,
  splitterFrom: 7,

  // ---- 吐酸者 ----
  spitter: {
    gap: 5.4, // 停在英雄前方这么远（普通丧尸是 1.15，所以它远远地站着）
    interval: 2.1, // 喷吐间隔
    speed: 15, // 酸液飞行速度（世界单位/秒）
    lead: 0.0, // 0 = 对着玩家当前位置直射（不预判，所以走位就能躲）
  },

  // ---- 连杀 ----
  // 连续击杀不断链，分数按连杀数加成：鼓励"贪"，和"往后缩最安全"形成对抗
  combo: {
    window: 2.6, // 超过这么久没击杀就断链
    perScore: 0.06, // 每级连杀 +6% 分数
    max: 2.5, // 分数加成上限（+250%）
    punch: 1.0, // 数字弹一下的动画时长
  },

  // ---- 充能空袭（大招）----
  // 击杀攒能量，满了之后点右下角按钮呼叫轰炸：一串炮弹从远处砸到桥头。
  // 给玩家一个"我主动做了一件大事"的按钮，这是玩法维度上最直接的补充。
  charge: {
    perKill: 3.2, // 约 31 只充一次：隔着"一波多"才来一次，才不会退化成每波例行清场
    perBoss: 30,
    max: 100,
  },
  strike: {
    count: 5, // 砸几发
    interval: 0.13, // 每发之间的间隔
    firstDelay: 0.25,
    radius: 0.45, // 每发的横向伤害半径
    zRadius: 1.5,
    damage: 4, // 基础伤害（再按波次和升级加成）——目标是"砸残一片"，不是"一键清屏"
    damagePerWave: 0.45,
    // 飞机掠过 + 导弹从天而降（视觉重做：以前是"炮弹贴着桥面飞"，现在改成
    // 轰炸机从夜空横穿、导弹带着尾迹从画面顶端砸下来，冲击感强得多）
    planeDur: 2.1, // 飞机横穿屏幕用的秒数
    planeY: 0.3, // 航线高度 = 地平线高度的这个比例
    missileDur: 0.62, // 单发导弹从出场到落地
    missileFrom: 0.34, // 出场时间占 missileDur 的比例（先"在高空"待一下再砸）
  },

  // ---- 角色台词 ----
  // 连杀到这些节点，英雄喊一句（英文、短、有鼓动性）。
  // 参考用户给的例子：十连击 = "PERFECT!"
  shouts: [
    { combo: 5, text: 'NICE!', color: '#ffd166' },
    { combo: 10, text: 'PERFECT!', color: '#7df9ff' },
    { combo: 15, text: 'INCREDIBLE!', color: '#8bf58b' },
    { combo: 20, text: 'UNSTOPPABLE!', color: '#ff7df2' },
    { combo: 25, text: 'GODLIKE!', color: '#ff9f45' },
    { combo: 30, text: 'LEGENDARY!', color: '#ff3b2f' },
    { combo: 40, text: 'HOLD THE BRIDGE!', color: '#ffd166' },
  ],

  // ---- 波次词条 ----
  // 每 modEvery 波给这一波加一个随机词条，让每一局的中段节奏都不一样
  modEvery: 3,
  mods: [
    { id: 'rage', name: '狂暴', desc: '丧尸速度 +25%', color: '#ff7a5c', speedMul: 1.25, scoreMul: 1.25 },
    { id: 'thick', name: '厚皮', desc: '丧尸血量 +60%', color: '#ffd166', hpMul: 1.6, scoreMul: 1.4 },
    { id: 'horde', name: '丧尸潮', desc: '数量 +50%', color: '#7df9ff', countMul: 1.5, hpMul: 0.8, scoreMul: 1.1 },
    { id: 'fog', name: '血月浓雾', desc: '视野变差', color: '#c86bff', fog: 1.7, scoreMul: 1.5 },
    { id: 'rush', name: '疾行者', desc: '全是快跑的家伙', color: '#8bf58b', allRunner: true, scoreMul: 1.35 },
  ],

  // ---- 计分与掉落 ----
  score: { perWave: 50 },

  // ---- 关卡与金币 ----
  // 一关 15 波，清完就结算：按得分的这个比例发金币。
  // 金币是跨局的，先只做"攒着"，留给以后主界面里的商店花。
  //
  // 用户 m01451/m01453：第二关换成"疯狂水世界"——蓝色水域主题、丧尸融合海洋动物、
  // 图片人物当主角、奖励墙也带海洋元素，通关第一关后从结算面板进去。
  // theme 指向下面的 CFG.themes，skin 决定丧尸/英雄画成哪一套。
  levels: [
    {
      id: 1,
      name: '血色大桥',
      hud: '第 1 关 · 血色大桥',
      waves: 15,
      coinRatio: 0.08, // 得分 × 8% = 金币（4000 分 → 320 金币）
      theme: 'city',
      skin: null, // 城市丧尸 + 蓝衣英雄
    },
    {
      id: 2,
      name: '疯狂水世界',
      hud: '第 2 关 · 疯狂水世界',
      waves: 15,
      coinRatio: 0.1,
      theme: 'water',
      skin: 'ocean', // 海洋动物化的丧尸 + 图片人物主角
      intro: true, // 进来先播一段进场对话（STATE.TALK），点「疯狂水世界 · 启动！」才开打
    },
    {
      // 用户 m02771：第三关做植物大战僵尸风格 —— 戴夫开场、警报 + 321 倒计时、
      // 主角是豌豆射手（弹道 +1 = 多一个头）、奖励墙独属寒冰/炎火。
      id: 3,
      name: '疯狂草坪',
      hud: '第 3 关 · 疯狂草坪',
      waves: 15,
      coinRatio: 0.12,
      theme: 'lawn',
      skin: 'pvz', // 植物大战僵尸的僵尸种类 + 豌豆射手主角
      intro: 'dave', // 戴夫先喊一句「歪比巴布」，点掉之后走"警报 + 321"开场
      // 草坪比桥上宽敞：前后活动范围放到 3.0 / 4.6，阳光掉下来才有得捡。
      // （桥上那 1.8/2.8 是第一关调了很久的手感，别动它。）
      roam: { zBack: 3.0, zFwd: 4.6 },
    },
  ],
  levelIndex: 0,
  // 当前关卡的快捷引用（初始化时 = levels[0]）。全工程都读 CFG.level.xxx，
  // 所以切关卡只调 setLevel()，其余代码一行都不用改。
  level: null,
  theme: null,

  // ---- 存档 ----
  storageKey: 'hold-the-bridge:best',
  coinKey: 'hold-the-bridge:coins',
  progressKey: 'hold-the-bridge:progress',
};

// ---- 波型判定（全工程唯一出处）----
// 以前 game.js / main.js / render.js / 探针脚本各自写一遍 `w % bossEvery === 0`，
// 一改规则就得满工程找。现在只有这两个函数说了算。
//
// 人海波：桥面一次性铺满一枪一个的小兵（第 5 / 10 / 15 波）
export const isHordeWave = (w) => w > 0 && w % CFG.wave.hordeEvery === 0;
// BOSS 波：只在每一关的最后一波出场（第一关 = 第 15 波）。清完这一波就结算通关，
// 所以"最后来一只大的"这件事刚好成立；第 5 / 10 波只来人海，不再夹带 BOSS。
export const isBossWave = (w) => w > 0 && w % CFG.level.waves === 0;

// 武器质变阶梯：按"攻击类升级"累计点数解锁，纯视觉 + 轻微加成
export const WEAPON_TIERS = [
  { at: 0, name: '制式弹', color: '#ffd97a', glow: '#ffae2e', radiusMul: 1.0, trail: 0.5, splash: 0 },
  { at: 2, name: '强化弹', color: '#ffb347', glow: '#ff7a18', radiusMul: 1.25, trail: 0.7, splash: 0 },
  { at: 4, name: '等离子', color: '#7df9ff', glow: '#12b6ff', radiusMul: 1.5, trail: 1.0, splash: 0.035 },
  { at: 7, name: '毁灭者', color: '#ff7df2', glow: '#c21bff', radiusMul: 1.85, trail: 1.3, splash: 0.06 },
];

// 哪些升级算作"攻击类"，用于推进武器质变
// （iceLane/fireLane 是第三关给单条弹道加属性的，本质也是进攻手段，算进去）
export const OFFENSIVE_KEYS = ['damage', 'rateMul', 'pierce', 'bullets', 'crit', 'critMul', 'bulletSpeedMul', 'splash', 'iceLane', 'fireLane'];

// ---- 第三关：主角变身豌豆射手 ----
// 用户 m02771 的原话是"弹道 +1 换双头豌豆射手，以此类推"，所以这里的档位
// 【完全按弹道数走】，而不是按 WEAPON_TIERS 的攻击点数走：
// 弹道 1/2/3/4/5 → 豌豆射手 / 双发射手 / 三线射手 / 机枪豌豆 / 玉米加农炮。
// heads = 画几个头（渲染器按它决定造型），名字同时进 HUD 的武器称号。
export const PVZ_PLANTS = [
  { bullets: 1, name: '豌豆射手', short: '豌豆', heads: 1, color: '#5fbf3a', dark: '#2f6b1d' },
  { bullets: 2, name: '双发射手', short: '双发', heads: 2, color: '#57c236', dark: '#2a6318' },
  { bullets: 3, name: '三线射手', short: '三线', heads: 3, color: '#4cc42f', dark: '#275c16' },
  { bullets: 4, name: '机枪豌豆', short: '机枪', heads: 4, color: '#3fc728', dark: '#235413' },
  { bullets: 5, name: '玉米加农炮', short: '加农', heads: 5, color: '#ffd23f', dark: '#9a6c12' },
];

/** 按弹道数取第三关的植物档位（超出表格就取最后一档，名字后面加 +N）。 */
export function pvzPlant(bullets) {
  const n = Math.max(1, bullets | 0);
  const t = PVZ_PLANTS[Math.min(PVZ_PLANTS.length, n) - 1];
  if (!t) return PVZ_PLANTS[0];
  if (n <= PVZ_PLANTS.length) return t;
  return { ...t, name: t.name + ' +' + (n - PVZ_PLANTS.length), short: t.short + '+' };
}

/** 当前关卡是不是"疯狂草坪"皮肤（渲染器和玩法逻辑都拿它分支）。 */
export function isPvz() {
  return !!CFG.level && CFG.level.skin === 'pvz';
}

// ---- 加成表 ----
// v1 是"清完一波弹三张卡让你选"，用户反馈不要弹窗。
// 现在每条加成会在桥上变成一块面板：op 是运算符号（+ / × / −），
// amt 是大字，short 是小字说明。玩家靠"走位站在桥的左半边还是右半边"来选。
// apply 里是纯数值增量，由 game.js 统一解释，避免循环依赖
export const UPGRADES = [
  { id: 'damage', name: '火力强化', desc: '子弹伤害 +1', tag: '伤害', max: 12, op: '+', amt: '1', short: '子弹伤害', apply: { damage: 1 } },
  { id: 'rateMul', name: '急速扳机', desc: '射速 ×1.18', tag: '射速', max: 8, op: '×', amt: '1.18', short: '射速', apply: { rateMul: 1.18 } },
  { id: 'pierce', name: '穿甲弹头', desc: '穿透 +1，子弹可穿过敌人', tag: '弹道', max: 5, op: '+', amt: '1', short: '穿透', apply: { pierce: 1 } },
  { id: 'bullets', name: '双管齐射', desc: '弹道 +1，同时射出多颗子弹', tag: '弹道', max: 4, op: '+', amt: '1', short: '弹道数', apply: { bullets: 1 } },
  { id: 'crit', name: '致命一击', desc: '暴击率 +12%', tag: '伤害', max: 6, op: '+', amt: '12%', short: '暴击率', apply: { crit: 0.12 } },
  { id: 'critMul', name: '破坏者', desc: '暴击伤害 +60%', tag: '伤害', max: 5, op: '+', amt: '60%', short: '暴击伤害', apply: { critMul: 0.6 } },
  { id: 'splash', name: '高爆弹头', desc: '子弹附带溅射伤害', tag: '特效', max: 5, op: '+', amt: '范围', short: '溅射伤害', apply: { splash: 0.03 } },
  { id: 'ice', name: '液氮弹', desc: '命中减速敌人 45%', tag: '特效', max: 2, op: '−', amt: '35%', short: '敌人速度', apply: { ice: 1 } },
  { id: 'burn', name: '燃烧弹', desc: '命中点燃敌人，持续掉血', tag: '特效', max: 4, op: '+', amt: '点燃', short: '持续伤害', apply: { burn: 1 } },
  { id: 'bulletSpeedMul', name: '高速弹药', desc: '子弹飞行速度 ×1.22', tag: '弹道', max: 4, op: '×', amt: '1.22', short: '子弹速度', apply: { bulletSpeedMul: 1.22 } },
  { id: 'moveMul', name: '轻装疾行', desc: '英雄移动速度 ×1.16', tag: '机动', max: 5, op: '×', amt: '1.16', short: '移动速度', apply: { moveMul: 1.16 } },
  { id: 'maxHp', name: '装甲加固', desc: '生命上限 +1，并回满生命', tag: '生存', max: 6, op: '+', amt: '1', short: '生命上限', apply: { maxHp: 1, healFull: true } },
  { id: 'heal', name: '战地医疗', desc: '立即回复 2 点生命', tag: '生存', max: 99, op: '+', amt: '2', short: '立即回血', apply: { heal: 2 } },
  { id: 'shieldPerWave', name: '能量护盾', desc: '每波开始时获得 1 层护盾', tag: '生存', max: 4, op: '+', amt: '1', short: '每波护盾', apply: { shieldPerWave: 1 } },
  { id: 'dropChance', name: '磁力吸取', desc: '击杀有几率掉落治疗包', tag: '生存', max: 4, op: '+', amt: '7%', short: '掉落几率', apply: { dropChance: 0.07 } },
  { id: 'pulse', name: '过载脉冲', desc: '每 6.5 秒释放冲击波，伤害全场敌人', tag: '特效', max: 4, op: '+', amt: '脉冲', short: '自动 AOE', apply: { pulse: 1 } },
  { id: 'chargeMul', name: '超导电容', desc: '空袭充能速度 ×1.4', tag: '特效', max: 4, op: '×', amt: '1.4', short: '充能速度', apply: { chargeMul: 1.4 } },
  { id: 'strikeMul', name: '重装弹头', desc: '空袭伤害 ×1.5', tag: '特效', max: 4, op: '×', amt: '1.5', short: '空袭伤害', apply: { strikeMul: 1.5 } },

  // ---- 第二关专属（l2: true，只在"疯狂水世界"的奖励门里出现）----
  // 一部分是海洋味道的数值加成（比第一关更猛，因为海里的怪也更猛），
  // 一部分是本关独有的新玩法（水雷 / 气泡护盾）。
  { id: 'deepSea', name: '深海弹头', desc: '子弹伤害 +2', tag: '伤害', max: 6, op: '+', amt: '2', short: '子弹伤害', apply: { damage: 2 }, l2: true },
  { id: 'current', name: '洋流加速', desc: '射速 ×1.25', tag: '射速', max: 5, op: '×', amt: '1.25', short: '射速', apply: { rateMul: 1.25 }, l2: true },
  { id: 'coralArmor', name: '珊瑚装甲', desc: '生命上限 +2，并回满生命', tag: '生存', max: 3, op: '+', amt: '2', short: '生命上限', apply: { maxHp: 2, healFull: true }, l2: true },
  { id: 'bubbleShield', name: '气泡护盾', desc: '每波开始时获得 2 层护盾', tag: '生存', max: 3, op: '+', amt: '2', short: '每波护盾', apply: { shieldPerWave: 2 }, l2: true },
  { id: 'mine', name: '布设水雷', desc: '每波开始时在前方布 3 颗水雷，敌人碰到就炸', tag: '特效', max: 3, op: '+', amt: '3 颗', short: '水雷', apply: { mine: 1 }, l2: true },
  { id: 'torpedo', name: '鱼类鱼雷', desc: '空袭伤害 ×1.6', tag: '特效', max: 3, op: '×', amt: '1.6', short: '空袭伤害', apply: { strikeMul: 1.6 }, l2: true },

  // ---- 第三关专属（l3: true，只在"疯狂草坪"的奖励门里出现）----
  // 用户 m02771 明确要求：奖励墙独属【寒冰】【炎火】，而且吃到只改一条弹道
  // （不是全队变属性）—— 所以 iceLane / fireLane 是这一关的核心构筑件，
  // 弹道越多，越能混出"一半冰一半火"的场面。
  { id: 'iceLane', name: '寒冰弹道', desc: '一条弹道变成寒冰：命中减速 55%', tag: '特效', max: 5, op: '+', amt: '寒冰', short: '寒冰豌豆', apply: { iceLane: 1 }, l3: true },
  { id: 'fireLane', name: '炎火弹道', desc: '一条弹道变成炎火：命中持续燃烧', tag: '特效', max: 5, op: '+', amt: '炎火', short: '炎火豌豆', apply: { fireLane: 1 }, l3: true },
  { id: 'sunflower', name: '向日葵', desc: '每波开始时多掉 1 个阳光', tag: '特效', max: 3, op: '+', amt: '1 个', short: '阳光', apply: { sunWave: 1 }, l3: true },
  { id: 'sunValue', name: '阳光充沛', desc: '阳光充能 ×1.6', tag: '特效', max: 3, op: '×', amt: '1.6', short: '阳光充能', apply: { sunMul: 1.6 }, l3: true },
  { id: 'cherryBig', name: '巨型樱桃', desc: '樱桃炸弹范围 ×1.35', tag: '特效', max: 3, op: '×', amt: '1.35', short: '樱桃范围', apply: { cherryR: 1.35 }, l3: true },
];

// ============================================================
//  主题配色（用户 m01451：第二关"背景换成疯狂水世界风格"）
//
//  渲染器不再写死颜色，全部读 CFG.theme.xxx。city 那一套就是第一关原来的
//  字面量 1:1 搬过来的（所以第一关画面一模一样），water 是新做的水世界。
// ============================================================
CFG.themes = {
  // 第一关：血色大桥（夜晚、城市天际线、橙色光污染）
  city: {
    sky: ['#04060c', '#0a1019', '#151727', '#2a1c22'],
    pollute: ['rgba(255,150,90,0.20)', 'rgba(180,90,110,0.09)'],
    starRGB: '220,235,255',
    skyDeco: 'stars',
    moon: '#cfd9e2',
    moonSpot: 'rgba(120,135,150,0.30)',
    skyline: 'city',
    horizon: ['rgba(255,120,80,0)', 'rgba(255,110,70,0.16)', 'rgba(255,80,60,0)'],
    sea: ['#0d1420', '#080c15', '#03050a'],
    foam: ['rgba(255,150,90,0)', 'rgba(255,170,110,', 'rgba(255,150,90,0)'],
    deck: ['#0f1218', '#1b1f26', '#262b33', '#30363f'],
    seam: 'rgba(0,0,0,0.20)',
    dash: 'rgba(226,206,140,0.30)',
    edge: ['rgba(180,150,70,0.10)', 'rgba(226,196,110,0.34)', 'rgba(240,214,130,0.5)'],
    railBar: 'rgba(96,106,120,0.85)',
    railPost: 'rgba(80,88,100,0.9)',
    railTop: 'rgba(150,110,80,0.5)',
    haze: ['rgba(20,24,34,0.72)', 'rgba(18,22,32,0.30)', 'rgba(16,20,30,0)'],
    fog: ['rgba(26,30,40,0.96)', 'rgba(24,28,38,0.80)', 'rgba(22,26,36,0.34)', 'rgba(20,24,34,0)'],
    stain: ['#3d0808', '#8d1010'],
    dust: '#9aa7bd',
    lamp: ['rgba(255,238,190,0.15)', 'rgba(255,238,190,0)'],
    panel: 'rgba(10,14,22,0.72)',
  },

  // 第二关：疯狂水世界（水世界乐园：蓝白格子墙 + 水草 + 气泡 + 木栈道）
  // 关键词：亮、蓝、湿。雾是水汽（不是夜雾），桥面是湿木板，护栏是白色塑料，
  // 头顶黄圈是救生圈配色 —— 一眼就和第一关不是一个地方。
  water: {
    sky: ['#0a3f6b', '#12699b', '#2b9bd0', '#9be8ff'],
    pollute: ['rgba(160,240,255,0.22)', 'rgba(70,180,255,0.12)'],
    starRGB: '235,250,255',
    skyDeco: 'bubbles',
    moon: '#eafbff',
    moonSpot: 'rgba(140,200,225,0.30)',
    skyline: 'reef',
    horizon: ['rgba(120,230,255,0)', 'rgba(120,220,255,0.22)', 'rgba(90,200,255,0)'],
    sea: ['#1e86b4', '#12618c', '#0a3f5e'],
    foam: ['rgba(255,255,255,0)', 'rgba(228,252,255,', 'rgba(255,255,255,0)'],
    deck: ['#7a5b3e', '#96714b', '#b08a5c', '#c9a273'],
    seam: 'rgba(60,34,14,0.30)',
    dash: 'rgba(255,255,255,0.26)',
    edge: ['rgba(255,255,255,0.10)', 'rgba(220,250,255,0.34)', 'rgba(255,255,255,0.5)'],
    railBar: 'rgba(238,252,255,0.9)',
    railPost: 'rgba(205,236,248,0.95)',
    railTop: 'rgba(255,206,92,0.6)',
    haze: ['rgba(178,232,248,0.60)', 'rgba(160,218,240,0.28)', 'rgba(150,210,236,0)'],
    fog: ['rgba(196,240,252,0.95)', 'rgba(184,232,248,0.78)', 'rgba(172,222,242,0.32)', 'rgba(160,214,238,0)'],
    stain: ['#3a1010', '#7c1a1a'],
    dust: '#ffffff',
    lamp: ['rgba(255,246,214,0.18)', 'rgba(255,246,214,0)'],
    panel: 'rgba(6,32,46,0.72)',
    bubble: 'rgba(240,253,255,',
    reef: {
      wallA: '#2f7fd0',
      wallB: '#ffffff',
      weed: '#3fbf8f',
      weedDark: '#1d7a58',
      fish: ['#ffd166', '#ff8fab', '#7df9ff'],
    },
  },

  // 第三关：疯狂草坪（用户 m02771：植物大战僵尸风格）
  // 这一套和上面两关反着来 —— 白天，不是夜晚。天空是亮蓝 + 白云，
  // 桥面铺成绿草皮，两边栏杆换成木头栅栏，两旁那片"海"其实是草坪，
  // 远处是郊区民房和树。所有键名和 city/water 一一对应，渲染器不用改结构。
  lawn: {
    sky: ['#3ea7e8', '#66c2f2', '#9fdcf8', '#d8f2ff'],
    pollute: ['rgba(255,244,196,0.22)', 'rgba(255,255,255,0.12)'],
    starRGB: '255,255,255',
    skyDeco: 'clouds',
    moon: '#fff6d8',
    moonSpot: 'rgba(255,236,168,0.35)',
    skyline: 'houses',
    horizon: ['rgba(190,240,255,0)', 'rgba(214,246,255,0.30)', 'rgba(255,255,255,0)'],
    sea: ['#6fbe55', '#4f9c3c', '#2f6f26'],
    foam: ['rgba(255,255,255,0)', 'rgba(246,255,238,', 'rgba(255,255,255,0)'],
    deck: ['#4f8f34', '#61a840', '#74bd4d', '#8ed162'],
    seam: 'rgba(28,64,20,0.28)',
    dash: 'rgba(255,255,255,0.34)',
    edge: ['rgba(255,255,255,0.10)', 'rgba(240,255,220,0.34)', 'rgba(255,255,255,0.5)'],
    railBar: 'rgba(160,112,58,0.9)',
    railPost: 'rgba(138,94,46,0.95)',
    railTop: 'rgba(214,166,96,0.6)',
    haze: ['rgba(226,250,255,0.55)', 'rgba(232,252,255,0.26)', 'rgba(240,255,255,0)'],
    fog: ['rgba(238,255,250,0.95)', 'rgba(232,252,244,0.78)', 'rgba(226,248,240,0.32)', 'rgba(224,246,238,0)'],
    stain: ['#3a1010', '#7c1a1a'],
    dust: '#ffffff',
    lamp: ['rgba(255,246,196,0.18)', 'rgba(255,246,196,0)'],
    panel: 'rgba(24,58,18,0.72)',
    // 疯狂草坪专属颜色（渲染器画草坪条纹 / 民房 / 栅栏 / 白云 / 阳光时读这里）
    lawn: {
      stripeA: '#5aa63c',
      stripeB: '#69b747',
      dirt: '#a9773f',
      fence: '#c9a165',
      fenceDark: '#8a6234',
      house: '#f2e6c8',
      roof: '#c9502f',
      tree: '#2f6f2a',
      treeDark: '#1d4a1c',
      cloud: 'rgba(255,255,255,',
      sun: '#fff0a8',
      sunCore: '#ffd23f',
      pea: '#69d13c',
      peaDark: '#2f7a1c',
    },
  },
};

// 当前关卡 + 主题：初始化成第一关，切关卡只调 setLevel()
CFG.level = CFG.levels[0];
CFG.theme = CFG.themes[CFG.level.theme] || CFG.themes.city;

/**
 * 切换关卡（0 = 第一关 / 1 = 疯狂水世界）。
 * CFG.level 与 CFG.theme 一起换，渲染器和玩法逻辑都跟着变。
 */
export function setLevel(idx) {
  const i = Math.max(0, Math.min(CFG.levels.length - 1, idx | 0));
  CFG.levelIndex = i;
  CFG.level = CFG.levels[i];
  CFG.theme = CFG.themes[CFG.level.theme] || CFG.themes.city;
  return CFG.level;
}

/**
 * 英雄能站的那条 z 区间 [zBack 端, zFwd 端]，供 updatePlayer 夹取、
 * 也供"掉下来的阳光"算出走得到的落点。
 *
 * 关卡可以用 levels[].roam = { zBack, zFwd } 覆盖（草坪比桥上宽敞），
 * 没写就用 CFG.hero 的通用值 —— 桥上那套是第一关调出来的手感。
 */
export function heroZRange() {
  const r = (CFG.level && CFG.level.roam) || CFG.hero;
  const back = r.zBack != null ? r.zBack : CFG.hero.zBack;
  const fwd = r.zFwd != null ? r.zFwd : CFG.hero.zFwd;
  return [CFG.zNear - back, CFG.zNear + fwd];
}

/**
 * 按"关卡 id"找关卡（id 从 1 开始，和数组下标不是一回事，
 * 结算面板要按下一关的 id 拿名字，别再拿 id 当下标用）。
 */
export function findLevel(id) {
  return CFG.levels.find((l) => l.id === id) || null;
}

/**
 * 按"关卡 id"取数组下标（找不到就给 0）。
 * 选关面板和结算面板的「下一关」都拿到的是 id，而 setLevel/beginLevel 要的是下标，
 * 中间必须过这一道，不然 id=2 当 下标 用就悄悄指到别的关（或者被 clamp 掉）。
 */
export function levelIndexOf(id) {
  const i = CFG.levels.findIndex((l) => l.id === id);
  return i < 0 ? 0 : i;
}
