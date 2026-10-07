// サーバーを落とせる・他人の情報が見える 系の穴が塞がっているかのテスト
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

describe('大きすぎるデータ', () => {
  test('投稿の画像は Cloudinary のURLだけ(Base64の直書きは不可)', async () => {
    const a = await S.user('A');
    const big = 'data:image/png;base64,' + 'A'.repeat(1000);
    assert.equal((await a.call('POST', '/api/posts', { text: 'x', mediaUrl: big, mediaType: 'image' })).status, 400);
    const ok = await a.call('POST', '/api/posts', { text: 'x', mediaUrl: 'https://res.cloudinary.com/demo/image/upload/v1/brochat/posts/a.jpg', mediaType: 'image' });
    assert.equal(ok.status, 200);
  });

  test('メッセージ本文にBase64のメディアを直接入れる古い形式は不可', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const r = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: '[画像]', mediaType: 'image', mediaData: 'data:image/png;base64,AAAA' });
    assert.equal(r.status, 400);
  });

  test('コメントが文字列でなくても500にならない', async () => {
    const a = await S.user('A');
    const p = await a.call('POST', '/api/posts', { text: 'hello' });
    const r = await a.call('POST', `/api/posts/${p.data.post.id}/comments`, { text: ['x'] });
    assert.equal(r.status, 400);
  });

  test('同時に掛けられる電話は3本まで(呼び出し情報でメモリを埋められない)', async () => {
    const a = await S.user('A');
    const friends = [];
    for (let i = 0; i < 4; i++) { const f = await S.user('F' + i); await S.befriend(a, f); friends.push(f); }
    const wa = await S.connect(a);
    try {
      friends.forEach((f, i) => wa.send({ type: 'call_offer', recipientId: f.userId, callId: 'cap' + i + Date.now(), sdp: { type: 'offer', sdp: 'v=0' } }));
      await sleep(600);
      const refused = wa.msgs.filter(m => m.type === 'call_unavailable');
      assert.equal(refused.length, 1, JSON.stringify(wa.msgs.map(m => m.type)));
      // 大きすぎる呼び出し情報は無視される
      const before = wa.msgs.length;
      wa.send({ type: 'call_offer', recipientId: friends[0].userId, callId: 'huge' + Date.now(), sdp: { type: 'offer', sdp: 'x'.repeat(40000) } });
      await sleep(300);
      assert.equal(wa.msgs.length, before);
    } finally {
      wa.msgs.forEach(() => {});
      wa.close();
    }
  });

  test('WebSocketの古い直接中継(message / group_message)はもう何もしない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    const wa = await S.connect(a);
    try {
      wa.send({ type: 'message', recipientId: b.userId, payload: { x: 'y'.repeat(1000) }, msgUuid: 'm1' });
      await sleep(300);
      assert.ok(!wa.msgs.some(m => m.type === 'sent_ack'));
      // bが後から繋いでも何も届かない(DBに積まれていない)
      const wb = await S.connect(b);
      await sleep(300);
      assert.ok(!wb.msgs.some(m => m.type === 'message'));
      wb.close();
    } finally { wa.close(); }
  });
});

describe('変な入力で500にならない', () => {
  test('before に配列や日時でない文字列を入れても500にならない', async () => {
    const a = await S.user('A'); const b = await S.user('B');
    await S.befriend(a, b);
    for (const q of ['before[]=1&before[]=2', 'before=not-a-date', "before=2026-01-01'"]) {
      assert.notEqual((await a.call('GET', '/api/posts?' + q)).status, 500, q);
      assert.notEqual((await a.call('GET', '/api/messages/history/' + b.userId + '?' + q)).status, 500, q);
    }
  });
});

describe('他人の情報', () => {
  test('通話メモに知らない人のIDを入れても、その人の名前や写真は出ない', async () => {
    const a = await S.user('A'); const stranger = await S.user('Stranger');
    const r = await a.call('POST', '/api/call-assist/notes', { callId: 'c-' + Date.now(), otherId: stranger.userId, content: 'memo' });
    if (r.status === 404) return; // この環境で通話メモが無効なら対象外
    const list = await a.call('GET', '/api/call-assist/notes');
    assert.ok(!JSON.stringify(list.data).includes('Stranger'));
  });

  test('使っていないGoogle連絡先同期は止めてある', async () => {
    const a = await S.user('A');
    assert.equal((await a.call('POST', '/api/auth/google-contacts/sync', { accessToken: 'x' })).status, 410);
  });

  test('Googleログイン(アプリ): 確認番号がアプリ側とブラウザ側で同じ', async () => {
    const st = await S.req('POST', '/api/auth/google/app-start', { body: {} });
    assert.equal(st.status, 200);
    assert.match(String(st.data.code), /^\d{4}$/);
    const c = await S.req('GET', '/api/auth/google/app-code?state=' + st.data.state);
    assert.equal(c.data.code, st.data.code);
    // 確認番号を出すAPIからはトークンも pollKey も出ない
    assert.ok(!('pollKey' in c.data));
  });
});
