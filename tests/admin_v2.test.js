// 管理Exe v2 用API (adminApi = 2) のテスト。サーバーは1台を使い回し、上から順に進める。
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

const KEY = 'admin-v2-test-key-0123456789abcdef';
const TAG = 'Tg' + Math.random().toString(36).slice(2, 7);
let S;
const U = {}; // alice, bob, carol

// 管理APIを叩く。ip を変えると失敗回数(IP単位)が別枠になる
async function adm(method, p, body, { key = KEY, ip = '9.9.9.9' } = {}) {
  const headers = { 'x-forwarded-for': ip, 'content-type': 'application/json' };
  if (key !== null) headers['x-admin-key'] = key;
  const x = await fetch(S.base + '/api/admin' + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await x.json(); } catch (_) {}
  return { status: x.status, data };
}
async function login(u) {
  const r = await S.req('POST', '/api/auth/login', { ip: u.ip, body: { username: u.username, password: u.password } });
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.data.token;
}
const callWith = (u, token) => (m, p, body) => S.req(m, p, { token, body, ip: u.ip });

test.before(async () => {
  S = await startServer({ ADMIN_API_KEY: KEY });
  U.alice = await S.user(`Zed ${TAG} Alice`);
  U.bob = await S.user(`Abe ${TAG} Bob`);
  U.carol = await S.user(`Mid ${TAG} Carol`);
});
test.after(async () => { if (S) await S.stop(); });

test('鍵なし・間違いは401、ADMIN_API_KEY未設定は404', async () => {
  const paths = [
    ['GET', '/stats'], ['GET', '/users'], ['GET', '/users/x'], ['GET', '/online'], ['GET', '/posts'], ['GET', '/audit'],
    ['POST', '/users/x/ban'], ['POST', '/users/x/sessions/y/revoke'], ['POST', '/posts/x/delete'], ['POST', '/posts/x/restore'],
  ];
  let n = 0;
  for (const [m, p] of paths) {
    // 失敗回数はIP単位(15分に10回)なので、毎回別のIPから叩く
    const none = await adm(m, p, m === 'POST' ? {} : undefined, { key: null, ip: `8.8.${n}.1` });
    const bad = await adm(m, p, m === 'POST' ? {} : undefined, { key: KEY + 'x', ip: `8.8.${n}.2` });
    n++;
    assert.equal(none.status, 401, m + ' ' + p);
    assert.equal(bad.status, 401, m + ' ' + p);
  }
  const S2 = await startServer({});
  try {
    const x = await fetch(S2.base + '/api/admin/audit', { headers: { 'x-admin-key': KEY } });
    assert.equal(x.status, 404);
  } finally { await S2.stop(); }
});

test('stats: 追加項目が入っていて、既存の項目も残っている', async () => {
  const ws = await S.connect(U.alice);
  try {
    const r = await adm('GET', '/stats');
    assert.equal(r.status, 200);
    const d = r.data;
    assert.equal(d.adminApi, 3);
    for (const k of ['version', 'uptimeSec', 'memoryMB', 'users', 'online', 'messages', 'groupMessages', 'groups', 'posts', 'activeSessions']) assert.ok(k in d, k);
    assert.ok(d.newUsers24h >= 3, 'newUsers24h=' + d.newUsers24h);
    assert.ok(d.newUsers7d >= d.newUsers24h);
    assert.equal(d.openReports, 0);
    assert.equal(d.bannedUsers, 0);
    assert.equal(typeof d.dbMs, 'number');
    assert.ok(d.dbMs >= 0);
    assert.ok(d.wsConnections >= 1, 'wsConnections=' + d.wsConnections);
    assert.ok(d.online >= 1);
  } finally { ws.close(); }
});

