// routes/prekeys.js
// PreKeyStore: X3DH用の鍵バンドルの保管・配布
// - identity key (長期公開鍵)
// - signed prekey (署名付き中期鍵)
// - one-time prekeys (使い捨て鍵、X3DHの前方秘匿性を強化)
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

// --- 自分の鍵バンドルをサーバーに登録 ---
// body: { identityPubkey, signingPubkey, signedPrekeyPub, signedPrekeySig, registrationId, oneTimePrekeys: [pubkey,...] }
router.post('/upload', verifyToken, asyncHandler(async (req, res) => {
  const { identityPubkey, signingPubkey, signedPrekeyPub, signedPrekeySig, registrationId, oneTimePrekeys } = req.body;
  const userId = req.user.userId;

  if (!identityPubkey || !signedPrekeyPub || !signedPrekeySig) {
    return res.status(400).json({ error: '鍵バンドルが不完全です' });
  }

  const existing = await db.get('SELECT user_id FROM identity_keys WHERE user_id = ?', [userId]);
  if (existing) {
    // signingPubkeyが省略された場合(補充リクエストなど)は既存の値を保持する
    if (signingPubkey) {
      await db.run(
        `UPDATE identity_keys SET identity_pubkey=?, signing_pubkey=?, signed_prekey_pub=?, signed_prekey_sig=?, registration_id=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`,
        [identityPubkey, signingPubkey, signedPrekeyPub, signedPrekeySig, registrationId || 0, userId]
      );
    } else {
      await db.run(
        `UPDATE identity_keys SET identity_pubkey=?, signed_prekey_pub=?, signed_prekey_sig=?, registration_id=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`,
        [identityPubkey, signedPrekeyPub, signedPrekeySig, registrationId || 0, userId]
      );
    }
  } else {
    await db.run(
      `INSERT INTO identity_keys (user_id, identity_pubkey, signing_pubkey, signed_prekey_pub, signed_prekey_sig, registration_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, identityPubkey, signingPubkey || null, signedPrekeyPub, signedPrekeySig, registrationId || 0]
    );
  }

  if (Array.isArray(oneTimePrekeys)) {
    // クライアントから { keyId, pubkey } 形式または旧来の文字列(pubkeyのみ)が来る。
    // クライアント指定のkeyIdがある場合はそれを使う(クライアント側のローカルと一致させるため)。
    // 旧来の文字列形式の場合はサーバー側でMAX(key_id)+1から採番する(後方互換)。
    const hasStructured = oneTimePrekeys.length > 0 && typeof oneTimePrekeys[0] === 'object';
    let nextKeyId = 0;
    if (!hasStructured) {
      const maxRow = await db.get('SELECT MAX(key_id) as maxId FROM one_time_prekeys WHERE user_id = ?', [userId]);
      nextKeyId = (maxRow && maxRow.maxId != null) ? maxRow.maxId + 1 : 0;
    }
    for (const entry of oneTimePrekeys) {
      const pubkey = hasStructured ? entry.pubkey : entry;
      const keyId = hasStructured ? entry.keyId : nextKeyId++;
      await db.run(
        'INSERT INTO one_time_prekeys (id, user_id, key_id, pubkey) VALUES (?, ?, ?, ?)',
        [uuidv4(), userId, keyId, pubkey]
      );
    }
  }

  res.json({ ok: true, uploadedOneTimeKeys: (oneTimePrekeys || []).length });
}));

// --- 相手の鍵バンドルを取得 (X3DHのために1回使い捨て鍵を1個消費する) ---
router.get('/bundle/:userId', verifyToken, asyncHandler(async (req, res) => {
  const targetId = req.params.userId;
  const identity = await db.get('SELECT * FROM identity_keys WHERE user_id = ?', [targetId]);
  if (!identity) {
    return res.status(404).json({ error: 'このユーザーの鍵が登録されていません' });
  }

  // NOTE: 以前は SELECT → UPDATE の2段階だったため、同時に複数リクエストが
  // 来ると同じワンタイム鍵が2人以上に配布されてしまうレースコンディションが
  // あった(X3DHの前方秘匿性を損なう)。UPDATE...RETURNINGで原子的に「未使用の
  // 鍵を1つ確保して即座にusedへ更新」を1クエリで行い、これを防ぐ。
  const otk = await db.get(
    `UPDATE one_time_prekeys SET used = 1
     WHERE id = (SELECT id FROM one_time_prekeys WHERE user_id = ? AND used = 0 LIMIT 1)
     RETURNING *`,
    [targetId]
  );

  res.json({
    userId: targetId,
    identityPubkey: identity.identity_pubkey,
    signingPubkey: identity.signing_pubkey || null,
    signedPrekeyPub: identity.signed_prekey_pub,
    signedPrekeySig: identity.signed_prekey_sig,
    registrationId: identity.registration_id,
    oneTimePrekey: otk ? { keyId: otk.key_id, pubkey: otk.pubkey } : null,
  });
}));

// --- 残りの使い捨て鍵の数を確認 (少なくなったらクライアントが補充する) ---
router.get('/count', verifyToken, asyncHandler(async (req, res) => {
  const row = await db.get(
    'SELECT COUNT(*) as cnt FROM one_time_prekeys WHERE user_id = ? AND used = 0',
    [req.user.userId]
  );
  res.json({ remaining: row ? row.cnt : 0 });
}));

module.exports = router;
