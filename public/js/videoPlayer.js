// videoPlayer.js — 投稿の動画プレーヤー(標準の操作バーの代わり)。
// ・画面の左右をダブルタップで10秒戻す/進む  ・長押しの間だけ2倍速  ・再生速度(0.5〜2倍)
// ・シークバー(ドラッグ、読み込み済みの範囲を表示)  ・ピクチャ・イン・ピクチャ  ・ループ  ・全画面
// ・続きから再生(この端末だけに記録)  ・読み込み中のくるくる  ・失敗した時に「もう一度」
// ・PCでは キーボード(スペース/K 再生、←→ 5秒、J/L 10秒、M ミュート、F 全画面)
// 使い方: BroPlayer.attach(containerEl, videoEl, { id: 投稿ID, autoplay: true }) → { destroy() }
(function () {
  if (window.BroPlayer) return;
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const POS_PREFIX = 'vpos_';
  const POS_KEEP = 60; // 覚えておく動画の数
  const ic = {
    play: '<svg viewBox="0 0 24 24"><polygon points="7 4 20 12 7 20 7 4" fill="currentColor" stroke="none"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    fullExit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
    pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><rect x="12" y="11" width="8" height="5" rx="1" fill="currentColor" stroke="none"/></svg>',
    loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/></svg>',
    fwd10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/></svg>',
  };

  function css() {
    if (document.getElementById('bpCss')) return;
    const st = document.createElement('style'); st.id = 'bpCss';
    st.textContent = `
.bp{position:absolute;inset:0;z-index:3;color:#fff;user-select:none;-webkit-user-select:none;touch-action:manipulation;font-family:inherit}
.bp svg{width:22px;height:22px;display:block}
.bp .bp-shade{position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,.45),transparent 28%,transparent 55%,rgba(0,0,0,.6));opacity:0;transition:opacity .2s;pointer-events:none}
.bp.show .bp-shade{opacity:1}
.bp .bp-center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:64px;height:64px;border-radius:50%;background:rgba(0,0,0,.5);border:0;color:#fff;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s;pointer-events:none;cursor:pointer}
.bp .bp-center svg{width:30px;height:30px}
.bp.show .bp-center{opacity:1;pointer-events:auto}
.bp.busy .bp-center{opacity:0;pointer-events:none}
.bp .bp-spin{position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px 0 0 -20px;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:bpSpin .8s linear infinite;display:none}
.bp.busy .bp-spin{display:block}
@keyframes bpSpin{to{transform:rotate(360deg)}}
.bp .bp-bar{position:absolute;left:0;right:0;bottom:0;padding:0 10px 6px;opacity:0;transition:opacity .2s;pointer-events:none}
.bp.show .bp-bar{opacity:1;pointer-events:auto}
.bp .bp-seek{position:relative;height:26px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.bp .bp-track{position:relative;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.28);transition:height .12s}
.bp .bp-seek:hover .bp-track,.bp.drag .bp-track{height:6px}
.bp .bp-buf{position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:rgba(255,255,255,.35);width:0}
.bp .bp-pos{position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:#ff2d55;width:0}
.bp .bp-knob{position:absolute;top:50%;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;background:#ff2d55;left:0;transform:scale(0);transition:transform .12s}
.bp.show .bp-knob,.bp.drag .bp-knob{transform:scale(1)}
.bp .bp-row{display:flex;align-items:center;gap:2px}
.bp .bp-b{width:38px;height:36px;border:0;background:none;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:8px;flex:none}
.bp .bp-b.on{color:#ff2d55}
.bp .bp-b:active{background:rgba(255,255,255,.18)}
.bp .bp-time{font-size:12px;font-variant-numeric:tabular-nums;opacity:.95;margin:0 6px;white-space:nowrap}
.bp .bp-sp{flex:1}
.bp .bp-speed{min-width:44px;font-size:13px;font-weight:700;width:auto;padding:0 8px}
.bp .bp-menu{position:absolute;right:10px;bottom:52px;background:rgba(24,24,27,.95);border-radius:12px;padding:6px;display:none;flex-direction:column;min-width:96px;z-index:4}
.bp .bp-menu.on{display:flex}
.bp .bp-menu button{border:0;background:none;color:#fff;text-align:left;padding:9px 12px;font:inherit;font-size:14px;border-radius:8px;cursor:pointer}
.bp .bp-menu button.on{color:#ff2d55;font-weight:700}
.bp .bp-ff{position:absolute;top:0;bottom:0;width:36%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px;font-size:13px;font-weight:700;opacity:0;pointer-events:none;background:radial-gradient(closest-side,rgba(255,255,255,.22),transparent)}
.bp .bp-ff.l{left:0}.bp .bp-ff.r{right:0}
.bp .bp-ff.go{animation:bpFf .55s ease-out}
@keyframes bpFf{0%{opacity:0}20%{opacity:1}100%{opacity:0}}
.bp .bp-2x{position:absolute;top:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.6);border-radius:14px;padding:4px 12px;font-size:13px;font-weight:700;display:none}
.bp.fast .bp-2x{display:block}
.bp .bp-err{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.82);font-size:14px;text-align:center;padding:0 24px}
.bp.err .bp-err{display:flex}
.bp.err .bp-center,.bp.err .bp-spin{display:none}
.bp .bp-err button{border:0;border-radius:18px;padding:8px 20px;background:#fff;color:#111;font:inherit;font-weight:700;cursor:pointer}
.bp:fullscreen,.bp-fs{background:#000}
`;
    document.head.appendChild(st);
  }

  const fmt = t => {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };
  const T = (k, fb) => (window.i18n && i18n.t ? i18n.t(k, fb) : fb);

  // 続きから再生: 動画IDごとの位置を、最近のもの60本まで覚える
  const posStore = {
    get(id) { try { const o = JSON.parse(localStorage.getItem(POS_PREFIX + id) || 'null'); return o && typeof o.t === 'number' ? o.t : 0; } catch (_) { return 0; } },
    set(id, t) {
      try {
        localStorage.setItem(POS_PREFIX + id, JSON.stringify({ t: Math.floor(t), at: Date.now() }));
        const keys = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(POS_PREFIX)) keys.push(k); }
        if (keys.length > POS_KEEP) {
          keys.map(k => { let at = 0; try { at = JSON.parse(localStorage.getItem(k)).at || 0; } catch (_) {} return [k, at]; })
            .sort((a, b) => a[1] - b[1]).slice(0, keys.length - POS_KEEP).forEach(([k]) => localStorage.removeItem(k));
        }
      } catch (_) {}
    },
    del(id) { try { localStorage.removeItem(POS_PREFIX + id); } catch (_) {} },
  };

  function attach(box, video, opts) {
    opts = opts || {};
    css();
    const id = opts.id ? String(opts.id) : '';
    video.controls = false;
    video.removeAttribute('controls');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    try { video.disableRemotePlayback = false; } catch (_) {}

    const root = document.createElement('div'); root.className = 'bp show';
    root.innerHTML = `
      <div class="bp-shade"></div>
      <div class="bp-ff l">${ic.back10}<span>-10</span></div><div class="bp-ff r">${ic.fwd10}<span>+10</span></div>
      <div class="bp-2x">2x</div>
      <div class="bp-spin"></div>
      <button type="button" class="bp-center" aria-label="再生/一時停止"></button>
      <div class="bp-bar">
        <div class="bp-seek" role="slider" aria-label="シーク" tabindex="0"><div class="bp-track"><div class="bp-buf"></div><div class="bp-pos"></div><div class="bp-knob"></div></div></div>
        <div class="bp-row">
          <button type="button" class="bp-b bp-pp" aria-label="再生/一時停止"></button>
          <button type="button" class="bp-b bp-mute" aria-label="ミュート"></button>
          <span class="bp-time">0:00 / 0:00</span>
          <span class="bp-sp"></span>
          <button type="button" class="bp-b bp-loop" aria-label="ループ">${ic.loop}</button>
          <button type="button" class="bp-b bp-speed" aria-label="再生速度">1x</button>
          <button type="button" class="bp-b bp-pip" aria-label="ピクチャ・イン・ピクチャ">${ic.pip}</button>
          <button type="button" class="bp-b bp-fs" aria-label="全画面">${ic.full}</button>
        </div>
      </div>
      <div class="bp-menu"></div>
      <div class="bp-err"><span></span><button type="button"></button></div>`;
    box.appendChild(root);
    const $ = s => root.querySelector(s);
    const center = $('.bp-center'), pp = $('.bp-pp'), mute = $('.bp-mute'), time = $('.bp-time');
    const seek = $('.bp-seek'), buf = $('.bp-buf'), pos = $('.bp-pos'), knob = $('.bp-knob');
    const speedBtn = $('.bp-speed'), pipBtn = $('.bp-pip'), fsBtn = $('.bp-fs'), loopBtn = $('.bp-loop'), menu = $('.bp-menu');
    $('.bp-err span').textContent = T('vp_error', '動画を再生できませんでした');
    $('.bp-err button').textContent = T('vp_retry', 'もう一度');

    let hideT = null, dragging = false, destroyed = false, lastSave = 0, fastOn = false, prevRate = 1;
    const canPip = !!(document.pictureInPictureEnabled && video.requestPictureInPicture) || !!video.webkitSupportsPresentationMode;
    if (!canPip) pipBtn.style.display = 'none';

    function paint() {
      const playing = !video.paused && !video.ended;
      pp.innerHTML = center.innerHTML = playing ? ic.pause : ic.play;
      mute.innerHTML = (video.muted || video.volume === 0) ? ic.mute : ic.vol;
      const d = video.duration, t = video.currentTime;
      time.textContent = fmt(t) + ' / ' + fmt(d);
      if (!dragging && isFinite(d) && d > 0) { const p = Math.min(100, t / d * 100); pos.style.width = p + '%'; knob.style.left = p + '%'; }
      seek.setAttribute('aria-valuenow', String(Math.floor(t)));
    }
    function paintBuf() {
      try {
        const d = video.duration; if (!isFinite(d) || !d) return;
        const b = video.buffered; let end = 0;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.5) end = Math.max(end, b.end(i));
        buf.style.width = Math.min(100, end / d * 100) + '%';
      } catch (_) {}
    }
    function show(sticky) {
      root.classList.add('show');
      clearTimeout(hideT);
      if (!sticky && !video.paused && !dragging && !menu.classList.contains('on')) hideT = setTimeout(() => root.classList.remove('show'), 3000);
    }
    function toggle() { if (video.paused || video.ended) video.play().catch(() => {}); else video.pause(); }
    function skip(sec) {
      const d = video.duration || Infinity;
      video.currentTime = Math.max(0, Math.min(d - 0.1, video.currentTime + sec));
      const el = $(sec < 0 ? '.bp-ff.l' : '.bp-ff.r'); el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
      paint(); show();
    }
    function setRate(r) {
      video.playbackRate = r; speedBtn.textContent = (r === 1 ? '1' : String(r)) + 'x';
      menu.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.r) === r));
    }
    SPEEDS.forEach(r => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.r = r; b.textContent = r + 'x';
      b.addEventListener('click', e => { e.stopPropagation(); setRate(r); prevRate = r; menu.classList.remove('on'); show(); });
      menu.appendChild(b);
    });
    setRate(1);

    // --- 画面のタップ: 1回=操作バーの出し入れ、左右ダブル=10秒、長押し=2倍速 ---
    let lastTap = 0, lastX = 0, tapTimer = null, pressT = null, downAt = 0, moved = false, sx = 0, sy = 0;
    root.addEventListener('pointerdown', e => {
      if (e.target.closest('.bp-bar,.bp-menu,.bp-center,.bp-err')) return;
      downAt = Date.now(); moved = false; sx = e.clientX; sy = e.clientY;
      clearTimeout(pressT);
      pressT = setTimeout(() => { // 長押しの間だけ2倍速
        if (!video.paused) { fastOn = true; prevRate = video.playbackRate; video.playbackRate = 2; root.classList.add('fast'); }
      }, 450);
    });
    root.addEventListener('pointermove', e => { if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) { moved = true; clearTimeout(pressT); } });
    const endPress = () => { clearTimeout(pressT); if (fastOn) { fastOn = false; video.playbackRate = prevRate; root.classList.remove('fast'); } };
    root.addEventListener('pointercancel', endPress);
    root.addEventListener('pointerup', e => {
      if (e.target.closest('.bp-bar,.bp-menu,.bp-center,.bp-err')) return;
      const wasFast = fastOn; endPress();
      if (wasFast || moved) return;
      const now = Date.now(), rect = root.getBoundingClientRect(), x = e.clientX - rect.left;
      if (menu.classList.contains('on')) { menu.classList.remove('on'); return; }
      if (now - lastTap < 300 && Math.abs(x - lastX) < 80) {
        clearTimeout(tapTimer); lastTap = 0;
        const third = rect.width / 3;
        if (x < third) skip(-10); else if (x > rect.width - third) skip(10); else toggle();
        return;
      }
      lastTap = now; lastX = x;
      tapTimer = setTimeout(() => { // ダブルタップでなければ、バーの出し入れ
        if (root.classList.contains('show') && !video.paused) root.classList.remove('show'); else show();
      }, 300);
    });

    center.addEventListener('click', e => { e.stopPropagation(); toggle(); show(); });
    pp.addEventListener('click', e => { e.stopPropagation(); toggle(); show(); });
    mute.addEventListener('click', e => { e.stopPropagation(); video.muted = !video.muted; paint(); show(); });
    loopBtn.addEventListener('click', e => { e.stopPropagation(); video.loop = !video.loop; loopBtn.classList.toggle('on', video.loop); show(); });
    speedBtn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('on'); show(true); });
    pipBtn.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else if (video.requestPictureInPicture) await video.requestPictureInPicture();
        else if (video.webkitSetPresentationMode) video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      } catch (_) {}
    });
    function isFs() { return document.fullscreenElement === box || document.webkitFullscreenElement === box || !!video.webkitDisplayingFullscreen; }
    fsBtn.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        if (isFs()) { (document.exitFullscreen || document.webkitExitFullscreen || (() => video.webkitExitFullscreen && video.webkitExitFullscreen())).call(document); }
        else if (box.requestFullscreen) await box.requestFullscreen();
        else if (box.webkitRequestFullscreen) box.webkitRequestFullscreen();
        else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
      } catch (_) {}
    });
    const onFsChange = () => { fsBtn.innerHTML = isFs() ? ic.fullExit : ic.full; box.classList.toggle('bp-fs', isFs()); };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    fsBtn.innerHTML = ic.full;

    // --- シークバー(ドラッグ) ---
    function seekTo(clientX, commit) {
      const r = seek.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      pos.style.width = p * 100 + '%'; knob.style.left = p * 100 + '%';
      const d = video.duration;
      if (isFinite(d)) { time.textContent = fmt(p * d) + ' / ' + fmt(d); if (commit) video.currentTime = p * d; }
    }
    seek.addEventListener('pointerdown', e => {
      e.stopPropagation(); dragging = true; root.classList.add('drag'); show(true);
      try { seek.setPointerCapture(e.pointerId); } catch (_) {}
      seekTo(e.clientX, false);
    });
    seek.addEventListener('pointermove', e => { if (dragging) seekTo(e.clientX, false); });
    const endDrag = e => { if (!dragging) return; dragging = false; root.classList.remove('drag'); seekTo(e.clientX, true); show(); };
    seek.addEventListener('pointerup', endDrag);
    seek.addEventListener('pointercancel', () => { dragging = false; root.classList.remove('drag'); paint(); });
    seek.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') { e.preventDefault(); skip(-5); } else if (e.key === 'ArrowRight') { e.preventDefault(); skip(5); } });

    // --- 動画の状態 ---
    const on = (ev, fn) => video.addEventListener(ev, fn);
    on('timeupdate', () => {
      paint();
      const now = Date.now();
      if (id && now - lastSave > 5000 && video.currentTime > 3) { lastSave = now; posStore.set(id, video.currentTime); }
    });
    on('progress', paintBuf); on('loadedmetadata', () => { paint(); paintBuf(); });
    on('play', () => { paint(); show(); }); on('playing', () => { root.classList.remove('busy', 'err'); paint(); show(); });
    on('pause', () => { paint(); show(true); if (id && video.currentTime > 3 && !video.ended) posStore.set(id, video.currentTime); });
    on('ended', () => { if (id) posStore.del(id); paint(); show(true); });
    on('waiting', () => root.classList.add('busy')); on('canplay', () => root.classList.remove('busy'));
    on('seeking', () => root.classList.add('busy')); on('seeked', () => root.classList.remove('busy'));
    on('volumechange', paint);
    on('error', () => { root.classList.remove('busy'); root.classList.add('err'); });
    $('.bp-err button').addEventListener('click', e => { e.stopPropagation(); root.classList.remove('err'); const t = video.currentTime; video.load(); video.currentTime = t; video.play().catch(() => {}); });
    // 他のアプリに移っても、位置を残す
    const onHide = () => { if (id && video.currentTime > 3 && !video.ended) posStore.set(id, video.currentTime); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);

    // 続きから再生(最初の5秒以内と、終わり際5秒は最初から)
    if (id) {
      const t0 = posStore.get(id);
      const resume = () => { const d = video.duration; if (t0 > 5 && isFinite(d) && t0 < d - 5) { try { video.currentTime = t0; } catch (_) {} } };
      if (video.readyState >= 1) resume(); else video.addEventListener('loadedmetadata', resume, { once: true });
    }

    // PCのキーボード(入力欄にいる時は何もしない)
    const onKey = e => {
      if (destroyed || !box.isConnected) return;
      const tg = e.target; if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
      const k = e.key;
      if (k === ' ' || k === 'k' || k === 'K') { e.preventDefault(); toggle(); show(); }
      else if (k === 'ArrowLeft') { e.preventDefault(); skip(-5); }
      else if (k === 'ArrowRight') { e.preventDefault(); skip(5); }
      else if (k === 'j' || k === 'J') skip(-10);
      else if (k === 'l' || k === 'L') skip(10);
      else if (k === 'm' || k === 'M') { video.muted = !video.muted; paint(); }
      else if (k === 'f' || k === 'F') fsBtn.click();
    };
    document.addEventListener('keydown', onKey);
    box.addEventListener('mousemove', () => show());

    paint();
    if (!video.paused) show();
    return {
      destroy() {
        destroyed = true; clearTimeout(hideT); clearTimeout(pressT); clearTimeout(tapTimer);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('fullscreenchange', onFsChange);
        document.removeEventListener('webkitfullscreenchange', onFsChange);
        window.removeEventListener('pagehide', onHide);
        document.removeEventListener('visibilitychange', onHide);
        if (id && video.currentTime > 3 && !video.ended) posStore.set(id, video.currentTime);
        try { if (document.fullscreenElement === box) document.exitFullscreen(); } catch (_) {}
        try { if (document.pictureInPictureElement === video) document.exitPictureInPicture(); } catch (_) {}
        root.remove();
      },
    };
  }

  window.BroPlayer = { attach, _fmt: fmt };
})();
