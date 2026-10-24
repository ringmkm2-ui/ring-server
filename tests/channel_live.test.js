const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

test('チャンネル情報: 登録者・動画数・総再生回数・登録日・自己紹介が返り、ブロック相手は404', async () => {
  const a = await S.user('Chan A'); const b = await S.user('Chan B'); const c = await S.user('Chan C');
  const v = (await a.call('POST', '/api/posts', { text: 'vid', mediaUrl: 'https://res.cloudinary.com/demo/video/upload/v1/x/vid1', mediaType: 'video', durationSec: 30 })).data.post;
  await a.call('POST', '/api/posts', { text: 'pic', mediaUrl: 'https://res.cloudinary.com/demo/image/upload/v1/x/img1.jpg', mediaType: 'image' });
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
