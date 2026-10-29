// 消えるメッセージ: タイマーの設定・権限・期限の押印・履歴からの除外・掃除。
// テスト環境(NODE_ENV=test)だけ 2 秒のタイマーを選べる(期限切れを待って確かめるため)。
process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startServer, sleep } = require('./helpers');

let S;     // 掃除をほぼ止めたサーバー(「掃除の前でも履歴から外れる」ことを確かめる)
let F;     // 1秒ごとに掃除するサーバー
before(async () => {
  S = await startServer({ EXPIRY_SWEEP_MS: '3600000' });
  F = await startServer({ EXPIRY_SWEEP_MS: '1000' });
});
after(async () => { if (S) await S.stop(); if (F) await F.stop(); });

async function group(owner, members) {
  const r = await owner.call('POST', '/api/groups/create', { name: 'g', memberIds: members.map(m => m.userId), encryptedKeysForMembers: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.groupId;
}

test('1対1: 友だちなら両者が設定でき、お知らせとWSイベントが出る。値は決まった4つだけ', async () => {
  const a = await S.user('TtlA'); const b = await S.user('TtlB');
  await S.befriend(a, b);
  assert.equal((await a.call('GET', `/api/messages/ttl/${b.userId}`)).data.ttlSeconds, 0);
  const wsB = await S.connect(b);
  const ev = new Promise(res => wsB.ws.on('message', m => { const d = JSON.parse(m); if (d.type === 'conversation_ttl') res(d); }));

  const bad = await a.call('PUT', `/api/messages/ttl/${b.userId}`, { ttlSeconds: 5 });
  assert.equal(bad.status, 400);
  const ok = await a.call('PUT', `/api/messages/ttl/${b.userId}`, { ttlSeconds: 86400 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.ttlSeconds, 86400);
  const d = await ev;
  assert.equal(d.scope, 'dm');
  assert.equal(d.ttlSeconds, 86400);
  assert.equal(d.peerId, a.userId);
  assert.equal(d.changedBy, a.userId);
  wsB.close();

  // 相手側からも同じ値が見え、相手も変えられる
  assert.equal((await b.call('GET', `/api/messages/ttl/${a.userId}`)).data.ttlSeconds, 86400);
  assert.equal((await b.call('PUT', `/api/messages/ttl/${a.userId}`, { ttlSeconds: 0 })).status, 200);

  const hist = await a.call('GET', `/api/messages/history/${b.userId}`);
  const notices = hist.data.filter(m => m.msgType === 'notice').map(m => JSON.parse(m.content).__notice__);
  assert.equal(notices.length, 2);
  assert.ok(notices.every(n => n.kind === 'ttl'));
  // 同じ秒に作られると順番が決まらないので、順不同で確かめる
  const texts = notices.map(n => n.text);
  assert.ok(texts.some(t => /が消えるメッセージを1日に設定しました$/.test(t)), texts.join('|'));
  assert.ok(texts.some(t => /が消えるメッセージをオフにしました$/.test(t)), texts.join('|'));
  // お知らせの本文に絵文字を入れていない
  assert.ok(!/\p{Extended_Pictographic}/u.test(texts.join('')));
});

test('1対1: 友だちでない人は見ることも変えることもできない', async () => {
  const a = await S.user('TtlC'); const b = await S.user('TtlD'); const x = await S.user('TtlX');
  await S.befriend(a, b);
  assert.equal((await x.call('PUT', `/api/messages/ttl/${a.userId}`, { ttlSeconds: 3600 })).status, 403);
  assert.equal((await x.call('GET', `/api/messages/ttl/${a.userId}`)).status, 403);
  assert.equal((await a.call('GET', `/api/messages/ttl/${b.userId}`)).data.ttlSeconds, 0);
});

test('押印: タイマーがあれば expiresAt が入り、0なら NULL のまま', async () => {
  const a = await S.user('StA'); const b = await S.user('StB');
  await S.befriend(a, b);
  const none = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'no timer' });
  assert.equal(none.data.message.expiresAt, null);

  await a.call('PUT', `/api/messages/ttl/${b.userId}`, { ttlSeconds: 3600 });
  const t0 = Date.now();
  const timed = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'timed' });
  const exp = Date.parse(timed.data.message.expiresAt);
  assert.ok(exp >= t0 + 3600 * 1000 - 5000 && exp <= Date.now() + 3600 * 1000 + 5000, String(timed.data.message.expiresAt));

  // 編集しても期限は延びない
  const ed = await a.call('POST', '/api/messages/edit', { messageId: timed.data.message.id, content: 'timed edited' });
  assert.equal(ed.status, 200);
  const h1 = await a.call('GET', `/api/messages/history/${b.userId}`);
  assert.equal(Date.parse(h1.data.find(m => m.id === timed.data.message.id).expiresAt), exp);

  // オフに戻すと以降は NULL。すでに押した分はそのまま
  await a.call('PUT', `/api/messages/ttl/${b.userId}`, { ttlSeconds: 0 });
  const off = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'off again' });
  assert.equal(off.data.message.expiresAt, null);
  const h2 = await a.call('GET', `/api/messages/history/${b.userId}`);
  assert.equal(h2.data.find(m => m.id === timed.data.message.id).expiresAt !== null, true);
  assert.equal(h2.data.find(m => m.id === none.data.message.id).expiresAt, null);
});

