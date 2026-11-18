// FCM の中身を Google に読ませない(utils/fcmCrypto.js / utils/fcm.js)。
//  - 鍵を登録した端末(新しいAPK)には、data が {v,n,c} の暗号文だけになり、送信者名・暗号文・通話相手が平文で載らない
//  - 鍵の無い端末(古いAPK)には、今まで通り平文で届く
//  - 鍵の形式検証、改ざん検出、優先度・TTL が変わらないこと
//  - Android 側(PushCrypto.java)の JUnit と同じテストベクトルで一致すること
// 送信は fcm._setSenderForTest で差し替え、DB は一時 SQLite を使う。登録APIの検証だけは実サーバーを立てる。
process.env.NODE_ENV = 'test';
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brochat-fcmseal-'));
process.env.SQLITE_FILE = path.join(tmp, 'fs.sqlite');
delete process.env.DATABASE_URL;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/db');
const fcmCrypto = require('../utils/fcmCrypto');
let fcm;
const sent = [];
const KEY = crypto.randomBytes(32).toString('base64');

before(async () => {
  await db.initDB();
  fcm = require('../utils/fcm');
  fcm._setSenderForTest(async msg => { sent.push(msg); });
  await fcm.saveToken('u_new', 'tok-new-apk', KEY);
  await fcm.saveToken('u_old', 'tok-old-apk');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const SECRET = 'e2:SENDERPUB:RECIPPUB:CIPHERTEXTBASE64';
const dmExtra = () => ({ containsMessage: true, senderId: 'sender-user-0001', chatId: '', cipher: SECRET, senderPub: 'PUBKEY', senderPic: '/icons/alice' });

function onlyFor(token) { return sent.filter(m => m.token === token); }

test('鍵の形式: 32バイトの標準Base64だけを受け付ける', () => {
  assert.equal(fcmCrypto.isValidPushKey(KEY), true);
  assert.equal(fcmCrypto.isValidPushKey(crypto.randomBytes(16).toString('base64')), false); // 短い
  assert.equal(fcmCrypto.isValidPushKey(crypto.randomBytes(33).toString('base64')), false); // 長い
  assert.equal(fcmCrypto.isValidPushKey(crypto.randomBytes(32).toString('base64url')), false); // URL安全形式
  assert.equal(fcmCrypto.isValidPushKey(Buffer.alloc(32).toString('base64')), false); // 全部0
  assert.equal(fcmCrypto.isValidPushKey(''), false);
  assert.equal(fcmCrypto.isValidPushKey(null), false);
  assert.equal(fcmCrypto.isValidPushKey(123), false);
  assert.equal(fcmCrypto.isValidPushKey(KEY + ' '), false);
});

test('saveToken: 形の違う鍵は保存しない', async () => {
  await assert.rejects(() => fcm.saveToken('u_bad', 'tok-bad', 'AAAA'));
  assert.equal((await fcm.getTokenRows('u_bad')).length, 0);
});

test('メッセージ: 鍵付きの端末には暗号文だけ、送信者名・暗号文・公開鍵が平文で入らない', async () => {
  sent.length = 0;
  await fcm.sendMessageNotification('u_new', 'Alice (秘密グループ)', '[画像]', 'dm', dmExtra());
  const [m] = onlyFor('tok-new-apk');
  assert.ok(m, 'sent');
  assert.deepEqual(Object.keys(m.data).sort(), ['c', 'n', 'v']);
  assert.equal(m.data.v, '2');
  const raw = JSON.stringify(m);
  for (const s of ['Alice', '秘密グループ', 'CIPHERTEXT', 'PUBKEY', 'SENDERPUB', '/icons/alice', '"type"', '画像', 'sender-user-0001']) {
    assert.ok(!raw.includes(s), 'plaintext leaked: ' + s);
  }
  // 優先度・TTL は今まで通り
  assert.equal(m.android.priority, 'high');
  assert.equal(m.android.ttl, 24 * 3600 * 1000);
  // 端末側で開くと、今までと同じ data が出てくる
  const plain = fcmCrypto.openData(m.data, KEY);
  assert.equal(plain.type, 'message');
  assert.equal(plain.sender_name, 'Alice (秘密グループ)');
  assert.equal(plain.cipher, SECRET);
  assert.equal(plain.sender_pub, 'PUBKEY');
  assert.equal(plain.sender_id, 'sender-user-0001');
});

test('メッセージ: 鍵の無い端末(古いAPK)には従来通り平文', async () => {
  sent.length = 0;
  await fcm.sendMessageNotification('u_old', 'Alice', '[画像]', 'dm', dmExtra());
  const [m] = onlyFor('tok-old-apk');
  assert.equal(m.data.type, 'message');
  assert.equal(m.data.sender_name, 'Alice');
  assert.equal(m.data.cipher, SECRET);
  assert.equal(m.data.v, undefined);
});

test('着信: 鍵付きの端末は暗号化され、高優先度と TTL 30秒は落ちない', async () => {
  sent.length = 0;
  await fcm.sendCallNotification('u_new', 'caller1', 'Bob', '/icons/bob', 'call-xyz', true);
  const [m] = onlyFor('tok-new-apk');
  assert.deepEqual(Object.keys(m.data).sort(), ['c', 'n', 'v']);
  assert.equal(m.android.priority, 'high');
  assert.equal(m.android.ttl, 30000);
  const raw = JSON.stringify(m);
  // 短い文字列はBase64の中に偶然現れうるので、十分長いものだけを調べる
  for (const s of ['call-xyz', 'caller1', 'incoming_call']) assert.ok(!raw.includes(s), 'leaked ' + s);
  const plain = fcmCrypto.openData(m.data, KEY);
  assert.equal(plain.type, 'incoming_call');
  assert.equal(plain.caller_name, 'Bob');
  assert.equal(plain.call_id, 'call-xyz');
  assert.equal(plain.is_video, '1');
});

test('着信キャンセル: 鍵付きは暗号化、鍵無しは平文', async () => {
  sent.length = 0;
  await fcm.sendCallCancelled('u_new', 'call-xyz');
  await fcm.sendCallCancelled('u_old', 'call-xyz');
  const [a] = onlyFor('tok-new-apk');
  const [b] = onlyFor('tok-old-apk');
  assert.equal(a.android.priority, 'high');
  assert.equal(fcmCrypto.openData(a.data, KEY).type, 'call_cancelled');
  assert.ok(!JSON.stringify(a).includes('call-xyz'));
  assert.equal(b.data.type, 'call_cancelled');
  assert.equal(b.data.call_id, 'call-xyz');
});

test('Web側の登録(鍵なし)で上書きしても、保存済みの鍵は消えない', async () => {
  await fcm.saveToken('u_new', 'tok-new-apk'); // talklist.html の古い登録経路と同じ呼び方
  const rows = await fcm.getTokenRows('u_new');
  assert.equal(rows[0].push_key, KEY);
  // 鍵を作り直した時は新しい鍵に変わる
  const k2 = crypto.randomBytes(32).toString('base64');
  await fcm.saveToken('u_new', 'tok-new-apk', k2);
  assert.equal((await fcm.getTokenRows('u_new'))[0].push_key, k2);
  await fcm.saveToken('u_new', 'tok-new-apk', KEY);
});

test('同じトークンを別アカウントで登録し直すと、前のアカウントの行(と鍵)は消える', async () => {
  const k = crypto.randomBytes(32).toString('base64');
  await fcm.saveToken('u_a', 'tok-shared', k);
  await fcm.saveToken('u_b', 'tok-shared', k);
  assert.equal((await fcm.getTokenRows('u_a')).length, 0);
  assert.equal((await fcm.getTokenRows('u_b'))[0].push_key, k);
});

test('改ざん: 暗号文・nonce・鍵が違えば開けない', () => {
  const s = fcmCrypto.sealData({ type: 'message', sender_name: 'Alice' }, KEY);
  const bad = Buffer.from(s.c, 'base64'); bad[0] ^= 1;
  assert.throws(() => fcmCrypto.openData({ ...s, c: bad.toString('base64') }, KEY));
  const badN = Buffer.from(s.n, 'base64'); badN[0] ^= 1;
  assert.throws(() => fcmCrypto.openData({ ...s, n: badN.toString('base64') }, KEY));
  assert.throws(() => fcmCrypto.openData(s, crypto.randomBytes(32).toString('base64')));
  assert.throws(() => fcmCrypto.openData({ ...s, v: '3' }, KEY));
});

test('毎回 nonce が変わる(同じ中身でも暗号文が同じにならない)', () => {
  const d = { type: 'message', sender_name: 'Alice' };
  const a = fcmCrypto.sealData(d, KEY), b = fcmCrypto.sealData(d, KEY);
  assert.notEqual(a.n, b.n);
  assert.notEqual(a.c, b.c);
});

test('大きすぎる時は暗号文(本文)を落としてでも4KBに収め、平文には戻さない', () => {
  const big = { type: 'message', sender_name: 'Alice', content: 'x', cipher: 'A'.repeat(3000), sender_pub: 'P'.repeat(44), sender_avatar: '/icons/a' };
  const s = fcmCrypto.sealDataFitting(big, KEY);
  assert.ok(s.v.length + s.n.length + s.c.length < 4000);
  const p = fcmCrypto.openData(s, KEY);
  assert.equal(p.cipher, '');
  assert.equal(p.sender_name, 'Alice');
  // 小さい時はそのまま
  const small = { type: 'message', sender_name: 'Alice', cipher: 'abc' };
  assert.equal(fcmCrypto.openData(fcmCrypto.sealDataFitting(small, KEY), KEY).cipher, 'abc');
});

// Android 側 android/app/src/test/java/com/brochat/app/PushCryptoTest.java と同じ値。片方を変えたらもう片方も変える
test('テストベクトル(Android の PushCryptoTest と共通)', () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
  const nonce = Buffer.from(Array.from({ length: 12 }, (_, i) => 0xa0 + i));
  const data = { type: 'incoming_call', call_id: 'c-123', caller_name: '山田 太郎', caller_avatar: '', caller_id: 'u-9', is_video: '1' };
  const s = fcmCrypto.sealData(data, key, nonce);
  assert.equal(key, 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=');
  assert.equal(s.n, 'oKGio6Slpqeoqaqr');
  assert.equal(s.c, 'wvNJH43QeD5dZ8wInuhJ6jCI03g0BEKoBTi0kT4RsVET67urwuOCBw9a4vrHWiJCa+kepaH+3O9qATJBJaK3SEnmCQ0tpW7d+PMnmG6/iYCs6Xc/GYRwTOvQ6hiEpjnNYaxdNCXDYovRpHdUX0SVtb6kMBO0v/7r5tBqy0FL42EeZxLcFO5GI4hIfHE=');
  assert.deepEqual(fcmCrypto.openData(s, key), data);
});

test('登録API: 鍵の形が違えば 400、正しければ sealed:true、無ければ従来通り', async () => {
  const { startServer } = require('./helpers');
  const S = await startServer();
  try {
    const u = await S.user('FcmUser');
    const bad = await u.call('POST', '/api/push/fcm-register', { token: 'tokA', pushKey: 'short' });
    assert.equal(bad.status, 400);
    const bad2 = await u.call('POST', '/api/push/fcm-register', { token: 'tokA', pushKey: 12345 });
    assert.equal(bad2.status, 400);
    const ok = await u.call('POST', '/api/push/fcm-register', { token: 'tokA', pushKey: crypto.randomBytes(32).toString('base64') });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.sealed, true);
    const legacy = await u.call('POST', '/api/push/fcm-register', { token: 'tokB' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.data.sealed, false);
    // シークレットキーボードの設定: 既定はオフ、保存できて、真偽値以外はそのまま入らない
    const s0 = await u.call('GET', '/api/settings');
    assert.equal(s0.data.settings.incognitoKeyboard, false);
    const s1 = await u.call('PUT', '/api/settings', { settings: { incognitoKeyboard: true } });
    assert.equal(s1.data.settings.incognitoKeyboard, true);
    const s2 = await u.call('PUT', '/api/settings', { settings: { incognitoKeyboard: 'no' } });
    assert.equal(typeof s2.data.settings.incognitoKeyboard, 'boolean'); // 文字列はそのまま保存されない
    const noauth = await S.req('POST', '/api/push/fcm-register', { body: { token: 'tokC', pushKey: crypto.randomBytes(32).toString('base64') } });
    assert.equal(noauth.status, 401);
  } finally { await S.stop(); }
});
