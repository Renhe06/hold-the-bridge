// ---------------------------------------------------------------------------
//  中英双语（用户 m02901："主界面左下角加一个English小按钮，可以自由切换中英文模式，
//  后续更新也需要同步适配英语"）
//
//  为什么用"字典 + 自动套用"而不是把每个字符串都改成 t('key')：
//  这个游戏的全部文案都是直接写在代码里的中文字面量（约 400 条，散在 DOM、canvas、
//  配置表里）。如果逐条改成 key，等于把整个项目重写一遍，而且以后每加一句都得记着
//  加 key —— 那正是用户担心会失控的地方。
//  这里的做法是：
//    1) 字典以"中文原文 → 英文"的形式存在（EN 表），一眼能看出缺哪条；
//    2) DOM 侧用 MutationObserver 自动翻译文本节点 —— 谁写的、什么时候写的都不用管，
//       以后新加的界面文案只要字典里有就自动跟着切；
//    3) canvas 侧在 ctx.fillText/strokeText 上装一层查表（所有画布文字都走这两个 API）；
//    4) 大段带标签的说明文字（使用说明整段）用 data-i18n="guide" 标一次，
//       英文放在下面的 HTML 表里 —— 免得被 <b> 切成几十个碎片去逐条翻；
//    5) 拼出来的句子（带数字/变量的）走 PATTERNS 正则表，调用点一个字都不用改；
//    6) 少量必须在调用点给两份的用 L(中文, 英文)；
//    7) tools/i18n-check.mjs 是守卫：扫源码里所有面向玩家的中文，字典里缺哪条就报哪条，
//       让"以后更新忘了补英文"变成一条能跑出来的红色清单，而不是上线后才被发现。
// ---------------------------------------------------------------------------

const KEY = 'hold-the-bridge:lang';

