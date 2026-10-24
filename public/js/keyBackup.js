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
  // バックアップの対象:
  //   個人チャット … e2e_keypair_<id>(いまの鍵) と e2e_keyring_<id>(過去の鍵も含む一覧)
  //   グループ     … signal_identity_<id>(グループ鍵を受け取るための身元鍵一式) と
  //                   group_key_<groupId>_v<n>(復号済みのグループ鍵のキャッシュ)
  function kpName() { return 'e2e_keypair_' + uid(); }
  function ringName() { return 'e2e_keyring_' + uid(); }
  function idName() { return 'signal_identity_' + uid(); }
  function trustName() { return 'e2e_bk_key_' + uid(); }
  function readJson(name, fb) { try { var v = JSON.parse(localStorage.getItem(name)); return v == null ? fb : v; } catch (e) { return fb; } }
  function pubOf(k) { return b64e(new Uint8Array(k.publicKey)); }

  function localGroupKeys() {
    var out = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (/^group_key_[^_]+.*_v\d+$/.test(k)) {
        var v = readJson(k, null);
        if (Array.isArray(v) && v.length === 32) out[k] = v;
      }
    }
    return out;
  }

  function localState() {
    var kp = readJson(kpName(), null);
    var ring = readJson(ringName(), []);
    return { keypair: kp, keyring: Array.isArray(ring) ? ring : [], identity: readJson(idName(), null), groupKeys: localGroupKeys() };
  }
  function hasLocalKey() { var s = localState(); return !!(s.keypair || s.keyring.length || s.identity); }
  function currentPub() {
    var s = localState();
    var k = s.keypair || s.keyring[0];
    return k ? pubOf(k) : null;
  }
  function identityPub(id) { return id && id.identity && id.identity.publicKey ? String(id.identity.publicKey) : null; }

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

  // blob = bk1.<個人鍵の公開鍵 or ->.<salt>.<sealed>[.<グループ身元鍵の公開鍵 or ->]
  // (末尾の5つ目は後から足した。4つだけの古いバックアップも読める)
  function pack(pub, salt, sealed, idpub) { return 'bk1.' + (pub || '-') + '.' + b64e(salt) + '.' + sealed + '.' + (idpub || '-'); }
  function unpack(blob) {
    var p = String(blob || '').split('.');
    if ((p.length !== 4 && p.length !== 5) || p[0] !== 'bk1') return null;
    return { pub: p[1] === '-' ? null : p[1], salt: b64d(p[2]), saltB64: p[2], sealed: p[3], idpub: p[4] && p[4] !== '-' ? p[4] : null };
  }

  function payloadFromLocal() {
    var s = localState();
    var canon = s.keypair || s.keyring[0] || null;
    return {
      keypair: canon,
      keyring: canon ? mergeRing(canon, [s.keyring]) : [],
      identity: s.identity,
      groupKeys: s.groupKeys
    };
  }

  // ---------- 公開API(ロジック) ----------
  async function serverInfo(full) {
    try {
      var r = await http('GET', '/api/friends/key-backup' + (full ? '?full=1' : ''));
      return r && r.exists ? r : { exists: false };
    } catch (e) { return { exists: null }; } // 取得失敗(オフライン等)は「不明」
  }

  async function upload(pass, saltOverride, strong) {
    var salt = saltOverride || nacl().randomBytes(16);
    var key = await deriveKey(pass, salt);
    var payload = payloadFromLocal();
    if (!payload.keypair && !payload.identity) throw new Error('no local key');
    // パスフレーズを変える時、ほかの端末だけが持っていた鍵がバックアップから消えないよう、今のバックアップと混ぜてから預け直す
    // (この端末が今のバックアップを開ける時だけ。開けなければこの端末の分だけになる)
    try {
      var trust = readJson(trustName(), null);
      var cur = trust ? await serverInfo(true) : null;
      var cu = cur && cur.exists ? unpack(cur.blob) : null;
      var old = cu && cu.saltB64 === trust.salt ? open(cu.sealed, b64d(trust.key)) : null;
      if (old) {
        if (payload.keypair) payload.keyring = mergeRing(payload.keypair, [payload.keyring, old.keyring || []]);
        payload.groupKeys = Object.assign({}, old.groupKeys || {}, payload.groupKeys || {});
        if (!payload.identity && old.identity) payload.identity = old.identity;
      }
    } catch (e) {}
    var blob = pack(payload.keypair ? pubOf(payload.keypair) : null, salt, seal(payload, key), identityPub(payload.identity));
    var r = await http('PUT', '/api/friends/key-backup', { blob: blob, strong: !!strong });
    if (!r || !r.ok) throw new Error((r && r.error) || 'upload failed');
    // この端末を「信頼済み」にして、以後は鍵が増えたら黙って更新できるようにする
    localStorage.setItem(trustName(), JSON.stringify({ salt: b64e(salt), key: b64e(key) }));
    return true;
  }

  // 復元したグループ用の身元鍵を、サーバーの登録にも反映する
  // (サーバーの登録が別の端末の鍵のままだと、これから届くグループ鍵がこの端末では開けない)
  async function publishIdentity(id) {
    if (!id || !id.identity || !id.signedPrekey) return;
    var cur = await http('GET', '/api/prekeys/identity/' + uid());
    if (cur && cur.identityPubkey === id.identity.publicKey) return; // もう同じ
    var otks = (id.oneTimePrekeys || []).slice(-20).map(function (k) { return { keyId: k.keyId, pubkey: k.publicKey }; });
    await http('POST', '/api/prekeys/upload', {
      identityPubkey: id.identity.publicKey,
      signingPubkey: id.signing && id.signing.publicKey,
      signedPrekeyPub: id.signedPrekey.publicKey,
      signedPrekeySig: id.signedPrekey.signature,
      registrationId: Math.floor(Math.random() * 1e9),
      oneTimePrekeys: otks
    });
  }

  async function restore(pass) {
    var info = await serverInfo(true);
    if (!info.exists) throw new Error('no backup');
    var u = unpack(info.blob);
    if (!u) throw new Error('bad backup');
    var key = await deriveKey(pass, u.salt);
    var data = open(u.sealed, key);
    if (!data || (!data.keypair && !data.identity)) { var e = new Error('wrong passphrase'); e.code = 'WRONG'; throw e; }

    var s = localState();
    // 個人チャットの鍵
    if (data.keypair) {
      var canon = { publicKey: data.keypair.publicKey, secretKey: data.keypair.secretKey };
      var ring = mergeRing(canon, [data.keyring || [], s.keyring, s.keypair ? [s.keypair] : []]);
      localStorage.setItem(kpName(), JSON.stringify({ publicKey: Array.from(canon.publicKey), secretKey: Array.from(canon.secretKey) }));
      localStorage.setItem(ringName(), JSON.stringify(ring));
      // 公開鍵を戻す。これで相手は以後この鍵宛てに暗号化する
      await http('POST', '/api/friends/publickey', { publicKey: b64e(new Uint8Array(canon.publicKey)) });
    }
    // グループの身元鍵とグループ鍵
    if (data.identity) {
      localStorage.setItem(idName(), JSON.stringify(data.identity));
      await publishIdentity(data.identity);
    }
    var gk = data.groupKeys || {};
    Object.keys(gk).forEach(function (k) {
      if (/^group_key_[^_]+.*_v\d+$/.test(k) && Array.isArray(gk[k]) && gk[k].length === 32 && localStorage.getItem(k) == null) {
        localStorage.setItem(k, JSON.stringify(gk[k]));
      }
    });
    localStorage.setItem(trustName(), JSON.stringify({ salt: u.saltB64, key: b64e(key) }));
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
    var canon = s.keypair || s.keyring[0] || (data.keypair || null);
    var merged = canon ? mergeRing(canon, [s.keyring, data.keyring || []]) : [];
    // 身元鍵は、この端末の方が新しければ(=バックアップと違えば)この端末のものを正とする
    var identity = s.identity || data.identity || null;
    var groupKeys = Object.assign({}, data.groupKeys || {}, s.groupKeys);

    var sameKeys = (canon ? pubOf(canon) : null) === (u.pub || null) && merged.length === (data.keyring || []).length;
    var sameId = identityPub(identity) === (u.idpub || null);
    var sameGroups = Object.keys(groupKeys).length === Object.keys(data.groupKeys || {}).length;
    if (sameKeys && sameId && sameGroups) return false;

    var payload = { keypair: canon, keyring: merged, identity: identity, groupKeys: groupKeys };
    var blob = pack(canon ? pubOf(canon) : null, u.salt, seal(payload, key), identityPub(identity));
    var r = await http('PUT', '/api/friends/key-backup', { blob: blob });
    if (r && r.ok && canon) localStorage.setItem(ringName(), JSON.stringify(merged));
    return !!(r && r.ok);
  }

  // グループ鍵を新しく手に入れた直後などに呼ぶ(数秒まとめて1回だけ同期する)
  var syncTimer = null;
  function syncSoon() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () { syncTimer = null; syncIfNeeded().catch(function () {}); }, 4000);
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

      var isSetup = mode === 'setup' || mode === 'upgrade' || mode === 'signup';
      var title = isSetup ? T('kb_setup_title', '暗号鍵をバックアップ') : T('kb_restore_title', '暗号鍵を復元');
      if (mode === 'upgrade') title = T('kb_upgrade_title', 'パスフレーズを強くしてください');
      if (mode === 'signup') title = T('kb_signup_title', '暗号鍵を設定しましょう');
      var body = mode === 'upgrade'
        ? T('kb_upgrade_body', '今のバックアップは、前の基準(8文字以上)のパスフレーズで預けられています。短いと、万一サーバーのデータが漏れた時に総当たりで破られるおそれがあります。新しいパスフレーズで預け直すと、古いバックアップは置き換わります。')
        : mode === 'signup'
        ? T('kb_signup_body', 'アカウントができました。メッセージはこの端末の鍵で暗号化されます。鍵をパスフレーズで暗号化して預けておくと、機種変更や別の端末でも過去のメッセージが読めます。パスフレーズはサーバーにも分かりません。忘れると復元できないので控えてください。')
        : isSetup
        ? T('kb_setup_body', '別の端末でも過去のメッセージを読めるように、鍵をパスフレーズで暗号化して預けます。パスフレーズはサーバーにも分かりません。忘れると復元できないので、控えておいてください。')
        : (mode === 'restore-mismatch'
          ? T('kb_mismatch_body', 'この端末の鍵が、バックアップの鍵と違っています。このままだと一部のメッセージが読めません。バックアップのパスフレーズを入力すると、鍵が揃います。')
          : T('kb_restore_body', 'この端末にはまだ暗号鍵がありません。バックアップのパスフレーズを入力すると、過去のメッセージが読めるようになります。'));
      box.appendChild(el('div', 'font-size:18px;font-weight:700;margin-bottom:6px', title));
      box.appendChild(el('div', 'font-size:13px;line-height:1.55;color:' + sub + ';margin-bottom:14px', body));

      var inCss = 'width:100%;box-sizing:border-box;border:0;outline:0;border-radius:12px;background:' + inputBg + ';color:' + fg + ';font-size:16px;padding:12px 14px;margin-bottom:8px';
      var p1 = el('input', inCss); p1.type = 'password'; p1.autocomplete = isSetup ? 'new-password' : 'current-password';
      p1.placeholder = isSetup ? T('kb_pass_strong', 'パスフレーズ(12文字以上)') : T('kb_pass', 'パスフレーズ');
      box.appendChild(p1);
      var p2 = null;
      if (isSetup) {
        p2 = el('input', inCss); p2.type = 'password'; p2.autocomplete = 'new-password';
        p2.placeholder = T('kb_pass2', 'もう一度入力');
        box.appendChild(p2);
        // 自分で考えると弱くなりがちなので、強いものを作るボタン(約93ビット)。作ったら見えるようにして控えてもらう
        var gen = el('button', 'border:0;background:none;color:#10b981;font-size:13px;font-weight:700;padding:2px 2px 8px;cursor:pointer;text-align:left', T('kb_generate', '強いパスフレーズを自動で作る'));
        gen.type = 'button';
        gen.onclick = function () { var v = genPass(); p1.value = v; p2.value = v; p1.type = 'text'; p2.type = 'text'; msg.style.color = sub; msg.textContent = T('kb_generated', 'これを必ず控えてください(スクショやメモ)。忘れると復元できません'); };
        box.appendChild(gen);
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
        msg.style.color = '#ef4444';
        if (isSetup) { var weak = weakReason(pass); if (weak) { msg.textContent = weak; return; } }
        else if (pass.length < MIN_PASS) { msg.textContent = T('kb_err_short', 'パスフレーズは8文字以上にしてください'); return; }
        if (isSetup && pass !== p2.value) { msg.textContent = T('kb_err_match', '2つのパスフレーズが一致しません'); return; }
        busy = true; btn.disabled = true; btn.style.opacity = '.6';
        btn.textContent = T('kb_working', '処理中…');
        try {
          if (isSetup) await upload(pass, null, !weakReason(pass)); else await restore(pass);
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

  // ---------- パスフレーズの強さ ----------
  // サーバーのデータが漏れた時、弱いパスフレーズは総当たりで破られて過去のメッセージが全部読まれる。
  // 以前は8文字以上なら何でも通していた。新しく預ける時は、12文字以上で推測されにくいものだけにする
  var COMMON = ['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'asdfghjkl', 'iloveyou', 'abcdefg', 'abc123', 'letmein', 'welcome', 'monkey', 'dragon', 'brochat', 'bro chat', 'admin', 'sakura', 'tokyo', 'japan'];
  function weakReason(p) {
    var s = String(p || '');
    if (s.length < 12) return T('kb_err_short12', 'パスフレーズは12文字以上にしてください');
    var low = s.toLowerCase();
    if (/^(.)\1+$/.test(s) || new Set(s).size < 5) return T('kb_err_simple', '同じ文字の繰り返しが多すぎます');
    var seq = '0123456789abcdefghijklmnopqrstuvwxyz';
    for (var i = 0; i + 6 <= low.length; i++) { var c = low.slice(i, i + 6); if (seq.indexOf(c) >= 0 || '9876543210'.indexOf(c) >= 0) return T('kb_err_seq', '並んだ文字や数字(123456、abcdef など)は使えません'); }
    for (var j = 0; j < COMMON.length; j++) if (low.indexOf(COMMON[j]) >= 0) return T('kb_err_common', 'よく使われる言葉が入っています。ほかのものにしてください');
    var me = [String(localStorage.getItem('ring_username') || '').split('@')[0], String(localStorage.getItem('ring_display_name') || ''), String(localStorage.getItem('ring_userIdCode') || '')];
    for (var k = 0; k < me.length; k++) if (me[k] && me[k].length >= 4 && low.indexOf(me[k].toLowerCase()) >= 0) return T('kb_err_me', '自分の名前・ID・メールアドレスは入れないでください');
    var classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(function (r) { return r.test(s); }).length;
    if (s.length < 16 && classes < 2) return T('kb_err_classes', '16文字未満なら、英字・数字・記号を混ぜてください');
    return null;
  }
  function genPass() {
    var A = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 見間違えやすい l,o,I,O,0,1 は除く
    // 56文字から偏りなく選ぶ(256は56で割り切れないので、224以上の値は捨てて引き直す)。16文字で約93ビット
    var out = '', n = 0, b = new Uint8Array(32);
    while (n < 16) {
      crypto.getRandomValues(b);
      for (var i = 0; i < b.length && n < 16; i++) {
        if (b[i] >= 224) continue;
        out += A[b[i] % A.length]; n++;
        if (n % 4 === 0 && n < 16) out += '-';
      }
    }
    return out;
  }

  // ---------- ログアウト時の鍵の扱い ----------
  // 預けたバックアップが、この端末の鍵を全部含んでいるか(=端末から消しても復元で戻せるか)。
  // 信頼済みの端末で、最新の鍵を預け直した上で、実際に開いて中身を確かめる。確かめられなければ false
  async function backupCoversLocal() {
    var trust = readJson(trustName(), null);
    if (!trust) return false;
    try { await syncIfNeeded(); } catch (e) {}
    var info = await serverInfo(true);
    if (!info.exists) return false;
    var u = unpack(info.blob);
    if (!u || u.saltB64 !== trust.salt) return false;
    var data = open(u.sealed, b64d(trust.key));
    if (!data) return false;

    var s = localState();
    var have = {};
    (data.keyring || []).concat(data.keypair ? [data.keypair] : []).forEach(function (k) { if (k && k.publicKey) have[pubOf(k)] = 1; });
    var mine = s.keyring.concat(s.keypair ? [s.keypair] : []);
    for (var i = 0; i < mine.length; i++) if (!have[pubOf(mine[i])]) return false;
    if (s.identity && identityPub(data.identity) !== identityPub(s.identity)) return false;
    var gk = data.groupKeys || {};
    for (var name in s.groupKeys) if (!gk[name]) return false;
    return true;
  }

  // ログアウトの前に呼ぶ。端末の暗号鍵を消してよいかを決める。
  //   'wipe'   … バックアップに全部入っていると確かめられた。鍵を端末から消す(共用の端末・紛失に備える)
  //   'keep'   … 確かめられない/バックアップが無い。消すと過去のメッセージが読めなくなるので、鍵は端末に残す
  //   'cancel' … 本人がログアウトをやめた
  async function logoutPlan() {
    try {
      if (!nacl() || !crypto || !crypto.subtle) return 'keep';
      var s = localState();
      if (!s.keypair && !s.keyring.length && !s.identity) return 'keep'; // 消すものが無い
      if (await backupCoversLocal()) return 'wipe';
    } catch (e) {}
    return confirm(T('kb_logout_nobackup', 'この端末の暗号鍵は、まだバックアップされていません。このままログアウトすると鍵は端末に残ります(共用の端末では、先にバックアップを作ってください)。ログアウトしますか？')) ? 'keep' : 'cancel';
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

  // 登録した直後に auth.html が付ける印
  var NEW_ACCOUNT = 'bc_new_account';

  // 個人チャットの鍵が端末にあるようにする(別の処理が作っている最中なら、同じ処理を待つ)。
  // 登録直後は鍵がまだ無いことがあり、鍵が無いままだと預けるものが無い
  async function ensureLocalKey() {
    var s = localState();
    if (!s.keypair && !s.keyring.length && typeof window.getOrCreateMyKeyPair === 'function') {
      try { await window.getOrCreateMyKeyPair(); } catch (e) {}
    }
    return hasLocalKey();
  }

  // トーク一覧を開いた時に呼ぶ。状況に合わせて、必要な時だけ案内を出す。
  async function init() {
    try {
      if (!nacl() || !uid() || !token() || !crypto || !crypto.subtle) return;
      var info = await serverInfo(false);
      if (info.exists === null) return;
      if (info.exists) localStorage.removeItem(NEW_ACCOUNT); // もうバックアップがあるなら、登録直後の案内は要らない
      var trusted = !!readJson(trustName(), null);
      if (info.exists) {
        if (!hasLocalKey()) { await guardCreate(); return; } // 鍵が無い端末: 復元を促す
        if (trusted) {
          syncIfNeeded().catch(function () {});
          // 前の基準(8文字以上)で預けたバックアップは、強いパスフレーズで預け直してもらう(断られたら7日あける)
          var usn = Number(localStorage.getItem('e2e_bk_upgrade_snooze_' + uid()) || 0);
          if (info.strong === false && Date.now() > usn) {
            var ur = await showModal('upgrade');
            if (ur !== 'saved') localStorage.setItem('e2e_bk_upgrade_snooze_' + uid(), String(Date.now() + 7 * 24 * 3600 * 1000));
          }
          return;
        }
        // 鍵はあるが、バックアップの鍵と違う端末(別端末で作った鍵)
        var full = await serverInfo(true);
        var u = full.exists ? unpack(full.blob) : null;
        var snooze = Number(localStorage.getItem('e2e_bk_snooze_' + uid()) || 0);
        var s0 = localState();
        var personalDiff = u && u.pub && s0.keypair && u.pub !== currentPub();
        var groupDiff = u && u.idpub && s0.identity && u.idpub !== identityPub(s0.identity);
        if (u && (personalDiff || groupDiff) && Date.now() > snooze) {
          var r = await showModal('restore-mismatch');
          if (r === 'later') localStorage.setItem('e2e_bk_snooze_' + uid(), String(Date.now() + 24 * 3600 * 1000));
          if (r === 'restored') location.reload();
        }
      } else {
        // まだバックアップが無い。登録した直後(auth.html が印を付ける)なら、鍵ができるのを待って、
        // 登録の流れとしてバックアップの設定まで案内する。それ以外は、鍵がある端末にだけ勧める
        var fresh = localStorage.getItem(NEW_ACCOUNT) === '1';
        if (fresh) await ensureLocalKey();
        if (!hasLocalKey()) return; // 鍵がまだ作れていなければ印を残して、次に開いた時にやり直す
        // 断られたら、登録直後は1日、それ以外は3日あけて再度
        var sn = Number(localStorage.getItem('e2e_bk_snooze_' + uid()) || 0);
        if (!fresh && Date.now() < sn) return;
        if (fresh) localStorage.removeItem(NEW_ACCOUNT);
        var res = await showModal(fresh ? 'signup' : 'setup');
        if (res === 'later') localStorage.setItem('e2e_bk_snooze_' + uid(), String(Date.now() + (fresh ? 1 : 3) * 24 * 3600 * 1000));
      }
    } catch (e) { console.warn('[keyBackup] init:', e); }
  }

  window.bcKeyBackup = {
    init: init,
    guardCreate: guardCreate,
    syncIfNeeded: syncIfNeeded,
    syncSoon: syncSoon,
    logoutPlan: logoutPlan,
    // 設定画面から: 'setup' で預け直し(パスフレーズ変更)、'restore' で復元
    openSetup: function () { return showModal('setup'); },
    openRestore: function () { return showModal('restore-mismatch'); },
    status: async function () { var i = await serverInfo(false); return { server: i.exists, local: hasLocalKey(), trusted: !!readJson(trustName(), null) }; },
    // テスト用
    _internal: { upload: upload, restore: restore, mergeRing: mergeRing, pack: pack, unpack: unpack, deriveKey: deriveKey, backupCoversLocal: backupCoversLocal }
  };
})();
