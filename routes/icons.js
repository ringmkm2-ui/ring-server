// routes/icons.js
// アイコン画像のアップロード(認証あり)と、サーバー保存分の配信(認証なし・推測不能ID)
const express = require('express');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { parseDataUrl, storeIcon, baseUrl } = require('../utils/iconStore');

const uploadRouter = express.Router();
const publicRouter = express.Router();

// body: { dataUrl: "data:image/png;base64,..." } -> { url }
uploadRouter.post('/', verifyToken, asyncHandler(async (req, res) => {
  const parsed = parseDataUrl(req.body && req.body.dataUrl);
  if (!parsed) return res.status(400).json({ error: '画像の形式またはサイズが不正です(png/jpeg/webp/gif、1.5MBまで)' });
  const url = await storeIcon(parsed.buf, parsed.mime, baseUrl(req));
  res.json({ url });
}));

// <img>/CSSのurl()は認証ヘッダーを付けられないため、配信は認証なし。IDはuuidで推測できない
publicRouter.get('/:id', asyncHandler(async (req, res) => {
  if (!/^[0-9a-f\-]{36}$/.test(req.params.id)) return res.status(404).end();
  const row = await db.get('SELECT mime, data FROM icon_images WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(row.mime).send(row.data);
}));

module.exports = { uploadRouter, publicRouter };
