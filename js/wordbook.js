// ---------------------------------------------------------
//  单词模式：错词本（用户 m16607）
//   - 已背单词：这一路背过的所有单词（去重，按最近一次出现排序）
//   - 错词：曾经答错过的词 + 错了几次，按次数从多到少排
//  存在 localStorage，换一局也还在；清空只能靠用户自己（目前不提供按钮）
// ---------------------------------------------------------
const KEY = 'htb.words.v1';
const MAX_LEARNED = 4000;

let book = null;

function blank() {
  return { learned: [], wrong: {} };
}

function safeParse(raw) {
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return blank();
    const learned = Array.isArray(o.learned) ? o.learned.filter((w) => typeof w === 'string') : [];
    const wrong = o.wrong && typeof o.wrong === 'object' ? o.wrong : {};
    const clean = {};
    for (const k of Object.keys(wrong)) {
      const n = wrong[k] | 0;
      if (n > 0) clean[k] = n;
    }
    return { learned, wrong: clean };
  } catch (e) {
    return blank();
  }
}

export function loadBook() {
  if (book) return book;
  let raw = null;
  try {
    raw = window.localStorage && window.localStorage.getItem(KEY);
  } catch (e) {
    raw = null;
  }
  book = raw ? safeParse(raw) : blank();
  return book;
}

function save() {
  try {
    window.localStorage && window.localStorage.setItem(KEY, JSON.stringify(book));
  } catch (e) {
    /* 存不了就算了，本局仍然有效 */
  }
}

/** 背过一个词（答对或答错都算"背过"） */
export function markLearned(w) {
  if (!w) return;
  const b = loadBook();
  const i = b.learned.indexOf(w);
  if (i >= 0) b.learned.splice(i, 1);
  b.learned.push(w);
  if (b.learned.length > MAX_LEARNED) b.learned.splice(0, b.learned.length - MAX_LEARNED);
  save();
}

/** 答错一次：错词次数 +1，同时算背过 */
export function markWrong(w) {
  if (!w) return 0;
  const b = loadBook();
  b.wrong[w] = (b.wrong[w] | 0) + 1;
  markLearned(w);
  save();
  return b.wrong[w];
}

/** 答对了这个错词：次数保留（错词本要记历史），只是不再排期 */
export function wrongTimes(w) {
  const b = loadBook();
  return b.wrong[w] | 0;
}

/** 已背单词：倒序（最近的在前） */
export function learnedList() {
  const b = loadBook();
  return b.learned.slice().reverse();
}

/** 错词：按次数从多到少排，次数一样按最近（后出现的靠前） */
export function wrongList() {
  const b = loadBook();
  const items = Object.keys(b.wrong).map((w) => ({ w, n: b.wrong[w] | 0 }));
  items.sort((a, c) => c.n - a.n || (b.learned.indexOf(c.w) - b.learned.indexOf(a.w)));
  return items;
}

export function bookStats() {
  const b = loadBook();
  return { learned: b.learned.length, wrong: Object.keys(b.wrong).length };
}
