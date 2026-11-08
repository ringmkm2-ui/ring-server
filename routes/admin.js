// routes/admin.js
// -----------------------------------------------------------------------
// 管理者専用API(管理用exeから使う)。
// 環境変数 ADMIN_API_KEY が未設定ならこのAPI全体が存在しない扱い(404)になる。
// 鍵はヘッダー x-admin-key で渡す。通常ユーザーのJWTとは完全に別物。
// -----------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/db');
const { asyncHandler } = require('../utils/asyncHandler');
const { validatePassword } = require('../utils/passwordPolicy');
const sessionEvents = require('../utils/sessionEvents');
const pkg = require('../package.json');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// 鍵の総当たり対策: 鍵が違う(401)だけ数えて、IP単位で15分に10回まで
// (入力ミスの400や対象なしの404まで数えると、管理画面の普通の操作で締め出される)
const failLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '試行が多すぎます。しばらくしてから再度お試しください。' },
});

const isGuestName = n => /^guest_/i.test(String(n || ''));

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (!key || key.length < 16) return res.status(404).json({ error: 'Not Found' });
  const given = req.get('x-admin-key') || '';
  if (!crypto.timingSafeEqual(sha(given), sha(key))) return res.status(401).json({ error: '管理キーが違います' });
  next();
}

router.use(failLimiter, requireAdmin);

async function count(sql, params = []) {
  try { const r = await db.get(sql, params); return Number(r && r.n) || 0; } catch (e) { return null; }
}

// 操作ログ。失敗しても本処理は落とさない。パスワードや鍵は渡さないこと
async function audit(req, action, target, detail) {
  try {
    const t = target || {};
    await db.run(
      'INSERT INTO admin_audit (id, action, target_type, target_id, target_label, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), action, t.type || null, t.id ? String(t.id).slice(0, 100) : null, t.label ? String(t.label).slice(0, 100) : null, detail ? String(detail).slice(0, 500) : null, String(req.ip || '').slice(0, 64)]
    );
  } catch (e) { console.error('[admin] audit failed:', e.message); }
}