// 中文 → 英文。键必须与源码里的字面量**完全一致**（守卫会逐条对）。
const EN = {
  // ---- 开始界面 / 菜单 ----
  守桥: 'HOLD THE BRIDGE',
  '守 桥': 'HOLD THE BRIDGE',
  '守桥 · 丧尸围城': 'Hold the Bridge · Zombie Siege',
  丧尸围城: 'Zombie Siege',
  // head 里的标题 / 分享卡片文案（抓取方读的是 index.html 里那份中文，
  // 但浏览器标签、分享面板、装到主屏幕的名字要跟着玩家选的语言走 —— 见 applyMeta）
  守大桥: 'Hold the Bridge',
  '守大桥 · 丧尸围城': 'Hold the Bridge · Zombie Siege',
  '守大桥：桥面上一大波丧尸冲过来，主角在桥头开火':
    'Hold the Bridge: a horde of zombies charges down the bridge while the hero fires away',
  '单指走位、自动射击的竖屏塔防小游戏。手机扫码即玩。':
    'A portrait tower defense: drag to move, the gun fires itself. Scan the QR code to play on your phone.',
  '单指走位、自动射击的竖屏塔防小游戏。守住这座桥，别让丧尸潮过去。手机扫码即玩，能添加到主屏幕离线玩。':
    'A portrait tower defense: drag to move, the gun fires itself. Hold this bridge — do not let the horde through. Scan the QR code to play on your phone, or add it to your home screen and play offline.',
  '丧尸围城 · 你身后是最后一道防线': 'Zombie Siege · the last line stands behind you',
  你身后是最后一道防线: 'The last line stands behind you',
  '单指走位、自动射击的竖屏塔防小游戏。守住这座桥，别让丧尸潮过去。':
    'A portrait tower defense: drag to move, the gun fires itself. Hold this bridge — do not let the horde through.',
  历史最高: 'Best',
  金币: 'Coins',
  分: 'pts',
  角色: 'Hero',
  '角 色': 'HERO',
  切换出战英雄: 'Swap your hero',
  '切 换 出 战 英 雄': 'SWAP HERO',
  武器: 'Weapon',
  '武 器': 'WEAPON',
  切换主武器: 'Swap your gun',
  '切 换 主 武 器': 'SWAP GUN',
  商店: 'Shop',
  '商 店': 'SHOP',
  金币买装备: 'Spend coins',
  '金 币 买 装 备': 'SPEND COINS',
  关卡: 'Stage',
  '关 卡': 'STAGE',
  选择关卡: 'Select stage',
  '选 择 关 卡': 'SELECT STAGE',
  '第 1 关 · 可打': 'Stage 1 · open',
  '第 1 关 可打': 'Stage 1 open',
  '第 1~2 关 可选': 'Stages 1-2 open',
  '第 1~3 关 可选': 'Stages 1-3 open',
  '第 1~4 关 可选': 'Stages 1-4 open',
  '第 1 ~ 3 关可以打，第 4 关往后还在做': 'Stages 1-3 are playable, 4 and up are still being built',
  '第 1 ~ 4 关可以打，第 5 关往后还在做': 'Stages 1-4 are playable, 5 and up are still being built',
  // 【用户 m14093】第 5 关是特典关卡、6~10 关按钮删掉，选关面板下面多了两个模式
  '第 1 ~ 4 关可以打 · 无尽模式随时能进': 'Stages 1-4 are open · Endless is always available',
  '第 1~4 关都能进 · 无尽模式随时能进': 'Stages 1-4 are open · Endless is always available',
  '第 5 关 · 上': 'Stage 5 · Part 1',
  '第 5 关 · 下': 'Stage 5 · Part 2',
  '特典关卡 · 敬请期待~': 'Special stage · coming soon~',
  '敬请期待~': 'Coming soon~',
  '无 尽 模 式': 'E N D L E S S',
  无尽模式: 'Endless',
  '没有终点 · 全员出动 · 四技能合一': 'No finish · everything spawns · four skills',
  '单 词 模 式': 'W O R D   M O D E',
  '单词模式 · 敬请期待~': 'Word mode · coming soon~',
  上: 'Part 1',
  下: 'Part 2',
  // 无尽模式四个技能键上的字（画在 canvas 上，走字典自动翻译）
  袭: 'A',
  鱼: 'T',
  樱: 'C',
  兽: 'U',
  '鱼 雷': 'TORPEDO',

  // ---- 单词模式（【用户 m16141】Beta）----
  // 局内不走英语模式（用户 m16473），这里的英文只给"选词量 / 复盘 / 结算"三块 DOM 用。
  单词模式: 'Word mode',
  'Beta 版 · 边打边背单词': 'Beta · learn words as you play',
  '这 轮 背 多 少 个 ?': 'How many words this round?',
  '选一个数量，答完就结算': 'Pick a number — the round ends when you finish them',
  热身: 'Warm-up',
  轻松: 'Easy',
  标准: 'Standard',
  硬核: 'Hardcore',
  '答 错 了': 'Not quite',
  '这四个词都记一下 —— 红的是你选的': 'Note all four — red is what you picked',
  '继 续': 'Continue',
  '本 轮 完 成': 'Round complete',
  词汇量: 'Words',
  正确: 'Correct',
  错误: 'Wrong',
  正确率: 'Accuracy',
  最长连对: 'Best streak',
  用时: 'Time',
  '再 来 一 轮': 'Again',
  '返 回 主 界 面': 'Back to menu',
  '第 2、3 关已解锁 · 选一关开打': 'Stages 2-3 unlocked · pick one',
  '第 3 关已解锁 · 选一关开打': 'Stage 3 unlocked · pick one',
  '第 4 关已解锁 · 选一关开打': 'Stage 4 unlocked · pick one',
  '第 1~4 关都能进 · 选一关开打': 'Stages 1-4 are all open · pick one',
  '第 2~4 关已解锁 · 选一关开打': 'Stages 2-4 unlocked · pick one',
  '先打第 1 关 · 第 2、3 关也可以直接进': 'Start with stage 1 · 2 and 3 are open too',
  '先打第 1 关 · 第 2~4 关也可以直接进': 'Start with stage 1 · 2-4 are open too',
  '第一关 · 15 波': 'Stage 1 · 15 waves',
  '第 1 关': 'Stage 1',
  '第 2 关': 'Stage 2',
  '第 3 关': 'Stage 3',
  '第 4 关': 'Stage 4',
  '第 5 关': 'Stage 5',
  '第 6 关': 'Stage 6',
  '第 7 关': 'Stage 7',
  '第 8 关': 'Stage 8',
  '第 9 关': 'Stage 9',
  '第 10 关': 'Stage 10',
  '第 1 关 · 血色大桥': 'Stage 1 · Blood Bridge',
  '第 2 关 · 疯狂水世界': 'Stage 2 · Mad Water World',
  '第 4 关 · 穿越异世界': 'Stage 4 · Into Another World',
  '第 3 关 · 疯狂戴夫': 'Stage 3 · Crazy Dave',
  开始挑战: 'START',
  '开 始 挑 战': 'START',
  使用说明: 'HOW TO PLAY',
  '使 用 说 明': 'HOW TO PLAY',
  '玩 法 与 使 用 说 明': 'HOW TO PLAY',
  返回: 'Back',
  '返 回': 'BACK',
  '返 回 主 界 面': 'BACK TO MENU',
  继续游戏: 'Resume',
  '继 续 游 戏': 'RESUME',
  再来一局: 'Play again',
  '再 来 一 局': 'PLAY AGAIN',
  知道了: 'Got it',
  '知 道 了': 'GOT IT',
  '下 一 关 →': 'NEXT STAGE →',
  下一关: 'Next stage',
  '新 纪 录': 'NEW RECORD',
  '桥 头 失 守': 'BRIDGE LOST',
  // 第三关（疯狂戴夫）失守：PvZ 名场面（用户 m04749）
  你的脑子被僵尸吃掉了: 'THE ZOMBIES ATE YOUR BRAINS!',
  // 声音没起来时的提示条（用户 m04749）
  '音效没开 · 点一下画面': 'Sound is off · tap the screen',
  '第 一 关 · 通 关': 'STAGE 1 · CLEARED',
  通关: 'Cleared',
  '守 住 大 桥 ！': 'HOLD THE BRIDGE!',
  版本号: 'build',
  确认返回: 'Confirm',
  '提示：在 Safari 里点「分享 → 添加到主屏幕」，就能全屏离线玩': 'Tip: in Safari tap Share → Add to Home Screen to play fullscreen offline',
  本游戏完全免费: 'Completely free',
  English: 'English',
  中文: '中文',
  切换到中文: 'Switch to Chinese',

  // ---- 更新说明（用户 m04486）----
  // 条目原文在 js/changelog.js，这里只放英文；新增条目时两边要一起补
  更新说明: "What's new",
  '更 新 说 明': "WHAT'S NEW",
  'UI和特效重做，视觉效果全面焕新': 'UI and effects rebuilt — a full visual refresh',
  '底层架构优化，提升运行速度': 'Under-the-hood work for smoother, faster runs',
  '全面适配英语，双语种同步更新': 'Full English support, both languages updated together',
  '新增版本说明，更新一目了然~': 'New update notes — see what changed at a glance~',
  // v1.0.48（用户 m10948/m10949：条目由用户给定，只做措辞润色；预告走方案 B 的独立一行）
  '角色页面开放，可自由更换出场角色': 'Hero screen is open — switch your hero any time',
  '第四关「异世界」主题关卡上线，全新场景与敌人登场':
    'Stage 4 "Otherworld" is live — new scenery and new enemies',
  '修复多项问题，优化操作与画面细节': 'Fixed several issues; tightened controls and visuals',
  '第五关为特典关卡，主题「保护世界」':
    'Stage 5 is a special bonus stage — theme: "Protect the World"',
  // v1.0.53（用户 m11916：条目由用户给定）
  '新增第三关通关失败彩蛋': 'New game-over easter egg on Stage 3',
  '新增加载页面': 'New loading screen',
  '自该版本起，游戏改为联网模式': 'The game now runs in online mode',
  '整合和修改了部分功能与界面': 'Several features and screens consolidated and reworked',
  '新增角色花仙子，大量角色专属效果与玩法上线~':
    'New hero: the Fairy — lots of hero-specific effects and gameplay are live~',
  // v1.0.54（用户 m12738：在上面那几条的基础上新增，旧条目一条没删）
  '第四关「异世界」主题关卡上线，全新场景与敌人，玩法升级':
    'Stage 4 "Otherworld" is live — new scenery, new enemies, deeper play',
  '新增角色界面，可自由更换出战角色': 'New hero screen — switch your fighter freely',
  '修复大量 bug': 'Fixed a pile of bugs',
  即将上线: 'COMING SOON',

  // ---- HUD / 局内 ----
  波次: 'Wave',
  最高: 'Best',
  得分: 'Score',
  本关得分: 'Stage score',
  最高分: 'Best score',
  最高连杀: 'Best streak',
  撑到第: 'Reached wave',
  击杀: 'Kills',
  最终武器: 'Final weapon',
  金币总数: 'Total coins',
  空袭: 'STRIKE',
  '空 袭': 'STRIKE',
  点我: 'TAP',
  暂停: 'Pause',
  连杀: 'streak',
  准备迎战: 'GET READY',
  已: 'Paused',
  '已 暂 停': 'PAUSED',
  声音开关: 'Sound',
  音效: 'SFX',
  '音效：正常': 'SFX: normal',
  '已静音（点右上角 🔊 打开）': 'Muted (tap 🔊 top right)',
  '音效已关，点一下打开': 'SFX off · tap to enable',
  '音效已开，点一下关闭': 'SFX on · tap to mute',
  // 【用户 m10795】切后台回来没声、重建也救不回来时的兜底提示
  '声音卡死 · 请刷新页面': 'Sound blocked · please reload',
  '未启动（在画面上点一下）': 'Not started (tap the screen)',
  '被挂起 · 点一下画面': 'Suspended · tap the screen',
  '被系统打断 · 点一下画面': 'Interrupted · tap the screen',
  '被系统关闭 · 要刷新页面': 'Closed by the system · reload the page',

  // ---- 波次横幅 / 词条 ----
  割草波: 'MOW WAVE',
  精英波: 'ELITE WAVE',
  '精 英 波': 'ELITE WAVE',
  '割 草 波': 'MOW WAVE',
  'BOSS 来袭': 'BOSS INCOMING',
  '尸 潮 来 袭': 'HORDE INCOMING',
  尸潮来袭: 'HORDE INCOMING',
  尸潮: 'HORDE',
  丧尸潮: 'HORDE',
  '僵 尸 来 了 ！': 'ZOMBIES INCOMING!',
  '警报！僵尸来了！': 'ALERT! ZOMBIES!',
  '戴夫：歪比巴布 ——': 'Dave: Wabby wabbo —',
  精英来了: 'Elite incoming',
  '精英来了！': 'Elite incoming!',
  狂暴: 'Frenzy',
  '丧尸速度 +25%': 'Zombie speed +25%',
  厚皮: 'Thick hide',
  '丧尸血量 +60%': 'Zombie HP +60%',
  '数量 +50%': 'Count +50%',
  正常: 'Normal',
  生存: 'Survival',
  特效: 'Effects',
  未实装: 'Not implemented yet',
  视野变差: 'Reduced visibility',
  皮厚一倍: 'Twice as tough',
  '带队一只精英': 'brings one elite',
  '皮厚一倍 · 带队一只精英': 'Twice as tough · brings one elite',
  '一枪一个 · 放心扫': 'One shot each · mow them down',
  三波一组: 'Groups of three',
  '割草波 → 割草波 → 精英波': 'MOW → MOW → ELITE',
  战场词缀: 'modifier',
  每组的第二波: 'second wave of each group',
  押在: 'lands on',
  两场专属大场面: 'two signature set-pieces',
  每关另有: 'each stage also has',
  全是同一种僵尸: 'all one type of zombie',
  全是快跑的家伙: 'all sprinters',
  领队精英: 'elite leader',
  '压上来的：': 'coming at you:',
  来一次的: 'every',
  每: 'every',
  从: 'from',
  用: 'Use',
  点底部: 'Tap',
  分享: 'Share',
  '按钮 → 往下找': '→ scroll to',
  '「添加到主屏幕」': '“Add to Home Screen”',
  '→ 添加': '→ Add',
  版本号: 'build',

  // ---- 关卡名 / 专属大场面 / 主题 ----
  血色大桥: 'Blood Bridge',
  疯狂水世界: 'Mad Water World',
  疯狂戴夫: 'Crazy Dave',
  狂奔潮: 'Stampede',
  '全员狂奔 · 别让它们贴脸': 'All sprinters · do not let them touch you',
  迷雾压桥: 'Choking Fog',
  血月浓雾: 'Blood Moon Fog',
  '浓雾压桥 · 只能看清眼前': 'Heavy fog · you can only see right in front',
  鲨鱼群: 'Shark Pack',
  '巨人鲨成群 · 皮糙肉厚': 'Brutes in packs · thick skinned',
  酸液潮: 'Acid Tide',
  '远程齐射 · 别站着不动': 'Ranged volley · keep moving',
  铁桶潮: 'Bucket Tide',
  '全员铁桶 · 先破盾再打': 'All shielded · break the shield first',
  巨人潮: 'Giant Tide',
  '巨人成群 · 火力拉满': 'Giants in packs · max firepower',
  // 第四关（用户 m04749）：关卡名 + 两场专属大场面
  穿越异世界: 'Into Another World',
  哥布林潮: 'Goblin Tide',
  '成群哥布林 · 前排顶住': 'Goblins in packs · hold the front line',
  巨龙咆哮: 'Dragon Roar',
  '兽人压阵 · 恶龙在天上': 'Orcs press the line · a dragon overhead',

  // 第四关的敌人换皮名（血条 / 图鉴里会用到，用户 m04749）
  哥布林: 'Goblin',
  郊狼: 'Coyote',
  兽人: 'Orc',
  鹰身女妖: 'Harpy',
  史莱姆: 'Slime',
  持盾哥布林: 'Shield Goblin',
  恶龙: 'Evil Dragon',

  // 第四关的大招与 BOSS 技能（画布飘字）
  '独角兽就绪 · 点右下角': 'Unicorn ready · tap bottom right',
  '独 角 兽': 'UNICORN',
  '冲 ！': 'CHARGE!',
  '火焰吐息': 'Flame breath',
  '振翅冲击波': 'Wing shockwave',
  '召唤哥布林': 'Summon goblins',
  已用完: 'Used up',

  // 第四关的专属奖励（剑气 / 星尘 / 独角兽 / 精灵祝福，用户 m04749）
  剑气纵横: 'Blade Storm',
  '穿透 +2，剑气一刀扫过一整排': 'Pierce +2 · one slash mows a whole row',
  剑气穿透: 'Blade pierce',
  星尘散射: 'Stardust Volley',
  '弹道 +1，魔法粒子多撒一条': 'Lane +1 · one more stream of magic motes',
  独角兽加能: 'Unicorn Overcharge',
  '本局独角兽可多用 1 次': 'One extra unicorn charge this run',
  '1 次': '1 use',
  独角兽次数: 'Unicorn uses',
  精灵祝福: 'Faerie Blessing',
  '子弹伤害 ×1.15': 'Bullet damage ×1.15',
  攻击力: 'Attack',
  荆棘皮甲: 'Thorn Hide',
  疾风皮靴: 'Swift Boots',
  '移动速度 ×1.2': 'Move speed ×1.2',

  // 第四关的武器称号（勇者一条剑线，花仙子一条法杖线）
  白刃: 'Blade',
  精钢剑: 'Steel Sword',
  符文剑: 'Rune Blade',
  龙牙圣剑: 'Dragonfang Blade',
  花杖: 'Flower Wand',
  银月法杖: 'Silvermoon Wand',
  星辰法杖: 'Star Wand',
  星辉圣杖: 'Starlight Wand',

  // 角色面板（用户 m04749）
  勇者: 'Hero',
  '勇 者': 'Hero',
  花仙子: 'Flower Fairy',
  // 【用户 m12944】第三项「默认」：每关原本的主角
  默认: 'Default',
  '默 认': 'Default',
  '每关原本的主角': "Each stage's own hero",
  随关卡: 'Per stage',
  '勇者 / 花仙子四关都能用 · 默认 = 每关原本的主角':
    'Hero and Flower Fairy work on all 4 stages · Default keeps each stage’s own hero',
  '挥剑 · 剑气冲击波': 'Sword · blade shockwave',
  '魔法棒 · 魔法粒子': 'Wand · magic particles',
  近战: 'Melee',
  远程: 'Ranged',
  '只在第 4 关「穿越异世界」生效': 'Stage 4 only · Into Another World',
  '只在第 4 关「穿越异世界」生效 · 前三关沿用原主角': 'Stage 4 only · stages 1-3 keep the original hero',
  '当前就在第 4 关 · 换完立刻生效': 'You are on stage 4 · the swap applies right away',

  // 加载页小字（用户 m13363）
  '首次加载需要较长时间，请耐心等待~': 'First load can take a while — thanks for waiting~',

  // v1.0.56 更新说明（用户 m13363 给的条目）
  '修复微信打开偶发技能错位bug': 'Fixed the occasional skill-button misalignment when opening in WeChat',
  '勇者和花仙子现在适配全部关卡了': 'Hero and Flower Fairy now work on every stage',
  '勇者角色的视觉效果增强': 'Polished visuals for the Hero character',
  '修复了其他伴生bug和部分细节优化': 'Fixed assorted related bugs and polished the details',

  // ---- 介绍对话 ----
  司令: 'Commander',
  '司 令': 'Commander',
  英雄: 'Hero',
  '英 雄': 'Hero',
  大叔: 'Old Man',
  '大 叔': 'Old Man',
  戴夫: 'Dave',
  '戴 夫': 'Dave',
  '这座桥是城里最后一条退路。桥断了，后面的人一个都走不掉。':
    'This bridge is the last way out. If it falls, nobody behind us gets away.',
  '我这边弹药不够。清完这一波，我去两边捡物资。':
    'I am low on ammo. Once this wave is clear I will grab supplies from both sides.',
  '守满 15 波，桥就还有明天。': 'Hold 15 waves and the bridge lives another day.',
  '它们会一波接一波地来，最后那只是大家伙。守满 15 波 —— 一秒都别退。':
    'They come wave after wave, and the last one is a big one. Hold 15 waves — do not give an inch.',
  '桥那头已经全是水了。船还在，绞盘也在——就是得有人下去把闸门撬开，水才能退。你行不行？':
    'The far end is all water. The boat is still there, and the winch — but someone has to go down and pry the gate open. You up for it?',
  '海里爬上来的东西，比城里那些难缠。': 'What crawls out of the sea is worse than what was in the city.',
  '那就下水。把我的鱼叉枪修好，码头就交给我。': 'Then into the water. Fix my harpoon gun and the pier is mine.',
  '报告司令 —— 城市守住了，桥还在我们手里，清理已经收尾。':
    'Report, Commander — the city held, the bridge is still ours, cleanup is wrapping up.',
  '干得好。可海面不太平：声呐里全是心跳，它们从水里爬上来了。':
    'Good work. But the sea is restless: the sonar is full of heartbeats. They are crawling out of the water.',
  '明白。给我弹药和路障，我站在桥头。': 'Understood. Give me ammo and barricades — I hold the bridgehead.',
  '歪比巴布！': 'Wabby wabbo!',
  '看见没？桥面已经全是草坪了。草坪 + 僵尸 = 热闹，你懂我意思吧。':
    'See this? The deck is all lawn now. Lawn + zombies = a party. You know what I mean.',
  '甭慌 —— 你有豌豆，天上掉的阳光记得捡，攒满了扔樱桃。':
    'Easy there — you have peas, grab the suns falling from the sky, and throw cherries when charged.',
  '好 了 · 开 打 ！': 'GO TIME!',
  // ---- 第四关「穿越异世界」（用户 m04749）：说话人 + 开场三句 ----
  村长: 'Elder',
  '村 长': 'Elder',
  勇者: 'Hero',
  '勇 者': 'Hero',
  '出 发 · 清 剿 ！': 'MARCH OUT · CLEAR THEM!',
  '哥布林天刚亮就冲进村子了 —— 牲口全被赶走，麦田也点了火。':
    'Goblins hit the village at dawn — the livestock are gone and the wheat fields are burning.',
  '先把大伙撤进教堂。剩下的交给我，一步都不退。':
    'Get everyone into the chapel first. Leave the rest to me — I am not backing down.',
  '往东就是它们的巢穴……听说那头恶龙也醒了，会喷火，还会召哥布林。':
    'Their lair is east of here… they say the dragon is awake too. It breathes fire, and it calls goblins.',
  '疯 狂 水 世 界 · 启动 ！': 'MAD WATER WORLD · GO!',
  '▼ 点一下继续': '▼ TAP TO CONTINUE',
  '点一下继续': 'Tap to continue',
  '点一下屏幕任意位置': 'tap anywhere on the screen',

  // ---- 使用说明里的小节标题 ----
  怎么玩: 'How to play',
  奖励门: 'Reward gates',
  连杀与大招: 'Streak & strike',
  武器成长: 'Weapon growth',
  '波次节奏（三波一组）': 'Wave rhythm (groups of three)',
  僵尸图鉴: 'Zombie codex',
  战场上的额外情况: 'Battlefield modifiers',
  '装到桌面（推荐）': 'Add to Home Screen (recommended)',
  离线也能玩: 'Play offline',
  以后更新: 'Updates',
  '没声音？打不开？': 'No sound? Not loading?',
  桌面图标: 'Home icon',
  '全屏无地址栏': 'Fullscreen, no address bar',
  '跟 App 一样': 'just like an app',
  联网打开一次: 'open it once online',
  就会把全部文件存进手机: 'and every file is stored on your phone',
  '新版推上去后，': 'After a new build ships, ',
  '联网打开（或下拉刷新）一次就是新版': 'open it once online (or pull to refresh) and you are on the new build',
  不用重新添加到桌面: 'no need to re-add it to the home screen',
  '如果打开还是旧画面：把标签页关掉重进一次；主界面右下角的':
    'If you still see the old build: close the tab and reopen. The',
  变新了就是更新成功: 'at the bottom right of the menu shows the new version — that means the update worked',
  '没声音：先': 'No sound: first',
  '（iOS 要求先碰一下才允许出声），再确认左上角的喇叭不是静音':
    ' (iOS only allows audio after a tap), then check the speaker at the top left is not muted',
  '打不开：确认网络，或者把这一页关掉重新打开一次':
    'Will not load: check your network, or close this page and open it again',
  '别去点「设置 → Safari → 清除历史记录与网站数据」，那会把游戏一起清掉':
    'Do not use Settings → Safari → Clear History and Website Data — that wipes the game too',
  '打开本页（微信里点右上角 ··· →「在 Safari 中打开」）':
    'Open this page (in WeChat: tap ··· top right → Open in Safari)',

  // ---- 僵尸 / 植物 ----
  小兵: 'Grunt',
  快跑者: 'Sprinter',
  重装兵: 'Brute',
  吐酸者: 'Spitter',
  铁盾兵: 'Shielded',
  分裂者: 'Splitter',
  '尸潮首领（BOSS）': 'Horde Boss',
  尸潮首领: 'Horde Boss',
  僵尸博士: 'Zombie Doctor',
  僵王: 'Boss',
  豌豆: 'Pea',
  豌豆射手: 'Peashooter',
  双发射手: 'Repeater',
  三线射手: 'Threepeater',
  机枪豌豆: 'Gatling Pea',
  玉米加农炮: 'Kernel Cannon',
  巨型樱桃: 'Giant cherry',
  寒冰: 'Ice',
  炎火: 'Fire',
  寒冰弹道: 'Ice lane',
  炎火弹道: 'Fire lane',
  寒冰豌豆: 'Ice pea',
  炎火豌豆: 'Fire pea',
  水雷: 'Mine',
  '水雷命中！': 'Mine hit!',
  水雷已布好: 'Mines laid',
  '河豚炸开！': 'Pufferfish burst!',
  点燃: 'Burn',

  // ---- 僵尸图鉴里的短语（画布上的说明）----
  僵尸是: 'Zombies come',
  枪是: 'The gun is',
  自动开的: 'automatic',
  蓄力扑击: 'charge pounce',
  血厚得很: 'very thick hide',
  '每 2 秒就往脚下放一批小僵尸': 'drops a batch of little zombies every 2 s',
  技能也一刻不停: 'and never stops casting',
  导弹阵: 'missile array',
  '快 2 秒后': 'lands 2 s later',
  '被打中掉 1 格血': 'a hit costs 1 heart',
  一定留出空档: 'always leaves a gap',
  火球齐射: 'fireball volley',
  '也只铺 3 颗、左右留出能站人的通道。它身上挂着':
    ' only lays 3 balls and keeps room to stand on both sides. It carries',
  两段血: 'two health bars',
  变身: 'transforms',
  死的时候会炸开一圈: 'burst when they die',
  补给: 'supply drops',
  永久加攻击力: 'permanent attack up',
  '警报 + 3 2 1 倒数': 'alarm + 3-2-1 countdown',
  有些战场会掉: 'some battlefields drop',
  击杀有几率掉落治疗包: 'Kills can drop medkits',

  // ---- 奖励 / 升级 ----
  弹道数: 'Lanes',
  '弹道 +1，同时射出多颗子弹': '+1 lane, one more bullet per shot',
  子弹伤害: 'Bullet damage',
  穿透: 'Pierce',
  '穿透 +1，子弹可穿过敌人': 'Pierce +1, bullets pass through enemies',
  暴击率: 'Crit chance',
  '暴击率 +12%': 'Crit chance +12%',
  暴击伤害: 'Crit damage',
  '暴击伤害 +60%': 'Crit damage +60%',
  射速: 'Fire rate',
  '射速 ×1.18': 'Fire rate ×1.18',
  '射速 ×1.25': 'Fire rate ×1.25',
  子弹速度: 'Bullet speed',
  '子弹飞行速度 ×1.22': 'Bullet speed ×1.22',
  移动速度: 'Move speed',
  '英雄移动速度 ×1.16': 'Hero speed ×1.16',
  敌人速度: 'Enemy speed',
  掉落几率: 'Drop chance',
  空袭伤害: 'Strike damage',
  '空袭伤害 ×1.5': 'Strike damage ×1.5',
  '空袭伤害 ×1.6': 'Strike damage ×1.6',
  '空袭充能速度 ×1.4': 'Strike charge ×1.4',
  充能速度: 'Charge rate',
  持续伤害: 'Damage over time',
  '命中点燃敌人，持续掉血': 'Ignites enemies · damage over time',
  '命中减速敌人 45%': 'Slows enemies 45% on hit',
  '一条弹道变寒冰：一发两颗，寒冰弹命中减速 55%':
    'One lane becomes ice: two peas per shot, 55% slow on hit',
  '一条弹道变炎火：一发两颗，炎火弹命中持续燃烧':
    'One lane becomes fire: two peas per shot, burns on hit',
  '每波开始时获得 1 层护盾': 'Gain 1 shield at the start of each wave',
  '每波开始时获得 2 层护盾': 'Gain 2 shields at the start of each wave',
  '每波开始时在前方布 3 颗水雷，敌人碰到就炸':
    'Lay 3 mines ahead at the start of each wave · enemies that touch them blow up',
  布设水雷: 'Lay mines',
  '生命上限 +1，并回满生命': 'Max hearts +1 and heal to full',
  '生命上限 +2，并回满生命': 'Max hearts +2 and heal to full',
  立即回血: 'Instant heal',
  '立即回复 2 点生命': 'Restore 2 hearts instantly',
  阳光效果: 'Sun effect',
  '每个阳光的充能与攻击加成 ×1.6': 'Each sun gives ×1.6 charge and attack',
  阳光充沛: 'Sunny',
  樱桃范围: 'Cherry radius',
  '樱桃炸弹范围 ×1.35': 'Cherry blast ×1.35',
  战地医疗: 'Field medic',
  火力强化: 'Firepower',
  穿甲弹头: 'AP rounds',
  重装弹头: 'Heavy rounds',
  高速弹药: 'High-velocity ammo',
  液氮弹: 'Liquid nitrogen',
  燃烧弹: 'Incendiary',
  磁力吸取: 'Magnet',
  超导电容: 'Super capacitor',
  能量护盾: 'Energy shield',
  气泡护盾: 'Bubble shield',
  珊瑚装甲: 'Coral armor',
  装甲加固: 'Armor plating',
  机动: 'Mobility',
  轻装疾行: 'Light step',
  双管齐射: 'Twin barrels',
  鱼类鱼雷: 'Fish torpedo',
  鱼雷: 'Torpedo',
  洋流加速: 'Current boost',
  致命一击: 'Deadly blow',
  急速扳机: 'Rapid trigger',
  三线: 'Triple lane',
  双发: 'Double shot',
  加农: 'Cannon',
  机枪: 'Machine gun',
  破坏者: 'Ravager',
  毁灭者: 'Destroyer',
  等离子: 'Plasma',
  强化弹: 'Upgraded rounds',
  制式弹: 'Standard rounds',
  '空袭就绪 · 点右下角': 'Strike ready · tap bottom right',
  '樱桃炸弹就绪 · 点右下角': 'Cherry ready · tap bottom right',
  '← 走位吃奖励 →': '← MOVE TO GRAB →',

  // ---- 奖励卡上的分类标签 / 短标签（js/config.js 的 tag、short、amt）----
  伤害: 'DMG',
  弹道: 'LANES',
  每波护盾: 'Shield/wave',
  生命上限: 'Max hearts',
  '子弹伤害 +1': 'Bullet damage +1',
  '3 颗': '3 mines',
  '+1 生命': '+1 HEART',
  '· 金币': '· Coins',

  // ---- 局内飘字 / 波次名（js/game.js、js/config.js）----
  破盾: 'SHIELD BREAK',
  护盾抵挡: 'BLOCKED',
  导弹来袭: 'MISSILE INCOMING',
  召唤尸潮: 'SUMMON HORDE',
  疾行者: 'Sprinters',
  '樱 桃 炸 弹': 'CHERRY BOMB',
  '再 玩 一 次': 'PLAY AGAIN',
  '疯 狂 水 世 界 · 启 动 ！': 'MAD WATER WORLD · GO!',
  '……那就下水。把我的鱼叉枪修好，码头就交给我。':
    '…Then we go in. Fix my harpoon gun and the pier is mine.',
  '歪比巴布！！……咳，我是说：歪、比、巴、布。':
    'Wabby wabbo!! …ahem. I mean: wab-by-wab-bo.',

  // ---- 金币结算 ----
  每关打完按得分结算: 'Coins are awarded from your score after each stage',
  每关打完按得分结算金币: 'Coins are awarded from your score after each stage',
  '歇一口气，桥还在那儿': 'Take a breath — the bridge is still there',
};

