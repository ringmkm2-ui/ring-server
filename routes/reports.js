// routes/reports.js
// バグ報告 / ユーザー通報。ログイン中のユーザーだけが送れる。確認は管理API(/api/admin/reports)から。
const express = require('express');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const pkg = require('../package.json');

const router = express.Router();

// 連投・荒らし対策: ユーザー単位で1時間に10件まで
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => 'u:' + (req.userId || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  message: { error: '送信が多すぎます。しばらくしてからもう一度お試しください' },
});

const USER_CATEGORIES = ['spam', 'harassment', 'impersonation', 'inappropriate', 'other'];

function clean(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// body: { kind: 'bug' | 'user', message, category?, targetUserId?(ユーザーの内部ID), targetCode?(U3K7F9のような表示用ID) }
router.post('/', verifyToken, reportLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const kind = body.kind;
  if (kind !== 'bug' && kind !== 'user') return res.status(400).json({ error: '種類が正しくありません' });

  const message = clean(body.message, 2000);
  if (message.length < 5) return res.status(400).json({ error: '内容を5文字以上で書いてください' });

  let targetId = null;
  let category = null;
  if (kind === 'user') {
    category = USER_CATEGORIES.includes(body.category) ? body.category : 'other';
    const byId = clean(body.targetUserId, 100);
    const byCode = clean(body.targetCode, 20).toUpperCase();
    let target = null;
    if (byId) target = await db.get("SELECT id FROM users WHERE id = ? AND password_hash <> ''", [byId]);
    else if (byCode) target = await db.get("SELECT id FROM users WHERE user_id = ? AND password_hash <> ''", [byCode]);
    if (!target) return res.status(404).json({ error: '通報するユーザーが見つかりません' });
    if (target.id === req.userId) return res.status(400).json({ error: '自分自身は通報できません' });
    targetId = target.id;
  }

  await db.run(
    'INSERT INTO reports (id, kind, reporter_id, target_id, category, message, app_version, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), kind, req.userId, targetId, category, message, clean(body.appVersion, 40) || pkg.version, clean(req.get('user-agent'), 300)]
  );
  res.json({ ok: true });
}));

module.exports = router;
