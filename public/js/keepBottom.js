// トークの一番下を見ている時は、キーボードや＋メニューで表示エリアが縮んでも一番下に張り付ける。
// (以前はキーボードを出すと表示エリアだけ縮んで、最新のメッセージが入力欄の裏に隠れていた)
// ＋メニューを開いたまま文字を打ち始めたら、メニューは閉じる(キーボードと重なって狭くなるため)
(function () {
  function attach(cs) {
    if (!cs || cs._keepBottom) return;
    cs._keepBottom = true;
    let atBottom = true;
    let lastH = -1; // 最初の大きさは ResizeObserver が教えてくれる(ここで測ると読み込み中に重い再計算が走る)
    cs.addEventListener('scroll', () => {
      atBottom = cs.scrollHeight - cs.scrollTop - cs.clientHeight < 80;
    }, { passive: true });
    // 画像・動画は後から読み込まれて高さが増える。一番下を見ていたなら、増えた分だけ下に付いていく
    // (以前は届いた画像の下半分が入力欄の裏に隠れたままになっていた)
    const follow = () => { if (atBottom) cs.scrollTop = cs.scrollHeight; };
    cs.addEventListener('load', follow, true);
    cs.addEventListener('loadedmetadata', follow, true);
    if (!window.ResizeObserver) return;
    new ResizeObserver(entries => {
      const h = Math.round(entries[entries.length - 1].contentRect.height);
      if (h === lastH) return;
      const first = lastH < 0;
      lastH = h;
      if (first) return;
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
