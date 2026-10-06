// routes/moderation.js
// E2E暗号化のチャット(個人・グループ)で禁止語を送ろうとした時に、送る側の端末が呼ぶ。
// サーバーは暗号文しか見えないので、端末の申告で「自分自身を」3日間停止にする。
// 止められるのは呼んだ本人のアカウントだけなので、他人を停止させる悪用はできない。
const express = require('express');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { banUser } = require('../utils/moderation');

const router = express.Router();

router.post('/self-report', verifyToken, asyncHandler(async (req, res) => {
  const where = typeof req.body?.where === 'string' ? req.body.where.replace(/[^a-z_-]/gi, '').slice(0, 20) : 'chat';
  const until = await banUser(req.user.userId, 'profanity:' + (where || 'chat'));
  res.status(403).json({ error: '禁止されている言葉を使ったため、3日間利用停止になりました', banned: true, bannedUntil: until });
}));

module.exports = router;
