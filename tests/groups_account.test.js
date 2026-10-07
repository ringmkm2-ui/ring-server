// グループ・アカウント・設定・WebSocketまわりのテスト
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

async function group(owner, members = []) {
  const r = await owner.call('POST', '/api/groups/create', { name: 'G' + Date.now() % 10000, memberIds: members.map(m => m.userId) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

describe('グループ', () => {
  test('友だちでない人はグループに入れられない', async () => {
    const a = await S.user('A'); const b = await S.user('B'); const c = await S.user('C');
    await S.befriend(a, b);
    const g = await group(a, [b, c]);
    assert.ok(g.members.includes(b.userId));
    assert.ok(!g.members.includes(c.userId), '友だちでないCは入らない');
  });

  test('メンバー以外は読めない・送れない・招待できない', async () => {
    const a = await S.user('A'); const out = await S.user('Out');
    const g = await group(a);
    assert.equal((await out.call('GET', `/api/groups/${g.groupId}/messages`)).status, 403);
    assert.equal((await out.call('POST', `/api/groups/${g.groupId}/messages/send`, { content: 'x' })).status, 403);
    assert.equal((await out.call('POST', '/api/groups/invite', { groupId: g.groupId, targetUserId: out.userId })).status, 403);
  });

  test('メンバーは送れて、他のメンバーが読める', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const g = await group(a, [b]);
    assert.equal((await a.call('POST', `/api/groups/${g.groupId}/messages/send`, { content: 'hey all' })).status, 200);
    const r = await b.call('GET', `/api/groups/${g.groupId}/messages`);
    assert.equal(r.status, 200);
    const list = Array.isArray(r.data) ? r.data : r.data.messages;
    assert.ok(list.some(m => m.content === 'hey all'));
  });

  test('他人のグループメッセージは編集・削除できない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const g = await group(a, [b]);
    const s = await a.call('POST', `/api/groups/${g.groupId}/messages/send`, { content: 'mine' });
    const id = s.data.message.id;
    assert.equal((await b.call('POST', `/api/groups/${g.groupId}/messages/${id}/edit`, { content: 'x' })).status, 403);
    assert.equal((await b.call('POST', `/api/groups/${g.groupId}/messages/${id}/delete`, {})).status, 403);
  });

  test('オーナー以外は他人を外せない(自分で抜けるのはOK)', async () => {
    const a = await S.user('A'); const b = await S.user('B'); const c = await S.user('C');
    await S.befriend(a, b); await S.befriend(a, c);
    const g = await group(a, [b, c]);
    assert.equal((await b.call('POST', '/api/groups/remove-member', { groupId: g.groupId, removeUserId: c.userId })).status, 403);
    assert.equal((await b.call('POST', '/api/groups/remove-member', { groupId: g.groupId, removeUserId: b.userId })).status, 200);
  });

  test('ブロックしていても、同じグループの中では普通に会話できる', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const g = await group(a, [b]);
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    await a.call('POST', `/api/groups/${g.groupId}/messages/send`, { content: 'in group' });
    const r = await b.call('GET', `/api/groups/${g.groupId}/messages`);
    const list = Array.isArray(r.data) ? r.data : r.data.messages;
    assert.ok(list.some(m => m.content === 'in group'));
  });
});

describe('アカウント', () => {
  test('ログアウトするとそのトークンは使えない', async () => {
    const a = await S.user('A');
    assert.equal((await a.call('POST', '/api/auth/logout', {})).status, 200);
    assert.equal((await a.call('GET', '/api/friends/list')).status, 401);
  });

  test('パスワードを変えると古いトークンは使えず、新しいパスワードでログインできる', async () => {
    const a = await S.user('A');
    const np = 'Nw7!pQ' + Date.now() + 'zZ';
    const r = await a.call('POST', '/api/auth/change-password', { currentPassword: a.password, newPassword: np });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await a.call('GET', '/api/friends/list')).status, 401);
    if (r.data.token) {
      const fresh = await S.req('GET', '/api/friends/list', { token: r.data.token, ip: a.ip });
      assert.equal(fresh.status, 200, '変更直後に返されたトークンは使える');
    }
    const login = await S.req('POST', '/api/auth/login', { body: { username: a.username, password: np } });
    assert.equal(login.status, 200);
  });

  test('今のパスワードが違えば変更できない', async () => {
    const a = await S.user('A');
    const r = await a.call('POST', '/api/auth/change-password', { currentPassword: 'wrong-pass-123', newPassword: 'Nw7!pQabcdefzZ1' });
    assert.notEqual(r.status, 200);
  });

  test('退会にはパスワードが必要で、退会後はログインできない', async () => {
    const a = await S.user('A');
    assert.notEqual((await a.call('POST', '/api/auth/delete-account', { password: 'wrong-pass-123' })).status, 200);
    assert.equal((await a.call('POST', '/api/auth/delete-account', { password: a.password })).status, 200);
    const login = await S.req('POST', '/api/auth/login', { body: { username: a.username, password: a.password } });
    assert.notEqual(login.status, 200);
  });
});

