// ============================================================
//  Service Worker —— 让游戏加到主屏幕后能离线打开
//  只在 https 下注册（main.js 里已跳过 localhost，方便开发时改完就生效）
//
//  策略：网络优先，失败再回缓存。
//  刻意不用"缓存优先"：这个游戏要反复调手感，缓存优先会让手机上永远跑旧版本，
//  而且表现是"我明明改了怎么没变"，最难查。网络优先时在线永远拿最新代码，
//  断网时又还能打开，离线能力一点没少。
// ============================================================

const CACHE = 'hold-the-bridge-v1.0.26';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './fonts/smiley-sans.woff2',
  './manifest.webmanifest',
  // 英文清单：切到 English 时装到主屏幕的名字也走英文（i18n.js 的 applyMeta 换 href）
  './manifest.en.webmanifest',
  './img/hero-uncle.jpg',
  // 对话立绘（用户 m02399 头像重构）：说话人是谁就换谁的图
  './img/portrait-hero.png',
  './img/portrait-uncle.png',
  './img/portrait-cmd.png',
  './img/portrait-dave.png',
  './js/main.js',
  './js/config.js',
  './js/util.js',
  './js/quality.js',
  './js/i18n.js',
  './js/changelog.js',
  './js/camera.js',
  './js/audio.js',
  './js/game.js',
  './js/render.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
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

  e.respondWith(
    fetch(req)
      .then((res) => {
        // 只回填同源的正常响应；opaque 响应（跨域）不缓存，免得把错误页存进去
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        // 断网兜底：缓存里没有就一律回游戏本体
        // （原先还判过一个独立的说明页，用户 m02534 说整合进游戏里了，那个文件已经删掉）
        caches.match(req).then((hit) => hit || caches.match('./index.html'))
      )
  );
});
