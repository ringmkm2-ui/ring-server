// js/e2eKeys.js
// E2E暗号化用の鍵ペア管理（admin.html と groupchat.html で共有）

let myKeyPair = null;

let _kpPromise = null;
function getOrCreateMyKeyPair() {
  // 同時に何度呼ばれても、鍵の生成・復元は1回だけ走らせる(復元の確認中に別々の鍵が作られないように)
  if (myKeyPair) return Promise.resolve(myKeyPair);
  if (!_kpPromise) _kpPromise = _getOrCreateMyKeyPair().finally(() => { _kpPromise = null; });
  return _kpPromise;
}
async function _getOrCreateMyKeyPair() {
  if (myKeyPair) return myKeyPair;

  // myUserId は各ページで定義されていることを想定
  if (!window.myUserId) {
    throw new Error('myUserId is not defined');
  }

  const keyStorageName = `e2e_keypair_${window.myUserId}`;
  const keyringName = `e2e_keyring_${window.myUserId}`;
  let keyStr = localStorage.getItem(keyStorageName);

  // keypair本体が消えていても keyring に過去の鍵が残っていれば復活させる
  // (新しい鍵を作ると過去メッセージが全滅するので最終手段にする)
  if (!keyStr) {
    try {
      const ring = JSON.parse(localStorage.getItem(keyringName) || '[]');
      if (ring.length) {
        keyStr = JSON.stringify(ring[0]);
        localStorage.setItem(keyStorageName, keyStr);
      }
    } catch (e) {}
  }

  // 鍵が無い端末で勝手に新しい鍵を作ると、公開鍵の登録を上書きして他の端末のメッセージが読めなくなる。
  // バックアップがあるなら、作る前に復元を促す(keyBackup.js)
  if (!keyStr && window.bcKeyBackup) {
    try {
      if ((await window.bcKeyBackup.guardCreate()) === 'restored') keyStr = localStorage.getItem(keyStorageName);
    } catch (e) {}
  }

  if (!keyStr) {
    // 新規鍵ペア生成（Curve25519）
    if (!window.nacl) {
      throw new Error('TweetNaCl not loaded');
    }

    myKeyPair = window.nacl.box.keyPair();
    keyStr = JSON.stringify({
      publicKey: Array.from(myKeyPair.publicKey),
      secretKey: Array.from(myKeyPair.secretKey)
    });
    localStorage.setItem(keyStorageName, keyStr);
    
    // サーバーに公開鍵を登録
    try {
      await registerMyPublicKey(myKeyPair);
    } catch (e) {
      console.error('[e2eKeys] Register public key error:', e);
    }
  } else {
    const keyObj = JSON.parse(keyStr);
    myKeyPair = {
      publicKey: new Uint8Array(keyObj.publicKey),
      secretKey: new Uint8Array(keyObj.secretKey)
    };

    // この端末の鍵がサーバーの一覧に無ければ足す(端末ごとに鍵が違ってよい。上書きし合わない)
    try {
      const myLocalPublicKeyB64 = window.nacl.util.encodeBase64(myKeyPair.publicKey);
      const me = await api('/api/friends/me');
      const list = (me && Array.isArray(me.publicKeys)) ? me.publicKeys : (me && me.publicKey ? [me.publicKey] : []);
      const stampKey = 'e2e_touch_' + window.myUserId;
      if (!list.includes(myLocalPublicKeyB64) || Date.now() - Number(localStorage.getItem(stampKey) || 0) > 24 * 3600 * 1000) {
        await registerMyPublicKey(myKeyPair);
        localStorage.setItem(stampKey, String(Date.now()));
      }
    } catch (err) {
      console.error('[e2eKeys] Public key verification error:', err);
    }
  }

  // 全世代の鍵を keyring に残す(admin.html の復号で過去の鍵も試すため)
  try {
    const pub = Array.from(myKeyPair.publicKey);
    const ring = JSON.parse(localStorage.getItem(keyringName) || '[]')
      .filter(k => JSON.stringify(k.publicKey) !== JSON.stringify(pub));
    ring.unshift({ publicKey: pub, secretKey: Array.from(myKeyPair.secretKey) });
    localStorage.setItem(keyringName, JSON.stringify(ring.slice(0, 20)));
  } catch (e) {
    console.error('[e2eKeys] keyring save error:', e);
  }

  return myKeyPair;
}

async function registerMyPublicKey(keyPair) {
  try {
    const publicKeyB64 = window.nacl.util.encodeBase64(keyPair.publicKey);
    await api('/api/friends/publickey', {
      method: 'POST',
      body: JSON.stringify({ publicKey: publicKeyB64 })
    });
    console.log('[e2eKeys] Public key registered');
  } catch (err) {
    console.error('[e2eKeys] Register public key error:', err);
    throw err;
  }
}

// グローバル export
window.getOrCreateMyKeyPair = getOrCreateMyKeyPair;
window.registerMyPublicKey = registerMyPublicKey;
