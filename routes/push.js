// routes/push.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { VAPID_PUBLIC_KEY } = require('../utils/webPush');
const { sendServerError } = require('../utils/errorResponse');
const { verifyToken: auth } = require('../utils/authMiddleware');

const router = express.Router();

// クライアントがVAPID公開鍵を取得するためのエンドポイント
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Push購読を登録（デバイスごとに1件、endpointで一意）
router.post('/subscribe', auth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'invalid subscription' });
    }
    const { endpoint, keys } = subscription;

    // 既存の同endpoint購読があれば上書き（ユーザーが変わった場合等）
    const existing = await db.get('SELECT id FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    if (existing) {
      await db.run(
        'UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE endpoint = ?',
        [req.userId, keys.p256dh, keys.auth, endpoint]
      );
    } else {
      await db.run(
        'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), req.userId, endpoint, keys.p256dh, keys.auth]
      );
    }
    res.json({ success: true });
  } catch (e) {
    sendServerError(res, e);
  }
});

// Push購読を解除
router.post('/unsubscribe', auth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.userId]);
    res.json({ success: true });
  } catch (e) {
    sendServerError(res, e);
  }
});

module.exports = router;