// 拼出来的句子：正则 → 英文模板（$1… 是捕获组）。
// 反向（英文 → 中文）不写第二套正则：翻译时把"英文结果 → 中文原文"记进 PAT_BACK，
// 切回中文时直接查那张表 —— 屏幕上出现过的句子一定有记录。
const PATTERNS = [
  [/^第 (\d+) \/ (\d+) 波$/, 'Wave $1 / $2'],
  [/^第 (\d+)\/(\d+) 波 (.+)来袭 · (\d+)$/, (m) => `Wave ${m[1]}/${m[2]} · ${tagEn(m[3])} incoming · ${m[4]}`],
  [/^第 (\d+) 波清除 \+(\d+)$/, 'Wave $1 cleared +$2'],
  [/^(\d+) 连杀！$/, '$1 STREAK!'],
  [/^(\d+) 连杀$/, '$1 STREAK'],
  [/^(.+) 进化！$/, (m) => `${I18Nd(m[1])} evolves!`],
  [/^(\d+) 连导弹来袭$/, '$1 missiles incoming'],
  [/^(.+)通关！\+(\d+) 金币$/, (m) => `${I18Nd(m[1])} cleared! +${m[2]} coins`],
  [/^☀ 攻击 \+(\d+)%$/, '☀ ATK +$1%'],
  [/^(.+) · 攻\+(\d+)%$/, (m) => `${I18Nd(m[1])} · ATK+${m[2]}%`],
  [/^(.+) · 通 关$/, (m) => `${I18Nd(m[1])} · CLEARED`],
  [/^(.+) · 该功能未实装$/, (m) => `${m[1]} · not implemented yet`],
  [/^第 (\d+) 关 · 该关卡未实装$/, 'Stage $1 · not implemented yet'],
  [/^暴击 (\d+)$/, 'CRIT $1'],
  [/^被导弹命中 -(\d+)$/, 'Missile hit -$1'],
  [/^武器进化 · (.+)$/, (m) => `Weapon evolved · ${I18Nd(m[1])}`],
  [/^第 (\d+) 条弹道 · (寒冰|炎火)（一发两颗）$/, (m) => `Lane ${m[1]} · ${m[2] === '寒冰' ? 'Ice' : 'Fire'} (two peas)`],
  [/^音效：(.+)$/, (m) => `SFX: ${I18Nd(m[1])}`],
];

