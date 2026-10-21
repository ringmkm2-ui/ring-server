const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// db をスタブに差し替えて、公式アカウントを友だちにする処理だけを調べる
function load(rows) {
  const dbPath = require.resolve(path.join(__dirname, '../db/db'));
  const inserted = [];
  const stub = {
    get: async (sql, p) => {
      if (/FROM users WHERE user_id/.test(sql)) return rows.official && rows.official.user_id === p[0] ? rows.official : undefined;
      if (/FROM friendships/.test(sql)) return rows.friendship;
    },
    run: async (sql, p) => { inserted.push(p); },
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub };
  delete require.cache[require.resolve('../utils/officialFriend')];
  return { mod: require('../utils/officialFriend'), inserted };
}

test('新規ユーザーに公式アカウントを友だちとして入れる', async () => {
  delete process.env.OFFICIAL_FRIEND_ID;
  const { mod, inserted } = load({ official: { id: 'off-1', user_id: 'UMTUK9D' } });
  await mod.befriendOfficial('user-9');
  assert.equal(inserted.length, 1);
  assert.deepEqual([inserted[0][1], inserted[0][2]], ['off-1', 'user-9'].sort());
});

test('すでに友だち・自分自身・無効化(空)なら何もしない', async () => {
  let r = load({ official: { id: 'off-1', user_id: 'UMTUK9D' }, friendship: { id: 'x' } });
  await r.mod.befriendOfficial('user-9'); assert.equal(r.inserted.length, 0);
  r = load({ official: { id: 'off-1', user_id: 'UMTUK9D' } });
  await r.mod.befriendOfficial('off-1'); assert.equal(r.inserted.length, 0);
  process.env.OFFICIAL_FRIEND_ID = '';
  r = load({ official: { id: 'off-1', user_id: 'UMTUK9D' } });
  await r.mod.befriendOfficial('user-9'); assert.equal(r.inserted.length, 0);
  delete process.env.OFFICIAL_FRIEND_ID;
});
