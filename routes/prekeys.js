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
const { isAcquainted } = require('../utils/relations');
const { prekeyLimiter } = require('../utils/rateLimits');
const { broadcastToUser } = require('../ws/wsServer');

const router = express.Router();

// --- 自分の鍵バンドルをサーバーに登録 ---
// body: { identityPubkey, signingPubkey, signedPrekeyPub, signedPrekeySig, registrationId, oneTimePrekeys: [pubkey,...] }
router.post('/upload', prekeyLimiter, verifyToken, asyncHandler(async (req, res) => {
  const { identityPubkey, signingPubkey, signedPrekeyPub, signedPrekeySig, registrationId, oneTimePrekeys } = req.body;
  const userId = req.user.userId;

  if (!identityPubkey || !signedPrekeyPub || !signedPrekeySig) {
    return res.status(400).json({ error: '鍵バンドルが不完全です' });
  }
  // 入力の検証: 鍵はbase64の短い文字列だけ。長さや個数に上限が無いと、巨大なデータでDBを埋められる
  const KEY_RE = /^[A-Za-z0-9+/_=-]{20,200}$/;
  const SIG_RE = /^[A-Za-z0-9+/_=-]{20,400}$/;
  if (typeof identityPubkey !== 'string' || !KEY_RE.test(identityPubkey) ||
      typeof signedPrekeyPub !== 'string' || !KEY_RE.test(signedPrekeyPub) ||
      typeof signedPrekeySig !== 'string' || !SIG_RE.test(signedPrekeySig) ||
      (signingPubkey != null && (typeof signingPubkey !== 'string' || !KEY_RE.test(signingPubkey)))) {
    return res.status(400).json({ error: '鍵の形式が正しくありません' });
  }
  if (oneTimePrekeys != null) {
    if (!Array.isArray(oneTimePrekeys) || oneTimePrekeys.length > 200) {
      return res.status(400).json({ error: 'ワンタイム鍵は一度に200個までです' });
    }
    for (const e of oneTimePrekeys) {
      const k = (e && typeof e === 'object') ? e.pubkey : e;
      const id = (e && typeof e === 'object') ? e.keyId : 0;
      if (typeof k !== 'string' || !KEY_RE.test(k) || !Number.isInteger(id) || id < 0) {
        return res.status(400).json({ error: 'ワンタイム鍵の形式が正しくありません' });
      }
    }
    const cnt = await db.get('SELECT COUNT(*) AS n FROM one_time_prekeys WHERE user_id = ? AND used = 0', [userId]);
    if ((Number(cnt && cnt.n) || 0) + oneTimePrekeys.length > 500) {
      return res.status(400).json({ error: '未使用のワンタイム鍵が多すぎます' });
    }
  }

  const existing = await db.get('SELECT user_id, identity_pubkey FROM identity_keys WHERE user_id = ?', [userId]);
  if (existing && existing.identity_pubkey !== identityPubkey) {
    // 別の端末が新しい鍵を作って上書きした。サーバーに残っている古い鍵のワンタイム鍵は、
    // 新しい鍵の持ち主には対応する秘密鍵が無いので、残すと相手がそれを使って暗号化し、復号できなくなる
    await db.run('DELETE FROM one_time_prekeys WHERE user_id = ?', [userId]);
  }
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
    // 初めて鍵を登録した。同じグループの人に知らせて、まだ渡せていないグループ鍵を配ってもらう
    try {
      const peers = await db.all(
        `SELECT DISTINCT gm2.user_id FROM group_members gm1
         JOIN group_members gm2 ON gm2.group_id = gm1.group_id AND gm2.left_at IS NULL AND gm2.user_id <> ?
         WHERE gm1.user_id = ? AND gm1.left_at IS NULL`,
        [userId, userId]
      );
      for (const p of peers) broadcastToUser(p.user_id, { type: 'member_keys_ready', userId });
    } catch (e) { console.error('member_keys_ready broadcast failed:', e.message); }
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

// --- 指定ユーザーのidentity公開鍵だけを返す (OTK消費なし) ---
// x3dhRespond (受信側) で配布者のidentityPubkeyを取得するために使う。
// /bundle/:userId はOTKを消費してしまうためこのエンドポイントを分けている。
router.get('/identity/:userId', verifyToken, asyncHandler(async (req, res) => {
  const targetId = req.params.userId;
  // /bundle と同じく、友だち・同じグループ・自分だけに限る。
  // ここだけ素通しだと、IDを総当たりして「誰が登録しているか」と各人の身元鍵を集められた。
  // (ブロックしていても同じグループの人の鍵は取れないと、グループの暗号が開けなくなる)
  if (targetId !== req.user.userId && !(await isAcquainted(req.user.userId, targetId))) {
    return res.status(403).json({ error: 'このユーザーの鍵は取得できません' });
  }
  const identity = await db.get('SELECT identity_pubkey, signing_pubkey, signed_prekey_pub, signed_prekey_sig, registration_id FROM identity_keys WHERE user_id = ?', [targetId]);
  if (!identity) {
    return res.status(404).json({ error: 'このユーザーの鍵が登録されていません' });
  }
  res.json({
    userId: targetId,
    identityPubkey: identity.identity_pubkey,
    signingPubkey: identity.signing_pubkey || null,
    signedPrekeyPub: identity.signed_prekey_pub,
    signedPrekeySig: identity.signed_prekey_sig,
  });
}));

// --- 相手の鍵バンドルを取得 (X3DHのために1回使い捨て鍵を1個消費する) ---
router.get('/bundle/:userId', verifyToken, asyncHandler(async (req, res) => {
  const targetId = req.params.userId;
  // このAPIは相手のワンタイム鍵を1個消費する。無関係なユーザーが繰り返し叩くと、相手の鍵を使い切れて
  // しまう(前方秘匿性が落ちる)ので、友だち・同じグループの人・自分だけに限る。
  if (targetId !== req.user.userId) {
    const related = await db.get(
      `SELECT 1 AS ok FROM friendships
        WHERE status = 'accepted' AND ((user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?))
       UNION ALL
       SELECT 1 AS ok FROM group_members g1
         JOIN group_members g2 ON g2.group_id = g1.group_id
        WHERE g1.user_id = ? AND g2.user_id = ? AND g1.left_at IS NULL AND g2.left_at IS NULL
       LIMIT 1`,
      [req.user.userId, targetId, targetId, req.user.userId, req.user.userId, targetId]
    );
    if (!related) return res.status(403).json({ error: 'このユーザーの鍵は取得できません' });
  }
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
  res.json({ remaining: row ? Number(row.cnt) : 0 });
}));

module.exports = router;
