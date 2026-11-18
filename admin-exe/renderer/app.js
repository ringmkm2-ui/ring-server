'use strict';
/* 接続・画面切り替え・自動更新・キーボード */
(function () {
  const { h, icon, fmt, toast, clear } = BC;
  const $ = id => document.getElementById(id);
  const POLL_MS = 15000, STALE_MS = 20000;

  let active = null, ticking = false, lastTick = 0, pollTimer = null;
  let connectToken = 0, wakeTimer = null;
  const navBtns = {}, lastLoad = {};
  const down = { on: false, probing: false, next: 0, probeStart: 0, tmr: null };

  /* ---------- 画面の組み立て ---------- */
  function buildShell() {
    const nav = $('nav'), host = $('views');
    BC.viewOrder.forEach(id => {
      const v = BC.views[id];
      const badge = v.badge ? h('span', { class: 'badge', id: 'repBadge', hidden: true }) : null;
      const b = h('button', { class: 'nav-item', type: 'button', title: v.label, 'data-view': id, onclick: () => BC.go(id) },
        icon(v.icon, 18), h('span', { class: 'nav-label' }, v.label), badge);
      navBtns[id] = b; nav.appendChild(b);
      v.host = h('section', { class: 'view-host', hidden: true, 'aria-label': v.label }, v.el);
      host.appendChild(v.host);
    });
  }

  BC.go = (id, opts) => {
    let v = BC.views[id];
    if (!v || (v.v2only && !BC.S.v2)) { id = 'dashboard'; v = BC.views[id]; }
    if (active && active !== v && active.host) active.host.hidden = true;
    active = v; v.host.hidden = false;
    Object.keys(navBtns).forEach(k => { if (k === id) navBtns[k].setAttribute('aria-current', 'page'); else navBtns[k].removeAttribute('aria-current'); });
    $('viewTitle').textContent = v.label;
    v.activate(opts);
    const stale = Date.now() - (lastLoad[id] || 0) > STALE_MS;
    if (stale && lastLoad[id] && v.id !== 'dashboard') v.refresh(true);
    lastLoad[id] = Date.now();
  };

  /* ---------- stats ---------- */
  function setBadge(n) {
    const b = $('repBadge'); if (!b) return;
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = !(n > 0);
    navBtns.reports.setAttribute('aria-label', '報告' + (n > 0 ? ' 未対応 ' + n + ' 件' : ''));
  }
  function applyServerMode(v2) {
    const changed = BC.S.v2 !== v2;
    BC.S.v2 = v2;
    $('bannerOld').hidden = v2;
    BC.viewOrder.forEach(id => { const v = BC.views[id]; if (v.v2only) navBtns[id].hidden = !v2; });
    if (changed && active && active.v2only && !v2) BC.go('dashboard');
    paintServer();
  }
  function paintServer() {
    const s = BC.S.stats;
    $('srvText').textContent = s ? 'サーバー v' + s.version : '-';
    const dot = $('srvDot');
    dot.className = 'srv-dot ' + (down.on ? 'err' : BC.S.v2 ? 'ok' : 'warn');
  }
  async function onStats(s) {
    BC.S.stats = s;
    BC.S.v3 = Number(s.adminApi) >= 3; // アカウント削除が使えるサーバーか
    applyServerMode(Number(s.adminApi) >= 2);
    paintServer();
    if (BC.S.v2) setBadge(Number(s.openReports) || 0);
    else {
      try { const r = await BC.api('GET', '/api/admin/reports?status=open', null, { quiet: true }); setBadge((r.reports || []).length); } catch (e) {}
    }
    $('updated').textContent = '更新 ' + fmt.time(new Date());
  }
  async function refreshStats() {
    const s = await BC.api('GET', '/api/admin/stats');
    await onStats(s);
    return s;
  }

  async function reload() {
    if (!BC.S.connected) return;
    const btn = $('btnRefresh'); btn.classList.add('spinning');
    try { await refreshStats(); } catch (e) { if (!e.network && !e.auth) toast(e.message, 'err'); }
    try { if (active) await active.refresh(true); lastLoad[active.id] = Date.now(); } catch (e) {}
    btn.classList.remove('spinning');
  }

  /* ---------- 変更後の連動更新 ---------- */
  function touch(ids) {
    ids.forEach(id => {
      const v = BC.views[id]; if (!v) return;
      if (active === v) v.refresh(true); else v.invalidate();
    });
  }
  BC.afterUserChange = () => { refreshStats().catch(() => {}); touch(['users', 'online']); BC.views.audit.invalidate(); if (active === BC.views.audit) active.refresh(true); };
  BC.afterReportChange = () => { refreshStats().catch(() => {}); BC.refreshOpenUser(); };
  BC.afterPostChange = () => { refreshStats().catch(() => {}); BC.views.audit.invalidate(); };

  /* ---------- 自動更新 ---------- */
  async function tick() {
    if (!BC.S.connected || document.hidden || down.on || ticking) return;
    ticking = true; lastTick = Date.now();
    try {
      await refreshStats();
      if (active && active.auto) { await active.refresh(true); lastLoad[active.id] = Date.now(); }
    } catch (e) {} finally { ticking = false; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !BC.S.connected) return;
    if (down.on) { probe(); return; }
    if (Date.now() - lastTick > POLL_MS - 1000) tick();
  });

  /* ---------- 接続断 ---------- */
  function renderDown() {
    if (!down.on) return;
    if (down.probing) {
      const sec = Math.floor((Date.now() - down.probeStart) / 1000);
      $('downTitle').textContent = sec >= 3 ? 'サーバーを起こしています(最大60秒)' : 'サーバーに接続できない';
      $('downSub').textContent = '再接続中 ' + sec + '秒';
    } else {
      $('downTitle').textContent = 'サーバーに接続できない';
      $('downSub').textContent = Math.max(0, Math.ceil((down.next - Date.now()) / 1000)) + '秒後に自動で再試行する';
    }
  }
  async function probe() {
    if (!down.on || down.probing) return;
    down.probing = true; down.probeStart = Date.now(); renderDown();
    try { await onStats(await BC.api('GET', '/api/admin/stats', null, { quiet: true })); }
    catch (e) { if (e.auth) { BC.hooks.auth(e); return; } }
    down.probing = false; down.next = Date.now() + 5000; renderDown();
  }
  BC.hooks.down = () => {
    if (!BC.S.connected || down.on) return;
    down.on = true; down.next = Date.now() + 5000; down.probing = false;
    $('bannerDown').hidden = false; paintServer(); renderDown();
    down.tmr = setInterval(() => { if (!document.hidden && !down.probing && Date.now() >= down.next) probe(); renderDown(); }, 1000);
  };
  BC.hooks.up = () => {
    if (!down.on) return;
    down.on = false; down.probing = false; clearInterval(down.tmr);
    $('bannerDown').hidden = true; paintServer();
    toast('再接続した');
    setTimeout(reload, 0);
  };
  function resetDown() { down.on = false; down.probing = false; clearInterval(down.tmr); $('bannerDown').hidden = true; }
  $('downRetry').addEventListener('click', () => probe());

  /* ---------- ログイン ---------- */
  function stopWake() { clearInterval(wakeTimer); wakeTimer = null; $('wake').hidden = true; }
  function setBusy(on) {
    $('loginBtn').disabled = on; $('loginBtnText').textContent = on ? '接続中...' : '接続';
    $('url').disabled = on; $('key').disabled = on;
  }
  async function connect() {
    const url = $('url').value.trim().replace(/\/+$/, '');
    const key = $('key').value;
    $('loginErr').textContent = '';
    if (!url || !key) { $('loginErr').textContent = 'URLと管理キーを入れる'; return; }
    const token = ++connectToken;
    BC.cfg = { url, key };
    setBusy(true);
    const t0 = Date.now();
    stopWake();
    wakeTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      if (sec >= 3) {
        $('wake').hidden = false;
        $('wakeSec').textContent = String(sec);
        $('wakeBar').style.width = Math.min(100, sec / 60 * 100) + '%';
      }
    }, 500);
    let stats;
    try { stats = await BC.api('GET', '/api/admin/stats', null, { quiet: true }); }
    catch (e) {
      if (token !== connectToken) return;
      stopWake(); setBusy(false);
      $('loginErr').textContent = e.message; return;
    }
    if (token !== connectToken) return;
    stopWake(); setBusy(false);
    try { await window.admin.saveCfg({ url, key, remember: $('remember').checked }); } catch (e) {}
    enterApp(stats);
  }
  $('loginForm').addEventListener('submit', e => { e.preventDefault(); connect(); });
  $('wakeCancel').addEventListener('click', () => { connectToken++; stopWake(); setBusy(false); $('loginErr').textContent = '中止した'; });
  $('keyToggle').addEventListener('click', () => {
    const k = $('key'), show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    const b = $('keyToggle'); clear(b).appendChild(icon(show ? 'eyeoff' : 'eye', 16));
  });

  let built = false;
  async function enterApp(stats) {
    if (!built) { buildShell(); built = true; }
    BC.S.connected = true; lastTick = Date.now();
    Object.keys(lastLoad).forEach(k => delete lastLoad[k]);
    BC.viewOrder.forEach(id => BC.views[id].invalidate());
    $('login').hidden = true; $('app').hidden = false;
    await onStats(stats);
    BC.go('dashboard');
    clearInterval(pollTimer); pollTimer = setInterval(tick, POLL_MS);
    try {
      if (window.admin.getInfo) { const i = await window.admin.getInfo(); if (i && i.version) $('srvInfo').title = '管理アプリ v' + i.version; }
    } catch (e) {}
  }
  function leave(msg) {
    BC.S.connected = false; BC.S.stats = null; BC.S.v2 = false;
    clearInterval(pollTimer); resetDown();
    BC.closeUser();
    BC.cfg.key = ''; $('key').value = '';
    $('app').hidden = true; $('login').hidden = false;
    $('loginErr').textContent = msg || '';
    $('key').focus();
  }
  $('btnDisconnect').addEventListener('click', () => leave(''));
  BC.hooks.auth = () => { if (BC.S.connected) leave('管理キーが違う'); };
  $('btnRefresh').addEventListener('click', reload);

  /* ---------- キーボード ---------- */
  function typing(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r') { e.preventDefault(); reload(); return; }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) {
      if (!BC.S.connected || BC.drawerOpen() || document.querySelector('dialog[open]')) return;
      if (active && active.focusSearch) { e.preventDefault(); active.focusSearch(); }
      return;
    }
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return;   // ダイアログは自分で閉じる
      if (BC.drawerOpen()) { e.preventDefault(); BC.closeUser(); }
    }
  });

  /* ---------- 起動 ---------- */
  (async () => {
    BC.hydrateIcons();
    let c = {};
    try { c = (await window.admin.getCfg()) || {}; } catch (e) {}
    $('url').value = c.url || ''; $('key').value = c.key || ''; $('remember').checked = !!c.remember;
    if (c.url && c.key) connect(); else $((c.url ? 'key' : 'url')).focus();
  })();
})();
