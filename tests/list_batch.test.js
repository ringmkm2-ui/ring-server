// まとめ取りに変えたAPI(グループ一覧・DM履歴のリアクション)が、以前と同じ答えを返すか
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

describe('グループ一覧', () => {
  test('最新メッセージ・未読数・メンバーが正しく、既読で未読が0になる', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const g1 = (await a.call('POST', '/api/groups/create', { name: 'G1', memberIds: [b.userId] })).data;
    const g2 = (await a.call('POST', '/api/groups/create', { name: 'G2', memberIds: [b.userId] })).data;
    await sleep(1100);
    await a.call('POST', `/api/groups/${g1.groupId}/messages/send`, { content: 'one' });
    await sleep(1100); // SQLiteは時刻が秒単位なので、順番が決まるよう間を空ける
    await a.call('POST', `/api/groups/${g1.groupId}/messages/send`, { content: 'two' });
    const r = await b.call('GET', '/api/groups/list');
    assert.equal(r.status, 200);
    const l1 = r.data.groups.find(x => x.groupId === g1.groupId);
    const l2 = r.data.groups.find(x => x.groupId === g2.groupId);
    assert.equal(l1.lastMessage.content, 'two');
    assert.equal(l1.unreadCount, 2);
    assert.equal(l1.members.length, 2);
    assert.equal(l2.lastMessage, null);
    assert.equal(l2.unreadCount, 0);
    // 新しい発言があった方が上
    assert.equal(r.data.groups[0].groupId, g1.groupId);
    // 送った本人には未読が付かない
    const mine = (await a.call('GET', '/api/groups/list')).data.groups.find(x => x.groupId === g1.groupId);
    assert.equal(mine.unreadCount, 0);
    await b.call('POST', `/api/groups/${g1.groupId}/seen`, {});
    const after = (await b.call('GET', '/api/groups/list')).data.groups.find(x => x.groupId === g1.groupId);
    assert.equal(after.unreadCount, 0);
  });

  test('グループが無い人は空の一覧', async () => {
    const c = await S.user('C');
    const r = await c.call('GET', '/api/groups/list');
    assert.deepEqual(r.data.groups, []);
  });

  test('既読者一覧は別グループのメッセージIDでは見えない', async () => {
    const a = await S.user('A'); const b = await S.user('B'); const x = await S.user('X');
    await S.befriend(a, b);
    const g = (await a.call('POST', '/api/groups/create', { name: 'GA', memberIds: [b.userId] })).data;
    const other = (await x.call('POST', '/api/groups/create', { name: 'GX' })).data;
    const m = (await a.call('POST', `/api/groups/${g.groupId}/messages/send`, { content: 'hi' })).data.message;
    await b.call('POST', `/api/groups/${g.groupId}/messages/read`, { messageIds: [m.id] });
    const own = await a.call('GET', `/api/groups/${g.groupId}/messages/${m.id}/reads`);
    assert.equal(own.data.reads.length, 1);
    const leak = await x.call('GET', `/api/groups/${other.groupId}/messages/${m.id}/reads`);
    assert.equal(leak.data.reads.length, 0);
  });
});

describe('DM履歴のリアクション', () => {
  test('メッセージごとのリアクション数が合う', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const m1 = (await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'm1' })).data.message;
    const m2 = (await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'm2' })).data.message;
    await b.call('POST', '/api/messages/react', { messageId: m1.id, emoji: 'a' });
    await a.call('POST', '/api/messages/react', { messageId: m1.id, emoji: 'a' });
    await b.call('POST', '/api/messages/react', { messageId: m1.id, emoji: 'b' });
    const h = await b.call('GET', `/api/messages/history/${a.userId}`);
    const h1 = h.data.find(m => m.id === m1.id), h2 = h.data.find(m => m.id === m2.id);
    assert.deepEqual(h1.reactions.slice().sort((x, y) => x.emoji.localeCompare(y.emoji)), [{ emoji: 'a', count: 2 }, { emoji: 'b', count: 1 }]);
    assert.deepEqual(h2.reactions, []);
  });
});

describe('退会', () => {
  test('オーナーが退会すると、残りの人に引き継がれ、退会者はメンバーから外れる', async () => {
    const a = await S.user('Owner'); const b = await S.user('Member');
    await S.befriend(a, b);
    const g = (await a.call('POST', '/api/groups/create', { name: 'GD', memberIds: [b.userId] })).data;
    assert.equal((await a.call('POST', '/api/auth/delete-account', { password: a.password })).status, 200);
    const l = (await b.call('GET', '/api/groups/list')).data.groups.find(x => x.groupId === g.groupId);
    assert.ok(l, 'グループは残る');
    assert.equal(l.ownerId, b.userId);
    assert.equal(l.isOwner, true);
    assert.deepEqual(l.members.map(m => m.userId), [b.userId]);
  });
});
