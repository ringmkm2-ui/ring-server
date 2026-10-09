// utils/deviceKeys.js
// 1人が複数の端末(PC・スマホ・デスクトップ版)で使えるように、端末ごとの公開鍵を全部覚えておく。
// users.public_key は「最後に登録された1本」(古い端末向けにそのまま残す)。
// 送る側は activeKeys の全部に向けて暗号化する(public/js/e2eMulti.js の e3 形式)。
const db = require('../db/db');

const ACTIVE_MS = 45 * 24 * 60 * 60 * 1000; // 45日開いていない端末の鍵には、もう送らない
const MAX_ACTIVE = 6;
const MAX_ROWS = 12;

async function touch(userId, publicKey) {
  const now = Date.now();
  await db.run(
    `INSERT INTO user_pubkeys (user_id, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, public_key) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    [userId, publicKey, now, now]
  );
  const rows = await db.all('SELECT public_key FROM user_pubkeys WHERE user_id = ? ORDER BY last_seen_at DESC', [userId]);
  for (const r of rows.slice(MAX_ROWS)) await db.run('DELETE FROM user_pubkeys WHERE user_id = ? AND public_key = ?', [userId, r.public_key]);
}

// userIds -> Map(userId -> [公開鍵...]) 新しく使われた順。latest(users.public_key)は必ず含める
async function activeKeysMany(users) {
  const out = new Map();
  if (!users.length) return out;
  const ids = users.map(u => u.id);
  const since = Date.now() - ACTIVE_MS;
  const rows = await db.all(
    `SELECT user_id, public_key FROM user_pubkeys WHERE user_id IN (${ids.map(() => '?').join(',')}) AND last_seen_at > ? ORDER BY last_seen_at DESC`,
    [...ids, since]
  );
  for (const u of users) out.set(u.id, u.public_key ? [u.public_key] : []);
  for (const r of rows) {
    const list = out.get(r.user_id);
    if (list && !list.includes(r.public_key) && list.length < MAX_ACTIVE) list.push(r.public_key);
  }
  return out;
}
async function activeKeys(userId) {
  const u = await db.get('SELECT id, public_key FROM users WHERE id = ?', [userId]);
  if (!u) return [];
  return (await activeKeysMany([u])).get(u.id) || [];
}

// 「全ての端末からログアウト」: ほかの端末の鍵にはもう送らない(なくした端末で読まれないように)
async function clearAll(userId) {
  await db.run('DELETE FROM user_pubkeys WHERE user_id = ?', [userId]);
}

module.exports = { touch, activeKeys, activeKeysMany, clearAll };
