// ============================================================
//  js/failsafe.js —— 脚本没起来时的兜底提示（**必须是普通脚本，不能是 module**）
//
//  为什么单独一个文件、而不是写在 index.html 里：
//   1) 它要在"模块图整个挂掉"时仍然执行 —— 所以不能 import 任何东西，
//      也不能依赖 js/i18n.js（那份字典本身也是模块）；
//   2) index.html 里的中文字面量会参与 i18n 扫描，多行内联脚本会把
//      tools/i18n-check.mjs 的引号分词弄乱（实测报出 4 条假缺失）。
//
//  触发条件（任一）：
//    · <script type="module" src="./js/main.js"> 取不到 → error 事件目标是 SCRIPT
//    · 5 秒后 window.__HBT_READY 还没置位（main.js 正常执行时会置位）
//  不触发：首屏加载页已经露出来（说明 JS 活着，只是资源慢）。
// ============================================================
(function () {
  var shown = false;

  function fail() {
    if (shown || window.__HBT_READY) return;
    var boot = document.getElementById('bootOverlay');
    if (boot && boot.style.display === 'flex') return;
    shown = true;

    var zh = (navigator.language || 'zh').toLowerCase().indexOf('zh') === 0;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;gap:16px;padding:0 30px;text-align:center;'
      + 'background:radial-gradient(130% 90% at 50% 32%,#13284a,#04070d 72%);'
      + 'color:#dff3ff;font-size:14px;letter-spacing:2px;line-height:1.7';
    box.innerHTML = '<div style="font-size:34px;font-weight:900;letter-spacing:10px;text-indent:10px">'
      + (zh ? '守 桥' : 'HOLD THE BRIDGE') + '</div><div>'
      + (zh ? '资源没加载完，点一下重试' : 'Assets failed to load — tap to retry') + '</div>';
    box.addEventListener('pointerdown', function () { location.reload(); });
    document.body.appendChild(box);
  }

  // 模块脚本取不到时，error 事件的目标就是那个 <script>
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target.tagName === 'SCRIPT') fail();
  }, true);
  setTimeout(fail, 5000);
})();
