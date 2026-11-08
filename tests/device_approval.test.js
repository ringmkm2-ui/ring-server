// 新しい端末の承認。パスワード(トークン)を盗まれても、攻撃者の端末の鍵に暗号文が届かないこと
process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nacl = require('../public/js/nacl.min.js');
const { startServer } = require('./helpers');
const b64 = u => Buffer.from(u).toString('base64');
const dec = s => new Uint8Array(Buffer.from(s, 'base64'));
let S, A, B, ipSeq = 10;
const dev = () => { const k = nacl.box.keyPair(); return { sk: k.secretKey, pk: b64(k.publicKey) }; };
const reg = async (u, d) => (await u.call('POST', '/api/friends/publickey', { publicKey: d.pk })).data;
const keysOf = async (me, other) => (await me.call('GET', '/api/friends/publickey/' + other.userId)).data.publicKeys;
async function prove(u, d) {
  const c = (await u.call('POST', '/api/devices/challenge', { publicKey: d.pk })).data;
  const ans = nacl.box.open(dec(c.box), dec(c.nonce), dec(c.serverPublicKey), d.sk);
  return { challengeId: c.id, answer: b64(ans) };
}
before(async () => {
  S = await startServer();
  A = await S.user('dev_a', '10.9.0.1'); B = await S.user('dev_b', '10.9.0.2');
  await S.befriend(A, B);
});
after(async () => { await S.stop(); });

test('1台目はそのまま有効。2台目は承認待ちで相手に配られない', async () => {
  const d1 = dev(); A.d1 = d1;
  const r1 = await reg(A, d1);
  assert.notEqual(r1.status, 'pending');
  assert.deepEqual(await keysOf(B, A), [d1.pk]);
  const thief = dev(); A.thief = thief;
  // 盗んだ人は別のログイン(別セッション)から鍵を登録する
  const lg = await S.req('POST', '/api/auth/login', { ip: A.ip, body: { username: A.username, password: A.password } });
  assert.ok(lg.data && lg.data.token, 'login');
  A.thiefCall = (m, p, b) => S.req(m, p, { token: lg.data.token, body: b, ip: A.ip });
  const r2 = (await A.thiefCall('POST', '/api/friends/publickey', { publicKey: thief.pk })).data;
  assert.equal(r2.status, 'pending');
  assert.match(r2.code, /^\d{3} \d{3}$/);
  assert.deepEqual(await keysOf(B, A), [d1.pk], '承認前の鍵は相手に渡らない');
});

test('プロフィール更新の経路でも承認を素通りできない', async () => {
  const x = dev();
  await A.call('POST', '/api/friends/profile', { publicKey: x.pk }).catch(() => {});
  const keys = await keysOf(B, A);
  assert.ok(!keys.includes(x.pk));
});

test('承認待ちの端末からは暗号文を送れない。有効な端末からは送れる', async () => {
  const body = pk => ({ recipientId: B.userId, content: `e3:${pk}:${'A'.repeat(44)}.abcd`, encrypted: true });
  const bad = await A.thiefCall('POST', '/api/messages/send', body(A.thief.pk));
  assert.equal(bad.status, 403);
  assert.equal(bad.data.code, 'DEVICE_PENDING');
  const ok = await A.call('POST', '/api/messages/send', body(A.d1.pk));
  assert.equal(ok.status, 200);
});

test('トークンだけでは許可できない。秘密鍵の証明が要る', async () => {
  // 証明なし
  let r = await A.call('POST', '/api/devices/approve', { publicKey: A.thief.pk });
  assert.equal(r.status, 403);
  // 承認待ちの鍵では挑戦を受けられない
  r = await A.call('POST', '/api/devices/challenge', { publicKey: A.thief.pk });
  assert.equal(r.status, 403);
  // 有効な鍵の挑戦に、秘密鍵なしででたらめに答える
  const c = (await A.call('POST', '/api/devices/challenge', { publicKey: A.d1.pk })).data;
  r = await A.call('POST', '/api/devices/approve', { publicKey: A.thief.pk, challengeId: c.id, answer: b64(nacl.randomBytes(32)) });
  assert.equal(r.status, 403);
  // 外した挑戦は使い回せない
  const real = nacl.box.open(dec(c.box), dec(c.nonce), dec(c.serverPublicKey), A.d1.sk);
  r = await A.call('POST', '/api/devices/approve', { publicKey: A.thief.pk, challengeId: c.id, answer: b64(real) });
  assert.equal(r.status, 403);
  // 他人の挑戦は使えない
  const c2 = (await A.call('POST', '/api/devices/challenge', { publicKey: A.d1.pk })).data;
  const ans2 = nacl.box.open(dec(c2.box), dec(c2.nonce), dec(c2.serverPublicKey), A.d1.sk);
  r = await B.call('POST', '/api/devices/approve', { publicKey: A.thief.pk, challengeId: c2.id, answer: b64(ans2) });
  assert.ok(r.status === 403);
  assert.deepEqual(await keysOf(B, A), [A.d1.pk]);
});