describe('設定', () => {
  test('保存した設定が取れて、知らない項目は捨てられる', async () => {
    const a = await S.user('A');
    const r = await a.call('PUT', '/api/settings', { settings: { sendTypingIndicator: false, evilKey: 'x' } });
    assert.equal(r.status, 200);
    const g = await a.call('GET', '/api/settings');
    assert.equal(g.data.settings.sendTypingIndicator, false);
    assert.ok(!('evilKey' in g.data.settings));
  });

  test('形がおかしい設定は400', async () => {
    const a = await S.user('A');
    assert.equal((await a.call('PUT', '/api/settings', { settings: [1, 2] })).status, 400);
    assert.equal((await a.call('PUT', '/api/settings', {})).status, 400);
  });
});

describe('入力中・WebSocket', () => {
  test('知らない人には入力中が届かない、友だちには届く', async () => {
    const a = await S.user('A'); const b = await S.user('B'); const x = await S.user('X');
    await S.befriend(a, b);
    const wa = await S.connect(a); const wb = await S.connect(b); const wx = await S.connect(x);
    try {
      wa.send({ type: 'typing', recipientId: b.userId });
      wa.send({ type: 'typing', recipientId: x.userId });
      await sleep(400);
      assert.ok(wb.msgs.some(m => m.type === 'typing'), '友だちには届く');
      assert.ok(!wx.msgs.some(m => m.type === 'typing'), '知らない人には届かない');
    } finally { wa.close(); wb.close(); wx.close(); }
  });

  test('ブロックした相手の入力中は届かない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    const wa = await S.connect(a); const wb = await S.connect(b);
    try {
      wa.send({ type: 'typing', recipientId: b.userId });
      await sleep(400);
      assert.ok(!wb.msgs.some(m => m.type === 'typing'));
    } finally { wa.close(); wb.close(); }
  });

  test('オンライン状態: 友だちには見えて、ブロックすると見えなくなる', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const wa = await S.connect(a); const wb = await S.connect(b);
    const ask = async () => {
      wa.msgs.length = 0;
      wa.send({ type: 'presence_query', targetUserId: b.userId });
      await sleep(300);
      const r = wa.msgs.find(m => m.type === 'presence_result');
      return r && r.online;
    };
    try {
      assert.equal(await ask(), true);
      await b.call('POST', '/api/friends/block', { userId: a.userId });
      assert.equal(await ask(), false, 'ブロックした人のオンラインは見えない');
      await b.call('POST', '/api/friends/unblock', { userId: a.userId });
      assert.equal(await ask(), true, '解除すればまた見える');
    } finally { wa.close(); wb.close(); }
  });

  test('壊れたデータを送ってもサーバーは落ちない', async () => {
    const a = await S.user('A');
    const wa = await S.connect(a);
    try {
      for (const junk of ['null', '123', '[]', '{"type":null}', '{"type":"call_offer"}', 'not json', '{"type":"typing","recipientId":{}}']) wa.ws.send(junk);
      await sleep(300);
      const h = await fetch(S.base + '/health');
      assert.equal(h.status, 200);
    } finally { wa.close(); }
  });

  test('偽トークンでは認証できない', async () => {
    await assert.rejects(S.connect({ token: 'bad.token.here', ip: '10.9.9.9' }));
  });
});

describe('メッセージの入力チェック', () => {
  test('長すぎるメッセージは413', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const r = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'x'.repeat(200000) });
    assert.ok(r.status === 413 || r.status === 400, String(r.status));
  });

  test('Cloudinary以外のmediaUrlは受け付けない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const r = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: '[画像]', mediaType: 'image', mediaUrl: 'https://evil.example.com/x.png' });
    assert.equal(r.status, 400);
  });
});
