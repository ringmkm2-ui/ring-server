const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

test('名前だけ送っても自己紹介は消えない', async () => {
  const a = await S.user('Alice');
  await a.call('POST', '/api/friends/me', { displayName: 'Alice', bio: 'hello bio' });
  await a.call('POST', '/api/friends/me', { displayName: 'Alice2' });
  const me = (await a.call('GET', '/api/friends/me')).data;
  assert.equal(me.displayName, 'Alice2');
  assert.equal(me.bio, 'hello bio');
  await a.call('POST', '/api/friends/me', { bio: '' });
  assert.equal((await a.call('GET', '/api/friends/me')).data.bio, '');
});

test('検索の % _ は文字として扱う(全員ヒットしない)', async () => {
  const a = await S.user('Seeker'); await S.user('Zed Person'); await S.user('Yan Person');
  assert.deepEqual((await a.call('GET', '/api/friends/search?q=' + encodeURIComponent('%%'))).data, []);
  assert.deepEqual((await a.call('GET', '/api/friends/search?q=' + encodeURIComponent('__'))).data, []);
  const hit = (await a.call('GET', '/api/friends/search?q=' + encodeURIComponent('Zed Per'))).data;
  assert.equal(hit.length, 1);
});

test('お互いに申請し合ったら、そのまま友だちになる', async () => {
  const a = await S.user('A'); const b = await S.user('B');
  assert.equal((await a.call('POST', '/api/friends/request', { targetUserIdCode: b.userIdCode })).status, 200);
  const dup = await a.call('POST', '/api/friends/request', { targetUserIdCode: b.userIdCode });
  assert.equal(dup.status, 400, '同じ人が二重に送るのは断る');
  const r = await b.call('POST', '/api/friends/request', { targetUserIdCode: a.userIdCode });
  assert.equal(r.status, 200);
  assert.equal(r.data.accepted, true);
  const list = (await a.call('GET', '/api/friends/list')).data;
  assert.ok(list.some(f => f.userId === b.userId));
});

test('退会したユーザーは検索にも申請にも出ない', async () => {
  const a = await S.user('Seeker2'); const gone = await S.user('Goner Person');
  await gone.call('POST', '/api/auth/delete-account', { password: gone.password });
  assert.deepEqual((await a.call('GET', '/api/friends/search?q=' + encodeURIComponent('退会'))).data, []);
  assert.equal((await a.call('POST', '/api/friends/request', { targetUserIdCode: gone.userIdCode })).status, 404);
});
