// トークリストの操作(ピン留め・ミュート・非表示・自分だけトーク削除・開かずに既読)のサーバー側。
// SQLiteは時刻を秒単位でしか持たないので、「あとから届いたメッセージ」を作る所では1.1秒空けている。
process.env.NODE_ENV = 'test';
const os = require('os');
const fs = require('fs');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brochat-cp-'));
// このプロセスの中で直接使うDB(通知の止め方の確認用)。サーバーは helpers が別のファイルで立てる
process.env.SQLITE_FILE = path.join(tmp, 'cp.sqlite');
delete process.env.DATABASE_URL;

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => { S && S.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const talkOf = async (u, peer) => (await u.call('GET', '/api/messages/talks')).data.find(t => t.userId === peer.userId);
const groupOf = async (u, gid) => (await u.call('GET', '/api/groups/list')).data.groups.find(g => g.groupId === gid);
const prefOf = async (u, kind, peerId) => (await u.call('GET', '/api/chat-prefs')).data.prefs.find(p => p.kind === kind && p.peerId === peerId);
const dm = (from, to, content) => from.call('POST', '/api/messages/send', { recipientId: to.userId, content });
const gsend = (from, gid, content) => from.call('POST', `/api/groups/${gid}/messages/send`, { content });
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(50); }
}

