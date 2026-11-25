// ============================================================
//  Service Worker —— 让游戏加到主屏幕后能离线打开
//  只在 https 下注册（main.js 里已跳过 localhost，方便开发时改完就生效）
//
//  【用户 m06896】"不用完全追求离线游玩，先保证游戏体验，不然老是卡顿"：
//  以前 install 时把**全部资源**（含两张 300~460KB 的第四关立绘）一次性 addAll，
//  每次改版本号都要重下一遍，首开还得等这一坨下载完 —— 卡顿的一大来源。
//  现在分两类：
//    ① 外壳（html/css/js/字体/图标）：这层小（~200KB），预缓存，
//       取的时候**缓存优先**，命中就直接出、不再等网络；同时后台顺手更新缓存
//       （版本号变了新 SW 会重新预缓存并清掉旧缓存，所以不会"永远跑旧版本"）。
//    ② 图片等大资源：**不拦**，交给浏览器自己的 HTTP 缓存。
//       离线时外壳还在、能打开游戏；图片没缓存上顶多暂时缺图（渲染器有手绘兜底）。
// ============================================================

const CACHE = 'hold-the-bridge-v1.0.93';

// 只预缓存"外壳"：打开游戏必需的那几样，体积小、改动频繁
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './fonts/smiley-sans.woff2',
  './manifest.webmanifest',
  // 英文清单：切到 English 时装到主屏幕的名字也走英文（i18n.js 的 applyMeta 换 href）
  './manifest.en.webmanifest',
  './js/main.js',
  // 普通脚本（非模块）：模块图整个挂掉时它仍要能跑，负责显示"资源没加载完"的提示
  './js/failsafe.js',
  // 【2026-11-24】art.js 是 main/render/sea-whale 的**静态依赖**：
  // 漏掉它的话，Shell 缓存命中 main.js 而 art.js 取不到时，整个模块图直接加载失败 ——
  // 页面只剩静态 DOM、画布一片黑（用户报的"进去到处都是空白"）。
  './js/art.js',
  // 【本次】同一个坑又抓到一处：wordbook.js 被 game.js 静态 import，
  // 却一直没进外壳表。离线打开（装到主屏幕 / 断网重开）时它取不到，
  // 整张模块图失败 —— 症状和上面 art.js 那次一模一样。
  './js/wordbook.js',
  './js/config.js',
  './js/util.js',
  './js/quality.js',
  './js/i18n.js',
  './js/changelog.js',
  './js/words-bank.js',
  './js/words-cet4.js',
  './js/words-cet6.js',
  './js/words-kaoyan.js',
  './js/camera.js',
  './js/audio.js',
  './js/game.js',
  './js/render.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// 哪些请求算"外壳"：html / css / js / 字体 / 站点清单 / 根路径
function isShell(url) {
  const p = url.pathname;
  if (p.endsWith('/hold-the-bridge/') || p.endsWith('/')) return true;
  return /\.(?:html|css|js|mjs|woff2?|webmanifest)$/i.test(p);
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  if (url.origin !== location.origin) return;
  // 图片 / 音频这类大资源不拦：让浏览器自己的 HTTP 缓存去管，少一层转发就少一次卡顿
  if (!isShell(url)) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      // 后台顺手更新（stale-while-revalidate）：这一帧先用缓存，下一轮就是新的
      const fresh = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => null);
      if (hit) {
        e.waitUntil(fresh.catch(() => {}));
        return hit;
      }
      return fresh.then(
        (res) =>
          res ||
          // 断网 + 没缓存：兜底回游戏本体（用户 m02534 把独立说明页整合进游戏里了）
          caches.match('./index.html')
      );
    })
  );
});
