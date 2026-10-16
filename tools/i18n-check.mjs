// ============================================================
//  中英双语守卫（用户 m02901："后续更新也需要同步适配英语"）
//
//  扫源码里所有"面向玩家的中文"，逐条核对 js/i18n.js 的字典（EN 表）里有没有英文。
//  缺哪条就打印哪条，并以非 0 退出码结束 —— 以后加了一句中文忘了补英文，
//  在 `node tools/i18n-check.mjs` 这一步就会红。
//
//  用法：
//    node tools/i18n-check.mjs          只报缺失（退出码 = 缺失条数是否 > 0）
//    node tools/i18n-check.mjs --all    连"已翻译"的条数统计一起报
//    node tools/i18n-check.mjs --list   逐条列出所有扫到的中文（含已有译文）
//
//  允许例外：确实不给玩家看的字符串（内部 key、debug 输出）写进下面的 ALLOW 里，
//  并且必须写清理由 —— 这行白名单本身就是"为什么它不需要翻译"的记录。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const FILES = ['index.html', 'js/main.js', 'js/game.js', 'js/render.js', 'js/config.js', 'js/audio.js', 'manifest.webmanifest', 'manifest.en.webmanifest'];

// 收集阶段会往里塞：HTML 里 data-i18n="key" 用到的键、含 ${} 的拼接句
const htmlKeys = new Set();
const composed = new Set();

// 例外清单（每条都写理由）。这些字符串不会出现在玩家眼前，或者不需要翻译。
const ALLOW = new Set([
  // 存档键 / class 名之类的内部标识
  'hold-the-bridge:best',
  'hold-the-bridge:coin',
  'hold-the-bridge:progress',
  'hold-the-bridge:lang',
  'hold-the-bridge:quality',
]);

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1'))
    .join('\n');
}

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
const NOISE = /^(#|\.|--|\/|https?:|[A-Za-z0-9_\-.:/]+$)/;

function collect() {
  const counts = new Map();
  htmlKeys.clear();
  composed.clear();
  const add = (raw) => {
    const s = String(raw).replace(/\s+/g, ' ').trim();
    if (!s || !CJK.test(s) || NOISE.test(s) || ALLOW.has(s)) return;
    // 拼出来的句子（含 ${...}）永远不可能和字典键对上：它们在 i18n.js 的 PATTERNS
    // 正则表里处理，或者是调用点用 I18N.L() 给两份 —— 这一类单独统计，不算缺翻译。
    if (s.includes('${')) {
      composed.add(s);
      return;
    }
    counts.set(s, (counts.get(s) || 0) + 1);
  };
  for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    let src = fs.readFileSync(p, 'utf8');
    if (f.endsWith('.html')) {
      // data-i18n="xxx" 的整段文字由 HTML 表负责，先把块内容抠掉再扫，
      // 否则会被 <b> 切成几十个碎片，逼着字典去翻半句话。
      for (const m of src.matchAll(/data-i18n="([^"]+)"/g)) htmlKeys.add(m[1]);
      src = src.replace(/<([a-zA-Z][\w-]*)\b[^>]*\bdata-i18n="[^"]*"[^>]*>[\s\S]*?<\/\1>/g, ' ');
      for (const m of src.matchAll(/>([^<>]+)</g)) add(m[1]);
      for (const m of src.matchAll(/(?:placeholder|aria-label|title|alt|content)="([^"]*)"/g)) add(m[1]);
    } else if (f.endsWith('.json') || f.endsWith('.webmanifest')) {
      for (const m of src.matchAll(/"([^"]*)"/g)) add(m[1]);
    } else {
      src = stripComments(src);
      for (const m of src.matchAll(/'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g)) add(m[1] ?? m[2] ?? m[3] ?? '');
    }
  }
  return counts;
}

// 词典：从 js/i18n.js 里取出 EN 表和 HTML 表的键（不 import —— 那个文件依赖 window）
function dictKeys() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'i18n.js'), 'utf8');
  const keys = new Set();
  const sliceTable = (name) => {
    const start = src.indexOf(`const ${name} = {`);
    if (start < 0) return '';
    const end = src.indexOf('\n};', start);
    return src.slice(start, end);
  };
  for (const body of [sliceTable('EN')]) {
    // 匹配 `键: '值'`：键可能是标识符（含汉字——JS 允许汉字做标识符）、带引号的字符串
    for (const m of body.matchAll(/(?:^|\n)\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([\w$\u3400-\u9fff]+))\s*:/g)) {
      keys.add(m[1] ?? m[2] ?? m[3]);
    }
  }
  return keys;
}

function htmlTableKeys() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'i18n.js'), 'utf8');
  const start = src.indexOf('const HTML = {');
  const end = src.indexOf('\n};', start);
  const keys = new Set();
  for (const m of src.slice(start, end).matchAll(/(?:^|\n)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)) {
    keys.add(m[1] ?? m[2] ?? m[3]);
  }
  return keys;
}

/**
 * 跑一遍检查，把结果交出去（给冒烟测试用同一套判定 —— 两边不可能对不上）。
 * 不打印任何东西；报告与退出码留给自己当脚本跑的那条路径。
 */
export function checkI18N() {
  const counts = collect();
  const keys = dictKeys();
  const htmlDict = htmlTableKeys();
  const missing = [...counts.keys()].filter((s) => !keys.has(s)).sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
  const missingHtml = [...htmlKeys].filter((k) => !htmlDict.has(k));
  return { counts, keys, htmlDict, missing, missingHtml, composed: new Set(composed), htmlKeys: new Set(htmlKeys) };
}

// 只有"被当成脚本直接跑"时才打报告 / 设退出码；被 import 时保持安静
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { counts, keys, htmlDict, missing, missingHtml, composed, htmlKeys: hk } = checkI18N();

  if (process.argv.includes('--list')) {
    for (const [s, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`${keys.has(s) ? '✓' : '✗'} ${String(n).padStart(3)}  ${s}`);
    }
  }

  console.log(`\n面向玩家的中文：${counts.size} 条｜EN 字典：${keys.size} 条｜已覆盖 ${counts.size - missing.length} 条`);
  console.log(`拼出来的句子（走 PATTERNS 正则 / 调用点 L()）：${composed.size} 条`);
  console.log(`data-i18n 整段文字：${[...hk].join(', ') || '（无）'}｜HTML 表：${[...htmlDict].join(', ') || '（无）'}`);
  if (process.argv.includes('--all')) {
    const unused = [...keys].filter((k) => !counts.has(k));
    if (unused.length) console.log(`字典里暂时用不到的键 ${unused.length} 条：${unused.join(' / ')}`);
  }
  if (process.argv.includes('--composed')) {
    for (const s of composed) console.log(`  拼接句：${s}`);
  }

  let bad = 0;
  if (missing.length) {
    bad += missing.length;
    console.log(`\n缺英文的 ${missing.length} 条（加进 js/i18n.js 的 EN 表，键要完全一致）：`);
    for (const s of missing) console.log(`  ${s}`);
  }
  if (missingHtml.length) {
    bad += missingHtml.length;
    console.log(`\ndata-i18n 用了但没有英文版的键：${missingHtml.join(' / ')}`);
  }
  if (bad) {
    process.exitCode = 1;
  } else {
    console.log('\n全部中文都有英文了 ✅');
  }
}
