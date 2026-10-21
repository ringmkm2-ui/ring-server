const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

async function pendingId(u) { return (await u.call('GET', '/api/friends/pending')).data[0].friendshipId; }

test('受け取った申請を拒否できる(送った側は拒否できない)', async () => {
  const a = await S.user('RejA'); const b = await S.user('RejB');
  await a.call('POST', '/api/friends/request', { targetUserIdCode: b.userIdCode });
  const id = await pendingId(b);
  assert.equal((await a.call('POST', '/api/friends/reject', { friendshipId: id })).status, 400);
  assert.equal((await b.call('POST', '/api/friends/reject', { friendshipId: id })).status, 200);
  assert.deepEqual((await b.call('GET', '/api/friends/pending')).data, []);
});

test('送った申請を取り消せる・第三者は触れない', async () => {
  const a = await S.user('CanA'); const b = await S.user('CanB'); const c = await S.user('CanC');
  await a.call('POST', '/api/friends/request', { targetUserIdCode: b.userIdCode });
  const id = await pendingId(a);
  assert.equal((await c.call('POST', '/api/friends/cancel', { friendshipId: id })).status, 403);
  assert.equal((await b.call('POST', '/api/friends/cancel', { friendshipId: id })).status, 400);
  assert.equal((await a.call('POST', '/api/friends/cancel', { friendshipId: id })).status, 200);
});

test('友だちを削除すると送れなくなり、申請し直せる', async () => {
  const a = await S.user('RmA'); const b = await S.user('RmB');
  await S.befriend(a, b);
  assert.equal((await a.call('POST', '/api/friends/remove', { userId: b.userId || b.user.id })).status, 200);
  assert.equal((await a.call('POST', '/api/friends/remove', { userId: b.userId || b.user.id })).status, 404);
  assert.equal((await a.call('POST', '/api/friends/request', { targetUserIdCode: b.userIdCode })).status, 200);
});
