// routes/prekeys.js
// PreKeyStore: X3DH用の鍵バンドルの保管・配布
// - identity key (長期公開鍵)
// - signed prekey (署名付き中期鍵)
// - one-time prekeys (使い捨て鍵、X3DHの前方秘匿性を強化)
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('./auth');

const router = express.Router();

// --- 自分の鍵バンドルをサーバーに登録 ---
// body: { identityPubkey, signedPrekeyPub, signedPrekeySig, registrationId, oneTimePrekeys: [pubkey,...] }
router.post('/upload', verifyToken, async (req, res) => {
  const { identityPubkey, signedPrekeyPub, signedPrekeySig, registrationId, oneTimePrekeys } = req.body;
  const userId = req.user.userId;

  if (!identityPubkey || !signedPrekeyPub || !signedPrekeySig) {
    return res.status(400).json({ error: '鍵バンドルが不完全です' });
  }

  const existing = await db.get('SELECT user_id FROM identity_keys WHERE user_id = ?', [userId]);
  if (existing) {
    await db.run(
      `UPDATE identity_keys SET identity_pubkey=?, signed_prekey_pub=?, signed_prekey_sig=?, registration_id=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`,
      [identityPubkey, signedPrekeyPub, signedPrekeySig, registrationId || 0, userId]
    );
  } else {
    await db.run(
      `INSERT INTO identity_keys (user_id, identity_pubkey, signed_prekey_pub, signed_prekey_sig, registration_id) VALUES (?, ?, ?, ?, ?)`,
      [userId, identityPubkey, signedPrekeyPub, signedPrekeySig, registrationId || 0]
    );
  }

  if (Array.isArray(oneTimePrekeys)) {
    for (let idx = 0; idx < oneTimePrekeys.length; idx++) {
      await db.run(
        'INSERT INTO one_time_prekeys (id, user_id, key_id, pubkey) VALUES (?, ?, ?, ?)',
        [uuidv4(), userId, idx, oneTimePrekeys[idx]]
      );
    }
  }

  res.json({ ok: true, uploadedOneTimeKeys: (oneTimePrekeys || []).length });
});

// --- 相手の鍵バンドルを取得 (X3DHのために1回使い捨て鍵を1個消費する) ---
router.get('/bundle/:userId', verifyToken, async (req, res) => {
  const targetId = req.params.userId;
  const identity = await db.get('SELECT * FROM identity_keys WHERE user_id = ?', [targetId]);
  if (!identity) {
    return res.status(404).json({ error: 'このユーザーの鍵が登録されていません' });
  }

  const otk = await db.get(
    'SELECT * FROM one_time_prekeys WHERE user_id = ? AND used = 0 LIMIT 1',
    [targetId]
  );
  if (otk) {
    await db.run('UPDATE one_time_prekeys SET used = 1 WHERE id = ?', [otk.id]);
  }

  res.json({
    userId: targetId,
    identityPubkey: identity.identity_pubkey,
    signedPrekeyPub: identity.signed_prekey_pub,
    signedPrekeySig: identity.signed_prekey_sig,
    registrationId: identity.registration_id,
    oneTimePrekey: otk ? { keyId: otk.key_id, pubkey: otk.pubkey } : null,
  });
});

// --- 残りの使い捨て鍵の数を確認 (少なくなったらクライアントが補充する) ---
router.get('/count', verifyToken, async (req, res) => {
  const row = await db.get(
    'SELECT COUNT(*) as cnt FROM one_time_prekeys WHERE user_id = ? AND used = 0',
    [req.user.userId]
  );
  res.json({ remaining: row ? row.cnt : 0 });
});

module.exports = router;
