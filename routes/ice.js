// routes/ice.js
// -----------------------------------------------------------------------
// クライアント(admin.html)が通話を開始する直前に、このエンドポイントを
// 叩いて最新のSTUN/TURN(ICEサーバー)情報を取得する。
// Twilioの認証情報(Account SID/Auth Token)はサーバー側にのみ保持し、
// ここで発行される一時的なトークンだけをクライアントへ渡す。
const express = require('express');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { fetchTwilioIceServers } = require('../utils/twilioIce');

const router = express.Router();

router.get('/', verifyToken, asyncHandler(async (req, res) => {
  const iceServers = await fetchTwilioIceServers();
  res.json({ iceServers });
}));

module.exports = router;
