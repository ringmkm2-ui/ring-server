const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startServer, sleep } = require('./helpers');
const { startSmtpSink } = require('./smtp_sink');

let S, smtp;
const rnd = () => Math.random().toString(36).slice(2, 8);
const PW = () => 'Vq8!mZ' + rnd() + 'xL2';
before(async () => { smtp = await startSmtpSink(); S = await startServer(smtp.env); });
after(async () => { if (S) await S.stop(); if (smtp) await smtp.close(); });

async function waitCode(to, after = 0) {
  for (let i = 0; i < 50; i++) { const c = smtp.lastCode(to); if (c && smtp.mails.length > after) return c; await sleep(100); }
  throw new Error('mail did not arrive for ' + to);
}
async function normalUser(name = 'Host') {
  const username = `n_${rnd()}${rnd()}@example.com`, password = PW();
  const r = await S.req('POST', '/api/auth/register', { body: { username, password, displayName: name, realName: '山田 太郎' } });
  let data = r.data;
  if (data.needsVerification) {
    const code = await waitCode(username);
    data = (await S.req('POST', '/api/auth/verify-email', { body: { username, code, password } })).data;
  }
  const u = { ...data, username, password };
  u.call = (m, p, body) => S.req(m, p, { token: u.token, body });
  return u;
}
async function guest(host) {
  host = host || await normalUser('Host');
  const code = (await host.call('POST', '/api/invites', {})).data.invite.code;
  const r = await S.req('POST', '/api/auth/register-invite', { body: { code, displayName: 'Guesty', realName: '田中 太郎' } });
  assert.equal(r.status, 200, JSON.stringify(r));
  const g = { ...r.data, host };
  g.call = (m, p, body) => S.req(m, p, { token: g.token, body });
  return g;
}
async function upgrade(g, email, password) {
  const n = smtp.mails.length;
  const s = await g.call('POST', '/api/auth/guest/upgrade/start', { email, password });
  assert.equal(s.status, 200, JSON.stringify(s));
  const code = await waitCode(s.data.email, n);
  const c = await g.call('POST', '/api/auth/guest/upgrade/confirm', { code });
  assert.equal(c.status, 200, JSON.stringify(c));
  return c.data;
}

test('QB1: 確認メールの同時送信で「1分に1回・1日10通」を回避できる', async () => {
  const g = await guest();
  const n0 = smtp.mails.length;
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    g.call('POST', '/api/auth/guest/upgrade/start', { email: `victim${i}_${rnd()}@example.com`, password: PW() })));
  await sleep(1500);
  const ok = rs.filter(r => r.status === 200).length;
  assert.ok(ok <= 1, `並列12本で 200 が ${ok} 件、実際に出たメール ${smtp.mails.length - n0} 通`);
});

test('QB2: 同じコードの同時confirm / 別メールの同時confirmで壊れない', async () => {
  const g = await guest();
  const email = `QB2_${rnd()}@Example.com`;
  const n = smtp.mails.length;
  await g.call('POST', '/api/auth/guest/upgrade/start', { email, password: PW() });
  const code = await waitCode(email.toLowerCase(), n);
  const rs = await Promise.all(Array.from({ length: 6 }, () => g.call('POST', '/api/auth/guest/upgrade/confirm', { code })));
  assert.equal(rs.filter(r => r.status === 200).length, 1, JSON.stringify(rs.map(r => r.status)));
  assert.ok(rs.every(r => [200, 403, 400, 401].includes(r.status)), JSON.stringify(rs.map(r => r.status)));
  const st = (await S.req('GET', '/api/auth/guest/status', { token: rs.find(r => r.status === 200).data.token })).data;
  assert.equal(st.guest, false);
});

test('QB3: 2人のゲストが同じメールを同時にconfirm', async () => {
  const gs = [await guest(), await guest()];
  const email = `qb3_${rnd()}@example.com`;
  for (const g of gs) {
    const n = smtp.mails.length;
    const s = await g.call('POST', '/api/auth/guest/upgrade/start', { email, password: PW() });
    assert.equal(s.status, 200);
    g.code = await waitCode(email, n);
  }
  const rs = await Promise.all(gs.map(g => g.call('POST', '/api/auth/guest/upgrade/confirm', { code: g.code })));
  const st = rs.map(r => r.status).sort();
  assert.deepEqual(st, [200, 409], JSON.stringify(rs));
});

