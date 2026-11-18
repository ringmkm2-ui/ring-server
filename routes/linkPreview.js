// routes/linkPreview.js
// GET /api/link-preview?url=...  -> { url, title?, description?, image?, siteName? }
// 設定の linkPreview を自分でオンにした人だけが使える(サーバーがURL先を取りに行くため、既定はオフ)。
const express = require('express');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { linkPreviewLimiter, linkPreviewImageLimiter } = require('../utils/rateLimits');
const { getSettings } = require('../utils/userSettings');
const { getPreview, getImage, PreviewError } = require('../utils/linkPreview');
const { sendServerError } = require('../utils/errorResponse');

const router = express.Router();

router.get('/', linkPreviewLimiter, verifyToken, asyncHandler(async (req, res) => {
  if (!(await getSettings(req.user.userId)).linkPreview) {
    return res.status(403).json({ error: 'リンクのプレビューがオフになっています' });
  }
  const url = req.query.url;
  if (typeof url !== 'string' || !url || url.length > 2000) {
    return res.status(400).json({ error: 'URLの形式が正しくありません' });
  }
  try {
    res.json(await getPreview(url));
  } catch (e) {
    if (e instanceof PreviewError) return res.status(e.status).json({ error: e.message });
    // 想定外はログにだけ詳細を残し、クライアントには一般的な文言だけ返す
    sendServerError(res, e, 'link-preview');
  }
}));

// GET /api/link-preview/image?url=...  -> 画像そのもの(サーバーが代わりに取りに行く)
// クライアントは fetch(認証ヘッダ付き)で受けて blob: にして <img> に入れる。外のサイトに閲覧者のIPを見せないための経路。
router.get('/image', linkPreviewImageLimiter, verifyToken, asyncHandler(async (req, res) => {
  if (!(await getSettings(req.user.userId)).linkPreview) {
    return res.status(403).json({ error: 'リンクのプレビューがオフになっています' });
  }
  const url = req.query.url;
  if (typeof url !== 'string' || !url || url.length > 2000) {
    return res.status(400).json({ error: 'URLの形式が正しくありません' });
  }
  try {
    const img = await getImage(url);
    res.set({
      'Content-Type': img.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
    });
    res.send(img.buf);
  } catch (e) {
    if (e instanceof PreviewError) return res.status(e.status).json({ error: e.message });
    sendServerError(res, e, 'link-preview-image');
  }
}));

module.exports = router;
