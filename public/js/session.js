// public/js/session.js
// セッションが切れた(別の端末から失効された・パスワード変更・アカウント削除など)ときに、
// 画面が壊れたまま固まらず、ログイン画面へ戻すための共通処理。
// talklist.html / admin.html / groupchat.html で読み込む。
(function () {
  if (window.bcForceLogout) return;

  // E2Eの鍵と自分の送信控えは残す(消すと再ログイン後にそれまでのメッセージが読めなくなる)
  var KEEP = /^(e2e_keypair_|e2e_keyring_|e2e_peerkeys_|own_plaintext_|signal_identity_|group_key_|e2e_registered_)/;
  var going = false;

  window.bcForceLogout = function () {
    if (going) return;
    going = true;
    try {
      var keep = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (KEEP.test(k)) keep[k] = localStorage.getItem(k);
      }
      localStorage.clear();
      for (var k2 in keep) localStorage.setItem(k2, keep[k2]);
    } catch (e) {}
    window.location.href = '/auth.html';
  };

  // 利用停止(禁止語で3日間)の画面。画面全体を覆って操作できなくし、解除までの残り時間を出す
  window.bcShowBanned = function (until) {
    until = Number(until) || 0;
    if (until <= Date.now()) return;
    try { localStorage.setItem('bc_banned_until', String(until)); } catch (e) {}
    var ov = document.getElementById('bcBanOv');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'bcBanOv';
      ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0b0d12;color:#e5e7eb;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:32px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
      ov.innerHTML = '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/></svg>' +
        '<div style="font-size:20px;font-weight:700">利用停止中</div>' +
        '<div style="font-size:14px;color:#9ca3af;line-height:1.7">禁止されている言葉を使ったため、<br>3日間このアカウントは使えません。</div>' +
        '<div id="bcBanLeft" style="font-size:15px;font-weight:600;color:#f3f4f6"></div>';
      (document.body || document.documentElement).appendChild(ov);
    }
    var left = document.getElementById('bcBanLeft');
    var tick = function () {
      var ms = until - Date.now();
      if (ms <= 0) { try { localStorage.removeItem('bc_banned_until'); } catch (e) {} location.reload(); return; }
      var d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4);
      if (left) left.textContent = '解除まで ' + (d ? d + '日 ' : '') + h + '時間 ' + m + '分';
    };
    tick();
    clearInterval(window.__bcBanT);
    window.__bcBanT = setInterval(tick, 30000);
  };
  // 前回停止を受けていて、まだ期間中ならすぐ出す(オフラインでも)
  try {
    var savedBan = Number(localStorage.getItem('bc_banned_until') || 0);
    if (savedBan > Date.now()) {
      if (document.body) window.bcShowBanned(savedBan);
      else document.addEventListener('DOMContentLoaded', function () { window.bcShowBanned(savedBan); });
    }
  } catch (e) {}

  // 認証トークンが理由の401だけを拾う。「現在のパスワードが違います」のような401は対象外。
  var TOKEN_ERRORS = ['トークンが無効です', '認証トークンがありません'];
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var p = origFetch.apply(this, arguments);
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/') === -1 || url.indexOf('/api/auth/login') !== -1) return p;
      return p.then(function (res) {
        // 途中で解除された(管理者の解除など)ら、普通に通るようになった時点で停止画面を外す
        if (res && res.ok && document.getElementById('bcBanOv') && /\/api\/(messages|friends|groups|posts|communities)\//.test(url)) {
          var ovEl = document.getElementById('bcBanOv');
          if (ovEl) ovEl.remove();
          clearInterval(window.__bcBanT);
          try { localStorage.removeItem('bc_banned_until'); } catch (e) {}
        }
        if (res && res.status === 403) {
          res.clone().json().then(function (j) {
            if (j && j.banned) window.bcShowBanned(j.bannedUntil);
          }).catch(function () {});
        }
        if (res && res.status === 401) {
          res.clone().json().then(function (j) {
            if (j && TOKEN_ERRORS.indexOf(j.error) !== -1) window.bcForceLogout();
          }).catch(function () {});
        }
        return res;
      });
    } catch (e) {
      return p;
    }
  };

  // WebSocketで届く失効通知(サーバーが接続を切る前に送る)
  window.bcHandleWsAuth = function (data) {
    if (data && data.type === 'banned') {
      window.bcShowBanned(data.bannedUntil);
      return true;
    }
    if (data && (data.type === 'session_revoked' || data.type === 'auth_error')) {
      window.bcForceLogout();
      return true;
    }
    return false;
  };
})();
