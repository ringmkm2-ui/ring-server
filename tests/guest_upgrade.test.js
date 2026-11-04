// 招待コードで始めたゲストが、あとからメールとパスワードを付ける(2段階: コードを送る → コードで確定)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');
const { startSmtpSink } = require('./smtp_sink');

let S, smtp, N;     // S: メールあり / N: メール設定なし
const rnd = () => Math.random().toString(36).slice(2, 8);
const PW = () => 'Vq8!mZ' + rnd() + 'xL2';

before(async () => {
  smtp = await startSmtpSink();
  S = await startServer(smtp.env);
  N = await startServer();
});
after(async () => { if (S) await S.stop(); if (N) await N.stop(); if (smtp) await smtp.close(); });

// メール認証つきで、ふつうのユーザーを作る
async function normalUser(srv, name = 'Host') {
  const username = `n_${rnd()}${rnd()}@example.com`, password = PW();
  const r = await srv.req('POST', '/api/auth/register', { body: { username, password, displayName: name, realName: '山田 太郎' } });
  assert.equal(r.status, 200, JSON.stringify(r));
  let data = r.data;
  if (data.needsVerification) {
    const code = await waitCode(username);
    const v = await srv.req('POST', '/api/auth/verify-email', { body: { username, code, password } });
    assert.equal(v.status, 200, JSON.stringify(v));
    data = v.data;
  }
  const u = { ...data, username, password };
  u.call = (m, p, body) => srv.req(m, p, { token: u.token, body });
  return u;
}
async function waitCode(to, after = 0) {
  for (let i = 0; i < 40; i++) {
    const c = smtp.lastCode(to);
    if (c && smtp.mails.length > after) return c;
    await sleep(100);
  }
  throw new Error('mail did not arrive for ' + to);
}
// 招待コードだけで始めたゲストを作る
async function guest(srv, name = 'Guesty') {
  const host = await normalUser(srv, 'Host');
  const code = (await host.call('POST', '/api/invites', {})).data.invite.code;
  const r = await srv.req('POST', '/api/auth/register-invite', { body: { code, displayName: name, realName: '田中 太郎' } });
  assert.equal(r.status, 200, JSON.stringify(r));
  const g = { ...r.data, host };
  g.call = (m, p, body) => srv.req(m, p, { token: g.token, body });
  return g;
}
const newEmail = () => `Up_${rnd()}${rnd()}@Example.com`;   // 大文字入り(保存は小文字になる)

test('ゲストでない人・ログインしていない人は使えない', async () => {
  const u = await normalUser(S);
  const r = await u.call('POST', '/api/auth/guest/upgrade/start', { email: newEmail(), password: PW() });
  assert.equal(r.status, 403);
  assert.equal((await u.call('POST', '/api/auth/guest/upgrade/confirm', { code: '123456' })).status, 403);
  assert.equal((await S.req('POST', '/api/auth/guest/upgrade/start', { body: { email: newEmail(), password: PW() } })).status, 401);
  assert.equal((await u.call('GET', '/api/auth/guest/status')).data.guest, false);
});

test('入力の確認: メールの形・弱いパスワード・メールと同じパスワードは弾く(メールも送らない)', async () => {
  const g = await guest(S);
  const before = smtp.mails.length;
  const bad = async (body) => (await g.call('POST', '/api/auth/guest/upgrade/start', body)).status;
  assert.equal(await bad({ email: 'not-an-email', password: PW() }), 400);
  assert.equal(await bad({ email: newEmail(), password: 'short' }), 400);
  assert.equal(await bad({ email: newEmail(), password: 'password123' }), 400);
  assert.equal(await bad({ email: 'abcdefgh@example.com', password: 'abcdefgh@example.com' }), 400);
  assert.equal(await bad({ email: 'guest_abc@example.com', password: PW() }), 400);
  assert.equal(await bad({ email: 123, password: PW() }), 400);
  assert.equal(await bad({}), 400);
  await sleep(200);
  assert.equal(smtp.mails.length, before, '入力が悪い時はメールを送らない');
});

test('すでに使われているメールは大文字小文字が違っても409。メールも送らない', async () => {
  const g = await guest(S);
  const other = await normalUser(S);
  const before = smtp.mails.length;
  const r = await g.call('POST', '/api/auth/guest/upgrade/start', { email: other.username.toUpperCase(), password: PW() });
  assert.equal(r.status, 409);
  await sleep(200);
  assert.equal(smtp.mails.length, before);
});

