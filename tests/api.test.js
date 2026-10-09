// npm test で動くAPIテスト。サーバーを本当に立ち上げて、外から叩いて確かめる。
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let S;

before(async () => { S = await startServer(); });
after(() => S && S.stop());

describe('登録・ログイン', () => {
  test('登録するとトークンが返り、自分の情報が取れる', async () => {
    const u = await S.user('Alice');
    assert.ok(u.token);
    assert.match(u.userIdCode, /^U[A-Z0-9]+$/);
    const me = await u.call('GET', '/api/friends/me');
    assert.equal(me.status, 200);
  });

  test('間違ったパスワードではログインできない', async () => {
    const u = await S.user('Bob');
    const bad = await S.req('POST', '/api/auth/login', { body: { username: u.username, password: 'wrong-password-123' } });
    assert.notEqual(bad.status, 200);
    assert.ok(!bad.data || !bad.data.token);
    const ok = await S.req('POST', '/api/auth/login', { body: { username: u.username, password: u.password } });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.token);
  });

  test('トークン無し・偽トークンでは弾かれる', async () => {
    assert.equal((await S.req('GET', '/api/friends/list')).status, 401);
    const r = await S.req('GET', '/api/friends/list', { token: 'eyJhbGciOiJIUzI1NiJ9.e30.xxxx' });
    assert.ok(r.status === 401 || r.status === 403);
  });
});

describe('友だち・DM', () => {
  test('友だちでない相手にはDMを送れない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    const r = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'hi' });
    assert.equal(r.status, 403);
  });

  test('友だちになれば送れて、相手の履歴に出る', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const r = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'hello' });
    assert.equal(r.status, 200);
    const h = await b.call('GET', '/api/messages/history/' + a.userId);
    assert.ok(h.data.some(m => m.content === 'hello'));
  });

  test('他人同士の友だち申請を第三者が承認できない', async () => {
    const a = await S.user('A'); const b = await S.user('B'); const c = await S.user('C');
    await a.call('POST', '/api/friends/request', { targetUserIdCode: b.userIdCode });
    const pend = await b.call('GET', '/api/friends/pending');
    const r = await c.call('POST', '/api/friends/accept', { friendshipId: pend.data[0].friendshipId });
    assert.equal(r.status, 403);
  });

  test('他人のメッセージは編集・取り消しできない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const sent = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'mine' });
    const id = sent.data.message.id;
    assert.equal((await b.call('POST', '/api/messages/edit', { messageId: id, content: 'x' })).status, 403);
    assert.equal((await b.call('POST', '/api/messages/delete', { messageId: id })).status, 403);
  });
});

