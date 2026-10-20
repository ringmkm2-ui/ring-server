const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

test('ブロックした相手の投稿とコメントは出ない・退会したら投稿も消える', async () => {
  const a = await S.user('A'); const b = await S.user('B'); const c = await S.user('C');
  const pb = (await b.call('POST', '/api/posts', { text: 'from B' })).data.post;
  const pc = (await c.call('POST', '/api/posts', { text: 'from C' })).data.post;
  await b.call('POST', `/api/posts/${pc.id}/comments`, { text: 'B comment' });
  let tl = (await a.call('GET', '/api/posts')).data;
  assert.ok(tl.some(p => p.id === pb.id) && tl.some(p => p.id === pc.id));
  await a.call('POST', '/api/friends/block', { userId: b.userId });
  tl = (await a.call('GET', '/api/posts')).data;
  assert.ok(!tl.some(p => p.id === pb.id), 'ブロックした人の投稿は出ない');
  assert.ok(tl.some(p => p.id === pc.id));
  assert.equal((await a.call('GET', `/api/posts/${pc.id}/comments`)).data.length, 0, 'ブロックした人のコメントは出ない');
  // ブロックされた側からも見えない
  assert.ok(!(await b.call('GET', '/api/posts')).data.some(p => p.authorId === a.userId));
  // 退会したら投稿が消える
  await c.call('POST', '/api/auth/delete-account', { password: c.password });
  assert.ok(!(await a.call('GET', '/api/posts')).data.some(p => p.id === pc.id), '退会者の投稿は消える');
});
