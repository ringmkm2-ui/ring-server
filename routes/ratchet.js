// routes/ratchet.js
// 個人チャットのラチェット(public/js/ratchet.js)のプリキー。公開鍵だけを預かる。
// サーバーがプリキーを偽っても本文は読めない(受け取る端末に対応する秘密鍵が無く、開けずに止まる)。
const express = require('express');
const db = require('../db/db');
const deviceKeys = require('../utils/deviceKeys');
const { isAcquainted, canInteract } = require('../utils/relations');
const { proved } = require('./devices');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { prekeyLimiter, apiLimiter } = require('../utils/rateLimits');

const router = express.Router();
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
// 同じ鍵の別表記を「別の端末」として扱わせない
const canon = k => {
  if (typeof k !== 'string' || !KEY_RE.test(k)) return false;
  const b = Buffer.from(k, 'base64');
  return b.length === 32 && !(b[31] & 0x80) && b.toString('base64') === k;
};
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/;
// OTKは相手の前方秘匿性を守る有限の資源。同じ人が取り尽くせないようにする(超えたらSPKだけ渡す。送信は止めない)
const OTK_PER_PAIR_PER_HOUR = 5, OTK_PER_TARGET_PER_HOUR = 30;
const otkUse = new Map();
function takeOtkAllowance(key, max) {
  const now = Date.now();
  if (otkUse.size > 20000) for (const [k, v] of otkUse) if (now - v.since > 3600000) otkUse.delete(k);
  let c = otkUse.get(key);
  if (!c || now - c.since > 3600000) { c = { n: 0, since: now }; otkUse.set(key, c); }
  if (c.n >= max) return false;
  c.n += 1;
  return true;
}
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
  const enabled = await enabledFor(req.user.userId);
  // 一度プリキーを出した人は、送信を無効に戻しても出し続ける(相手がもうe5でしか送ってこないので、新しい端末にも要る)
  const had = enabled ? null : await db.get('SELECT 1 AS ok FROM device_prekeys WHERE user_id = ? LIMIT 1', [req.user.userId]);
  res.json({ enabled, publish: enabled || !!had });
}));

router.get('/prekeys/count', asyncHandler(async (req, res) => {
  const key = req.query.deviceKey;
  if (typeof key !== 'string' || !KEY_RE.test(key)) return res.status(400).json({ error: '公開鍵の形式が不正です' });
  const row = await db.get('SELECT spk_id FROM device_prekeys WHERE user_id = ? AND device_key = ?', [req.user.userId, key]);
  const c = await db.get('SELECT COUNT(*) AS c FROM device_otks WHERE user_id = ? AND device_key = ?', [req.user.userId, key]);
  res.json({ spkId: row ? Number(row.spk_id) : null, otks: Number(c && c.c) || 0 });
}));

router.post('/prekeys', prekeyLimiter, asyncHandler(async (req, res) => {
  const { deviceKey, spk, otks, replace } = req.body || {};
  if (!canon(deviceKey)) return res.status(400).json({ error: '公開鍵の形式が不正です' });
  if (!spk || !validId(spk.id) || !canon(spk.pub) || typeof spk.sig !== 'string' || !SIG_RE.test(spk.sig)) return res.status(400).json({ error: 'プリキーの形式が不正です' });
  const list = Array.isArray(otks) ? otks : [];
  if (list.length > MAX_UPLOAD || list.some(k => !k || !validId(k.id) || !canon(k.pub))) {
    return res.status(400).json({ error: 'プリキーの形式が不正です' });
  }
  // 自分の有効な端末の鍵にだけ置ける(承認待ちの端末にはまだ誰も送らない)
  const st = await deviceKeys.statusOf(req.user.userId, deviceKey);
  if (st.status !== 'active') return res.status(403).json({ error: 'この端末では登録できません' });
  // 公開鍵は誰でも知っているので、自分の鍵として登録するだけなら他人の鍵でもできる。秘密鍵を持っている証明を求める
  if (!proved(req, deviceKey)) return res.status(403).json({ error: 'この端末では登録できません' });
  // 端末の中の状態が無くなった時は、秘密鍵の無い古いOTKを全部捨てる
  if (replace === true) await db.run('DELETE FROM device_otks WHERE user_id = ? AND device_key = ?', [req.user.userId, deviceKey]);
  await db.run(
    `INSERT INTO device_prekeys (user_id, device_key, spk_id, spk_pub, spk_sig, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_key) DO UPDATE SET spk_id = excluded.spk_id, spk_pub = excluded.spk_pub, spk_sig = excluded.spk_sig, updated_at = excluded.updated_at`,
    [req.user.userId, deviceKey, spk.id, spk.pub, spk.sig, Date.now()]
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
  if (!canon(key)) return res.status(400).json({ error: '公開鍵の形式が不正です' });
  const row = await db.get(
    `SELECT p.user_id, p.spk_id, p.spk_pub, p.spk_sig FROM device_prekeys p
     JOIN user_pubkeys k ON k.user_id = p.user_id AND k.public_key = p.device_key
     WHERE p.device_key = ? AND k.status = 'active' LIMIT 1`,
    [key]
  );
  // 知らない人には、この端末があるかどうかも教えない
  if (!row || (row.user_id !== req.user.userId && !(await isAcquainted(req.user.userId, row.user_id)))) {
    return res.status(404).json({ error: 'not found' });
  }
  const me = req.user.userId, self = row.user_id === me;
  const mayTake = self || ((await canInteract(me, row.user_id))
    && takeOtkAllowance(me + '>' + key, OTK_PER_PAIR_PER_HOUR)
    && takeOtkAllowance('t:' + key, OTK_PER_TARGET_PER_HOUR));
  const otk = !mayTake ? null : await db.get(
    `DELETE FROM device_otks WHERE device_key = ? AND otk_id = (SELECT MIN(otk_id) FROM device_otks WHERE device_key = ?) RETURNING otk_id, pub`,
    [key, key]
  );
  res.json({ deviceKey: key, spk: { id: Number(row.spk_id), pub: row.spk_pub, sig: row.spk_sig }, otk: otk ? { id: Number(otk.otk_id), pub: otk.pub } : null });
}));

module.exports = router;
module.exports.enabledFor = enabledFor;
