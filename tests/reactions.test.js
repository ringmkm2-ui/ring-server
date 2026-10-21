const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

test('リアクションの同時連打で500にならない・種類は12まで', async () => {
  const a = await S.user('ReA'); const b = await S.user('ReB');
  await S.befriend(a, b);
  const sent = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'hi' });
  const id = sent.data.message.id;
  const rs = await Promise.all(Array.from({ length: 8 }, () => b.call('POST', '/api/messages/react', { messageId: id, emoji: 'a' })));
  for (const r of rs) assert.ok(r.status === 200, 'status ' + r.status + ' ' + JSON.stringify(r.data));
  for (const e of ['b','c','d','e','f','g','h','i','j','k','l','m','n']) await b.call('POST', '/api/messages/react', { messageId: id, emoji: e });
  const last = await b.call('POST', '/api/messages/react', { messageId: id, emoji: 'zz' });
  assert.equal(last.status, 429);
});
