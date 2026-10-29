// public/js/privacyScreen.js
// -----------------------------------------------------------------------
// 画面を隠す(アプリ切替・バックグラウンド) / スクショ・画面録画の禁止
//
//  privacyScreen   : ページが隠れている間、不透明のカバーで全面を覆う(アプリ切替の縮小画像に中身を出さない)
//  blockScreenshots: Capacitor の BroCall.setSecure({enabled}) を呼ぶ(Android の FLAG_SECURE)。
//                    ネイティブ側が未対応なら何も起きない(Web版では効かない)。
//
//  設定は window.bcSettings(userSettings.js)から読む。無いページでは localStorage の写しを読む。
//  設定が変わったら apply() を呼び直す(bcSettings.update をラップして検知する)。
// -----------------------------------------------------------------------
(function () {
  'use strict';
  if (window.BroPrivacyScreen) return;
  var doc = document, root = doc.documentElement;
  var cover = null, blurTimer = 0, lastSecure = null;

  function settings() { return window.BroSettings || window.bcSettings || null; }
  function getSetting(key, def) {
    try {
      var s = settings();
      if (s && typeof s.get === 'function') { var v = s.get(key); if (v !== undefined) return !!v; }
    } catch (e) {}
    try {
      var o = JSON.parse(localStorage.getItem('ring_user_settings') || 'null');
      if (o && typeof o[key] === 'boolean') return o[key];
    } catch (e) {}
    return def;
  }
  function enabled() { return getSetting('privacyScreen', false); }

  function injectStyle() {
    if (doc.getElementById('bro-privacy-css')) return;
    var st = doc.createElement('style');
    st.id = 'bro-privacy-css';
    st.textContent =
      '#broPrivacy{position:fixed;inset:0;z-index:2147482900;background:#e0f2fe;display:flex;align-items:center;justify-content:center;visibility:visible}' +
      'html.dark-mode #broPrivacy{background:#0b1220}html.dark-mode.dark-black #broPrivacy{background:#000}' +
      '#broPrivacy img{width:88px;height:88px;border-radius:22px;object-fit:cover;display:block}';
    (doc.head || root).appendChild(st);
  }
  function show() {
    if (cover || !enabled()) return;
    injectStyle();
    cover = doc.createElement('div');
    cover.id = 'broPrivacy';
    cover.setAttribute('aria-hidden', 'true');
    var img = doc.createElement('img');
    img.src = '/images/logo.jpg'; img.alt = ''; img.decoding = 'sync';
    img.onerror = function () { img.style.visibility = 'hidden'; };
    cover.appendChild(img);
    root.appendChild(cover); // body の外に置く(アプリロックの body 非表示と干渉しない)
  }
  function hide() {
    clearTimeout(blurTimer);
    if (cover) { if (cover.parentNode) cover.parentNode.removeChild(cover); cover = null; }
  }

  function onVisibility() { if (doc.visibilityState === 'hidden') show(); else hide(); }

  // PCのブラウザだけ: 別ウィンドウに移って 300ms 以上フォーカスが戻らなければ隠す。
  // アプリ(Capacitor)ではキーボードやファイル選択で blur が出るので使わない。
  function onBlur() {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return;
    clearTimeout(blurTimer);
    blurTimer = setTimeout(function () { if (!doc.hasFocus() && doc.visibilityState !== 'hidden') show(); }, 300);
  }
  function onFocus() { clearTimeout(blurTimer); if (doc.visibilityState !== 'hidden') hide(); }

  // Capacitor 3以上は、ネイティブ側に実装が無くても Plugins.BroCall.setSecure が関数として見える(呼ぶと reject)。
  // なので「呼んで通るか」で対応済みかを判定する。true=対応 / false=未対応 / null=まだ不明
  var secureState = null;
  function applySecure() {
    return new Promise(function (resolve) {
      try {
        var enable = getSetting('blockScreenshots', false);
        var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BroCall;
        if (!P || typeof P.setSecure !== 'function') { secureState = false; return resolve(false); }
        var r = P.setSecure({ enabled: enable });
        lastSecure = enable;
        if (r && typeof r.then === 'function') r.then(function () { secureState = true; resolve(true); }, function () { secureState = false; resolve(false); });
        else { secureState = true; resolve(true); }
      } catch (e) { secureState = false; resolve(false); }
    });
  }
  function apply() {
    try {
      if (!enabled()) hide();
      else if (doc.visibilityState === 'hidden') show();
    } catch (e) {}
    applySecure();
  }

  function wrapSettings() {
    var s = settings();
    if (!s || s.__bpsWrapped || typeof s.update !== 'function') return !!(s && s.__bpsWrapped);
    var orig = s.update;
    s.update = function () {
      var p = orig.apply(this, arguments);
      apply(); // 値は update の呼び出しで同期的に変わる
      if (p && typeof p.then === 'function') p.then(apply, apply);
      return p;
    };
    if (typeof s.refresh === 'function') {
      var oref = s.refresh;
      s.refresh = function () { var p = oref.apply(this, arguments); if (p && p.then) p.then(apply, function () {}); return p; };
    }
    s.__bpsWrapped = true;
    return true;
  }

  doc.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', function (e) { if (e.persisted) show(); }); // 通常の画面遷移では出さない
  window.addEventListener('pageshow', function () { if (doc.visibilityState !== 'hidden') hide(); apply(); });
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  window.addEventListener('storage', function (e) { if (e.key === 'ring_user_settings') apply(); });
  try {
    var A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (A && A.addListener) A.addListener('appStateChange', function (st) { if (st && st.isActive === false) show(); else hide(); });
  } catch (e) {}

  wrapSettings();
  apply();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { wrapSettings(); apply(); });
  window.addEventListener('load', function () { wrapSettings(); apply(); setTimeout(function () { applySecure(); }, 1500); });

  window.BroPrivacyScreen = { apply: apply, probeSecure: applySecure, secureSupported: function () { return secureState; }, show: show, hide: hide, isCovering: function () { return !!cover; } };
})();
