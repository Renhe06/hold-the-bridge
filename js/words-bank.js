// 三套词库的统一入口（【用户 m17229】四级 / 六级 / 考研 各 800 词）
//   · 三套词表互相不重复，所以"干扰项"只在同一套里找时，四个中文选项难度是一致的；
//   · ALL_WORDS 是并集：错词本要按单词反查释义、干扰项池子不够时兜底用。
// 体积：三套合计约 133 KB 源码 / 42 KB gzip，够小，所以这里是静态 import。
// 以后要上 5 万词级别再改成 await import()（见 m17204 的讨论）。
import { CET4_WORDS } from './words-cet4.js';
import { CET6_WORDS } from './words-cet6.js';
import { KAOYAN_WORDS } from './words-kaoyan.js';

export const WORD_BANKS = [
  { id: 'cet4', name: '四级', tag: 'CET-4', words: CET4_WORDS },
  { id: 'cet6', name: '六级', tag: 'CET-6', words: CET6_WORDS },
  { id: 'kaoyan', name: '考研', tag: 'Postgrad', words: KAOYAN_WORDS },
];

export const ALL_WORDS = CET4_WORDS.concat(CET6_WORDS, KAOYAN_WORDS);

const BY_ID = new Map(WORD_BANKS.map((b) => [b.id, b]));

/** 按 id 取某一套词（id 不认识就回四级） */
export function bankWords(id) {
  const b = BY_ID.get(id);
  return b ? b.words : CET4_WORDS;
}

export function bankName(id) {
  const b = BY_ID.get(id);
  return b ? b.name : WORD_BANKS[0].name;
}

/** 单词 → 词条（错词本按单词查释义，单词在三套里唯一） */
export const WORD_LOOKUP = new Map(ALL_WORDS.map((c) => [c.w, c]));
