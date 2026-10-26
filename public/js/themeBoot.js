// 見た目(ライト/ダーク)の決定と適用。全ページの <head> で「defer なし」で読み込むこと。
// 最初の描画より前にhtmlへクラスを付けるので、開いた直後に違う色で一瞬出るのを防げる。
//
// 保存先(localStorage)
//   themeMode     : 'system'(端末に合わせる) | 'light' | 'dark' | 'schedule'(時間で切替)
//   darkSchedFrom : 'HH:MM' ダークにする開始時刻 (既定 20:00)
//   darkSchedTo   : 'HH:MM' ライトに戻す時刻     (既定 07:00)
//   darkBlack     : '1' なら、ダークの時に背景を真っ黒にする(有機EL向け)
//   darkMode      : 旧設定 '1'/'0'。themeMode が無い端末だけ参照する。
//                   他のページや古い画面が読むので、切替時は同じ意味で書き戻す。
(function () {
  var d = document.documentElement;
  var DEF_FROM = '20:00', DEF_TO = '07:00';
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function sysDark() { return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); }

  function mode() {
    var m = ls('themeMode');
    if (m === 'system' || m === 'light' || m === 'dark' || m === 'schedule') return m;
    var o = ls('darkMode');
    return o === '1' ? 'dark' : o === '0' ? 'light' : 'system';
  }
  function toMin(s, def) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(s || '') || /^(\d{1,2}):(\d{2})$/.exec(def);
    return Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]);
  }
  function sched() { return { from: ls('darkSchedFrom') || DEF_FROM, to: ls('darkSchedTo') || DEF_TO }; }
  // 開始と終了が日をまたぐ(20:00→07:00)場合も、同じ時刻(常時ダーク/ライト)の場合も扱う
  function inSchedule(now) {
    var s = sched(), a = toMin(s.from, DEF_FROM), b = toMin(s.to, DEF_TO);
    var n = now.getHours() * 60 + now.getMinutes();
    if (a === b) return false;
    return a < b ? (n >= a && n < b) : (n >= a || n < b);
  }
  function isDark() {
    var m = mode();
    if (m === 'dark') return true;
    if (m === 'light') return false;
    if (m === 'schedule') return inSchedule(new Date());
    return sysDark();
  }
  var BG = { light: '#e0f2fe', dark: '#0e1014', black: '#000000' };
  var wantColor = null;
  function paintThemeColor() {
    try {
      // <meta> がまだ読み込まれていない(このスクリプトの方が先)なら、DOMが出来てからもう一度
      var el = document.querySelector('meta[name="theme-color"]');
      if (el && wantColor && el.getAttribute('content') !== wantColor) el.setAttribute('content', wantColor);
    } catch (e) {}
  }
  function setThemeColor(color) { wantColor = color; paintThemeColor(); }
  var last = null;
  function apply() {
    var dark = isDark(), black = dark && ls('darkBlack') === '1';
    d.classList.toggle('dark-mode', dark);
    d.classList.toggle('dark-black', black);
    var key = (dark ? 'd' : 'l') + (black ? 'b' : '');
    if (key !== last) {
      last = key;
      setThemeColor(black ? BG.black : dark ? BG.dark : BG.light);
      try { window.dispatchEvent(new CustomEvent('themechange', { detail: { dark: dark, black: black } })); } catch (e) {}
    }
    scheduleNext();
  }

  // 時間指定のときは、次の切替時刻にちょうど切り替える(次の開始/終了のうち近い方)
  var timer = null;
  function scheduleNext() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (mode() !== 'schedule') return;
    var s = sched(), now = new Date(), best = null;
    [toMin(s.from, DEF_FROM), toMin(s.to, DEF_TO)].forEach(function (mm) {
      var t = new Date(now); t.setHours(Math.floor(mm / 60), mm % 60, 0, 0);
      if (t <= now) t.setDate(t.getDate() + 1);
      if (best == null || t < best) best = t;
    });
    if (best) timer = setTimeout(apply, Math.min(best - now + 500, 2147000000));
  }

  // 設定画面から呼ぶ。partial = { mode, from, to, black }
  function set(p) {
    p = p || {};
    if (p.mode) {
      lset('themeMode', p.mode);
      // 旧キーも意味を合わせて更新(古い読み方をする画面用)。system/scheduleは「手動指定なし」扱い
      lset('darkMode', p.mode === 'dark' ? '1' : p.mode === 'light' ? '0' : null);
    }
    if (p.from) lset('darkSchedFrom', p.from);
    if (p.to) lset('darkSchedTo', p.to);
    if (p.black != null) lset('darkBlack', p.black ? '1' : null);
    apply();
    try { window.dispatchEvent(new Event('settings-changed')); } catch (e) {}
  }

  window.BroTheme = {
    mode: mode, isDark: isDark, apply: apply, set: set,
    schedule: function () { var s = sched(); return { from: s.from, to: s.to }; },
    black: function () { return ls('darkBlack') === '1'; },
  };

  apply();
  // 端末のダーク設定の変化 / 別タブでの変更 / アプリに戻ってきた時(寝ている間に時刻が過ぎている)に追従
  try {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', apply);
  } catch (e) {}
  window.addEventListener('storage', function (e) {
    if (!e.key || /^(themeMode|darkMode|darkSchedFrom|darkSchedTo|darkBlack)$/.test(e.key)) apply();
  });
  document.addEventListener('DOMContentLoaded', paintThemeColor);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) apply(); });
  window.addEventListener('pageshow', apply);
})();
