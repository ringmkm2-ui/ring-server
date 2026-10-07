// routes/staff.js
// アプリの中で使える運営機能(管理用exeとは別)。今は「誰がオンラインか」を見るだけ。
// 使えるのは環境変数 STAFF_USERS に書いたアカウント(カンマ区切りで メールアドレス か IDコード)。
// 未設定なら Ring の本アカと別アカ(UMTUK9D)。普通のユーザーには、この機能があること自体見せない(404)。
const express = require('express');
const db = require('../db/db');
const { verifyToken: auth } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { adminUserIds } = require('../utils/adminNotify');

const router = express.Router();
const DEFAULT_STAFF = 'ringmkm2@gmail.com,UMTUK9D';

let cache = { ids: null, ts: 0 };
async function staffIds() {
  if (cache.ids && Date.now() - cache.ts < 60000) return cache.ids;
  const ids = new Set(await adminUserIds('STAFF_USERS', DEFAULT_STAFF));
  // 運営アカウントがまだ1つも無い時は覚えない(後から作った時にすぐ使えるように)
  if (ids.size) cache = { ids, ts: Date.now() };
  return ids;
}
async function requireStaff(req, res, next) {
  try {
    if ((await staffIds()).has(req.userId)) return next();
  } catch (e) { console.error('[staff] lookup failed:', e.message); }
  res.status(404).json({ error: 'Not Found' });
}

router.get('/me', auth, asyncHandler(async (req, res) => {
  res.json({ staff: (await staffIds()).has(req.userId) });
}));

router.get('/online', auth, requireStaff, asyncHandler(async (req, res) => {
  const { onlineUsers } = require('../ws/wsServer');
  const list = onlineUsers();
  if (!list.length) return res.json({ count: 0, users: [] });
  const ids = list.map(u => u.userId);
  const ph = ids.map(() => '?').join(',');
  const rows = await db.all(`SELECT id, user_id, display_name, profile_pic FROM users WHERE id IN (${ph})`, ids);
  const byId = new Map(rows.map(r => [r.id, r]));
  const users = list.map(u => {
    const r = byId.get(u.userId) || {};
    return { userId: u.userId, userIdCode: r.user_id || '', displayName: r.display_name || '(不明)', profilePic: r.profile_pic || '', since: u.since, devices: u.devices };
  }).sort((a, b) => (b.since || 0) - (a.since || 0));
  res.json({ count: users.length, users });
}));

// 全ユーザー一覧(最後にいた順)。メールアドレスは出さない
router.get('/users', auth, requireStaff, asyncHandler(async (req, res) => {
  const { isUserOnline } = require('../ws/wsServer');
  const rows = await db.all(
    `SELECT u.id, u.user_id, u.display_name, u.profile_pic, u.created_at, u.banned_until,
            (SELECT MAX(s.last_seen_at) FROM user_sessions s WHERE s.user_id = u.id) AS last_seen
       FROM users u
      WHERE u.username NOT LIKE 'deleted%'
      LIMIT 2000`
  );
  const users = rows.map(r => ({
    userId: r.id, userIdCode: r.user_id, displayName: r.display_name || '(名前なし)', profilePic: r.profile_pic || '',
    createdAt: r.created_at, lastSeen: r.last_seen, online: isUserOnline(r.id),
    banned: Number(r.banned_until) > Date.now(),
  })).sort((a, b) => (b.online - a.online) || (new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0)));
  res.json({ count: users.length, online: users.filter(u => u.online).length, users });
}));

module.exports = router;
