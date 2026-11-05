// utils/inviteCore.js
// 招待コードの共通処理。既存ユーザーがコードを入れる(routes/invites.js)のと、
// コードだけで新規登録する(routes/auth.js の register-invite)の両方で使う。
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');

const INVALID = { error: '招待コードが無効か、期限切れです' };

// 入力のゆれ(小文字・ハイフン・空白)を吸収する。形式が違えば null
function normalizeCode(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  // 全角の英数・ハイフン・空白(日本語キーボードの入力)を半角にそろえてから見る
  const c = v.normalize('NFKC').toUpperCase().replace(/[\s\-\u2010-\u2015\u2212\u30fc]/g, '');
  return /^[A-Z0-9]{8}$/.test(c) ? c : null;
}

// コードと持ち主を引く。コードが無い・持ち主が退会済みなら null
async function loadInvite(code) {
  const inv = await db.get('SELECT * FROM invite_codes WHERE code = ?', [code]);
  if (!inv) return null;
  const owner = await db.get(
    "SELECT id, user_id, display_name, profile_pic, banned_until FROM users WHERE id = ? AND substr(username, 1, 8) != 'deleted_'",
    [inv.owner_id]
  );
  // 使用停止中の持ち主のコードでは、友だちも新しいアカウントも作れない(停止を迂回する足場にさせない)
  if (owner && (Number(owner.banned_until) || 0) > Date.now()) return null;
  return owner ? { inv, owner } : null;
}

// 人数を1つ確保する。戻り値: 'claimed'(今回消費した) / 'again'(前に使った人。消費しない) / null(使えない)
// 使用の記録を先に入れる(主キー=コード+人)ので、同じ人が同時に何回送っても消費は1回だけ。
// 人数の消費は1文で行うので、同時に使われても上限を超えない
async function claimInvite(inv, userId, now = Date.now()) {
  // 記録(使用の証拠)は、人数を確保できた後にだけ入れる。こうすると記録が「一瞬だけ存在して消える」ことが無く、
  // 満杯のコードに同じ人が同時に送って「前に使った人」の経路に紛れ込む、ということが起きない
  const prev = await db.get('SELECT 1 AS x FROM invite_redemptions WHERE code = ? AND user_id = ?', [inv.code, userId]);
  if (prev) {
    // 前に使った事のあるコードでも、期限が切れていたり消されていれば再利用できない
    const cur = await db.get('SELECT expires_ms FROM invite_codes WHERE code = ?', [inv.code]);
    if (!cur || (cur.expires_ms != null && Number(cur.expires_ms) <= now)) return null;
    return 'again';
  }
  const r = await db.run(
    `UPDATE invite_codes SET uses = uses + 1
      WHERE code = ? AND (expires_ms IS NULL OR expires_ms > ?) AND (max_uses IS NULL OR uses < max_uses)`,
    [inv.code, now]
  );
  if (!r || !r.changes) return null;
  let ins;
  try {
    ins = await db.run(
      'INSERT INTO invite_redemptions (code, user_id, redeemed_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [inv.code, userId, now]
    );
  } catch (e) {
    // PostgreSQL: 間にコードが消された(外部キー違反)。確保した分を戻して「無効」扱いにする
    await db.run('UPDATE invite_codes SET uses = uses - 1 WHERE code = ? AND uses > 0', [inv.code]).catch(() => {});
    if (/foreign key|violates/i.test(String(e && e.message))) return null;
    throw e;
  }
  if (!ins || !ins.changes) {
    // 同じ人の別の送信が先に記録した(二重送信)。そちらが消費しているので、こちらの分は戻す
    await db.run('UPDATE invite_codes SET uses = uses - 1 WHERE code = ? AND uses > 0', [inv.code]).catch(() => {});
    return 'again';
  }
  return 'claimed';
}

// claimInvite が 'claimed' を返した後で失敗した時に、消費を元に戻す
async function releaseInvite(code, userId) {
  await db.run('DELETE FROM invite_redemptions WHERE code = ? AND user_id = ?', [code, userId]).catch(() => {});
  await db.run('UPDATE invite_codes SET uses = uses - 1 WHERE code = ? AND uses > 0', [code]).catch(() => {});
}

// 2人を承認済みの友だちにする。「無ければ作る→申請の途中なら承認済みにする」を、同時に来ても落ちない形で行う
// (先に存在確認してから INSERT すると、同時送信で一意制約に当たって500になる)。持ち主から誘った形にする
async function makeFriends(meId, ownerId) {
  const [a, b] = [meId, ownerId].sort();
  const iso = new Date().toISOString();
  await db.run(
    "INSERT INTO friendships (id, user_a_id, user_b_id, status, requested_by, requested_at, accepted_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?) ON CONFLICT DO NOTHING",
    [uuidv4(), a, b, ownerId, iso, iso]
  );
  await db.run(
    "UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE user_a_id = ? AND user_b_id = ? AND status <> 'accepted'",
    [iso, a, b]
  );
}

// 持ち主が友だちから外した相手を覚える。覚えておかないと、外された人が持っているコード(無制限のものや、
// 人数に空きのあるもの)を入れるだけで、承認なしに黙って友だちに戻れてしまう
async function markRemoved(ownerId, userId) {
  await db.run(
    `INSERT INTO invite_removals (owner_id, user_id, removed_ms) VALUES (?, ?, ?)
     ON CONFLICT(owner_id, user_id) DO UPDATE SET removed_ms = excluded.removed_ms`,
    [ownerId, userId, Date.now()]
  );
}
// 持ち主が自分から友だちになり直した(IDで申請した・承認した・相手のコードを使った)ら、記録を消す
async function clearRemoved(ownerId, userId) {
  await db.run('DELETE FROM invite_removals WHERE owner_id = ? AND user_id = ?', [ownerId, userId]);
}
async function wasRemoved(ownerId, userId) {
  return !!(await db.get('SELECT 1 AS x FROM invite_removals WHERE owner_id = ? AND user_id = ?', [ownerId, userId]));
}

// 友だちの関係が変わったことを両方の開いている画面に知らせる(friends.js と同じ)
function notifyFriendChange(a, b) {
  try {
    const ws = require('../ws/wsServer');
    if (ws.forgetPresenceContacts) { ws.forgetPresenceContacts(a); ws.forgetPresenceContacts(b); }
    ws.broadcastToUser(a, { type: 'friends_changed', kind: 'accepted' });
    ws.broadcastToUser(b, { type: 'friends_changed', kind: 'accepted' });
  } catch (_) {}
}

module.exports = { INVALID, normalizeCode, loadInvite, claimInvite, releaseInvite, makeFriends, notifyFriendChange, markRemoved, clearRemoved, wasRemoved };
