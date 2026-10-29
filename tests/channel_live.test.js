const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

test('チャンネル情報: 登録者・動画数・総再生回数・登録日・自己紹介が返り、ブロック相手は404', async () => {
  const a = await S.user('Chan A'); const b = await S.user('Chan B'); const c = await S.user('Chan C');
  const v = (await a.call('POST', '/api/posts', { text: 'vid', mediaUrl: 'https://res.cloudinary.com/a6rxinoz/video/upload/v1/x/vid1', mediaType: 'video', durationSec: 30 })).data.post;
  await a.call('POST', '/api/posts', { text: 'pic', mediaUrl: 'https://res.cloudinary.com/a6rxinoz/image/upload/v1/x/img1.jpg', mediaType: 'image' });
  await a.call('POST', '/api/posts', { text: 'plain' });
  await b.call('POST', `/api/posts/${v.id}/view`);
  await c.call('POST', `/api/posts/${v.id}/view`);
  await b.call('POST', `/api/posts/channel/${a.userId}/subscribe`);
  const r = await b.call('GET', `/api/posts/channel/${a.userId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Chan A');
  assert.equal(r.data.postCount, 3);
  assert.equal(r.data.videoCount, 1);
  assert.equal(r.data.imageCount, 1);
  assert.equal(r.data.totalViews, 2);
  assert.equal(r.data.subscriberCount, 1);
  assert.equal(r.data.subscribedByMe, true);
  assert.ok(r.data.joinedAt, '登録日');
  assert.equal(typeof r.data.bio, 'string');
  assert.ok(!('handle' in r.data) && !('userIdCode' in r.data), '友だち追加用のIDは出さない');
  // 自分のチャンネルも見られる
  assert.equal((await a.call('GET', `/api/posts/channel/${a.userId}`)).data.subscribedByMe, false);
  // ?channel= で投稿者の投稿だけ
  const list = (await b.call('GET', `/api/posts?channel=${a.userId}&limit=50`)).data;
  assert.equal(list.length, 3);
  assert.ok(list.every(p => p.authorId === a.userId));
  // ブロックしたら存在しない扱い
  await b.call('POST', '/api/friends/block', { userId: a.userId });
  assert.equal((await b.call('GET', `/api/posts/channel/${a.userId}`)).status, 404);
  assert.equal((await a.call('GET', `/api/posts/channel/${b.userId}`)).status, 404);
  assert.equal((await b.call('GET', '/api/posts/channel/nonexistent-id')).status, 404);
});

test('ライブ一覧: 配信者の名前・アイコン・登録者数・登録済みが付く', async () => {
  const host = await S.user('Live Host'); const viewer = await S.user('Live Viewer');
  await viewer.call('POST', `/api/posts/channel/${host.userId}/subscribe`);
  const ws = await S.connect(host);
  try {
    ws.send({ type: 'live_start', groupId: 'u:' + host.userId });
    let mine = null;
    for (let i = 0; i < 20 && !mine; i++) {
      await sleep(150);
      const r = await viewer.call('GET', '/api/live/active');
      assert.equal(r.status, 200);
      mine = r.data.find(l => l.hostId === host.userId);
    }
    assert.ok(mine, 'ライブが一覧に出る');
    assert.equal(mine.hostName, 'Live Host');
    assert.ok('hostPic' in mine);
    assert.equal(mine.subscriberCount, 1);
    assert.equal(mine.subscribedByMe, true);
    assert.equal(mine.key, 'u:' + host.userId);
    // 登録していない人には subscribedByMe=false
    const other = await S.user('Other');
    assert.equal((await other.call('GET', '/api/live/active')).data.find(l => l.hostId === host.userId).subscribedByMe, false);
  } finally { ws.close(); }
});

test('アカウント欄: いいねした投稿・登録チャンネル・登録者・いいねした人(本人だけ)', async () => {
  const a = await S.user('Acct A'); const b = await S.user('Acct B'); const c = await S.user('Acct C');
  const pa = (await a.call('POST', '/api/posts', { text: 'A post 1' })).data.post;
  const pa2 = (await a.call('POST', '/api/posts', { text: 'A post 2' })).data.post;
  const pc = (await c.call('POST', '/api/posts', { text: 'C post' })).data.post;
  // B が2つにいいね、A と C を登録
  await b.call('POST', `/api/posts/${pa.id}/like`);
  await sleep(1100); // いいね順(created_at は秒精度)を確かめるため
  await b.call('POST', `/api/posts/${pc.id}/like`);
  await b.call('POST', `/api/posts/channel/${a.userId}/subscribe`);
  await b.call('POST', `/api/posts/channel/${c.userId}/subscribe`);
  await c.call('POST', `/api/posts/${pa.id}/like`);

  // いいねした投稿は新しい順
  const liked = (await b.call('GET', '/api/posts/liked')).data;
  assert.deepEqual(liked.map(p => p.id), [pc.id, pa.id]);
  assert.equal(liked[0].likedByMe, true);
  assert.deepEqual((await a.call('GET', '/api/posts/liked')).data, [], '自分がいいねしていなければ空');
  // 登録チャンネル
  const subs = (await b.call('GET', '/api/posts/subscriptions')).data;
  assert.equal(subs.length, 2);
  assert.ok(subs.some(s => s.id === a.userId && s.name === 'Acct A' && s.subscriberCount === 1));
  // 登録者は本人だけ
  const who = await a.call('GET', `/api/posts/channel/${a.userId}/subscribers`);
  assert.equal(who.status, 200);
  assert.deepEqual(who.data.map(u => u.id), [b.userId]);
  assert.equal((await b.call('GET', `/api/posts/channel/${a.userId}/subscribers`)).status, 403);
  // いいねした人は投稿者本人だけ
  const likers = await a.call('GET', `/api/posts/${pa.id}/likes`);
  assert.equal(likers.status, 200);
  assert.deepEqual(likers.data.map(u => u.id).sort(), [b.userId, c.userId].sort());
  assert.equal((await b.call('GET', `/api/posts/${pa.id}/likes`)).status, 403);
  assert.equal((await a.call('GET', `/api/posts/${pa2.id}/likes`)).data.length, 0);
  assert.equal((await a.call('GET', '/api/posts/nope/likes')).status, 404);
  // ブロックしたら一覧から消える
  await a.call('POST', '/api/friends/block', { userId: b.userId });
  assert.deepEqual((await a.call('GET', `/api/posts/channel/${a.userId}/subscribers`)).data, []);
  assert.ok(!(await a.call('GET', `/api/posts/${pa.id}/likes`)).data.some(u => u.id === b.userId));
  assert.ok(!(await b.call('GET', '/api/posts/subscriptions')).data.some(s => s.id === a.userId));
  assert.ok(!(await b.call('GET', '/api/posts/liked')).data.some(p => p.id === pa.id));
});

test('いいねされた: 自分の投稿に来たいいねが 誰が・どの投稿に で返る(自分/ブロック/消した投稿は除く)', async () => {
  const a = await S.user('Recv A'); const b = await S.user('Recv B'); const c = await S.user('Recv C');
  const p1 = (await a.call('POST', '/api/posts', { text: 'mine 1' })).data.post;
  const p2 = (await a.call('POST', '/api/posts', { text: 'mine 2' })).data.post;
  const other = (await b.call('POST', '/api/posts', { text: 'B own' })).data.post;
  await b.call('POST', `/api/posts/${p1.id}/like`);
  await c.call('POST', `/api/posts/${p1.id}/like`);
  await c.call('POST', `/api/posts/${p2.id}/like`);
  await a.call('POST', `/api/posts/${p1.id}/like`);       // 自分で自分にしたいいねは数えない
  await a.call('POST', `/api/posts/${other.id}/like`);    // 他人の投稿へのいいねは対象外
  let r = (await a.call('GET', '/api/posts/likes-received')).data;
  assert.equal(r.total, 3);
  assert.equal(r.items.length, 3);
  assert.ok(r.items.every(i => i.user.id !== a.userId && i.post.authorId === a.userId));
  assert.ok(r.items.some(i => i.user.id === b.userId && i.post.id === p1.id && i.user.name === 'Recv B'));
  const rb = (await b.call('GET', '/api/posts/likes-received')).data;
  assert.equal(rb.total, 1, 'b には a のいいね1件だけ');
  assert.equal(rb.items[0].user.id, a.userId);
  assert.deepEqual((await c.call('GET', '/api/posts/likes-received')).data, { total: 0, items: [] }, 'c は何もいいねされていない');
  // 消した投稿とブロックした人は除く
  await a.call('DELETE', `/api/posts/${p2.id}`);
  await a.call('POST', '/api/friends/block', { userId: b.userId });
  r = (await a.call('GET', '/api/posts/likes-received')).data;
  assert.equal(r.total, 1);
  assert.deepEqual(r.items.map(i => i.user.id), [c.userId]);
});
