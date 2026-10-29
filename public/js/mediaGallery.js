// mediaGallery.js
// トーク(個人・グループ)の画像/動画ビューア。
//  - 左右スワイプで前・次のメディアへ(端はゴムのように引っ張られて戻る)
//  - 縦にスワイプして閉じる(背景が薄くなる)
//  - ピンチ拡大・ダブルタップで拡大/戻す・拡大中はドラッグで移動
//  - タップで操作ボタンの表示/非表示、「3 / 12」の枚数表示
//  - 端末の戻るボタンで閉じる、PCは矢印キー/Esc/ホイール拡大
// 使い方: BroGallery.open(クリックされた<img>/<video>, {selector: '同じトークのメディアを拾うCSSセレクタ'})
(function () {
  if (window.BroGallery) return;

  const PH = 'data:image/gif;base64,R0lGODlhAQAB'; // 読み込み前の1x1プレースホルダー
  const MAXZ = 6;
  const SVG = {
    close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    dl: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    prev: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    next: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    play: '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="rgba(255,255,255,.75)"/></svg>',
  };

  let ov = null, track = null, counter = null, uiEls = [], btnPrev = null, btnNext = null;
  let items = [], idx = 0, W = 0, H = 0, slides = {}, open = false, uiOn = true;
  let sc = 1, tx = 0, ty = 0;                 // 今のスライドの拡大率と位置
  let mode = null, busy = false;
  let t0 = null, lastTap = null, tapTimer = null, lastTouchAt = 0, pinch = null, drag = null;
  let pushed = false, prevOverflow = '';

  function css() {
    if (document.getElementById('bro-gal-css')) return;
    const s = document.createElement('style');
    s.id = 'bro-gal-css';
    s.textContent =
      '.bgal{position:fixed;inset:0;z-index:20000;background:#000;opacity:0;transition:opacity .2s ease;touch-action:none;user-select:none;-webkit-user-select:none;overflow:hidden;-webkit-tap-highlight-color:transparent}' +
      '.bgal.on{opacity:1}' +
      '.bgal-track{position:absolute;inset:0;will-change:transform}' +
      '.bgal-slide{position:absolute;top:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden}' +
      '.bgal-slide img,.bgal-slide video{width:100%;height:100%;object-fit:contain;display:block;transform-origin:center center;will-change:transform;-webkit-user-drag:none}' +
      '.bgal-slide video{background:#000}' +
      '.bgal-msg{color:rgba(255,255,255,.7);font-size:14px}' +
      '.bgal-btn{position:absolute;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.35);border-radius:50%;width:42px;height:42px;display:flex;justify-content:center;align-items:center;cursor:pointer;z-index:2;padding:0;transition:opacity .2s ease}' +
      '.bgal-btn:active{background:rgba(255,255,255,.35)}' +
      '.bgal-cnt{position:absolute;left:50%;transform:translateX(-50%);top:calc(24px + env(safe-area-inset-top,0px));padding:5px 12px;border-radius:999px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3);color:#fff;font-size:13px;font-weight:700;letter-spacing:.5px;z-index:2;transition:opacity .2s ease;font-variant-numeric:tabular-nums}' +
      '.bgal.hideui .bgal-btn,.bgal.hideui .bgal-cnt{opacity:0;pointer-events:none}' +
      '.bgal-arrow{display:none}' +
      '@media (hover:hover) and (pointer:fine){.bgal-arrow{display:flex;top:50%;margin-top:-21px}}';
    document.head.appendChild(s);
  }

  function btn(svg, label, extra) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'bgal-btn ' + (extra || ''); b.innerHTML = svg;
    b.setAttribute('aria-label', label); b.title = label;
    return b;
  }

  function build() {
    css();
    ov = document.createElement('div');
    ov.className = 'bgal';
    ov.setAttribute('role', 'dialog');
    track = document.createElement('div'); track.className = 'bgal-track';
    ov.appendChild(track);

    counter = document.createElement('div'); counter.className = 'bgal-cnt';
    const top = 'calc(16px + env(safe-area-inset-top,0px))';
    const bClose = btn(SVG.close, '閉じる'); bClose.style.cssText = 'top:' + top + ';right:16px';
    const bDl = btn(SVG.dl, 'ダウンロード'); bDl.style.cssText = 'top:' + top + ';right:70px';
    btnPrev = btn(SVG.prev, '前へ', 'bgal-arrow'); btnPrev.style.left = '16px';
    btnNext = btn(SVG.next, '次へ', 'bgal-arrow'); btnNext.style.right = '16px';
    bClose.onclick = () => close();
    bDl.onclick = () => download();
    btnPrev.onclick = () => go(idx - 1);
    btnNext.onclick = () => go(idx + 1);
    [counter, bClose, bDl, btnPrev, btnNext].forEach(e => ov.appendChild(e));
    uiEls = [counter, bClose, bDl, btnPrev, btnNext];

    ov.addEventListener('touchstart', onStart, { passive: true });
    ov.addEventListener('touchmove', onMove, { passive: false });
    ov.addEventListener('touchend', onEnd, { passive: true });
    ov.addEventListener('touchcancel', onEnd, { passive: true });
    ov.addEventListener('wheel', onWheel, { passive: false });
    ov.addEventListener('mousedown', onMouseDown);
    ov.addEventListener('click', onClick);
  }

  // ---- 取得 ----
  const srcOf = el => el.currentSrc || el.src || '';
  const isVideo = el => el && el.tagName === 'VIDEO';
  const loaded = el => { const s = srcOf(el); return !!s && s.indexOf(PH) !== 0; };
  const curKind = () => (items[idx] && isVideo(items[idx])) ? 'video' : 'image';

  function collect(el, selector) {
    let list = [];
    try {
      list = Array.prototype.filter.call(document.querySelectorAll(selector), n =>
        !n.closest('[class*="quote"],[class*="avatar"],[class*="file"]'));
    } catch (e) { list = []; }
    if (list.indexOf(el) < 0) list = [el];
    return list;
  }

  // ---- スライド ----
  function makeSlide(i, isCur) {
    const el = items[i];
    const s = document.createElement('div');
    s.className = 'bgal-slide';
    s.style.left = ((i - idx) * 100) + '%';
    fillSlide(s, el, isCur);
    return s;
  }

  function fillSlide(s, el, isCur) {
    s.innerHTML = '';
    if (isVideo(el)) {
      if (!isCur) { s.innerHTML = SVG.play; return; }   // 隣の動画は再生マークだけ(重くしない)
      if (!loaded(el)) return waitLoad(s, el, isCur);
      const v = document.createElement('video');
      v.controls = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.autoplay = true;
      v.src = srcOf(el);
      s.appendChild(v);
      const p = v.play(); if (p && p.catch) p.catch(() => {});
      return;
    }
    if (!loaded(el)) return waitLoad(s, el, isCur);
    const im = document.createElement('img');
    im.draggable = false; im.decoding = 'async'; im.src = srcOf(el);
    s.appendChild(im);
  }

  // まだ復号中の画像は「読み込み中」を出し、届いたら差し替える
  function waitLoad(s, el, isCur) {
    const m = document.createElement('div'); m.className = 'bgal-msg'; if (window.BroDots) BroDots.set(m, '読み込み中...', { wow: true }); else m.textContent = '読み込み中...';
    s.appendChild(m);
    let n = 0;
    const iv = setInterval(() => {
      if (!s.isConnected || ++n > 360) { clearInterval(iv); return; }
      if (loaded(el)) { clearInterval(iv); fillSlide(s, el, isCur); }
    }, 250);
  }

  function render() {
    // 古いスライドを片付ける(動画は止める)
    Object.keys(slides).forEach(k => {
      const v = slides[k].querySelector('video'); if (v) { try { v.pause(); } catch (e) {} }
      slides[k].remove();
    });
    slides = {};
    for (let i = idx - 1; i <= idx + 1; i++) {
      if (i < 0 || i >= items.length) continue;
      slides[i] = makeSlide(i, i === idx);
      track.appendChild(slides[i]);
    }
    track.style.transition = 'none';
    track.style.transform = 'translate3d(0,0,0)';
    sc = 1; tx = 0; ty = 0;
    counter.textContent = (idx + 1) + ' / ' + items.length;
    counter.style.display = items.length > 1 ? '' : 'none';
    btnPrev.style.visibility = idx > 0 ? 'visible' : 'hidden';
    btnNext.style.visibility = idx < items.length - 1 ? 'visible' : 'hidden';
    if (items.length < 2) { btnPrev.style.display = btnNext.style.display = 'none'; }
  }

  const curEl = () => { const s = slides[idx]; return s ? s.querySelector('img,video') : null; };
  function applyZ(anim) {
    const e = curEl(); if (!e) return;
    e.style.transition = anim ? 'transform .25s cubic-bezier(.22,1,.36,1)' : 'none';
    e.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(' + sc + ')';
  }

  // 実際に画面に出ている画像の大きさ(object-fit:contain の中身)
  function shown() {
    const e = curEl();
    if (e && e.tagName === 'IMG' && e.naturalWidth) {
      const f = Math.min(W / e.naturalWidth, H / e.naturalHeight);
      return { w: e.naturalWidth * f, h: e.naturalHeight * f };
    }
    return { w: W, h: H };
  }
  function clampT() {
    const d = shown();
    const mx = Math.max(0, (d.w * sc - W) / 2), my = Math.max(0, (d.h * sc - H) / 2);
    tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty));
  }
  function zoomAt(ns, px, py) {   // (px,py)の下にある点を動かさずに拡大率を変える
    const cx = W / 2, cy = H / 2;
    const qx = (px - cx - tx) / sc, qy = (py - cy - ty) / sc;
    sc = ns; tx = px - cx - sc * qx; ty = py - cy - sc * qy;
  }

  // ---- 移動 ----
  function go(n) {
    if (busy || n < 0 || n >= items.length || n === idx) return;
    busy = true;
    const dir = n > idx ? -1 : 1;
    track.style.transition = 'transform .28s cubic-bezier(.22,1,.36,1)';
    track.style.transform = 'translate3d(' + (dir * W) + 'px,0,0)';
    setTimeout(() => { idx = n; render(); busy = false; }, 290);
  }
  function snapBack() {
    track.style.transition = 'transform .25s cubic-bezier(.22,1,.36,1)';
    track.style.transform = 'translate3d(0,0,0)';
    ov.style.transition = 'opacity .25s ease'; ov.style.opacity = '1';
  }

  // ---- タッチ ----
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  function inVideoControls(e) {
    const v = e.target && e.target.tagName === 'VIDEO' ? e.target : null;
    if (!v) return false;
    const r = v.getBoundingClientRect();
    return e.touches[0].clientY > r.bottom - 90;     // 再生バーの辺りはビデオ側に任せる
  }
  function onStart(e) {
    lastTouchAt = Date.now();
    if (busy || !open) return;
    if (e.target.closest && e.target.closest('.bgal-btn')) { mode = null; return; }
    if (e.touches.length === 2 && curKind() === 'image') {
      const m = mid(e.touches);
      pinch = { d: dist(e.touches), s: sc, qx: (m.x - W / 2 - tx) / sc, qy: (m.y - H / 2 - ty) / sc };
      mode = 'pinch'; return;
    }
    if (e.touches.length === 1) {
      if (inVideoControls(e)) { mode = null; return; }
      const t = e.touches[0];
      t0 = { x: t.clientX, y: t.clientY, t: Date.now(), tx, ty, dx: 0, dy: 0 };
      mode = sc > 1 ? 'pan' : 'pending';
    }
  }
  const mid = t => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  function onMove(e) {
    if (!mode || busy) return;
    if (mode === 'pinch' && e.touches.length === 2) {
      e.preventDefault();
      sc = Math.max(1, Math.min(MAXZ, pinch.s * dist(e.touches) / pinch.d));
      const m = mid(e.touches);
      tx = m.x - W / 2 - sc * pinch.qx; ty = m.y - H / 2 - sc * pinch.qy;
      applyZ(false); return;
    }
    if (e.touches.length !== 1 || !t0) return;
    const t = e.touches[0];
    t0.dx = t.clientX - t0.x; t0.dy = t.clientY - t0.y;
    if (mode === 'pending') {
      if (Math.abs(t0.dx) < 8 && Math.abs(t0.dy) < 8) return;
      mode = Math.abs(t0.dx) > Math.abs(t0.dy) ? 'swipe' : 'dismiss';
    }
    if (mode === 'swipe') {
      e.preventDefault();
      const atEdge = (idx === 0 && t0.dx > 0) || (idx === items.length - 1 && t0.dx < 0);
      const dx = atEdge ? t0.dx / 3 : t0.dx;
      track.style.transition = 'none';
      track.style.transform = 'translate3d(' + dx + 'px,0,0)';
    } else if (mode === 'dismiss') {
      e.preventDefault();
      track.style.transition = 'none';
      track.style.transform = 'translate3d(0,' + t0.dy + 'px,0)';
      ov.style.transition = 'none';
      ov.style.opacity = String(Math.max(0.25, 1 - Math.abs(t0.dy) / 420));
    } else if (mode === 'pan') {
      e.preventDefault();
      tx = t0.tx + t0.dx; ty = t0.ty + t0.dy;
      applyZ(false);
    }
  }
  function onEnd(e) {
    if (e.touches && e.touches.length > 0) {
      if (mode === 'pinch' && e.touches.length === 1) {   // 指が1本残ったらそのまま移動に切り替える
        const t = e.touches[0];
        t0 = { x: t.clientX, y: t.clientY, t: Date.now(), tx, ty, dx: 0, dy: 0 };
        mode = 'pan';
      }
      return;
    }
    const m = mode; mode = null;
    if (m === 'pinch') {
      if (sc < 1.05) { sc = 1; tx = 0; ty = 0; } else clampT();
      applyZ(true); return;
    }
    if (!t0) return;
    const dt = Math.max(1, Date.now() - t0.t), v = Math.abs(t0.dx) / dt, vy = Math.abs(t0.dy) / dt;
    if (m === 'swipe') {
      const next = t0.dx < 0 ? idx + 1 : idx - 1;
      if ((Math.abs(t0.dx) > W * 0.2 || v > 0.5) && next >= 0 && next < items.length) go(next);
      else snapBack();
    } else if (m === 'dismiss') {
      if (Math.abs(t0.dy) > 110 || vy > 0.6) close(true);
      else snapBack();
    } else if (m === 'pan') {
      if (Math.abs(t0.dx) + Math.abs(t0.dy) < 8) tap(t0.x, t0.y); else { clampT(); applyZ(true); }
    } else if (m === 'pending') {
      tap(t0.x, t0.y);
    }
    t0 = null;
  }

  function tap(x, y) {
    const now = Date.now();
    if (lastTap && now - lastTap.t < 280 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
      clearTimeout(tapTimer); lastTap = null;
      if (curKind() !== 'image') return;
      if (sc > 1) { sc = 1; tx = 0; ty = 0; } else { zoomAt(2.6, x, y); clampT(); }
      applyZ(true); return;
    }
    lastTap = { x, y, t: now };
    clearTimeout(tapTimer);
    if (curKind() === 'video') return;     // 動画のタップは再生/停止に任せる
    tapTimer = setTimeout(() => { lastTap = null; toggleUi(); }, 270);
  }
  function toggleUi() { uiOn = !uiOn; ov.classList.toggle('hideui', !uiOn); }

  // ---- マウス/キーボード(PC) ----
  function onWheel(e) {
    if (!open || curKind() !== 'image') return;
    e.preventDefault();
    const ns = Math.max(1, Math.min(MAXZ, sc * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (ns === sc) return;
    zoomAt(ns, e.clientX, e.clientY);
    if (sc < 1.02) { sc = 1; tx = 0; ty = 0; } else clampT();
    applyZ(false);
  }
  function onMouseDown(e) {
    if (e.button !== 0 || sc <= 1 || curKind() !== 'image') return;
    if (e.target.closest && e.target.closest('.bgal-btn')) return;
    drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
    e.preventDefault();
  }
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    tx = drag.tx + dx; ty = drag.ty + dy; clampT(); applyZ(false);
  });
  window.addEventListener('mouseup', () => { if (drag) { const mv = drag.moved; drag = null; if (mv) lastTouchAt = Date.now() - 600; } });
  function onClick(e) {
    if (Date.now() - lastTouchAt < 700) return;          // タッチ操作の後に来るclickは無視
    if (e.target.closest && e.target.closest('.bgal-btn')) return;
    if (e.target.tagName === 'VIDEO') return;
    if (e.target.tagName === 'IMG') {                     // 画像の外側(黒い余白)をクリックした時だけ閉じる
      const d = shown();
      if (Math.abs(e.clientX - W / 2) <= d.w / 2 && Math.abs(e.clientY - H / 2) <= d.h / 2) return;
    }
    if (sc === 1) close();
  }
  document.addEventListener('keydown', e => {
    if (!open) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(idx - 1);
    else if (e.key === 'ArrowRight') go(idx + 1);
  });

  // ---- 保存 ----
  async function download() {
    const el = items[idx]; if (!el) return;
    const src = srcOf(el); if (!src || src.indexOf(PH) === 0) return;
    try {
      if (window.BroMediaSave) {
        const ok = await BroMediaSave.save(src, isVideo(el));
        if (ok && window.LiquidGlass && LiquidGlass.haptic) LiquidGlass.haptic('success');
      } else {
        const a = document.createElement('a');
        a.href = src; a.download = 'brochat_' + Date.now() + (isVideo(el) ? '.mp4' : '.jpg');
        document.body.appendChild(a); a.click(); a.remove();
      }
    } catch (e) { console.error('[gallery] download', e); }
  }

  // ---- 開閉 ----
  function openGallery(el, opts) {
    if (!el || open) return;
    items = collect(el, (opts && opts.selector) || 'img,video');
    idx = Math.max(0, items.indexOf(el));
    if (!ov) build();
    W = window.innerWidth; H = window.innerHeight;
    document.body.appendChild(ov);
    uiOn = true; ov.classList.remove('hideui');
    ov.style.transition = 'none'; ov.style.opacity = '0';
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    busy = false; mode = null; open = true;
    render();
    requestAnimationFrame(() => { ov.style.transition = ''; ov.style.opacity = ''; ov.classList.add('on'); });
    try { history.pushState({ bgal: 1 }, ''); pushed = true; } catch (e) { pushed = false; }
  }

  function close(fromDrag) {
    if (!open) return;
    open = false;
    if (pushed) { pushed = false; try { if (history.state && history.state.bgal) history.back(); } catch (e) {} }
    ov.style.transition = 'opacity .2s ease';
    ov.style.opacity = '0'; ov.classList.remove('on');
    document.body.style.overflow = prevOverflow;
    setTimeout(() => {
      if (open) return;
      Object.keys(slides).forEach(k => { const v = slides[k].querySelector('video'); if (v) { try { v.pause(); } catch (e) {} } });
      slides = {}; track.innerHTML = ''; ov.remove(); items = [];
    }, 220);
  }

  // 端末の戻るボタン: ビューアが開いていたら閉じるだけ(トークからは出ない)
  window.addEventListener('popstate', () => { if (open) { pushed = false; close(); } });
  window.addEventListener('resize', () => { if (open) { W = window.innerWidth; H = window.innerHeight; } });

  window.BroGallery = { open: openGallery, close };
})();
