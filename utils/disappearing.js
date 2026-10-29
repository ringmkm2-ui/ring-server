// utils/disappearing.js
// 消えるメッセージ(会話ごとのタイマー)。
//
// - タイマーは会話ごとに持つ: 1対1は 'dm:<小さいID>:<大きいID>'、グループは 'g:<groupId>'
// - 送信時に messages / group_messages の expires_at = 今 + タイマー を押す。編集しても延びない
// - expires_at を過ぎた行は、掃除が走る前でも履歴・未読・一覧から外す(notExpiredSql)
// - 掃除(sweepExpired)は定期的に期限切れの行を消し、リアクション・既読・返信の参照も片付ける
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');

// 選べる長さ(秒)。0 = オフ。テスト環境だけ、期限切れを待てるよう 2 秒も許す(本番では選べない)
const ALLOWED_TTL = [0, 3600, 86400, 604800];
if (process.env.NODE_ENV === 'test') ALLOWED_TTL.push(2);

function isAllowedTtl(n) { return Number.isInteger(n) && ALLOWED_TTL.includes(n); }

function dmKey(a, b) { return 'dm:' + [a, b].sort().join(':'); }
function groupKey(groupId) { return 'g:' + groupId; }

async function getTtl(convKey) {
  const row = await db.get('SELECT ttl_seconds FROM conversation_ttl WHERE conv_key = ?', [convKey]);
  return row ? Number(row.ttl_seconds) || 0 : 0;
}

