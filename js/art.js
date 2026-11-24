// ============================================================
//  共享贴图缓存：加载页与渲染层共用同一张「真的画得出来」的图
//
//  为什么要有这个文件（2026-11-24 用户："加载动画等了很久，进关还是没有贴图"）：
//   1) 加载页当年自己 new Image() 取图 + decode()，渲染层再 new 一张 ——
//      就算 HTTP 缓存命中，渲染层仍要从头解码一次。
//   2) 更致命的是：**decode() 在一些环境里永远不 settle**。
//      实测同一台机器：有 GPU 时 hero-knight 的 decode() 立刻 resolve；
//      加上 --disable-gpu（软件光栅，低端机/部分 WebView 就是这个状态）后
//      decode() 一直挂着，可 drawImage 却能正常画出像素。
//      旧代码"等 decode 成功才置 ok"，在这种设备上等于**永远等不到贴图** ——
//      这就是"加载页转了很久、进关还是没贴图"的真正原因。
//
//  所以判定标准从"decode 完成了"改成"**画得出来**"：
//    onload → 缩成 6×6 试画一次 → 只要有像素就算就绪（decode 只做后台预热）。
//
//  约定：
//   - artGet(url)  同步取「已就绪」的图；没有就返回 null（渲染层要能在一帧内决定走兜底）
//   - artLoad(url) 异步取，自带超时与重试；同一个 URL 并发只发一次请求
// ============================================================

const cache = new Map(); // url -> { img, ok, promise }

/** 画得出来吗：缩到 6×6 抽一次像素。比"等 decode"可靠，也比全尺寸读像素便宜 */
function hasPixels(im) {
  try {
    const cv = document.createElement('canvas');
    cv.width = 6;
    cv.height = 6;
    const g = cv.getContext('2d');
    if (!g) return true; // 拿不到上下文就别误判，交给 drawImage 自己
    g.drawImage(im, 0, 0, 6, 6);
    const d = g.getImageData(0, 0, 6, 6).data;
    let sum = 0;
    for (let i = 3; i < d.length; i += 4) sum += d[i];
    return sum > 0;
  } catch (_) {
    return true; // 跨域 / 取像素失败：不要因为"量不出来"就把图判死
  }
}

/** 取一张图；只要它已经能画出像素就算成功，绝不干等 decode() */
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
      // 画不出像素 = 这张图这次没用（缓存坏了 / 解码器还没起来），当失败重试
      if (!hasPixels(im)) return fin(null);
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
