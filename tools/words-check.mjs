// 词表守卫：node tools/words-check.mjs
// 只做数据体检（不跑游戏），用于"单词模式"开发期间防止词表被改坏。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const src = readFileSync(path.join(ROOT, 'js', 'words-cet4.js'), 'utf8');

const load = async (file, name) =>
  (await import('file://' + path.join(ROOT, 'js', file).replace(/\\/g, '/')))[name];
const words = await load('words-cet4.js', 'CET4_WORDS');
const cet6 = await load('words-cet6.js', 'CET6_WORDS');
const kaoyan = await load('words-kaoyan.js', 'KAOYAN_WORDS');

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log('✗ ' + msg); fail++; } else { console.log('✓ ' + msg); }
};

ok(Array.isArray(words), '词表导出的是数组');
ok(words.length === 800, `词表刚好 800 词（现在 ${words.length}）`);

const seen = new Set();
const dups = [];
const badShape = [];
const badPos = [];
const noAscii = [];
const POS = new Set(['n.', 'v.', 'a.', 'ad.', 'prep.', 'conj.', 'pron.', 'num.', 'int.', 'n./v.', 'n./a.', 'a./n.', 'v./n.', 'a./v.', 'a./ad.', 'ad./a.', 'prep./ad.', 'n./a./v.', 'n./v./a.', 'v./n./a.', 'a./n./v.']);

for (const e of words) {
  if (!e || typeof e.w !== 'string' || typeof e.z !== 'string' || typeof e.p !== 'string') { badShape.push(JSON.stringify(e)); continue; }
  if (seen.has(e.w)) dups.push(e.w);
  seen.add(e.w);
  if (!POS.has(e.p)) badPos.push(`${e.w}(${e.p})`);
  if (!/^[a-z][a-z'-]*$/.test(e.w)) noAscii.push(e.w);
  if (!e.z.trim()) badShape.push(e.w + ' 缺释义');
}

ok(dups.length === 0, `没有重复词${dups.length ? '：' + dups.slice(0, 8).join(', ') : ''}`);
ok(badShape.length === 0, `每条都有 w/z/p${badShape.length ? '：' + badShape.slice(0, 4).join(' | ') : ''}`);
ok(badPos.length === 0, `词性都用约定的写法${badPos.length ? '：' + badPos.slice(0, 8).join(', ') : ''}`);
ok(noAscii.length === 0, `单词都是纯小写字母${noAscii.length ? '：' + noAscii.slice(0, 8).join(', ') : ''}`);
ok(words.filter((e) => /[\u4e00-\u9fa5]/.test(e.z)).length === words.length, '释义都是中文');

// 单词模式要靠"中文提示 → 选英文"出题，释义重复太多次会让四个选项撞车
const zCount = new Map();
for (const e of words) zCount.set(e.z, (zCount.get(e.z) || 0) + 1);
const zDup = [...zCount.entries()].filter(([, n]) => n > 1);
ok(zDup.length <= 12, `释义撞车不超过 12 组（现在 ${zDup.length}）${zDup.length ? '：' + zDup.slice(0, 5).map(([z, n]) => `${z}×${n}`).join(' / ') : ''}`);

// 首字母分布别太偏（四个选项同一首字母时玩家容易靠开局蒙）
const first = new Map();
for (const e of words) first.set(e.w[0], (first.get(e.w[0]) || 0) + 1);
// 词表按字母排列，同字母扎堆是正常的；出题时只要"四个选项首字母互不相同"就行，
// 所以这里只要求首字母种类够多（能稳定凑出四选一）。
const maxFirst = Math.max(...first.values());
ok(first.size >= 20, `首字母有 ${first.size} 种（≥20，四选一能避开同首字母）`);
ok(maxFirst <= 160, `单个首字母最多 ${maxFirst} 个（≤160，避免某个字母占掉词表两成）`);

// ---- 三套词库（用户 m17229）----
for (const [name, bank] of [['六级', cet6], ['考研', kaoyan]]) {
  ok(Array.isArray(bank) && bank.length === 800, `${name}词表 800 词（现在 ${bank.length}）`);
  const bad = bank.filter((e) => !e || typeof e.w !== 'string' || typeof e.z !== 'string' || typeof e.p !== 'string' || !e.z.trim());
  ok(bad.length === 0, `${name}词表每条都有 w/z/p`);
  const notCn = bank.filter((e) => !/[\u4e00-\u9fa5]/.test(e.z || ''));
  ok(notCn.length === 0, `${name}词表释义都是中文`);
  const inner = new Map();
  const dupIn = [];
  for (const e of bank) { if (inner.has(e.w)) dupIn.push(e.w); inner.set(e.w, 1); }
  ok(dupIn.length === 0, `${name}词表内部没有重复词${dupIn.length ? '：' + dupIn.slice(0, 5).join(', ') : ''}`);
}
const all = new Map();
const crossDup = [];
for (const e of words.concat(cet6, kaoyan)) {
  if (all.has(e.w)) crossDup.push(e.w);
  all.set(e.w, 1);
}
ok(crossDup.length === 0, `三套词库之间零重复${crossDup.length ? '：' + crossDup.slice(0, 8).join(', ') : ''}`);
ok(all.size === 2400, `三套合计 2400 词（现在 ${all.size}）`);

if (fail) { console.log(`\n词表体检失败 ${fail} 项`); process.exit(1); }
console.log('\n词表体检通过 ✅');
