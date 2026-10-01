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

  // 認証トークンが理由の401だけを拾う。「現在のパスワードが違います」のような401は対象外。
  var TOKEN_ERRORS = ['トークンが無効です', '認証トークンがありません'];
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var p = origFetch.apply(this, arguments);
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/') === -1 || url.indexOf('/api/auth/login') !== -1) return p;
      return p.then(function (res) {
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
    if (data && (data.type === 'session_revoked' || data.type === 'auth_error')) {
      window.bcForceLogout();
      return true;
    }
    return false;
  };
})();
