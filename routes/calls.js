// routes/calls.js
// APKのネイティブ着信画面から使う通話操作。ネイティブ側はWebSocketを持っていないので、
// 「アプリを開かずに拒否」だけはRESTで受けてWS側の呼び出し中の通話に反映する。
const express = require('express');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.post('/reject', verifyToken, asyncHandler(async (req, res) => {
  const { callId } = req.body || {};
  if (!callId || typeof callId !== 'string' || callId.length > 100) {
    return res.status(400).json({ error: 'callId required' });
  }
  const { rejectPendingCall } = require('../ws/wsServer');
  const ok = rejectPendingCall(req.userId, callId);
  console.log(`[calls] native reject callId=${callId} user=${req.userId} -> ${ok ? 'rejected' : 'no pending call'}`);
  res.json({ ok });
}));

// APKの着信画面に相手のアイコンを出すため。プロフィール画像(data:URL か URL)を画像として返す
router.get('/avatar/:userId', verifyToken, asyncHandler(async (req, res) => {
  const db = require('../db/db');
  const u = await db.get('SELECT profile_pic FROM users WHERE id = ?', [req.params.userId]);
  const pic = u && u.profile_pic;
  if (!pic) return res.status(404).end();
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(pic);
  res.set('Cache-Control', 'private, max-age=3600');
  if (m) return res.type(m[1]).send(Buffer.from(m[2], 'base64'));
  if (/^https:\/\//.test(pic)) return res.redirect(pic);
  res.status(404).end();
}));

// APKの通知で本文を復号できなかった理由を記録する(本文や鍵は送らない。原因調査用)
router.post('/notify-diag', verifyToken, (req, res) => {
  const reason = String((req.body && req.body.reason) || '').slice(0, 120);
  console.log(`[notify-diag] user=${req.userId} ${reason}`);
  res.json({ ok: true });
});

module.exports = router;