test('users: 形・ページング・検索・並べ替え', async () => {
  const r = await adm('GET', '/users?q=' + encodeURIComponent(TAG));
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 3);
  assert.equal(r.data.users.length, 3);
  const a = r.data.users.find(u => u.id === U.alice.userId);
  assert.ok(a);
  assert.equal(a.userId, U.alice.userIdCode);
  assert.equal(a.username, U.alice.username);
  assert.match(a.displayName, /Alice/);
  assert.equal(a.realName, '山田 太郎');
  assert.equal(a.banned, false);
  assert.equal(a.bannedUntil, null);
  assert.equal(a.banReason, null);
  assert.equal(a.locked, false);
  assert.equal(a.failedLogins, 0);
  assert.equal(typeof a.emailVerified, 'boolean');
  assert.equal(a.googleOnly, false);
  assert.equal(a.totp, false);
  assert.ok(a.createdAt);
  assert.ok(a.lastSeen, '登録でセッションができているので lastSeen がある');

  // 名前順
  const asc = await adm('GET', '/users?sort=name&order=asc&q=' + TAG);
  assert.deepEqual(asc.data.users.map(u => u.id), [U.bob, U.carol, U.alice].map(u => u.userId));
  const desc = await adm('GET', '/users?sort=name&order=desc&q=' + TAG);
  assert.deepEqual(desc.data.users.map(u => u.id), [U.alice, U.carol, U.bob].map(u => u.userId));

  // ページング: total は変わらず、ページごとに別の人
  const p1 = await adm('GET', '/users?sort=name&order=asc&limit=2&offset=0&q=' + TAG);
  const p2 = await adm('GET', '/users?sort=name&order=asc&limit=2&offset=2&q=' + TAG);
  assert.equal(p1.data.total, 3);
  assert.equal(p2.data.total, 3);
  assert.equal(p1.data.users.length, 2);
  assert.equal(p2.data.users.length, 1);
  assert.deepEqual([...p1.data.users, ...p2.data.users].map(u => u.id), asc.data.users.map(u => u.id));

  // 作成順・最終アクセス順は200で3人とも返る
  for (const s of ['created', 'lastSeen']) for (const o of ['asc', 'desc']) {
    const x = await adm('GET', `/users?sort=${s}&order=${o}&q=${TAG}`);
    assert.equal(x.status, 200, s + o);
    assert.equal(x.data.users.length, 3);
  }
  const created = (await adm('GET', `/users?sort=created&order=asc&q=${TAG}`)).data.users.map(u => u.createdAt);
  assert.deepEqual(created, [...created].sort());

  // 検索: IDコード(小文字でも)・本名・表示名の一部。LIKEの記号は文字として扱う
  assert.equal((await adm('GET', '/users?q=' + U.bob.userIdCode)).data.users.map(u => u.id).join(), U.bob.userId);
  assert.equal((await adm('GET', '/users?q=' + encodeURIComponent('山田') + '&limit=200')).data.users.length >= 3, true);
  assert.equal((await adm('GET', '/users?q=%25')).data.total, 0);
  assert.equal((await adm('GET', '/users?q=' + TAG + 'zzz')).data.total, 0);

  // 範囲外の値は丸める
  const big = await adm('GET', '/users?limit=100000&offset=-5&sort=bogus&order=bogus&filter=bogus');
  assert.equal(big.status, 200);
  assert.ok(big.data.users.length <= 200);
  assert.equal((await adm('GET', '/users?limit=0')).data.users.length, 1);
});

