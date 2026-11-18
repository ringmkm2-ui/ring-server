const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

const friendIds = async (u) => (await u.call('GET', '/api/friends/list')).data.map(f => f.userId);
const mk = (n, p) => Promise.all(Array.from({ length: n }, (_, i) => S.user((p || 'U') + i)));

test('QA1: 1コードを12人が同時に使っても max_uses=3 を超えない', async () => {
  for (let round = 0; round < 3; round++) {
    const owner = await S.user('Owner');
    const code = (await owner.call('POST', '/api/invites', { maxUses: 5, expiresInDays: 7 })).data.invite.code;
    // maxUses 5 は選択肢。5人上限で10人同時
    const js = await mk(10, 'J');
    const rs = await Promise.all(js.map(j => j.call('POST', '/api/invites/redeem', { code })));
    const ok = rs.filter(r => r.status === 200).length;
    const bad = rs.filter(r => ![200, 404].includes(r.status));
    assert.deepEqual(bad.map(b => b.status), [], '200/404以外が出た: ' + JSON.stringify(bad[0]));
    assert.equal(ok, 5, `round${round}: 成功数=${ok}`);
    const row = (await owner.call('GET', '/api/invites')).data.codes.find(c => c.code === code);
    assert.equal(row.uses, 5);
    const ids = await friendIds(owner);
    const friendsOfThem = js.filter(j => ids.includes(j.userId)).length;
    assert.equal(friendsOfThem, 5, `友だちになった人数=${friendsOfThem}`);
  }
});

test('QA2: 満杯のコードに、同じ人が並列で何回も送ると友だちになれてしまう(again経路のレース)', async () => {
  const owner = await S.user('Owner');
  const code = (await owner.call('POST', '/api/invites', { maxUses: 1, expiresInDays: 7 })).data.invite.code;
  const first = await S.user('First');
  assert.equal((await first.call('POST', '/api/invites/redeem', { code })).status, 200);
  const attackers = await mk(8, 'X');
  const results = await Promise.all(attackers.map(async a => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => a.call('POST', '/api/invites/redeem', { code })));
    return rs.map(r => r.status);
  }));
  const ids = await friendIds(owner);
  const leaked = attackers.filter(a => ids.includes(a.userId));
  assert.equal(leaked.length, 0, `満杯なのに友だちになれた人: ${leaked.length}人 / statuses=${JSON.stringify(results[0])}`);
});

test('QA3: コードの同時作成が上限10を超える', async () => {
  const owner = await S.user('Owner');
  const rs = await Promise.all(Array.from({ length: 30 }, () => owner.call('POST', '/api/invites', {})));
  const ok = rs.filter(r => r.status === 200).length;
  const codes = (await owner.call('GET', '/api/invites')).data.codes;
  assert.ok(ok <= 10, `作れたコード数=${ok}`);
  assert.ok(codes.length <= 10, `有効コード数=${codes.length}`);
});

test('QA4: 使われている最中にコードを消しても 5xx にならず、整合している', async () => {
  for (let round = 0; round < 4; round++) {
    const owner = await S.user('Owner');
    const code = (await owner.call('POST', '/api/invites', { maxUses: 10, expiresInDays: 7 })).data.invite.code;
    const js = await mk(6, 'J');
    const calls = js.map(j => j.call('POST', '/api/invites/redeem', { code }));
    calls.push(owner.call('DELETE', '/api/invites/' + code));
    const rs = await Promise.all(calls);
    const del = rs.pop();
    assert.equal(del.status, 200);
    const bad = rs.filter(r => ![200, 404].includes(r.status));
    assert.deepEqual(bad.map(b => b.status + JSON.stringify(b.data)), [], 'round ' + round);
    const ids = await friendIds(owner);
    rs.forEach((r, i) => {
      if (r.status === 404) assert.ok(!ids.includes(js[i].userId), '404なのに友だち');
    });
  }
});

test('QA5: 退会した持ち主 / 退会した参加者 / ブロック', async () => {
  const owner = await S.user('Owner'); const j = await S.user('J'); const j2 = await S.user('J2');
  const code = (await owner.call('POST', '/api/invites', { maxUses: 5 })).data.invite.code;
  // 参加者がブロックしている持ち主のコードは無効。人数は減らない
  await j.call('POST', '/api/friends/block', { userId: owner.userId });
  const r = await j.call('POST', '/api/invites/redeem', { code });
  assert.equal(r.status, 404);
  const row = (await owner.call('GET', '/api/invites')).data.codes.find(c => c.code === code);
  assert.equal(row.uses, 0);
  // 持ち主が参加者をブロック
  await owner.call('POST', '/api/friends/block', { userId: j2.userId });
  assert.equal((await j2.call('POST', '/api/invites/redeem', { code })).status, 404);
  // 使った後で退会した参加者
  const j3 = await S.user('J3');
  assert.equal((await j3.call('POST', '/api/invites/redeem', { code })).status, 200);
  const del = await j3.call('POST', '/api/auth/delete-account', { password: j3.password });
  assert.equal(del.status, 200);
  const row2 = (await owner.call('GET', '/api/invites')).data.codes.find(c => c.code === code);
  assert.equal(row2.joined.length, 0);
  // 退会した持ち主のコード
  const o2 = await S.user('O2'); const c2 = (await o2.call('POST', '/api/invites', {})).data.invite.code;
  await o2.call('POST', '/api/auth/delete-account', { password: o2.password });
  const k = await S.user('K');
  assert.equal((await k.call('POST', '/api/invites/redeem', { code: c2 })).status, 404);
  assert.equal((await S.req('POST', '/api/auth/register-invite', { body: { code: c2, displayName: 'x', realName: '田中 太郎' } })).status, 404);
});