// 使用说明整段（data-i18n="guide"）的英文版：结构与中文那份一致。
const HTML = {
  guide: `
        <h3>Zombie compendium</h3>
        <p class="tiny">Every stage has its own cast — learn them first; ★ marks the stage boss.</p>

        <h4>Stage 1 · Blood Bridge</h4>
        <ul class="howto">
          <li><b>Walker</b>: the basic grunt, one shot each; a mass rush is a horde — perfect for farming score</li>
          <li><b>Runner</b>: small, fast, thin — take it out first</li>
          <li><b>Brute</b>: slow and very tough, don’t let it crawl up to you</li>
          <li><b>Shield</b>: holds a shield, half damage from the front — break the shield first</li>
          <li><b>Spitter</b>: spits acid from afar and leaves a damaging puddle</li>
          <li><b>Splitter</b>: splits into two smaller copies when it dies</li>
          <li><b>★ Horde Chief</b>: can’t reach you but is very tanky; drops a batch of walkers every 2 seconds and calls down red-circle missiles (about 2 seconds of warning, step out to dodge). Its health comes in two bars</li>
        </ul>

        <h4>Stage 2 · Crazy Water World</h4>
        <ul class="howto">
          <li>The whole cast turns aquatic: fish walkers, squid runners, crab brutes, turtle shields, jelly splitters</li>
          <li><b>Puffer spitter</b>: same ranged acid, and bursts into a ring when it dies</li>
          <li><b>★ Shark King</b>: the aquatic Horde Chief — same kit (spawns + missile grids)</li>
        </ul>

        <h4>Stage 3 · Crazy Dave</h4>
        <ul class="howto">
          <li>Plants vs. Zombies skin: zombies, pole-vault runners, gargantuar brutes, bucket shields, imp splitters</li>
          <li><b>★ Zomboss</b>: break its first health bar and it <b>evolves into Dr. Zomboss</b> on the spot — thicker bar, denser kit (missile grids / fireball volleys)</li>
        </ul>

        <h4>Stage 4 · Otherworld</h4>
        <ul class="howto">
          <li><b>Goblin</b> walkers, <b>coyote</b> runners, <b>orc</b> brutes, <b>shield goblins</b> (front damage cut), <b>slimes</b> (split on death)</li>
          <li><b>Harpy</b>: ranged wing-beat attack, and it dives at you</li>
          <li><b>★ Dragon</b>: <b>Flame Breath</b> covers the whole bridge and leaves exactly one fixed gap (a single wall); <b>Wing Beat</b> sends two crescents that take a heart if they clip you; and it keeps summoning goblins</li>
        </ul>

        <h3>Stage skills</h3>
        <ul class="howto">
          <li><b>Stage 1</b>: <b>Airstrike</b> — tap the bridge and a line of bombs lands there</li>
          <li><b>Stage 2</b>: <b>Airstrike</b> — same, but the bombs are torpedoes</li>
          <li><b>Stage 3</b>: <b>Cherry Bomb</b> — one huge bomb, the widest blast of all</li>
          <li><b>Stage 4</b>: <b>Unicorn Charge</b> — a unicorn sweeps one whole lane clear</li>
        </ul>

        <h3>Install to home screen</h3>
        <ul class="howto">
          <li><b>iPhone / iPad</b>: open this page in Safari (in WeChat tap ··· → “Open in Safari”) → Share → “Add to Home Screen”</li>
          <li><b>Android</b>: open in Chrome → menu top right → “Add to Home screen”</li>
          <li>Launched from the icon it runs full screen with no address bar, like an app; one online visit caches everything for offline play</li>
        </ul>

        <h3>No sound?</h3>
        <ul class="howto">
          <li>Make sure the phone’s mute switch (the side one on iPhone) is off — it silences web games too</li>
          <li>iOS only allows audio after a touch: <b>tap anywhere once</b>, then check the speaker top left is not muted</li>
          <li>Still silent? Close the page and open it again</li>
        </ul>

        <h3>Updates</h3>
        <ul class="howto">
          <li>After a deploy, <b>open online or pull to refresh once</b> and you are on the new build — no need to re-add to the home screen</li>
          <li>The <b>version number</b> bottom right shows the current build; tap “Update notes” to see what changed</li>
          <li>Still the old screen? Close the tab and open it again</li>
        </ul>`,
};