test('users: online フィルターと /online', async () => {
  const ws = await S.connect(U.bob);
  try {
    const f = await adm('GET', '/users?filter=online&q=' + TAG);
    assert.equal(f.data.total, 1);
    assert.equal(f.data.users[0].id, U.bob.userId);
    assert.equal(f.data.users[0].online, true);

    const o = await adm('GET', '/online');
    assert.equal(o.status, 200);
    assert.equal(o.data.count, o.data.users.length);
    const me = o.data.users.find(u => u.id === U.bob.userId);
    assert.ok(me);
    assert.equal(me.userId, U.bob.userIdCode);
    assert.match(me.displayName, /Bob/);
    assert.equal(me.realName, '山田 太郎');
    assert.equal(me.devices, 1);
    assert.equal(typeof me.since, 'number');

    // 2台目がつながると devices が増え、since は新しい順
    const ws2 = await S.connect(U.alice);
    try {
      const o2 = await adm('GET', '/online');
      assert.equal(o2.data.users.find(u => u.id === U.bob.userId).devices, 1);
      const ids = o2.data.users.map(u => u.id);
      assert.ok(ids.indexOf(U.alice.userId) < ids.indexOf(U.bob.userId), 'since降順');
      for (let i = 1; i < o2.data.users.length; i++) assert.ok(o2.data.users[i - 1].since >= o2.data.users[i].since);
    } finally { ws2.close(); }
  } finally { ws.close(); }
  await sleep(500);
  assert.equal((await adm('GET', '/users?filter=online&q=' + TAG)).data.total, 0);
});

test('users: locked フィルター。unlockで外れる', async () => {
  const v = U.carol;
  for (let i = 0; i < 25; i++) for (let j = 0; j < 2; j++) {
    await S.req('POST', '/api/auth/login', { ip: `10.61.${i}.1`, body: { username: v.username, password: 'wrongwrong' + j } });
  }
  const f = await adm('GET', '/users?filter=locked&q=' + TAG);
  assert.equal(f.data.total, 1);
  assert.equal(f.data.users[0].id, v.userId);
  assert.equal(f.data.users[0].locked, true);
  assert.ok(f.data.users[0].failedLogins >= 50);
  assert.equal((await adm('POST', `/users/${v.userId}/unlock`)).status, 200);
  assert.equal((await adm('GET', '/users?filter=locked&q=' + TAG)).data.total, 0);
});

test('users/:id: id でも IDコードでも引ける。件数・セッション・通報', async () => {
  const { alice, bob } = U;
  await S.befriend(alice, bob);
  const post = await alice.call('POST', '/api/posts', { text: `詳細テスト ${TAG}` });
  assert.equal(post.status, 200);
  const tok2 = await login(alice); // 2つ目のセッション
  assert.equal((await bob.call('POST', '/api/reports', { kind: 'user', targetUserId: alice.userId, category: 'spam', message: 'しつこい人です' })).status, 200);
  assert.equal((await alice.call('POST', '/api/reports', { kind: 'user', targetUserId: bob.userId, category: 'other', message: 'やり返しです' })).status, 200);
  assert.ok(tok2);

  const byId = await adm('GET', '/users/' + alice.userId);
  const byCode = await adm('GET', '/users/' + alice.userIdCode);
  assert.equal(byId.status, 200);
  assert.deepEqual(byCode.data, byId.data);
  const d = byId.data;
  assert.equal(d.user.id, alice.userId);
  assert.equal(d.user.userId, alice.userIdCode);
  assert.ok('bio' in d.user && 'profilePic' in d.user);
  assert.equal(typeof d.user.emailVerified, 'boolean');
  assert.equal(d.counts.posts, 1);
  assert.equal(d.counts.friends, 1);
  assert.equal(d.counts.groups, 0);
  assert.equal(typeof d.counts.sentMessages, 'number');
  assert.ok(d.sessions.length >= 2);
  for (const s of d.sessions) {
    assert.ok(s.id);
    assert.equal(s.revoked, false);
    for (const k of ['device', 'ip', 'createdAt', 'lastSeenAt']) assert.ok(k in s, k);
  }
  assert.equal(d.reportsAgainst.length, 1);
  assert.equal(d.reportsAgainst[0].message, 'しつこい人です');
  assert.equal(d.reportsAgainst[0].target.id, alice.userId);
  assert.equal(d.reportsBy.length, 1);
  assert.equal(d.reportsBy[0].message, 'やり返しです');
  for (const k of ['id', 'kind', 'category', 'status', 'createdAt', 'mediaUrls', 'reporter', 'target']) assert.ok(k in d.reportsBy[0], k);

  assert.equal((await adm('GET', '/users/no-such-user')).status, 404);
  assert.equal((await adm('GET', '/users/no-such-user')).data.error, 'ユーザーが見つかりません');

  // /reports は従来どおり
  const rep = await adm('GET', '/reports?status=open');
  assert.equal(rep.status, 200);
  assert.equal(rep.data.reports.length, 2);
  assert.equal((await adm('GET', '/stats')).data.openReports, 2);
});

