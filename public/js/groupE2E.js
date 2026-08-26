// groupE2E.js
// -----------------------------------------------------------------------
// グループチャットのE2E暗号化を統合するモジュール。
// signalkeymanager.js (X3DH の数学的なコア) と、サーバーの
// /api/prekeys/* および /api/groups/* エンドポイントを繋ぎ合わせ、
// 「グループ共有鍵を各メンバーに安全に配布し、その鍵でメッセージ/メディアを
// 暗号化・復号する」という実際のフローを提供する。
//
// 依存: libsodium-wrappers.min.js, signalkeymanager.js (この順で先に読み込む)
// -----------------------------------------------------------------------

(function () {
  const IDENTITY_STORAGE_KEY_PREFIX = 'signal_identity_';
  const GROUP_KEY_STORAGE_PREFIX = 'group_key_'; // group_key_<groupId>_v<version>

  let myFullBundle = null; // 端末内にのみ保存する秘密鍵一式

  // --- 自分の鍵バンドルを取得(なければ生成)し、公開鍵部分をサーバーに登録する ---
  async function ensureMyIdentity() {
    if (myFullBundle) return myFullBundle;
    if (!window.myUserId) throw new Error('myUserId is not defined');
    if (!window.RingSignalKeyManager) throw new Error('signalkeymanager.js not loaded');

    const storageKey = IDENTITY_STORAGE_KEY_PREFIX + window.myUserId;
    const stored = localStorage.getItem(storageKey);

    if (stored) {
      myFullBundle = JSON.parse(stored);
      // ワンタイム鍵の残数が少なければサーバーへ補充する
      try {
        const countRes = await api('/api/prekeys/count');
        if (countRes && countRes.remaining < 5) {
          await replenishOneTimeKeys();
        }
      } catch (e) {
        console.warn('[groupE2E] prekey count check failed:', e);
      }
      return myFullBundle;
    }

    // 初回: 鍵一式を生成してローカルに保存し、公開鍵だけサーバーへ送る
    const bundle = await window.RingSignalKeyManager.generateKeyBundle(20);
    myFullBundle = bundle;
    localStorage.setItem(storageKey, JSON.stringify(bundle));

    await api('/api/prekeys/upload', {
      method: 'POST',
      body: JSON.stringify({
        identityPubkey: bundle.identity.publicKey,
        signingPubkey: bundle.signing.publicKey,
        signedPrekeyPub: bundle.signedPrekey.publicKey,
        signedPrekeySig: bundle.signedPrekey.signature,
        registrationId: Math.floor(Math.random() * 1e9),
        // { keyId, pubkey } 形式で送り、サーバーがこのkeyIdでDBに格納する
        oneTimePrekeys: bundle.oneTimePrekeys.map(k => ({ keyId: k.keyId, pubkey: k.publicKey })),
      }),
    });

    return myFullBundle;
  }

  async function replenishOneTimeKeys() {
    const sodium = await (async () => { await window.sodium.ready; return window.sodium; })();

    // 補充時のkeyIdは既存エントリの最大値+1から採番する
    const currentMaxKeyId = myFullBundle.oneTimePrekeys.reduce(
      (max, k) => (k.keyId != null && k.keyId > max ? k.keyId : max), -1
    );

    const newKeys = [];
    for (let i = 0; i < 20; i++) {
      const kp = sodium.crypto_box_keypair();
      newKeys.push({
        keyId: currentMaxKeyId + 1 + i,
        publicKey: sodium.to_base64(kp.publicKey),
        privateKey: sodium.to_base64(kp.privateKey),
      });
    }

    // ローカル保存分にも追加(x3dhRespondで使う可能性があるため)
    myFullBundle.oneTimePrekeys.push(...newKeys);
    localStorage.setItem(IDENTITY_STORAGE_KEY_PREFIX + window.myUserId, JSON.stringify(myFullBundle));

    await api('/api/prekeys/upload', {
      method: 'POST',
      body: JSON.stringify({
        identityPubkey: myFullBundle.identity.publicKey,
        signedPrekeyPub: myFullBundle.signedPrekey.publicKey,
        signedPrekeySig: myFullBundle.signedPrekey.signature,
        // { keyId, pubkey } 形式で送り、サーバーがこのkeyIdで格納する
        oneTimePrekeys: newKeys.map(k => ({ keyId: k.keyId, pubkey: k.publicKey })),
      }),
    });
  }

  // --- 新しいランダムなグループ鍵(32byte)を生成 ---
  async function generateGroupKey() {
    await window.sodium.ready;
    return window.sodium.crypto_secretbox_keygen();
  }

  // signed prekey の署名を検証する。これが無いと、サーバーやMITM攻撃者が
  // 偽のsignedPrekeyPubを返してもクライアントは気づかずX3DHを実行してしまう
  // (署名者本人以外にはsigningの秘密鍵を知りようがないため、検証をパスした
  //  signedPrekeyは確かにidentityPubkeyの持ち主が発行したものだと保証できる)。
  async function verifySignedPrekey(bundle) {
    const sodium = await (async () => { await window.sodium.ready; return window.sodium; })();
    if (!bundle.signingPubkey) {
      // 過去に登録された鍵にはsigningPubkeyが無い(移行期間中の後方互換)。
      // 検証できない場合は安全側に倒し、警告を出しつつ許容する。
      console.warn('[groupE2E] signingPubkey missing for bundle - signature cannot be verified (legacy key?)');
      return true;
    }
    const signingPubkey = sodium.from_base64(bundle.signingPubkey);
    const signedPrekeyPub = sodium.from_base64(bundle.signedPrekeyPub);
    const signature = sodium.from_base64(bundle.signedPrekeySig);
    return sodium.crypto_sign_verify_detached(signature, signedPrekeyPub, signingPubkey);
  }

  // --- グループ鍵を、指定した1人のメンバー宛にX3DHで暗号化する ---
  // 戻り値をそのまま group_key_distributions.encrypted_group_key (JSON文字列) に保存する
  async function encryptGroupKeyForMember(groupKeyBytes, targetUserId) {
    const sodium = await (async () => { await window.sodium.ready; return window.sodium; })();
    await ensureMyIdentity();

    // 自分自身への配布は、X3DHで鍵バンドルを消費する意味がない
    // (相手=自分の身元鍵で自分の秘密鍵を使って暗号化するだけの単純なケース)。
    // identity keypair自体をDH鍵として使い、自分の公開鍵宛にsecretboxする。
    if (targetUserId === window.myUserId) {
      const myIdPriv = sodium.from_base64(myFullBundle.identity.privateKey);
      const myIdPub = sodium.from_base64(myFullBundle.identity.publicKey);
      const sharedSecret = sodium.crypto_generichash(32, sodium.crypto_scalarmult(myIdPriv, myIdPub));
      const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
      const ciphertext = sodium.crypto_secretbox_easy(groupKeyBytes, nonce, sharedSecret);
      return JSON.stringify({
        ciphertext: sodium.to_base64(ciphertext),
        nonce: sodium.to_base64(nonce),
        selfEncrypted: true,
        fromUserId: window.myUserId,
      });
    }

    // 相手の鍵バンドルをサーバーから取得(ワンタイム鍵を1つ消費する)
    // NOTE: api()ヘルパーはHTTPステータスに関わらずJSONをそのまま返すため、
    // 404時は{error:'...'}が返る(nullにはならない)。identityPubkeyの有無で判定する。
    const theirBundle = await api('/api/prekeys/bundle/' + targetUserId);
    if (!theirBundle || !theirBundle.identityPubkey) {
      throw new Error('相手の鍵バンドルが見つかりません: ' + targetUserId + (theirBundle && theirBundle.error ? ' (' + theirBundle.error + ')' : ''));
    }

    // signed prekey の署名検証(なりすまし・改竄防止)。ここを通らない鍵バンドルは
    // 信頼できないため、X3DHを実行せず即座に失敗させる。
    const isValid = await verifySignedPrekey(theirBundle);
    if (!isValid) {
      throw new Error('相手の鍵の署名検証に失敗しました。なりすましの可能性があるため処理を中断します: ' + targetUserId);
    }

    const x3dhResult = await window.RingSignalKeyManager.x3dhInitiate(myFullBundle, theirBundle);
    const sharedSecret = sodium.from_base64(x3dhResult.sharedSecret);

    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(groupKeyBytes, nonce, sharedSecret);

    return JSON.stringify({
      ciphertext: sodium.to_base64(ciphertext),
      nonce: sodium.to_base64(nonce),
      ephemeralPublicKey: x3dhResult.ephemeralPublicKey,
      usedOneTimeKeyId: x3dhResult.usedOneTimeKeyId,
      fromUserId: window.myUserId,
    });
  }

  // --- 自分宛に配布されたグループ鍵を復号する ---
  async function decryptGroupKey(encryptedGroupKeyJson) {
    const sodium = await (async () => { await window.sodium.ready; return window.sodium; })();
    await ensureMyIdentity();

    const payload = JSON.parse(encryptedGroupKeyJson);

    if (payload.selfEncrypted) {
      const myIdPriv = sodium.from_base64(myFullBundle.identity.privateKey);
      const myIdPub = sodium.from_base64(myFullBundle.identity.publicKey);
      const sharedSecret = sodium.crypto_generichash(32, sodium.crypto_scalarmult(myIdPriv, myIdPub));
      const ciphertext = sodium.from_base64(payload.ciphertext);
      const nonce = sodium.from_base64(payload.nonce);
      const groupKey = sodium.crypto_secretbox_open_easy(ciphertext, nonce, sharedSecret);
      if (!groupKey) throw new Error('グループ鍵の復号に失敗しました(自己配布分)');
      return groupKey;
    }

    const sharedSecretB64 = await window.RingSignalKeyManager.x3dhRespond(
      myFullBundle,
      await getIdentityPubkeyOf(payload.fromUserId),
      payload.ephemeralPublicKey,
      payload.usedOneTimeKeyId
    );
    const sharedSecret = sodium.from_base64(sharedSecretB64);

    const ciphertext = sodium.from_base64(payload.ciphertext);
    const nonce = sodium.from_base64(payload.nonce);
    const groupKey = sodium.crypto_secretbox_open_easy(ciphertext, nonce, sharedSecret);
    if (!groupKey) throw new Error('グループ鍵の復号に失敗しました');
    return groupKey; // Uint8Array(32)
  }

  // 配布者(fromUserId)のidentity公開鍵を取得する。x3dhRespondの計算に必要。
  // NOTE: /api/prekeys/bundle は使い捨て鍵(OTK)を消費するため、
  // identity鍵のみが目的の場合は /api/prekeys/identity を使う。
  const identityPubkeyCache = new Map();
  async function getIdentityPubkeyOf(userId) {
    if (identityPubkeyCache.has(userId)) return identityPubkeyCache.get(userId);
    const bundle = await api('/api/prekeys/identity/' + userId);
    if (!bundle || !bundle.identityPubkey) {
      throw new Error('配布者の鍵情報が見つかりません: ' + userId);
    }
    const isValid = await verifySignedPrekey(bundle);
    if (!isValid) {
      throw new Error('配布者の鍵の署名検証に失敗しました。なりすましの可能性があるため処理を中断します: ' + userId);
    }
    identityPubkeyCache.set(userId, bundle.identityPubkey);
    return bundle.identityPubkey;
  }

  // --- グループの現在の鍵を取得する(ローカルキャッシュ→無ければサーバーから取得して復号) ---
  async function getGroupKey(groupId) {
    // まずサーバーに現在のkeyVersionを問い合わせ、ローカルキャッシュと突き合わせる
    const myKeyRes = await api('/api/groups/' + groupId + '/my-key');
    if (!myKeyRes || !myKeyRes.encryptedGroupKey) {
      throw new Error('グループ鍵が見つかりません（まだ配布されていない可能性があります）');
    }

    const cacheKey = GROUP_KEY_STORAGE_PREFIX + groupId + '_v' + myKeyRes.keyVersion;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      return { key: new Uint8Array(JSON.parse(cached)), version: myKeyRes.keyVersion };
    }

    const groupKey = await decryptGroupKey(myKeyRes.encryptedGroupKey);
    localStorage.setItem(cacheKey, JSON.stringify(Array.from(groupKey)));
    return { key: groupKey, version: myKeyRes.keyVersion };
  }

  // --- グループ鍵でテキストを暗号化 ---
  async function encryptGroupText(plaintext, groupKey) {
    await window.sodium.ready;
    const sodium = window.sodium;
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const data = sodium.from_string(plaintext);
    const ciphertext = sodium.crypto_secretbox_easy(data, nonce, groupKey);
    return JSON.stringify({
      ciphertext: sodium.to_base64(ciphertext),
      nonce: sodium.to_base64(nonce),
    });
  }

  // --- グループ鍵でテキストを復号 ---
  async function decryptGroupText(encryptedJson, groupKey) {
    await window.sodium.ready;
    const sodium = window.sodium;
    const payload = JSON.parse(encryptedJson);
    const ciphertext = sodium.from_base64(payload.ciphertext);
    const nonce = sodium.from_base64(payload.nonce);
    const decrypted = sodium.crypto_secretbox_open_easy(ciphertext, nonce, groupKey);
    if (!decrypted) throw new Error('復号に失敗しました');
    return sodium.to_string(decrypted);
  }

  // --- グループ作成時: 作成者が新規グループ鍵を生成し、初期メンバー全員分を暗号化する ---
  // 戻り値をそのまま /api/groups/create の body.encryptedKeysForMembers に渡せる形にする
  async function createInitialGroupKeyDistribution(memberIds) {
    const groupKey = await generateGroupKey();
    const distributions = [];
    for (const uid of memberIds) {
      distributions.push({ userId: uid, encryptedGroupKey: await encryptGroupKeyForMember(groupKey, uid) });
    }
    return { groupKey, distributions };
  }

  window.groupE2E = {
    ensureMyIdentity,
    generateGroupKey,
    encryptGroupKeyForMember,
    decryptGroupKey,
    getGroupKey,
    encryptGroupText,
    decryptGroupText,
    createInitialGroupKeyDistribution,
  };
})();
