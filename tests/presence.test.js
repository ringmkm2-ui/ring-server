// 画面移動で繋ぎ直しただけなら、相手にオフラインを送らない。本当に切れたら送る
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

test('すぐ繋ぎ直した時はオフラインを送らず、戻らなければ送る', async () => {
  const a = await S.user('A'); const b = await S.user('B');
  await S.befriend(a, b);
  await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'hi' }); // トークした相手になる
  const wa = await S.connect(a);
  let wb = await S.connect(b);
  wb.send({ type: 'chat_open' });
  await sleep(500);
  assert.ok(wa.msgs.some(m => m.type === 'presence_update' && m.userId === b.userId && m.online === true), 'オンラインが届く');

  wb.close();
  await sleep(300);
  wb = await S.connect(b);
  wb.send({ type: 'chat_open' });
  await sleep(5000);
  assert.ok(!wa.msgs.some(m => m.type === 'presence_update' && m.userId === b.userId && m.online === false), '繋ぎ直しではオフラインを送らない');
  assert.equal(wa.msgs.filter(m => m.type === 'presence_update' && m.online === true).length, 1, 'オンラインも二重に送らない');

  wb.close();
  await sleep(5500);
  assert.ok(wa.msgs.some(m => m.type === 'presence_update' && m.userId === b.userId && m.online === false), '戻らなければオフラインが届く');
  wa.close();
});
