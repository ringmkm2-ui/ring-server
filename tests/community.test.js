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

test('メッセージの編集は本人だけ、削除は本人か管理者だけ', async () => {
  const o = await S.user('Owner'); const m = await S.user('Member'); const x = await S.user('Other');
  const c = (await o.call('POST', '/api/communities', { name: 'Edit' })).data.community;
  await m.call('POST', '/api/communities/join', { inviteCode: c.inviteCode });
  const ch = (await o.call('GET', `/api/communities/${c.id}`)).data.channels[0].id;
  const base = `/api/communities/${c.id}`;
  const id = (await m.call('POST', `${base}/channels/${ch}/messages`, { content: 'v1' })).data.message.id;
  assert.equal((await o.call('POST', `${base}/messages/${id}/edit`, { content: 'hack' })).status, 403);
  assert.equal((await x.call('POST', `${base}/messages/${id}/edit`, { content: 'hack' })).status, 403);
  assert.equal((await m.call('POST', `${base}/messages/${id}/edit`, { content: 'v2' })).status, 200);
  let h = (await o.call('GET', `${base}/channels/${ch}/messages`)).data.messages;
  assert.equal(h[0].content, 'v2'); assert.ok(h[0].edited_at);
  assert.equal((await x.call('POST', `${base}/messages/${id}/delete`, {})).status, 403);
  assert.equal((await o.call('POST', `${base}/messages/${id}/delete`, {})).status, 200); // 管理者
  assert.equal((await m.call('POST', `${base}/messages/${id}/delete`, {})).status, 404);
  h = (await o.call('GET', `${base}/channels/${ch}/messages`)).data.messages;
  assert.equal(h.length, 0);
});

test('同じコミュニティの人(友だちでなくても)とは鍵のやり取りができる。無関係な人は不可', async () => {
  const o = await S.user('Owner'); const m = await S.user('Member'); const x = await S.user('Stranger');
  const c = (await o.call('POST', '/api/communities', { name: 'Keys2', encryptedKeyForSelf: KEY })).data.community;
  await m.call('POST', '/api/communities/join', { inviteCode: c.inviteCode });
  // 403 = 関係が無いので拒否 / 404 = 関係はあるが相手がまだ鍵を登録していない
  assert.equal((await o.call('GET', `/api/prekeys/identity/${m.userId}`)).status, 404);
  assert.equal((await o.call('GET', `/api/prekeys/bundle/${m.userId}`)).status, 404);
  assert.equal((await x.call('GET', `/api/prekeys/identity/${m.userId}`)).status, 403);
  assert.equal((await x.call('GET', `/api/prekeys/bundle/${m.userId}`)).status, 403);
  const d = (await o.call('GET', `/api/communities/${c.id}`)).data;
  assert.equal(d.community.encrypted, true);
});

// 5秒ごとの確認で本文を返さない近道。これが無いと、コミュニティを開いたままの端末1台で
// 1日1〜2GBのDB転送になり、Neonの無料枠(1か月5GB)を使い切ってDBが止まる(2026-10-28に実際に起きた)
test('印(v)が同じなら本文を返さない。発言があれば印が変わって本文が返る', async () => {
  const o = await S.user('VOwner');
  const c = (await o.call('POST', '/api/communities', { name: 'V', encryptedKeyForSelf: KEY })).data.community;
  const ch = (await o.call('GET', `/api/communities/${c.id}`)).data.channels[0].id;
  const url = `/api/communities/${c.id}/channels/${ch}/messages`;

  const first = await o.call('GET', url);
  assert.equal(first.status, 200);
  assert.ok(typeof first.data.v === 'string' && first.data.v.length, '印が返っていない');

  // 同じ印で聞くと本文は返らない(ここが転送量の節約点)
  const again = await o.call('GET', `${url}?v=${encodeURIComponent(first.data.v)}`);
  assert.equal(again.data.unchanged, true);
  assert.equal(again.data.messages, undefined);
  assert.equal(again.data.v, first.data.v);

  // 発言すると印が変わり、本文が返る
  assert.equal((await o.call('POST', url, { content: 'yo' })).status, 200);
  const after = await o.call('GET', `${url}?v=${encodeURIComponent(first.data.v)}`);
  assert.ok(!after.data.unchanged, '新しい発言があるのに本文が返っていない');
  assert.ok(after.data.messages.some(x => x.content === 'yo'));
  assert.notEqual(after.data.v, first.data.v);

  // 当てずっぽうの印では本文が返る(近道で中身が隠れたままにならない)
  const bogus = await o.call('GET', `${url}?v=nonsense`);
  assert.ok(!bogus.data.unchanged);
  assert.ok(bogus.data.messages.length >= 1);
});