// 波次标签（横幅里拼进句子用）
function tagEn(tag) {
  return { 尸潮: 'HORDE', '尸潮': 'HORDE', BOSS: 'BOSS', 精英: 'ELITE' }[tag] || tag;
}
function I18Nd(s) {
  return EN[s] || s;
}

// 运行时拼出来的短句（`−35% 敌人速度`、PVZ 词条的 `敌人速度+`、`−35%  液氮弹`）
// 整串在字典里当然查不到 —— 但它里面那段中文是字典里的一条。
// 所以整串查不到时，再在"词的边界"上替换一次：只认前后不是中日韩字/字母/数字的位置，
// 而且只对短串做（长句交给 PATTERNS，免得在一句没收录的话里换掉半句）。
const CJK = /[\u3400-\u9fff]/;
const WORD = /[0-9A-Za-z_\u3400-\u9fff]/;
const SUB = Object.keys(EN)
  .filter((k) => k.length >= 2 && CJK.test(k))
  .sort((a, b) => b.length - a.length);

const ZH = {};
for (const [zh, en] of Object.entries(EN)) if (!(en in ZH)) ZH[en] = zh;

// 翻译过的句子在这里留一份对照（英文 → 中文原文）。切回中文时优先查它，
// 这样"带字距空格"的按钮文案（开 始 挑 战）能原样还原，而不是变成同义的另一种写法。
const BACK = new Map();

