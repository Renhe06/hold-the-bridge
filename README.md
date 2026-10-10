# 守桥 · 丧尸围城

一个给 iPhone 玩的竖屏网页小游戏：你站在一条窄桥的桥头，丧尸从远处涌来，身后是最后一道防线。
**纯静态、零依赖、零构建**——`index.html` + 几个 ES module + 一个 Canvas，扔到任何静态托管上都能跑。

## 玩法

- **单指拖动**屏幕任意位置：左右是走位，**上下能前进/后退**（越靠前打出的伤害越高，最高 +19.6%）
- **自动开火**，不用瞄准，只需要走位
- 丧尸挤到桥头会**蓄力扑击**——看到它下蹲发光就让开
- 每清一波，桥面左右滑来两块**奖励门**（`+ / × / −` 大字），**你站在哪半边就吃哪一块**，没有任何弹窗
- 连续击杀攒**连杀**，分数按连杀数放大（最高 ×2.5）；**被咬一口连杀立刻清零**
- 击杀充能，满了点**右下角「空袭」**，一串炮弹从远处犁到桥头
- 每 3 波一个**词条**（狂暴 / 厚皮 / 丧尸潮 / 血月浓雾 / 疾行者）
- 七种敌人：小兵、快跑者、大块头、BOSS、**吐酸者**（远处吐酸）、**铁盾兵**（带盾减半伤）、**分裂者**（死后裂两只）
- 最高分存在手机本地（`localStorage`）

## 本地跑

```bash
node tools/serve.mjs 8123      # 然后开 http://127.0.0.1:8123/
```

`tools/serve.mjs` 而不是 `python -m http.server`，是因为后者会把 `.webmanifest` 发成
`application/octet-stream`（PWA 装不上），而且会带 `Last-Modified` 让手机上吃到旧文件。

手机上真机调试：浏览器打开电脑的局域网地址（`http://192.168.x.x:8123/`）即可。

## 怎么改

| 想改什么 | 改哪 |
| --- | --- |
| 数值（血量、伤害、出怪节奏、怪的种类、词条、升级池） | `js/config.js`，**只改这一个文件就够了** |
| 游戏逻辑（出怪、伤害、充能、拾取、状态机） | `js/game.js` |
| 画面（桥面、丧尸、英雄、奖励门、HUD、空袭按钮） | `js/render.js` |
| 输入、状态与 DOM 的同步、启动 | `js/main.js` |
| 音效（全部是 WebAudio 现场合成，没有音频文件） | `js/audio.js` |
| 透视角与投影 | `js/camera.js` |
| 页面结构 / 样式 | `index.html` / `styles.css` |
| 图标 | `node tools/make-icons.mjs`（纯 Node 手写 PNG 编码，不依赖任何图形库） |

改完**一定要跑一遍自测**：

```bash
node tools/smoke-test.mjs     # 27 条断言：真的把 main.js 跑起来 + 一个会走位会选门的机器人打到死
node tools/dom-check.mjs      # js 里引用的 id 是否都在 index.html 里（拼错就是整页白屏）
node tools/balance-probe.mjs  # 逐波算账：需要多少 DPS、估计有多少 DPS、余量够不够
```

`tools/dom-stub.mjs` 是最小 DOM/Canvas 桩，冒烟测试和出图夹具共用它，避免两边形状漂移。
`tools/smoke-test.mjs` 里的随机源是**种死的**（`makeRng(20240613)`），所以调参前后成绩可比。

## 发布与更新

托管在 GitHub Pages，推送即上线（见 `.github/workflows/pages.yml`）：

```powershell
pwsh -File tools/deploy.ps1 "改了什么"     # = git add -A && git commit && git push
```

推上去约 40 秒后生效。Service Worker 是**网络优先**，所以手机上刷新就是新版本
（如果加了主屏幕图标，关掉重开）。`sw.js` 里的 `CACHE` 名字只在需要强制清离线缓存时才动。

## 注意（iOS Safari 的坑，已在代码里处理）

- `viewport-fit=cover` + `env(safe-area-inset-*)` 适配刘海/灵动岛
- 高度用 `100dvh`（Safari 地址栏伸缩时 `100vh` 会跳），并保留 `100vh` 兜底
- `touch-action: none` + 拦掉双击缩放和橡皮筋
- 全部用 Pointer 事件，不用 `click`（避免 iOS 的 300ms 延迟），单指锁 + `setPointerCapture`
- WebAudio 必须等第一次触摸才能出声（`Sound.unlock()`）
- Canvas 按 `devicePixelRatio` 缩放（封顶 2，dpr=3 时像素量是 2 的 2.25 倍但看不出差别）
- `manifest.webmanifest` + `apple-mobile-web-app-capable` 支持「分享 → 添加到主屏幕」全屏玩
