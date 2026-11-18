// stampArt.js
// 公式スタンプの絵(全部SVG。画像ファイル・絵文字は使わない)と、動き・音・画面エフェクトの定義。
// stamps.js がこれを読んで表示する。ここには利用者の入力は入らない(メッセージスタンプの文字だけは
// stamps.js 側でエスケープしてから渡す)。
//
//   BroStampArt.packs            -> [{ id, title, author, kind, stickers:[{ id, label, kw:[], anim, snd, fx, msg }] }]
//   BroStampArt.svg(id, opts)    -> SVG文字列 (opts.text = メッセージスタンプの文字(エスケープ済み))
//   BroStampArt.playSound(id)    -> サウンドスタンプの音を鳴らす
//   BroStampArt.css              -> 動き用のCSS
(function () {
  if (window.BroStampArt) return;

  const INK = '#3b2a20';
  const SW = 3.4; // 線の太さ
  const FONT = "'M PLUS Rounded 1c','Hiragino Maru Gothic ProN','Hiragino Sans','Arial Rounded MT Bold','Noto Sans JP',system-ui,sans-serif";

  // ---- キャラクター ----
  // 座標は 0..160 の箱。頭の中心 (80,70)、体 (80,116)。最後に全体を縮めて配置する
  const CHARS = {
    neko: { body: '#fff7ea', inner: '#ffb3c1', cheek: '#ff8fa3', ears: 'cat', whisker: true },
    usa: { body: '#ffffff', inner: '#ffc4d6', cheek: '#ff9ab5', ears: 'rabbit', whisker: false },
    kuma: { body: '#e9c9a3', inner: '#c99c6e', cheek: '#ff8f8f', ears: 'bear', whisker: false },
  };

  const st = (w, c) => ' stroke="' + (c || INK) + '" stroke-width="' + (w || SW) + '" stroke-linecap="round" stroke-linejoin="round"';

  function ears(ch) {
    const c = CHARS[ch];
    if (c.ears === 'cat') {
      return '<path d="M44 58 L40 24 Q41 19 46 22 L72 40 Z" fill="' + c.body + '"' + st() + '/>' +
        '<path d="M116 58 L120 24 Q119 19 114 22 L88 40 Z" fill="' + c.body + '"' + st() + '/>' +
        '<path d="M48 48 L46 30 L62 41 Z" fill="' + c.inner + '"/>' +
        '<path d="M112 48 L114 30 L98 41 Z" fill="' + c.inner + '"/>';
    }
    if (c.ears === 'rabbit') {
      return '<g class="sa-earl"><path d="M58 46 C46 22 46 4 56 2 C68 0 70 22 70 42 Z" fill="' + c.body + '"' + st() + '/>' +
        '<path d="M60 38 C53 20 52 6 57 5 C63 4 64 20 64 36 Z" fill="' + c.inner + '"/></g>' +
        '<g class="sa-earr"><path d="M102 46 C114 22 114 4 104 2 C92 0 90 22 90 42 Z" fill="' + c.body + '"' + st() + '/>' +
        '<path d="M100 38 C107 20 108 6 103 5 C97 4 96 20 96 36 Z" fill="' + c.inner + '"/></g>';
    }
    return '<circle cx="48" cy="40" r="13" fill="' + c.body + '"' + st() + '/><circle cx="112" cy="40" r="13" fill="' + c.body + '"' + st() + '/>' +
      '<circle cx="48" cy="40" r="6.5" fill="' + c.inner + '"/><circle cx="112" cy="40" r="6.5" fill="' + c.inner + '"/>';
  }
  function head(ch) {
    const c = CHARS[ch];
    return '<path d="M80 34 C112 34 126 50 126 72 C126 94 106 106 80 106 C54 106 34 94 34 72 C34 50 48 34 80 34 Z" fill="' + c.body + '"' + st() + '/>';
  }
  function bodyShape(ch) {
    const c = CHARS[ch];
    return '<ellipse cx="66" cy="137" rx="11" ry="7" fill="' + c.body + '"' + st() + '/>' +
      '<ellipse cx="94" cy="137" rx="11" ry="7" fill="' + c.body + '"' + st() + '/>' +
      '<path d="M54 100 C50 116 52 134 80 134 C108 134 110 116 106 100 Z" fill="' + c.body + '"' + st() + '/>';
  }
  function whiskers(ch) {
    if (!CHARS[ch].whisker) return '';
    return '<path d="M30 76 L44 78 M31 86 L44 84 M130 76 L116 78 M129 86 L116 84"' + st(2.4) + ' fill="none"/>';
  }
  // 腕: 太い線2本(外側=輪郭色、内側=体の色)で描く
  function arm(ch, d, cls) {
    const c = CHARS[ch];
    return '<g' + (cls ? ' class="' + cls + '"' : '') + '><path d="' + d + '" fill="none" stroke="' + INK + '" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="' + d + '" fill="none" stroke="' + c.body + '" stroke-width="10.4" stroke-linecap="round" stroke-linejoin="round"/></g>';
  }
  // ポーズ: [後ろの腕(頭より奥), 前の腕(顔より手前)]
  const POSES = {
    down: ch => [arm(ch, 'M58 108 Q50 118 50 124') + arm(ch, 'M102 108 Q110 118 110 124'), ''],
    wave: ch => [arm(ch, 'M58 108 Q50 118 50 124') + arm(ch, 'M104 104 Q122 96 128 76', 'sa-wave'), ''],
    banzai: ch => [arm(ch, 'M58 104 Q30 98 20 64', 'sa-armL') + arm(ch, 'M102 104 Q130 98 140 64', 'sa-armR'), ''],
    okring: ch => [arm(ch, 'M58 102 Q22 84 26 44 Q34 6 76 4') + arm(ch, 'M102 102 Q138 84 134 44 Q126 6 84 4'), ''],
    salute: ch => [arm(ch, 'M58 108 Q50 118 50 124'), arm(ch, 'M104 104 Q122 74 106 56', 'sa-salute')],
    thumbs: ch => [arm(ch, 'M58 108 Q50 118 50 124'), arm(ch, 'M100 110 Q118 106 122 94', 'sa-thumb') +
      '<g class="sa-thumb"><rect x="114" y="80" width="16" height="16" rx="6" fill="' + CHARS[ch].body + '"' + st(3) + '/>' +
      '<path d="M120 80 L120 68 Q120 63 125 64 Q128 66 127 72 L126 80" fill="' + CHARS[ch].body + '"' + st(3) + '/></g>'],
    pray: ch => ['', arm(ch, 'M58 108 Q70 112 78 104') + arm(ch, 'M102 108 Q90 112 82 104')],
    cheeks: ch => ['', arm(ch, 'M56 112 Q44 100 46 88') + arm(ch, 'M104 112 Q116 100 114 88')],
    fists: ch => ['', arm(ch, 'M60 110 Q46 108 42 96', 'sa-armL') + arm(ch, 'M100 110 Q114 108 118 96', 'sa-armR')],
    hug: ch => ['', arm(ch, 'M58 108 Q66 120 80 118') + arm(ch, 'M102 108 Q94 120 80 118')],
    stop: ch => [arm(ch, 'M58 108 Q50 118 50 124'), arm(ch, 'M102 106 Q122 104 132 98') +
      '<ellipse cx="134" cy="94" rx="9" ry="11" fill="' + CHARS[ch].body + '"' + st(3) + '/>'],
    hold: ch => ['', arm(ch, 'M58 108 Q62 112 66 112') + arm(ch, 'M102 108 Q98 112 94 112')],
    raise: ch => [arm(ch, 'M58 108 Q50 118 50 124') + arm(ch, 'M102 102 Q118 80 116 52', 'sa-raise'), ''],
    cover: ch => ['', arm(ch, 'M58 110 Q50 96 60 80') + arm(ch, 'M102 110 Q110 96 100 80')],
  };

  // ---- 顔 ----
  const EYES = {
    dot: () => '<g class="sa-blink"><ellipse cx="63" cy="72" rx="4.6" ry="5.8" fill="' + INK + '"/><ellipse cx="97" cy="72" rx="4.6" ry="5.8" fill="' + INK + '"/>' +
      '<circle cx="64.6" cy="69.6" r="1.6" fill="#fff"/><circle cx="98.6" cy="69.6" r="1.6" fill="#fff"/></g>',
    big: () => '<g class="sa-blink"><ellipse cx="63" cy="71" rx="7" ry="8.6" fill="' + INK + '"/><ellipse cx="97" cy="71" rx="7" ry="8.6" fill="' + INK + '"/>' +
      '<circle cx="65.4" cy="67.6" r="2.8" fill="#fff"/><circle cx="99.4" cy="67.6" r="2.8" fill="#fff"/><circle cx="60.6" cy="74.6" r="1.4" fill="#fff"/><circle cx="94.6" cy="74.6" r="1.4" fill="#fff"/></g>',
    happy: () => '<path d="M56 74 Q63 64 70 74 M90 74 Q97 64 104 74" fill="none"' + st(3.6) + '/>',
    closed: () => '<path d="M56 71 Q63 78 70 71 M90 71 Q97 78 104 71" fill="none"' + st(3.6) + '/>',
    flat: () => '<path d="M56 73 H70 M90 73 H104" fill="none"' + st(3.6) + '/>',
    angry: () => '<ellipse cx="63" cy="75" rx="4.2" ry="5" fill="' + INK + '"/><ellipse cx="97" cy="75" rx="4.2" ry="5" fill="' + INK + '"/>' +
      '<path d="M53 62 L71 68 M107 62 L89 68" fill="none"' + st(3.8) + '/>',
    squeeze: () => '<path d="M56 66 L69 72 L56 78 M104 66 L91 72 L104 78" fill="none"' + st(3.6) + '/>',
    wide: () => '<circle cx="63" cy="71" r="9" fill="#fff"' + st(3) + '/><circle cx="97" cy="71" r="9" fill="#fff"' + st(3) + '/>' +
      '<circle cx="63" cy="72" r="3" fill="' + INK + '"/><circle cx="97" cy="72" r="3" fill="' + INK + '"/>',
    star: () => '<path d="M63 61 L66 68.4 L73.6 68.8 L67.6 73.6 L69.8 81 L63 76.8 L56.2 81 L58.4 73.6 L52.4 68.8 L60 68.4 Z M97 61 L100 68.4 L107.6 68.8 L101.6 73.6 L103.8 81 L97 76.8 L90.2 81 L92.4 73.6 L86.4 68.8 L94 68.4 Z" fill="#ffd23f"' + st(2.4) + '/>',
    heart: () => '<path d="M63 81 C53 74 52 69 54 66 C56 62 61 62 63 66 C65 62 70 62 72 66 C74 69 73 74 63 81 Z M97 81 C87 74 86 69 88 66 C90 62 95 62 97 66 C99 62 104 62 106 66 C108 69 107 74 97 81 Z" fill="#ff4d6d"' + st(2.4) + '/>',
    teary: () => '<path d="M56 72 Q63 66 70 72 M90 72 Q97 66 104 72" fill="none"' + st(3.6) + '/>' +
      '<path class="sa-tear" d="M58 76 Q54 92 58 104 L66 104 Q66 90 64 76 Z" fill="#8fd3ff" opacity=".9"/><path class="sa-tear" d="M102 76 Q106 92 102 104 L94 104 Q94 90 96 76 Z" fill="#8fd3ff" opacity=".9"/>',
    sleepy: () => '<path d="M56 74 Q63 70 70 74 M90 74 Q97 70 104 74" fill="none"' + st(3.6) + '/><path d="M55 69 H71 M89 69 H105" fill="none"' + st(2.2) + ' opacity=".5"/>',
    wink: () => '<ellipse cx="63" cy="72" rx="4.6" ry="5.8" fill="' + INK + '"/><circle cx="64.6" cy="69.6" r="1.6" fill="#fff"/><path d="M90 74 Q97 64 104 74" fill="none"' + st(3.6) + '/>',
    swirl: () => '<path d="M63 72 m-1 0 a1 1 0 1 1 2 0 a3 3 0 1 1 -6 0 a5 5 0 1 1 10 0 a7 7 0 1 1 -14 0 M97 72 m-1 0 a1 1 0 1 1 2 0 a3 3 0 1 1 -6 0 a5 5 0 1 1 10 0 a7 7 0 1 1 -14 0" fill="none"' + st(2.2) + '/>',
  };
  const MOUTHS = {
    cat: () => '<path d="M72 85 Q76 90 80 85 Q84 90 88 85" fill="none"' + st(3) + '/>',
    smile: () => '<path d="M70 85 Q80 95 90 85" fill="none"' + st(3.4) + '/>',
    grin: () => '<path d="M68 83 H92 Q92 98 80 98 Q68 98 68 83 Z" fill="#c2364a"' + st(3) + '/><path d="M73 93 Q80 89 87 93 Q84 97 80 97 Q76 97 73 93 Z" fill="#ff8fa3"/>',
    o: () => '<ellipse cx="80" cy="89" rx="5.4" ry="7" fill="#c2364a"' + st(3) + '/>',
    small: () => '<ellipse cx="80" cy="88" rx="3" ry="2.4" fill="#c2364a"' + st(2.4) + '/>',
    frown: () => '<path d="M71 92 Q80 83 89 92" fill="none"' + st(3.4) + '/>',
    wavy: () => '<path d="M68 89 Q71 85 74 89 Q77 93 80 89 Q83 85 86 89 Q89 93 92 89" fill="none"' + st(3) + '/>',
    wail: () => '<path d="M66 84 H94 Q94 102 80 102 Q66 102 66 84 Z" fill="#c2364a"' + st(3) + '/><path d="M72 96 Q80 91 88 96 Q85 101 80 101 Q75 101 72 96 Z" fill="#ff8fa3"/>',
    flat: () => '<path d="M72 89 H88" fill="none"' + st(3.4) + '/>',
    tongue: () => '<path d="M70 85 Q80 93 90 85" fill="none"' + st(3.2) + '/><path d="M80 89 Q80 99 86 98 Q90 96 88 88" fill="#ff8fa3"' + st(2.6) + '/>',
    teeth: () => '<path d="M68 85 H92 Q90 95 80 95 Q70 95 68 85 Z" fill="#fff"' + st(3) + '/><path d="M74 85 V92 M80 85 V95 M86 85 V92"' + st(2) + '/>',
  };
  function cheeks(ch) {
    const c = CHARS[ch].cheek;
    return '<ellipse cx="50" cy="84" rx="7.5" ry="4.8" fill="' + c + '" opacity=".55"/><ellipse cx="110" cy="84" rx="7.5" ry="4.8" fill="' + c + '" opacity=".55"/>';
  }

  // ---- 小物・記号 (座標は160の箱の中、キャラを縮めた後の位置ではなく最終位置) ----
  const sparkle = (x, y, s, col) => '<path d="M' + x + ' ' + (y - s) + ' Q' + (x + s * .18) + ' ' + (y - s * .18) + ' ' + (x + s) + ' ' + y + ' Q' + (x + s * .18) + ' ' + (y + s * .18) + ' ' + x + ' ' + (y + s) +
    ' Q' + (x - s * .18) + ' ' + (y + s * .18) + ' ' + (x - s) + ' ' + y + ' Q' + (x - s * .18) + ' ' + (y - s * .18) + ' ' + x + ' ' + (y - s) + ' Z" fill="' + (col || '#ffd23f') + '"' + st(2.2) + '/>';
  const heartAt = (x, y, s, col, cls) => '<g' + (cls ? ' class="' + cls + '"' : '') + ' transform="translate(' + x + ' ' + y + ') scale(' + s + ')"><path d="M0 9 C-11 1 -12 -5 -9 -9 C-6 -13 -1 -12 0 -7 C1 -12 6 -13 9 -9 C12 -5 11 1 0 9 Z" fill="' + (col || '#ff4d6d') + '"' + st(2.6 / s) + '/></g>';
  const PROPS = {
    sparkles: () => '<g class="sa-twinkle">' + sparkle(22, 30, 9) + sparkle(140, 26, 7) + sparkle(136, 64, 5) + '</g>',
    sweat: () => '<path class="sa-drip" d="M134 34 Q126 48 134 52 Q142 48 134 34 Z" fill="#8fd3ff"' + st(2.4, '#3d8fd1') + '/>',
    sweat2: () => '<path class="sa-drip" d="M134 34 Q126 48 134 52 Q142 48 134 34 Z" fill="#8fd3ff"' + st(2.4, '#3d8fd1') + '/><path class="sa-drip2" d="M24 44 Q18 54 24 57 Q30 54 24 44 Z" fill="#8fd3ff"' + st(2.2, '#3d8fd1') + '/>',
    vein: () => '<g class="sa-pulse" transform="translate(126 30)"><path d="M-10 -3 Q-3 -3 -3 -10 M10 -3 Q3 -3 3 -10 M-10 3 Q-3 3 -3 10 M10 3 Q3 3 3 10" fill="none" stroke="#e8352e" stroke-width="3.6" stroke-linecap="round"/></g>',
    question: () => '<g class="sa-tilt2"><text x="128" y="44" font-size="34" font-weight="900" font-family="' + FONT + '" fill="#5aa9ff" stroke="' + INK + '" stroke-width="2.6" paint-order="stroke">?</text><text x="16" y="38" font-size="22" font-weight="900" font-family="' + FONT + '" fill="#5aa9ff" stroke="' + INK + '" stroke-width="2.2" paint-order="stroke">?</text></g>',
    exclaim: () => '<g class="sa-pop2"><text x="130" y="44" font-size="36" font-weight="900" font-family="' + FONT + '" fill="#ff5a5a" stroke="' + INK + '" stroke-width="2.6" paint-order="stroke">!</text><text x="18" y="40" font-size="26" font-weight="900" font-family="' + FONT + '" fill="#ff5a5a" stroke="' + INK + '" stroke-width="2.2" paint-order="stroke">!</text></g>',
    zzz: () => '<g class="sa-floatz" font-family="' + FONT + '" font-weight="900" fill="#8c7bff" stroke="' + INK + '" stroke-width="2" paint-order="stroke"><text x="118" y="44" font-size="22">Z</text><text x="134" y="28" font-size="16">z</text><text x="146" y="16" font-size="11">z</text></g>',
    shock: () => '<g class="sa-shiver"><path d="M50 30 V44 M62 26 V44 M74 24 V44 M86 24 V44 M98 26 V44 M110 30 V44" stroke="#5a7cff" stroke-width="3" stroke-linecap="round" opacity=".7"/></g>',
    gloom: () => '<g opacity=".75"><path d="M46 28 V48 M58 24 V48 M70 22 V48 M82 22 V48 M94 22 V48 M106 24 V48 M118 28 V48" stroke="#6b5bd6" stroke-width="3" stroke-linecap="round"/></g>',
    hearts: () => heartAt(26, 34, 1, '#ff4d6d', 'sa-floath') + heartAt(136, 30, .8, '#ff7aa2', 'sa-floath2') + heartAt(142, 70, .55, '#ff4d6d', 'sa-floath'),
    bigheart: () => '<g class="sa-beat">' + heartAt(80, 104, 1.6, '#ff4d6d') + '</g>',
    notes: () => '<g class="sa-floath" fill="' + INK + '"><path d="M128 40 V22 L144 18 V36" fill="none" stroke="' + INK + '" stroke-width="3"/><ellipse cx="125" cy="40" rx="5" ry="4"/><ellipse cx="141" cy="36" rx="5" ry="4"/></g><g class="sa-floath2" fill="' + INK + '"><path d="M24 44 V28" fill="none" stroke="' + INK + '" stroke-width="3"/><path d="M24 28 Q30 30 32 36" fill="none" stroke="' + INK + '" stroke-width="3"/><ellipse cx="21" cy="44" rx="5" ry="4"/></g>',
    sun: () => '<g class="sa-spin" transform="translate(136 26)"><g stroke="#ffb800" stroke-width="3.6" stroke-linecap="round"><path d="M0 -20 V-14 M0 14 V20 M-20 0 H-14 M14 0 H20 M-14 -14 L-10 -10 M14 -14 L10 -10 M-14 14 L-10 10 M14 14 L10 10"/></g><circle r="9" fill="#ffd23f"' + st(2.4) + '/></g>',
    moon: () => '<path d="M140 14 A16 16 0 1 0 150 40 A12 12 0 1 1 140 14 Z" fill="#ffe27a"' + st(2.4) + '/>' + sparkle(20, 24, 6, '#fff3a8'),
    flowers: () => '<g class="sa-twinkle">' + [[22, 34], [140, 30], [146, 76]].map(p => '<g transform="translate(' + p[0] + ' ' + p[1] + ')">' +
      [0, 72, 144, 216, 288].map(a => '<ellipse rx="4.6" ry="7" cy="-7" transform="rotate(' + a + ')" fill="#ffb3c7"' + st(1.8) + '/>').join('') + '<circle r="4" fill="#ffd23f"' + st(1.8) + '/></g>').join('') + '</g>',
    confetti: () => '<g class="sa-confetti">' + [[18, 22, '#ff5a7a', 20], [36, 12, '#ffd23f', -30], [124, 14, '#5ad1ff', 40], [144, 34, '#7be08a', -10], [140, 60, '#b388ff', 25], [20, 58, '#ffa94d', -40], [58, 8, '#7be08a', 10], [104, 8, '#ff5a7a', -20]].map(c =>
      '<rect x="' + c[0] + '" y="' + c[1] + '" width="9" height="5" rx="1.4" fill="' + c[2] + '" transform="rotate(' + c[3] + ' ' + c[0] + ' ' + c[1] + ')"/>').join('') + '</g>',
    popper: () => '<g transform="translate(118 108) rotate(-35)"><path d="M0 0 L-12 30 L12 30 Z" fill="#ffd23f"' + st(2.6) + '/><path d="M-6 15 L6 15 M-9 23 L9 23" stroke="#ff5a7a" stroke-width="3"/></g>',
    tea: () => '<g transform="translate(120 118)"><path d="M-14 -10 H14 L11 10 Q10 14 6 14 H-6 Q-10 14 -11 10 Z" fill="#fff"' + st(2.8) + '/><path d="M14 -6 Q22 -6 21 1 Q20 7 12 6" fill="none"' + st(2.8) + '/><path d="M-12 -7 H12" stroke="#8bc58b" stroke-width="3"/>' +
      '<g class="sa-steam" fill="none" stroke="#bbb" stroke-width="2.6" stroke-linecap="round"><path d="M-6 -16 Q-10 -22 -6 -28 Q-2 -34 -6 -40"/><path d="M5 -16 Q1 -22 5 -28 Q9 -34 5 -40"/></g></g>',
    fire: () => '<g class="sa-flicker"><path d="M18 120 Q8 96 22 80 Q22 94 30 96 Q28 82 40 70 Q40 92 48 100 Q50 116 34 124 Q20 126 18 120 Z" fill="#ff7a3d"' + st(2.4) + '/><path d="M142 120 Q152 96 138 80 Q138 94 130 96 Q132 82 120 70 Q120 92 112 100 Q110 116 126 124 Q140 126 142 120 Z" fill="#ff7a3d"' + st(2.4) + '/></g>',
    nightcap: () => '<g><path d="M48 46 Q74 30 108 40 Q98 10 64 6 Q42 14 48 46 Z" fill="#6b8cff"' + st() + '/><path d="M46 46 Q78 32 110 42" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/><path d="M46 46 Q78 32 110 42" fill="none"' + st(2) + ' opacity=".2"/><circle cx="64" cy="8" r="8" fill="#fff"' + st(2.6) + '/></g>',
    headband: () => '<path d="M36 56 Q80 44 124 56 L124 64 Q80 52 36 64 Z" fill="#fff"' + st(2.8) + '/><circle cx="80" cy="54" r="5.4" fill="#e8352e"/><path d="M124 58 L140 50 M124 62 L142 64" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><path d="M124 58 L140 50 M124 62 L142 64" fill="none"' + st(2) + '/>',
    speed: () => '<g class="sa-dash" stroke="' + INK + '" stroke-width="3" stroke-linecap="round" opacity=".55"><path d="M4 60 H22 M2 80 H26 M6 100 H20"/></g>',
    rice: () => '<g transform="translate(124 112)"><path d="M0 -18 L16 10 Q16 16 10 16 H-10 Q-16 16 -16 10 Z" fill="#fff"' + st(2.8) + '/><path d="M-12 6 H12 V16 H-12 Z" fill="#2d3a2d"/></g>',
    bubble: () => '',
    clap: () => '<g class="sa-twinkle" stroke="#ffb800" stroke-width="3.4" stroke-linecap="round"><path d="M50 28 L44 18 M80 22 V10 M110 28 L116 18"/></g>',
    tearpuddle: () => '<ellipse class="sa-puddle" cx="80" cy="146" rx="46" ry="6" fill="#8fd3ff" opacity=".7"/>',
    blushlines: () => '<path d="M44 80 L48 88 M50 80 L54 88 M106 80 L110 88 M112 80 L116 88" stroke="#ff6b81" stroke-width="2.4" stroke-linecap="round"/>',
    dots3: () => '<g class="sa-dots" fill="' + INK + '"><circle cx="120" cy="40" r="4"/><circle cx="134" cy="40" r="4"/><circle cx="148" cy="40" r="4"/></g>',
  };

  // ---- 看板(メッセージスタンプ) ----
  function signBoard(ch, text, kind) {
    const c = CHARS[ch];
    if (kind === 'bubble') {
      return '<path d="M10 10 H150 Q156 10 156 16 V66 Q156 72 150 72 H104 L92 86 L90 72 H10 Q4 72 4 66 V16 Q4 10 10 10 Z" fill="#fff"' + st(3) + '/>' + text;
    }
    if (kind === 'banner') {
      return '<path d="M4 18 H156 L148 40 L156 62 H4 L12 40 Z" fill="#ffe27a"' + st(3) + '/>' + text;
    }
    return '<rect x="10" y="8" width="140" height="70" rx="10" fill="#fff"' + st(3) + '/><path d="M18 16 H142" stroke="' + c.inner + '" stroke-width="3" opacity=".5"/>' + text;
  }

  // ---- 1枚分の組み立て ----
  // pose / eyes / mouth / props(前) / back(キャラの後ろの小物) / cap(文字) / capc(文字色) / pos('top'|'bottom'|'none')
  function character(ch, s) {
    const pose = POSES[s.pose || 'down'](ch);
    return '<g class="sa-body ' + (s.anim ? 'sa-' + s.anim : '') + '">' +
      pose[0] + bodyShape(ch) + ears(ch) + head(ch) + whiskers(ch) +
      (s.noCheek ? '' : cheeks(ch)) + EYES[s.eyes || 'dot']() + MOUTHS[s.mouth || 'cat']() +
      (s.face || []).map(p => PROPS[p]()).join('') + pose[1] + '</g>';
  }
  function esc(t) { return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // 文字(縁取り2重)。幅に合わせて大きさを決める
  function caption(text, color, y, maxW, rot) {
    const n = Array.from(text).reduce((a, ch) => a + (/[\x20-\x7e]/.test(ch) ? .62 : 1), 0) || 1;
    const fs = Math.max(11, Math.min(30, Math.floor((maxW || 148) / n)));
    const t = esc(text);
    const common = 'x="80" y="' + y + '" text-anchor="middle" font-size="' + fs + '" font-weight="900" font-family="' + FONT + '" stroke-linejoin="round" paint-order="stroke"';
    return '<g class="sa-cap" transform="rotate(' + (rot == null ? -4 : rot) + ' 80 ' + y + ')">' +
      '<text ' + common + ' fill="' + INK + '" stroke="' + INK + '" stroke-width="9">' + t + '</text>' +
      '<text ' + common + ' fill="' + (color || '#ff7a3d') + '" stroke="#fff" stroke-width="4.2">' + t + '</text></g>';
  }
  // 看板用の文字(複数行・折り返し)
  function boardText(text, box) {
    const chars = Array.from(text || '');
    const w = box.w, h = box.h;
    let best = null;
    for (let lines = 1; lines <= 3; lines++) {
      const per = Math.ceil(chars.length / lines) || 1;
      const fs = Math.min(Math.floor(w / per), Math.floor(h / lines / 1.18), 34);
      if (!best || fs > best.fs) best = { lines, per, fs };
    }
    let rows = [];
    for (let i = 0; i < best.lines; i++) rows.push(chars.slice(i * best.per, (i + 1) * best.per).join(''));
    // 2行の時は、句読点・空白の後ろで切れるならそこで切る(「遅れ/る」のような切れ方を避ける)
    if (best.lines === 2) {
      let cut = -1, worst = Infinity;
      chars.forEach((c, i) => {
        if (i === 0 || i >= chars.length - 1 || !/[\s、。!！?？,.・…ー〜~]/.test(c)) return;
        const w = Math.max(i + 1, chars.length - i - 1);
        if (w < worst) { worst = w; cut = i + 1; }
      });
      if (cut > 0 && worst <= best.per + 2) {
        rows = [chars.slice(0, cut).join('').trim(), chars.slice(cut).join('').trim()];
        best.fs = Math.min(best.fs, Math.floor(w / worst));
      }
    }
    const rs = rows.filter(r => r);
    const lh = best.fs * 1.18;
    const y0 = box.y + h / 2 - (rs.length - 1) * lh / 2 + best.fs * .36;
    return rs.map((r, i) => '<text x="' + box.x + '" y="' + (y0 + i * lh).toFixed(1) + '" text-anchor="middle" font-size="' + best.fs + '" font-weight="900" font-family="' + FONT + '" fill="' + (box.color || INK) + '">' + esc(r) + '</text>').join('');
  }

  function build(ch, s, opts) {
    opts = opts || {};
    let inner = '';
    if (s.msg) {
      // メッセージスタンプ: 上に看板、下にキャラが顔を出す
      const kind = s.msg;
      const box = kind === 'bubble' ? { x: 80, y: 14, w: 140, h: 54 } : kind === 'banner' ? { x: 80, y: 20, w: 128, h: 40 } : { x: 80, y: 12, w: 126, h: 62 };
      const text = boardText(opts.text || s.label, box);
      inner = signBoard(ch, text, kind) +
        '<g transform="translate(80 ' + (kind === 'bubble' ? 124 : 122) + ') scale(.56) translate(-80 -82)">' + character(ch, s) + '</g>';
      if (kind === 'sign') inner = '<path d="M60 76 V100 M100 76 V100" stroke="#b07a46" stroke-width="7" stroke-linecap="round"/>' + inner;
      return inner;
    }
    const pos = s.pos || 'bottom';
    const scale = s.scale || (pos === 'none' ? .92 : .8);
    const cy = pos === 'top' ? 98 : pos === 'none' ? 80 : 66;
    inner = (s.back || []).map(p => PROPS[p]()).join('') +
      '<g transform="translate(80 ' + cy + ') scale(' + scale + ') translate(-80 -82)">' + character(ch, s) + '</g>' +
      (s.props || []).map(p => PROPS[p]()).join('');
    if (pos !== 'none') inner += caption(s.label, s.capc, pos === 'top' ? 32 : 150, 150, s.rot);
    return inner;
  }

  // ---- サウンド(WebAudioで合成。音声ファイルは使わない) ----
  // [周波数Hz, 長さ秒, 波形, 音量] の並び。0Hzは休み
  const SOUNDS = {
    hi: [[784, .09, 'square', .12], [1047, .16, 'square', .12]],
    yay: [[523, .08, 'triangle'], [659, .08, 'triangle'], [784, .08, 'triangle'], [1047, .22, 'triangle']],
    ok: [[880, .1, 'sine'], [1319, .2, 'sine']],
    no: [[330, .14, 'sawtooth', .08], [247, .26, 'sawtooth', .08]],
    cry: [[660, .18, 'sine'], [620, .18, 'sine'], [560, .34, 'sine']],
    love: [[659, .1, 'sine'], [880, .1, 'sine'], [1175, .3, 'sine']],
    bye: [[1047, .1, 'triangle'], [784, .1, 'triangle'], [523, .22, 'triangle']],
    what: [[440, .06, 'square', .1], [880, .2, 'square', .1]],
    thx: [[587, .1, 'triangle'], [740, .1, 'triangle'], [880, .1, 'triangle'], [0, .04], [880, .2, 'triangle']],
    sleep: [[196, .4, 'sine', .14], [0, .1], [174, .5, 'sine', .14]],
    hungry: [[110, .12, 'sawtooth', .1], [98, .14, 'sawtooth', .1], [82, .3, 'sawtooth', .1]],
    angry: [[220, .07, 'square', .1], [0, .03], [220, .07, 'square', .1], [0, .03], [220, .14, 'square', .1]],
    shy: [[1319, .07, 'sine'], [1175, .07, 'sine'], [1319, .16, 'sine']],
    run: [[523, .05, 'square', .08], [659, .05, 'square', .08], [523, .05, 'square', .08], [659, .05, 'square', .08], [784, .12, 'square', .08]],
    clap: 'clap',
    omg: [[392, .2, 'sawtooth', .1], [370, .2, 'sawtooth', .1], [349, .2, 'sawtooth', .1], [330, .45, 'sawtooth', .1]],
  };
  let actx = null;
  function playSound(name) {
    const pat = SOUNDS[name];
    if (!pat) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const master = actx.createGain(); master.gain.value = .7; master.connect(actx.destination);
      let t = actx.currentTime + .02;
      if (pat === 'clap') {
        for (let i = 0; i < 4; i++) {
          const len = Math.floor(actx.sampleRate * .06);
          const b = actx.createBuffer(1, len, actx.sampleRate);
          const d = b.getChannelData(0);
          for (let j = 0; j < len; j++) d[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 3);
          const src = actx.createBufferSource(); src.buffer = b;
          const g = actx.createGain(); g.gain.value = .5;
          const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400;
          src.connect(f); f.connect(g); g.connect(master); src.start(t);
          t += .13;
        }
        return;
      }
      pat.forEach(n => {
        const [hz, dur, type, vol] = n;
        if (hz > 0) {
          const o = actx.createOscillator(); o.type = type || 'sine'; o.frequency.value = hz;
          const g = actx.createGain();
          const v = vol || .18;
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + .01);
          g.gain.setValueAtTime(v, t + dur * .7); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
          o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + .02);
        }
        t += dur;
      });
    } catch (e) {}
  }

  // ---- 定義 ----
  // [id, 表示名, 検索語, 設定]
  const NEKO = [
    ['ok', 'OK', ['ok', 'おけ', 'オッケー', 'おっけー', 'いいよ', 'りょ'], { pose: 'okring', eyes: 'happy', mouth: 'grin', props: ['sparkles'], anim: 'bounce', capc: '#ff7a3d' }],
    ['ryokai', '了解!', ['了解', 'りょうかい', 'りょ', 'わかった', '承知'], { pose: 'salute', eyes: 'dot', mouth: 'smile', anim: 'pop', capc: '#3d8fff', face: [] }],
    ['thanks', 'ありがとう', ['ありがとう', 'ありがと', 'あざす', 'サンキュー', 'thx', 'thanks', '感謝'], { pose: 'pray', eyes: 'happy', mouth: 'cat', props: ['flowers'], anim: 'bow', capc: '#ff6f91' }],
    ['sorry', 'ごめんね', ['ごめん', 'ごめんね', 'すまん', 'すみません', 'sorry', 'ゴメン'], { pose: 'pray', eyes: 'teary', mouth: 'frown', props: ['sweat'], anim: 'bow', capc: '#6b8cff' }],
    ['wakaran', 'わからん', ['わからん', 'わからない', '？', '?', 'なに', '不明'], { pose: 'down', eyes: 'dot', mouth: 'wavy', props: ['question'], anim: 'tilt', capc: '#5aa9ff' }],
    ['majika', 'まじか', ['まじか', 'マジか', 'まじ', 'うそ', 'え', 'えっ'], { pose: 'banzai', eyes: 'wide', mouth: 'o', props: ['exclaim', 'speed'], anim: 'shake', capc: '#ff5a5a' }],
    ['yabai', 'やばい', ['やばい', 'ヤバい', 'やば', 'ヤバ', 'まずい', '焦'], { pose: 'cheeks', eyes: 'wide', mouth: 'wavy', props: ['shock', 'sweat2'], anim: 'tremble', capc: '#5a7cff' }],
    ['warai', 'www', ['笑', 'w', 'www', 'わら', 'ワロタ', '草', 'うける', 'ウケる'], { pose: 'banzai', eyes: 'squeeze', mouth: 'grin', props: ['sparkles'], anim: 'shake', capc: '#3cbf6b' }],
    ['nemui', 'ねむい', ['ねむい', '眠い', 'ねむ', 'ねる', '寝る'], { pose: 'down', eyes: 'sleepy', mouth: 'small', props: ['zzz'], anim: 'sway', capc: '#8c7bff' }],
    ['otsukare', 'おつかれ', ['おつかれ', 'お疲れ', 'おつ', '乙', 'お疲れ様', 'おつかれさま'], { pose: 'down', eyes: 'closed', mouth: 'cat', props: ['tea'], anim: 'sway', capc: '#3cbf6b' }],
    ['iine', 'いいね!', ['いいね', 'いいね!', 'ナイス', 'nice', 'good', 'グッド', 'さすが'], { pose: 'thumbs', eyes: 'star', mouth: 'grin', props: ['sparkles'], anim: 'pop', capc: '#ff9f1c' }],
    ['ha', 'は?', ['は', 'は?', 'は？', 'はぁ', 'はあ'], { pose: 'down', eyes: 'angry', mouth: 'flat', props: ['vein'], anim: 'zoom', capc: '#e8352e', noCheek: true }],
    ['fuzake', 'ふざけんな', ['ふざけんな', 'ふざけるな', 'おこ', '怒', 'むかつく', 'ムカつく'], { pose: 'fists', eyes: 'angry', mouth: 'teeth', props: ['vein', 'fire'], anim: 'shake', capc: '#e8352e', noCheek: true }],
    ['naku', 'うえーん', ['泣', 'うえーん', 'えーん', 'ぴえん', 'かなしい', '悲しい', 'つらい'], { pose: 'down', eyes: 'teary', mouth: 'wail', props: ['tearpuddle'], anim: 'sob', capc: '#4aa3ff' }],
    ['suki', 'すき', ['すき', '好き', '大好き', 'だいすき', 'love', 'ラブ', 'ハート'], { pose: 'hold', eyes: 'heart', mouth: 'cat', props: ['hearts', 'bigheart'], anim: 'sway', capc: '#ff4d6d', fx: 'hearts' }],
    ['oyasumi', 'おやすみ', ['おやすみ', 'おやすみなさい', 'good night', 'ねる', '寝る'], { pose: 'down', eyes: 'closed', mouth: 'small', face: ['nightcap'], props: ['moon', 'zzz'], anim: 'sway', capc: '#6b8cff' }],
    ['ohayo', 'おはよう', ['おはよう', 'おは', 'おはようございます', 'good morning'], { pose: 'wave', eyes: 'dot', mouth: 'smile', props: ['sun'], anim: 'bounce', capc: '#ff9f1c' }],
    ['matte', 'まって!', ['まって', '待って', 'ちょっと', 'ストップ', 'stop'], { pose: 'stop', eyes: 'wide', mouth: 'wavy', props: ['sweat'], anim: 'tremble', capc: '#ff7a3d' }],
    ['yoroshiku', 'よろしく', ['よろしく', 'よろしくね', 'よろ', 'よろしくお願いします'], { pose: 'pray', eyes: 'happy', mouth: 'smile', props: ['sparkles'], anim: 'bow', capc: '#ff6f91' }],
    ['omedeto', 'おめでとう', ['おめでとう', 'おめ', 'おめでと', '誕生日', 'たんじょうび', 'happy birthday', 'congrats'], { pose: 'banzai', eyes: 'happy', mouth: 'grin', props: ['confetti', 'popper'], anim: 'jump', capc: '#ff4d6d', fx: 'confetti' }],
    ['ganbare', 'がんばれ', ['がんばれ', '頑張れ', 'がんば', 'ファイト', 'fight', 'がんばって'], { pose: 'fists', eyes: 'big', mouth: 'grin', face: ['headband'], anim: 'jump', capc: '#e8352e' }],
    ['hai', 'はーい', ['はーい', 'はい', 'うん', 'yes', 'おk'], { pose: 'raise', eyes: 'happy', mouth: 'smile', anim: 'bounce', capc: '#3cbf6b' }],
    ['gyu', 'ぎゅー', ['ぎゅー', 'ぎゅ', 'ハグ', 'hug', 'だきしめ'], { pose: 'hug', eyes: 'closed', mouth: 'cat', props: ['hearts'], anim: 'squish', capc: '#ff6f91', fx: 'hearts' }],
    ['ten', '……', ['…', '...', '・・・', '無言', 'え', '沈黙'], { pose: 'down', eyes: 'flat', mouth: 'flat', props: ['dots3'], anim: 'none', capc: '#8a8a8a', pos: 'none', noCheek: true }],
  ];
  const USA = [
    ['usa_hi', 'やっほー', ['やっほー', 'やほ', 'こんにちは', 'ハロー', 'hello', 'hi'], { pose: 'wave', eyes: 'big', mouth: 'smile', anim: 'bounce', capc: '#ff6f91', snd: 'hi' }],
    ['usa_yay', 'わーい', ['わーい', 'やった', 'やったー', 'うれしい', '嬉しい', 'yay'], { pose: 'banzai', eyes: 'happy', mouth: 'grin', props: ['sparkles'], anim: 'jump', capc: '#ff9f1c', snd: 'yay' }],
    ['usa_ok', 'おっけー', ['ok', 'おっけー', 'オッケー', 'りょ', 'いいよ'], { pose: 'okring', eyes: 'wink', mouth: 'tongue', anim: 'bounce', capc: '#3cbf6b', snd: 'ok' }],
    ['usa_no', 'ムリ', ['むり', 'ムリ', '無理', 'no', 'いや', 'やだ'], { pose: 'cover', eyes: 'flat', mouth: 'frown', props: ['gloom'], anim: 'tremble', capc: '#6b5bd6', snd: 'no' }],
    ['usa_cry', 'ぴえん', ['ぴえん', 'ぱおん', '泣', 'かなしい', 'つらい'], { pose: 'cheeks', eyes: 'teary', mouth: 'frown', anim: 'sob', capc: '#4aa3ff', snd: 'cry' }],
    ['usa_love', 'だいすき', ['だいすき', '大好き', 'すき', '好き', 'love', 'ハート'], { pose: 'hold', eyes: 'heart', mouth: 'smile', props: ['hearts', 'bigheart'], anim: 'sway', capc: '#ff4d6d', snd: 'love', fx: 'hearts' }],
    ['usa_bye', 'またね', ['またね', 'バイバイ', 'ばいばい', 'じゃあね', 'bye', 'またあした'], { pose: 'wave', eyes: 'happy', mouth: 'smile', anim: 'sway', capc: '#5aa9ff', snd: 'bye' }],
    ['usa_what', 'えっ', ['えっ', 'え', 'えー', 'うそ', 'まじ'], { pose: 'down', eyes: 'wide', mouth: 'o', props: ['exclaim'], anim: 'zoom', capc: '#ff5a5a', snd: 'what' }],
    ['usa_thx', 'サンキュー', ['ありがとう', 'サンキュー', 'さんきゅ', 'thx', 'thanks', 'あざす'], { pose: 'thumbs', eyes: 'wink', mouth: 'grin', props: ['sparkles'], anim: 'pop', capc: '#ff9f1c', snd: 'thx' }],
    ['usa_sleep', 'ぐー', ['ぐー', 'ねる', '寝る', 'ねむい', 'おやすみ', 'zzz'], { pose: 'down', eyes: 'closed', mouth: 'small', props: ['zzz'], anim: 'sway', capc: '#8c7bff', snd: 'sleep' }],
    ['usa_hungry', 'おなかすいた', ['おなかすいた', 'はらへ', '腹減', 'お腹すいた', 'ごはん', 'ご飯'], { pose: 'cheeks', eyes: 'swirl', mouth: 'wavy', props: ['rice'], anim: 'sway', capc: '#ff9f1c', snd: 'hungry' }],
    ['usa_angry', 'ぷんぷん', ['ぷんぷん', 'おこ', '怒', 'むかつく', 'ムカ'], { pose: 'fists', eyes: 'angry', mouth: 'frown', props: ['vein'], anim: 'shake', capc: '#e8352e', snd: 'angry', noCheek: false }],
    ['usa_shy', 'てれてれ', ['てれ', 'てれてれ', '照れ', 'はずかしい', '恥ずかしい'], { pose: 'cover', eyes: 'closed', mouth: 'cat', face: ['blushlines'], props: ['hearts'], anim: 'sway', capc: '#ff6f91', snd: 'shy' }],
    ['usa_run', 'いまいく!', ['いまいく', '今行く', 'いく', '行く', 'すぐ行く', 'ダッシュ'], { pose: 'banzai', eyes: 'big', mouth: 'grin', props: ['speed', 'sweat'], anim: 'run', capc: '#3d8fff', snd: 'run' }],
    ['usa_clap', 'パチパチ', ['パチパチ', 'ぱちぱち', '拍手', 'すごい', 'すご', 'おめでとう'], { pose: 'pray', eyes: 'happy', mouth: 'grin', props: ['clap', 'sparkles'], anim: 'pop', capc: '#ff9f1c', snd: 'clap' }],
    ['usa_omg', 'ガーン', ['ガーン', 'がーん', 'ショック', 'しょっく', 'うそでしょ', '絶望'], { pose: 'down', eyes: 'wide', mouth: 'wavy', props: ['gloom'], anim: 'droop', capc: '#6b5bd6', snd: 'omg', noCheek: true }],
  ];
  const KUMA = [
    ['kuma_ok', 'りょ', ['りょ', 'りょうかい', 'ok', 'おけ'], { pose: 'salute', eyes: 'dot', mouth: 'cat', anim: 'pop', capc: '#a0612b' }],
    ['kuma_ya', 'やったね', ['やったね', 'やった', 'すごい', 'ナイス'], { pose: 'banzai', eyes: 'happy', mouth: 'grin', props: ['confetti'], anim: 'jump', capc: '#ff7a3d', fx: 'confetti' }],
    ['kuma_hmm', 'うーん', ['うーん', 'うむ', 'なやむ', '悩む', 'どうしよう'], { pose: 'cheeks', eyes: 'flat', mouth: 'wavy', props: ['question'], anim: 'tilt', capc: '#a0612b' }],
    ['kuma_eat', 'もぐもぐ', ['もぐもぐ', 'たべる', '食べる', 'ごはん', 'いただきます'], { pose: 'hold', eyes: 'closed', mouth: 'grin', props: ['rice'], anim: 'squish', capc: '#ff9f1c' }],
    ['kuma_fight', 'ファイト', ['ファイト', 'がんばれ', '頑張れ', 'fight'], { pose: 'fists', eyes: 'big', mouth: 'grin', face: ['headband'], props: ['fire'], anim: 'jump', capc: '#e8352e' }],
    ['kuma_ok2', 'だいじょうぶ?', ['だいじょうぶ', '大丈夫', 'だいじょぶ', '平気'], { pose: 'pray', eyes: 'dot', mouth: 'small', props: ['sweat'], anim: 'tilt', capc: '#5aa9ff' }],
    ['kuma_tired', 'つかれた', ['つかれた', '疲れた', 'しんどい', 'つら'], { pose: 'down', eyes: 'swirl', mouth: 'wavy', props: ['gloom'], anim: 'droop', capc: '#6b5bd6', noCheek: true }],
    ['kuma_kansha', '感謝', ['感謝', 'かんしゃ', 'ありがとう', 'ありがたい'], { pose: 'pray', eyes: 'closed', mouth: 'cat', props: ['sparkles', 'flowers'], anim: 'bow', capc: '#ff6f91' }],
  ];
  const MSG = [
    ['msg_neko_sign', 'ここに文字', ['メッセージ', '看板', 'カスタム'], { msg: 'sign', pose: 'hold', eyes: 'dot', mouth: 'cat', ch: 'neko', anim: 'none' }],
    ['msg_neko_bubble', 'ここに文字', ['メッセージ', 'ふきだし', 'カスタム'], { msg: 'bubble', pose: 'wave', eyes: 'happy', mouth: 'smile', ch: 'neko', anim: 'none' }],
    ['msg_usa_sign', 'ここに文字', ['メッセージ', '看板', 'カスタム'], { msg: 'sign', pose: 'hold', eyes: 'big', mouth: 'smile', ch: 'usa', anim: 'none' }],
    ['msg_usa_banner', 'ここに文字', ['メッセージ', 'バナー', 'カスタム'], { msg: 'banner', pose: 'banzai', eyes: 'happy', mouth: 'grin', ch: 'usa', anim: 'none' }],
    ['msg_kuma_sign', 'ここに文字', ['メッセージ', '看板', 'カスタム'], { msg: 'sign', pose: 'hold', eyes: 'dot', mouth: 'cat', ch: 'kuma', anim: 'none' }],
    ['msg_kuma_bubble', 'ここに文字', ['メッセージ', 'ふきだし', 'カスタム'], { msg: 'bubble', pose: 'raise', eyes: 'closed', mouth: 'smile', ch: 'kuma', anim: 'none' }],
  ];

  const BY_ID = {};
  function mk(ch, list) {
    return list.map(r => {
      const s = Object.assign({ label: r[1] }, r[3]);
      const def = { id: r[0], label: r[1], kw: r[2], ch: s.ch || ch, s, anim: s.anim && s.anim !== 'none' ? s.anim : null, snd: s.snd || null, fx: s.fx || null, msg: s.msg || null };
      BY_ID[r[0]] = def;
      return { id: def.id, label: def.label, kw: def.kw, anim: def.anim, snd: def.snd, fx: def.fx, msg: !!def.msg };
    });
  }
  const packs = [
    { id: 'b:neko', title: 'ねこまる', author: 'Bro Chat', desc: '毎日使える、ゆるいねこ。動くスタンプ', kind: 'animated', stickers: mk('neko', NEKO) },
    { id: 'b:usa', title: 'もちうさ サウンド', author: 'Bro Chat', desc: 'タップすると音が鳴るうさぎ', kind: 'sound', stickers: mk('usa', USA) },
    { id: 'b:kuma', title: 'くまごろう', author: 'Bro Chat', desc: 'のんびりくま', kind: 'animated', stickers: mk('kuma', KUMA) },
    { id: 'b:msg', title: 'メッセージスタンプ', author: 'Bro Chat', desc: '好きな文字を入れて送れる', kind: 'message', stickers: mk('neko', MSG) },
  ];

  // 表示用のSVG。opts.text はメッセージスタンプの文字(ここでエスケープする)
  function svg(id, opts) {
    const d = BY_ID[id];
    if (!d) return '';
    opts = opts || {};
    const px = opts.px || 160;
    const label = esc(opts.text || d.label);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="' + px + '" height="' + px + '" role="img" aria-label="' + label + '" class="sa-svg' + (d.anim ? ' sa-anim' : '') + '" overflow="visible">' +
      build(d.ch, d.s, opts) + '</svg>';
  }

  // 動き(親に .sa-play が付いた時だけ動く。3回で止まる。LINEの動くスタンプと同じ)
  const css =
    '.sa-svg *{transform-box:fill-box}' +
    '.sa-play .sa-body{animation-duration:.9s;animation-iteration-count:3;animation-timing-function:ease-in-out;transform-origin:50% 100%}' +
    '.sa-play .sa-bounce{animation-name:saBounce}.sa-play .sa-jump{animation-name:saJump}.sa-play .sa-pop{animation-name:saPop}' +
    '.sa-play .sa-shake{animation-name:saShake;animation-duration:.45s;animation-iteration-count:6}' +
    '.sa-play .sa-tremble{animation-name:saTremble;animation-duration:.18s;animation-iteration-count:14}' +
    '.sa-play .sa-sway{animation-name:saSway;animation-duration:1.4s}' +
    '.sa-play .sa-tilt{animation-name:saTilt;animation-duration:1.2s}' +
    '.sa-play .sa-bow{animation-name:saBow;animation-duration:1.1s}' +
    '.sa-play .sa-zoom{animation-name:saZoom;animation-duration:.7s}' +
    '.sa-play .sa-sob{animation-name:saSob;animation-duration:.35s;animation-iteration-count:8}' +
    '.sa-play .sa-squish{animation-name:saSquish;animation-duration:.8s}' +
    '.sa-play .sa-droop{animation-name:saDroop;animation-duration:1.4s;animation-iteration-count:2}' +
    '.sa-play .sa-run{animation-name:saRun;animation-duration:.3s;animation-iteration-count:9}' +
    '.sa-play .sa-wave{animation:saWave .5s ease-in-out 6;transform-origin:0% 100%}' +
    '.sa-play .sa-armL{animation:saArmL .45s ease-in-out 6;transform-origin:100% 100%}' +
    '.sa-play .sa-armR{animation:saArmR .45s ease-in-out 6;transform-origin:0% 100%}' +
    '.sa-play .sa-raise{animation:saArmR .6s ease-in-out 4;transform-origin:0% 100%}' +
    '.sa-play .sa-thumb{animation:saPop .7s ease-in-out 3;transform-origin:50% 100%}' +
    '.sa-play .sa-salute{animation:saSalute .8s ease-in-out 3;transform-origin:0% 100%}' +
    '.sa-play .sa-earl{animation:saArmL .6s ease-in-out 4;transform-origin:50% 100%}.sa-play .sa-earr{animation:saArmR .6s ease-in-out 4;transform-origin:50% 100%}' +
    '.sa-play .sa-twinkle{animation:saTwinkle .6s ease-in-out 5;transform-origin:50% 50%}' +
    '.sa-play .sa-floatz{animation:saFloat 1.4s ease-out 3}' +
    '.sa-play .sa-floath{animation:saFloat 1.2s ease-out 3}.sa-play .sa-floath2{animation:saFloat 1.2s .4s ease-out 3}' +
    '.sa-play .sa-beat{animation:saBeat .6s ease-in-out 5;transform-origin:50% 50%}' +
    '.sa-play .sa-pulse{animation:saBeat .4s ease-in-out 6;transform-origin:50% 50%}' +
    '.sa-play .sa-drip{animation:saDrip 1s ease-in 3}.sa-play .sa-drip2{animation:saDrip 1s .3s ease-in 3}' +
    '.sa-play .sa-tear{animation:saTear .5s linear 6}' +
    '.sa-play .sa-spin{animation:saSpin 2.4s linear 2;transform-origin:50% 50%}' +
    '.sa-play .sa-steam{animation:saFloat 1.3s ease-out 3}' +
    '.sa-play .sa-flicker{animation:saFlick .25s ease-in-out 12;transform-origin:50% 100%}' +
    '.sa-play .sa-confetti{animation:saConf 1.2s ease-out 2}' +
    '.sa-play .sa-shiver{animation:saTremble .15s linear 14}' +
    '.sa-play .sa-dash{animation:saDash .3s linear 9}' +
    '.sa-play .sa-dots circle{animation:saDot 1s ease-in-out 3}.sa-play .sa-dots circle:nth-child(2){animation-delay:.15s}.sa-play .sa-dots circle:nth-child(3){animation-delay:.3s}' +
    '.sa-play .sa-cap{animation:saCap .5s cubic-bezier(.2,1.6,.4,1) 1;transform-origin:50% 50%}' +
    '.sa-play .sa-puddle{animation:saPuddle 1.6s ease-out 1;transform-origin:50% 50%}' +
    '.sa-play .sa-blink{animation:saBlink 1.8s 2;transform-origin:50% 50%}' +
    '.sa-play .sa-tilt2{animation:saTilt 1s ease-in-out 3;transform-origin:50% 50%}.sa-play .sa-pop2{animation:saPop .6s ease-in-out 4;transform-origin:50% 100%}' +
    '@keyframes saBounce{0%,100%{transform:translateY(0)}30%{transform:translateY(-10%) scale(1.02,.98)}55%{transform:translateY(0) scale(1.06,.93)}75%{transform:translateY(-3%)}}' +
    '@keyframes saJump{0%,100%{transform:translateY(0) scale(1)}15%{transform:scale(1.08,.9)}45%{transform:translateY(-18%) scale(.95,1.06)}75%{transform:translateY(0) scale(1.08,.92)}}' +
    '@keyframes saPop{0%,100%{transform:scale(1)}40%{transform:scale(1.12)}70%{transform:scale(.96)}}' +
    '@keyframes saShake{0%,100%{transform:rotate(0)}25%{transform:rotate(-6deg)}75%{transform:rotate(6deg)}}' +
    '@keyframes saTremble{0%,100%{transform:translateX(0)}50%{transform:translateX(2.5%)}}' +
    '@keyframes saSway{0%,100%{transform:rotate(0)}25%{transform:rotate(-5deg)}75%{transform:rotate(5deg)}}' +
    '@keyframes saTilt{0%,100%{transform:rotate(0)}40%,60%{transform:rotate(-14deg)}}' +
    '@keyframes saBow{0%,100%{transform:rotate(0) translateY(0)}35%,65%{transform:rotate(0) translateY(10%) scaleY(.9)}}' +
    '@keyframes saZoom{0%{transform:scale(.6)}50%{transform:scale(1.15)}100%{transform:scale(1)}}' +
    '@keyframes saSob{0%,100%{transform:translateY(0)}50%{transform:translateY(3%) scale(1.02,.97)}}' +
    '@keyframes saSquish{0%,100%{transform:scale(1)}30%{transform:scale(1.12,.86)}60%{transform:scale(.94,1.06)}}' +
    '@keyframes saDroop{0%{transform:translateY(0)}50%,100%{transform:translateY(8%) scaleY(.92)}}' +
    '@keyframes saRun{0%,100%{transform:translate(0,0) rotate(-6deg)}50%{transform:translate(3%,-5%) rotate(-10deg)}}' +
    '@keyframes saWave{0%,100%{transform:rotate(0)}50%{transform:rotate(-24deg)}}' +
    '@keyframes saArmL{0%,100%{transform:rotate(0)}50%{transform:rotate(14deg)}}' +
    '@keyframes saArmR{0%,100%{transform:rotate(0)}50%{transform:rotate(-14deg)}}' +
    '@keyframes saSalute{0%,100%{transform:rotate(0)}30%{transform:rotate(12deg)}}' +
    '@keyframes saTwinkle{0%,100%{transform:scale(1) rotate(0);opacity:1}50%{transform:scale(.6) rotate(20deg);opacity:.6}}' +
    '@keyframes saFloat{0%{transform:translateY(8px);opacity:0}30%{opacity:1}100%{transform:translateY(-10px);opacity:0}}' +
    '@keyframes saBeat{0%,100%{transform:scale(1)}30%{transform:scale(1.2)}55%{transform:scale(.95)}}' +
    '@keyframes saDrip{0%{transform:translateY(0);opacity:1}100%{transform:translateY(14px);opacity:0}}' +
    '@keyframes saTear{0%{transform:scaleY(.6)}50%{transform:scaleY(1.08)}100%{transform:scaleY(.6)}}' +
    '@keyframes saSpin{to{transform:rotate(360deg)}}' +
    '@keyframes saFlick{0%,100%{transform:scale(1,1)}50%{transform:scale(.9,1.12)}}' +
    '@keyframes saConf{0%{transform:translateY(-14px);opacity:0}20%{opacity:1}100%{transform:translateY(10px);opacity:1}}' +
    '@keyframes saDash{0%{transform:translateX(4px);opacity:.2}100%{transform:translateX(-6px);opacity:1}}' +
    '@keyframes saDot{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}' +
    '@keyframes saCap{0%{transform:scale(.3);opacity:0}100%{transform:scale(1);opacity:1}}' +
    '@keyframes saPuddle{0%{transform:scaleX(.2);opacity:0}100%{transform:scaleX(1);opacity:.7}}' +
    '@keyframes saBlink{0%,44%,52%,100%{transform:scaleY(1)}48%{transform:scaleY(.1)}}' +
    'html.reduce-motion .sa-play *{animation:none!important}@media (prefers-reduced-motion:reduce){.sa-play *{animation:none!important}}';

  // メッセージスタンプの初期文字が入る看板サイズの都合で、最大文字数を決めておく
  const MSG_MAX = 24;

  window.BroStampArt = { packs, svg, playSound, css, has: id => !!BY_ID[id], def: id => BY_ID[id] || null, MSG_MAX, esc };
})();