describe('ブロック', () => {
  test('ブロックした側は送れない(403, blockedByMe)', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    assert.equal((await b.call('POST', '/api/friends/block', { userId: a.userId })).status, 200);
    const r = await b.call('POST', '/api/messages/send', { recipientId: a.userId, content: 'x' });
    assert.equal(r.status, 403);
    assert.equal(r.data.blockedByMe, true);
  });

  test('ブロックされた側は送れたように見えるが、相手には届かない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    const r = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'secret-1' });
    assert.equal(r.status, 200, 'ブロックされたことが分からないよう、成功に見える');
    // 送った本人には見える
    const ha = await a.call('GET', '/api/messages/history/' + b.userId);
    assert.ok(ha.data.some(m => m.content === 'secret-1'));
    // ブロックした人には見えない(履歴・トーク一覧・未読数)
    const hb = await b.call('GET', '/api/messages/history/' + a.userId);
    assert.ok(!hb.data.some(m => m.content === 'secret-1'));
    const talks = await b.call('GET', '/api/messages/talks');
    assert.ok(!talks.data.some(t => t.userId === a.userId));
    // 解除しても、ブロック中に届いた分は出ない(LINEと同じ)
    await b.call('POST', '/api/friends/unblock', { userId: a.userId });
    const hb2 = await b.call('GET', '/api/messages/history/' + a.userId);
    assert.ok(!hb2.data.some(m => m.content === 'secret-1'));
    // 解除後に送った分は届く
    await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'after' });
    const hb3 = await b.call('GET', '/api/messages/history/' + a.userId);
    assert.ok(hb3.data.some(m => m.content === 'after'));
  });

  test('ブロックした人は届かなかったメッセージにピン・リアクションできない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    const r = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'hidden' });
    const id = r.data.message.id;
    assert.equal((await b.call('POST', '/api/messages/pin', { messageId: id, pinned: true })).status, 404);
    assert.equal((await b.call('POST', '/api/messages/react', { messageId: id, emoji: 'x' })).status, 404);
  });

  test('ブロック状態: 自分がしたかどうかだけ分かり、されたかどうかは分からない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    assert.equal((await b.call('GET', '/api/friends/block-status/' + a.userId)).data.blocked, true);
    assert.equal((await a.call('GET', '/api/friends/block-status/' + b.userId)).data.blocked, false);
  });

  test('ブロックされた人からは検索で見えず、友だち申請は「見つからない」', async () => {
    const a = await S.user('A'); const b = await S.user('Bobby' + Date.now());
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    const s = await a.call('GET', '/api/friends/search?q=' + encodeURIComponent(b.userIdCode));
    assert.ok(!s.data.some(u => u.userId === b.userId));
    const r = await a.call('POST', '/api/friends/request', { targetUserIdCode: b.userIdCode });
    assert.equal(r.status, 404);
  });

  test('ブロックした相手は友だち一覧から消え、ブロック一覧に出る', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    const list = await b.call('GET', '/api/friends/list');
    assert.ok(!list.data.some(f => f.userId === a.userId));
    const blocks = await b.call('GET', '/api/friends/blocks');
    assert.ok(blocks.data.some(u => u.userId === a.userId));
  });

  test('自分自身・存在しない人はブロックできない', async () => {
    const a = await S.user('A');
    assert.equal((await a.call('POST', '/api/friends/block', { userId: a.userId })).status, 400);
    assert.equal((await a.call('POST', '/api/friends/block', { userId: '00000000-0000-0000-0000-000000000000' })).status, 404);
  });

  test('ブロックされた人からの電話は「繋がらない」になる', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const wa = await S.connect(a); const wb = await S.connect(b);
    try {
      // ブロック前は着信が届く
      wa.send({ type: 'call_offer', recipientId: b.userId, callId: 'c1' + Date.now(), sdp: { type: 'offer', sdp: 'v=0' } });
      await sleep(400);
      assert.ok(wb.msgs.some(m => m.type === 'call_offer'), 'ブロック前は着信が届く');
      await b.call('POST', '/api/friends/block', { userId: a.userId });
      wb.msgs.length = 0;
      const cid = 'c2' + Date.now();
      wa.send({ type: 'call_offer', recipientId: b.userId, callId: cid, sdp: { type: 'offer', sdp: 'v=0' } });
      await sleep(400);
      assert.ok(!wb.msgs.some(m => m.type === 'call_offer'), 'ブロック後は着信が届かない');
      // すぐ「繋がらない」にするとブロックがバレるので、オフラインの時と同じく「呼び出し中」になる
      assert.ok(wa.msgs.some(m => m.type === 'call_waiting' && m.callId === cid), '呼び出し中に見える');
      assert.ok(!wa.msgs.some(m => m.type === 'call_unavailable' && m.callId === cid), 'すぐには切れない');
      wa.send({ type: 'call_end', callId: cid, recipientId: b.userId });
    } finally { wa.close(); wb.close(); }
  });
});

describe('ブロック(抜け道)', () => {
  test('ブロックされた人が禁止語を送っても、相手のトークに通知は出ない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'you fuck', encrypted: false });
    const h = await b.call('GET', '/api/messages/history/' + a.userId);
    assert.ok(!h.data.some(m => m.senderId === a.userId), JSON.stringify(h.data));
  });

  test('ブロックしても、同じグループの人の身元鍵は取れる(グループの暗号が壊れない)', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    await a.call('POST', '/api/groups/create', { name: 'G', memberIds: [b.userId] });
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    assert.notEqual((await a.call('GET', '/api/prekeys/identity/' + b.userId)).status, 403);
    assert.notEqual((await b.call('GET', '/api/prekeys/identity/' + a.userId)).status, 403);
  });

  test('ブロックされた人は、相手をグループに入れたり招待したりできない', async () => {
    const a = await S.user('A'); const b = await S.user('B'); const c = await S.user('C');
    await S.befriend(a, b); await S.befriend(a, c);
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    const g = await a.call('POST', '/api/groups/create', { name: 'G', memberIds: [b.userId, c.userId] });
    assert.ok(!g.data.members.includes(b.userId));
    assert.ok(g.data.members.includes(c.userId));
    const inv = await a.call('POST', '/api/groups/invite', { groupId: g.data.groupId, targetUserId: b.userId });
    assert.equal(inv.status, 404);
  });

  test('ブロックされた人の編集・リアクションは相手に届かず、ピン留めは相手に残らない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const old = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'before block' });
    const bMsg = await b.call('POST', '/api/messages/send', { recipientId: a.userId, content: 'from b' });
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    const wb = await S.connect(b);
    try {
      await a.call('POST', '/api/messages/edit', { messageId: old.data.message.id, content: 'edited after block' });
      await a.call('POST', '/api/messages/react', { messageId: bMsg.data.message.id, emoji: 'x' });
      const pin = await a.call('POST', '/api/messages/pin', { messageId: bMsg.data.message.id, pinned: true });
      assert.equal(pin.status, 200, 'ピン留めした本人には成功に見える');
      await sleep(400);
      assert.ok(!wb.msgs.some(m => m.type === 'message_edited' || m.type === 'message_reaction' || m.type === 'message_pinned'), JSON.stringify(wb.msgs.map(m => m.type)));
      const pinned = await b.call('GET', '/api/messages/pinned/' + a.userId);
      const list = Array.isArray(pinned.data) ? pinned.data : (pinned.data && pinned.data.messages) || [];
      assert.ok(!list.some(m => m.id === bMsg.data.message.id));
    } finally { wb.close(); }
  });

  test('ブロックした瞬間、相手の画面のオンライン表示が消える', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const wa = await S.connect(a);
    try {
      await b.call('POST', '/api/friends/block', { userId: a.userId });
      await sleep(300);
      assert.ok(wa.msgs.some(m => m.type === 'presence_update' && m.userId === b.userId && m.online === false));
    } finally { wa.close(); }
  });
});