let lang = 'zh';
try {
  const saved = window.localStorage && window.localStorage.getItem(KEY);
  if (saved === 'en' || saved === 'zh') lang = saved;
} catch (e) {
  /* 隐私模式下拿不到 localStorage，就用中文 */
}

function isEn() {
  return lang === 'en';
}

// ---------------------------------------------------------
//  页面标题 + 分享元信息（用户 m02901："页面标题与分享元信息全部覆盖"）
//  index.html 的 head 里写的是中文（抓取方不看 JS，得有一份默认值），
//  玩家真正看到的那份（浏览器标签、微信/QQ 分享卡片、加到主屏幕的名字）
//  在切语言时换成英文。中文字符串本身也留在 EN 表里当键 ——
//  这样"中文原文 → 英文"只有一处真相，守卫也能核到。
// ---------------------------------------------------------
const HEAD = {
  title: '守桥 · 丧尸围城',
  appTitle: '守桥',
  siteName: '守大桥',
  shareTitle: '守大桥 · 丧尸围城',
  desc: '单指走位、自动射击的竖屏塔防小游戏。守住这座桥，别让丧尸潮过去。',
  shareDesc: '单指走位、自动射击的竖屏塔防小游戏。守住这座桥，别让丧尸潮过去。手机扫码即玩，能添加到主屏幕离线玩。',
  twDesc: '单指走位、自动射击的竖屏塔防小游戏。手机扫码即玩。',
  imgAlt: '守大桥：桥面上一大波丧尸冲过来，主角在桥头开火',
};

