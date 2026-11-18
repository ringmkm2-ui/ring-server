// public/js/schoolMode.js
// -----------------------------------------------------------------------
// 学校モード(端末ごとの制限モード。解除にはパスワードが要る)
//
//  - 学校の端末で使う時のためのモード。オンの間は、通話(個人/グループ)、ライブ配信、
//    投稿タブ、コミュニティ、コーヒーの支援リンクを使えなくする。テキストのトークは今まで通り。
//  - パスワードは保存しない。PBKDF2-SHA256(250,000回) + 16バイトのランダム塩のハッシュだけを
//    localStorage('bro_school_v1') に置く。サーバーには何も送らない(アカウントの設定は触らない)。
//  - ログアウトしても消えない(ログアウトで抜けられると意味が無いので)。解除はパスワードだけ。
//  - 5回間違えるごとに待たされる時間が伸びる(30秒 → 1分 → 5分 → 15分)。
//  - これは画面の鍵。端末のストレージを直接消せる人(ブラウザのサイトデータ削除、開発者ツール)には効かない。
//    端末側の管理(MDMや学校のフィルター)の代わりにはならない。
//  - <head> の先頭近くで読み込む。html.bro-school が付いている間、CSSで入口を消す。
// -----------------------------------------------------------------------
(function () {
  'use strict';
  if (window.BroSchool) return;

  var KEY = 'bro_school_v1';
  var ITER = 250000;
  var MIN_PW = 6, MAX_PW = 64;
  var LOCKOUTS = [30, 60, 300, 900];
  var doc = document, root = doc.documentElement;

  function t(k, fb) { try { return window.i18n ? window.i18n.t(k, fb) : fb; } catch (e) { return fb; } }
  function mkErr(code, msg) { var e = new Error(msg || code); e.code = code; return e; }

  // ---------- 保存 ----------
  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o && typeof o === 'object' && o.enabled && o.saltB64 && o.hashB64) return o;
    } catch (e) {}
    return null;
  }
  function save(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }

  // ---------- 暗号 ----------
  function b64(buf) { var a = new Uint8Array(buf), s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function unb64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  async function derive(pw, salt, iter) {
    if (!(window.crypto && crypto.subtle)) throw mkErr('no_crypto', t('school_err_crypto', 'この環境では学校モードを使えません(HTTPS接続が必要です)'));
    var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iter }, key, 256));
  }
  function same(a, b) { if (a.length !== b.length) return false; var d = 0; for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
  function validPw(pw) { return typeof pw === 'string' && pw.length >= MIN_PW && pw.length <= MAX_PW; }

  // ---------- 状態 ----------
  var listeners = [];
  function isOn() { return !!load(); }
  function emit() {
    apply();
    for (var i = 0; i < listeners.length; i++) { try { listeners[i]({ enabled: isOn() }); } catch (e) {} }
  }
  function lockRemainMs() { var s = load(); return s && s.lockedUntil ? Math.max(0, s.lockedUntil - Date.now()) : 0; }

  async function check(pw) {
    var s = load();
    if (!s) return true;
    var rm = lockRemainMs();
    if (rm > 0) { var e = mkErr('locked_out'); e.remainMs = rm; throw e; }
    if (!validPw(pw)) return countFail(s);
    var h = await derive(pw, unb64(s.saltB64), s.iter || ITER);
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

  // ---------- 公開API ----------
  async function setup(pw) {
    if (isOn()) throw mkErr('already_on', t('school_err_already', 'すでにオンです'));
    if (!validPw(pw)) throw mkErr('bad_pw', t('school_err_format', 'パスワードは6文字以上にしてください'));
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var h = await derive(pw, salt, ITER);
    save({ enabled: true, saltB64: b64(salt), hashB64: b64(h), iter: ITER, failCount: 0, lockedUntil: 0 });
    emit();
    return true;
  }
  async function disable(pw) {
    if (!(await check(pw))) throw mkErr('wrong_pw', t('school_err_wrong', 'パスワードが違います'));
    try { localStorage.removeItem(KEY); } catch (e) {}
    emit();
    return true;
  }
  async function change(oldPw, newPw) {
    if (!validPw(newPw)) throw mkErr('bad_pw', t('school_err_format', 'パスワードは6文字以上にしてください'));
    if (!(await check(oldPw))) throw mkErr('wrong_pw', t('school_err_wrong', 'パスワードが違います'));
    var prev = load();
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var h = await derive(newPw, salt, ITER);
    prev.saltB64 = b64(salt); prev.hashB64 = b64(h); prev.iter = ITER;
    prev.failCount = 0; prev.lockedUntil = 0;
    save(prev);
    emit();
    return true;
  }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  // 使えない機能の入口で呼ぶ。オンなら説明を出して true を返す(呼び出し側はそこで止める)
  function blocked() {
    if (!isOn()) return false;
    try { alert(t('school_blocked', '学校モード中は使えません。')); } catch (e) {}
    return true;
  }

  // ---------- 見た目 ----------
  function injectStyle() {
    if (doc.getElementById('bro-school-css')) return;
    var st = doc.createElement('style');
    st.id = 'bro-school-css';
    st.textContent =
      'html.bro-school #phoneBtn,html.bro-school #videoCallBtn,' +
      'html.bro-school #liveBtnG,html.bro-school #phoneBtnG,html.bro-school #videoBtnG,' +
      'html.bro-school #gcallBanner,html.bro-school #setCoffee,html.bro-school .school-hide{display:none!important}' +
      '.school-note{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:56px 24px;opacity:.75;font-size:14px;line-height:1.6}' +
      'html:not(.bro-school) .school-only{display:none!important}' +
      'html.bro-school #pagePosts>:not(.school-only){display:none!important}';
    (doc.head || root).appendChild(st);
  }
  function apply() {
    injectStyle();
    root.classList.toggle('bro-school', isOn());
  }

  window.BroSchool = {
    isOn: isOn,
    setup: setup,
    disable: disable,
    change: change,
    check: check,
    onChange: onChange,
    blocked: blocked,
    minLength: MIN_PW,
    maxLength: MAX_PW,
    lockRemainMs: lockRemainMs,
  };
  apply();
})();
