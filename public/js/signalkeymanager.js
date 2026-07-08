// signalkeymanager.js
// -----------------------------------------------------------------------
// Signal Protocol 風の鍵管理: X3DH (Extended Triple Diffie-Hellman)
// libsodium (X25519 + Ed25519) を使用。ブラウザでは <script src="libsodium-wrappers.js">
// を読み込んだ後にこのファイルを読み込むことで window.RingSignalKeyManager として使える。
// -----------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('libsodium-wrappers'));
  } else {
    root.RingSignalKeyManager = factory(root.sodium);
  }
})(typeof self !== 'undefined' ? self : this, function (sodiumLib) {

  async function ready() {
    await sodiumLib.ready;
    return sodiumLib;
  }

  // --- 自分の鍵一式を生成 ---
  // identityKey: 長期の身元鍵 (X25519)
  // signedPrekey: 中期鍵。identityKeyの署名付き(Ed25519で署名するため別途signingKeyも生成)
  // oneTimePrekeys: 使い捨て鍵の束 (X3DHの前方秘匿性強化)
  async function generateKeyBundle(oneTimeCount = 10) {
    const sodium = await ready();

    const identityKeyPair = sodium.crypto_box_keypair(); // X25519 (DH用)
    const signingKeyPair = sodium.crypto_sign_keypair(); // Ed25519 (署名用)
    const signedPrekeyPair = sodium.crypto_box_keypair();

    // signed prekey の公開鍵に対し、身元の署名鍵で署名する (なりすまし防止)
    const signature = sodium.crypto_sign_detached(
      signedPrekeyPair.publicKey,
      signingKeyPair.privateKey
    );

    const oneTimePrekeys = [];
    for (let i = 0; i < oneTimeCount; i++) {
      oneTimePrekeys.push(sodium.crypto_box_keypair());
    }

    return {
      identity: {
        publicKey: sodium.to_base64(identityKeyPair.publicKey),
        privateKey: sodium.to_base64(identityKeyPair.privateKey), // 端末のローカルのみに保存, サーバーには送らない
      },
      signing: {
        publicKey: sodium.to_base64(signingKeyPair.publicKey),
        privateKey: sodium.to_base64(signingKeyPair.privateKey),
      },
      signedPrekey: {
        publicKey: sodium.to_base64(signedPrekeyPair.publicKey),
        privateKey: sodium.to_base64(signedPrekeyPair.privateKey),
        signature: sodium.to_base64(signature),
      },
      oneTimePrekeys: oneTimePrekeys.map(kp => ({
        publicKey: sodium.to_base64(kp.publicKey),
        privateKey: sodium.to_base64(kp.privateKey),
      })),
    };
  }

  // --- X3DH: 送信側 (自分がチャット開始する側) ---
  // 相手のバンドル(サーバーから取得したもの)と自分の鍵から共有秘密鍵を導出する
  async function x3dhInitiate(myIdentity, theirBundle) {
    const sodium = await ready();

    // 一時的な鍵 (Ephemeral key) を都度生成 → 前方秘匿性を確保
    const ephemeralKeyPair = sodium.crypto_box_keypair();

    const myIdPriv = sodium.from_base64(myIdentity.identity.privateKey);
    const ephPriv = ephemeralKeyPair.privateKey;

    const theirIdPub = sodium.from_base64(theirBundle.identityPubkey);
    const theirSignedPrekeyPub = sodium.from_base64(theirBundle.signedPrekeyPub);
    const theirOtkPub = theirBundle.oneTimePrekey
      ? sodium.from_base64(theirBundle.oneTimePrekey.pubkey)
      : null;

    // DH1 = DH(自分のID鍵, 相手のSignedPrekey)
    // DH2 = DH(自分のEphemeral鍵, 相手のID鍵)
    // DH3 = DH(自分のEphemeral鍵, 相手のSignedPrekey)
    // DH4 = DH(自分のEphemeral鍵, 相手のOneTimePrekey) ※あれば
    const dh1 = sodium.crypto_scalarmult(myIdPriv, theirSignedPrekeyPub);
    const dh2 = sodium.crypto_scalarmult(ephPriv, theirIdPub);
    const dh3 = sodium.crypto_scalarmult(ephPriv, theirSignedPrekeyPub);
    const dh4 = theirOtkPub ? sodium.crypto_scalarmult(ephPriv, theirOtkPub) : new Uint8Array(0);

    const combined = new Uint8Array(dh1.length + dh2.length + dh3.length + dh4.length);
    combined.set(dh1, 0);
    combined.set(dh2, dh1.length);
    combined.set(dh3, dh1.length + dh2.length);
    combined.set(dh4, dh1.length + dh2.length + dh3.length);

    // HKDF的にハッシュして32byteの共有鍵(Root Key)を導出
    const sharedSecret = sodium.crypto_generichash(32, combined);

    return {
      sharedSecret: sodium.to_base64(sharedSecret),
      ephemeralPublicKey: sodium.to_base64(ephemeralKeyPair.publicKey),
      usedOneTimeKeyId: theirBundle.oneTimePrekey ? theirBundle.oneTimePrekey.keyId : null,
    };
  }

  // --- X3DH: 受信側 (相手が送ってきたephemeralPublicKeyから同じ共有秘密を再現) ---
  async function x3dhRespond(myFullBundle, theirIdentityPubkey, theirEphemeralPubkey, usedOneTimeKeyId) {
    const sodium = await ready();

    const mySignedPrekeyPriv = sodium.from_base64(myFullBundle.signedPrekey.privateKey);
    const myIdPriv = sodium.from_base64(myFullBundle.identity.privateKey);
    const theirIdPub = sodium.from_base64(theirIdentityPubkey);
    const theirEphPub = sodium.from_base64(theirEphemeralPubkey);

    let myOtkPriv = null;
    if (usedOneTimeKeyId !== null && usedOneTimeKeyId !== undefined) {
      const found = myFullBundle.oneTimePrekeys[usedOneTimeKeyId];
      if (found) myOtkPriv = sodium.from_base64(found.privateKey);
    }

    // 送信側と対称になるようDHを計算
    const dh1 = sodium.crypto_scalarmult(mySignedPrekeyPriv, theirIdPub);
    const dh2 = sodium.crypto_scalarmult(myIdPriv, theirEphPub);
    const dh3 = sodium.crypto_scalarmult(mySignedPrekeyPriv, theirEphPub);
    const dh4 = myOtkPriv ? sodium.crypto_scalarmult(myOtkPriv, theirEphPub) : new Uint8Array(0);

    const combined = new Uint8Array(dh1.length + dh2.length + dh3.length + dh4.length);
    combined.set(dh1, 0);
    combined.set(dh2, dh1.length);
    combined.set(dh3, dh1.length + dh2.length);
    combined.set(dh4, dh1.length + dh2.length + dh3.length);

    const sharedSecret = sodium.crypto_generichash(32, combined);
    return sodium.to_base64(sharedSecret);
  }

  return { generateKeyBundle, x3dhInitiate, x3dhRespond };
});
