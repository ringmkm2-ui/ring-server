// utils/guest.js
// ゲスト = 招待コードだけで始めた人(ユーザー名が guest_ で始まり、パスワードが空)。
// 使い捨てで何人でも作れるので、お金や容量がかかる機能の枠はふつうの人より絞る。
const db = require('../db/db');

function isGuestRow(u) {
  return !!(u && /^guest_/.test(String(u.username || '')) && !u.password_hash);
}

async function isGuestUser(userId) {
  return isGuestRow(await db.get('SELECT username, password_hash FROM users WHERE id = ?', [userId]));
}

module.exports = { isGuestRow, isGuestUser };
