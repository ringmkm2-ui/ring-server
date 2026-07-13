// routes/messages.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const db = require('../db/db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'ring-dev-secret-CHANGE-IN-PRODUCTION';

function auth(req, res, next) {
  const token = (req.get('Authorization') || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// メッセージ送信
// POST /api/messages/send
// body: { recipientId, content }
router.post('/send', auth, async (req, res) => {
  try {
    const { recipientId, content } = req.body;
    if (!recipientId || !content) return res.status(400).json({ error: 'recipientId and content required' });

    const recipient = await db.get('SELECT id FROM users WHERE id = ?', [recipientId]);
    if (!recipient) return res.status(404).json({ error: 'recipient not found' });

    const msgId = uuidv4();
    await db.run(
      'INSERT INTO messages (id, sender_id, recipient_id, content) VALUES (?, ?, ?, ?)',
      [msgId, req.userId, recipientId, content]
    );

    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [msgId]);

    // WebSocket でリアルタイム通知
    const { broadcastToUser } = require('../ws/wsServer');
    const payload = {
      type: 'new_message',
      message: {
        id: msg.id,
        senderId: msg.sender_id,
        recipientId: msg.recipient_id,
        content: msg.content,
        createdAt: msg.created_at,
      }
    };
    broadcastToUser(recipientId, payload);
    broadcastToUser(req.userId, payload); // 自分の他端末にも

    res.json({ ok: true, message: payload.message });
  } catch (e) {
    console.error('Error sending message:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 会話履歴取得
// GET /api/messages/history/:userId?before=<timestamp>&limit=50
router.get('/history/:userId', auth, async (req, res) => {
  try {
    const { userId: otherId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before;

    let sql = `
      SELECT * FROM messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    `;
    const params = [req.userId, otherId, otherId, req.userId];

    if (before) {
      sql += ' AND created_at < ?';
      params.push(before);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = await db.all(sql, params);

    // 未読を既読にする
    await db.run(
      "UPDATE messages SET read_at = datetime('now') WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL",
      [otherId, req.userId]
    );

    res.json(rows.reverse().map(m => ({
      id: m.id,
      senderId: m.sender_id,
      recipientId: m.recipient_id,
      content: m.content,
      createdAt: m.created_at,
      readAt: m.read_at,
    })));
  } catch (e) {
    console.error('Error fetching history:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// トークリスト取得（最新メッセージ付き + メッセージなしの友達も含む）
// GET /api/messages/talks
router.get('/talks', auth, async (req, res) => {
  try {
    // メッセージがある会話
    const rows = await db.all(`
      SELECT
        CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END as other_id,
        content,
        created_at,
        sender_id,
        MAX(created_at) as last_time
      FROM messages
      WHERE sender_id = ? OR recipient_id = ?
      GROUP BY other_id
      ORDER BY last_time DESC
    `, [req.userId, req.userId, req.userId]);

    const result = [];
    const processedIds = new Set();

    for (const row of rows) {
      const user = await db.get('SELECT id, user_id, display_name, profile_pic FROM users WHERE id = ?', [row.other_id]);
      if (user) {
        const unread = await db.get(
          "SELECT COUNT(*) as cnt FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL",
          [row.other_id, req.userId]
        );
        result.push({
          userId: user.id,
          userIdCode: user.user_id,
          displayName: user.display_name,
          profilePic: user.profile_pic,
          lastMessage: row.content,
          lastTime: row.last_time,
          unreadCount: unread ? unread.cnt : 0,
        });
        processedIds.add(user.id);
      }
    }

    // メッセージのない友達も含める
    const friends = await db.all(`
      SELECT
        CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END as friend_id
      FROM friendships
      WHERE (user_a_id = ? OR user_b_id = ?) AND status = 'accepted'
    `, [req.userId, req.userId, req.userId]);

    for (const f of friends) {
      if (!processedIds.has(f.friend_id)) {
        const user = await db.get('SELECT id, user_id, display_name, profile_pic FROM users WHERE id = ?', [f.friend_id]);
        if (user) {
          result.push({
            userId: user.id,
            userIdCode: user.user_id,
            displayName: user.display_name,
            profilePic: user.profile_pic,
            lastMessage: '',
            lastTime: new Date().toISOString(),
            unreadCount: 0,
          });
        }
      }
    }

    res.json(result);
  } catch (e) {
    console.error('Error fetching talks:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
