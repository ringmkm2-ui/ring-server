// routes/live.js — 投稿タブに出す「今ライブ中の人」一覧
const express = require('express');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const router = express.Router();

router.get('/active', verifyToken, asyncHandler(async (req, res) => {
  const { listFeedLives } = require('../ws/wsServer');
  res.json(await listFeedLives(req.userId));
}));

module.exports = router;