test('QB4: ゲストで大文字入りのメールにした後、同じ大文字入りでパスワード再設定できる', async () => {
  const g = await guest();
  const email = `QB4_${rnd()}@Example.com`;
  await upgrade(g, email, PW());
  const n = smtp.mails.length;
  assert.equal((await S.req('POST', '/api/auth/forgot-password', { body: { username: email } })).status, 200);
  await sleep(1500);
  assert.ok(smtp.mails.length > n, '大文字入りで打ったのに再設定メールが来ない');
});

test('QB5: メールアドレスをresetパスワードAPIに大文字入りで渡す', async () => {
  const g = await guest();
  const email = `QB5_${rnd()}@Example.com`;
  await upgrade(g, email, PW());
  const lower = email.toLowerCase();
  const n = smtp.mails.length;
  await S.req('POST', '/api/auth/forgot-password', { body: { username: lower } });
  const code = await waitCode(lower, n);
  const r = await S.req('POST', '/api/auth/reset-password', { body: { username: email, code, newPassword: PW() } });
  assert.equal(r.status, 200, '大文字入りのusernameで reset-password: ' + JSON.stringify(r));
});

test('QB6: ゲストの退会/トークン失効と途中状態', async () => {
  const g = await guest();
  const n = smtp.mails.length;
  const email = `qb6_${rnd()}@example.com`;
  await g.call('POST', '/api/auth/guest/upgrade/start', { email, password: PW() });
  const code = await waitCode(email, n);
  // 全端末ログアウト後は confirm できない(401)。ゲストは二度と入れない(仕様)
  assert.equal((await g.call('POST', '/api/auth/revoke-all-sessions', {})).status, 200);
  assert.equal((await g.call('POST', '/api/auth/guest/upgrade/confirm', { code })).status, 401);
  assert.equal((await S.req('POST', '/api/auth/login', { body: { username: email, password: 'x' + PW() } })).status, 401);
});

test('QB9: deleted_ で始まるメールに変えると、招待コードが無効になる', async () => {
  const g = await guest();
  const code = (await g.call('POST', '/api/invites', {})).data.invite.code;
  const s = await g.call('POST', '/api/auth/guest/upgrade/start', { email: `deleted_${rnd()}@example.com`, password: PW() });
  // 修正前は 200 で進み、確定すると退会済みと同じ見た目になって招待コードが使えなくなる
  assert.equal(s.status, 400, 'start status=' + s.status);
});

test('QB11: 本体以外の入力(配列・オブジェクト・巨大)', async () => {
  const g = await guest();
  for (const b of [{ email: ['a@b.co'], password: PW() }, { email: { a: 1 }, password: PW() }, { email: 'a@b.co', password: ['x'] }, { email: 'a'.repeat(5000) + '@b.co', password: PW() }, [], { email: 'a@b.co', password: 'x'.repeat(100000) }]) {
    const r = await g.call('POST', '/api/auth/guest/upgrade/start', b);
    assert.ok([400, 429].includes(r.status), JSON.stringify(b).slice(0, 50) + ' => ' + r.status);
  }
  for (const b of [{ code: ['123456'] }, { code: 123456 }, {}, [], { code: 'x'.repeat(100000) }]) {
    const r = await g.call('POST', '/api/auth/guest/upgrade/confirm', b);
    assert.ok([400, 429].includes(r.status), JSON.stringify(b).slice(0, 50) + ' => ' + r.status);
  }
  assert.equal((await S.req('GET', '/api/auth/guest/upgrade/start', { token: g.token })).status, 404);
});

test('QB12: 教室(同じIP)で22人のゲストが同じ日にメールを設定しようとすると、後ろの人が止まる', async () => {
  const gs = [];
  for (let i = 0; i < 22; i++) gs.push(await guest());
  const classroomIp = '10.77.0.1';
  const rs = [];
  for (const g of gs) {
    rs.push(await S.req('POST', '/api/auth/guest/upgrade/start', { token: g.token, ip: classroomIp, body: { email: `class_${rnd()}${rnd()}@example.com`, password: PW() } }));
  }
  const blocked = rs.filter(r => r.status === 429).length;
  assert.equal(blocked, 0, `同じIPの22人中 ${blocked} 人が 429`);
});
