// utils/officialFriend.js
// 新しく登録した人の友だち一覧に、最初から公式アカウント(既定 UMTUK9D)を入れておく。
// 何から始めればいいか分からない人でも、まず誰かに話しかけられる状態にするため。
// 環境変数 OFFICIAL_FRIEND_ID で変更でき、空にすると無効。
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');

async function befriendOfficial(userId) {
  try {
    const code = String(process.env.OFFICIAL_FRIEND_ID === undefined ? 'UMTUK9D' : process.env.OFFICIAL_FRIEND_ID).trim().toUpperCase();
    if (!code || !userId) return;
    const off = await db.get("SELECT id FROM users WHERE user_id = ? AND username NOT LIKE 'deleted%'", [code]);
    if (!off || off.id === userId) return;
    const [a, b] = [userId, off.id].sort();
    const ex = await db.get('SELECT id FROM friendships WHERE user_a_id = ? AND user_b_id = ?', [a, b]);
    if (ex) return;
    await db.run(
      "INSERT INTO friendships (id, user_a_id, user_b_id, status, requested_by, requested_at, accepted_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)",
      [uuidv4(), a, b, off.id, new Date().toISOString(), new Date().toISOString()]
    );
  } catch (e) {
    console.warn('[officialFriend] 失敗:', e.message); // 友だち追加に失敗しても登録自体は止めない
  }
}

module.exports = { befriendOfficial };
