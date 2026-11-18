// chatMedia.js
// トークの「写真・動画 / リンク / ファイル」一覧。画面いっぱいのオーバーレイ(下からバネで上がる)に3つのタブ。
//   写真・動画: 3列の正方形サムネ(画面に入ってから読み込む = IntersectionObserver)
//   リンク:     http(s) の URL だけ(それ以外は捨てる)。別タブで開く(rel=noopener)
//   ファイル:   ファイル名の一覧。タップで onOpen
//
// 使い方(admin.html / groupchat.html 共通):
//   BroChatMedia.open({
//     getItems: () => [{ id, kind: 'image'|'video'|'link'|'file', src, url, title, time, poster, sub, bh }],
//        // src: サムネに使える URL(復号済みの blob: など)。まだ復号してなければ省略 → ぼかし/アイコンの枠だけ出る
//        // poster: 動画の静止画があれば(無ければ src を <video> で1コマ出す)
//        // bh: {blurhash,w,h}(復号済みメタデータから。あれば枠にぼかしを描く)
//        // url: link の URL / sub: file の補足(サイズなど)
//     onOpen: (item, el) => openGalleryOrJump(item.id),  // 写真・動画・ファイル: タップで呼ばれる(閉じない。ギャラリーを重ねる想定)
//     title: 'メディア'                                    // 省略可
//   });
//   リンク行は本体をタップすると URL を別タブで開き、右端の矢印ボタンで onOpen(トークの該当位置へ)を呼ぶ。
//   戻り値 { close(), refresh() }。 refresh() は getItems を取り直して描き直す(復号が進んだ後など)。
(function () {
  if (window.BroChatMedia) return;

  const tr = (k, fb) => { try { return (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb; } catch (e) { return fb; } };
  const reduced = () => document.documentElement.classList.contains('reduce-motion') ||
    (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const NS = 'http://www.w3.org/2000/svg';

  function icon(name, size) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', size || 20); s.setAttribute('height', size || 20); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    const add = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); s.appendChild(e); };
    if (name === 'play') { s.setAttribute('fill', 'currentColor'); s.setAttribute('stroke', 'none'); add('polygon', { points: '8 5 19 12 8 19 8 5' }); }
    else if (name === 'file') { add('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }); add('polyline', { points: '14 2 14 8 20 8' }); }
    else if (name === 'link') { add('path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }); add('path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }); }
    else if (name === 'jump') { add('polyline', { points: '9 18 15 12 9 6' }); }
    else if (name === 'img') { add('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }); add('circle', { cx: 8.5, cy: 8.5, r: 1.5 }); add('polyline', { points: '21 15 16 10 5 21' }); }
    return s;
  }

  function css() {
    if (document.getElementById('bro-cm-css')) return;
    const s = document.createElement('style');
    s.id = 'bro-cm-css';
    s.textContent =
      '.bcm{--bg:#fff;--fg:#0f172a;--sub:#64748b;--line:rgba(15,23,42,.1);--fld:#eef1f5;--ph:#e2e8f0;position:fixed;inset:0;z-index:20500;background:var(--bg);color:var(--fg);display:flex;flex-direction:column;opacity:0;transform:translate3d(0,40px,0);will-change:transform,opacity;font-family:inherit;-webkit-tap-highlight-color:transparent;overscroll-behavior:contain}' +
      'html.dark-mode .bcm{--bg:#0f172a;--fg:#e2e8f0;--sub:#94a3b8;--line:rgba(255,255,255,.1);--fld:#1e293b;--ph:#1e293b}' +
      '.bcm.on{opacity:1;transform:none;transition:transform .5s cubic-bezier(.2,1.1,.3,1),opacity .2s ease}' +
      '.bcm.out{opacity:0;transform:translate3d(0,40px,0);transition:transform .22s ease-in,opacity .2s ease}' +
      'html.reduce-motion .bcm.on,html.reduce-motion .bcm.out{transition:opacity .01s}' +
      '@media (prefers-reduced-motion:reduce){.bcm.on,.bcm.out{transition:opacity .01s}}' +
      '.bcm-top{display:flex;align-items:center;justify-content:space-between;padding:calc(6px + env(safe-area-inset-top,0px)) 8px 6px 16px;min-height:52px}' +
      '.bcm-ttl{font-size:17px;font-weight:700}' +
      '.bcm-x{min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:#007aff;font:inherit;font-size:15px;font-weight:600;cursor:pointer;padding:0 8px}' +
      '.bcm-tabs{display:flex;gap:4px;margin:0 12px 8px;padding:3px;border-radius:12px;background:var(--fld)}' +
      '.bcm-tab{flex:1;min-height:44px;border:0;border-radius:10px;background:transparent;color:var(--sub);font:inherit;font-size:14px;font-weight:600;cursor:pointer}' +
      '.bcm-tab[aria-selected="true"]{background:var(--bg);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.15)}' +
      '.bcm-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}' +
      '.bcm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}' +
      '.bcm-th{position:relative;aspect-ratio:1/1;padding:0;border:0;background:var(--ph);overflow:hidden;cursor:pointer;display:block;content-visibility:auto;contain-intrinsic-size:auto 120px}' +
      '.bcm-th img,.bcm-th video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;opacity:0}' +
      '.bcm-th img.ld,.bcm-th video.ld{opacity:1;transition:opacity .2s ease}' +
      '.bcm-th .bcm-ic{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--sub);opacity:.6}' +
      '.bcm-th .bcm-pl{position:absolute;right:6px;bottom:6px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;display:flex;align-items:center;justify-content:center}' +
      '.bcm-row{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);min-height:56px}' +
      '.bcm-main{flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:10px 4px 10px 16px;min-height:44px;color:inherit;text-decoration:none;background:transparent;border:0;font:inherit;text-align:left;cursor:pointer}' +
      '.bcm-main:active{background:var(--fld)}' +
      '.bcm-ri{flex:none;width:40px;height:40px;border-radius:10px;background:var(--fld);color:var(--sub);display:flex;align-items:center;justify-content:center}' +
      '.bcm-tx{min-width:0;flex:1}' +
      '.bcm-t1{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.bcm-t2{font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}' +
      '.bcm-go{flex:none;min-width:44px;min-height:44px;margin-right:4px;border:0;background:transparent;color:var(--sub);display:flex;align-items:center;justify-content:center;cursor:pointer}' +
      '.bcm-empty{padding:56px 24px;text-align:center;color:var(--sub);font-size:14px;line-height:1.6}';
    document.head.appendChild(s);
  }

  // http(s) だけ通す。javascript: / data: / blob: などは捨てる
  function safeUrl(u) {
    try {
      const x = new URL(String(u), 'http://invalid.invalid/');
      if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
      if (x.hostname === 'invalid.invalid') return null;   // 相対パスは対象外
      return x.href;
    } catch (e) { return null; }
  }

  function fmtDate(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    const d = new Date(t);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  let cur = null;

  function open(opts) {
    opts = opts || {};
    if (cur) cur.close(true);
    css();
    const prevFocus = document.activeElement;

    const ov = document.createElement('div');
    ov.className = 'bcm';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    const title = opts.title || tr('bro_media_title', 'メディア');
    ov.setAttribute('aria-label', title);

    const top = document.createElement('div'); top.className = 'bcm-top';
    const ttl = document.createElement('div'); ttl.className = 'bcm-ttl'; ttl.textContent = title;
    const xb = document.createElement('button'); xb.type = 'button'; xb.className = 'bcm-x'; xb.textContent = tr('bro_close', '閉じる');
    top.appendChild(ttl); top.appendChild(xb);

    const TABS = [
      ['media', tr('bro_media_tab_media', '写真・動画')],
      ['link', tr('bro_media_tab_link', 'リンク')],
      ['file', tr('bro_media_tab_file', 'ファイル')],
    ];
    const tabs = document.createElement('div'); tabs.className = 'bcm-tabs'; tabs.setAttribute('role', 'tablist');
    const tabEls = {};
    for (const [k, label] of TABS) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'bcm-tab'; b.setAttribute('role', 'tab');
      b.textContent = label; b.dataset.tab = k;
      b.addEventListener('click', () => select(k));
      tabs.appendChild(b); tabEls[k] = b;
    }
    const body = document.createElement('div'); body.className = 'bcm-body'; body.setAttribute('role', 'tabpanel');
    ov.appendChild(top); ov.appendChild(tabs); ov.appendChild(body);

    let data = { media: [], link: [], file: [] };
    let tab = 'media', closed = false, io = null;

    function load() {
      let raw = [];
      try { raw = (opts.getItems && opts.getItems()) || []; } catch (e) { raw = []; }
      const d = { media: [], link: [], file: [] };
      for (const it of raw) {
        if (!it) continue;
        if (it.kind === 'image' || it.kind === 'video') d.media.push(it);
        else if (it.kind === 'link') { const u = safeUrl(it.url); if (u) d.link.push({ it, u }); }
        else if (it.kind === 'file') d.file.push(it);
      }
      const ts = x => { const t = Date.parse((x.it || x).time); return isFinite(t) ? t : 0; };
      for (const k in d) d[k] = d[k].map((v, i) => [v, i]).sort((a, b) => (ts(b[0]) - ts(a[0])) || (b[1] - a[1])).map(p => p[0]);
      data = d;
      TABS.forEach(([k, label]) => { tabEls[k].textContent = label + (d[k].length ? ' ' + d[k].length : ''); });
    }

    function observer() {
      if (io) io.disconnect();
      io = null;
      if (typeof IntersectionObserver !== 'function') return null;
      io = new IntersectionObserver(es => {
        for (const e of es) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          fillThumb(e.target);
        }
      }, { root: body, rootMargin: '300px 0px' });
      return io;
    }

    function fillThumb(btn) {
      const it = btn._it;
      if (!it || btn._filled) return;
      btn._filled = true;
      const poster = it.poster && String(it.poster);
      let el = null;
      if (it.kind === 'image' && it.src) { el = document.createElement('img'); el.src = it.src; el.alt = ''; el.decoding = 'async'; }
      else if (it.kind === 'video' && poster) { el = document.createElement('img'); el.src = poster; el.alt = ''; el.decoding = 'async'; }
      else if (it.kind === 'video' && it.src) {
        el = document.createElement('video'); el.muted = true; el.playsInline = true; el.preload = 'metadata';
        el.setAttribute('playsinline', ''); el.src = it.src + (String(it.src).indexOf('#') < 0 ? '#t=0.1' : '');
      }
      if (!el) return;       // まだ復号されていない: アイコンの枠のまま
      const done = () => { el.classList.add('ld'); const ic = btn.querySelector('.bcm-ic'); if (ic) ic.remove(); };
      if (el.tagName === 'VIDEO') el.addEventListener('loadeddata', done, { once: true }); else el.addEventListener('load', done, { once: true });
      el.addEventListener('error', () => el.remove(), { once: true });
      btn.insertBefore(el, btn.firstChild);
    }

    function empty(text) {
      const d = document.createElement('div'); d.className = 'bcm-empty'; d.textContent = text;
      body.appendChild(d);
    }

    function openItem(it, el) { try { opts.onOpen && opts.onOpen(it, el); } catch (e) { console.error('[chatMedia] onOpen', e); } }

    function render() {
      body.textContent = '';
      body.scrollTop = 0;
      const o = observer();
      for (const k in tabEls) tabEls[k].setAttribute('aria-selected', k === tab ? 'true' : 'false');
      const list = data[tab];
      if (!list.length) {
        empty(tab === 'media' ? tr('bro_media_none_media', '写真・動画はまだありません') : tab === 'link' ? tr('bro_media_none_link', 'リンクはまだありません') : tr('bro_media_none_file', 'ファイルはまだありません'));
        return;
      }
      const frag = document.createDocumentFragment();
      if (tab === 'media') {
        const grid = document.createElement('div'); grid.className = 'bcm-grid';
        for (const it of list) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'bcm-th';
          b.setAttribute('aria-label', it.kind === 'video' ? tr('bro_media_video', '動画') : tr('bro_media_photo', '写真'));
          b._it = it;
          if (it.bh && window.BroBlurhash) { try { window.BroBlurhash.paint(b, it.bh); b.style.aspectRatio = '1 / 1'; b.style.backgroundSize = 'cover'; } catch (e) {} }
          const ic = document.createElement('span'); ic.className = 'bcm-ic'; ic.appendChild(icon('img', 26)); b.appendChild(ic);
          if (it.kind === 'video') { const pl = document.createElement('span'); pl.className = 'bcm-pl'; pl.appendChild(icon('play', 12)); b.appendChild(pl); }
          b.addEventListener('click', () => openItem(it, b));
          grid.appendChild(b);
          if (o) o.observe(b); else fillThumb(b);
        }
        frag.appendChild(grid);
      } else if (tab === 'link') {
        for (const { it, u } of list) {
          const row = document.createElement('div'); row.className = 'bcm-row';
          const a = document.createElement('a'); a.className = 'bcm-main';
          a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer';
          const ri = document.createElement('span'); ri.className = 'bcm-ri'; ri.appendChild(icon('link', 20));
          const tx = document.createElement('span'); tx.className = 'bcm-tx';
          const t1 = document.createElement('div'); t1.className = 'bcm-t1';
          let host = ''; try { host = new URL(u).hostname; } catch (e) {}
          t1.textContent = it.title ? String(it.title) : host;
          const t2 = document.createElement('div'); t2.className = 'bcm-t2';
          t2.textContent = u.replace(/^https?:\/\//, '') + (it.time ? '  ' + fmtDate(it.time) : '');
          tx.appendChild(t1); tx.appendChild(t2); a.appendChild(ri); a.appendChild(tx);
          const go = document.createElement('button'); go.type = 'button'; go.className = 'bcm-go';
          go.setAttribute('aria-label', tr('bro_media_goto', 'トークで見る')); go.appendChild(icon('jump', 20));
          go.addEventListener('click', () => openItem(it, go));
          row.appendChild(a); row.appendChild(go); frag.appendChild(row);
        }
      } else {
        for (const it of list) {
          const row = document.createElement('div'); row.className = 'bcm-row';
          const m = document.createElement('button'); m.type = 'button'; m.className = 'bcm-main';
          const ri = document.createElement('span'); ri.className = 'bcm-ri'; ri.appendChild(icon('file', 20));
          const tx = document.createElement('span'); tx.className = 'bcm-tx';
          const t1 = document.createElement('div'); t1.className = 'bcm-t1'; t1.textContent = it.title ? String(it.title) : tr('bro_media_file', 'ファイル');
          const t2 = document.createElement('div'); t2.className = 'bcm-t2'; t2.textContent = [it.sub, fmtDate(it.time)].filter(Boolean).join('  ');
          tx.appendChild(t1); tx.appendChild(t2); m.appendChild(ri); m.appendChild(tx);
          m.addEventListener('click', () => openItem(it, m));
          row.appendChild(m); frag.appendChild(row);
        }
      }
      body.appendChild(frag);
    }

    function select(k) { if (k === tab && body.firstChild) return; tab = k; render(); }
    function refresh() { if (closed) return; const st = body.scrollTop; load(); render(); body.scrollTop = st; }

    xb.addEventListener('click', () => close());
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);

    function close(instant) {
      if (closed) return;
      closed = true;
      if (io) io.disconnect();
      document.removeEventListener('keydown', onKey, true);
      if (cur && cur.ov === ov) cur = null;
      const done = () => { ov.remove(); try { if (prevFocus && prevFocus.focus && !instant) prevFocus.focus({ preventScroll: true }); } catch (e) {} };
      if (instant || reduced()) { done(); return; }
      ov.classList.remove('on'); ov.classList.add('out');
      let fin = false;
      const f = () => { if (fin) return; fin = true; done(); };
      ov.addEventListener('transitionend', e => { if (e.target === ov && e.propertyName === 'transform') f(); });
      setTimeout(f, 400);
    }

    load();
    // 写真が無くてリンクかファイルだけある時は、最初からそのタブを出す
    if (!data.media.length) tab = data.link.length ? 'link' : (data.file.length ? 'file' : 'media');
    render();
    document.body.appendChild(ov);
    void ov.offsetWidth;
    ov.classList.add('on');
    cur = { ov, close };
    return { close, refresh, _select: select };
  }

  window.BroChatMedia = { open, _safeUrl: safeUrl };
})();