function applyMeta() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  // 冒烟测试里的 document 桩只有 documentElement / body，没有查节点这回事 ——
  // 这里静默跳过，别让"标题翻译"把不需要 DOM 的测试搞红。
  if (typeof document.querySelector !== 'function') return;
  const t = (zh) => (isEn() ? EN[zh] || zh : zh);
  const meta = (sel, val) => {
    const node = document.querySelector(sel);
    if (node && node.getAttribute('content') !== val) node.setAttribute('content', val);
  };
  const title = t(HEAD.title);
  if (document.title !== title) document.title = title;
  meta('meta[name="description"]', t(HEAD.desc));
  meta('meta[name="apple-mobile-web-app-title"]', t(HEAD.appTitle));
  meta('meta[property="og:site_name"]', t(HEAD.siteName));
  meta('meta[property="og:title"]', t(HEAD.shareTitle));
  meta('meta[property="og:description"]', t(HEAD.shareDesc));
  meta('meta[property="og:image:alt"]', t(HEAD.imgAlt));
  meta('meta[name="twitter:title"]', t(HEAD.shareTitle));
  meta('meta[name="twitter:description"]', t(HEAD.twDesc));
  // 装到主屏幕的名字取自 manifest：切语言时换成英文那份清单
  const man = document.querySelector('link[rel="manifest"]');
  if (man) {
    const href = isEn() ? './manifest.en.webmanifest' : './manifest.webmanifest';
    if (man.getAttribute('href') !== href) man.setAttribute('href', href);
  }
  const lg = isEn() ? 'en' : 'zh-CN';
  if (document.documentElement.getAttribute('lang') !== lg) {
    document.documentElement.setAttribute('lang', lg);
  }
}

// 一句中文 → 英文（查不到就原样返回）
function toEn(s) {
  const core = String(s);
  const hit = EN[core];
  if (hit) {
    BACK.set(hit, core);
    return hit;
  }
  for (const [re, out] of PATTERNS) {
    const m = core.match(re);
    if (!m) continue;
    const en = typeof out === 'function' ? out(m) : core.replace(re, out);
    BACK.set(en, core);
    return en;
  }
  if (core.length <= 24 && CJK.test(core)) {
    for (const k of SUB) {
      const i = core.indexOf(k);
      if (i < 0) continue;
      const before = i > 0 ? core[i - 1] : '';
      const after = core[i + k.length] || '';
      if (WORD.test(before) || WORD.test(after)) continue;
      const en = core.slice(0, i) + EN[k] + core.slice(i + k.length);
      BACK.set(en, core);
      return en;
    }
  }
  return core;
}

