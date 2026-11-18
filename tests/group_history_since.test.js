// グループの履歴取得の since: この時刻より後の新着だけ返す(Neonの転送量を節約するため)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

const wait = ms => new Promise(r => setTimeout(r, ms));

// SQLiteは時刻を文字列で持っていて、この比較が合わない。本番(Postgres)と同じ環境でだけ確かめる
test('グループ履歴: since を付けると新着だけ返る', { skip: !process.env.TEST_DATABASE_URL && 'Postgres のときだけ' }, async () => {
  const a = await S.user('GsA'); const b = await S.user('GsB');
  await S.befriend(a, b);
  const g = (await a.call('POST', '/api/groups/create', { name: 'g', memberIds: [b.userId], encryptedKeysForMembers: [] })).data.groupId;
  await a.call('POST', `/api/groups/${g}/messages/send`, { content: 'one' });
  await a.call('POST', `/api/groups/${g}/messages/send`, { content: 'two' });

  const full = await b.call('GET', `/api/groups/${g}/messages`);
  assert.ok(full.data.filter(m => m.content === 'one' || m.content === 'two').length === 2);

  await wait(1200);
  const since = new Date().toISOString();
  const none = await b.call('GET', `/api/groups/${g}/messages?since=${encodeURIComponent(since)}`);
  assert.equal(none.status, 200);
  assert.deepEqual(none.data, []);

  await wait(1200);
  await a.call('POST', `/api/groups/${g}/messages/send`, { content: 'three' });
  const r = await b.call('GET', `/api/groups/${g}/messages?since=${encodeURIComponent(since)}`);
  assert.deepEqual(r.data.map(m => m.content), ['three']);

  // 変な値は無視されて全件になる
  const bad = await b.call('GET', `/api/groups/${g}/messages?since=zzz`);
  assert.ok(bad.data.length >= 3);
});
