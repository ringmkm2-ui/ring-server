// スタンプ(自作パック・ショップ・マイスタンプ・お気に入り)のサーバー側
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => { S && S.stop(); });

// 1x1の透明PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('スタンプ', () => {
  test('最初は公式パックだけが既定の順で入っている', async () => {
    const a = await S.user('A');
    const r = await a.call('GET', '/api/stickers/mine');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.order, ['b:neko', 'b:usa', 'b:kuma', 'b:msg']);
    assert.deepEqual(r.data.hidden, []);
    assert.deepEqual(r.data.packs, []);
    assert.deepEqual(r.data.favs, []);
  });

  test('作る → 画像を足す → 他の人がショップで見つけて追加 → 届いたスタンプを引ける', async () => {
    const a = await S.user('作者'); const b = await S.user('B');
    const p = await a.call('POST', '/api/stickers/packs', { title: 'テストねこ', description: 'ゆるい' });
    assert.equal(p.status, 200);
    assert.equal(p.data.mine, true);
    assert.equal(p.data.added, true, '作った人のマイスタンプには最初から入る');

    const s1 = await a.call('POST', `/api/stickers/packs/${p.data.id}/stickers`, { dataUrl: PNG, label: 'おはよ', keywords: ['おはよう', 'morning', 'おはよう'] });
    assert.equal(s1.status, 200, JSON.stringify(s1.data));
    assert.match(s1.data.url, /^https?:\/\//);
    assert.deepEqual(s1.data.keywords, ['おはよう', 'morning']);
    const s2 = await a.call('POST', `/api/stickers/packs/${p.data.id}/stickers`, { dataUrl: PNG, label: 'ねる' });
    assert.equal(s2.status, 200);

    // 他人は変更できない
    assert.equal((await b.call('POST', `/api/stickers/packs/${p.data.id}/stickers`, { dataUrl: PNG })).status, 403);
    assert.equal((await b.call('PATCH', `/api/stickers/packs/${p.data.id}`, { title: 'x' })).status, 403);
    assert.equal((await b.call('DELETE', `/api/stickers/packs/${p.data.id}`)).status, 403);

    // 画像以外は通さない
    assert.equal((await a.call('POST', `/api/stickers/packs/${p.data.id}/stickers`, { dataUrl: 'data:text/html;base64,PGI+' })).status, 400);

    const shop = await b.call('GET', '/api/stickers/shop?q=' + encodeURIComponent('おはよう'));
    assert.equal(shop.status, 200);
    const found = shop.data.packs.find(x => x.id === p.data.id);
    assert.ok(found, 'キーワードで見つかる');
    assert.equal(found.count, 2);
    assert.equal(found.added, false);

    assert.equal((await b.call('POST', `/api/stickers/mine/${p.data.id}`)).status, 200);
    const mine = await b.call('GET', '/api/stickers/mine');
    assert.equal(mine.data.packs.length, 1);
    assert.equal(mine.data.packs[0].stickers.length, 2);
    assert.equal(mine.data.order[mine.data.order.length - 1], p.data.id);
    assert.equal((await b.call('GET', `/api/stickers/packs/${p.data.id}`)).data.addCount, 1);

    const look = await b.call('GET', `/api/stickers/s?ids=${s1.data.id},${s2.data.id},not-a-uuid`);
    assert.equal(look.data.stickers.length, 2);

    // 並び替え
    const re = await a.call('PATCH', `/api/stickers/packs/${p.data.id}`, { order: [s2.data.id, s1.data.id], isPublic: false });
    assert.deepEqual(re.data.stickers.map(x => x.id), [s2.data.id, s1.data.id]);
    assert.equal(re.data.isPublic, false);
    // 非公開はショップに出ない(IDを知っていれば見られる)
    assert.ok(!(await b.call('GET', '/api/stickers/shop')).data.packs.some(x => x.id === p.data.id));
    assert.equal((await b.call('GET', `/api/stickers/packs/${p.data.id}`)).status, 200);

    // 外す → 数が戻る
    await b.call('DELETE', `/api/stickers/mine/${p.data.id}`);
    assert.equal((await b.call('GET', '/api/stickers/mine')).data.packs.length, 0);
    assert.equal((await b.call('GET', `/api/stickers/packs/${p.data.id}`)).data.addCount, 0);

    // パックを消すと、もう追加できない。送ってあったスタンプの絵は引ける
    await b.call('POST', `/api/stickers/mine/${p.data.id}`);
    assert.equal((await a.call('DELETE', `/api/stickers/packs/${p.data.id}`)).status, 200);
    assert.equal((await b.call('GET', '/api/stickers/mine')).data.packs.length, 0);
    assert.equal((await b.call('POST', `/api/stickers/mine/${p.data.id}`)).status, 404);
    assert.equal((await b.call('GET', `/api/stickers/s?ids=${s1.data.id}`)).data.stickers.length, 1);
  });

  test('公式パックの並び替え・非表示、お気に入り', async () => {
    const a = await S.user('A');
    const r = await a.call('PUT', '/api/stickers/mine', { order: ['b:msg', 'b:neko', 'b:usa', 'b:kuma'], hidden: ['b:kuma'] });
    assert.equal(r.status, 200);
    let mine = (await a.call('GET', '/api/stickers/mine')).data;
    assert.deepEqual(mine.order, ['b:msg', 'b:neko', 'b:usa', 'b:kuma']);
    assert.deepEqual(mine.hidden, ['b:kuma']);
    await a.call('POST', '/api/stickers/mine/b:kuma');
    mine = (await a.call('GET', '/api/stickers/mine')).data;
    assert.deepEqual(mine.hidden, []);

    const f = await a.call('PUT', '/api/stickers/favs', { keys: ['ok', 'u:00000000-0000-4000-8000-000000000000', 'ok', '<script>', 'u:bad'] });
    assert.equal(f.status, 200);
    assert.deepEqual(f.data.favs, ['ok', 'u:00000000-0000-4000-8000-000000000000']);
    assert.deepEqual((await a.call('GET', '/api/stickers/mine')).data.favs, f.data.favs);
  });

  test('名前が無いパックは作れない・ログインしていないと使えない', async () => {
    const a = await S.user('A');
    assert.equal((await a.call('POST', '/api/stickers/packs', { title: '   ' })).status, 400);
    assert.equal((await S.req('GET', '/api/stickers/mine')).status, 401);
  });
});