describe('ピン留め・ミュート・非表示', () => {
  test('GETは最初は空。PUTは送った項目だけを変えて、結果をcamelCaseで返す', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    assert.deepEqual((await a.call('GET', '/api/chat-prefs')).data, { prefs: [] });

    const before = Date.now();
    const r1 = await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, pinned: true });
    assert.equal(r1.status, 200);
    assert.equal(r1.data.kind, 'dm');
    assert.equal(r1.data.peerId, b.userId);
    assert.ok(typeof r1.data.pinnedAt === 'number' && r1.data.pinnedAt >= before);
    assert.equal(r1.data.muted, false);
    assert.equal(r1.data.hiddenAt, null);
    assert.equal(r1.data.clearedAt, 0);

    // mutedだけ送ってもピン留めは残る
    const r2 = await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, muted: true });
    assert.equal(r2.data.muted, true);
    assert.equal(r2.data.pinnedAt, r1.data.pinnedAt);
    // すでにピン留め済みなら、もう一度送っても時刻は変わらない(並びが入れ替わらない)
    const r3 = await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, pinned: true });
    assert.equal(r3.data.pinnedAt, r1.data.pinnedAt);

    const list = (await a.call('GET', '/api/chat-prefs')).data.prefs;
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], r3.data);

    // 外す: ピン留めはnullに戻り、ミュートは残る
    const r4 = await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, pinned: false });
    assert.equal(r4.data.pinnedAt, null);
    assert.equal(r4.data.muted, true);
    // 全部初期値に戻したら行は残らない
    await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, muted: false });
    assert.deepEqual((await a.call('GET', '/api/chat-prefs')).data, { prefs: [] });
  });

  test('ピン留めはDMとグループを合わせて10件まで。超えると pin_limit、外せばまた留められる', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const gids = [];
    for (let i = 0; i < 11; i++) gids.push((await a.call('POST', '/api/groups/create', { name: 'G' + i })).data.groupId);
    assert.equal((await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, pinned: true })).status, 200);
    for (let i = 0; i < 9; i++) assert.equal((await a.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: gids[i], pinned: true })).status, 200);
    // 10件目まで入った。11件目は断られる
    const over = await a.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: gids[9], pinned: true });
    assert.equal(over.status, 400);
    assert.equal(over.data.code, 'pin_limit');
    assert.ok(typeof over.data.error === 'string' && over.data.error.length > 0);
    assert.equal(await prefOf(a, 'group', gids[9]), undefined);
    // 留めてあるものを留め直しても、上限には引っかからない
    assert.equal((await a.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: gids[0], pinned: true })).status, 200);
    // ミュートなど、ピン留め以外は上限と関係ない
    assert.equal((await a.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: gids[10], muted: true })).status, 200);
    // 1件外すと、新しく留められる
    await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, pinned: false });
    assert.equal((await a.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: gids[9], pinned: true })).status, 200);
    // 他の人の枠には影響しない
    assert.equal((await b.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: a.userId, pinned: true })).status, 200);
  });

  test('一覧(talks / groups/list)に pinnedAt・muted・hidden が付く', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const g = (await a.call('POST', '/api/groups/create', { name: 'GL', memberIds: [b.userId] })).data;
    await dm(a, b, 'hi');
    await gsend(a, g.groupId, 'hello');

    // 何もしていない時
    let t = await talkOf(a, b);
    assert.equal(t.pinnedAt, null); assert.equal(t.muted, false); assert.equal(t.hidden, false);
    let gl = await groupOf(a, g.groupId);
    assert.equal(gl.pinnedAt, null); assert.equal(gl.muted, false); assert.equal(gl.hidden, false);

    const p1 = (await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, pinned: true, muted: true })).data;
    const p2 = (await a.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: g.groupId, muted: true })).data;
    t = await talkOf(a, b);
    assert.equal(t.pinnedAt, p1.pinnedAt); assert.equal(t.muted, true); assert.equal(t.hidden, false);
    gl = await groupOf(a, g.groupId);
    assert.equal(gl.pinnedAt, null); assert.equal(gl.muted, p2.muted); assert.equal(gl.hidden, false);
    // 設定は本人にだけ。相手の一覧は変わらない
    t = await talkOf(b, a);
    assert.equal(t.pinnedAt, null); assert.equal(t.muted, false);
    gl = await groupOf(b, g.groupId);
    assert.equal(gl.muted, false);
  });

  test('非表示: 新しいメッセージが来るまで hidden。来たら戻る(項目は一覧から消さない)', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    // 話していない友だちでも非表示にできる
    await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, hidden: true });
    let t = await talkOf(a, b);
    assert.ok(t, '非表示でも一覧には残る');
    assert.equal(t.hidden, true);
    await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, hidden: false });
    assert.equal((await talkOf(a, b)).hidden, false);

    await dm(a, b, 'one');
    await sleep(1100);
    const h = (await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, hidden: true })).data;
    assert.ok(typeof h.hiddenAt === 'number');
    assert.equal((await talkOf(a, b)).hidden, true);
    await sleep(1100);
    await dm(b, a, 'two'); // 相手からの新着
    t = await talkOf(a, b);
    assert.equal(t.hidden, false, '新着で戻る');
    assert.equal(t.lastMessage, 'two');
    // 設定自体(hiddenAt)は残る。次に何も来なければ、また隠せるのは「もう一度 hidden:true」した時
    assert.equal((await prefOf(a, 'dm', b.userId)).hiddenAt, h.hiddenAt);
    await sleep(1100);
    await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, hidden: true });
    assert.equal((await talkOf(a, b)).hidden, true);
    // 自分が送った分でも戻る
    await sleep(1100);
    await dm(a, b, 'three');
    assert.equal((await talkOf(a, b)).hidden, false);

    // グループも同じ
    const g = (await a.call('POST', '/api/groups/create', { name: 'GH', memberIds: [b.userId] })).data;
    await gsend(a, g.groupId, 'g1');
    await sleep(1100);
    await a.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: g.groupId, hidden: true });
    assert.equal((await groupOf(a, g.groupId)).hidden, true);
    await sleep(1100);
    await gsend(b, g.groupId, 'g2');
    assert.equal((await groupOf(a, g.groupId)).hidden, false);
  });
});

