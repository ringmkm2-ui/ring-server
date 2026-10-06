// utils/userSettings.js
// ユーザーごとの設定を、端末ではなくサーバーに持たせる。
//
// これまで設定は localStorage に入っていたので、端末を変えると全部やり直しだったし、
// 「既読を送らない」「入力中を見せない」のようなプライバシー設定は画面側でしか
// 効いていなかった(= 相手の端末に情報自体は届いていた)。
// ここに集約して、WebSocketやAPIの側でも実際に止める。
const db = require('../db/db');

// 既定値。ここに無いキーは保存しない(クライアントから好きなキーを投げ込ませない)
const DEFAULTS = Object.freeze({
  // --- プライバシー ---
  sendReadReceipts: true,       // 既読を相手に知らせる
  sendTypingIndicator: true,    // 入力中を相手に見せる
  showOnlineStatus: true,       // オンライン状態を相手に見せる
  allowCallsFrom: 'friends',    // 'friends' | 'nobody'  誰からの着信を受けるか
  // --- 通話 ---
  hideIpInCalls: false,         // TURN中継のみを使い、相手に自分のIPを見せない(音質と引き換え)
  showCallCode: true,           // 通話の確認コード(中間者がいないかを声で突き合わせる4桁)
  // --- セキュリティ ---
  loginAlertEmail: true,        // 新しい端末でログインされたらメールで知らせる
});

const BOOL_KEYS = Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k] === 'boolean');
const ENUMS = { allowCallsFrom: ['friends', 'nobody'] };

// 設定はリクエストのたびに読まれる(WSの入力中表示など高頻度)ので短時間だけ覚える
const cache = new Map(); // userId -> { v, ts }
const CACHE_MS = 60 * 1000;

function clean(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of BOOL_KEYS) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (typeof raw[k] === 'string' && allowed.includes(raw[k])) out[k] = raw[k];
  }
  return out;
}

async function getSettings(userId) {
  if (!userId) return { ...DEFAULTS };
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.v;
  let v = { ...DEFAULTS };
  try {
    const row = await db.get('SELECT data FROM user_settings WHERE user_id = ?', [userId]);
    if (row && row.data) v = clean(JSON.parse(row.data));
  } catch (e) {
    // 設定が読めなくても既定値で動かす(ここで落とすとチャット全体が止まる)
    console.warn('[settings] read failed:', e.message);
  }
  if (cache.size > 5000) cache.clear();
  cache.set(userId, { v, ts: Date.now() });
  return v;
}

async function saveSettings(userId, patch) {
  const current = await getSettings(userId);
  const next = clean({ ...current, ...(patch || {}) });
  await db.run(
    `INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
    [userId, JSON.stringify(next)]
  );
  cache.set(userId, { v: next, ts: Date.now() });
  return next;
}

function invalidate(userId) { cache.delete(userId); }

module.exports = { DEFAULTS, getSettings, saveSettings, invalidate };
