// routes/devices.js
// 新しい端末の承認(utils/deviceKeys.js)。許可と拒否は、有効な鍵を持っている端末からしかできない。
// トークンだけでは足りない: パスワードを盗んだ人もトークンは手に入るが、端末の秘密鍵は持っていない。
const express = require('express');
const crypto = require('crypto');
const nacl = require('libsodium-wrappers');
const db = require('../db/db');
const deviceKeys = require('../utils/deviceKeys');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { prekeyLimiter } = require('../utils/rateLimits');

const router = express.Router();
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const CHALLENGE_MS = 2 * 60 * 1000;
const challenges = new Map(); // id -> { userId, publicKey, answer, exp }
function sweep() { const n = Date.now(); for (const [k, v] of challenges) if (v.exp < n) challenges.delete(k); }

router.use(verifyToken);

router.get('/status', asyncHandler(async (req, res) => {
  const pk = req.query.publicKey;
  if (typeof pk !== 'string' || !KEY_RE.test(pk)) return res.status(400).json({ error: '公開鍵の形式が不正です' });
  const st = await deviceKeys.statusOf(req.user.userId, pk);
  res.json({ status: st.status, approveAfter: st.approveAfter, code: deviceKeys.codeFor(pk), enabled: deviceKeys.enabled() });
}));

router.get('/pending', asyncHandler(async (req, res) => {
  res.json({ pending: await deviceKeys.listPending(req.user.userId) });
}));

// この端末が publicKey の秘密鍵を持っていることの確認。ランダムな値をその鍵あてに暗号化して渡し、開けるかを見る
router.post('/challenge', prekeyLimiter, asyncHandler(async (req, res) => {
  const pk = req.body && req.body.publicKey;
  if (typeof pk !== 'string' || !KEY_RE.test(pk)) return res.status(400).json({ error: '公開鍵の形式が不正です' });
  const st = await deviceKeys.statusOf(req.user.userId, pk);
  if (st.status !== 'active') return res.status(403).json({ error: 'この端末では操作できません' });
  await nacl.ready;
  sweep();
  const eph = nacl.crypto_box_keypair();
  const nonce = nacl.randombytes_buf(nacl.crypto_box_NONCEBYTES);
  const answer = nacl.randombytes_buf(32);
  const box = nacl.crypto_box_easy(answer, nonce, Buffer.from(pk, 'base64'), eph.privateKey);
  const id = crypto.randomUUID();
  challenges.set(id, { userId: req.user.userId, publicKey: pk, answer: Buffer.from(answer), exp: Date.now() + CHALLENGE_MS });
  const b64 = u => Buffer.from(u).toString('base64');
  res.json({ id, serverPublicKey: b64(eph.publicKey), nonce: b64(nonce), box: b64(box) });
}));

// 1回限り。使ったら(失敗でも)消すので、総当たりできない
function proved(req, requiredKey) {
  const { challengeId, answer } = req.body || {};
  if (typeof challengeId !== 'string' || typeof answer !== 'string') return false;
  const c = challenges.get(challengeId);
  if (!c) return false;
  challenges.delete(challengeId);
  if (c.userId !== req.user.userId || c.exp < Date.now()) return false;
  if (requiredKey && c.publicKey !== requiredKey) return false;
  const got = Buffer.from(answer, 'base64');
  return got.length === c.answer.length && crypto.timingSafeEqual(got, c.answer);
}

async function decide(req, res, kind) {
  const target = req.body && req.body.publicKey;
  if (typeof target !== 'string' || !KEY_RE.test(target)) return res.status(400).json({ error: '公開鍵の形式が不正です' });
  if (!proved(req)) return res.status(403).json({ error: 'この端末では操作できません' });
  const ok = await (kind === 'approve' ? deviceKeys.approve : deviceKeys.reject)(req.user.userId, target);
  if (!ok) return res.status(404).json({ error: '承認待ちの端末が見つかりません' });
  const { broadcastToUser } = require('../ws/wsServer');
  broadcastToUser(req.user.userId, { type: kind === 'approve' ? 'device_approved' : 'device_rejected', publicKey: target });
  if (kind === 'approve') await deviceKeys.announce(req.user.userId);
  res.json({ ok: true });
}
router.post('/approve', prekeyLimiter, asyncHandler((req, res) => decide(req, res, 'approve')));
router.post('/reject', prekeyLimiter, asyncHandler((req, res) => decide(req, res, 'reject')));

// 本人に知らせる。本人が許可していなければ、パスワードを盗まれている合図になる
async function mailPending(userId, publicKey) {
  const { isMailConfigured, sendMail } = require('../utils/mailer');
  if (!isMailConfigured()) return;
  const u = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
  if (!u || !/@/.test(u.username || '') || /^guest_/.test(u.username)) return;
  const when = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  await sendMail({
    to: u.username,
    subject: 'Bro Chat 新しい端末の追加が要求されました',
    text: `あなたのアカウントに新しい端末を追加する要求がありました。\n\n日時: ${when} (日本時間)\n確認コード: ${deviceKeys.codeFor(publicKey)}\n\n`
        + `ご自身の操作なら、ログイン済みの端末で Bro Chat を開いて許可してください。\n`
        + `心当たりが無い場合は、ログイン済みの端末で拒否して、すぐにパスワードを変更してください。\n`
        + `何もしないと、72時間後に新しい端末が有効になります。\n`,
  });
}

module.exports = router;
module.exports.mailPending = mailPending;
module.exports.proved = proved;
