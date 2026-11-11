// 鍵バックアップの合言葉(routes/friends.js): トークンだけでは中身を取れない・書き換えられない・総当たりできない
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

const acc = () => crypto.randomBytes(32).toString('base64');
const blob = 'bk2.-.-.' + crypto.randomBytes(16).toString('base64') + '.wrap.sealed.-.-';
async function req(u, method, path, body, access) {
  const res = await fetch(S.base + path, { method, headers: { Authorization: 'Bearer ' + u.token, 'Content-Type': 'application/json', ...(access ? { 'x-backup-access': access } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('合言葉付きの行は、合言葉なしでは中身を渡さず、書き換えもできない', async () => {
  const A = await S.user('KB1');
  const pass = acc();
  assert.equal((await req(A, 'PUT', '/api/friends/key-backup', { blob, newAccess: { pass } })).status, 200);
  const head = await req(A, 'GET', '/api/friends/key-backup');
  assert.equal(head.data.protected, true);
  assert.ok(head.data.psalt);
  assert.equal(head.data.blob, undefined);
  const noAcc = await req(A, 'GET', '/api/friends/key-backup?full=1');
  assert.equal(noAcc.status, 403); assert.equal(noAcc.data.blob, undefined);
  const ok = await req(A, 'GET', '/api/friends/key-backup?full=1', null, pass);
  assert.equal(ok.status, 200); assert.equal(ok.data.blob, blob);
  const over = await req(A, 'PUT', '/api/friends/key-backup', { blob: blob + 'x', newAccess: { pass: acc() } });
  assert.equal(over.status, 403);
  const over2 = await req(A, 'PUT', '/api/friends/key-backup', { blob: blob + 'x', newAccess: { pass: acc() } }, acc());
  assert.equal(over2.status, 403);
  assert.equal((await req(A, 'GET', '/api/friends/key-backup?full=1', null, pass)).data.blob, blob);
});

test('間違いは1日10回まで(正しい合言葉でも止まる)', async () => {
  const A = await S.user('KB2');
  const pass = acc();
  await req(A, 'PUT', '/api/friends/key-backup', { blob, newAccess: { pass } });
  for (let i = 0; i < 10; i++) assert.equal((await req(A, 'GET', '/api/friends/key-backup?full=1', null, acc())).status, 403);
  const locked = await req(A, 'GET', '/api/friends/key-backup?full=1', null, pass);
  assert.equal(locked.status, 429);
});

test('合言葉の無い古いバックアップは今まで通り取れて、合言葉を付けて預け直せる', async () => {
  const A = await S.user('KB3');
  assert.equal((await req(A, 'PUT', '/api/friends/key-backup', { blob })).status, 200);
  assert.equal((await req(A, 'GET', '/api/friends/key-backup?full=1')).data.blob, blob);
  const pass = acc();
  assert.equal((await req(A, 'PUT', '/api/friends/key-backup', { blob, newAccess: { pass } })).status, 200);
  assert.equal((await req(A, 'GET', '/api/friends/key-backup?full=1')).status, 403);
});

test('回復コードの合言葉でも取り出せ、null で消せる', async () => {
  const A = await S.user('KB4');
  const pass = acc(), code = acc();
  await req(A, 'PUT', '/api/friends/key-backup', { blob, newAccess: { pass, code } });
  assert.equal((await req(A, 'GET', '/api/friends/key-backup?full=1', null, code)).status, 200);
  await req(A, 'PUT', '/api/friends/key-backup', { blob, newAccess: { code: null } }, pass);
  assert.equal((await req(A, 'GET', '/api/friends/key-backup?full=1', null, code)).status, 403);
  assert.equal((await req(A, 'GET', '/api/friends/key-backup?full=1', null, pass)).status, 200);
});
