// routes/settings.js
// 端末をまたいで同じになる設定の読み書き。
const express = require('express');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { DEFAULTS, getSettings, saveSettings } = require('../utils/userSettings');

const router = express.Router();

router.get('/', verifyToken, asyncHandler(async (req, res) => {
  res.json({ settings: await getSettings(req.user.userId), defaults: DEFAULTS });
}));

// 部分更新。知らないキーは黙って捨てる(utils/userSettings.js の clean が担当)
router.put('/', verifyToken, asyncHandler(async (req, res) => {
  const patch = req.body && req.body.settings;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ error: '設定の形式が正しくありません' });
  }
  res.json({ ok: true, settings: await saveSettings(req.user.userId, patch) });
}));

module.exports = router;
