// stamps.js
// スタンプ。画像ファイルは使わず、全部この中のSVGで描く(絵文字も使わない)。
//
// 送り方: スタンプは「本文が [[stamp:ID]] だけのテキストメッセージ」。
//   新しいメッセージ種別を作らないので、1:1もグループも今のE2E暗号のまま通る(サーバーは中身を知らなくていい)。
//   古いバージョンの端末だと [[stamp:ok]] という文字がそのまま見えるだけで、壊れはしない。
//
//   BroStamps.encode('ok')          -> '[[stamp:ok]]'
//   BroStamps.parse(text)           -> 'ok' | null   (本文がスタンプ1個だけの時だけ。知らないIDはnull)
//   BroStamps.label(id)             -> 'OK'          (一覧・返信引用に出す名前)
//   BroStamps.previewText(text)     -> 'スタンプ: OK' | null   (トーク一覧用。スタンプでなければnull)
//   BroStamps.el(id, px)            -> <span> (SVG入り。吹き出しなしで置く)
//   BroStamps.openPicker({ onPick(id) })   下から出る選択シート
(function () {
  if (window.BroStamps) return;

  const NS = 'http://www.w3.org/2000/svg';
  const tr = (k, fb) => { try { return (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb; } catch (e) { return fb; } };

  // ---- 部品(目・口・飾り)。全部 viewBox 0 0 120 120 の中で、顔の中心が (60,50) ----
  const INK = '#2b2118';
  const eyes = {
    dot: () => '<circle cx="46" cy="48" r="5" fill="' + INK + '"/><circle cx="74" cy="48" r="5" fill="' + INK + '"/>',
    wide: () => '<circle cx="46" cy="47" r="8" fill="#fff" stroke="' + INK + '" stroke-width="3"/><circle cx="74" cy="47" r="8" fill="#fff" stroke="' + INK + '" stroke-width="3"/><circle cx="46" cy="48" r="3" fill="' + INK + '"/><circle cx="74" cy="48" r="3" fill="' + INK + '"/>',
    happy: () => '<path d="M38 52q8-12 16 0M66 52q8-12 16 0" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>',
    closed: () => '<path d="M38 49q8 8 16 0M66 49q8 8 16 0" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>',
    flat: () => '<path d="M39 48h14M67 48h14" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>',
    angry: () => '<circle cx="46" cy="50" r="4.5" fill="' + INK + '"/><circle cx="74" cy="50" r="4.5" fill="' + INK + '"/><path d="M36 38l18 6M84 38l-18 6" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>',
    tear: () => '<path d="M38 46q8 10 16 0M66 46q8 10 16 0" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/><path d="M46 56q-5 8 0 12q5-4 0-12zM74 56q-5 8 0 12q5-4 0-12z" fill="#7cc4ff"/>',
    star: () => '<path d="M46 38l3.2 6.6 7.2 1-5.2 5 1.3 7.2L46 54.4l-6.5 3.4 1.3-7.2-5.2-5 7.2-1zM74 38l3.2 6.6 7.2 1-5.2 5 1.3 7.2L74 54.4l-6.5 3.4 1.3-7.2-5.2-5 7.2-1z" fill="#fff" stroke="' + INK + '" stroke-width="2.4" stroke-linejoin="round"/>',
    heart: () => '<path d="M46 58c-9-6-12-10-12-14a6 6 0 0 1 12-1 6 6 0 0 1 12 1c0 4-3 8-12 14zM74 58c-9-6-12-10-12-14a6 6 0 0 1 12-1 6 6 0 0 1 12 1c0 4-3 8-12 14z" fill="#ff5a7a" stroke="' + INK + '" stroke-width="2.4" stroke-linejoin="round"/>',
  };
  const mouths = {
    smile: () => '<path d="M50 66q10 9 20 0" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>',
    grin: () => '<path d="M46 62h28q0 14-14 14t-14-14z" fill="#8a2b2b" stroke="' + INK + '" stroke-width="3.5" stroke-linejoin="round"/><path d="M52 71q8 5 16 0q-8-3-16 0z" fill="#ff8f9f"/>',
    flat: () => '<path d="M52 69h16" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>',
    frown: () => '<path d="M50 72q10-9 20 0" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round"/>',
    o: () => '<ellipse cx="60" cy="69" rx="6" ry="8" fill="#8a2b2b" stroke="' + INK + '" stroke-width="3.5"/>',
    wavy: () => '<path d="M46 69q4-5 8 0t8 0t8 0" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>',
    wail: () => '<path d="M48 64h24q0 14-12 14t-12-14z" fill="#8a2b2b" stroke="' + INK + '" stroke-width="3.5" stroke-linejoin="round"/>',
  };
  const extras = {
    blush: () => '<ellipse cx="35" cy="62" rx="7" ry="4.5" fill="#ff6b81" opacity=".45"/><ellipse cx="85" cy="62" rx="7" ry="4.5" fill="#ff6b81" opacity=".45"/>',
    sweat: () => '<path d="M92 28q-6 10 0 14q6-4 0-14z" fill="#7cc4ff" stroke="#3d8fd1" stroke-width="2"/>',
    zzz: () => '<g fill="' + INK + '" font-family="Arial,sans-serif" font-weight="800"><text x="88" y="26" font-size="16">Z</text><text x="99" y="16" font-size="11">z</text></g>',
    vein: () => '<path d="M84 22l6 4M90 22l-6 4M87 18v12M81 26h12" fill="none" stroke="#e8352e" stroke-width="3.4" stroke-linecap="round"/>',
    question: () => '<text x="92" y="30" font-size="26" font-weight="800" font-family="Arial,sans-serif" fill="' + INK + '">?</text>',
    sun: () => '<g stroke="#ffb800" stroke-width="4" stroke-linecap="round"><path d="M96 12v8M96 38v8M83 29h8M101 29h8M87 20l5 5M105 20l-5 5M87 38l5-5M105 38l-5-5"/></g><circle cx="96" cy="29" r="7" fill="#ffd54a"/>',
    spark: () => '<path d="M96 14v14M89 21h14" stroke="#ffb800" stroke-width="4" stroke-linecap="round"/><path d="M22 20v10M17 25h10" stroke="#ffb800" stroke-width="3.4" stroke-linecap="round"/>',
    hands: () => '<path d="M30 78q-8-2-8 6t10 6M90 78q8-2 8 6t-10 6" fill="none" stroke="' + INK + '" stroke-width="3.4" stroke-linecap="round"/>',
  };

  // [id, 表示名, 体の色, 目, 口, 飾り(配列)]
  const DEFS = [
    ['ok', 'OK', '#ffd45e', 'happy', 'grin', ['spark']],
    ['ryokai', '了解', '#9bd8ff', 'dot', 'smile', []],
    ['thanks', 'ありがとう', '#ffc2a8', 'happy', 'smile', ['blush']],
    ['sorry', 'ごめん', '#c8d0ff', 'tear', 'frown', ['sweat']],
    ['wakaran', 'わからん', '#d9d2c5', 'dot', 'wavy', ['question']],
    ['majika', 'まじか', '#ffd45e', 'wide', 'o', []],
    ['yabai', 'やばい', '#ffb4b4', 'wide', 'wavy', ['sweat']],
    ['warai', '笑', '#ffe27a', 'happy', 'grin', []],
    ['nemui', 'ねむい', '#c9b8f5', 'flat', 'flat', ['zzz']],
    ['otsukare', 'おつかれ', '#b8e6c1', 'closed', 'smile', ['sweat']],
    ['iine', 'いいね', '#ffe27a', 'star', 'grin', ['spark']],
    ['ha', 'は？', '#ff9f80', 'angry', 'flat', ['vein']],
    ['fuzake', 'ふざけんな', '#ff8a8a', 'angry', 'frown', ['vein']],
    ['naku', 'うえーん', '#a8d8ff', 'tear', 'wail', []],
    ['suki', 'すき', '#ffc2d4', 'heart', 'smile', ['blush']],
    ['oyasumi', 'おやすみ', '#b6c4ff', 'closed', 'smile', ['zzz']],
    ['ohayo', 'おはよう', '#fff0a0', 'dot', 'smile', ['sun']],
    ['matte', 'まって', '#e2e2e2', 'dot', 'flat', ['sweat', 'hands']],
  ];
  const BY_ID = {};
  DEFS.forEach(d => { BY_ID[d[0]] = d; });

  const RE = /^\[\[stamp:([a-z0-9_]{1,24})\]\]$/;
  function parse(text) {
    if (typeof text !== 'string') return null;
    const m = RE.exec(text.trim());
    return m && BY_ID[m[1]] ? m[1] : null;
  }
  function encode(id) { return BY_ID[id] ? '[[stamp:' + id + ']]' : ''; }
  function label(id) { const d = BY_ID[id]; return d ? tr('stamp_' + id, d[1]) : ''; }
  function previewText(text) {
    const id = parse(text);
    return id ? tr('stamp_preview', 'スタンプ') + ': ' + label(id) : null;
  }

  // SVG文字列。入るのは上のDEFSの固定の値だけ(利用者の文字は入れない)ので、そのまま innerHTML に入れて大丈夫
  function svgMarkup(id, px) {
    const d = BY_ID[id];
    if (!d) return '';
    const body = d[2];
    const cap = label(id).replace(/[<>&"]/g, '');
    const fs = cap.length > 5 ? 13 : cap.length > 3 ? 15 : 18;
    return '<svg xmlns="' + NS + '" viewBox="0 0 120 120" width="' + px + '" height="' + px + '" role="img" aria-label="' + cap + '">' +
      '<path d="M60 12c26 0 46 14 46 38 0 22-18 38-46 38S14 72 14 50C14 26 34 12 60 12z" fill="' + body + '" stroke="' + INK + '" stroke-width="3.6" stroke-linejoin="round"/>' +
      '<path d="M32 28q8-9 20-11" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".55"/>' +
      eyes[d[3]]() + mouths[d[4]]() + d[5].map(x => extras[x]()).join('') +
      '<text x="60" y="110" text-anchor="middle" font-size="' + fs + '" font-weight="800" font-family="system-ui,-apple-system,\'Hiragino Sans\',\'Noto Sans JP\',sans-serif" ' +
      'fill="' + INK + '" stroke="#fff" stroke-width="4.5" stroke-linejoin="round" paint-order="stroke">' + cap + '</text>' +
      '</svg>';
  }
  function el(id, px) {
    const s = document.createElement('span');
    s.className = 'bro-stamp';
    s.dataset.stamp = id;
    s.style.cssText = 'display:inline-block;line-height:0;width:' + (px || 120) + 'px;height:' + (px || 120) + 'px';
    s.innerHTML = svgMarkup(id, px || 120);
    return s;
  }

  // ---- 選択シート ----
  function css() {
    if (document.getElementById('bro-stamp-css')) return;
    const s = document.createElement('style');
    s.id = 'bro-stamp-css';
    s.textContent =
      '.bstp{--bg:#fff;--fg:#0f172a;--line:rgba(15,23,42,.1);--fld:#eef1f5;position:fixed;inset:0;z-index:20600;display:flex;align-items:flex-end;justify-content:center;font-family:inherit;-webkit-tap-highlight-color:transparent}' +
      'html.dark-mode .bstp{--bg:#1e293b;--fg:#e2e8f0;--line:rgba(255,255,255,.1);--fld:#334155}' +
      '.bstp-bd{position:absolute;inset:0;background:rgba(0,0,0,.45);opacity:0}' +
      '.bstp-sh{position:relative;width:100%;max-width:520px;max-height:62vh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);border-radius:18px 18px 0 0;padding:8px 0 calc(10px + env(safe-area-inset-bottom,0px));transform:translate3d(0,100%,0);will-change:transform}' +
      '.bstp.on .bstp-bd{opacity:1;transition:opacity .25s ease}' +
      '.bstp.on .bstp-sh{transform:none;transition:transform .45s cubic-bezier(.2,1.05,.3,1)}' +
      '.bstp.out .bstp-bd{opacity:0;transition:opacity .2s ease}' +
      '.bstp.out .bstp-sh{transform:translate3d(0,100%,0);transition:transform .22s ease-in}' +
      'html.reduce-motion .bstp .bstp-sh,html.reduce-motion .bstp .bstp-bd{transition:none!important}' +
      '@media (prefers-reduced-motion:reduce){.bstp .bstp-sh,.bstp .bstp-bd{transition:none!important}}' +
      '.bstp-grip{width:36px;height:4px;border-radius:2px;background:var(--line);margin:0 auto 8px;flex:none}' +
      '.bstp-h{padding:2px 20px 8px;font-size:16px;font-weight:700;flex:none}' +
      '.bstp-g{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:4px 14px 8px;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}' +
      '.bstp-b{display:flex;align-items:center;justify-content:center;aspect-ratio:1;border:0;border-radius:14px;background:transparent;padding:4px;cursor:pointer;color:inherit}' +
      '.bstp-b:active{background:var(--fld)}' +
      '.bstp-b svg{width:100%;height:100%;display:block;pointer-events:none}' +
      '@media (min-width:420px){.bstp-g{grid-template-columns:repeat(4,1fr)}}';
    document.head.appendChild(s);
  }

  let cur = null;
  function openPicker(o) {
    o = o || {};
    if (cur) cur.close(true);
    css();
    const prevFocus = document.activeElement;
    const root = document.createElement('div'); root.className = 'bstp';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
    const title = tr('stamp_title', 'スタンプ');
    root.setAttribute('aria-label', title);
    const bd = document.createElement('div'); bd.className = 'bstp-bd';
    const sh = document.createElement('div'); sh.className = 'bstp-sh';
    const grip = document.createElement('div'); grip.className = 'bstp-grip';
    const h = document.createElement('div'); h.className = 'bstp-h'; h.textContent = title;
    const g = document.createElement('div'); g.className = 'bstp-g';
    DEFS.forEach(d => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'bstp-b';
      b.setAttribute('aria-label', label(d[0]));
      b.innerHTML = svgMarkup(d[0], 96);
      b.addEventListener('click', () => { close(); try { if (o.onPick) o.onPick(d[0]); } catch (e) { console.error(e); } });
      g.appendChild(b);
    });
    sh.appendChild(grip); sh.appendChild(h); sh.appendChild(g);
    root.appendChild(bd); root.appendChild(sh);
    document.body.appendChild(root);

    let closed = false;
    function close(now) {
      if (closed) return; closed = true;
      document.removeEventListener('keydown', onKey, true);
      cur = null;
      if (now) { root.remove(); return; }
      root.classList.add('out');
      setTimeout(() => root.remove(), 260);
      try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    bd.addEventListener('click', () => close());
    cur = { close };
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('on')));
  }

  window.BroStamps = { list: () => DEFS.map(d => d[0]), encode, parse, label, previewText, el, svgMarkup, openPicker };
})();
