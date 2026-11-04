const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

const friendIds = async (u) => (await u.call('GET', '/api/friends/list')).data.map(f => f.userId);

test('コードを作って入れると、入れた人も持ち主もお互いの友だち一覧に出る(承認待ちなし)', async () => {
  const a = await S.user('Inviter'); const b = await S.user('Guest');
  const made = await a.call('POST', '/api/invites', {});
  assert.equal(made.status, 200);
  const code = made.data.invite.code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  // 既定は10人まで・7日
  assert.equal(made.data.invite.maxUses, 10);
  assert.ok(made.data.invite.expiresAt > Date.now() + 6 * 86400000);

  // 小文字・ハイフン・空白が混じっていても通る
  const typed = ' ' + code.slice(0, 4).toLowerCase() + '-' + code.slice(4).toLowerCase() + ' ';
  const r = await b.call('POST', '/api/invites/redeem', { code: typed });
  assert.equal(r.status, 200);
  assert.equal(r.data.already, false);
  assert.equal(r.data.friend.userId, a.userId);
  assert.ok(await friendIds(a).then(ids => ids.includes(b.userId)), '持ち主の一覧に相手が出る');
  assert.ok(await friendIds(b).then(ids => ids.includes(a.userId)), '入れた人の一覧に持ち主が出る');
  assert.equal((await b.call('GET', '/api/friends/pending')).data.length, 0);
});

test('同じ人がもう一度入れても、人数は減らない', async () => {
  const a = await S.user('A'); const b = await S.user('B');
  const code = (await a.call('POST', '/api/invites', { maxUses: 5, expiresInDays: 7 })).data.invite.code;
  await b.call('POST', '/api/invites/redeem', { code });
  const again = await b.call('POST', '/api/invites/redeem', { code });
  assert.equal(again.status, 200);
  assert.equal(again.data.already, true);
  const list = (await a.call('GET', '/api/invites')).data.codes;
  assert.equal(list.find(c => c.code === code).uses, 1);
});

test('1つのコードを複数人が使える。人数の上限に達したら使えない', async () => {
  const a = await S.user('Owner');
  const code = (await a.call('POST', '/api/invites', { maxUses: 5, expiresInDays: null })).data.invite.code;
  const joiners = await Promise.all([1, 2, 3, 4, 5].map(i => S.user('J' + i)));
  for (const j of joiners) assert.equal((await j.call('POST', '/api/invites/redeem', { code })).status, 200);
  const late = await S.user('Late');
  assert.equal((await late.call('POST', '/api/invites/redeem', { code })).status, 404);
  const ids = await friendIds(a);
  assert.ok(joiners.every(j => ids.includes(j.userId)) && !ids.includes(late.userId));
  const row = (await a.call('GET', '/api/invites')).data.codes.find(x => x.code === code);
  assert.equal(row.uses, 5); assert.equal(row.full, true); assert.equal(row.expiresAt, null);
});

test('1人用のコードは、2人目が使えない', async () => {
  const a = await S.user('Single');
  const code = (await a.call('POST', '/api/invites', { maxUses: 1, expiresInDays: 1 })).data.invite.code;
  const b = await S.user('First'); const c = await S.user('Second');
  assert.equal((await b.call('POST', '/api/invites/redeem', { code })).status, 200);
  assert.equal((await c.call('POST', '/api/invites/redeem', { code })).status, 404);
});

test('同時に何人が入れても上限を超えない', async () => {
  const a = await S.user('Race');
  const code = (await a.call('POST', '/api/invites', { maxUses: 5, expiresInDays: 1 })).data.invite.code;
  const users = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(i => S.user('R' + i)));
  const rs = await Promise.all(users.map(u => u.call('POST', '/api/invites/redeem', { code })));
  assert.equal(rs.filter(r => r.status === 200).length, 5);
  assert.equal((await a.call('GET', '/api/invites')).data.codes.find(x => x.code === code).uses, 5);
  assert.equal((await friendIds(a)).length, 5);
});

test('同じ人が同時に2回送っても、人数を消費するのは1回だけ', async () => {
  const a = await S.user('Twice'); const b = await S.user('Double');
  const code = (await a.call('POST', '/api/invites', { maxUses: 5, expiresInDays: 1 })).data.invite.code;
  await Promise.all([1, 2, 3, 4].map(() => b.call('POST', '/api/invites/redeem', { code })));
  assert.equal((await a.call('GET', '/api/invites')).data.codes.find(x => x.code === code).uses, 1);
  assert.equal((await friendIds(a)).filter(id => id === b.userId).length, 1);
});

test('自分のコード・存在しないコード・形式がおかしいコードは使えない', async () => {
  const a = await S.user('Self'); const b = await S.user('Other');
  const code = (await a.call('POST', '/api/invites', {})).data.invite.code;
  assert.equal((await a.call('POST', '/api/invites/redeem', { code })).status, 400);
  assert.equal((await b.call('POST', '/api/invites/redeem', { code: 'ZZZZZZZZ' })).status, 404);
  assert.equal((await b.call('POST', '/api/invites/redeem', { code: 'abc' })).status, 404);
  assert.equal((await b.call('POST', '/api/invites/redeem', { code: { length: 8 } })).status, 404);
  assert.equal((await b.call('POST', '/api/invites/redeem', {})).status, 404);
});

