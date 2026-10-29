// 履歴取得の since: 前回以降に変わったメッセージだけ返す(Neonの転送量を節約するため)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

const wait = ms => new Promise(r => setTimeout(r, ms));

// SQLiteは時刻を文字列で持っていて、この比較が合わない。本番(Postgres)と同じ環境でだけ確かめる
test('since を付けると、変わった分だけ返る(新着・編集・既読・リアクション追加)', { skip: !process.env.TEST_DATABASE_URL && 'Postgres のときだけ' }, async () => {
  const a = await S.user('SinA'); const b = await S.user('SinB');
  await S.befriend(a, b);
  const m1 = (await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'one' })).data.message;
  const m2 = (await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'two' })).data.message;

  // since 無し: 全件
  const full = await a.call('GET', '/api/messages/history/' + b.userId);
  assert.equal(full.data.length, 2);

  // 何も変わっていなければ空
  await wait(1200);
  const since0 = new Date().toISOString();
  const none = await a.call('GET', '/api/messages/history/' + b.userId + '?since=' + encodeURIComponent(since0));
  assert.equal(none.status, 200);
  assert.deepEqual(none.data, []);

  // 新着だけ返る
  await wait(1200);
  const m3 = (await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'three' })).data.message;
  const r3 = await a.call('GET', '/api/messages/history/' + b.userId + '?since=' + encodeURIComponent(since0));
  assert.deepEqual(r3.data.map(m => m.id), [m3.id]);

  // 古いメッセージの編集も拾う
  const since1 = new Date().toISOString();
  await wait(1200);
  const ed = await a.call('POST', '/api/messages/edit', { messageId: m1.id, content: 'one edited' });
  assert.equal(ed.status, 200, JSON.stringify(ed.data));
  const r4 = await a.call('GET', '/api/messages/history/' + b.userId + '?since=' + encodeURIComponent(since1));
  assert.deepEqual(r4.data.map(m => m.id), [m1.id]);

  // 相手が開いて既読になった分も拾う
  const since2 = new Date().toISOString();
  await wait(1200);
  await b.call('GET', '/api/messages/history/' + a.userId);
  const r5 = await a.call('GET', '/api/messages/history/' + b.userId + '?since=' + encodeURIComponent(since2));
  assert.equal(r5.data.length, 3);
  assert.ok(r5.data.every(m => m.readAt));

  // リアクション追加も拾う
  const since3 = new Date().toISOString();
  await wait(1200);
  await b.call('POST', '/api/messages/react', { messageId: m2.id, emoji: 'a' });
  const r6 = await a.call('GET', '/api/messages/history/' + b.userId + '?since=' + encodeURIComponent(since3));
  assert.deepEqual(r6.data.map(m => m.id), [m2.id]);
  assert.equal(r6.data[0].reactions.length, 1);

  // 変な値は無視されて全件になる
  const bad = await a.call('GET', '/api/messages/history/' + b.userId + '?since=zzz');
  assert.equal(bad.data.length, 3);
});
