// public/js/keyBackup.js
// E2E暗号鍵のバックアップと復元(端末の乗り換え・複数端末で過去のメッセージを読めるようにする)。
//
// 仕組み:
//  - 自分の鍵(e2e_keypair_<id> と e2e_keyring_<id>)を、パスフレーズから作った鍵(PBKDF2-SHA256, 60万回)で
//    暗号化(nacl.secretbox)してサーバーに預ける。サーバーは中身を読めない。
//  - 新しい端末で鍵が無い時は、新しい鍵を作る前に必ず「復元するか」を聞く。
//    (これが無いと、端末ごとに別の鍵が作られ、公開鍵の登録を上書きし合って、
//     片方の端末でしか読めないメッセージが増え続ける)
//  - 復元すると、バックアップの鍵を「いまの鍵」に戻して公開鍵を再登録し、
//    この端末で作ってしまった鍵は keyring に残す(その間に届いたメッセージも読める)。
//
// 対象は個人チャットの鍵。グループの鍵(signal_identity_*)は別系統なのでここでは触らない。
(function () {
  if (window.bcKeyBackup) return;

  var PBKDF2_ITER = 600000;
  var MIN_PASS = 8;
  var uid = function () { return localStorage.getItem('ring_userId') || window.myUserId || ''; };
  var token = function () { return localStorage.getItem('ring_token') || ''; };
  var T = function (k, fb) { return window.i18n ? window.i18n.t(k, fb) : fb; };
  var nacl = function () { return window.nacl; };
  var b64e = function (u8) { return nacl().util.encodeBase64(u8); };
  var b64d = function (s) { return nacl().util.decodeBase64(s); };

  function http(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json().catch(function () { return null; }); });
  }

  // ---------- ローカルの鍵 ----------
  function kpName() { return 'e2e_keypair_' + uid(); }
  function ringName() { return 'e2e_keyring_' + uid(); }
  function trustName() { return 'e2e_bk_key_' + uid(); }
  function readJson(name, fb) { try { var v = JSON.parse(localStorage.getItem(name)); return v == null ? fb : v; } catch (e) { return fb; } }
  function pubOf(k) { return b64e(new Uint8Array(k.publicKey)); }

  function localState() {
    var kp = readJson(kpName(), null);
    var ring = readJson(ringName(), []);
    return { keypair: kp, keyring: Array.isArray(ring) ? ring : [] };
  }
  function hasLocalKey() { var s = localState(); return !!(s.keypair || s.keyring.length); }
  function currentPub() {
    var s = localState();
    var k = s.keypair || s.keyring[0];
    return k ? pubOf(k) : null;
  }

  // keyring を「優先する鍵を先頭」にして重複を除いて合成する
  function mergeRing(first, lists) {
    var seen = {}, out = [];
    var all = [first].concat(Array.prototype.concat.apply([], lists));
    all.forEach(function (k) {
      if (!k || !k.publicKey || !k.secretKey) return;
      var p = pubOf(k);
      if (seen[p]) return;
      seen[p] = 1;
      out.push({ publicKey: Array.from(k.publicKey), secretKey: Array.from(k.secretKey) });
    });
    return out.slice(0, 20);
  }

  // ---------- 暗号 ----------
  function deriveKey(pass, salt) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
      .then(function (base) {
        return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: PBKDF2_ITER }, base, 256);
      })
      .then(function (bits) { return new Uint8Array(bits); });
  }

  function seal(obj, key) {
    var nonce = nacl().randomBytes(nacl().secretbox.nonceLength);
    var box = nacl().secretbox(nacl().util.decodeUTF8(JSON.stringify(obj)), nonce, key);
    var full = new Uint8Array(nonce.length + box.length);
    full.set(nonce); full.set(box, nonce.length);
    return b64e(full);
  }
  function open(sealedB64, key) {
    var full = b64d(sealedB64);
    var nonce = full.slice(0, nacl().secretbox.nonceLength);
    var box = full.slice(nacl().secretbox.nonceLength);
    var plain = nacl().secretbox.open(box, nonce, key);
    if (!plain) return null;
    try { return JSON.parse(nacl().util.encodeUTF8(plain)); } catch (e) { return null; }
  }

  // blob = bk1.<正の公開鍵(Base64)>.<salt(Base64)>.<sealed(Base64)>
  function pack(pub, salt, sealed) { return 'bk1.' + pub + '.' + b64e(salt) + '.' + sealed; }
  function unpack(blob) {
    var p = String(blob || '').split('.');
    if (p.length !== 4 || p[0] !== 'bk1') return null;
    return { pub: p[1], salt: b64d(p[2]), saltB64: p[2], sealed: p[3] };
  }

  function payloadFromLocal() {
    var s = localState();
    var canon = s.keypair || s.keyring[0];
    return { keypair: canon, keyring: mergeRing(canon, [s.keyring]) };
  }

  // ---------- 公開API(ロジック) ----------
  async function serverInfo(full) {
    try {
      var r = await http('GET', '/api/friends/key-backup' + (full ? '?full=1' : ''));
      return r && r.exists ? r : { exists: false };
    } catch (e) { return { exists: null }; } // 取得失敗(オフライン等)は「不明」
  }

  async function upload(pass, saltOverride) {
    var salt = saltOverride || nacl().randomBytes(16);
    var key = await deriveKey(pass, salt);
    var payload = payloadFromLocal();
    if (!payload.keypair) throw new Error('no local key');
    var blob = pack(pubOf(payload.keypair), salt, seal(payload, key));
    var r = await http('PUT', '/api/friends/key-backup', { blob: blob });
    if (!r || !r.ok) throw new Error((r && r.error) || 'upload failed');
    // この端末を「信頼済み」にして、以後は鍵が増えたら黙って更新できるようにする
    localStorage.setItem(trustName(), JSON.stringify({ salt: b64e(salt), key: b64e(key) }));
    return true;
  }

  async function restore(pass) {
    var info = await serverInfo(true);
    if (!info.exists) throw new Error('no backup');
    var u = unpack(info.blob);
    if (!u) throw new Error('bad backup');
    var key = await deriveKey(pass, u.salt);
    var data = open(u.sealed, key);
    if (!data || !data.keypair) { var e = new Error('wrong passphrase'); e.code = 'WRONG'; throw e; }

    var s = localState();
    var canon = { publicKey: data.keypair.publicKey, secretKey: data.keypair.secretKey };
    var ring = mergeRing(canon, [data.keyring || [], s.keyring, s.keypair ? [s.keypair] : []]);
    localStorage.setItem(kpName(), JSON.stringify({ publicKey: Array.from(canon.publicKey), secretKey: Array.from(canon.secretKey) }));
    localStorage.setItem(ringName(), JSON.stringify(ring));
    localStorage.setItem(trustName(), JSON.stringify({ salt: u.saltB64, key: b64e(key) }));
    // 公開鍵を戻す。これで相手は以後この鍵宛てに暗号化する
    await http('POST', '/api/friends/publickey', { publicKey: b64e(new Uint8Array(canon.publicKey)) });
    return true;
  }

  // 信頼済みの端末なら、鍵が増えた時にバックアップを黙って更新する
  async function syncIfNeeded() {
    var trust = readJson(trustName(), null);
    if (!trust || !hasLocalKey() || !nacl()) return false;
    var info = await serverInfo(true);
    if (!info.exists) return false;
    var u = unpack(info.blob);
    if (!u) return false;
    if (u.saltB64 !== trust.salt) { localStorage.removeItem(trustName()); return false; } // 別の端末でパスフレーズが変えられた
    var key = b64d(trust.key);
    var data = open(u.sealed, key);
    if (!data) { localStorage.removeItem(trustName()); return false; }
    var s = localState();
    var canon = s.keypair || s.keyring[0];
    var merged = mergeRing(canon, [s.keyring, data.keyring || []]);
    var same = pubOf(canon) === u.pub && merged.length === (data.keyring || []).length;
    if (same) return false;
    var payload = { keypair: canon, keyring: merged };
    var blob = pack(pubOf(canon), u.salt, seal(payload, key));
    var r = await http('PUT', '/api/friends/key-backup', { blob: blob });
    if (r && r.ok) localStorage.setItem(ringName(), JSON.stringify(merged));
    return !!(r && r.ok);
  }

  // ---------- 画面 ----------
  var LOCK_SVG = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>';

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  // mode: 'setup' | 'restore' | 'restore-mismatch'
  function showModal(mode) {
    return new Promise(function (resolve) {
      var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      var fg = dark ? '#f2f2f7' : '#111';
      var card = dark ? '#2c2c2e' : '#fff';
      var sub = dark ? 'rgba(235,235,245,.65)' : 'rgba(60,60,67,.65)';
      var inputBg = dark ? 'rgba(120,120,128,.28)' : 'rgba(120,120,128,.12)';

      var wrap = el('div', 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)');
      var box = el('div', 'width:100%;max-width:360px;background:' + card + ';color:' + fg + ';border-radius:22px;padding:22px 20px 16px;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif');
      var ic = el('div', 'color:#10b981;margin-bottom:8px'); ic.innerHTML = LOCK_SVG; box.appendChild(ic);

      var isSetup = mode === 'setup';
      var title = isSetup ? T('kb_setup_title', '暗号鍵をバックアップ') : T('kb_restore_title', '暗号鍵を復元');
      var body = isSetup
        ? T('kb_setup_body', '別の端末でも過去のメッセージを読めるように、鍵をパスフレーズで暗号化して預けます。パスフレーズはサーバーにも分かりません。忘れると復元できないので、控えておいてください。')
        : (mode === 'restore-mismatch'
          ? T('kb_mismatch_body', 'この端末の鍵が、バックアップの鍵と違っています。このままだと一部のメッセージが読めません。バックアップのパスフレーズを入力すると、鍵が揃います。')
          : T('kb_restore_body', 'この端末にはまだ暗号鍵がありません。バックアップのパスフレーズを入力すると、過去のメッセージが読めるようになります。'));
      box.appendChild(el('div', 'font-size:18px;font-weight:700;margin-bottom:6px', title));
      box.appendChild(el('div', 'font-size:13px;line-height:1.55;color:' + sub + ';margin-bottom:14px', body));

      var inCss = 'width:100%;box-sizing:border-box;border:0;outline:0;border-radius:12px;background:' + inputBg + ';color:' + fg + ';font-size:16px;padding:12px 14px;margin-bottom:8px';
      var p1 = el('input', inCss); p1.type = 'password'; p1.autocomplete = isSetup ? 'new-password' : 'current-password';
      p1.placeholder = T('kb_pass', 'パスフレーズ(8文字以上)');
      box.appendChild(p1);
      var p2 = null;
      if (isSetup) {
        p2 = el('input', inCss); p2.type = 'password'; p2.autocomplete = 'new-password';
        p2.placeholder = T('kb_pass2', 'もう一度入力');
        box.appendChild(p2);
      }
      var msg = el('div', 'min-height:18px;font-size:12.5px;color:#ef4444;margin:2px 2px 8px');
      box.appendChild(msg);

      var btn = el('button', 'width:100%;border:0;border-radius:14px;padding:13px;font-size:16px;font-weight:700;color:#fff;background:#10b981', isSetup ? T('kb_do_setup', '預ける') : T('kb_do_restore', '復元する'));
      btn.type = 'button';
      box.appendChild(btn);

      var row = el('div', 'display:flex;flex-direction:column;gap:2px;margin-top:6px');
      var later = el('button', 'border:0;background:none;color:' + sub + ';font-size:14px;padding:10px', mode === 'restore' ? T('kb_make_new', '新しい鍵を作る(過去のメッセージは読めません)') : T('kb_later', 'あとで'));
      later.type = 'button';
      row.appendChild(later);
      box.appendChild(row);
      wrap.appendChild(box);
      document.body.appendChild(wrap);
      setTimeout(function () { try { p1.focus(); } catch (e) {} }, 50);

      var busy = false;
      function close(result) { try { wrap.remove(); } catch (e) {} resolve(result); }

      btn.onclick = async function () {
        if (busy) return;
        var pass = p1.value;
        msg.textContent = '';
        if (pass.length < MIN_PASS) { msg.textContent = T('kb_err_short', 'パスフレーズは8文字以上にしてください'); return; }
        if (isSetup && pass !== p2.value) { msg.textContent = T('kb_err_match', '2つのパスフレーズが一致しません'); return; }
        busy = true; btn.disabled = true; btn.style.opacity = '.6';
        btn.textContent = T('kb_working', '処理中…');
        try {
          if (isSetup) await upload(pass); else await restore(pass);
          close(isSetup ? 'saved' : 'restored');
        } catch (e) {
          msg.textContent = e && e.code === 'WRONG' ? T('kb_err_wrong', 'パスフレーズが違います') : T('kb_err_fail', '失敗しました。通信を確認してもう一度試してください');
          busy = false; btn.disabled = false; btn.style.opacity = '1';
          btn.textContent = isSetup ? T('kb_do_setup', '預ける') : T('kb_do_restore', '復元する');
        }
      };
      later.onclick = function () {
        if (mode === 'restore') {
          if (!confirm(T('kb_confirm_new', '新しい鍵を作ると、これまでのメッセージはこの端末では読めなくなります。よろしいですか？'))) return;
          close('new');
        } else close('later');
      };
    });
  }

  // ---------- 入口 ----------
  var inFlight = null;

  // 新しい鍵を作る直前に呼ぶ。バックアップがあるなら先に復元を促す。
  // 戻り値: 'restored'(復元できた→鍵を読み直す) | 'new'(新しい鍵を作ってよい)
  function guardCreate() {
    if (inFlight) return inFlight;
    inFlight = (async function () {
      try {
        if (!nacl() || !crypto || !crypto.subtle) return 'new';
        var info = await serverInfo(false);
        if (info.exists === true) {
          if ((await showModal('restore')) === 'restored') {
            // 表示済みの「復号に失敗しました」を直すため、読み込み直す
            setTimeout(function () { try { location.reload(); } catch (e) {} }, 50);
            return 'restored';
          }
          return 'new';
        }
      } catch (e) {}
      return 'new';
    })().then(function (r) { inFlight = null; return r; });
    return inFlight;
  }

  // トーク一覧を開いた時に呼ぶ。状況に合わせて、必要な時だけ案内を出す。
  async function init() {
    try {
      if (!nacl() || !uid() || !token() || !crypto || !crypto.subtle) return;
      var info = await serverInfo(false);
      if (info.exists === null) return;
      var trusted = !!readJson(trustName(), null);
      if (info.exists) {
        if (!hasLocalKey()) { await guardCreate(); return; } // 鍵が無い端末: 復元を促す
        if (trusted) { syncIfNeeded().catch(function () {}); return; }
        // 鍵はあるが、バックアップの鍵と違う端末(別端末で作った鍵)
        var full = await serverInfo(true);
        var u = full.exists ? unpack(full.blob) : null;
        var snooze = Number(localStorage.getItem('e2e_bk_snooze_' + uid()) || 0);
        if (u && u.pub !== currentPub() && Date.now() > snooze) {
          var r = await showModal('restore-mismatch');
          if (r === 'later') localStorage.setItem('e2e_bk_snooze_' + uid(), String(Date.now() + 24 * 3600 * 1000));
          if (r === 'restored') location.reload();
        }
      } else if (hasLocalKey()) {
        // まだバックアップが無く、この端末には鍵がある: 設定を勧める(断られたら3日あけて再度)
        var sn = Number(localStorage.getItem('e2e_bk_snooze_' + uid()) || 0);
        if (Date.now() < sn) return;
        var res = await showModal('setup');
        if (res === 'later') localStorage.setItem('e2e_bk_snooze_' + uid(), String(Date.now() + 3 * 24 * 3600 * 1000));
      }
    } catch (e) { console.warn('[keyBackup] init:', e); }
  }

  window.bcKeyBackup = {
    init: init,
    guardCreate: guardCreate,
    syncIfNeeded: syncIfNeeded,
    // 設定画面から: 'setup' で預け直し(パスフレーズ変更)、'restore' で復元
    openSetup: function () { return showModal('setup'); },
    openRestore: function () { return showModal('restore-mismatch'); },
    status: async function () { var i = await serverInfo(false); return { server: i.exists, local: hasLocalKey(), trusted: !!readJson(trustName(), null) }; },
    // テスト用
    _internal: { upload: upload, restore: restore, mergeRing: mergeRing, pack: pack, unpack: unpack, deriveKey: deriveKey }
  };
})();
