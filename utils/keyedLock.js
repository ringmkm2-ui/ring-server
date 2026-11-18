// utils/keyedLock.js
// 同じキー(ユーザーIDなど)の処理を1つずつ順番に行う。「数えてから足す」「前回の送信時刻を見てから送る」のように、
// 確認と書き込みが別々のSQLになる処理が、同時に来た時にすり抜けるのを防ぐ。サーバー1台の前提(複数台ならDB側のロックが要る)
const tails = new Map();
async function withLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  let release;
  const mine = new Promise(r => { release = r; });
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  await prev;
  try { return await fn(); }
  finally { release(); if (tails.get(key) === tail) tails.delete(key); }
}
module.exports = { withLock };
