// routes/moderation.js
// E2E暗号化のチャット(個人・グループ)で禁止語を送った時に、送った側の端末が呼ぶ。
// サーバーは暗号文しか見えないので、端末の申告で「自分自身を」3日間停止にする。
// 止められるのは呼んだ本人のアカウントだけなので、他人を停止させる悪用はできない。
// 相手(peerId)やグループ(groupId)を渡すと、そこに「OOがFワードを言ったためBanしました。」を出す。
const express = require('express');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { banUser, postBanNotice } = require('../utils/moderation');
const { canInteract } = require('../utils/relations');

const router = express.Router();

router.post('/self-report', verifyToken, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const where = typeof body.where === 'string' ? body.where.replace(/[^a-z_-]/gi, '').slice(0, 20) : 'chat';
  const me = req.user.userId;
  try {
    if (typeof body.peerId === 'string' && body.peerId && body.peerId !== me && await canInteract(me, body.peerId)) {
      await postBanNotice(me, { peerId: body.peerId });
    } else if (typeof body.groupId === 'string' && body.groupId) {
      const mem = await db.get('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL', [body.groupId, me]);
      if (mem) await postBanNotice(me, { groupId: body.groupId });
    }
  } catch (e) { console.error('[moderation] notice failed:', e.message); }
  const until = await banUser(me, 'profanity:' + (where || 'chat'));
  res.status(403).json({ error: '禁止されている言葉を使ったため、3日間利用停止になりました', banned: true, bannedUntil: until });
}));

// 停止画面からの解除(管理キーを知っている人だけ)。テストで止めた自分のアカウントを、
// サーバーの再起動を待たずにその場で戻せるようにする。総当たりされないよう回数を絞る
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const unbanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: '試行が多すぎます。しばらくしてからお試しください。' },
});
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
router.post('/unban-self', unbanLimiter, verifyToken, asyncHandler(async (req, res) => {
  const key = process.env.ADMIN_API_KEY;
  const given = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!key || key.length < 16 || !given || !crypto.timingSafeEqual(sha(given), sha(key))) {
    return res.status(401).json({ error: '管理キーが違います' });
  }
  await db.run('UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?', [req.user.userId]);
  res.json({ ok: true });
}));

module.exports = router;