describe('運営用(staff)', () => {
  test('普通のユーザーには存在しない扱い(404)', async () => {
    const a = await S.user('A');
    assert.equal((await a.call('GET', '/api/staff/me')).data.staff, false);
    assert.equal((await a.call('GET', '/api/staff/online')).status, 404);
  });

  test('STAFF_USERS のIDコードのアカウントだけオンライン一覧を見られ、同じ名前で登録しても運営にはなれない', async () => {
    // 1回目: アカウントを作る → 2回目: そのIDコードを運営にして同じDBで再起動
    const S1 = await startServer();
    const staff = await S1.user('Staff');
    await S1.stop(true);
    const S2 = await startServer({ STAFF_USERS: staff.userIdCode }, { dbFile: S1.dbFile });
    try {
      const login = await S2.req('POST', '/api/auth/login', { ip: staff.ip, body: { username: staff.username, password: staff.password } });
      assert.equal(login.status, 200);
      const tok = login.data.token;
      const other = await S2.user('Online');
      const w = await S2.connect(other);
      try {
        assert.equal((await S2.req('GET', '/api/staff/me', { token: tok, ip: staff.ip })).data.staff, true);
        const on = await S2.req('GET', '/api/staff/online', { token: tok, ip: staff.ip });
        assert.equal(on.status, 200);
        assert.ok(on.data.users.some(u => u.userId === other.userId));
        const all = await S2.req('GET', '/api/staff/users', { token: tok, ip: staff.ip });
        assert.equal(all.status, 200);
        assert.ok(all.data.users.some(u => u.userId === other.userId && u.online));
        assert.ok(!JSON.stringify(all.data).includes('@example.com'), 'メールアドレスは出さない');
      } finally { w.close(); }
      // 運営のIDコードと同じユーザー名で登録した人は運営ではない
      const ip = '10.251.0.9';
      const fake = await S2.req('POST', '/api/auth/register', { ip, body: { username: staff.userIdCode, password: 'Vq8!mZfakexL2q', displayName: 'Fake', realName: '偽 太郎' } });
      if (fake.status === 200) {
        assert.equal((await S2.req('GET', '/api/staff/me', { token: fake.data.token, ip })).data.staff, false);
        assert.equal((await S2.req('GET', '/api/staff/online', { token: fake.data.token, ip })).status, 404);
      }
    } finally { await S2.stop(); }
  });
});

describe('通報・管理API', () => {
  test('通報は5文字以上必要、正しければ受け付ける', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    assert.equal((await a.call('POST', '/api/reports', { kind: 'user', targetUserId: b.userId, category: 'spam', message: 'x' })).status, 400);
    assert.equal((await a.call('POST', '/api/reports', { kind: 'user', targetUserId: b.userId, category: 'spam', message: 'しつこく送ってくる' })).status, 200);
    assert.equal((await a.call('POST', '/api/reports', { kind: 'user', targetUserId: a.userId, category: 'spam', message: '自分を通報してみる' })).status, 400);
  });

  test('管理API・Claude窓口は鍵が設定されていなければ存在しない扱い', async () => {
    assert.equal((await S.req('GET', '/api/admin/stats')).status, 404);
    assert.equal((await S.req('GET', '/api/claude-feed/bugs')).status, 404);
  });
});
