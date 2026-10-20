const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

const KEY = 'k'.repeat(40);

test('作成・参加・一覧・メンバーは管理者が先・メッセージ', async () => {
  const o = await S.user('Owner'); const m = await S.user('Member');
  const c = (await o.call('POST', '/api/communities', { name: 'Room', description: 'd', encryptedKeyForSelf: KEY })).data.community;
  assert.ok(c.inviteCode);
  const j = await m.call('POST', '/api/communities/join', { inviteCode: c.inviteCode });
  assert.equal(j.status, 200);
  const d = (await m.call('GET', `/api/communities/${c.id}`)).data;
  assert.equal(d.members[0].role, 'admin');
  const ch = d.channels[0].id;
  const sent = await m.call('POST', `/api/communities/${c.id}/channels/${ch}/messages`, { content: 'hello' });
  assert.equal(sent.status, 200);
  const h = (await o.call('GET', `/api/communities/${c.id}/channels/${ch}/messages`)).data.messages;
  assert.ok(h.some(x => x.content === 'hello'));
  assert.equal((await o.call('POST', `/api/communities/${c.id}/channels`, { name: { length: 3 } })).status, 400);
});

test('削除はオーナーだけ。消えたら誰からも見えない', async () => {
  const o = await S.user('Owner'); const m = await S.user('Member');
  const c = (await o.call('POST', '/api/communities', { name: 'Gone' })).data.community;
  await m.call('POST', '/api/communities/join', { inviteCode: c.inviteCode });
  assert.equal((await m.call('POST', `/api/communities/${c.id}/delete`, {})).status, 403);
  assert.equal((await o.call('POST', `/api/communities/${c.id}/delete`, {})).status, 200);
  assert.deepEqual((await m.call('GET', '/api/communities/list')).data.communities, []);
  assert.equal((await o.call('POST', `/api/communities/${c.id}/delete`, {})).status, 404);
});

test('鍵の作り直しは、同じ版からだと1回しか通らない', async () => {
  const o = await S.user('Owner');
  const c = (await o.call('POST', '/api/communities', { name: 'Keys', encryptedKeyForSelf: KEY })).data.community;
  const body = { expectedVersion: 1, encryptedKeysForMembers: [{ userId: o.userId, encryptedKey: 'n'.repeat(40) }] };
  const [a, b] = await Promise.all([
    o.call('POST', `/api/communities/${c.id}/rotate-key`, body),
    o.call('POST', `/api/communities/${c.id}/rotate-key`, body),
  ]);
  const ok = [a, b].filter(r => r.status === 200).length;
  assert.equal(ok, 1, JSON.stringify([a.status, b.status]));
});