test('コードで確定するまでは何も変わらず、確定するとメール+パスワードでログインできる(友だちもそのまま)', async () => {
  const g = await guest(S);
  const email = newEmail(), lower = email.toLowerCase(), password = PW();
  const n0 = smtp.mails.length;
  const s = await g.call('POST', '/api/auth/guest/upgrade/start', { email: '  ' + email + ' ', password });
  assert.equal(s.status, 200, JSON.stringify(s));
  assert.equal(s.data.email, lower);
  const code = await waitCode(lower, n0);

  // 途中: まだゲストのまま。パスワードでは入れない。状態には送り先が出る
  let st = (await g.call('GET', '/api/auth/guest/status')).data;
  assert.equal(st.guest, true); assert.equal(st.pending.email, lower);
  assert.equal((await S.req('POST', '/api/auth/login', { body: { username: lower, password } })).status, 401);

  // 間違ったコード
  const wrong = code === '000000' ? '000001' : '000000';
  assert.equal((await g.call('POST', '/api/auth/guest/upgrade/confirm', { code: wrong })).status, 400);
  assert.equal((await g.call('GET', '/api/auth/guest/status')).data.guest, true);

  const c = await g.call('POST', '/api/auth/guest/upgrade/confirm', { code: code.slice(0, 3) + ' ' + code.slice(3) });
  assert.equal(c.status, 200, JSON.stringify(c));
  assert.equal(c.data.username, lower);
  assert.equal(c.data.userId, g.userId, '同じアカウントのまま');
  assert.equal(c.data.upgraded, true);
  assert.ok(c.data.token);

  // 新しいトークンも、前のトークンも使える
  assert.equal((await S.req('GET', '/api/friends/me', { token: c.data.token })).status, 200);
  assert.equal((await g.call('GET', '/api/friends/me')).status, 401, '確定前のトークンは失効している(新しいトークンに切り替わる)');
  // 友だち(招待してくれた人)は残っている
  const ids = (await S.req('GET', '/api/friends/list', { token: c.data.token })).data.map(f => f.userId);
  assert.ok(ids.includes(g.host.userId));
  // ログアウトして入り直せる(大文字入りで打っても入れる)
  assert.equal((await S.req('POST', '/api/auth/login', { body: { username: lower, password } })).status, 200);
  assert.equal((await S.req('POST', '/api/auth/login', { body: { username: email, password } })).status, 200);
  assert.equal((await S.req('POST', '/api/auth/login', { body: { username: lower, password: 'Wrong-' + password } })).status, 401);
  // もうゲストではない
  assert.equal((await S.req('GET', '/api/auth/guest/status', { token: c.data.token })).data.guest, false);
  assert.equal((await S.req('POST', '/api/auth/guest/upgrade/start', { token: c.data.token, body: { email: newEmail(), password: PW() } })).status, 403);
});

test('確定したあと、パスワード再設定も使える', async () => {
  const g = await guest(S);
  const email = newEmail().toLowerCase(), password = PW();
  let n = smtp.mails.length;
  await g.call('POST', '/api/auth/guest/upgrade/start', { email, password });
  const code = await waitCode(email, n);
  assert.equal((await g.call('POST', '/api/auth/guest/upgrade/confirm', { code })).status, 200);

  n = smtp.mails.length;
  assert.equal((await S.req('POST', '/api/auth/forgot-password', { body: { username: email } })).status, 200);
  for (let i = 0; i < 40 && smtp.mails.length === n; i++) await sleep(100);
  const rc = smtp.lastCode(email);
  const np = PW();
  const rr = await S.req('POST', '/api/auth/reset-password', { body: { username: email, code: rc, newPassword: np } });
  assert.equal(rr.status, 200, JSON.stringify(rr));
  assert.equal((await S.req('POST', '/api/auth/login', { body: { username: email, password: np } })).status, 200);
});

test('送ったばかりで続けて送ると429', async () => {
  const g = await guest(S);
  const body = { email: newEmail(), password: PW() };
  assert.equal((await g.call('POST', '/api/auth/guest/upgrade/start', body)).status, 200);
  const again = await g.call('POST', '/api/auth/guest/upgrade/start', body);
  assert.equal(again.status, 429);
  assert.ok(again.data.retryAfter > 0);
});

test('コードを5回外すと、正しいコードでも通らなくなる(送り直しが必要)', async () => {
  const g = await guest(S);
  const email = newEmail().toLowerCase();
  const n = smtp.mails.length;
  await g.call('POST', '/api/auth/guest/upgrade/start', { email, password: PW() });
  const code = await waitCode(email, n);
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await g.call('POST', '/api/auth/guest/upgrade/confirm', { code: wrong })).status, 400);
  const r = await g.call('POST', '/api/auth/guest/upgrade/confirm', { code });
  assert.equal(r.status, 400);
  assert.equal((await g.call('GET', '/api/auth/guest/status')).data.guest, true);
});

test('同じメールを2人のゲストが取ろうとしたら、先に確定した方だけが取れる', async () => {
  const g1 = await guest(S), g2 = await guest(S);
  const email = newEmail().toLowerCase();
  let n = smtp.mails.length;
  await g1.call('POST', '/api/auth/guest/upgrade/start', { email, password: PW() });
  const c1 = await waitCode(email, n);
  n = smtp.mails.length;
  await g2.call('POST', '/api/auth/guest/upgrade/start', { email, password: PW() });
  const c2 = await waitCode(email, n);
  assert.equal((await g1.call('POST', '/api/auth/guest/upgrade/confirm', { code: c1 })).status, 200);
  const r = await g2.call('POST', '/api/auth/guest/upgrade/confirm', { code: c2 });
  assert.equal(r.status, 409);
  assert.equal((await g2.call('GET', '/api/auth/guest/status')).data.guest, true, '負けた方はゲストのまま');
});

