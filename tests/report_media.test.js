const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

test('バグ報告に画像・動画を付けられる(Cloudinaryの正規URLだけ・3つまで)', async () => {
  const a = await S.user('RpMedia');
  const ok = await a.call('POST', '/api/reports', { kind: 'bug', message: '画面が崩れます再現あり', mediaUrls: ['https://res.cloudinary.com/a6rxinoz/image/upload/v1/brochat/reports/x.png', 'https://res.cloudinary.com/a6rxinoz/video/upload/v1/brochat/reports/y.mp4'] });
  assert.equal(ok.status, 200);
  const bad = await a.call('POST', '/api/reports', { kind: 'bug', message: '画面が崩れます再現あり', mediaUrls: ['https://evil.example.com/a.png'] });
  assert.equal(bad.status, 400);
  const many = await a.call('POST', '/api/reports', { kind: 'bug', message: '画面が崩れます再現あり', mediaUrls: Array(4).fill('https://res.cloudinary.com/a6rxinoz/image/upload/v1/a.png') });
  assert.equal(many.status, 400);
  const none = await a.call('POST', '/api/reports', { kind: 'bug', message: '添付なしの報告です' });
  assert.equal(none.status, 200);
});

test('全ブロック一覧は運営以外には404、運営には誰が誰をか見える', async () => {
  const a = await S.user('AllBkA'); const b = await S.user('AllBkB');
  await S.befriend(a, b);
  assert.equal((await b.call('POST', '/api/friends/block', { userId: a.userId })).status, 200);
  assert.equal((await a.call('GET', '/api/staff/blocks')).status, 404);
  const S1 = await startServer();
  const staff = await S1.user('StaffAll'); const x = await S1.user('XBlk'); const y = await S1.user('YBlk');
  await S1.befriend(x, y);
  assert.equal((await x.call('POST', '/api/friends/block', { userId: y.userId })).status, 200);
  await S1.stop(true);
  const S2 = await startServer({ STAFF_USERS: staff.userIdCode }, { dbFile: S1.dbFile });
  try {
    const login = await S2.req('POST', '/api/auth/login', { ip: staff.ip, body: { username: staff.username, password: staff.password } });
    const r = await S2.req('GET', '/api/staff/blocks', { token: login.data.token, ip: staff.ip });
    assert.equal(r.status, 200);
    assert.equal(r.data.blocks.length, 1);
    assert.equal(r.data.blocks[0].blocker.userId, x.userId);
    assert.equal(r.data.blocks[0].blocked.userId, y.userId);
    assert.ok(!JSON.stringify(r.data).includes('@'));
  } finally { await S2.stop(); }
});
