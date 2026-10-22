// viewportFix.js
// -----------------------------------------------------------------------
// スマホでキーボードを閉じた後などに、画面の中身が上へずれたまま戻らないことがある
// (ヘッダーが上で切れて、入力欄の下に同じだけ空白ができる)。
// 原因は、overflow:hidden の外枠が、入力欄に焦点が当たった時にブラウザに勝手にスクロールされて、
// そのスクロール位置が残ること(hiddenでも、ブラウザ自身はスクロールできる)。
// 外枠は CSS で overflow:clip にして動かないようにしてあるが、clip に対応しない古い端末向けに、
// ずれが残っていたら (0,0) に戻す。キーボードが出ている間のずれは正常なので触らない。
// Androidの「戻る」でキーボードだけ閉じた時は入力欄に焦点が残るので、焦点ではなく
// 画面の高さが元に戻ったかで判断する。
// -----------------------------------------------------------------------
(function () {
  const vv = window.visualViewport;
  const SHELLS = '.phone-container, .pc';
  let timer = null;
  let full = Math.max(window.innerHeight, vv ? vv.height : 0);

  function keyboardOpen() {
    if (!vv) return false;
    full = Math.max(full, window.innerHeight, vv.height);
    return vv.height < full - 100;
  }
  function reset() {
    let moved = false;
    const els = [document.scrollingElement, document.documentElement, document.body].concat([].slice.call(document.querySelectorAll(SHELLS)));
    for (const el of els) {
      if (el && (el.scrollTop > 0 || el.scrollLeft > 0)) { el.scrollTop = 0; el.scrollLeft = 0; moved = true; }
    }
    if (window.scrollY > 0 || window.scrollX > 0) { try { window.scrollTo(0, 0); } catch (e) {} moved = true; }
    return moved;
  }
  function settle() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (keyboardOpen()) return;
      reset();
    }, 150);
  }
  // スクロールはバブリングしないので、capture で外枠のスクロールも拾う
  document.addEventListener('scroll', settle, true);
  window.addEventListener('resize', () => { if (!keyboardOpen()) full = Math.max(window.innerHeight, vv ? vv.height : 0); settle(); });
  window.addEventListener('orientationchange', () => { full = 0; setTimeout(() => { full = Math.max(window.innerHeight, vv ? vv.height : 0); settle(); }, 400); });
  if (vv) { vv.addEventListener('resize', settle); vv.addEventListener('scroll', settle); }
  document.addEventListener('focusout', () => setTimeout(settle, 350));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) settle(); });
})();
