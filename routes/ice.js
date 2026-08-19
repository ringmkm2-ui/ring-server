// routes/ice.js
// -----------------------------------------------------------------------
// クライアント(admin.html)が通話を開始する直前に、このエンドポイントを
// 叩いて最新のSTUN/TURN(ICEサーバー)情報を取得する。
// Metered.ca のSecret Keyはサーバー側にのみ保持し、
// ここで発行される一時的なICEサーバー情報だけをクライアントへ渡す。
const express = require('express');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { fetchMeteredIceServers } = require('../utils/meteredIce');

const router = express.Router();

router.get('/', verifyToken, asyncHandler(async (req, res) => {
  const iceServers = await fetchMeteredIceServers();
  res.json({ iceServers });
}));

module.exports = router;