// 一句英文 → 中文（先查"这次真的翻过的那句"，再查字典反查表）
function toZh(s) {
  const core = String(s);
  const back = BACK.get(core);
  if (back) return back;
  return ZH[core] || core;
}

// 【用户 m16473】单词模式局内不走英语模式：题干是英文、选项是中文，
// 任何自动翻译都会把两边搅乱（反查表还带"袭→A""樱→C"这种单字母）。
let bypass = false;

export const I18N = {
  get lang() {
    return lang;
  },
  isEn,
  /** 局内暂停自动翻译（单词模式用）；恢复时传 false */
  setBypass(v) {
    bypass = !!v;
  },
  get bypassed() {
    return bypass;
  },
  // 通用翻译入口（也跟着当前语言走）
  tr(s) {
    if (bypass) return String(s);
    return isEn() ? toEn(s) : toZh(s);
  },
  // 必须在调用点给两份的句子（带变量、而且变量本身也要翻的）
  L(zh, en) {
    return isEn() ? en : zh;
  },
  // persist=false：只临时切界面语言，不写 localStorage（单词模式开局用，用户 m16473）
  set(next, persist = true) {
    if (next !== 'en' && next !== 'zh') return;
    lang = next;
    if (persist) {
      try {
        window.localStorage && window.localStorage.setItem(KEY, lang);
      } catch (e) {
        /* 存不了就算了，只影响下次打开 */
      }
    }
    this.applyDom();
  },
  toggle() {
    this.set(isEn() ? 'zh' : 'en');
  },

  // ---- DOM ----
  // 整段替换用的节点集合：自己带 data-i18n 也算（可能被 applyDom 单独喂进来）
  _i18nNodes(root) {
    const nodes = [];
    if (root.nodeType === 1 && root.hasAttribute && root.hasAttribute('data-i18n')) nodes.push(root);
    if (root.querySelectorAll) nodes.push(...root.querySelectorAll('[data-i18n]'));
    return nodes;
  },
  // data-i18n="guide" 这种整段替换：第一次替换前把中文原样存进 dataset，切回中文时还原
  _htmlPass(root) {
    for (const node of this._i18nNodes(root)) {
      const key = node.getAttribute('data-i18n');
      const en = HTML[key];
      if (en === undefined) continue;
      if (node.dataset.i18nZh === undefined) node.dataset.i18nZh = node.innerHTML;
      const want = isEn() ? en : node.dataset.i18nZh;
      if (node.innerHTML !== want) node.innerHTML = want;
    }
  },

  _walk(root) {
    // 没有 TreeWalker（无浏览器的测试桩里）就没什么可翻的 —— 翻译是渐进增强，
    // 不能因为环境缺 API 把游戏本身搞崩。
    if (typeof document.createTreeWalker !== 'function') return;
    // data-i18n 的子树由 HTML 表整段负责；data-no-i18n 的子树（比如语言按钮自己）
    // 永远不碰，否则会出现"语言按钮被翻译成另一种语言"的鬼故事
    const skip = new Set();
    if (root.nodeType === 1 && root.hasAttribute && (root.hasAttribute('data-i18n') || root.hasAttribute('data-no-i18n'))) skip.add(root);
    if (root.querySelectorAll) {
      for (const n of root.querySelectorAll('[data-i18n]')) skip.add(n);
      for (const n of root.querySelectorAll('[data-no-i18n]')) skip.add(n);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        for (let p = n.parentNode; p; p = p.parentNode) {
          if (skip.has(p)) return NodeFilter.FILTER_REJECT;
          if (p.hasAttribute && p.hasAttribute('data-no-i18n')) return NodeFilter.FILTER_REJECT;
        }
        return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const hits = [];
    while (walker.nextNode()) hits.push(walker.currentNode);
    for (const node of hits) {
      const raw = node.nodeValue;
      const core = raw.trim();
      const out = this.tr(core);
      if (out !== core) node.nodeValue = raw.replace(core, () => out);
    }
  },

  applyDom(root = document.body) {
    if (!root) return;
    if (root.nodeType === 1 && root.hasAttribute && root.hasAttribute('data-no-i18n')) return;
    this._htmlPass(root);
    this._walk(root);
    if (root === document.body) {
      document.documentElement.setAttribute('data-lang', lang);
      applyMeta();
    }
  },

  // 标题 / 分享元信息也单独给一个入口（冒烟测试直接调它，不用造整个 body）
  applyMeta,

  // 这个文本节点是不是在"禁止翻译"的子树里（语言按钮等）
  _blocked(node) {
    for (let p = node && node.parentNode; p; p = p.parentNode) {
      if (p.hasAttribute && (p.hasAttribute('data-no-i18n') || p.hasAttribute('data-i18n'))) return true;
    }
    return false;
  },

  // 以后的界面文案（JS 动态写进去的）也自动跟着切
  watchDom(target = document.body) {
    if (this._obs || !target || !window.MutationObserver) return this._obs;
    this._obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') {
          const raw = r.target.nodeValue;
          if (!raw || !raw.trim() || this._blocked(r.target)) continue;
          const core = raw.trim();
          const out = this.tr(core);
          if (out !== core) r.target.nodeValue = raw.replace(core, () => out);
        } else {
          for (const n of r.addedNodes) {
            if (n.nodeType === 1) this.applyDom(n);
            else if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim() && !this._blocked(n)) {
              const core = n.nodeValue.trim();
              const out = this.tr(core);
              if (out !== core) n.nodeValue = n.nodeValue.replace(core, () => out);
            }
          }
        }
      }
    });
    this._obs.observe(target, { childList: true, subtree: true, characterData: true });
    return this._obs;
  },

  // ---- canvas ----
  // 画布上的文字全都走 fillText / strokeText（render.js 里没有别的写字途径），
  // 所以只在这一层装查表就覆盖了 HUD、横幅、飘字、按钮上的所有中文。
  installCanvas(ctx) {
    if (!ctx || ctx.__i18nWrapped) return;
    ctx.__i18nWrapped = true;
    // 【用户 m16141】单词模式的口语/单词必须原样画：
    // 反查表里有"袭→A""樱→C""鱼→T""兽→U"这种单字母映射，
    // 走翻译的话题干里的 A/B/C/D 会被替成汉字。这里把原始实现留个口子。
    ctx.__rawFillText = ctx.fillText.bind(ctx);
    ctx.__rawStrokeText = ctx.strokeText.bind(ctx);
    for (const name of ['fillText', 'strokeText']) {
      const orig = ctx[name].bind(ctx);
      ctx[name] = (text, ...rest) =>
        orig(bypass ? text : isEn() ? toEn(text) : toZh(text), ...rest);
    }
  },
};

export default I18N;