describe('トークを削除(自分だけ)', () => {
  test('DM: 履歴・トーク一覧は削除した本人だけ空になり、あとから届いた分は普通に出る', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    await dm(a, b, 'a1');
    await dm(b, a, 'b1'); // Aにとっては未読
    assert.equal((await talkOf(a, b)).unreadCount, 1);
    await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, hidden: true });
    await sleep(1100);

    const c = await a.call('POST', '/api/chat-prefs/clear', { kind: 'dm', peerId: b.userId });
    assert.equal(c.status, 200);
    assert.ok(c.data.clearedAt > 0);
    assert.equal(c.data.hiddenAt, null, '削除すると非表示は解ける');
    assert.equal(c.data.kind, 'dm');

    // Aの履歴は空。Bは何も変わらない
    assert.equal((await a.call('GET', `/api/messages/history/${b.userId}`)).data.length, 0);
    const hb = (await b.call('GET', `/api/messages/history/${a.userId}`)).data;
    assert.deepEqual(hb.map(m => m.content).sort(), ['a1', 'b1']);
    // 一覧: 何も話していない友だちと同じ(lastTime null、未読0)。Bの一覧は変わらない
    const ta = await talkOf(a, b);
    assert.equal(ta.lastTime, null); assert.equal(ta.lastMessage, ''); assert.equal(ta.unreadCount, 0);
    assert.equal(ta.hidden, false);
    const tb = await talkOf(b, a);
    assert.ok(['a1', 'b1'].includes(tb.lastMessage)); // 同じ秒に送ったので、どちらが最新かは決まらない
    assert.ok(tb.lastTime);

    // あとから届いた分は普通に出る
    await sleep(1100);
    await dm(b, a, 'b2');
    const ha = (await a.call('GET', `/api/messages/history/${b.userId}?markRead=0`)).data;
    assert.deepEqual(ha.map(m => m.content), ['b2']);
    const ta2 = await talkOf(a, b);
    assert.equal(ta2.lastMessage, 'b2');
    assert.equal(ta2.unreadCount, 1, '削除前の未読は数えず、新着だけ数える');
    assert.ok(ta2.lastTime);
    // 自分から送った新しい分も出る
    await sleep(1100);
    await dm(a, b, 'a2');
    assert.deepEqual((await a.call('GET', `/api/messages/history/${b.userId}?markRead=0`)).data.map(m => m.content), ['b2', 'a2']);
    // 相手の履歴は全部のまま
    assert.equal((await b.call('GET', `/api/messages/history/${a.userId}?markRead=0`)).data.length, 4);
    // 削除した時刻は prefs に残る
    assert.equal((await prefOf(a, 'dm', b.userId)).clearedAt, c.data.clearedAt);
  });

  test('グループ: メッセージ取得・一覧の最新/未読は削除した本人だけ空になる', async () => {
    const a = await S.user('A'); const b = await S.user('B'); const c = await S.user('C');
    await S.befriend(a, b); await S.befriend(a, c);
    const g = (await a.call('POST', '/api/groups/create', { name: 'GC', memberIds: [b.userId, c.userId] })).data;
    await sleep(1100);
    await gsend(b, g.groupId, 'g1');
    await gsend(c, g.groupId, 'g2');
    assert.equal((await groupOf(a, g.groupId)).unreadCount, 2);
    await sleep(1100);

    const r = await a.call('POST', '/api/chat-prefs/clear', { kind: 'group', peerId: g.groupId });
    assert.equal(r.status, 200);
    assert.equal((await a.call('GET', `/api/groups/${g.groupId}/messages`)).data.length, 0);
    assert.equal((await b.call('GET', `/api/groups/${g.groupId}/messages`)).data.length, 2);
    assert.equal((await c.call('GET', `/api/groups/${g.groupId}/messages`)).data.length, 2);
    let ga = await groupOf(a, g.groupId);
    assert.equal(ga.lastMessage, null); assert.equal(ga.unreadCount, 0);
    const gb = await groupOf(b, g.groupId);
    assert.ok(gb.lastMessage); assert.ok(['g1', 'g2'].includes(gb.lastMessage.content)); // 同じ秒に送ったので、どちらが最新かは決まらない

    await sleep(1100);
    await gsend(b, g.groupId, 'g3');
    assert.deepEqual((await a.call('GET', `/api/groups/${g.groupId}/messages`)).data.map(m => m.content), ['g3']);
    ga = await groupOf(a, g.groupId);
    assert.equal(ga.lastMessage.content, 'g3');
    assert.equal(ga.unreadCount, 1);
    assert.equal((await b.call('GET', `/api/groups/${g.groupId}/messages`)).data.length, 3);
  });
});

