// routes/admin.js
// -----------------------------------------------------------------------
// 管理者専用API(管理用exeから使う)。
// 環境変数 ADMIN_API_KEY が未設定ならこのAPI全体が存在しない扱い(404)になる。
// 鍵はヘッダー x-admin-key で渡す。通常ユーザーのJWTとは完全に別物。
// -----------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db/db');
const { asyncHandler } = require('../utils/asyncHandler');
const { validatePassword } = require('../utils/passwordPolicy');
const sessionEvents = require('../utils/sessionEvents');
const pkg = require('../package.json');

const router = express.Router();

// 鍵の総当たり対策: 失敗だけ数えて、IP単位で15分に10回まで
const failLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '試行が多すぎます。しばらくしてから再度お試しください。' },
});

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (!key || key.length < 16) return res.status(404).json({ error: 'Not Found' });
  const given = req.get('x-admin-key') || '';
  if (!crypto.timingSafeEqual(sha(given), sha(key))) return res.status(401).json({ error: '管理キーが違います' });
  next();
}

router.use(failLimiter, requireAdmin);

async function count(sql) {
  try { const r = await db.get(sql); return Number(r && r.n) || 0; } catch (e) { return null; }
}

router.get('/stats', asyncHandler(async (req, res) => {
  let online = null;
  try {
    const { isUserOnline } = require('../ws/wsServer');
    const ids = await db.all("SELECT id FROM users WHERE password_hash <> ''");
    online = ids.filter(u => isUserOnline(u.id)).length;
  } catch (e) {}
  res.json({
    version: pkg.version,
    uptimeSec: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    users: await count("SELECT COUNT(*) AS n FROM users WHERE password_hash <> ''"),
    online,
    messages: await count('SELECT COUNT(*) AS n FROM messages'),
    groupMessages: await count('SELECT COUNT(*) AS n FROM group_messages'),
    groups: await count('SELECT COUNT(*) AS n FROM groups'),
    posts: await count('SELECT COUNT(*) AS n FROM posts'),
    activeSessions: await count('SELECT COUNT(*) AS n FROM user_sessions WHERE revoked_at IS NULL'),
  });
}));

router.get('/users', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const like = `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`;
  const rows = await db.all(
    `SELECT id, user_id, username, display_name, created_at, failed_login_count, locked_until, token_revoked_at, banned_until, ban_reason
       FROM users
      WHERE username NOT LIKE 'deleted%' AND (? = '' OR username LIKE ? OR display_name LIKE ? OR user_id LIKE ?)
      ORDER BY created_at DESC LIMIT 200`,
    [q, like, like, like]
  );
  let isOnline = () => false;
  try { isOnline = require('../ws/wsServer').isUserOnline; } catch (e) {}
  res.json({
    users: rows.map(u => ({
      id: u.id,
      userId: u.user_id,
      username: u.username,
      displayName: u.display_name,
      createdAt: u.created_at,
      locked: Number(u.locked_until || 0) > Date.now(),
      failedLogins: Number(u.failed_login_count || 0),
      banned: Number(u.banned_until || 0) > Date.now(),
      bannedUntil: Number(u.banned_until || 0) > Date.now() ? Number(u.banned_until) : null,
      banReason: u.ban_reason || null,
      online: isOnline(u.id),
    })),
  });
}));

async function findUser(id) {
  // (Googleログインのアカウントはパスワードが空なので、以前は一覧にも出ず操作もできなかった。退会済みだけ除く)
  return db.get("SELECT id, username FROM users WHERE id = ? AND username NOT LIKE 'deleted%'", [String(id).slice(0, 100)]);
}

// 全端末からログアウトさせる
router.post('/users/:id/logout', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  await db.run('UPDATE users SET token_revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [u.id]);
  await db.run('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [u.id]);
  try { sessionEvents.emit('revoked', { userId: u.id }); } catch (e) {}
  res.json({ ok: true });
}));

// ログインロックを解除
router.post('/users/:id/unlock', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  await db.run('UPDATE users SET failed_login_count = 0, locked_until = 0 WHERE id = ?', [u.id]);
  res.json({ ok: true });
}));

// 禁止語による利用停止を解除する(Googleログインのアカウントも対象)
router.post('/users/:id/unban', asyncHandler(async (req, res) => {
  const u = await db.get('SELECT id FROM users WHERE id = ? OR user_id = ?', [String(req.params.id).slice(0, 100), String(req.params.id).slice(0, 20)]);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  await db.run('UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?', [u.id]);
  res.json({ ok: true });
}));

// パスワードを強制的に再設定(全端末ログアウトも兼ねる)
router.post('/users/:id/password', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  const password = req.body && req.body.password;
  const bad = validatePassword(password, u.username);
  if (bad) return res.status(400).json({ error: bad });
  const hash = await bcrypt.hash(password, 12);
  await db.run('UPDATE users SET password_hash = ?, token_revoked_at = CURRENT_TIMESTAMP, failed_login_count = 0, locked_until = 0 WHERE id = ?', [hash, u.id]);
  await db.run('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [u.id]);
  try { sessionEvents.emit('revoked', { userId: u.id }); } catch (e) {}
  res.json({ ok: true });
}));

// バグ報告・通報の一覧。status=open|resolved|all(既定open)
router.get('/reports', asyncHandler(async (req, res) => {
  const st = ['open', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const rows = await db.all(
    `SELECT r.id, r.kind, r.category, r.message, r.app_version, r.user_agent, r.status, r.created_at,
            rp.username AS reporter_username, rp.display_name AS reporter_name,
            tg.id AS target_id, tg.username AS target_username, tg.display_name AS target_name
       FROM reports r
       LEFT JOIN users rp ON rp.id = r.reporter_id
       LEFT JOIN users tg ON tg.id = r.target_id
      WHERE (? = 'all' OR r.status = ?)
      ORDER BY r.created_at DESC LIMIT 200`,
    [st, st]
  );
  res.json({
    reports: rows.map(r => ({
      id: r.id, kind: r.kind, category: r.category, message: r.message,
      appVersion: r.app_version, userAgent: r.user_agent, status: r.status, createdAt: r.created_at,
      reporter: { username: r.reporter_username, displayName: r.reporter_name },
      target: r.target_id ? { id: r.target_id, username: r.target_username, displayName: r.target_name } : null,
    })),
  });
}));

router.post('/reports/:id/status', asyncHandler(async (req, res) => {
  const status = req.body && req.body.status;
  if (status !== 'open' && status !== 'resolved') return res.status(400).json({ error: 'statusが正しくありません' });
  const r = await db.get('SELECT id FROM reports WHERE id = ?', [String(req.params.id).slice(0, 100)]);
  if (!r) return res.status(404).json({ error: '見つかりません' });
  await db.run('UPDATE reports SET status = ?, resolved_at = ' + (status === 'resolved' ? 'CURRENT_TIMESTAMP' : 'NULL') + ' WHERE id = ?', [status, r.id]);
  res.json({ ok: true });
}));

module.exports = router;
