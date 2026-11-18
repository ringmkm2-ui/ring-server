// utils/chatPrefs.js
// トークリストのチャットごとの操作(ピン留め・ミュート・非表示・自分だけトーク削除)の読み書きと、
// 一覧・履歴・通知から使う共通の小道具。
//
// - kind は 'dm'(peerId = 相手のユーザーID)か 'group'(peerId = グループID)
// - 時刻はすべて epoch ミリ秒。PostgreSQL の BIGINT は文字列で返ってくるので、ここで数値にそろえる
// - cleared_at より前のメッセージは、その人にだけ見えない(相手や他のメンバーには何も起きない)
// - 読み込みは1リクエストにつき1回(loadPrefs)。一覧の会話ごとに引かない
const db = require('../db/db');

const KINDS = ['dm', 'group'];
const MAX_PINNED = 10;

const key = (kind, peerId) => kind + ':' + peerId;
// SQLiteは 0/1、PostgreSQLは true/false で返す
const truthy = v => v === true || v === 1 || v === '1' || v === 't' || v === 'true';
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function shapeRow(row) {
  return {
    kind: row.kind,
    peerId: row.peer_id,
    pinnedAt: row.pinned_at == null ? null : num(row.pinned_at),
    muted: truthy(row.muted),
    hiddenAt: row.hidden_at == null ? null : num(row.hidden_at),
    clearedAt: num(row.cleared_at),
  };
}

// 何も設定していない時の形(行が無いチャット)
function defaultPref(kind, peerId) {
  return { kind, peerId, pinnedAt: null, muted: false, hiddenAt: null, clearedAt: 0 };
}

// そのユーザーの全チャット分。Map<'kind:peerId', pref>
async function loadPrefs(userId) {
  const rows = await db.all(
    'SELECT kind, peer_id, pinned_at, muted, hidden_at, cleared_at FROM chat_prefs WHERE user_id = ?',
    [userId]
  );
  const map = new Map();
  for (const r of rows) map.set(key(r.kind, r.peer_id), shapeRow(r));
  return map;
}

async function getPref(userId, kind, peerId) {
  const row = await db.get(
    'SELECT kind, peer_id, pinned_at, muted, hidden_at, cleared_at FROM chat_prefs WHERE user_id = ? AND kind = ? AND peer_id = ?',
    [userId, kind, peerId]
  );
  return row ? shapeRow(row) : defaultPref(kind, peerId);
}

function prefOf(prefs, kind, peerId) {
  return prefs.get(key(kind, peerId)) || defaultPref(kind, peerId);
}

// 通知を止めるか。読めなかった時は止めない(通知が届かないより、余計に届く方がまし)
async function isMuted(userId, kind, peerId) {
  if (!userId || !peerId) return false;
  try {
    const row = await db.get(
      'SELECT muted FROM chat_prefs WHERE user_id = ? AND kind = ? AND peer_id = ?',
      [userId, kind, peerId]
    );
    return !!row && truthy(row.muted);
  } catch (e) {
    console.warn('[chatPrefs] isMuted failed:', e.message);
    return false;
  }
}

// 同じチャットをミュートしているユーザーの集合(グループの全メンバー分を1回で引く)
async function mutedUserIds(userIds, kind, peerId) {
  const out = new Set();
  if (!userIds || !userIds.length) return out;
  try {
    for (let i = 0; i < userIds.length; i += 200) {
      const chunk = userIds.slice(i, i + 200);
      const rows = await db.all(
        `SELECT user_id, muted FROM chat_prefs WHERE kind = ? AND peer_id = ? AND user_id IN (${chunk.map(() => '?').join(',')})`,
        [kind, peerId, ...chunk]
      );
      for (const r of rows) if (truthy(r.muted)) out.add(r.user_id);
    }
  } catch (e) {
    console.warn('[chatPrefs] mutedUserIds failed:', e.message);
  }
  return out;
}

// --- 時刻の扱い ---
// メッセージの created_at は、PostgreSQL では Date、SQLite では 'YYYY-MM-DD HH:MM:SS'(UTC・タイムゾーン無し)で返る
function toMs(v) {
  if (v == null || v === '') return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  let s = String(v);
  if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

// created_at と比べるための値(SQLの `created_at > ?` に渡す)。
// SQLite は文字列比較なので、DBの書式('YYYY-MM-DD HH:MM:SS')にそろえる。ミリ秒まで付けるので、
// 消した瞬間と同じ秒に届いていたメッセージ(秒までしか持たない)は消した側に数える
function tsParam(ms) {
  const iso = new Date(ms).toISOString();
  return process.env.DATABASE_URL ? iso : iso.replace('T', ' ').replace('Z', '');
}

// 一覧の1件に足す { pinnedAt, muted, hidden }。lastMs はそのチャットの最新メッセージの時刻(無ければ 0)。
// hidden は「非表示にした後に、新しいメッセージが来ていない」間だけ true(LINEと同じ。来たら戻る)
function listFields(pref, lastMs) {
  return {
    pinnedAt: pref.pinnedAt,
    muted: pref.muted,
    hidden: pref.hiddenAt != null && !(lastMs > pref.hiddenAt),
  };
}

module.exports = {
  KINDS, MAX_PINNED, truthy, num, key, shapeRow, defaultPref,
  loadPrefs, getPref, prefOf, isMuted, mutedUserIds, toMs, tsParam, listFields,
};
