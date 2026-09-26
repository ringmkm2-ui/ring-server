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

module.exports = router;
