// loadingDots.js
// 「読み込み中...」「呼び出し中...」のような待ち表示の末尾の「...」を動かす。
//   標準(wow): . → .. → ... と増えながら、点がバネのように跳ねて光り、文字全体を光の帯が流れる
//   {wow:false} / data-bd="plain": 点が増えるだけの地味な版
// どちらも textContent は元の「中...」のまま(点は . の文字3つ)なので、既存の処理は影響を受けない。
// 使い方:
//   BroDots.set(el, '読み込み中...')            // 通常
//   BroDots.set(el, '呼び出し中...', {wow:true})  // wow
//   <div data-bd>読み込み中...</div>            // HTMLに直接書く場合(wowは data-bd="wow")
// 「中」「います」「ing」などで終わって、最後が ... か … の時だけ動かす(それ以外の文字には何もしない)。
(function () {
  if (window.BroDots) return;

  const TAIL = /^([\s\S]*[^.…\s])\s*(?:\.{2,3}|…)$/;
  const BODY = /(中|중|ます|ing|成)$/i;

  function css() {
    if (document.getElementById('bro-dots-css')) return;
    const s = document.createElement('style');
    s.id = 'bro-dots-css';
    s.textContent =
      // ---- 通常: . → .. → ... (点の位置は最初から確保して、文字が揺れないようにする) ----
      '.bd{display:inline-block;white-space:nowrap}' +
      '.bd>i{font-style:normal;display:inline-block}' +
      '.bd:not(.bd-wow)>i:nth-child(2){animation:bd-2 1.2s linear infinite}' +
      '.bd:not(.bd-wow)>i:nth-child(3){animation:bd-3 1.2s linear infinite}' +
      '@keyframes bd-2{0%,30%{opacity:0}38%,100%{opacity:1}}' +
      '@keyframes bd-3{0%,63%{opacity:0}71%,100%{opacity:1}}' +
      // ---- wow: 点が順番に跳ねる(行き過ぎて戻るバネ)+ 光る ----
      '.bd-wow>i{animation:bd-hop 1.15s cubic-bezier(.3,0,.2,1) infinite;transform-origin:50% 80%;will-change:transform}' +
      '.bd-wow>i:nth-child(2){animation:bd-hop 1.15s cubic-bezier(.3,0,.2,1) .14s infinite,bd-2 1.2s linear infinite}' +
      '.bd-wow>i:nth-child(3){animation:bd-hop 1.15s cubic-bezier(.3,0,.2,1) .28s infinite,bd-3 1.2s linear infinite}' +
      '@keyframes bd-hop{' +
        '0%{transform:translateY(0) scale(1);text-shadow:0 0 0 transparent}' +
        '16%{transform:translateY(-.52em) scale(1.5,1.5);text-shadow:0 0 .5em currentColor}' +
        '30%{transform:translateY(.1em) scale(1.25,.7);text-shadow:0 0 .2em currentColor}' +
        '42%{transform:translateY(-.1em) scale(.95,1.1);text-shadow:0 0 0 transparent}' +
        '52%,100%{transform:translateY(0) scale(1);text-shadow:0 0 0 transparent}}' +
      // 文字全体を光の帯が流れる(maskなので文字色はテーマのまま)
      '.bd-t{display:inline-block}' +
      '.bd-shine{-webkit-mask-image:linear-gradient(100deg,rgba(0,0,0,.42) 38%,#000 50%,rgba(0,0,0,.42) 62%);mask-image:linear-gradient(100deg,rgba(0,0,0,.42) 38%,#000 50%,rgba(0,0,0,.42) 62%);' +
        '-webkit-mask-size:260% 100%;mask-size:260% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;animation:bd-sweep 1.9s linear infinite}' +
      '@keyframes bd-sweep{0%{-webkit-mask-position:130% 0;mask-position:130% 0}100%{-webkit-mask-position:-30% 0;mask-position:-30% 0}}' +
      // 画像などの読み込み枠: 光沢がすっと横切る
      '.bd-skel{position:relative;overflow:hidden}' +
      '.bd-skel::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.55) 50%,transparent 70%);transform:translateX(-100%);animation:bd-skel 1.5s ease-in-out infinite;pointer-events:none}' +
      '@keyframes bd-skel{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}' +
      // 動きを減らす設定の時は点を全部出したまま止める
      'html.reduce-motion .bd>i{opacity:1!important;transform:none!important;text-shadow:none!important}' +
      'html.reduce-motion .bd-shine{-webkit-mask-image:none;mask-image:none}' +
      'html.reduce-motion .bd-skel::after{display:none}' +
      '@media (prefers-reduced-motion:reduce){.bd>i{opacity:1!important;animation:none!important;transform:none!important}.bd-shine{-webkit-mask-image:none;mask-image:none;animation:none}.bd-skel::after{display:none}}';
    document.head.appendChild(s);
  }

  function dots(wow) {
    const d = document.createElement('span');
    d.className = 'bd' + (wow ? ' bd-wow' : '');
    d.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) { const p = document.createElement('i'); p.textContent = '.'; d.appendChild(p); }
    return d;
  }

  // el の中身を text にする。待ち表示なら末尾の点を動かす。そうでなければただの textContent
  function set(el, text, opts) {
    if (!el) return;
    text = text == null ? '' : String(text);
    const m = TAIL.exec(text);
    if (!m || !BODY.test(m[1])) { el.textContent = text; return; }
    css();
    const wow = !(opts && opts.wow === false);   // 全部wow版が標準。地味にしたい時だけ {wow:false}
    el.textContent = '';
    const wrap = document.createElement('span');
    wrap.className = 'bd-t' + (wow ? ' bd-shine' : '');
    wrap.appendChild(document.createTextNode(m[1]));
    wrap.appendChild(dots(wow));
    el.appendChild(wrap);
  }

  // HTMLに直接書かれた <x data-bd>読み込み中...</x> を動かす
  function scan(root) {
    (root || document).querySelectorAll('[data-bd]').forEach(el => {
      if (el.firstElementChild) return;
      set(el, el.textContent, { wow: el.getAttribute('data-bd') !== 'plain' });
    });
  }

  // 画像などの読み込み枠に光沢を流す
  function skeleton(el) { if (el) { css(); el.classList.add('bd-skel'); } }
  function unskeleton(el) { if (el) el.classList.remove('bd-skel'); }

  window.BroDots = { set, scan, skeleton, unskeleton };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan());
  else scan();
})();
