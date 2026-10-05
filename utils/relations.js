// utils/relations.js
// 2人のユーザーの関係(友だち / 同じグループ)を調べる共通処理。
// 着信・入力中表示・オンライン状態など「相手に何かを届ける/相手の状態を知る」操作は、
// 知り合い(友だち、または同じグループのメンバー)の間だけに限る。
// 以前はユーザーIDさえ分かれば、全く知らない相手の端末を何度でも鳴らしたり、
// オンラインかどうかを覗いたりできた。
const db = require('../db/db');

async function areFriends(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;
  const [x, y] = [a, b].sort();
  const row = await db.get(
    "SELECT 1 AS ok FROM friendships WHERE user_a_id = ? AND user_b_id = ? AND status = 'accepted'",
    [x, y]
  );
  return !!row;
}

async function shareGroup(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;
  const row = await db.get(
    `SELECT 1 AS ok FROM group_members g1
       JOIN group_members g2 ON g2.group_id = g1.group_id
      WHERE g1.user_id = ? AND g2.user_id = ? AND g1.left_at IS NULL AND g2.left_at IS NULL
      LIMIT 1`,
    [a, b]
  );
  return !!row;
}

// 自分自身・友だち・同じグループの相手なら true
async function canInteract(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (await areFriends(a, b)) return true;
  return shareGroup(a, b);
}

module.exports = { areFriends, shareGroup, canInteract };
