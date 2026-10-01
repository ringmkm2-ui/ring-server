// utils/sessions.js
// 端末ごとのログインセッション。JWTの sid が user_sessions.id と対応し、
// 一覧表示・端末単位のサインアウトができる(sid の無い古いトークンは従来どおり有効)。
const crypto = require('crypto');
const db = require('../db/db');

const SESSION_KEEP_MS = 31 * 24 * 60 * 60 * 1000; // JWTの有効期限(30日)より少し長く残す

// User-Agentから「Chrome / Android」のような短い表示名を作る
function deviceLabel(ua) {
  const s = String(ua || '');
  if (!s) return '不明な端末';
  let os = 'その他';
  if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'Mac';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  else if (/Linux/i.test(s)) os = 'Linux';
  let br = 'ブラウザ';
  if (/; wv\)|Capacitor|BroChat/i.test(s)) br = 'アプリ';
  else if (/Edg\//i.test(s)) br = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) br = 'Opera';
  else if (/SamsungBrowser/i.test(s)) br = 'Samsung Internet';
  else if (/Firefox|FxiOS/i.test(s)) br = 'Firefox';
  else if (/Chrome|CriOS/i.test(s)) br = 'Chrome';
  else if (/Safari/i.test(s)) br = 'Safari';
  return `${br} / ${os}`;
}

async function createSession(userId, meta = {}) {
  const sid = crypto.randomUUID();
  try {
    await db.run(
      'INSERT INTO user_sessions (id, user_id, device, ip) VALUES (?, ?, ?, ?)',
      [sid, userId, deviceLabel(meta.ua), String(meta.ip || '').slice(0, 64)]
    );
    // 古いセッション行の掃除(ユーザー単位・ログインのたびに)
    const cutoff = new Date(Date.now() - SESSION_KEEP_MS).toISOString().replace('T', ' ').slice(0, 19);
    await db.run('DELETE FROM user_sessions WHERE user_id = ? AND created_at < ?', [userId, cutoff]);
  } catch (e) {
    console.error('[sessions] 作成失敗:', e.message);
    return null; // セッション管理に失敗してもログイン自体は止めない(sid無しトークンになる)
  }
  return sid;
}

// last_seen の更新は重くなるので sid ごとに5分に1回まで
const lastTouch = new Map();
function touchSession(sid) {
  const now = Date.now();
  if (now - (lastTouch.get(sid) || 0) < 5 * 60 * 1000) return;
  lastTouch.set(sid, now);
  if (lastTouch.size > 5000) lastTouch.clear();
  db.run('UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [sid]).catch(() => {});
}

module.exports = { createSession, touchSession, deviceLabel };
