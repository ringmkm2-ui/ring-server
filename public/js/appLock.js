// public/js/appLock.js
// -----------------------------------------------------------------------
// アプリロック(端末内だけで完結するPINロック)
//
//  - PINは保存しない。PBKDF2-SHA256(250,000回) + 16バイトのランダム塩のハッシュだけを
//    localStorage('bro_applock_v1') に置く。サーバーには何も送らない。
//  - <head> の先頭で読み込む。有効かつロック中なら、本文が1フレームも見える前に
//    全画面カバーを描く(html.bro-locked > body を visibility:hidden)。
//  - ページ遷移(トーク一覧 -> チャット)では聞き直さない。解除済みの印は sessionStorage に置き、
//    バックグラウンドに autoLockSec 秒(「すぐ」は2秒)以上いたら次に開いた時にロックする。
//  - ログアウトでロックも消える。ring_token が無い時も自動で消える。
//  - これは画面の鍵。端末のストレージを直接いじれる人(開発者ツール等)には効かない。
// -----------------------------------------------------------------------
(function () {
  'use strict';
  if (window.BroAppLock) return;

  var KEY = 'bro_applock_v1';
  var S_OK = 'bro_applock_ok';        // sessionStorage: このタブ/プロセスで解除済み
  var S_HID = 'bro_applock_hidden';   // sessionStorage: 最後に隠れた時刻
  var ITER = 250000;
  var MIN_HIDDEN_MS = 2000;
  var AUTO_CHOICES = [0, 60, 300, 900];
  var LOCKOUTS = [30, 60, 300, 900]; // 5回失敗するごとに段階的に伸びる(最後は15分のまま)
  var doc = document, root = doc.documentElement;

  function t(k, fb) { try { return window.i18n ? window.i18n.t(k, fb) : fb; } catch (e) { return fb; } }

  // ---------- 保存 ----------
  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o && typeof o === 'object' && o.enabled && o.saltB64 && o.hashB64) return o;
    } catch (e) {}
    return null;
  }
  function save(o) {
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {}
  }
  function ss(k, v) {
    try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  function hasToken() { try { return !!localStorage.getItem('ring_token'); } catch (e) { return true; } }

  // ---------- 暗号 ----------
  function b64(buf) { var a = new Uint8Array(buf), s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function unb64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  async function derive(pin, salt, iter) {
    if (!(window.crypto && crypto.subtle)) throw mkErr('no_crypto', t('applock_err_crypto', 'この環境ではロックを使えません(HTTPS接続が必要です)'));
    var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iter }, key, 256));
  }
  function same(a, b) { if (a.length !== b.length) return false; var d = 0; for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
  function mkErr(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function validPin(pin) { return typeof pin === 'string' && /^\d{4,8}$/.test(pin); }

  // ---------- 状態 ----------
  var locked = false;
  var listeners = [];
  function emit() { for (var i = 0; i < listeners.length; i++) { try { listeners[i]({ enabled: isEnabled(), locked: locked, autoLockSec: getAutoLockSec() }); } catch (e) {} } }
  function isEnabled() { return !!load(); }
  function getAutoLockSec() { var s = load(); return s && AUTO_CHOICES.indexOf(s.autoLockSec) >= 0 ? s.autoLockSec : 0; }
  function pinLen() { var s = load(); return s && s.pinLen >= 4 && s.pinLen <= 8 ? s.pinLen : 6; }
  function lockRemainMs() { var s = load(); return s && s.lockedUntil ? Math.max(0, s.lockedUntil - Date.now()) : 0; }

  // 失敗の記録つきで確認する。成功なら true / 違えば false / ロックアウト中は例外(code 'locked_out')
  async function check(pin) {
    var s = load();
    if (!s) return true;
    var rm = lockRemainMs();
    if (rm > 0) { var e = mkErr('locked_out'); e.remainMs = rm; throw e; }
    if (!validPin(pin)) return countFail(s);
    var h = await derive(pin, unb64(s.saltB64), s.iter || ITER);
    if (same(h, unb64(s.hashB64))) {
      if (s.failCount || s.lockedUntil) { s.failCount = 0; s.lockedUntil = 0; save(s); }
      return true;
    }
    return countFail(s);
  }
  function countFail(s) {
    s.failCount = (s.failCount || 0) + 1;
    if (s.failCount % 5 === 0) {
      var step = Math.min(Math.floor(s.failCount / 5) - 1, LOCKOUTS.length - 1);
      s.lockedUntil = Date.now() + LOCKOUTS[step] * 1000;
    }
    save(s);
    return false;
  }

  // ---------- 公開API(設定画面から) ----------
  async function setup(pin, autoLockSec) {
    if (!validPin(pin)) throw mkErr('bad_pin', t('applock_err_format', 'PINは4〜8桁の数字にしてください'));
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var h = await derive(pin, salt, ITER);
    save({
      enabled: true, saltB64: b64(salt), hashB64: b64(h), iter: ITER, pinLen: pin.length,
      failCount: 0, lockedUntil: 0,
      autoLockSec: AUTO_CHOICES.indexOf(autoLockSec) >= 0 ? autoLockSec : 0,
    });
    ss(S_OK, '1'); ss(S_HID, null);
    emit();
    return true;
  }
  async function disable(currentPin) {
    if (!(await check(currentPin))) throw mkErr('wrong_pin', t('applock_err_wrong', 'PINが違います'));
    reset();
    return true;
  }
  async function change(oldPin, newPin) {
    if (!validPin(newPin)) throw mkErr('bad_pin', t('applock_err_format', 'PINは4〜8桁の数字にしてください'));
    if (!(await check(oldPin))) throw mkErr('wrong_pin', t('applock_err_wrong', 'PINが違います'));
    var prev = load();
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var h = await derive(newPin, salt, ITER);
    prev.saltB64 = b64(salt); prev.hashB64 = b64(h); prev.iter = ITER; prev.pinLen = newPin.length;
    prev.failCount = 0; prev.lockedUntil = 0;
    save(prev);
    emit();
    return true;
  }
  function setAutoLockSec(n) {
    var s = load();
    if (!s || AUTO_CHOICES.indexOf(n) < 0) return false;
    s.autoLockSec = n; save(s); emit();
    return true;
  }
  // ログアウトや ring_token 消失で呼ぶ。ロックのデータを丸ごと消す
  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) {}
    ss(S_OK, null); ss(S_HID, null);
    locked = false;
    hideCover(true);
    emit();
  }
  function lockNow() {
    if (!isEnabled()) return false;
    ss(S_OK, null); ss(S_HID, null);
    showLock();
    emit();
    return true;
  }
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }
  // ファイル選択やカメラなど、アプリを一瞬離れる操作の前に呼ぶと、その間だけ再ロックしない
  var holdUntil = 0;
  function holdAutoLock(ms) { holdUntil = Date.now() + (ms || 60000); }

  // ---------- 画面 ----------
  var cover = null, dotsEl, msgEl, keysEl, bioBtn, forgotEl, panelMain, panelForgot, timer = 0, entered = '', busy = false, bioBusy = false;

  function injectStyle() {
    if (doc.getElementById('bro-applock-css')) return;
    var st = doc.createElement('style');
    st.id = 'bro-applock-css';
    st.textContent =
      'html.bro-locked>body{visibility:hidden!important}' +
      '#broLock{--bl-bg:#e0f2fe;--bl-fg:#0f172a;--bl-sub:#475569;--bl-key:rgba(15,23,42,.07);--bl-dot:rgba(15,23,42,.28);--bl-on:#0f172a;' +
      'position:fixed;inset:0;visibility:visible;z-index:2147483000;background:var(--bl-bg);color:var(--bl-fg);display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom));font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'user-select:none;-webkit-user-select:none;touch-action:manipulation;transition:transform .38s cubic-bezier(.32,.72,0,1),opacity .38s ease}' +
      'html.dark-mode #broLock{--bl-bg:#0b1220;--bl-fg:#f1f5f9;--bl-sub:#94a3b8;--bl-key:rgba(255,255,255,.09);--bl-dot:rgba(255,255,255,.3);--bl-on:#f1f5f9}' +
      'html.dark-mode.dark-black #broLock{--bl-bg:#000}' +
      '#broLock.bl-out{transform:translateY(-100%);opacity:.6;pointer-events:none}' +
      'html.reduce-motion #broLock{transition:none}' +
      '#broLock .bl-logo{width:64px;height:64px;border-radius:16px;object-fit:cover;display:block;margin:0 auto 14px}' +
      '#broLock .bl-title{font-size:18px;font-weight:700;text-align:center;margin:0 0 4px}' +
      '#broLock .bl-msg{min-height:20px;font-size:13px;color:var(--bl-sub);text-align:center;margin:0 0 18px;line-height:1.5}' +
      '#broLock .bl-msg.err{color:#ef4444}' +
      '#broLock .bl-dots{display:flex;gap:14px;justify-content:center;margin:0 0 28px;height:16px}' +
      '#broLock .bl-dots svg{width:14px;height:14px;display:block;overflow:visible}' +
      '#broLock .bl-dots circle{fill:transparent;stroke:var(--bl-dot);stroke-width:1.6}' +
      '#broLock .bl-dots circle.on{fill:var(--bl-on);stroke:var(--bl-on)}' +
      '#broLock .bl-dots.err circle{stroke:#ef4444}#broLock .bl-dots.err circle.on{fill:#ef4444}' +
      '#broLock .bl-dots.shake{animation:blShake .42s cubic-bezier(.36,.07,.19,.97)}' +
      'html.reduce-motion #broLock .bl-dots.shake{animation:none}' +
      '@keyframes blShake{10%,90%{transform:translateX(-2px)}20%,80%{transform:translateX(4px)}30%,50%,70%{transform:translateX(-8px)}40%,60%{transform:translateX(8px)}}' +
      '#broLock .bl-keys{display:grid;grid-template-columns:repeat(3,76px);gap:14px 22px;justify-content:center}' +
      '#broLock .bl-key{width:76px;height:76px;border-radius:50%;border:0;background:var(--bl-key);color:var(--bl-fg);font-size:28px;font-weight:500;font-family:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;outline:none;-webkit-tap-highlight-color:transparent}' +
      '#broLock .bl-key:active:not(:disabled){filter:brightness(.82)}' +
      'html.dark-mode #broLock .bl-key:active:not(:disabled){filter:brightness(1.6)}' +
      '#broLock .bl-key:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}' +
      '#broLock .bl-key:disabled{opacity:.35;cursor:default}' +
      '#broLock .bl-key.ghost{background:transparent}' +
      '#broLock .bl-key svg{width:28px;height:28px}' +
      '#broLock .bl-links{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:22px}' +
      '#broLock .bl-link{border:0;background:transparent;color:var(--bl-sub);font-size:14px;font-family:inherit;padding:10px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border-radius:10px}' +
      '#broLock .bl-link:active{filter:brightness(.7)}' +
      '#broLock .bl-link:focus-visible{outline:2px solid #3b82f6}' +
      '#broLock .bl-link svg{width:18px;height:18px}' +
      '#broLock .bl-forgot{max-width:320px;text-align:center}' +
      '#broLock .bl-forgot p{font-size:14px;line-height:1.7;color:var(--bl-sub);margin:0 0 18px}' +
      '#broLock .bl-btn{display:block;width:100%;border:0;border-radius:14px;padding:14px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;margin-top:8px;background:var(--bl-key);color:var(--bl-fg)}' +
      '#broLock .bl-btn:active{filter:brightness(.85)}' +
      '#broLock .bl-btn.danger{background:rgba(239,68,68,.14);color:#ef4444}' +
      '#broLock [hidden]{display:none!important}';
    (doc.head || root).appendChild(st);
  }

  var NS = 'http://www.w3.org/2000/svg';
  function svgEl(name, attrs) { var e = doc.createElementNS(NS, name); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function icon(paths) {
    var s = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (var i = 0; i < paths.length; i++) s.appendChild(svgEl('path', { d: paths[i] }));
    return s;
  }
  function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function buildCover() {
    injectStyle();
    cover = el('div', 'lg-no-lens'); cover.id = 'broLock'; // lg-no-lens: lgControls のガラス化から除外(キーは押しても膨らませない)
    cover.tabIndex = -1; cover.style.outline = 'none';
    cover.setAttribute('role', 'dialog'); cover.setAttribute('aria-modal', 'true');
    cover.setAttribute('aria-label', t('applock_aria', 'アプリロック'));

    panelMain = el('div'); panelMain.style.cssText = 'display:flex;flex-direction:column;align-items:center';
    var logo = el('img', 'bl-logo'); logo.src = '/images/logo.jpg'; logo.alt = ''; logo.width = 64; logo.height = 64; logo.decoding = 'async';
    logo.onerror = function () { logo.style.visibility = 'hidden'; };
    var title = el('h1', 'bl-title', t('applock_enter', 'PINを入力'));
    msgEl = el('p', 'bl-msg'); msgEl.setAttribute('role', 'status'); msgEl.setAttribute('aria-live', 'polite');
    dotsEl = el('div', 'bl-dots'); dotsEl.setAttribute('aria-hidden', 'true');
    keysEl = el('div', 'bl-keys');
    keysEl.setAttribute('role', 'group'); keysEl.setAttribute('aria-label', t('applock_keypad', 'テンキー'));
    var order = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del'];
    order.forEach(function (k) {
      var b = el('button', 'bl-key'); b.type = 'button';
      if (k === 'bio') {
        b.className = 'bl-key ghost'; b.style.visibility = 'hidden'; b.setAttribute('aria-label', t('applock_bio', '指紋・顔で解除'));
        b.appendChild(icon(['M12 11v3a4 4 0 0 1-1 2.6', 'M8 11a4 4 0 0 1 8 0v1.5', 'M5 11a7 7 0 0 1 14 0v2', 'M5 15c0 2 .5 3.5 1.5 5', 'M19 15.5c0 1.8-.4 3-1 4.5']));
        b.onclick = tryBiometric; bioBtn = b;
      } else if (k === 'del') {
        b.className = 'bl-key ghost'; b.setAttribute('aria-label', t('applock_del', '1文字消す'));
        b.appendChild(icon(['M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z', 'M17 9l-6 6', 'M11 9l6 6']));
        b.onclick = backspace;
      } else {
        b.textContent = k; b.setAttribute('data-k', k);
        b.setAttribute('aria-label', k);
        b.onclick = function () { press(k); };
      }
      keysEl.appendChild(b);
    });
    var links = el('div', 'bl-links');
    forgotEl = el('button', 'bl-link', t('applock_forgot', 'PINを忘れた')); forgotEl.type = 'button';
    forgotEl.onclick = function () { showForgot(true); };
    links.appendChild(forgotEl);
    panelMain.append(logo, title, msgEl, dotsEl, keysEl, links);

    panelForgot = el('div', 'bl-forgot'); panelForgot.hidden = true;
    var fh = el('h1', 'bl-title', t('applock_forgot', 'PINを忘れた')); fh.style.marginBottom = '12px';
    var fp = el('p', null, t('applock_forgot_body', 'PINは復元できません。ロックを解除する方法は、ログアウトすることだけです。ログアウトするとロックの設定は消えます。もう一度ログインすれば使えます。'));
    var fo = el('button', 'bl-btn danger', t('applock_forgot_logout', 'ログアウトしてロックを解除')); fo.type = 'button';
    fo.onclick = forgotLogout;
    var fc = el('button', 'bl-btn', t('cancel', 'やめる')); fc.type = 'button';
    fc.onclick = function () { showForgot(false); };
    panelForgot.append(fh, fp, fo, fc);

    cover.append(panelMain, panelForgot);
    renderDots();
    root.appendChild(cover); // body の外(html直下)に置く。body は visibility:hidden になるため
  }
  function bioAvailable() { return !!bioFn(); }
  function bioFn() {
    try {
      var P = window.Capacitor && window.Capacitor.Plugins;
      if (!P) return null;
      if (P.BroCall && typeof P.BroCall.biometricAuth === 'function') return function () { return P.BroCall.biometricAuth({ title: t('applock_bio_title', 'Bro Chat のロック解除'), reason: t('applock_bio_reason', 'ロックを解除します') }); };
      if (P.NativeBiometric && typeof P.NativeBiometric.verifyIdentity === 'function') return function () { return P.NativeBiometric.verifyIdentity({ reason: t('applock_bio_reason', 'ロックを解除します'), title: t('applock_bio_title', 'Bro Chat のロック解除') }); };
    } catch (e) {}
    return null;
  }
  async function tryBiometric() {
    var f = bioFn();
    if (!f || bioBusy) return;
    bioBusy = true;
    try {
      var r = await f();
      // BroCall.biometricAuth は { success|authenticated|verified } か真偽値、NativeBiometric は成功で resolve(失敗で reject)
      var okv = r === undefined || r === null || r === true ||
        (typeof r === 'object' && r.success !== false && r.authenticated !== false && r.verified !== false && !r.error);
      if (okv) unlock();
    } catch (e) { /* キャンセル・失敗はPIN入力に戻るだけ */ }
    bioBusy = false;
  }

  function renderDots() {
    if (!dotsEl) return;
    var n = pinLen();
    dotsEl.textContent = '';
    for (var i = 0; i < n; i++) {
      var s = svgEl('svg', { viewBox: '0 0 14 14' });
      s.appendChild(svgEl('circle', { cx: '7', cy: '7', r: '5.5', 'class': i < entered.length ? 'on' : '' }));
      dotsEl.appendChild(s);
    }
    dotsEl.setAttribute('data-n', String(entered.length));
  }
  function setMsg(text, err) { if (msgEl) { msgEl.textContent = text || ''; msgEl.className = 'bl-msg' + (err ? ' err' : ''); } }
  function press(d) {
    if (busy || !locked || lockRemainMs() > 0) return;
    if (entered.length >= pinLen()) return;
    if (msgEl && !msgEl.getAttribute('data-wait')) setMsg('', false);
    entered += d; renderDots();
    if (entered.length === pinLen()) submit();
  }
  function backspace() {
    if (busy || !entered) return;
    entered = entered.slice(0, -1); renderDots();
  }
  async function submit() {
    busy = true;
    var pin = entered;
    var ok = false, remain = 0;
    try { ok = await check(pin); } catch (e) { if (e && e.code === 'locked_out') remain = e.remainMs; else { setMsg(e && e.message || '', true); } }
    pin = null;
    busy = false;
    if (ok) { unlock(); return; }
    entered = ''; renderDots();
    dotsEl.classList.remove('shake', 'err'); void dotsEl.offsetWidth;
    dotsEl.classList.add('shake', 'err');
    setTimeout(function () { if (dotsEl) dotsEl.classList.remove('shake', 'err'); }, 520);
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
    if (lockRemainMs() > 0 || remain) startCountdown(); else setMsg(t('applock_wrong', 'PINが違います'), true);
  }
  function startCountdown() {
    clearInterval(timer);
    var tick = function () {
      var rm = lockRemainMs();
      var dis = rm > 0;
      var btns = keysEl ? keysEl.querySelectorAll('button') : [];
      for (var i = 0; i < btns.length; i++) btns[i].disabled = dis;
      if (!dis) { clearInterval(timer); timer = 0; if (msgEl) msgEl.removeAttribute('data-wait'); setMsg('', false); if (cover) { try { cover.focus({ preventScroll: true }); } catch (e) {} } return; }
      var sec = Math.ceil(rm / 1000);
      var txt = sec >= 60 ? Math.floor(sec / 60) + t('applock_min', '分') + (sec % 60 ? (sec % 60) + t('applock_sec', '秒') : '') : sec + t('applock_sec', '秒');
      msgEl.setAttribute('data-wait', '1');
      setMsg(t('applock_wait_pre', '失敗が続きました。あと') + txt + t('applock_wait_post', 'で再試行できます'), true);
    };
    tick();
    if (lockRemainMs() > 0) timer = setInterval(tick, 250);
  }
  function showForgot(on) {
    if (!cover) return;
    panelMain.hidden = on; panelForgot.hidden = !on;
    var f = (on ? panelForgot : panelMain).querySelector('button:not([hidden]):not(:disabled):not([style*=hidden])');
    if (f) { try { f.focus({ preventScroll: true }); } catch (e) {} }
  }
  // ログアウト: サーバーの端末セッションを失効(失敗しても続行) -> 暗号鍵だけ残して他は消す -> ログイン画面へ
  // 通常のログアウトの「残してログアウト」と同じ扱い(PINを知らない人に鍵を消す権限は渡さない)
  function forgotLogout() {
    try {
      var tk = localStorage.getItem('ring_token');
      if (tk) fetch('/api/auth/logout', { method: 'POST', keepalive: true, headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' }, body: JSON.stringify({ fcmToken: localStorage.getItem('fcm_token') || undefined }) }).catch(function () {});
    } catch (e) {}
    try {
      var keep = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/^(e2e_keypair_|e2e_keyring_|e2e_peerkeys_|own_plaintext_|signal_identity_|group_key_|community_key_|e2e_registered_|bc_sn_v1)/.test(k)) keep[k] = localStorage.getItem(k);
      }
      localStorage.clear();
      for (var kk in keep) localStorage.setItem(kk, keep[kk]);
    } catch (e) {}
    reset();
    location.href = '/auth.html';
  }

  function showLock() {
    locked = true;
    entered = ''; busy = false;
    root.classList.add('bro-locked');
    if (!cover) buildCover();
    else { cover.classList.remove('bl-out'); cover.hidden = false; if (!cover.parentNode) root.appendChild(cover); }
    renderDots();
    showForgot(false);
    if (bioBtn) { bioBtn.style.visibility = bioAvailable() ? '' : 'hidden'; bioBtn.disabled = !bioAvailable(); }
    setMsg('', false);
    startCountdown();
    try { cover.focus({ preventScroll: true }); } catch (e) {}
    emit();
  }
  function hideCover(instant) {
    root.classList.remove('bro-locked');
    clearInterval(timer); timer = 0;
    if (!cover) return;
    var c = cover; cover = null; dotsEl = msgEl = keysEl = bioBtn = null;
    if (instant || root.classList.contains('reduce-motion')) { if (c.parentNode) c.parentNode.removeChild(c); return; }
    c.classList.add('bl-out');
    setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 450);
  }
  function unlock() {
    locked = false; entered = '';
    ss(S_OK, '1'); ss(S_HID, null);
    hideCover(false);
    emit();
  }

  // ---------- 再ロックの判定 ----------
  function needsLock() {
    var s = load();
    if (!s) return false;
    if (ss(S_OK) !== '1') return true;                // このタブでまだ解除していない(アプリ再起動も含む)
    var h = parseInt(ss(S_HID) || '0', 10);
    if (!h) return false;
    if (holdUntil > Date.now()) return false;
    var limit = Math.max(getAutoLockSec() * 1000, MIN_HIDDEN_MS);
    return Date.now() - h >= limit;
  }
  function evaluate() {
    if (!hasToken()) { if (isEnabled()) reset(); return; }
    if (locked) return;
    if (needsLock()) { ss(S_OK, null); showLock(); }
  }
  function onHide() {
    if (locked || bioBusy || !isEnabled()) return;
    ss(S_HID, String(Date.now()));
  }
  function onShow() {
    evaluate();
    if (!locked) ss(S_HID, null);
  }

  // ---------- 起動 ----------
  function boot() {
    if (!hasToken()) { if (load()) reset(); }
    else if (load() && needsLock()) { ss(S_OK, null); showLock(); }
    else ss(S_HID, null);

    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden') onHide(); else onShow(); });
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', function (e) { if (e.persisted) onShow(); });
    // 別タブ/別ページで ring_token が消えた(ログアウト)・ロックが変わった
    window.addEventListener('storage', function (e) {
      if (e.key === 'ring_token' && !e.newValue && isEnabled()) reset();
      if (e.key === KEY) { if (!isEnabled() && locked) { locked = false; hideCover(true); } emit(); }
    });
    // Capacitor のアプリ状態(バックグラウンド/復帰)
    try {
      var A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
      if (A && A.addListener) A.addListener('appStateChange', function (st) { if (st && st.isActive === false) onHide(); else onShow(); });
    } catch (e) {}
    // PCでのキーボード入力(0-9 / Backspace)
    doc.addEventListener('keydown', function (e) {
      if (!locked || !cover || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!panelForgot.hidden) return;
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); backspace(); }
    }, true);
    // ロック中はフォーカスをカバーの外へ出さない
    doc.addEventListener('focusin', function (e) {
      if (locked && cover && !cover.contains(e.target)) { var b = cover.querySelector('button:not([hidden]):not(:disabled):not([style*=hidden])'); if (b) b.focus({ preventScroll: true }); }
    });
  }

  window.BroAppLock = {
    isEnabled: isEnabled,
    isLocked: function () { return locked; },
    setup: setup,
    disable: disable,
    change: change,
    setAutoLockSec: setAutoLockSec,
    getAutoLockSec: getAutoLockSec,
    lockNow: lockNow,
    reset: reset,
    onChange: onChange,
    holdAutoLock: holdAutoLock,
    biometricAvailable: bioAvailable,
    AUTO_CHOICES: AUTO_CHOICES,
  };
  boot();
})();