test('拒否すると消える', async () => {
  const pend = (await A.call('GET', '/api/devices/pending')).data.pending;
  assert.ok(pend.some(p => p.publicKey === A.thief.pk));
  const r = await A.call('POST', '/api/devices/reject', { publicKey: A.thief.pk, ...(await prove(A, A.d1)) });
  assert.equal(r.status, 200);
  assert.equal((await A.call('GET', '/api/devices/status?publicKey=' + encodeURIComponent(A.thief.pk))).data.status, 'unknown');
});

test('許可すると相手に配られ、相手へ通知が届く', async () => {
  const ws = await S.connect(B);
  const d2 = dev(); A.d2 = d2;
  assert.equal((await reg(A, d2)).status, 'pending');
  const r = await A.call('POST', '/api/devices/approve', { publicKey: d2.pk, ...(await prove(A, A.d1)) });
  assert.equal(r.status, 200);
  const keys = await keysOf(B, A);
  assert.ok(keys.includes(d2.pk) && keys.includes(A.d1.pk));
  for (let i = 0; i < 40 && !ws.msgs.some(m => m.type === 'peer_keys_changed' && m.userId === A.userId); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(ws.msgs.some(m => m.type === 'peer_keys_changed' && m.userId === A.userId));
  ws.close();
});

test('全端末ログアウトの後も、新しい鍵は承認なしで通らない。もとの鍵は戻せる', async () => {
  const C = await S.user('dev_c', '10.9.0.3');
  await S.befriend(C, B);
  const d1 = dev();
  await reg(C, d1);
  await C.call('POST', '/api/auth/revoke-all-sessions', {});
  const fresh = await S.req('POST', '/api/auth/login', { ip: '10.9.0.3', body: { username: C.username, password: C.password } });
  assert.ok(fresh.data.token, JSON.stringify(fresh.data));
  const call = (m, p, body) => S.req(m, p, { token: fresh.data.token, body, ip: '10.9.0.3' });
  const thief = dev();
  assert.equal((await call('POST', '/api/friends/publickey', { publicKey: thief.pk })).data.status, 'pending');
  assert.deepEqual(await keysOf(B, C), []);
  assert.notEqual((await call('POST', '/api/friends/publickey', { publicKey: d1.pk })).data.status, 'pending');
  assert.deepEqual(await keysOf(B, C), [d1.pk]);
});

test('端末を全部なくした人のために、待ち時間が過ぎれば本人の端末が開いた時に有効になる', async () => {
  const S2 = await startServer({ DEVICE_APPROVAL_WAIT_HOURS: '0.0002' }); // 約0.7秒
  try {
    const X = await S2.user('dev_x', '10.9.1.1'), Y = await S2.user('dev_y', '10.9.1.2');
    await S2.befriend(X, Y);
    const k1 = dev(), k2 = dev();
    await X.call('POST', '/api/friends/publickey', { publicKey: k1.pk });
    assert.equal((await X.call('POST', '/api/friends/publickey', { publicKey: k2.pk })).data.status, 'pending');
    await new Promise(r => setTimeout(r, 1000));
    assert.notEqual((await X.call('POST', '/api/friends/publickey', { publicKey: k2.pk })).data.status, 'pending');
    assert.ok((await Y.call('GET', '/api/friends/publickey/' + X.userId)).data.publicKeys.includes(k2.pk));
  } finally { await S2.stop(); }
});

test('DEVICE_APPROVAL=off なら従来どおり', async () => {
  const S3 = await startServer({ DEVICE_APPROVAL: 'off' });
  try {
    const X = await S3.user('dev_z', '10.9.2.1');
    await X.call('POST', '/api/friends/publickey', { publicKey: dev().pk });
    assert.notEqual((await X.call('POST', '/api/friends/publickey', { publicKey: dev().pk })).data.status, 'pending');
  } finally { await S3.stop(); }
});
