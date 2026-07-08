// messageencryptor.js
// -----------------------------------------------------------------------
// Double Ratchet (簡易版): X3DHで得た共有秘密(Root Key)から、
// メッセージを送るたびに鍵を1つずつ進める対称鍵チェーン(Symmetric Ratchet)を実装。
// 「1通ごとに鍵が変わる」ため、1通の鍵が漏れても過去・未来のメッセージは守られる。
// 暗号化には XSalsa20-Poly1305 (crypto_secretbox) を使用 (認証付き暗号 = 改ざん検知あり)。
// -----------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('libsodium-wrappers'));
  } else {
    root.RingMessageEncryptor = factory(root.sodium);
  }
})(typeof self !== 'undefined' ? self : this, function (sodiumLib) {

  async function ready() {
    await sodiumLib.ready;
    return sodiumLib;
  }

  // チェーンキーを1つ進める (KDF chain)
  // 次のチェーンキーと、今回のメッセージ鍵の2つを1つのハッシュ入力から派生させる
  async function ratchetStep(chainKeyB64) {
    const sodium = await ready();
    const chainKey = sodium.from_base64(chainKeyB64);

    // 「0x01」を足したものからメッセージ鍵、「0x02」を足したものから次のチェーン鍵を作る
    // (HMAC-likeな役割をgenerichashで代替)
    const msgKeyInput = new Uint8Array(chainKey.length + 1);
    msgKeyInput.set(chainKey, 0);
    msgKeyInput[chainKey.length] = 0x01;
    const messageKey = sodium.crypto_generichash(32, msgKeyInput);

    const nextChainInput = new Uint8Array(chainKey.length + 1);
    nextChainInput.set(chainKey, 0);
    nextChainInput[chainKey.length] = 0x02;
    const nextChainKey = sodium.crypto_generichash(32, nextChainInput);

    return {
      messageKey: sodium.to_base64(messageKey),
      nextChainKey: sodium.to_base64(nextChainKey),
    };
  }

  // ルートキー(X3DHの共有秘密)からチェーンキーを初期化
  async function initChain(rootKeyB64) {
    const sodium = await ready();
    // ルートキーをそのまま最初のチェーンキーとして使う (簡易実装)
    return rootKeyB64;
  }

  // --- メッセージ暗号化 ---
  // 呼ぶたびに chainKey を1ステップ進め、その時点のmessageKeyで暗号化する
  async function encryptMessage(chainKeyB64, plaintext) {
    const sodium = await ready();
    const { messageKey, nextChainKey } = await ratchetStep(chainKeyB64);

    const keyBytes = sodium.from_base64(messageKey);
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const plaintextBytes = sodium.from_string(plaintext);

    const ciphertext = sodium.crypto_secretbox_easy(plaintextBytes, nonce, keyBytes);

    return {
      ciphertext: sodium.to_base64(ciphertext),
      nonce: sodium.to_base64(nonce),
      nextChainKey, // 呼び出し側はこれを保存し、次回の暗号化に使う
    };
  }

  // --- メッセージ復号 ---
  async function decryptMessage(chainKeyB64, ciphertextB64, nonceB64) {
    const sodium = await ready();
    const { messageKey, nextChainKey } = await ratchetStep(chainKeyB64);

    const keyBytes = sodium.from_base64(messageKey);
    const nonce = sodium.from_base64(nonceB64);
    const ciphertext = sodium.from_base64(ciphertextB64);

    const plaintextBytes = sodium.crypto_secretbox_open_easy(ciphertext, nonce, keyBytes);
    if (!plaintextBytes) throw new Error('復号に失敗しました（改ざんまたは鍵の不一致）');

    return {
      plaintext: sodium.to_string(plaintextBytes),
      nextChainKey,
    };
  }

  // --- グループ用: 共通鍵を直接使った暗号化 (グループ鍵配布後の一括暗号化) ---
  async function encryptWithGroupKey(groupKeyB64, plaintext) {
    const sodium = await ready();
    const keyBytes = sodium.from_base64(groupKeyB64);
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, keyBytes);
    return { ciphertext: sodium.to_base64(ciphertext), nonce: sodium.to_base64(nonce) };
  }

  async function decryptWithGroupKey(groupKeyB64, ciphertextB64, nonceB64) {
    const sodium = await ready();
    const keyBytes = sodium.from_base64(groupKeyB64);
    const nonce = sodium.from_base64(nonceB64);
    const ciphertext = sodium.from_base64(ciphertextB64);
    const plaintextBytes = sodium.crypto_secretbox_open_easy(ciphertext, nonce, keyBytes);
    if (!plaintextBytes) throw new Error('復号に失敗しました');
    return sodium.to_string(plaintextBytes);
  }

  // --- グループ鍵生成 (グループ作成・鍵ラチェット時に使用) ---
  async function generateGroupKey() {
    const sodium = await ready();
    const key = sodium.crypto_secretbox_keygen();
    return sodium.to_base64(key);
  }

  // --- グループ鍵を特定メンバーの公開鍵に対して暗号化 (配布用) ---
  // 受信者の crypto_box 公開鍵 (identity key) に対して封筒暗号化する
  async function sealGroupKeyForMember(groupKeyB64, memberIdentityPubkeyB64) {
    const sodium = await ready();
    const groupKeyBytes = sodium.from_base64(groupKeyB64);
    const memberPub = sodium.from_base64(memberIdentityPubkeyB64);
    const sealed = sodium.crypto_box_seal(groupKeyBytes, memberPub);
    return sodium.to_base64(sealed);
  }

  async function unsealGroupKey(sealedB64, myIdentityPubkeyB64, myIdentityPrivkeyB64) {
    const sodium = await ready();
    const sealed = sodium.from_base64(sealedB64);
    const pub = sodium.from_base64(myIdentityPubkeyB64);
    const priv = sodium.from_base64(myIdentityPrivkeyB64);
    const opened = sodium.crypto_box_seal_open(sealed, pub, priv);
    if (!opened) throw new Error('グループ鍵の復号に失敗しました');
    return sodium.to_base64(opened);
  }

  return {
    initChain, encryptMessage, decryptMessage,
    encryptWithGroupKey, decryptWithGroupKey,
    generateGroupKey, sealGroupKeyForMember, unsealGroupKey,
  };
});
