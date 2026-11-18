// 「通知に本文を出さない」設定: Web Push / FCM の両方で、設定が有効な受信者の通知から
// 本文・暗号文・公開鍵が消え、オフなら今まで通り載ることを確かめる。
// サーバーは立てず、DB(一時SQLite)と web-push だけをこのプロセスの中で差し替えて通す。
process.env.NODE_ENV = 'test';
const os = require('os');
const fs = require('fs');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brochat-np-'));
process.env.SQLITE_FILE = path.join(tmp, 'np.sqlite');
delete process.env.DATABASE_URL;
const webpush = require('web-push');
process.env.VAPID_PRIVATE_KEY = webpush.generateVAPIDKeys().privateKey;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/db');
const settings = require('../utils/userSettings');
let sendPushToUser, buildMessageData;
const sent = []; // web-push に渡された本文

before(async () => {
  await db.initDB();
  webpush.sendNotification = async (sub, payload) => { sent.push(JSON.parse(payload)); };
  ({ sendPushToUser } = require('../utils/webPush'));
  ({ buildMessageData } = require('../utils/fcm'));
  for (const id of ['u_hide', 'u_show']) {
    await db.run('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)',
      ['s_' + id, id, 'https://fcm.googleapis.com/fcm/send/' + id, 'p', 'a']);
  }
  await settings.saveSettings('u_hide', { hideNotificationBody: true });
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const SECRET = 'ひみつの本文e2:CIPHERTEXT';
const dmPayload = () => ({ type: 'new_message', senderId: 's1', senderName: 'Alice', senderPic: '/icons/x', preview: '[画像]', cipher: SECRET, senderPub: 'PUBKEY' });

test('既定ではオフ(本文は今まで通り載る)', async () => {
  assert.equal((await settings.getSettings('u_show')).hideNotificationBody, false);
});

test('Web Push: 有効な受信者には本文・暗号文・種類が載らず、送信者名は残る', async () => {
  sent.length = 0;
  await sendPushToUser('u_hide', dmPayload(), { containsMessage: true });
  assert.equal(sent.length, 1);
  const raw = JSON.stringify(sent[0]);
  assert.ok(!raw.includes('CIPHERTEXT') && !raw.includes('PUBKEY') && !raw.includes('画像'), raw);
  assert.equal(sent[0].preview, '新しいメッセージ');
  assert.equal(sent[0].senderName, 'Alice');
  assert.equal(sent[0].cipher, undefined);
});

test('Web Push: グループ通知も同じ', async () => {
  sent.length = 0;
  await sendPushToUser('u_hide', { type: 'new_group_message', groupId: 'g', groupName: 'G', senderName: 'Bob', preview: 'メッセージが届きました' }, { containsMessage: true });
  assert.equal(sent[0].preview, '新しいメッセージ');
  assert.equal(sent[0].senderName, 'Bob');
});

test('Web Push: オフの受信者には従来どおり本文が載る', async () => {
  sent.length = 0;
  await sendPushToUser('u_show', dmPayload(), { containsMessage: true });
  assert.equal(sent[0].cipher, SECRET);
  assert.equal(sent[0].preview, '[画像]');
  assert.equal(sent[0].senderPub, 'PUBKEY');
});

test('Web Push: 本文を含まない通知(通話など)は設定があっても変わらない', async () => {
  sent.length = 0;
  await sendPushToUser('u_hide', { type: 'call_missed', callId: 'c1', callerName: 'Alice' }, { ttl: 3600 });
  assert.equal(sent[0].callerName, 'Alice');
  assert.equal(sent[0].type, 'call_missed');
});

test('FCM: 有効な受信者向けは本文・暗号文が空になり、送信者名は残る', () => {
  const extra = { containsMessage: true, senderId: 's1', cipher: SECRET, senderPub: 'PUBKEY', senderPic: '/icons/x' };
  const hidden = buildMessageData('Alice', '[画像]', 'dm', extra, true);
  assert.equal(hidden.content, '新しいメッセージ');
  assert.equal(hidden.cipher, '');
  assert.equal(hidden.sender_pub, '');
  assert.equal(hidden.sender_name, 'Alice');
  assert.ok(!JSON.stringify(hidden).includes('CIPHERTEXT'));
  const shown = buildMessageData('Alice', '[画像]', 'dm', extra, false);
  assert.equal(shown.content, '[画像]');
  assert.equal(shown.cipher, SECRET);
  assert.equal(shown.sender_pub, 'PUBKEY');
});

test('個人・グループの送信経路が、どちらも containsMessage を付けている', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.equal((read('routes/messages.js').match(/containsMessage: true/g) || []).length, 2);
  assert.equal((read('routes/groups.js').match(/containsMessage: true/g) || []).length, 2);
});
