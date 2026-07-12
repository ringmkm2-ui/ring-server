// routes/friends.js
// Friend management: search by ID, send request, accept, list friends
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../middleware/auth');

const { verifyTokenRaw } = require('./auth');

const router = express.Router();

// 認証ミドルウェア
async function auth(req, res, next) {
  const token = req.get('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  
  const decoded = verifyTokenRaw(token);
  if (!decoded) return res.status(401).json({ error: 'invalid token' });
  
  req.userId = decoded.userId;
  next();
}

// プロフィール取得（自分のまたは他人の）
// GET /api/friends/profile/:userIdCode
router.get('/profile/:userIdCode', auth, async (req, res) => {
  try {
    const { userIdCode } = req.params;
    const user = await db.get('SELECT id, user_id, display_name, profile_pic, bio FROM users WHERE user_id = ?', [userIdCode]);
    if (!user) return res.status(404).json({ error: 'user not found' });

    res.json({
      userId: user.id,
      userIdCode: user.user_id,
      displayName: user.display_name,
      profilePic: user.profile_pic,
      bio: user.bio,
    });
  } catch (e) {
    console.error('Error fetching profile:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 自分のプロフィール取得
// GET /api/friends/me
router.get('/me', auth, async (req, res) => {
  try {
    const user = await db.get('SELECT id, user_id, username, display_name, profile_pic, bio FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.status(404).json({ error: 'user not found' });

    res.json({
      userId: user.id,
      userIdCode: user.user_id,
      username: user.username,
      displayName: user.display_name,
      profilePic: user.profile_pic,
      bio: user.bio,
    });
  } catch (e) {
    console.error('Error fetching user profile:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// プロフィール更新
// POST /api/friends/me (body: { displayName, bio, profilePic })
router.post('/me', auth, async (req, res) => {
  try {
    const { displayName, bio, profilePic } = req.body;
    await db.run(
      'UPDATE users SET display_name = ?, bio = ?, profile_pic = ? WHERE id = ?',
      [displayName || '', bio || '', profilePic || '', req.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Error updating profile:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ユーザーID（user_id）で検索
// GET /api/friends/search?q=U3K7F9
router.get('/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);

    const results = await db.all(
      'SELECT id, user_id, display_name, profile_pic FROM users WHERE (user_id LIKE ? OR display_name LIKE ?) AND id != ? LIMIT 10',
      [q + '%', '%' + q + '%', req.userId]
    );

    res.json(results.map(u => ({
      userId: u.id,
      userIdCode: u.user_id,
      displayName: u.display_name,
      profilePic: u.profile_pic,
    })));
  } catch (e) {
    console.error('Error searching users:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 友達リクエスト送信
// POST /api/friends/request (body: { targetUserIdCode })
router.post('/request', auth, async (req, res) => {
  try {
    const { targetUserIdCode } = req.body;
    if (!targetUserIdCode) return res.status(400).json({ error: 'targetUserIdCode required' });

    const targetUser = await db.get('SELECT id FROM users WHERE user_id = ?', [targetUserIdCode]);
    if (!targetUser) return res.status(404).json({ error: 'target user not found' });

    if (targetUser.id === req.userId) return res.status(400).json({ error: 'cannot add yourself' });

    // Normalize: smaller ID first
    const [userA, userB] = [req.userId, targetUser.id].sort();

    // Check existing friendship
    const existing = await db.get('SELECT id, status FROM friendships WHERE user_a_id = ? AND user_b_id = ?', [userA, userB]);
    if (existing) {
      if (existing.status === 'accepted') return res.status(400).json({ error: 'already friends' });
      if (existing.status === 'pending') return res.status(400).json({ error: 'request already sent' });
    }

    const friendshipId = uuidv4();
    await db.run(
      'INSERT INTO friendships (id, user_a_id, user_b_id, status, requested_by) VALUES (?, ?, ?, ?, ?)',
      [friendshipId, userA, userB, 'pending', req.userId]
    );

    res.json({ ok: true, friendshipId });
  } catch (e) {
    console.error('Error sending friend request:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 友達リクエスト承認
// POST /api/friends/accept (body: { friendshipId })
router.post('/accept', auth, async (req, res) => {
  try {
    const { friendshipId } = req.body;
    const friendship = await db.get('SELECT * FROM friendships WHERE id = ?', [friendshipId]);

    if (!friendship) return res.status(404).json({ error: 'friendship request not found' });
    if (friendship.status !== 'pending') return res.status(400).json({ error: 'not pending' });

    const isRecipient = (friendship.user_a_id === req.userId || friendship.user_b_id === req.userId) &&
                        friendship.requested_by !== req.userId;
    if (!isRecipient) return res.status(403).json({ error: 'not authorized' });

    await db.run(
      'UPDATE friendships SET status = ?, accepted_at = datetime("now") WHERE id = ?',
      ['accepted', friendshipId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('Error accepting friend request:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 友達リスト取得
// GET /api/friends/list
router.get('/list', auth, async (req, res) => {
  try {
    const friendships = await db.all(
      `SELECT f.id, f.user_a_id, f.user_b_id, f.status, f.requested_by,
              CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END as friend_id
       FROM friendships f
       WHERE (f.user_a_id = ? OR f.user_b_id = ?) AND f.status = 'accepted'`,
      [req.userId, req.userId, req.userId]
    );

    const friendIds = friendships.map(f => f.friend_id);
    if (friendIds.length === 0) return res.json([]);

    const placeholders = friendIds.map(() => '?').join(',');
    const friends = await db.all(
      `SELECT id, user_id, display_name, profile_pic FROM users WHERE id IN (${placeholders})`,
      friendIds
    );

    res.json(friends.map(u => ({
      userId: u.id,
      userIdCode: u.user_id,
      displayName: u.display_name,
      profilePic: u.profile_pic,
    })));
  } catch (e) {
    console.error('Error listing friends:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ペンディングリクエスト取得
// GET /api/friends/pending
router.get('/pending', auth, async (req, res) => {
  try {
    const pending = await db.all(
      `SELECT f.id, f.user_a_id, f.user_b_id, f.requested_by,
              CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END as requester_id
       FROM friendships f
       WHERE (f.user_a_id = ? OR f.user_b_id = ?) AND f.status = 'pending'`,
      [req.userId, req.userId, req.userId]
    );

    const requesterIds = pending.map(p => p.requester_id);
    if (requesterIds.length === 0) return res.json([]);

    const placeholders = requesterIds.map(() => '?').join(',');
    const requesters = await db.all(
      `SELECT id, user_id, display_name, profile_pic FROM users WHERE id IN (${placeholders})`,
      requesterIds
    );

    res.json(pending.map(p => {
      const requester = requesters.find(r => r.id === p.requester_id);
      return {
        friendshipId: p.id,
        userId: requester.id,
        userIdCode: requester.user_id,
        displayName: requester.display_name,
        profilePic: requester.profile_pic,
        requestedBy: p.requested_by === req.userId,
      };
    }));
  } catch (e) {
    console.error('Error listing pending requests:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
