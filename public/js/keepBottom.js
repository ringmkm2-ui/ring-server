// トークの一番下を見ている時は、キーボードや＋メニューで表示エリアが縮んでも一番下に張り付ける。
// (以前はキーボードを出すと表示エリアだけ縮んで、最新のメッセージが入力欄の裏に隠れていた)
// ＋メニューを開いたまま文字を打ち始めたら、メニューは閉じる(キーボードと重なって狭くなるため)
(function () {
  function attach(cs) {
    if (!cs || cs._keepBottom) return;
    cs._keepBottom = true;
    let atBottom = true;
    let lastH = cs.clientHeight;
    cs.addEventListener('scroll', () => {
      atBottom = cs.scrollHeight - cs.scrollTop - cs.clientHeight < 80;
    }, { passive: true });
    if (!window.ResizeObserver) return;
    new ResizeObserver(() => {
      const h = cs.clientHeight;
      if (h === lastH) return;
      lastH = h;
      if (atBottom) cs.scrollTop = cs.scrollHeight;
    }).observe(cs);
  }
  function closeMenuOnType(inputId, barId, cls) {
    const inp = document.getElementById(inputId), bar = document.getElementById(barId);
    if (!inp || !bar) return;
    inp.addEventListener('focus', () => bar.classList.remove(cls));
  }
  function init() {
    attach(document.getElementById('chatScreen'));
    attach(document.querySelector('.cs'));
    closeMenuOnType('msgInput', 'inputBar', 'media-open');
    closeMenuOnType('mi', 'ibar', 'open');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