describe('開かずに既読', () => {
  test('DM: POST /api/messages/read/:userId で未読が0になり、相手に read_receipt_bulk が届く', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const m1 = (await dm(a, b, 'x1')).data.message;
    const m2 = (await dm(a, b, 'x2')).data.message;
    assert.equal((await talkOf(b, a)).unreadCount, 2);
    const wa = await S.connect(a);
    try {
      const r = await b.call('POST', `/api/messages/read/${a.userId}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.data, { ok: true, count: 2 });
      assert.equal((await talkOf(b, a)).unreadCount, 0);
      const ev = await waitFor(() => wa.msgs.find(m => m.type === 'read_receipt_bulk'));
      assert.ok(ev, 'read_receipt_bulk が届く');
      assert.equal(ev.readerId, b.userId);
      assert.deepEqual(ev.messageIds.slice().sort(), [m1.id, m2.id].sort());
    } finally { wa.close(); }
    // Aの履歴にも既読が付く
    const h = (await a.call('GET', `/api/messages/history/${b.userId}?markRead=0`)).data;
    assert.ok(h.every(m => m.readAt));
    // 2回目は何も既読にしない
    assert.deepEqual((await b.call('POST', `/api/messages/read/${a.userId}`)).data, { ok: true, count: 0 });
    // 自分自身は指定できない
    assert.equal((await b.call('POST', `/api/messages/read/${b.userId}`)).status, 400);
    // 未ログインは通らない
    assert.equal((await S.req('POST', `/api/messages/read/${a.userId}`)).status, 401);
  });

  test('DM: 相手をブロックしていると、既読にはなるが相手へは知らせない(履歴を開いた時と同じ)', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    await dm(a, b, 'y1');
    await b.call('POST', '/api/friends/block', { userId: a.userId });
    const wa = await S.connect(a);
    try {
      const r = await b.call('POST', `/api/messages/read/${a.userId}`);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.count, 1);
      await sleep(400);
      assert.equal(wa.msgs.find(m => m.type === 'read_receipt_bulk'), undefined);
    } finally { wa.close(); }
  });

  test('グループ: read-all で未読が0になり、既読者に記録され、メンバーへ通知が飛ぶ', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const g = (await a.call('POST', '/api/groups/create', { name: 'GR', memberIds: [b.userId] })).data;
    await sleep(1100);
    const m1 = (await gsend(a, g.groupId, 'r1')).data.message;
    const m2 = (await gsend(a, g.groupId, 'r2')).data.message;
    assert.equal((await groupOf(b, g.groupId)).unreadCount, 2);
    const wa = await S.connect(a);
    try {
      const r = await b.call('POST', `/api/groups/${g.groupId}/read-all`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.data, { ok: true });
      assert.equal((await groupOf(b, g.groupId)).unreadCount, 0);
      const ev = await waitFor(() => wa.msgs.find(m => m.type === 'group_message_read' && m.messageId === m2.id));
      assert.ok(ev);
      assert.equal(ev.readerUserId, b.userId);
      assert.equal(ev.readCount, 1);
    } finally { wa.close(); }
    for (const m of [m1, m2]) {
      const reads = (await a.call('GET', `/api/groups/${g.groupId}/messages/${m.id}/reads`)).data.reads;
      assert.deepEqual(reads.map(x => x.userId), [b.userId]);
    }
    // もう一度呼んでも二重には記録しない。自分が送った分は既読の対象外
    assert.equal((await b.call('POST', `/api/groups/${g.groupId}/read-all`)).status, 200);
    assert.equal((await a.call('GET', `/api/groups/${g.groupId}/messages/${m1.id}/reads`)).data.reads.length, 1);
    await a.call('POST', `/api/groups/${g.groupId}/read-all`);
    const mine = (await b.call('GET', `/api/groups/${g.groupId}/messages/${m1.id}/reads`)).data.reads;
    assert.ok(!mine.some(x => x.userId === a.userId));
  });
});

describe('権限と不正な入力', () => {
  test('友だちでも会話した相手でもなければ 403、存在しないIDは 404', async () => {
    const a = await S.user('A'); const stranger = await S.user('S');
    for (const body of [{ pinned: true }, { muted: true }, { hidden: true }]) {
      const r = await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: stranger.userId, ...body });
      assert.equal(r.status, 403, JSON.stringify(body));
    }
    assert.equal((await a.call('POST', '/api/chat-prefs/clear', { kind: 'dm', peerId: stranger.userId })).status, 403);
    assert.equal((await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: 'no-such-user', pinned: true })).status, 404);
    assert.deepEqual((await a.call('GET', '/api/chat-prefs')).data.prefs, []);
  });

  test('友だちを外したあとでも、メッセージのやり取りがある相手には設定できる', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    // befriend と同じ手順で、あとで外せるよう friendshipId を控える
    await a.call('POST', '/api/friends/request', { targetUserIdCode: b.userIdCode });
    const f = (await b.call('GET', '/api/friends/pending')).data.find(p => p.userId === a.userId);
    await b.call('POST', '/api/friends/accept', { friendshipId: f.friendshipId });
    await dm(a, b, 'before the end');
    assert.equal((await a.call('POST', '/api/friends/remove', { friendshipId: f.friendshipId })).status, 200);
    assert.equal((await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, pinned: true })).status, 200);
    // 外した後でも「外す方向」の操作は通る
    assert.equal((await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, pinned: false })).status, 200);
  });

  test('グループ: メンバーでなければ 403、存在しなければ 404。抜けると設定は消える', async () => {
    const a = await S.user('A'); const x = await S.user('X');
    const g = (await a.call('POST', '/api/groups/create', { name: 'GA' })).data;
    assert.equal((await x.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: g.groupId, pinned: true })).status, 403);
    assert.equal((await x.call('POST', '/api/chat-prefs/clear', { kind: 'group', peerId: g.groupId })).status, 403);
    assert.equal((await a.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: 'no-such-group', pinned: true })).status, 404);
    assert.equal((await x.call('POST', `/api/groups/${g.groupId}/read-all`)).status, 403);
    assert.equal((await a.call('POST', '/api/groups/no-such-group/read-all')).status, 404);

    // 3人目を入れて、Bが抜けたら設定が消える
    const b = await S.user('B');
    await S.befriend(a, b);
    const g2 = (await a.call('POST', '/api/groups/create', { name: 'GB', memberIds: [b.userId] })).data;
    await b.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: g2.groupId, pinned: true });
    assert.ok(await prefOf(b, 'group', g2.groupId));
    const left = await b.call('POST', '/api/groups/remove-member', { groupId: g2.groupId, removeUserId: b.userId });
    assert.equal(left.status, 200);
    assert.equal(await prefOf(b, 'group', g2.groupId), undefined);
    // 抜けたあとは留め直せない
    assert.equal((await b.call('PUT', '/api/chat-prefs', { kind: 'group', peerId: g2.groupId, pinned: true })).status, 403);
  });

  test('他人の設定は読めない・書き換わらない。未ログインは 401', async () => {
    const a = await S.user('A'); const b = await S.user('B'); const c = await S.user('C');
    await S.befriend(a, b); await S.befriend(c, b);
    await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, pinned: true, muted: true });
    assert.deepEqual((await c.call('GET', '/api/chat-prefs')).data.prefs, []);
    // 同じ相手に対する設定でも、人ごとに別
    await c.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, muted: false, hidden: true });
    const pa = await prefOf(a, 'dm', b.userId);
    assert.equal(pa.muted, true); assert.equal(pa.hiddenAt, null); assert.ok(pa.pinnedAt);
    // userId を本文に混ぜても自分の分にしか効かない
    await c.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, userId: a.userId, muted: true });
    assert.equal((await a.call('GET', '/api/chat-prefs')).data.prefs.length, 1);
    assert.equal((await S.req('GET', '/api/chat-prefs')).status, 401);
    assert.equal((await S.req('PUT', '/api/chat-prefs', { body: { kind: 'dm', peerId: b.userId, pinned: true } })).status, 401);
    assert.equal((await S.req('POST', '/api/chat-prefs/clear', { body: { kind: 'dm', peerId: b.userId } })).status, 401);
    assert.equal((await S.req('POST', '/api/groups/x/read-all')).status, 401);
  });

  test('不正な入力は 400', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const put = body => a.call('PUT', '/api/chat-prefs', body);
    assert.equal((await put({ kind: 'channel', peerId: b.userId, pinned: true })).status, 400);
    assert.equal((await put({ peerId: b.userId, pinned: true })).status, 400);
    assert.equal((await put({ kind: 'dm', pinned: true })).status, 400);
    assert.equal((await put({ kind: 'dm', peerId: 123, pinned: true })).status, 400);
    assert.equal((await put({ kind: 'dm', peerId: 'x'.repeat(65), pinned: true })).status, 400);
    assert.equal((await put({ kind: 'dm', peerId: a.userId, pinned: true })).status, 400); // 自分自身
    assert.equal((await put({ kind: 'dm', peerId: b.userId })).status, 400); // 何も変えない
    assert.equal((await put({ kind: 'dm', peerId: b.userId, pinned: 'yes' })).status, 400);
    assert.equal((await put({ kind: 'dm', peerId: b.userId, muted: 1 })).status, 400);
    assert.equal((await put({ kind: 'dm', peerId: b.userId, hidden: null })).status, 400);
    assert.equal((await put([1, 2])).status, 400);
    assert.equal((await a.call('POST', '/api/chat-prefs/clear', { kind: 'x', peerId: b.userId })).status, 400);
    assert.equal((await a.call('POST', '/api/chat-prefs/clear', { kind: 'dm' })).status, 400);
    assert.equal((await a.call('POST', '/api/chat-prefs/clear', {})).status, 400);
    assert.deepEqual((await a.call('GET', '/api/chat-prefs')).data.prefs, []);
  });

  test('退会した相手の設定は残らない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    await a.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: b.userId, pinned: true });
    await b.call('PUT', '/api/chat-prefs', { kind: 'dm', peerId: a.userId, muted: true });
    assert.equal((await b.call('POST', '/api/auth/delete-account', { password: b.password })).status, 200);
    assert.equal(await prefOf(a, 'dm', b.userId), undefined);
  });
});

// ---- このプロセスの中で、通知の止め方(utils/chatPrefs.js)を確かめる ----
describe('ミュートした人には通知を送らない(共通ヘルパー)', () => {
  const db = require('../db/db');
  let cp;
  before(async () => {
    await db.initDB();
    cp = require('../utils/chatPrefs');
    const ins = (u, kind, peer, muted) => db.run(
      'INSERT INTO chat_prefs (user_id, kind, peer_id, muted) VALUES (?, ?, ?, ?)', [u, kind, peer, muted]);
    await ins('u_mute', 'dm', 'peer1', true);
    await ins('u_mute', 'group', 'g1', true);
    await ins('u_plain', 'dm', 'peer1', false);
    await ins('u_other', 'dm', 'peer2', true);
    await ins('u_g2', 'group', 'g1', true);
    await ins('u_g3', 'group', 'g1', false);
  });

  test('isMuted: ミュートしたチャットだけ true。種類・相手が違えば false', async () => {
    assert.equal(await cp.isMuted('u_mute', 'dm', 'peer1'), true);
    assert.equal(await cp.isMuted('u_mute', 'group', 'g1'), true);
    assert.equal(await cp.isMuted('u_mute', 'dm', 'g1'), false);
    assert.equal(await cp.isMuted('u_mute', 'group', 'peer1'), false);
    assert.equal(await cp.isMuted('u_mute', 'dm', 'peer2'), false);
    assert.equal(await cp.isMuted('u_plain', 'dm', 'peer1'), false);
    assert.equal(await cp.isMuted('u_nobody', 'dm', 'peer1'), false);
    assert.equal(await cp.isMuted(undefined, 'dm', 'peer1'), false);
  });

  test('mutedUserIds: グループの全メンバーを1回で引き、ミュートした人だけ返す', async () => {
    const s = await cp.mutedUserIds(['u_mute', 'u_g2', 'u_g3', 'u_nobody'], 'group', 'g1');
    assert.deepEqual([...s].sort(), ['u_g2', 'u_mute']);
    assert.equal((await cp.mutedUserIds([], 'group', 'g1')).size, 0);
    assert.equal((await cp.mutedUserIds(['u_other'], 'group', 'g1')).size, 0);
  });

  test('呼び出し側がミュートを見ている(通知の送信箇所が isMuted / mutedUserIds を通る)', () => {
    const root = path.join(__dirname, '..');
    const msg = fs.readFileSync(path.join(root, 'routes/messages.js'), 'utf8');
    const grp = fs.readFileSync(path.join(root, 'routes/groups.js'), 'utf8');
    assert.match(msg, /chatPrefs\.isMuted\(recipientId, 'dm', req\.userId\)/);
    assert.match(grp, /chatPrefs\.mutedUserIds\(/);
    // 通話の着信・不在着信はミュートの対象にしない
    const ws = fs.readFileSync(path.join(root, 'ws/wsServer.js'), 'utf8');
    assert.ok(!/chatPrefs|isMuted/.test(ws));
  });

  test('時刻の変換と一覧の hidden 判定', () => {
    assert.equal(cp.toMs('2026-01-02 03:04:05'), Date.UTC(2026, 0, 2, 3, 4, 5));
    assert.equal(cp.toMs('2026-01-02T03:04:05.123Z'), Date.UTC(2026, 0, 2, 3, 4, 5, 123));
    assert.equal(cp.toMs(new Date(5000)), 5000);
    assert.equal(cp.toMs(null), 0);
    const pref = { pinnedAt: 5, muted: true, hiddenAt: 1000, clearedAt: 0 };
    assert.deepEqual(cp.listFields(pref, 900), { pinnedAt: 5, muted: true, hidden: true });
    assert.equal(cp.listFields(pref, 1000).hidden, true);
    assert.equal(cp.listFields(pref, 1001).hidden, false);
    assert.equal(cp.listFields({ ...pref, hiddenAt: null }, 0).hidden, false);
  });
});
