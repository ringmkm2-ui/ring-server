// routes/claudeFeed.js
// Claude(予約タスク)がバグ報告を受け取って直すための窓口。
// - 環境変数 CLAUDE_FEED_KEY(24文字以上)が無ければ、この窓口は存在しない扱い(404)
// - ヘッダー x-claude-key で鍵を渡す。管理キー(ADMIN_API_KEY)とは別物で、できることは下の2つだけ
// - 渡すのはバグ報告(kind='bug')だけ。ユーザー通報や、誰が送ったかは渡さない
//   (通報への対応はRingが判断する。報告者の名前は直すのに要らない)
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/db');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

const failLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  message: { error: '試行が多すぎます' },
});
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function requireKey(req, res, next) {
  const key = process.env.CLAUDE_FEED_KEY;
  if (!key || key.length < 24) return res.status(404).json({ error: 'Not Found' });
  if (!crypto.timingSafeEqual(sha(req.get('x-claude-key') || ''), sha(key))) return res.status(401).json({ error: 'unauthorized' });
  next();
}
router.use(failLimiter, requireKey);

// まだClaudeが手を付けていない、未対応のバグ報告(古い順・最大20件)
router.get('/bugs', asyncHandler(async (req, res) => {
  const rows = await db.all(
    `SELECT id, message, app_version, user_agent, created_at FROM reports
      WHERE kind = 'bug' AND status = 'open' AND claude_at IS NULL
      ORDER BY created_at ASC LIMIT 20`
  );
  res.json({ bugs: rows.map(r => ({ id: r.id, message: r.message, appVersion: r.app_version, userAgent: r.user_agent, createdAt: r.created_at })) });
}));

// 手を付けた印とメモ(「PR #12 で修正案」「再現できず: …」など)。同じ報告を次の回に拾わないようにする。
// 「対応済み」にするのはRing(管理exe)の役目なので、ここでは status は変えない
router.post('/bugs/:id/note', asyncHandler(async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
  if (!note) return res.status(400).json({ error: 'note が必要です' });
  const r = await db.get("SELECT id FROM reports WHERE id = ? AND kind = 'bug'", [String(req.params.id).slice(0, 100)]);
  if (!r) return res.status(404).json({ error: '見つかりません' });
  await db.run('UPDATE reports SET claude_note = ?, claude_at = CURRENT_TIMESTAMP WHERE id = ?', [note, r.id]);
  res.json({ ok: true });
}));

module.exports = router;
