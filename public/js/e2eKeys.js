// js/e2eKeys.js
// E2E暗号化用の鍵ペア管理（admin.html と groupchat.html で共有）

let myKeyPair = null;

async function getOrCreateMyKeyPair() {
  if (myKeyPair) return myKeyPair;

  // myUserId は各ページで定義されていることを想定
  if (!window.myUserId) {
    throw new Error('myUserId is not defined');
  }

  const keyStorageName = `e2e_keypair_${window.myUserId}`;
  let keyStr = localStorage.getItem(keyStorageName);

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

    // サーバー側との鍵一致確認
    try {
      const myLocalPublicKeyB64 = window.nacl.util.encodeBase64(myKeyPair.publicKey);
      const me = await api('/api/friends/me');
      if (!me || me.publicKey !== myLocalPublicKeyB64) {
        console.warn('[e2eKeys] Public key mismatch, re-registering...');
        await registerMyPublicKey(myKeyPair);
      }
    } catch (err) {
      console.error('[e2eKeys] Public key verification error:', err);
    }
  }

  return myKeyPair;
}

async function registerMyPublicKey(keyPair) {
  try {
    const publicKeyB64 = window.nacl.util.encodeBase64(keyPair.publicKey);
    await api('/api/friends/me', {
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