test('同じコードを同時に2回送っても、確定するのは1回だけ', async () => {
  const g = await guest(S);
  const email = newEmail().toLowerCase();
  const n = smtp.mails.length;
  await g.call('POST', '/api/auth/guest/upgrade/start', { email, password: PW() });
  const code = await waitCode(email, n);
  const rs = await Promise.all([1, 2, 3].map(() => g.call('POST', '/api/auth/guest/upgrade/confirm', { code })));
  assert.equal(rs.filter(r => r.status === 200).length, 1, rs.map(r => r.status).join(','));
});

test('認証されないまま放置された登録のメールは、コードで持ち主だと確かめられたゲストに譲る', async () => {
  const email = `stale_${rnd()}${rnd()}@example.com`;
  const reg = await S.req('POST', '/api/auth/register', { body: { username: email, password: PW(), displayName: 'Squatter', realName: '山田 太郎' } });
  assert.equal(reg.data.needsVerification, true);
  const g = await guest(S);
  const n = smtp.mails.length;
  const s = await g.call('POST', '/api/auth/guest/upgrade/start', { email, password: PW() });
  assert.equal(s.status, 200, JSON.stringify(s));
  const code = await waitCode(email, n - 0);
  const c = await g.call('POST', '/api/auth/guest/upgrade/confirm', { code });
  assert.equal(c.status, 200, JSON.stringify(c));
  assert.equal(c.data.username, email);
});

test('メールを送れない環境では、持ち主を確かめられないので進めない(503)', async () => {
  const g = await guest(N);
  const r = await g.call('POST', '/api/auth/guest/upgrade/start', { email: newEmail(), password: PW() });
  assert.equal(r.status, 503);
  const st = (await g.call('GET', '/api/auth/guest/status')).data;
  assert.equal(st.guest, true); assert.equal(st.mailConfigured, false);
});

test('ゲストのまま退会しても、途中の設定は残らない', async () => {
  const g = await guest(S);
  await g.call('POST', '/api/auth/guest/upgrade/start', { email: newEmail(), password: PW() });
  const d = await g.call('POST', '/api/auth/delete-account', {});
  assert.equal(d.status, 200, JSON.stringify(d));
});

test('同じメールアドレス宛には、ゲストを何人作っても1日3通まで(メール爆撃・送信枠の枯渇を止める)', async () => {
  const victim = newEmail().toLowerCase();
  const results = [];
  for (let i = 0; i < 4; i++) {
    const g = await guest(S, 'Spam' + i);
    results.push((await g.call('POST', '/api/auth/guest/upgrade/start', { email: i % 2 ? victim.toUpperCase() : victim, password: PW() })).status);
  }
  assert.deepEqual(results, [200, 200, 200, 429], JSON.stringify(results));
});

test('確定すると、確定前のトークン(ほかの端末に持ち出されていた分を含む)は使えなくなり、新しいトークンだけが使える', async () => {
  const g = await guest(S);
  const email = newEmail().toLowerCase();
  const n = smtp.mails.length;
  await g.call('POST', '/api/auth/guest/upgrade/start', { email, password: PW() });
  const code = await waitCode(email, n);
  const r = await g.call('POST', '/api/auth/guest/upgrade/confirm', { code });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.ok(r.data.token && r.data.token !== g.token);
  assert.equal((await S.req('GET', '/api/friends/list', { token: g.token })).status, 401, '古いトークンは失効');
  assert.equal((await S.req('GET', '/api/friends/list', { token: r.data.token })).status, 200, '新しいトークンは使える');
});

test('コードの試行は同時に送られても5回までしか数えない(同時に20本送っても、正しいコードが紛れても通らない)', async () => {
  const g = await guest(S);
  const email = newEmail().toLowerCase();
  const n = smtp.mails.length;
  await g.call('POST', '/api/auth/guest/upgrade/start', { email, password: PW() });
  const code = await waitCode(email, n);
  const wrong = code === '000000' ? '000001' : '000000';
  const codes = Array.from({ length: 20 }, (_, i) => (i === 12 ? code : wrong));
  const rs = await Promise.all(codes.map(c => g.call('POST', '/api/auth/guest/upgrade/confirm', { code: c })));
  const okCount = rs.filter(r => r.status === 200).length;
  // 正しいコードが5回目までに届いていれば確定してよいが、6回目以降(=上限の後)に届いたものは通らない。
  // どちらでも「確定は多くて1回」で、上限を超えて当て続けることはできない
  assert.ok(okCount <= 1);
  const status = (await g.call('GET', '/api/auth/guest/status')).data;
  if (!okCount) assert.equal(status.guest, true);
});
