// ============================================================
//  DOM 契约检查
//
//  冒烟测试用桩元素跑 main.js，桩对任何 id 都能现造一个，
//  所以"index.html 里 id 拼错 / 漏写"这类错误它抓不到——
//  而在真机上这类错误的症状是整页白屏。这个脚本专门补这个洞：
//  把 js 里所有 getElementById / querySelector('#…') 抓出来，
//  逐个回到 index.html 里核对。
//
//  运行：node tools/dom-check.mjs
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

const jsFiles = fs
  .readdirSync(path.join(ROOT, 'js'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join('js', f));

let problems = 0;
console.log('== DOM 契约检查 ==\n');
console.log(`index.html 里的 id（${htmlIds.size} 个）：${[...htmlIds].join(', ')}\n`);

for (const rel of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) used.add(m[1]);
  for (const m of src.matchAll(/querySelector\(\s*['"]#([^'"]+)['"]\s*\)/g)) used.add(m[1]);
  if (used.size === 0) continue;

  const missing = [...used].filter((id) => !htmlIds.has(id));
  const okCount = used.size - missing.length;
  console.log(`${rel}：引用 ${used.size} 个 id，命中 ${okCount} 个`);
  if (missing.length) {
    problems += missing.length;
    console.log(`  ✗ index.html 里不存在：${missing.join(', ')}`);
  }
}

// 反向检查：html 里的 id 是不是都有人用（纯提示，不算错误）
const allJs = jsFiles.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const unused = [...htmlIds].filter((id) => !allJs.includes(id));
if (unused.length) console.log(`\n提示：index.html 里这些 id 没有任何 js 引用：${unused.join(', ')}`);

console.log(problems === 0 ? '\n全部对上 ✅' : `\n有 ${problems} 处对不上 ❌`);
process.exit(problems === 0 ? 0 : 1);
