// routes/friends.js
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

// 自分のプロフィール取得
router.get('/me', auth, async (req, res) => {
  try {
    const user = await db.get('SELECT id, user_id, username, display_name, profile_pic, bio FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({ userId: user.id, userIdCode: user.user_id, username: user.username, displayName: user.display_name, profilePic: user.profile_pic, bio: user.bio });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// プロフィール更新
router.post('/me', auth, async (req, res) => {
  try {
    const { displayName, bio } = req.body;
    await db.run('UPDATE users SET display_name = ?, bio = ? WHERE id = ?', [displayName || '', bio || '', req.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// IDで検索
router.get('/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const results = await db.all(
      'SELECT id, user_id, display_name, profile_pic FROM users WHERE (user_id LIKE ? OR display_name LIKE ?) AND id != ? LIMIT 10',
      [q + '%', '%' + q + '%', req.userId]
    );
    res.json(results.map(u => ({ userId: u.id, userIdCode: u.user_id, displayName: u.display_name, profilePic: u.profile_pic })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 友達リクエスト送信
router.post('/request', auth, async (req, res) => {
  try {
    const { targetUserIdCode } = req.body;
    if (!targetUserIdCode) return res.status(400).json({ error: 'targetUserIdCode required' });

    const targetUser = await db.get('SELECT id FROM users WHERE user_id = ?', [targetUserIdCode]);
    if (!targetUser) return res.status(404).json({ error: 'user not found' });
    if (targetUser.id === req.userId) return res.status(400).json({ error: 'cannot add yourself' });

    const [userA, userB] = [req.userId, targetUser.id].sort();
    const existing = await db.get('SELECT id, status FROM friendships WHERE user_a_id = ? AND user_b_id = ?', [userA, userB]);
    if (existing) return res.status(400).json({ error: existing.status === 'accepted' ? 'already friends' : 'request already sent' });

    const friendshipId = uuidv4();
    await db.run('INSERT INTO friendships (id, user_a_id, user_b_id, status, requested_by) VALUES (?, ?, ?, ?, ?)', [friendshipId, userA, userB, 'pending', req.userId]);
    res.json({ ok: true, friendshipId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 友達リクエスト承認
router.post('/accept', auth, async (req, res) => {
  try {
    const { friendshipId } = req.body;
    const friendship = await db.get('SELECT * FROM friendships WHERE id = ?', [friendshipId]);
    if (!friendship) return res.status(404).json({ error: 'not found' });
    if (friendship.status !== 'pending') return res.status(400).json({ error: 'not pending' });
    if (friendship.requested_by === req.userId) return res.status(403).json({ error: 'not authorized' });

    const now = new Date().toISOString();
    await db.run("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE id = ?", [now, friendshipId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 友達リスト
router.get('/list', auth, async (req, res) => {
  try {
    const rows = await db.all(
      "SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END as friend_id FROM friendships WHERE (user_a_id = ? OR user_b_id = ?) AND status = 'accepted'",
      [req.userId, req.userId, req.userId]
    );
    if (!rows.length) return res.json([]);
    const ids = rows.map(r => r.friend_id);
    const placeholders = ids.map(() => '?').join(',');
    const friends = await db.all(`SELECT id, user_id, display_name, profile_pic FROM users WHERE id IN (${placeholders})`, ids);
    res.json(friends.map(u => ({ userId: u.id, userIdCode: u.user_id, displayName: u.display_name, profilePic: u.profile_pic })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ペンディングリクエスト
router.get('/pending', auth, async (req, res) => {
  try {
    const rows = await db.all(
      "SELECT id, user_a_id, user_b_id, requested_by FROM friendships WHERE (user_a_id = ? OR user_b_id = ?) AND status = 'pending'",
      [req.userId, req.userId]
    );
    if (!rows.length) return res.json([]);
    const result = [];
    for (const r of rows) {
      const otherId = r.user_a_id === req.userId ? r.user_b_id : r.user_a_id;
      const other = await db.get('SELECT id, user_id, display_name, profile_pic FROM users WHERE id = ?', [otherId]);
      if (other) result.push({ friendshipId: r.id, userId: other.id, userIdCode: other.user_id, displayName: other.display_name, profilePic: other.profile_pic, isSentByMe: r.requested_by === req.userId });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