test('ban: そのユーザーのAPIとWSが止まり、unbanで戻る。入力チェックと一覧', async () => {
  const { alice } = U;
  const ws = await S.connect(alice);
  try {
    assert.equal((await alice.call('GET', '/api/friends/list')).status, 200);

    for (const hours of [0, -1, 1.5, '5', null, 87601, undefined]) {
      const r = await adm('POST', `/users/${alice.userId}/ban`, { hours, reason: 'x' });
      assert.equal(r.status, 400, 'hours=' + hours);
    }
    assert.equal((await adm('POST', `/users/${alice.userId}/ban`, { hours: 2, reason: 123 })).status, 400);
    assert.equal((await adm('POST', '/users/no-such-user/ban', { hours: 2 })).status, 404);
    assert.equal((await alice.call('GET', '/api/friends/list')).status, 200, '不正な入力では止まらない');

    const t0 = Date.now();
    const r = await adm('POST', `/users/${alice.userIdCode}/ban`, { hours: 72, reason: '荒らし' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.ok(Math.abs(r.data.bannedUntil - (t0 + 72 * 3600000)) < 60000);

    const blocked = await alice.call('GET', '/api/friends/list');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.banned, true);
    assert.equal(blocked.data.bannedUntil, r.data.bannedUntil);
    assert.equal((await alice.call('GET', '/api/posts')).status, 403);
    // 接続中のWSには banned が届く
    const gotBanned = await (async () => { const end = Date.now() + 3000; while (Date.now() < end) { if (ws.msgs.some(m => m.type === 'banned')) return true; await sleep(50); } return false; })();
    assert.ok(gotBanned, 'WSにbannedが届かない');

    const list = await adm('GET', '/users?filter=banned&q=' + TAG);
    assert.equal(list.data.total, 1);
    assert.equal(list.data.users[0].id, alice.userId);
    assert.equal(list.data.users[0].banned, true);
    assert.equal(list.data.users[0].bannedUntil, r.data.bannedUntil);
    assert.equal(list.data.users[0].banReason, '荒らし');
    assert.equal((await adm('GET', '/stats')).data.bannedUsers, 1);
    assert.equal((await adm('GET', '/users/' + alice.userId)).data.user.banned, true);

    assert.equal((await adm('POST', `/users/${alice.userId}/unban`)).status, 200);
    assert.equal((await alice.call('GET', '/api/friends/list')).status, 200);
    assert.equal((await adm('GET', '/users?filter=banned&q=' + TAG)).data.total, 0);
    assert.equal((await adm('GET', '/stats')).data.bannedUsers, 0);
  } finally { ws.close(); }

  // 理由の長さは200文字で切る / 理由なしでも通る
  const long = await adm('POST', `/users/${U.carol.userId}/ban`, { hours: 1, reason: 'あ'.repeat(500) });
  assert.equal(long.status, 200);
  assert.equal((await adm('GET', '/users/' + U.carol.userId)).data.user.banReason.length, 200);
  assert.equal((await adm('POST', `/users/${U.carol.userId}/ban`, { hours: 1 })).status, 200);
  assert.equal((await adm('GET', '/users/' + U.carol.userId)).data.user.banReason, null);
  assert.equal((await adm('POST', `/users/${U.carol.userId}/unban`)).status, 200);
});

test('session revoke: 指定した端末だけ失効する。他人のsidは404', async () => {
  const { alice, bob } = U;
  const t1 = alice.token;
  const t2 = await login(alice);
  const c1 = callWith(alice, t1), c2 = callWith(alice, t2);
  assert.equal((await c1('GET', '/api/friends/list')).status, 200);
  assert.equal((await c2('GET', '/api/friends/list')).status, 200);

  const sid2 = JSON.parse(Buffer.from(t2.split('.')[1], 'base64url').toString()).sid;
  assert.ok(sid2);
  const bobSessions = (await adm('GET', '/users/' + bob.userId)).data.sessions;
  assert.equal((await adm('POST', `/users/${alice.userId}/sessions/${bobSessions[0].id}/revoke`)).status, 404, '他人のsid');
  assert.equal((await adm('POST', `/users/${alice.userId}/sessions/nope/revoke`)).status, 404);
  assert.equal((await adm('POST', `/users/nope/sessions/${sid2}/revoke`)).status, 404);
  assert.equal((await bob.call('GET', '/api/friends/list')).status, 200, 'bobは無傷');

  const ws2 = await S.connect({ ...alice, token: t2 });
  const r = await adm('POST', `/users/${alice.userIdCode}/sessions/${sid2}/revoke`);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal((await c2('GET', '/api/friends/list')).status, 401);
  assert.equal((await c1('GET', '/api/friends/list')).status, 200, '他の端末は生きている');
  const closed = await (async () => { const end = Date.now() + 3000; while (Date.now() < end) { if (ws2.msgs.some(m => m.type === 'session_revoked')) return true; await sleep(50); } return false; })();
  assert.ok(closed, '失効したWSに session_revoked が届かない');

  const ss = (await adm('GET', '/users/' + alice.userId)).data.sessions;
  assert.equal(ss.find(s => s.id === sid2).revoked, true);
  assert.ok(ss.some(s => !s.revoked));
  const rv = ss.find(s => s.id === sid2);
  assert.equal(rv.revokedReason, 'admin_revoke', '失効の理由が記録される');
  assert.ok(rv.revokedAt, '失効の時刻が記録される');
  assert.equal(ss.find(s => !s.revoked).revokedReason, null);

  // 本人のログアウトは logout として残る(あとのテストが使う alice の既定トークンは切らず、別に作った端末で試す)
  const t3 = await login(alice);
  assert.equal((await callWith(alice, t3)('POST', '/api/auth/logout', {})).status, 200);
  const ss2 = (await adm('GET', '/users/' + alice.userId)).data.sessions;
  assert.ok(ss2.some(s => s.revokedReason === 'logout'), '本人ログアウトの理由が logout で残る');
});

test('posts: 一覧・検索・delete・restore', async () => {
  const { alice, bob } = U;
  const pa = (await alice.call('POST', '/api/posts', { text: `ゆうやけ ${TAG} 100%_ok` })).data.post;
  await sleep(1100); // SQLiteは秒単位なので、新しい順が決まるよう間を空ける
  const pb = (await bob.call('POST', '/api/posts', { text: `ひるね ${TAG}` })).data.post;
  assert.ok(pa.id && pb.id);

  const all = await adm('GET', '/posts?q=' + TAG);
  assert.equal(all.status, 200);
  assert.equal(all.data.total, 3, '詳細テストの投稿を含めて3件');
  const first = all.data.posts[0];
  assert.equal(first.id, pb.id, '新しい順');
  for (const k of ['id', 'authorId', 'authorName', 'authorUserId', 'text', 'mediaUrl', 'mediaType', 'createdAt', 'deletedAt', 'viewCount']) assert.ok(k in first, k);
  assert.equal(first.authorId, bob.userId);
  assert.equal(first.authorUserId, bob.userIdCode);
  assert.match(first.authorName, /Bob/);
  assert.equal(first.mediaUrl, null);
  assert.equal(first.deletedAt, null);
  assert.equal(first.viewCount, 0);

  // 本文・投稿者名・IDコードで探せる。% と _ は文字として扱う
  assert.equal((await adm('GET', '/posts?q=' + encodeURIComponent('ゆうやけ'))).data.total, 1);
  assert.equal((await adm('GET', '/posts?q=' + encodeURIComponent('100%_ok'))).data.posts[0].id, pa.id);
  assert.equal((await adm('GET', '/posts?q=' + encodeURIComponent('100%_ng'))).data.total, 0);
  assert.equal((await adm('GET', '/posts?q=' + encodeURIComponent('Bob'))).data.posts.map(p => p.id).join(), pb.id);
  assert.equal((await adm('GET', '/posts?q=' + bob.userIdCode)).data.posts.map(p => p.id).join(), pb.id);
  const pg = await adm('GET', '/posts?limit=1&offset=1&q=' + TAG);
  assert.equal(pg.data.total, 3);
  assert.equal(pg.data.posts.length, 1);
  assert.equal(pg.data.posts[0].id, pa.id);

  // delete: 一覧から消え、deleted=1 に出る。利用者側の一覧からも消える
  assert.equal((await adm('POST', `/posts/${pa.id}/delete`)).status, 200);
  assert.equal((await adm('GET', '/posts?q=' + TAG)).data.total, 2);
  const del = await adm('GET', '/posts?deleted=1&q=' + TAG);
  assert.equal(del.data.total, 1);
  assert.equal(del.data.posts[0].id, pa.id);
  assert.ok(del.data.posts[0].deletedAt);
  assert.equal((await adm('GET', '/posts?deleted=all&q=' + TAG)).data.total, 3);
  const mine = await bob.call('GET', '/api/posts');
  assert.ok(!JSON.stringify(mine.data).includes(pa.id), '削除した投稿が利用者に見える');
  assert.equal((await adm('POST', `/posts/${pa.id}/delete`)).status, 200, '二重削除でも壊れない');

  // restore
  assert.equal((await adm('POST', `/posts/${pa.id}/restore`)).status, 200);
  assert.equal((await adm('GET', '/posts?deleted=1&q=' + TAG)).data.total, 0);
  const back = await adm('GET', '/posts?q=' + TAG);
  assert.equal(back.data.total, 3);
  assert.equal(back.data.posts.find(p => p.id === pa.id).deletedAt, null);

  // 存在しない
  for (const a of ['delete', 'restore']) {
    const r = await adm('POST', `/posts/no-such/${a}`);
    assert.equal(r.status, 404);
    assert.equal(r.data.error, '投稿が見つかりません');
  }
});

test('reports/:id/status と password: 既存の動きを保ったまま操作ログに残る', async () => {
  const open = (await adm('GET', '/reports?status=open')).data.reports;
  assert.equal(open.length, 2);
  assert.equal((await adm('POST', `/reports/${open[0].id}/status`, { status: 'bogus' })).status, 400);
  assert.equal((await adm('POST', `/reports/${open[0].id}/status`, { status: 'resolved' })).status, 200);
  assert.equal((await adm('GET', '/reports?status=resolved')).data.reports.length, 1);
  assert.equal((await adm('GET', '/stats')).data.openReports, 1);
  assert.equal((await adm('POST', '/reports/nope/status', { status: 'open' })).status, 404);

  const newPw = 'Zz9!newpassWordqq';
  assert.equal((await adm('POST', `/users/${U.carol.userId}/password`, { password: 'short' })).status, 400);
  assert.equal((await adm('POST', `/users/${U.carol.userIdCode}/password`, { password: newPw })).status, 200);
  assert.equal((await S.req('POST', '/api/auth/login', { ip: '10.62.0.1', body: { username: U.carol.username, password: newPw } })).status, 200);
  assert.equal((await adm('POST', `/users/${U.carol.userId}/logout`)).status, 200);
  assert.equal((await S.req('GET', '/api/friends/list', { token: U.carol.token, ip: U.carol.ip })).status, 401);
});

test('audit: 操作が新しい順で残り、パスワードや鍵は入らない', async () => {
  const r = await adm('GET', '/audit?limit=200');
  assert.equal(r.status, 200);
  assert.equal(r.data.total, r.data.entries.length);
  const e = r.data.entries;
  for (const x of e) for (const k of ['id', 'at', 'action', 'targetType', 'targetId', 'targetLabel', 'detail']) assert.ok(k in x, k);

  const find = (action, pred = () => true) => e.find(x => x.action === action && pred(x));
  const ban = find('user.ban', x => x.targetId === U.alice.userId);
  assert.ok(ban);
  assert.equal(ban.targetType, 'user');
  assert.match(ban.targetLabel, /Alice/);
  assert.ok(ban.targetLabel.includes(U.alice.userIdCode));
  assert.equal(ban.detail, '72時間: 荒らし');
  assert.ok(find('user.unban', x => x.targetId === U.alice.userId));
  assert.ok(find('user.unlock', x => x.targetId === U.carol.userId));
  assert.ok(find('user.logout', x => x.targetId === U.carol.userId));
  assert.ok(find('user.password', x => x.targetId === U.carol.userId));
  const rv = find('user.session_revoke', x => x.targetId === U.alice.userId);
  assert.ok(rv);
  assert.equal(rv.targetType, 'user');
  const pd = find('post.delete');
  assert.ok(pd);
  assert.equal(pd.targetType, 'post');
  assert.match(pd.detail, /ゆうやけ/);
  assert.ok(find('post.restore'));
  const rs = find('report.status');
  assert.ok(rs);
  assert.equal(rs.targetType, 'report');
  assert.match(rs.detail, /対応済み/);

  // 失敗した操作(400/404)は残らない
  assert.ok(!e.some(x => x.targetId === 'no-such-user' || x.targetId === 'nope'));

  // 新しい順
  for (let i = 1; i < e.length; i++) assert.ok(String(e[i - 1].at) >= String(e[i].at), '新しい順');

  // 秘密は入っていない
  const dump = JSON.stringify(r.data);
  assert.ok(!dump.includes('Zz9!newpassWordqq'), 'パスワードが入っている');
  assert.ok(!dump.includes(KEY), '管理キーが入っている');
  assert.ok(!dump.includes('password_hash'));
  assert.ok(!dump.includes(U.carol.username), 'メールアドレスが入っている');

  // ページング
  const p1 = await adm('GET', '/audit?limit=3&offset=0');
  const p2 = await adm('GET', '/audit?limit=3&offset=3');
  assert.equal(p1.data.entries.length, 3);
  assert.equal(p1.data.total, r.data.total);
  assert.deepEqual([...p1.data.entries, ...p2.data.entries].map(x => x.id), e.slice(0, 6).map(x => x.id));
  assert.equal((await adm('GET', '/audit?limit=100000')).status, 200);
});

test('退会済みユーザーは一覧にも詳細にも操作にも出ない', async () => {
  const d = await S.user(`Del ${TAG}`);
  assert.equal((await adm('GET', '/users/' + d.userId)).status, 200);
  const del = await d.call('POST', '/api/auth/delete-account', { password: d.password });
  assert.equal(del.status, 200);
  assert.equal((await adm('GET', '/users/' + d.userId)).status, 404);
  assert.equal((await adm('POST', `/users/${d.userId}/ban`, { hours: 1 })).status, 404);
  assert.equal((await adm('GET', '/users?q=Del ' + TAG)).data.total, 0);
});

test('鍵の総当たり対策: 鍵違いだけ数える。入力ミスや対象なしの繰り返しでは締め出されない', async () => {
  for (let i = 0; i < 15; i++) assert.equal((await adm('GET', '/users/nope', undefined, { ip: '7.7.7.7' })).status, 404);
  assert.equal((await adm('POST', '/users/nope/ban', { hours: 0 }, { ip: '7.7.7.7' })).status, 404);
  assert.equal((await adm('GET', '/stats', undefined, { ip: '7.7.7.7' })).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await adm('GET', '/stats', undefined, { key: 'wrong-key-' + i, ip: '7.7.7.8' })).status, 401);
  assert.equal((await adm('GET', '/stats', undefined, { key: 'wrong-key-x', ip: '7.7.7.8' })).status, 429);
  assert.equal((await adm('GET', '/stats', undefined, { ip: '7.7.7.8' })).status, 429, '締め出し中は正しい鍵でも通らない');
});