test('QA6: 入力のゆれ', async () => {
  const owner = await S.user('Owner');
  const code = (await owner.call('POST', '/api/invites', { maxUses: null, expiresInDays: null })).data.invite.code;
  const j = await mk(1);
  const J = j[0];
  const bodies = [
    { code: [code] }, { code: { a: code } }, { code: null }, { code: 12345678 }, { code: code + 'x' },
    { code: 'A'.repeat(100000) }, [], 'str',
  ];
  for (const b of bodies) {
    const r = await J.call('POST', '/api/invites/redeem', b);
    assert.ok([400, 404, 413].includes(r.status), JSON.stringify(b).slice(0, 60) + ' => ' + r.status);
  }
  // 全角
  const full = [...code].map(c => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
  const rf = await J.call('POST', '/api/invites/redeem', { code: full });
  assert.equal(rf.status, 200, '全角で入力したコードは通る? status=' + rf.status);
});

test('QA7: HTTPの端っこ', async () => {
  const a = await S.user('A');
  assert.equal((await S.req('POST', '/api/invites', { body: {} })).status, 401);
  assert.equal((await S.req('GET', '/api/invites', { token: 'x.y.z' })).status, 401);
  assert.equal((await a.call('GET', '/api/invites/')).status, 200);
  const put = await a.call('PUT', '/api/invites', {});
  assert.equal(put.status, 404);
  assert.equal((await a.call('DELETE', '/api/invites/')).status, 404);
  const mk1 = await a.call('POST', '/api/invites', { maxUses: null, expiresInDays: null });
  assert.equal(mk1.data.invite.maxUses, null);
  for (const bad of [{ maxUses: 2 }, { maxUses: '5' }, { expiresInDays: 0 }, { expiresInDays: '7' }, { maxUses: [5] }, { expiresInDays: 1.5 }]) {
    assert.equal((await a.call('POST', '/api/invites', bad)).status, 400, JSON.stringify(bad));
  }
  // 壊れたJSON・巨大JSON
  const raw = await fetch(S.base + '/api/invites/redeem', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + a.token }, body: '{"code":' });
  assert.equal(raw.status, 400);
  const dup = await fetch(S.base + '/api/invites/redeem', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + a.token }, body: '{"code":"zzz","code":"' + mk1.data.invite.code + '"}' });
  assert.ok([200, 400].includes(dup.status));
  const huge = await fetch(S.base + '/api/invites/redeem', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + a.token }, body: JSON.stringify({ code: 'A'.repeat(5 * 1024 * 1024) }) });
  assert.equal(huge.status, 413);
  // 他人のコードは消せない / 大文字小文字
  const b = await S.user('B');
  assert.equal((await b.call('DELETE', '/api/invites/' + mk1.data.invite.code)).status, 404);
  assert.equal((await a.call('DELETE', '/api/invites/' + mk1.data.invite.code.toLowerCase())).status, 200);
});

test('QA8: 友だち申請の途中でもコードで承認済みになる / 解除したあとの再利用は新しく人数を1つ使う', async () => {
  const o = await S.user('O'); const j = await S.user('J');
  const code = (await o.call('POST', '/api/invites', { maxUses: 5, expiresInDays: 7 })).data.invite.code;
  await j.call('POST', '/api/friends/request', { targetUserIdCode: o.userIdCode });
  assert.equal((await j.call('POST', '/api/invites/redeem', { code })).status, 200);
  assert.ok((await friendIds(o)).includes(j.userId));
  const rm = await j.call('POST', '/api/friends/remove', { userId: o.userId });
  assert.equal(rm.status, 200, JSON.stringify(rm));
  const again = await j.call('POST', '/api/invites/redeem', { code });
  assert.equal(again.status, 200, JSON.stringify(again));
  const row = (await o.call('GET', '/api/invites')).data.codes.find(c => c.code === code);
  assert.equal(row.uses, 2);
  // 使い切りのコードは、外された後に戻れない
  const c1 = (await o.call('POST', '/api/invites', { maxUses: 1, expiresInDays: 7 })).data.invite.code;
  const k = await S.user('K');
  assert.equal((await k.call('POST', '/api/invites/redeem', { code: c1 })).status, 200);
  await k.call('POST', '/api/friends/remove', { userId: o.userId });
  assert.equal((await k.call('POST', '/api/invites/redeem', { code: c1 })).status, 404);
});

test('QA9: register-invite を同時に叩いても上限を超えない / 失敗は5xxにならない', async () => {
  const o = await S.user('O');
  const code = (await o.call('POST', '/api/invites', { maxUses: 5, expiresInDays: 7 })).data.invite.code;
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => S.req('POST', '/api/auth/register-invite', { body: { code, displayName: 'G' + i, realName: '田中 太郎' } })));
  const bad = rs.filter(r => ![200, 404].includes(r.status));
  assert.deepEqual(bad.map(b => b.status), []);
  assert.equal(rs.filter(r => r.status === 200).length, 5);
  assert.equal((await o.call('GET', '/api/invites')).data.codes.find(c => c.code === code).uses, 5);
});

test('QA10: 見えない表示名(ゼロ幅など)でゲスト登録できてしまう', async () => {
  const o = await S.user('O');
  const code = (await o.call('POST', '/api/invites', {})).data.invite.code;
  for (const name of ['​​', 'ㅤ', '‮evil']) {
    const r = await S.req('POST', '/api/auth/register-invite', { body: { code, displayName: name, realName: '田中 太郎' } });
    assert.equal(r.status, 400, JSON.stringify(name) + ' => ' + r.status);
  }
});
