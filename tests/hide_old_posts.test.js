const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 公開前の投稿の非表示: 古い投稿だけが隠れ、あとから作った投稿・自分で消した投稿は影響を受けない。
// 起動(initDB)を何度繰り返しても、新しい投稿は隠れない。
test('公開前の投稿だけ非表示になり、何度起動しても新しい投稿は隠れない', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hide-posts-')), 't.sqlite');
  process.env.SQLITE_FILE = file;
  delete require.cache[require.resolve('../db/db.sqlite.js')];
  const db = require('../db/db.sqlite.js');
  await db.initDB();
  await db.run("INSERT INTO users (id, user_id, username, password_hash) VALUES ('u1', 'U1', 'u1', 'x')");
  const ins = (id, at, del) => db.run(
    'INSERT INTO posts (id, author_id, text, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)', [id, 'u1', id, at, del || null]);
  await ins('old', '2026-10-01 00:00:00');
  await ins('old_user_deleted', '2026-10-02 00:00:00', '2026-10-03 00:00:00');
  await ins('new', '2027-01-01 00:00:00');

  await db.initDB(); // 次の起動
  const rows = Object.fromEntries((await db.all('SELECT id, deleted_at, hidden_at FROM posts')).map(r => [r.id, r]));
  assert.ok(rows.old.deleted_at && rows.old.hidden_at, '古い投稿は非表示');
  assert.equal(rows.old_user_deleted.hidden_at, null, '自分で消した投稿に印は付けない');
  assert.equal(rows.old_user_deleted.deleted_at, '2026-10-03 00:00:00');
  assert.equal(rows.new.deleted_at, null, '新しい投稿は触らない');

  // 元に戻す手順: deleted_at だけ外せば、再起動しても隠れ直さない
  await db.run('UPDATE posts SET deleted_at = NULL WHERE hidden_at IS NOT NULL');
  await db.initDB();
  const back = await db.get("SELECT deleted_at FROM posts WHERE id = 'old'");
  assert.equal(back.deleted_at, null);
});
