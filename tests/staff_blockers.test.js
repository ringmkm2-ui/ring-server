const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

test('「自分をブロックした人」は運営以外には404(存在も見せない)', async () => {
  const a = await S.user('BkA'); const b = await S.user('BkB');
  await S.befriend(a, b);
  assert.equal((await b.call('POST', '/api/friends/block', { userId: a.userId })).status, 200);
  assert.equal((await a.call('GET', '/api/staff/blockers')).status, 404);
  assert.equal((await b.call('GET', '/api/staff/blockers')).status, 404);
});

test('運営アカウントは、自分をブロックした人だけを見られる(他人のブロックは見えない)', async () => {
  const S1 = await startServer();
  const staff = await S1.user('StaffBk');
  const x = await S1.user('Blocker'); const y = await S1.user('Other'); const z = await S1.user('Third');
  await S1.befriend(staff, x); await S1.befriend(staff, y); await S1.befriend(y, z);
  assert.equal((await x.call('POST', '/api/friends/block', { userId: staff.userId })).status, 200); // xが運営をブロック
  assert.equal((await z.call('POST', '/api/friends/block', { userId: y.userId })).status, 200);     // zがyをブロック(運営には無関係)
  await S1.stop(true);
  const S2 = await startServer({ STAFF_USERS: staff.userIdCode }, { dbFile: S1.dbFile });
  try {
    const login = await S2.req('POST', '/api/auth/login', { ip: staff.ip, body: { username: staff.username, password: staff.password } });
    assert.equal(login.status, 200);
    const r = await S2.req('GET', '/api/staff/blockers', { token: login.data.token, ip: staff.ip });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.users.map(u => u.userId), [x.userId]);
    assert.ok(!JSON.stringify(r.data).includes('@'), 'メールアドレスは出さない');
  } finally { await S2.stop(); }
});

test('既読を送らない設定は保存しても無視され、常に送る', async () => {
  const a = await S.user('RrA');
  await a.call('PUT', '/api/settings', { sendReadReceipts: false });
  const g = await a.call('GET', '/api/settings');
  assert.equal(g.status, 200);
  const v = g.data.settings || g.data;
  assert.equal(v.sendReadReceipts, true);
});
