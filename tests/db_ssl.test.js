// 同じ箱に置いたPostgres(Oracle/VPSへ移す時)をSSL無しで繋げるかの判定。
// 以前は接続URLに 'localhost' の文字があるかだけを見ていたので、127.0.0.1 や
// UNIXソケットで書くと「The server does not support SSL connections」で起動できなかった。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localConnection } = require('../db/db.postgres');

test('同じ箱のDBはSSL無しと判定する', () => {
  for (const u of [
    'postgres://brochat@localhost:5432/brochat',
    'postgres://brochat@localhost/brochat',
    'postgres://brochat@127.0.0.1:5432/brochat',
    'postgres://brochat:pw@127.0.0.1:5433/brochat',
    'postgres://brochat@[::1]:5432/brochat',
    'postgres://brochat@db.localhost:5432/brochat',
    'postgres:///brochat?host=/var/run/postgresql',
    'postgres:///brochat?host=%2Fvar%2Frun%2Fpostgresql',
  ]) assert.equal(localConnection(u), true, u);
});

test('外のDBはSSLで繋ぐと判定する', () => {
  for (const u of [
    'postgres://u:p@ep-weathered-bread.ap-southeast-1.aws.neon.tech/brochat?sslmode=require',
    'postgres://u:p@dpg-xxxx.oregon-postgres.render.com/brochat',
    'postgres://u:p@10.0.0.5:5432/brochat',
    'postgres://u:p@192.168.1.20:5432/brochat',
  ]) assert.equal(localConnection(u), false, u);
});

test('sslmode=disable を付ければ明示的に切れる', () => {
  assert.equal(localConnection('postgres://u:p@10.0.0.5:5432/brochat?sslmode=disable'), true);
  assert.equal(localConnection('postgres://u:p@host/db?a=1&sslmode=disable'), true);
  // sslmode=require は切らない(disableの部分一致で誤判定しないこと)
  assert.equal(localConnection('postgres://u:p@host/db?sslmode=require'), false);
});

test('未設定や壊れた値で落ちない', () => {
  assert.equal(localConnection(undefined), false);
  assert.equal(localConnection(''), false);
  assert.equal(localConnection('これはURLではない'), false);
  assert.equal(localConnection('localhostと書いただけの壊れた値'), true);
});
