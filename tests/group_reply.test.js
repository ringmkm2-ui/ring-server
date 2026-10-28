const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

async function group(owner, members) {
  const r = await owner.call('POST', '/api/groups/create', { name: 'g', memberIds: members.map(m => m.userId), encryptedKeysForMembers: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.groupId;
}

test('グループの返信: 返信先が保存され、履歴とWSに載る。ほかのグループや取り消し済みは指せない', async () => {
  const a = await S.user('GrA'); const b = await S.user('GrB'); const c = await S.user('GrC');
  await S.befriend(a, b); await S.befriend(a, c);
  const g1 = await group(a, [b]);
  const g2 = await group(a, [c]);

  const orig = await a.call('POST', `/api/groups/${g1}/messages/send`, { content: 'original' });
  assert.equal(orig.status, 200);
  const origId = orig.data.message.id;

  const ws = await S.connect(b);
  const got = new Promise(res => ws.ws.on('message', m => { const d = JSON.parse(m); if (d.type === 'group_message' && d.message.content === 'reply!') res(d.message); }));
  const rep = await b.call('POST', `/api/groups/${g1}/messages/send`, { content: 'reply!', repliedToId: origId });
  assert.equal(rep.status, 200, JSON.stringify(rep.data));
  const live = await got;
  assert.equal(live.repliedToId, origId);
  ws.close();

  const hist = await a.call('GET', `/api/groups/${g1}/messages`);
  const row = hist.data.find(m => m.content === 'reply!');
  assert.equal(row.replied_to_id, origId);

  // 別グループのメッセージは指せない
  const other = await a.call('POST', `/api/groups/${g2}/messages/send`, { content: 'in g2' });
  const cross = await b.call('POST', `/api/groups/${g1}/messages/send`, { content: 'x', repliedToId: other.data.message.id });
  assert.equal(cross.status, 400);

  // 形がおかしいものは弾く
  const bad = await b.call('POST', `/api/groups/${g1}/messages/send`, { content: 'x', repliedToId: { $ne: 1 } });
  assert.equal(bad.status, 400);

  // 取り消したメッセージにはもう返信できない
  await a.call('POST', `/api/groups/${g1}/messages/${origId}/delete`);
  const gone = await b.call('POST', `/api/groups/${g1}/messages/send`, { content: 'late', repliedToId: origId });
  assert.equal(gone.status, 400);
});
