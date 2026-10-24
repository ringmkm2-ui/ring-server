// routes/live.js — 投稿タブに出す「今ライブ中の人」一覧
const express = require('express');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const router = express.Router();

// 配信者のアイコンと、自分がそのチャンネルを登録しているか・登録者数を付ける。
// YouTubeのライブカードと同じ見た目(アイコン・チャンネル名・登録済み)を出すため。
router.get('/active', verifyToken, asyncHandler(async (req, res) => {
  const { listFeedLives } = require('../ws/wsServer');
  const me = req.user.userId;
  const lives = await listFeedLives(me);
  if (!lives.length) return res.json([]);
  const ids = [...new Set(lives.map(l => l.hostId))];
  const ph = ids.map(() => '?').join(',');
  const users = await db.all(`SELECT id, display_name, profile_pic FROM users WHERE id IN (${ph})`, ids);
  const userMap = new Map(users.map(u => [u.id, u]));
  const subs = await db.all(`SELECT channel_id, COUNT(*) AS cnt FROM user_subscriptions WHERE channel_id IN (${ph}) GROUP BY channel_id`, ids);
  const subMap = new Map(subs.map(s => [s.channel_id, Number(s.cnt)]));
  const mine = await db.all(`SELECT channel_id FROM user_subscriptions WHERE subscriber_id = ? AND channel_id IN (${ph})`, [me, ...ids]);
  const mineSet = new Set(mine.map(s => s.channel_id));
  res.json(lives.map(l => {
    const u = userMap.get(l.hostId);
    return {
      ...l,
      hostName: (u && u.display_name) || l.hostName,
      hostPic: (u && u.profile_pic) || null,
      subscriberCount: subMap.get(l.hostId) || 0,
      subscribedByMe: mineSet.has(l.hostId),
    };
  }));
}));

module.exports = router;