test('期限切れは、掃除の前でも履歴・一覧・未読から外れる', async () => {
  const a = await S.user('ExA'); const b = await S.user('ExB');
  await S.befriend(a, b);
  await a.call('PUT', `/api/messages/ttl/${b.userId}`, { ttlSeconds: 2 });
  const gone = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'will vanish' });
  await a.call('PUT', `/api/messages/ttl/${b.userId}`, { ttlSeconds: 0 });
  const stay = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'stays' });

  const before = await b.call('GET', `/api/messages/talks`);
  assert.equal(before.data.find(t => t.userId === a.userId).unreadCount >= 2, true);
  await sleep(2600);
  const talks = await b.call('GET', `/api/messages/talks`);
  const row = talks.data.find(t => t.userId === a.userId);
  assert.equal(row.unreadCount, 1, '期限切れの分は未読に数えない(残りは stays だけ)');
  const hist = await b.call('GET', `/api/messages/history/${a.userId}?markRead=0`);
  const ids = hist.data.map(m => m.id);
  assert.ok(!ids.includes(gone.data.message.id));
  assert.ok(ids.includes(stay.data.message.id));
  // 期限切れの返信先は指せない
  const rep = await b.call('POST', '/api/messages/send', { recipientId: a.userId, content: 'r', repliedToId: gone.data.message.id });
  assert.equal(rep.status, 404);
});

test('グループ: 部外者は設定できない。メンバーは設定でき、期限が押され、期限切れは履歴から外れる', async () => {
  const a = await S.user('GtA'); const b = await S.user('GtB'); const x = await S.user('GtX');
  await S.befriend(a, b);
  const g = await group(a, [b]);
  assert.equal((await x.call('PUT', `/api/groups/${g}/ttl`, { ttlSeconds: 3600 })).status, 403);
  assert.equal((await x.call('GET', `/api/groups/${g}/ttl`)).status, 403);
  assert.equal((await b.call('PUT', `/api/groups/${g}/ttl`, { ttlSeconds: 7 })).status, 400);

  const wsA = await S.connect(a);
  const ev = new Promise(res => wsA.ws.on('message', m => { const d = JSON.parse(m); if (d.type === 'conversation_ttl') res(d); }));
  const set = await b.call('PUT', `/api/groups/${g}/ttl`, { ttlSeconds: 2 });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  const d = await ev;
  assert.equal(d.scope, 'group'); assert.equal(d.groupId, g); assert.equal(d.ttlSeconds, 2); assert.equal(d.changedBy, b.userId);
  wsA.close();
  assert.equal((await a.call('GET', `/api/groups/${g}/ttl`)).data.ttlSeconds, 2);

  const m1 = await a.call('POST', `/api/groups/${g}/messages/send`, { content: 'g will vanish' });
  assert.equal(m1.status, 200);
  assert.ok(m1.data.message.expires_at, '期限が押されている');
  await b.call('PUT', `/api/groups/${g}/ttl`, { ttlSeconds: 0 });
  const m2 = await a.call('POST', `/api/groups/${g}/messages/send`, { content: 'g stays' });
  assert.equal(m2.data.message.expires_at, null);

  const h0 = await b.call('GET', `/api/groups/${g}/messages`);
  assert.ok(h0.data.some(m => m.id === m1.data.message.id));
  assert.equal(h0.data.filter(m => m.msg_type === 'notice').length, 2);
  await sleep(2600);
  const h1 = await b.call('GET', `/api/groups/${g}/messages`);
  const ids = h1.data.map(m => m.id);
  assert.ok(!ids.includes(m1.data.message.id));
  assert.ok(ids.includes(m2.data.message.id));
});