test('アカウント削除: 鍵なしは401、IDコードが合わない時は消えない', async () => {
  const none = await adm('POST', '/users/x/delete', {}, { key: null, ip: '8.9.0.1' });
  assert.equal(none.status, 401);
  const dave = await S.user(`Del ${TAG} Dave`);
  assert.equal((await adm('POST', '/users/' + dave.userId + '/delete', {})).status, 400);
  assert.equal((await adm('POST', '/users/' + dave.userId + '/delete', { confirm: 'ZZZZZZZ' })).status, 400);
  assert.equal((await adm('POST', '/users/' + dave.userId + '/delete', { confirm: 123 })).status, 400);
  assert.equal((await adm('GET', '/users/' + dave.userId)).status, 200, '消えていない');
  assert.equal((await adm('POST', '/users/nope/delete', { confirm: 'X' })).status, 404);
});

test('アカウント削除: 一覧・詳細から消え、ログインできず、投稿は非表示、操作ログに残る。もう一度は404', async () => {
  const erin = await S.user(`Del ${TAG} Erin`);
  const friend = await S.user(`Del ${TAG} Frank`);
  assert.equal((await erin.call('POST', '/api/posts', { text: 'さよなら投稿' })).status, 200);
  const token = erin.token;
  const r = await adm('POST', '/users/' + erin.userId + '/delete', { confirm: ' ' + erin.userIdCode.toLowerCase() + ' ' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await adm('GET', '/users/' + erin.userId)).status, 404);
  const list = await adm('GET', '/users?q=' + encodeURIComponent(erin.username));
  assert.equal(list.data.users.length, 0);
  const lg = await S.req('POST', '/api/auth/login', { ip: erin.ip, body: { username: erin.username, password: erin.password } });
  assert.notEqual(lg.status, 200, '削除後はログインできない');
  assert.notEqual((await S.req('GET', '/api/friends', { token, ip: erin.ip })).status, 200, '古いトークンも使えない');
  const posts = await adm('GET', '/posts?q=' + encodeURIComponent('さよなら'));
  assert.equal(posts.data.posts.length, 0, '投稿は一覧から消える');
  const audit = (await adm('GET', '/audit?limit=5')).data.entries.find(e => e.action === 'user.delete');
  assert.ok(audit && audit.targetLabel.includes('Erin'), JSON.stringify(audit));
  assert.ok(!JSON.stringify(audit).includes(erin.password));
  assert.equal((await adm('POST', '/users/' + erin.userId + '/delete', { confirm: erin.userIdCode })).status, 404);
  assert.equal((await adm('GET', '/users/' + friend.userId)).status, 200, '他の人は消えない');
});

test('アカウント削除: 運営アカウントは削除できない', async () => {
  const S3 = await startServer({ ADMIN_API_KEY: KEY });
  const boss = await S3.user('Boss');
  const dbFile = S3.dbFile;
  await S3.stop(true);
  const S4 = await startServer({ ADMIN_API_KEY: KEY, ADMIN_NOTIFY: boss.userIdCode }, { dbFile });
  try {
    const x = await fetch(S4.base + '/api/admin/users/' + boss.userId + '/delete', {
      method: 'POST', headers: { 'x-admin-key': KEY, 'content-type': 'application/json', 'x-forwarded-for': '7.7.7.7' },
      body: JSON.stringify({ confirm: boss.userIdCode }),
    });
    const d = await x.json();
    assert.equal(x.status, 400, JSON.stringify(d));
    assert.match(d.error, /運営/);
    const g = await fetch(S4.base + '/api/admin/users/' + boss.userId, { headers: { 'x-admin-key': KEY, 'x-forwarded-for': '7.7.7.7' } });
    assert.equal(g.status, 200, '消えていない');
  } finally { await S4.stop(); }
});