async function setTtl(convKey, ttlSeconds, userId) {
  // 掃除を動かすかどうかの判断に使う数(下の ttlActive)。オンにした時はその場で増やし、
  // オフにした時は数え直す(他の会話がまだ使っているかもしれないため)
  if (ttlSeconds > 0) ttlActive++;
  else setImmediate(() => { refreshTtlActive().catch(() => {}); });
  await db.run(
    `INSERT INTO conversation_ttl (conv_key, ttl_seconds, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(conv_key) DO UPDATE SET ttl_seconds = excluded.ttl_seconds, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
    [convKey, ttlSeconds, userId]
  );
}

// 今の時刻から ttl 秒後(ISO)。ttl が 0 なら null = 消えない
async function expiresAtFor(convKey) {
  const ttl = await getTtl(convKey);
  return ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null;
}

// 履歴・未読などの WHERE に足す条件と、そのパラメータ。alias は表の別名(無ければ空)
function notExpiredSql(alias) {
  const c = (alias ? alias + '.' : '') + 'expires_at';
  return `(${c} IS NULL OR ${c} > ?)`;
}
function nowParam() { return new Date().toISOString(); }

function ttlLabel(sec) {
  if (sec === 3600) return '1時間';
  if (sec === 86400) return '1日';
  if (sec === 604800) return '1週間';
  return sec + '秒';
}
function noticeText(name, sec) {
  return sec > 0 ? `${name}が消えるメッセージを${ttlLabel(sec)}に設定しました` : `${name}が消えるメッセージをオフにしました`;
}

// 変更を会話に「お知らせ」(msg_type='notice')として残し、開いているクライアントへ流す。
// お知らせは送信APIからは作れない種類なので、なりすませない。お知らせ自体は消えない(期限なし)
async function postTtlNotice({ actorId, peerId, groupId, ttlSeconds, hiddenForPeer }) {
  const { broadcastToUser } = require('../ws/wsServer');
  const u = await db.get('SELECT display_name FROM users WHERE id = ?', [actorId]);
  const name = (u && u.display_name) || 'ユーザー';
  const text = noticeText(name, ttlSeconds);
  const content = JSON.stringify({ __notice__: { kind: 'ttl', name, ttlSeconds, text } });
  const id = uuidv4();
  if (peerId) {
    await db.run(
      // 設定変更のお知らせは未読に数えない(読まれる必要が無いので最初から既読にしておく)
      "INSERT INTO messages (id, sender_id, recipient_id, content, msg_type, encrypted, read_at, hidden_for_recipient) VALUES (?, ?, ?, ?, 'notice', false, ?, ?)",
      [id, actorId, peerId, content, new Date().toISOString(), !!hiddenForPeer]
    );
    const m = await db.get('SELECT * FROM messages WHERE id = ?', [id]);
    const payload = { type: 'new_message', message: {
      id: m.id, senderId: m.sender_id, recipientId: m.recipient_id, content: m.content,
      msgType: 'notice', encrypted: false, repliedToId: null, createdAt: m.created_at, expiresAt: null,
    } };
    if (!hiddenForPeer) broadcastToUser(peerId, payload);
    broadcastToUser(actorId, payload);
  } else {
    const g = await db.get('SELECT key_version FROM groups WHERE id = ?', [groupId]);
    if (!g) return;
    await db.run(
      "INSERT INTO group_messages (id, group_id, sender_id, content, msg_type, encrypted, key_version) VALUES (?, ?, ?, ?, 'notice', false, ?)",
      [id, groupId, actorId, content, g.key_version]
    );
    const m = await db.get('SELECT * FROM group_messages WHERE id = ?', [id]);
    const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
    members.forEach(mm => broadcastToUser(mm.user_id, { type: 'group_message', groupId, message: {
      id: m.id, groupId, senderId: m.sender_id, content: m.content, msgType: 'notice',
      encrypted: false, keyVersion: m.key_version, repliedToId: null, createdAt: m.created_at, expiresAt: null,
    } }));
  }
}

// --- 期限切れの掃除 ---
const SWEEP_BATCH = 200;
let sweeping = false;

function inList(ids) { return ids.map(() => '?').join(','); }

// 1回の掃除。notify は {userIds, payload} を流す関数(テストで差し替えられる)。消した件数を返す。
// メディア(Cloudinary / Googleドライブ)の実体を消す共通処理は今のところ無いので、ここでは触らない
// (従来の「送信取り消し」も実体は消していない)。
async function sweepExpired(notify) {
  if (sweeping) return 0; // 前の掃除がまだ終わっていなければ重ねない
  sweeping = true;
  let total = 0;
  try {
    if (!notify) {
      const { broadcastToUser } = require('../ws/wsServer');
      notify = (userIds, payload) => userIds.forEach(u => broadcastToUser(u, payload));
    }
    const now = new Date().toISOString();

    // 1対1: 1回で最大 SWEEP_BATCH 件ずつ、取れなくなるまで(ただし暴走しないよう上限あり)
    for (let round = 0; round < 50; round++) {
      const rows = await db.all(
        'SELECT id, sender_id, recipient_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?',
        [now, SWEEP_BATCH]
      );
      if (!rows.length) break;
      const ids = rows.map(r => r.id);
      const ph = inList(ids);
      // 返信の参照(PostgreSQLでは外部キー)は先に外す。返信した側のメッセージは残り、引用だけが無くなる
      await db.run(`UPDATE messages SET replied_to_id = NULL WHERE replied_to_id IN (${ph})`, ids);
      await db.run(`DELETE FROM message_reactions WHERE message_id IN (${ph})`, ids);
      await db.run(`DELETE FROM messages WHERE id IN (${ph})`, ids);
      total += ids.length;
      // 相手ごとにまとめて知らせる(隠されていて相手に届いていなかった分のIDを知らせても害は無い)
      const byPair = new Map();
      for (const r of rows) {
        const key = dmKey(r.sender_id, r.recipient_id);
        if (!byPair.has(key)) byPair.set(key, { a: r.sender_id, b: r.recipient_id, ids: [] });
        byPair.get(key).ids.push(r.id);
      }
      for (const [key, e] of byPair) {
        notify([e.a], { type: 'messages_expired', scope: 'dm', conversationKey: key, peerId: e.b, messageIds: e.ids });
        if (e.b !== e.a) notify([e.b], { type: 'messages_expired', scope: 'dm', conversationKey: key, peerId: e.a, messageIds: e.ids });
      }
      if (rows.length < SWEEP_BATCH) break;
    }

    // グループ
    for (let round = 0; round < 50; round++) {
      const rows = await db.all(
        'SELECT id, group_id FROM group_messages WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?',
        [now, SWEEP_BATCH]
      );
      if (!rows.length) break;
      const ids = rows.map(r => r.id);
      const ph = inList(ids);
      await db.run(`UPDATE group_messages SET replied_to_id = NULL WHERE replied_to_id IN (${ph})`, ids);
      await db.run(`DELETE FROM group_message_reads WHERE message_id IN (${ph})`, ids);
      await db.run(`DELETE FROM group_message_reactions WHERE message_id IN (${ph})`, ids);
      await db.run(`DELETE FROM group_messages WHERE id IN (${ph})`, ids);
      total += ids.length;
      const byGroup = new Map();
      for (const r of rows) {
        if (!byGroup.has(r.group_id)) byGroup.set(r.group_id, []);
        byGroup.get(r.group_id).push(r.id);
      }
      for (const [gid, mids] of byGroup) {
        const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [gid]);
        notify(members.map(m => m.user_id), { type: 'messages_expired', scope: 'group', conversationKey: groupKey(gid), groupId: gid, messageIds: mids });
      }
      if (rows.length < SWEEP_BATCH) break;
    }
  } catch (e) {
    console.error('[disappearing] sweep failed:', e && e.message);
  } finally {
    sweeping = false;
  }
  return total;
}

// 起動時に1度だけ呼ぶ。EXPIRY_SWEEP_MS で間隔を変えられる(既定5分、最短1秒)
//
// 以前は60秒おきに無条件でクエリを投げていた。これだとDB(Neon)が一生眠れず、誰も使っていない
// 深夜もコンピュート時間を食い続け、無料枠(1か月100 CU時間)を半月で使い切ってDBが停止した。
// 掃除が遅れても、期限切れの行は notExpiredSql で履歴・未読・一覧から既に外れているので、
// 画面上の見え方は変わらない。だから以下の時はクエリを投げない:
//   - 消えるメッセージを使っている会話が1つも無い(ttlActive = 0)
//   - 直近 IDLE_MS の間、APIもWebSocketも来ていない(= 誰も使っていない)
const activity = require('./activity');
const IDLE_MS = 15 * 60 * 1000;
let timer = null;
let ttlActive = 0; // ttl_seconds > 0 の会話の数(起動時に1度数え、setTtlで増減)

async function refreshTtlActive() {
  try {
    const r = await db.get('SELECT COUNT(*) AS n FROM conversation_ttl WHERE ttl_seconds > 0');
    ttlActive = Number((r && r.n) || 0);
  } catch (e) {
    ttlActive = 1; // 数えられない時は「ある」として扱う(消し忘れるよりマシ)
  }
  return ttlActive;
}

function startSweeper() {
  if (timer) return;
  const ms = Math.max(1000, parseInt(process.env.EXPIRY_SWEEP_MS, 10) || 5 * 60 * 1000);
  refreshTtlActive().then(n => console.log(`[disappearing] 掃除は${ms / 1000}秒おき(消えるメッセージの会話: ${n}件)`)).catch(() => {});
  timer = setInterval(() => {
    if (ttlActive <= 0) return;
    if (!activity.activeWithin(IDLE_MS)) return; // 誰も使っていない間はDBを眠らせる
    sweepExpired().catch(e => console.error('[disappearing] sweep error:', e && e.message));
  }, ms);
  timer.unref();
}

module.exports = {
  ALLOWED_TTL, isAllowedTtl, dmKey, groupKey, getTtl, setTtl, expiresAtFor,
  notExpiredSql, nowParam, ttlLabel, noticeText, postTtlNotice, sweepExpired, startSweeper,
};