function intParam(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function likeOf(q) { return `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`; }
// created_at と比べる用(SQLiteの文字列でもPostgresのTIMESTAMPでも通る形)
function sqlTime(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }
function getOnlineFn() {
  try { return require('../ws/wsServer').isUserOnline; } catch (e) { return () => false; }
}

router.get('/stats', asyncHandler(async (req, res) => {
  let online = null;
  try {
    const { isUserOnline } = require('../ws/wsServer');
    const ids = await db.all("SELECT id FROM users WHERE password_hash <> ''");
    online = ids.filter(u => isUserOnline(u.id)).length;
  } catch (e) {}
  let wsConnections = null;
  try { wsConnections = require('../ws/wsServer').onlineUsers().reduce((a, u) => a + (u.devices || 0), 0); } catch (e) {}
  let dbMs = null;
  try { const t0 = process.hrtime.bigint(); await db.get('SELECT 1 AS n'); dbMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10; } catch (e) {}
  const now = Date.now();
  res.json({
    version: pkg.version,
    adminApi: 3,
    uptimeSec: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    users: await count("SELECT COUNT(*) AS n FROM users WHERE password_hash <> ''"),
    online,
    messages: await count('SELECT COUNT(*) AS n FROM messages'),
    groupMessages: await count('SELECT COUNT(*) AS n FROM group_messages'),
    groups: await count('SELECT COUNT(*) AS n FROM groups'),
    posts: await count('SELECT COUNT(*) AS n FROM posts'),
    activeSessions: await count('SELECT COUNT(*) AS n FROM user_sessions WHERE revoked_at IS NULL'),
    newUsers24h: await count("SELECT COUNT(*) AS n FROM users WHERE substr(username, 1, 8) != 'deleted_' AND created_at >= ?", [sqlTime(now - 24 * 3600 * 1000)]),
    newUsers7d: await count("SELECT COUNT(*) AS n FROM users WHERE substr(username, 1, 8) != 'deleted_' AND created_at >= ?", [sqlTime(now - 7 * 24 * 3600 * 1000)]),
    openReports: await count("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
    bannedUsers: await count("SELECT COUNT(*) AS n FROM users WHERE substr(username, 1, 8) != 'deleted_' AND banned_until > ?", [now]),
    dbMs,
    wsConnections,
  });
}));

// ---- ユーザー ----
const USER_COLS = `u.id, u.user_id, u.username, u.display_name, u.real_name, u.bio, u.profile_pic, u.created_at,
       u.banned_until, u.ban_reason, u.email_verified_at, u.totp_enabled, u.password_hash,
       (SELECT MAX(s.last_seen_at) FROM user_sessions s WHERE s.user_id = u.id) AS last_seen`;

// username -> 失敗回数。IN の個数が増えすぎないよう分けて引く
async function failsFor(usernames) {
  const { LOGIN_POLICY, accountFailCount } = require('../utils/attemptLimit');
  const out = new Map();
  for (let i = 0; i < usernames.length; i += 500) {
    const m = await accountFailCount(LOGIN_POLICY, usernames.slice(i, i + 500));
    for (const [k, v] of m) out.set(k, v);
  }
  return out;
}

function toUser(u, fails, isOnline) {
  const { LOGIN_POLICY } = require('../utils/attemptLimit');
  const bu = Number(u.banned_until || 0);
  const banned = bu > Date.now();
  const f = fails.get(u.username) || 0;
  return {
    id: u.id,
    userId: u.user_id,
    username: u.username,
    displayName: u.display_name,
    realName: u.real_name || '',
    createdAt: u.created_at,
    lastSeen: u.last_seen || null,
    locked: f >= LOGIN_POLICY.perAccount,
    failedLogins: f,
    banned,
    bannedUntil: banned ? bu : null,
    banReason: u.ban_reason || null,
    online: !!isOnline(u.id),
    // 招待コードで登録した人は guest_xxxx という仮の名前で、メールもパスワードも持たない(後から設定できる)
    guest: isGuestName(u.username),
    emailVerified: !isGuestName(u.username) && !!u.email_verified_at,
    googleOnly: !u.password_hash && !isGuestName(u.username),
    totp: !!u.totp_enabled,
  };
}

router.get('/users', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const filter = ['all', 'online', 'banned', 'locked'].includes(req.query.filter) ? req.query.filter : 'all';
  const sort = ['created', 'name', 'lastSeen'].includes(req.query.sort) ? req.query.sort : 'created';
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const limit = intParam(req.query.limit, 1, 200, 50);
  const offset = intParam(req.query.offset, 0, 100000000, 0);

  const where = ["substr(u.username, 1, 8) != 'deleted_'"];
  const params = [];
  if (q) {
    const like = likeOf(q);
    where.push("(u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.user_id LIKE ? ESCAPE '\\' OR u.real_name LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  if (filter === 'banned') { where.push('u.banned_until > ?'); params.push(Date.now()); }
  const orderBy = sort === 'name' ? `LOWER(COALESCE(t.display_name, '')) ${order}, t.id`
    : sort === 'lastSeen' ? `CASE WHEN t.last_seen IS NULL THEN 1 ELSE 0 END, t.last_seen ${order}, t.id`
    : `t.created_at ${order}, t.id`;
  const inner = `SELECT ${USER_COLS} FROM users u WHERE ${where.join(' AND ')}`;
  const isOnline = getOnlineFn();

  // online / locked はSQLで絞れないので、上限5000件を取ってJSで絞る
  if (filter === 'online' || filter === 'locked') {
    const rows = await db.all(`SELECT * FROM (${inner}) t ORDER BY ${orderBy} LIMIT 5000`, params);
    const fails = await failsFor(rows.map(u => u.username));
    const all = rows.map(u => toUser(u, fails, isOnline)).filter(u => (filter === 'online' ? u.online : u.locked));
    return res.json({ total: all.length, users: all.slice(offset, offset + limit) });
  }
  const totalRow = await db.get(`SELECT COUNT(*) AS n FROM users u WHERE ${where.join(' AND ')}`, params);
  const rows = await db.all(`SELECT * FROM (${inner}) t ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const fails = await failsFor(rows.map(u => u.username));
  res.json({ total: Number(totalRow && totalRow.n) || 0, users: rows.map(u => toUser(u, fails, isOnline)) });
}));

// id でも IDコード(user_id)でも引く。退会済みは除く
// (Googleログインのアカウントはパスワードが空なので、以前は一覧にも出ず操作もできなかった)
async function findUser(id) {
  const s = String(id).slice(0, 100);
  return db.get(
    "SELECT id, user_id, username, display_name FROM users WHERE (id = ? OR user_id = ?) AND substr(username, 1, 8) != 'deleted_'",
    [s, s]
  );
}
function userLabel(u) { return `${u.display_name || '(名前なし)'} (${u.user_id})`; }
function userTarget(u) { return { type: 'user', id: u.id, label: userLabel(u) }; }

const REPORT_SELECT = `SELECT r.id, r.kind, r.category, r.message, r.app_version, r.user_agent, r.status, r.created_at, r.claude_note, r.media_urls,
            rp.username AS reporter_username, rp.display_name AS reporter_name,
            tg.id AS target_id, tg.username AS target_username, tg.display_name AS target_name
       FROM reports r
       LEFT JOIN users rp ON rp.id = r.reporter_id
       LEFT JOIN users tg ON tg.id = r.target_id`;

function parseUrls(s) { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

function toReport(r) {
  return {
    id: r.id, kind: r.kind, category: r.category, message: r.message,
    appVersion: r.app_version, userAgent: r.user_agent, status: r.status, createdAt: r.created_at,
    claudeNote: r.claude_note || null,
    mediaUrls: parseUrls(r.media_urls),
    reporter: { username: r.reporter_username, displayName: r.reporter_name },
    target: r.target_id ? { id: r.target_id, username: r.target_username, displayName: r.target_name } : null,
  };
}

router.get('/users/:id', asyncHandler(async (req, res) => {
  const s = String(req.params.id).slice(0, 100);
  const u = await db.get(
    `SELECT ${USER_COLS} FROM users u WHERE (u.id = ? OR u.user_id = ?) AND substr(u.username, 1, 8) != 'deleted_'`,
    [s, s]
  );
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  const fails = await failsFor([u.username]);
  const sessions = await db.all(
    'SELECT id, device, ip, created_at, last_seen_at, revoked_at, revoked_reason FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
    [u.id]
  );
  const n = async (sql, p) => (await count(sql, p)) || 0;
  const counts = {
    posts: await n('SELECT COUNT(*) AS n FROM posts WHERE author_id = ? AND deleted_at IS NULL', [u.id]),
    groups: await n('SELECT COUNT(*) AS n FROM group_members WHERE user_id = ? AND left_at IS NULL', [u.id]),
    friends: await n("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (user_a_id = ? OR user_b_id = ?)", [u.id, u.id]),
    sentMessages: await n("SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND COALESCE(msg_type, 'text') != 'notice'", [u.id])
      + await n("SELECT COUNT(*) AS n FROM group_messages WHERE sender_id = ? AND COALESCE(msg_type, 'text') != 'notice'", [u.id]),
  };
  const against = await db.all(`${REPORT_SELECT} WHERE r.target_id = ? ORDER BY r.created_at DESC LIMIT 20`, [u.id]);
  const by = await db.all(`${REPORT_SELECT} WHERE r.reporter_id = ? ORDER BY r.created_at DESC LIMIT 20`, [u.id]);
  res.json({
    user: { ...toUser(u, fails, getOnlineFn()), bio: u.bio || '', profilePic: u.profile_pic || null },
    sessions: sessions.map(x => ({ id: x.id, device: x.device, ip: x.ip, createdAt: x.created_at, lastSeenAt: x.last_seen_at, revoked: !!x.revoked_at, revokedAt: x.revoked_at || null, revokedReason: x.revoked_reason || null })),
    counts,
    reportsAgainst: against.map(toReport),
    reportsBy: by.map(toReport),
  });
}));

// 全端末からログアウトさせる
router.post('/users/:id/logout', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  await db.run('UPDATE users SET token_revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [u.id]);
  await db.run("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'admin_logout' WHERE user_id = ? AND revoked_at IS NULL", [u.id]);
  try { sessionEvents.emit('revoked', { userId: u.id }); } catch (e) {}
  await audit(req, 'user.logout', userTarget(u), '全端末ログアウト');
  res.json({ ok: true });
}));

// ログインロックを解除
router.post('/users/:id/unlock', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  await db.run('UPDATE users SET failed_login_count = 0, locked_until = 0 WHERE id = ?', [u.id]);
  const { LOGIN_POLICY, clearAccount } = require('../utils/attemptLimit');
  await clearAccount(LOGIN_POLICY, u.username);
  await audit(req, 'user.unlock', userTarget(u), 'ロック解除');
  res.json({ ok: true });
}));

// 利用停止を解除する(Googleログインのアカウントも対象)
router.post('/users/:id/unban', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  await db.run('UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?', [u.id]);
  await audit(req, 'user.unban', userTarget(u), '利用停止を解除');
  res.json({ ok: true });
}));

// 利用停止にする。次のAPIから authMiddleware が弾き、接続中のWebSocketも切る
router.post('/users/:id/ban', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  const body = req.body || {};
  const hours = body.hours;
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 87600) {
    return res.status(400).json({ error: '時間は1〜87600の整数で指定してください' });
  }
  if (body.reason != null && typeof body.reason !== 'string') return res.status(400).json({ error: '理由は文字列で指定してください' });
  const reason = String(body.reason || '').trim().slice(0, 200);
  const until = Date.now() + hours * 3600000;
  await db.run('UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?', [until, reason || null, u.id]);
  try { require('../ws/wsServer').disconnectBanned(u.id, until); } catch (e) {}
  await audit(req, 'user.ban', userTarget(u), reason ? `${hours}時間: ${reason}` : `${hours}時間`);
  res.json({ ok: true, bannedUntil: until });
}));

// 端末(セッション)を1つだけ失効させる
router.post('/users/:id/sessions/:sid/revoke', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  const sid = String(req.params.sid).slice(0, 100);
  const s = await db.get('SELECT id, device FROM user_sessions WHERE id = ? AND user_id = ?', [sid, u.id]);
  if (!s) return res.status(404).json({ error: 'セッションが見つかりません' });
  await db.run("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'admin_revoke' WHERE id = ? AND revoked_at IS NULL", [s.id]);
  try { sessionEvents.emit('revoked', { userId: u.id, sid: s.id }); } catch (e) {}
  await audit(req, 'user.session_revoke', userTarget(u), s.device ? `端末: ${String(s.device).slice(0, 80)}` : 'セッション失効');
  res.json({ ok: true });
}));

// パスワードを強制的に再設定(全端末ログアウトも兼ねる)
router.post('/users/:id/password', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  const password = req.body && req.body.password;
  const bad = validatePassword(password, u.username);
  if (bad) return res.status(400).json({ error: bad });
  const hash = await require('../utils/passwordHash').hash(password, 12);
  await db.run('UPDATE users SET password_hash = ?, token_revoked_at = CURRENT_TIMESTAMP, failed_login_count = 0, locked_until = 0 WHERE id = ?', [hash, u.id]);
  await db.run("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'admin_password' WHERE user_id = ? AND revoked_at IS NULL", [u.id]);
  try { sessionEvents.emit('revoked', { userId: u.id }); } catch (e) {}
  await audit(req, 'user.password', userTarget(u), 'パスワードを再設定');
  res.json({ ok: true });
}));

// アカウントを削除する(元に戻せない)。本人の退会と同じ後始末(utils/accountRemoval.js)を使う。
// 誤操作を防ぐため、body.confirm にそのユーザーのIDコードを入れさせる。運営アカウントは削除できない。
router.post('/users/:id/delete', asyncHandler(async (req, res) => {
  const u = await findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  const confirm = req.body && req.body.confirm;
  if (typeof confirm !== 'string' || confirm.trim().toUpperCase() !== String(u.user_id).toUpperCase()) {
    return res.status(400).json({ error: 'IDコードが一致しません' });
  }
  const { adminUserIds, DEFAULT_ADMINS, DEFAULT_STAFF } = require('../utils/adminNotify');
  const protectedIds = new Set([
    ...await adminUserIds('ADMIN_NOTIFY', DEFAULT_ADMINS),
    ...await adminUserIds('STAFF_USERS', DEFAULT_STAFF),
  ]);
  if (protectedIds.has(u.id)) return res.status(400).json({ error: '運営アカウントは削除できません' });
  const target = userTarget(u); // 匿名化される前に名前を控える
  await require('../utils/accountRemoval').removeAccount(u.id);
  await audit(req, 'user.delete', target, 'アカウントを削除(元に戻せない)');
  res.json({ ok: true });
}));

// ---- オンライン ----
router.get('/online', asyncHandler(async (req, res) => {
  let list = [];
  try { list = require('../ws/wsServer').onlineUsers(); } catch (e) {}
  if (!list.length) return res.json({ count: 0, users: [] });
  const ids = list.map(u => u.userId);
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    rows.push(...await db.all(`SELECT id, user_id, display_name, real_name FROM users WHERE id IN (${part.map(() => '?').join(',')})`, part));
  }
  const byId = new Map(rows.map(r => [r.id, r]));
  const users = list.map(u => {
    const r = byId.get(u.userId) || {};
    return { id: u.userId, userId: r.user_id || '', displayName: r.display_name || '(不明)', realName: r.real_name || '', since: u.since, devices: u.devices };
  }).sort((a, b) => (b.since || 0) - (a.since || 0));
  res.json({ count: users.length, users });
}));

// ---- 投稿 ----
router.get('/posts', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const del = req.query.deleted === '1' || req.query.deleted === 'all' ? req.query.deleted : '0';
  const limit = intParam(req.query.limit, 1, 100, 30);
  const offset = intParam(req.query.offset, 0, 100000000, 0);
  const where = [];
  const params = [];
  if (del === '0') where.push('p.deleted_at IS NULL');
  else if (del === '1') where.push('p.deleted_at IS NOT NULL');
  if (q) {
    const like = likeOf(q);
    where.push("(p.text LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.user_id LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const from = `FROM posts p LEFT JOIN users u ON u.id = p.author_id ${w}`;
  const totalRow = await db.get(`SELECT COUNT(*) AS n ${from}`, params);
  const rows = await db.all(
    `SELECT p.id, p.author_id, p.text, p.media_url, p.media_type, p.created_at, p.deleted_at, p.view_count,
            u.display_name AS author_name, u.user_id AS author_user_id
       ${from} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  res.json({
    total: Number(totalRow && totalRow.n) || 0,
    posts: rows.map(p => ({
      id: p.id, authorId: p.author_id, authorName: p.author_name || '(不明)', authorUserId: p.author_user_id || '',
      text: p.text || '', mediaUrl: p.media_url || null, mediaType: p.media_type || null,
      createdAt: p.created_at, deletedAt: p.deleted_at || null, viewCount: Number(p.view_count) || 0,
    })),
  });
}));

async function findPost(id) {
  return db.get(
    `SELECT p.id, p.text, u.display_name AS author_name FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
    [String(id).slice(0, 100)]
  );
}
function postTarget(p) { return { type: 'post', id: p.id, label: p.author_name || '(不明)' }; }
function snippet(t) { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > 40 ? s.slice(0, 40) + '...' : s; }

router.post('/posts/:id/delete', asyncHandler(async (req, res) => {
  const p = await findPost(req.params.id);
  if (!p) return res.status(404).json({ error: '投稿が見つかりません' });
  await db.run('UPDATE posts SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL', [p.id]);
  await audit(req, 'post.delete', postTarget(p), snippet(p.text));
  res.json({ ok: true });
}));

router.post('/posts/:id/restore', asyncHandler(async (req, res) => {
  const p = await findPost(req.params.id);
  if (!p) return res.status(404).json({ error: '投稿が見つかりません' });
  await db.run('UPDATE posts SET deleted_at = NULL WHERE id = ?', [p.id]);
  await audit(req, 'post.restore', postTarget(p), snippet(p.text));
  res.json({ ok: true });
}));

// ---- 操作ログ ----
router.get('/audit', asyncHandler(async (req, res) => {
  const limit = intParam(req.query.limit, 1, 200, 50);
  const offset = intParam(req.query.offset, 0, 100000000, 0);
  const totalRow = await db.get('SELECT COUNT(*) AS n FROM admin_audit');
  const rows = await db.all(
    'SELECT id, at, action, target_type, target_id, target_label, detail FROM admin_audit ORDER BY at DESC, id DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );
  res.json({
    total: Number(totalRow && totalRow.n) || 0,
    entries: rows.map(a => ({ id: a.id, at: a.at, action: a.action, targetType: a.target_type, targetId: a.target_id, targetLabel: a.target_label, detail: a.detail })),
  });
}));

// ---- 通報 ----
// バグ報告・通報の一覧。status=open|resolved|all(既定open)
router.get('/reports', asyncHandler(async (req, res) => {
  const st = ['open', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const rows = await db.all(`${REPORT_SELECT} WHERE (? = 'all' OR r.status = ?) ORDER BY r.created_at DESC LIMIT 200`, [st, st]);
  res.json({ reports: rows.map(toReport) });
}));

router.post('/reports/:id/status', asyncHandler(async (req, res) => {
  const status = req.body && req.body.status;
  if (status !== 'open' && status !== 'resolved') return res.status(400).json({ error: 'statusが正しくありません' });
  const r = await db.get('SELECT id, kind, category FROM reports WHERE id = ?', [String(req.params.id).slice(0, 100)]);
  if (!r) return res.status(404).json({ error: '見つかりません' });
  await db.run('UPDATE reports SET status = ?, resolved_at = ' + (status === 'resolved' ? 'CURRENT_TIMESTAMP' : 'NULL') + ' WHERE id = ?', [status, r.id]);
  await audit(req, 'report.status', { type: 'report', id: r.id, label: [r.kind, r.category].filter(Boolean).join(' / ') }, status === 'resolved' ? '対応済みにした' : '未対応に戻した');
  res.json({ ok: true });
}));

module.exports = router;
