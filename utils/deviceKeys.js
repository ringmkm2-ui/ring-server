// utils/deviceKeys.js
// 1人が複数の端末(PC・スマホ・デスクトップ版)で使えるように、端末ごとの公開鍵を全部覚えておく。
// users.public_key は「最後に有効になった1本」(古い端末向けにそのまま残す)。
// 送る側は activeKeys の全部に向けて暗号化する(public/js/e2eMulti.js の e3 形式)。
//
// 端末の承認: パスワードを盗まれても、攻撃者の端末の鍵に暗号文が届かないようにする。
//  - 最近使われた鍵がある人が新しい鍵を登録すると pending(承認待ち)になり、相手には配られない
//  - 有効な鍵を持つ端末が許可すると active になる(routes/devices.js。鍵を持っている証明が要る)
//  - 全ての端末をなくした人のために、WAIT_MS 経ったら本人の端末が開いた時に自動で有効になる。
//    その間に本人へメールが届くので、盗まれた場合は拒否やパスワード変更ができる
//  - 鍵のバックアップから復元した端末は、もとの鍵を使うので承認は要らない(パスフレーズが証明になる)
const crypto = require('crypto');
const db = require('../db/db');

const ACTIVE_MS = 45 * 24 * 60 * 60 * 1000; // 45日開いていない端末の鍵には、もう送らない
const MAX_ACTIVE = 6;
const MAX_ROWS = 12;
const WAIT_MS = () => (Number(process.env.DEVICE_APPROVAL_WAIT_HOURS) > 0 ? Number(process.env.DEVICE_APPROVAL_WAIT_HOURS) : 72) * 60 * 60 * 1000;
// 問題が起きた時に、デプロイし直さず環境変数だけで止められるようにしておく
const enabled = () => process.env.DEVICE_APPROVAL !== 'off';

// 新しい端末と許可する端末の両方に出す6桁。別の人の端末を間違って許可しないために見比べる
function codeFor(publicKey) {
  const n = crypto.createHash('sha256').update('bc-device-v1:' + publicKey).digest().readUInt32BE(0) % 1000000;
  const s = String(n).padStart(6, '0');
  return s.slice(0, 3) + ' ' + s.slice(3);
}

async function trim(userId) {
  const rows = await db.all('SELECT public_key FROM user_pubkeys WHERE user_id = ? ORDER BY last_seen_at DESC', [userId]);
  for (const r of rows.slice(MAX_ROWS)) await db.run('DELETE FROM user_pubkeys WHERE user_id = ? AND public_key = ?', [userId, r.public_key]);
}

async function activate(userId, publicKey, now) {
  await db.run("UPDATE user_pubkeys SET status = 'active', approve_after = NULL, last_seen_at = ? WHERE user_id = ? AND public_key = ?", [now, userId, publicKey]);
  await db.run('UPDATE users SET public_key = ? WHERE id = ?', [publicKey, userId]);
}

// 戻り値: { status: 'active'|'pending', isNew: 今回初めて登録された, activated: 今回新しく有効になった, approveAfter }
async function touch(userId, publicKey) {
  const now = Date.now();
  const row = await db.get('SELECT status, approve_after FROM user_pubkeys WHERE user_id = ? AND public_key = ?', [userId, publicKey]);
  if (row) {
    if (row.status === 'pending') {
      const at = Number(row.approve_after) || 0;
      if (enabled() && at > now) {
        await db.run('UPDATE user_pubkeys SET last_seen_at = ? WHERE user_id = ? AND public_key = ?', [now, userId, publicKey]);
        return { status: 'pending', isNew: false, activated: false, approveAfter: at };
      }
      await activate(userId, publicKey, now);
      return { status: 'active', isNew: false, activated: true };
    }
    // inactive は「全端末ログアウト」等で止めた鍵。ログインし直した本人の端末なので戻す(トークンはその時に失効済み)
    await activate(userId, publicKey, now);
    return { status: 'active', isNew: false, activated: false };
  }
  // pending は数えない(盗んだ人が先に鍵を置いて、本人の次の端末を待たせることはできない)
  const recent = enabled() ? await db.get(
    "SELECT 1 AS ok FROM user_pubkeys WHERE user_id = ? AND status <> 'pending' AND last_seen_at > ? LIMIT 1",
    [userId, now - ACTIVE_MS]
  ) : null;
  if (recent) {
    const at = now + WAIT_MS();
    await db.run(
      "INSERT INTO user_pubkeys (user_id, public_key, created_at, last_seen_at, status, approve_after) VALUES (?, ?, ?, ?, 'pending', ?)",
      [userId, publicKey, now, now, at]
    );
    await trim(userId);
    return { status: 'pending', isNew: true, activated: false, approveAfter: at };
  }
  await db.run(
    "INSERT INTO user_pubkeys (user_id, public_key, created_at, last_seen_at, status) VALUES (?, ?, ?, ?, 'active')",
    [userId, publicKey, now, now]
  );
  await db.run('UPDATE users SET public_key = ? WHERE id = ?', [publicKey, userId]);
  await trim(userId);
  return { status: 'active', isNew: true, activated: true };
}

