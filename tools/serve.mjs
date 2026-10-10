// ============================================================
//  本地开发服务器
//
//  不用 python -m http.server 的原因有两个：
//   1. 它把 .webmanifest 当 application/octet-stream 发，PWA 装不上；
//   2. 它带 Last-Modified，改代码后浏览器/Service Worker 容易吃到旧文件，
//      手机上调手感时最难查的就是"我明明改了怎么没变"。
//  所以这里显式写死 MIME 表，并且一律 no-store。
//
//  运行：node tools/serve.mjs [端口]
// ============================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad url');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  // 目录穿越防护：解析后必须还在 ROOT 里面
  const filePath = path.resolve(ROOT, '.' + urlPath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.log(`  404  ${urlPath}`);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    console.log(`  200  ${urlPath}  (${type.split(';')[0]}, ${data.length}B)`);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      // 允许手机从局域网 IP 访问时正常加载（同源，其实用不到，留着无害）
      'access-control-allow-origin': '*',
    });
    res.end(data);
  });
});

// 不指定 host：Node 会绑到 ::（IPv6 双栈），同时接受 127.0.0.1 和 ::1。
// 踩过的坑：显式绑 '0.0.0.0' 时只监听 IPv4，而 Windows 的 ssh 在做端口转发时
// 会把 localhost 解析成 ::1，于是隧道那头连不上、公网地址直接 502。
server.listen(PORT, () => {
  console.log(`守桥 dev server  →  http://127.0.0.1:${PORT}/`);
  console.log(`静态根目录: ${ROOT}\n`);
});
