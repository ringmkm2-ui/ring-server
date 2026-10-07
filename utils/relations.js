// utils/relations.js
// 2人のユーザーの関係(友だち / 同じグループ)を調べる共通処理。
// 着信・入力中表示・オンライン状態など「相手に何かを届ける/相手の状態を知る」操作は、
// 知り合い(友だち、または同じグループのメンバー)の間だけに限る。
// 以前はユーザーIDさえ分かれば、全く知らない相手の端末を何度でも鳴らしたり、
// オンラインかどうかを覗いたりできた。
const db = require('../db/db');

// ブロックの状態。byMe: a が b をブロック / byThem: b が a をブロック
async function blockState(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string' || a === b) return { byMe: false, byThem: false };
  const rows = await db.all(
    'SELECT blocker_id FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
    [a, b, b, a]
  );
  return { byMe: rows.some(r => r.blocker_id === a), byThem: rows.some(r => r.blocker_id === b) };
}
// どちらかがブロックしていれば true
async function isBlockedEither(a, b) {
  const s = await blockState(a, b);
  return s.byMe || s.byThem;
}
// ブロックの付け外しの回数。WebSocket側の「関係の確認結果」の覚えを、変わった瞬間に捨てるために使う
let blockVersion = 0;
function bumpBlockVersion() { blockVersion++; }
function getBlockVersion() { return blockVersion; }

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

// 自分自身・友だち・同じグループの相手なら true(どちらかがブロックしていれば false)。
// 着信・入力中・オンライン状態は全部ここを通るので、ブロックすると全部止まる
async function canInteract(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (await isBlockedEither(a, b)) return false;
  if (await areFriends(a, b)) return true;
  return shareGroup(a, b);
}

module.exports = { areFriends, shareGroup, canInteract, blockState, isBlockedEither, bumpBlockVersion, getBlockVersion };
