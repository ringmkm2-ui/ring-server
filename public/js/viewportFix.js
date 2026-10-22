// viewportFix.js
// -----------------------------------------------------------------------
// スマホでキーボードを閉じた後などに、画面全体が上へずれたまま戻らないことがある
// (ヘッダーが上で切れて、入力欄の下に空白ができる)。ブラウザが見える範囲(visualViewport)の
// ずれやページのスクロール位置を戻し忘れる時の症状なので、入力していない時に
// ずれが残っていたら (0,0) に戻す。文字入力中のずれはキーボード用の正常な動きなので触らない。
// -----------------------------------------------------------------------
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  let timer = null;
  function typing() {
    const a = document.activeElement;
    return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
  }
  function settle() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (typing()) return;
      const se = document.scrollingElement;
      const shifted = Math.abs(vv.offsetTop) > 1 || Math.abs(vv.offsetLeft) > 1;
      const scrolled = (se && se.scrollTop > 0) || window.scrollY > 0 || document.body.scrollTop > 0;
      if (!shifted && !scrolled) return;
      try { window.scrollTo(0, 0); if (se) se.scrollTop = 0; document.body.scrollTop = 0; } catch (e) {}
    }, 150);
  }
  vv.addEventListener('resize', settle);
  vv.addEventListener('scroll', settle);
  window.addEventListener('scroll', settle, { passive: true });
  window.addEventListener('orientationchange', settle);
  document.addEventListener('focusout', () => setTimeout(settle, 350));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) settle(); });
})();