test('掃除: 期限切れだけが消え、messages_expired がWSで届く', async () => {
  const a = await F.user('SwA'); const b = await F.user('SwB'); const c = await F.user('SwC');
  await F.befriend(a, b);
  await F.befriend(a, c);
  const g = await group(a, [c]);
  const wsB = await F.connect(b);
  const wsA = await F.connect(a);
  const wsC = await F.connect(c);
  const waitFor = (w, pred) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('event timeout')), 8000);
    w.ws.on('message', m => { const d = JSON.parse(m); if (pred(d)) { clearTimeout(t); res(d); } });
  });
  const evB = waitFor(wsB, d => d.type === 'messages_expired');
  const evC = waitFor(wsC, d => d.type === 'messages_expired');

  await a.call('PUT', `/api/messages/ttl/${b.userId}`, { ttlSeconds: 2 });
  const dm = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'dm bye' });
  await b.call('POST', '/api/messages/react', { messageId: dm.data.message.id, emoji: 'a' });
  await a.call('PUT', `/api/groups/${g}/ttl`, { ttlSeconds: 2 });
  const gm = await a.call('POST', `/api/groups/${g}/messages/send`, { content: 'group bye' });

  const dB = await evB;
  assert.equal(dB.scope, 'dm');
  assert.equal(dB.peerId, a.userId);
  assert.ok(dB.messageIds.includes(dm.data.message.id));
  assert.match(dB.conversationKey, /^dm:/);
  const dC = await evC;
  assert.equal(dC.scope, 'group');
  assert.equal(dC.groupId, g);
  assert.ok(dC.messageIds.includes(gm.data.message.id));
  assert.equal(dC.conversationKey, 'g:' + g);
  wsA.close(); wsB.close(); wsC.close();
});

test('掃除(DB直接): 反応・既読・返信の参照を片付け、返信した側は残る。期限なしは触らない', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brochat-ttl-'));
  process.env.SQLITE_FILE = path.join(tmp, 'sweep.sqlite');
  delete process.env.DATABASE_URL;
  const db = require('../db/db');
  await db.initDB();
  const { sweepExpired } = require('../utils/disappearing');
  const past = new Date(Date.now() - 60000).toISOString();
  const future = new Date(Date.now() + 3600000).toISOString();
  const ins = (id, exp, reply) => db.run(
    "INSERT INTO messages (id, sender_id, recipient_id, content, expires_at, replied_to_id) VALUES (?, 'ua', 'ub', 'x', ?, ?)", [id, exp, reply || null]);
  await ins('old', past);
  await ins('reply', null, 'old');       // 期限切れを引用している(期限なし)
  await ins('keep', null);
  await ins('later', future);
  await db.run("INSERT INTO message_reactions (id, message_id, user_id, emoji) VALUES ('r1', 'old', 'ub', 'a')");
  await db.run("INSERT INTO group_messages (id, group_id, sender_id, content, expires_at) VALUES ('gold', 'G1', 'ua', 'x', ?)", [past]);
  await db.run("INSERT INTO group_messages (id, group_id, sender_id, content) VALUES ('gkeep', 'G1', 'ua', 'x')");
  await db.run("INSERT INTO group_message_reads (message_id, user_id) VALUES ('gold', 'ub')");
  await db.run("INSERT INTO group_message_reactions (message_id, user_id, emoji) VALUES ('gold', 'ub', 'a')");
  await db.run("INSERT INTO group_members (group_id, user_id) VALUES ('G1', 'ua')");
  await db.run("INSERT INTO group_members (group_id, user_id) VALUES ('G1', 'ub')");

  const events = [];
  const n = await sweepExpired((users, payload) => events.push({ users, payload }));
  assert.equal(n, 2);
  const left = (await db.all('SELECT id, replied_to_id FROM messages ORDER BY id')).map(r => r.id);
  assert.deepEqual(left, ['keep', 'later', 'reply']);
  assert.equal((await db.get("SELECT replied_to_id FROM messages WHERE id = 'reply'")).replied_to_id, null);
  assert.equal((await db.get("SELECT COUNT(*) AS c FROM message_reactions")).c, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS c FROM group_message_reads")).c, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS c FROM group_message_reactions")).c, 0);
  assert.deepEqual((await db.all('SELECT id FROM group_messages')).map(r => r.id), ['gkeep']);
  const dm = events.filter(e => e.payload.scope === 'dm');
  assert.equal(dm.length, 2); // 送り手と受け手の両方へ
  const gr = events.find(e => e.payload.scope === 'group');
  assert.deepEqual(gr.users.sort(), ['ua', 'ub']);
  assert.deepEqual(gr.payload.messageIds, ['gold']);
  // 2回目は何も消さない
  assert.equal(await sweepExpired(() => {}), 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});
