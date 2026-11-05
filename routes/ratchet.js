// routes/ratchet.js
// 個人チャットのラチェット(public/js/ratchet.js)のプリキー。公開鍵だけを預かる。
// サーバーがプリキーを偽っても本文は読めない(受け取る端末に対応する秘密鍵が無く、開けずに止まる)。
const express = require('express');
const db = require('../db/db');
const deviceKeys = require('../utils/deviceKeys');
const { isAcquainted } = require('../utils/relations');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { prekeyLimiter, apiLimiter } = require('../utils/rateLimits');

const router = express.Router();
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const MAX_UPLOAD = 100, MAX_STORED = 200;
const validId = n => Number.isInteger(n) && n > 0 && n <= 0x7fffffff;

// 全員に一度に入れず、本番の環境変数で段階的に広げる(RATCHET_ENABLED=on で全員、RATCHET_USERS=ID,ID で指定の人だけ)
async function enabledFor(userId) {
  if (process.env.RATCHET_ENABLED === 'on') return true;
  const list = String(process.env.RATCHET_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return false;
  const u = await db.get('SELECT user_id FROM users WHERE id = ?', [userId]);
  return !!(u && list.includes(u.user_id));
}

router.use(verifyToken);

router.get('/config', asyncHandler(async (req, res) => {
  res.json({ enabled: await enabledFor(req.user.userId) });
}));

router.get('/prekeys/count', asyncHandler(async (req, res) => {
  const key = req.query.deviceKey;
  if (typeof key !== 'string' || !KEY_RE.test(key)) return res.status(400).json({ error: '公開鍵の形式が不正です' });
  const row = await db.get('SELECT spk_id FROM device_prekeys WHERE user_id = ? AND device_key = ?', [req.user.userId, key]);
  const c = await db.get('SELECT COUNT(*) AS c FROM device_otks WHERE user_id = ? AND device_key = ?', [req.user.userId, key]);
  res.json({ spkId: row ? Number(row.spk_id) : null, otks: Number(c && c.c) || 0 });
}));

router.post('/prekeys', prekeyLimiter, asyncHandler(async (req, res) => {
  const { deviceKey, spk, otks } = req.body || {};
  if (typeof deviceKey !== 'string' || !KEY_RE.test(deviceKey)) return res.status(400).json({ error: '公開鍵の形式が不正です' });
  if (!spk || !validId(spk.id) || typeof spk.pub !== 'string' || !KEY_RE.test(spk.pub)) return res.status(400).json({ error: 'プリキーの形式が不正です' });
  const list = Array.isArray(otks) ? otks : [];
  if (list.length > MAX_UPLOAD || list.some(k => !k || !validId(k.id) || typeof k.pub !== 'string' || !KEY_RE.test(k.pub))) {
    return res.status(400).json({ error: 'プリキーの形式が不正です' });
  }
  // 自分の有効な端末の鍵にだけ置ける(承認待ちの端末にはまだ誰も送らない)
  const st = await deviceKeys.statusOf(req.user.userId, deviceKey);
  if (st.status !== 'active') return res.status(403).json({ error: 'この端末では登録できません' });
  await db.run(
    `INSERT INTO device_prekeys (user_id, device_key, spk_id, spk_pub, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_key) DO UPDATE SET spk_id = excluded.spk_id, spk_pub = excluded.spk_pub, updated_at = excluded.updated_at`,
    [req.user.userId, deviceKey, spk.id, spk.pub, Date.now()]
  );
  const c = await db.get('SELECT COUNT(*) AS c FROM device_otks WHERE user_id = ? AND device_key = ?', [req.user.userId, deviceKey]);
  const room = Math.max(0, MAX_STORED - (Number(c && c.c) || 0));
  for (const k of list.slice(0, room)) {
    await db.run('INSERT INTO device_otks (user_id, device_key, otk_id, pub) VALUES (?, ?, ?, ?) ON CONFLICT(device_key, otk_id) DO NOTHING', [req.user.userId, deviceKey, k.id, k.pub]);
  }
  res.json({ ok: true });
}));

// 相手の端末のプリキーを1組もらう。OTKは1回限りなので、同時に取られても同じものを渡さない
router.get('/bundle/:deviceKey', apiLimiter, asyncHandler(async (req, res) => {
  const key = req.params.deviceKey;
  if (typeof key !== 'string' || !KEY_RE.test(key)) return res.status(400).json({ error: '公開鍵の形式が不正です' });
  const row = await db.get(
    `SELECT p.user_id, p.spk_id, p.spk_pub FROM device_prekeys p
     JOIN user_pubkeys k ON k.user_id = p.user_id AND k.public_key = p.device_key
     WHERE p.device_key = ? AND k.status = 'active' LIMIT 1`,
    [key]
  );
  // 知らない人には、この端末があるかどうかも教えない
  if (!row || (row.user_id !== req.user.userId && !(await isAcquainted(req.user.userId, row.user_id)))) {
    return res.status(404).json({ error: 'not found' });
  }
  const otk = await db.get(
    `DELETE FROM device_otks WHERE device_key = ? AND otk_id = (SELECT MIN(otk_id) FROM device_otks WHERE device_key = ?) RETURNING otk_id, pub`,
    [key, key]
  );
  res.json({ deviceKey: key, spk: { id: Number(row.spk_id), pub: row.spk_pub }, otk: otk ? { id: Number(otk.otk_id), pub: otk.pub } : null });
}));

module.exports = router;
module.exports.enabledFor = enabledFor;
