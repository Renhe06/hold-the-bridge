// ============================================================
//  共享贴图缓存：加载页与渲染层共用同一张图（只取一次、只解一次）
//
//  ★ 2026-11-24 定版规则：**贴图永远不许挡住进门**。
//    上一版按"图不齐就不放人进关卡"做，结果在部分手机上 canvas 取像素拿不到，
//    每张图都被判失败 → 进关卡一直提示重试，比"晚一秒换贴图"糟得多。
//    这个小游戏的第一优先级是"点一下就能玩"，贴图晚到只是几帧手绘兜底。
//
//  判定标准：onload 且 naturalWidth>0 就算就绪（不再等 decode、不再取像素）。
//  - decode() 在软件光栅环境会永远挂着，等它就是永远等不到贴图（实测）；
//  - 取像素在部分 WebView 上不可靠，会把好图判死（这一版踩过）。
//  "第一帧烘出空白"的问题改在烘焙层解决：同一尺寸连烘两次才写缓存
//  （见 render.js 的 _heroBake / sea-whale.js 的 _bake），不再靠这里赌。
//
//  约定：
//   - artGet(url)  同步取已就绪的图；没有就返回 null（渲染层一帧内决定走兜底）
//   - artLoad(url) 异步取，带超时与重试；同一个 URL 并发只发一次请求
// ============================================================

const cache = new Map(); // url -> { img, ok, promise }

/** 取一张图：只要 onload 且尺寸正常就算成功 */
function loadOnce(url, timeout) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(null); // 冒烟测试的桩环境
    const im = new Image();
    im.decoding = 'async';
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => fin(null), timeout);
    im.onload = () => {
      if (!(im.naturalWidth > 0) || !(im.naturalHeight > 0)) return fin(null);
      // 解码预热：只加速后面的 drawImage，**不阻塞**就绪判定
      if (typeof im.decode === 'function') {
        try { im.decode().catch(() => {}); } catch (_) {}
      }
      fin(im);
    };
    im.onerror = () => fin(null);
    im.src = url;
  });
}

/** 同步取已就绪的图。没准备好就 null —— 调用方必须能靠它在一帧内决定兜底 */
export function artGet(url) {
  const rec = cache.get(url);
  return rec && rec.ok ? rec.img : null;
}

/**
 * 异步取图（带重试）。
 * @param {string} url
 * @param {{tries?:number, timeout?:number}} opt tries=总尝试次数，timeout=单次超时毫秒
 * @returns {Promise<Image|null>}
 */
export function artLoad(url, opt = {}) {
  const tries = Math.max(1, opt.tries || 3);
  const timeout = Math.max(1000, opt.timeout || 9000);
  let rec = cache.get(url);
  if (rec) {
    if (rec.ok) return Promise.resolve(rec.img);
    if (rec.promise) return rec.promise;
  } else {
    rec = { img: null, ok: false, promise: null };
    cache.set(url, rec);
  }
  rec.promise = (async () => {
    for (let i = 0; i < tries; i++) {
      const im = await loadOnce(url, timeout);
      if (im) {
        rec.img = im;
        rec.ok = true;
        rec.promise = null;
        return im;
      }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 180 * (i + 1)));
    }
    // 全部失败：把记录清掉，下一次调用还能重新试（不缓存"失败"本身）
    cache.delete(url);
    return null;
  })();
  return rec.promise;
}