test('ログインしていないと使えない', async () => {
  assert.equal((await S.req('GET', '/api/invites')).status, 401);
  assert.equal((await S.req('POST', '/api/invites/redeem', { body: { code: 'ABCDEFGH' } })).status, 401);
});

test('ブロックしている/されている相手とは友だちにならない(無効と同じ返事)', async () => {
  const a = await S.user('Blocker'); const b = await S.user('Blocked'); const c = await S.user('Blocks');
  const codeA = (await a.call('POST', '/api/invites', {})).data.invite.code;
  const codeC = (await c.call('POST', '/api/invites', {})).data.invite.code;
  await a.call('POST', '/api/friends/block', { userId: b.userId });
  await b.call('POST', '/api/friends/block', { userId: c.userId });
  const r1 = await b.call('POST', '/api/invites/redeem', { code: codeA });   // 相手にブロックされている
  const r2 = await c.call('POST', '/api/invites/redeem', { code: codeA });   // ブロックは無関係
  const r3 = await b.call('POST', '/api/invites/redeem', { code: codeC });   // 自分がブロックしている
  assert.equal(r1.status, 404); assert.equal(r2.status, 200); assert.equal(r3.status, 404);
  // 人数も消費されていない
  assert.equal((await a.call('GET', '/api/invites')).data.codes.find(x => x.code === codeA).uses, 1);
  assert.equal((await c.call('GET', '/api/invites')).data.codes.find(x => x.code === codeC).uses, 0);
});

test('友だち申請の途中でも、コードを入れればそのまま友だちになる', async () => {
  const a = await S.user('Pend1'); const b = await S.user('Pend2');
  await b.call('POST', '/api/friends/request', { targetUserIdCode: a.userIdCode });
  const code = (await a.call('POST', '/api/invites', {})).data.invite.code;
  const r = await b.call('POST', '/api/invites/redeem', { code });
  assert.equal(r.status, 200);
  assert.equal((await a.call('GET', '/api/friends/pending')).data.length, 0);
  assert.ok((await friendIds(a)).includes(b.userId));
});

test('友だちを削除したあと、同じコードでまた友だちになれる(人数は増えない)', async () => {
  const a = await S.user('Re1'); const b = await S.user('Re2');
  const code = (await a.call('POST', '/api/invites', { maxUses: 1, expiresInDays: 7 })).data.invite.code;
  assert.equal((await b.call('POST', '/api/invites/redeem', { code })).status, 200);
  await b.call('POST', '/api/friends/remove', { userId: a.userId });
  assert.ok(!(await friendIds(a)).includes(b.userId));
  const again = await b.call('POST', '/api/invites/redeem', { code });
  assert.equal(again.status, 200);
  assert.ok((await friendIds(a)).includes(b.userId));
});

test('コードを消すと、まだ使っていない人は使えない。すでに友だちの人はそのまま', async () => {
  const a = await S.user('Del'); const b = await S.user('Used'); const c = await S.user('Late');
  const code = (await a.call('POST', '/api/invites', {})).data.invite.code;
  await b.call('POST', '/api/invites/redeem', { code });
  // 他人は消せない
  assert.equal((await c.call('DELETE', '/api/invites/' + code)).status, 404);
  assert.equal((await a.call('DELETE', '/api/invites/' + code)).status, 200);
  assert.equal((await c.call('POST', '/api/invites/redeem', { code })).status, 404);
  assert.ok((await friendIds(a)).includes(b.userId));
  assert.equal((await a.call('GET', '/api/invites')).data.codes.some(x => x.code === code), false);
});

test('作る時の指定が不正なら400。有効なコードは10個まで、消せばまた作れる', async () => {
  const a = await S.user('Limit');
  assert.equal((await a.call('POST', '/api/invites', { maxUses: 999 })).status, 400);
  assert.equal((await a.call('POST', '/api/invites', { expiresInDays: 3 })).status, 400);
  assert.equal((await a.call('POST', '/api/invites', { maxUses: '5' })).status, 400);
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const r = await a.call('POST', '/api/invites', {});
    assert.equal(r.status, 200);
    codes.push(r.data.invite.code);
  }
  assert.equal((await a.call('POST', '/api/invites', {})).status, 400);
  await a.call('DELETE', '/api/invites/' + codes[0]);
  assert.equal((await a.call('POST', '/api/invites', {})).status, 200);
});

test('コードを入れる試行は15分に20回まで', async () => {
  const a = await S.user('Brute');
  let limited = 0;
  for (let i = 0; i < 24; i++) {
    const r = await a.call('POST', '/api/invites/redeem', { code: 'ABCDEFG' + (i % 8 + 2) });
    if (r.status === 429) limited++;
  }
  assert.ok(limited >= 3, '20回を超えたら429になる(実際: ' + limited + ')');
});

test('退会すると、その人のコードは使えなくなる', async () => {
  const a = await S.user('Leaver'); const b = await S.user('Joiner');
  const code = (await a.call('POST', '/api/invites', {})).data.invite.code;
  const del = await a.call('POST', '/api/auth/delete-account', { password: a.password });
  assert.equal(del.status, 200, JSON.stringify(del));
  assert.equal((await b.call('POST', '/api/invites/redeem', { code })).status, 404);
});