async function statusOf(userId, publicKey) {
  const r = await db.get('SELECT status, approve_after FROM user_pubkeys WHERE user_id = ? AND public_key = ?', [userId, publicKey]);
  return r ? { status: r.status, approveAfter: Number(r.approve_after) || null } : { status: 'unknown', approveAfter: null };
}
async function isPending(userId, publicKey) {
  const r = await statusOf(userId, publicKey);
  return enabled() && r.status === 'pending' && (r.approveAfter || 0) > Date.now();
}
async function listPending(userId) {
  const rows = await db.all(
    "SELECT public_key, created_at, approve_after FROM user_pubkeys WHERE user_id = ? AND status = 'pending' AND approve_after > ? ORDER BY created_at DESC",
    [userId, Date.now()]
  );
  return rows.map(r => ({ publicKey: r.public_key, code: codeFor(r.public_key), createdAt: Number(r.created_at), approveAfter: Number(r.approve_after) }));
}
async function approve(userId, publicKey) {
  const r = await statusOf(userId, publicKey);
  if (r.status !== 'pending') return false;
  await activate(userId, publicKey, Date.now());
  return true;
}
async function reject(userId, publicKey) {
  const r = await statusOf(userId, publicKey);
  if (r.status !== 'pending') return false;
  await db.run('DELETE FROM user_pubkeys WHERE user_id = ? AND public_key = ?', [userId, publicKey]);
  return true;
}

// 一番新しく増えた端末の鍵の時刻(ms)。無ければ 0
async function newestKeyAt(userId) {
  const r = await db.get("SELECT MAX(created_at) AS t FROM user_pubkeys WHERE user_id = ? AND status = 'active' AND last_seen_at > ?", [userId, Date.now() - ACTIVE_MS]);
  return Number(r && r.t) || 0;
}

// userIds -> Map(userId -> [公開鍵...]) 新しく使われた順。承認待ちと止めた鍵は渡さない
async function activeKeysMany(users) {
  const out = new Map();
  if (!users.length) return out;
  const ids = users.map(u => u.id);
  const since = Date.now() - ACTIVE_MS;
  const marks = ids.map(() => '?').join(',');
  const blocked = await db.all(
    `SELECT user_id, public_key FROM user_pubkeys WHERE user_id IN (${marks}) AND status <> 'active'`,
    ids
  );
  const isBlocked = new Set(blocked.map(r => r.user_id + '|' + r.public_key));
  const rows = await db.all(
    `SELECT user_id, public_key FROM user_pubkeys WHERE user_id IN (${marks}) AND status = 'active' AND last_seen_at > ? ORDER BY last_seen_at DESC`,
    [...ids, since]
  );
  for (const u of users) out.set(u.id, u.public_key && !isBlocked.has(u.id + '|' + u.public_key) ? [u.public_key] : []);
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

// 「全ての端末からログアウト」やパスワードの変更: 今ある鍵にはもう送らない(なくした端末で読まれない)。
// 消さずに止めるだけにする。消すと「最近の鍵が無い人」になり、盗んだ人の新しい鍵が承認なしで通ってしまう。
// 本人の端末は、ログインし直して開いた時に自分の鍵を登録して戻る。承認待ちの鍵は捨てる
async function clearAll(userId) {
  await db.run("DELETE FROM user_pubkeys WHERE user_id = ? AND status = 'pending'", [userId]);
  await db.run("UPDATE user_pubkeys SET status = 'inactive' WHERE user_id = ?", [userId]);
}

// 鍵が新しく有効になったことを、話す相手全員に知らせる(相手の画面の安全番号と「鍵が変わりました」を更新する)
async function announce(userId) {
  try {
    const { broadcastToUser } = require('../ws/wsServer');
    const peers = await db.all(
      `SELECT DISTINCT gm2.user_id AS id FROM group_members gm1
       JOIN group_members gm2 ON gm2.group_id = gm1.group_id AND gm2.left_at IS NULL
       WHERE gm1.user_id = ? AND gm1.left_at IS NULL`,
      [userId]
    );
    for (const p of peers) broadcastToUser(p.id, { type: 'member_keys_ready', userId });
    const friends = await db.all(
      "SELECT user_a_id AS a, user_b_id AS b FROM friendships WHERE status = 'accepted' AND (user_a_id = ? OR user_b_id = ?)",
      [userId, userId]
    );
    for (const f of friends) broadcastToUser(f.a === userId ? f.b : f.a, { type: 'peer_keys_changed', userId });
    broadcastToUser(userId, { type: 'peer_keys_changed', userId });
  } catch (e) { console.error('[deviceKeys] announce failed:', e.message); }
}

module.exports = { touch, activeKeys, activeKeysMany, clearAll, newestKeyAt, statusOf, isPending, listPending, approve, reject, announce, codeFor, enabled };
