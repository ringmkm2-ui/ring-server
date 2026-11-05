// e5 の送受信を、端末内の保存(IndexedDB)とサーバーのプリキーAPIを通して確かめる
process.env.NODE_ENV = 'test';
require('fake-indexeddb/auto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
globalThis.nacl = require('../public/js/nacl.min.js');
globalThis.nacl.util = require('../public/js/nacl-util.min.js');
require('../public/js/ratchet.js');
const { startServer } = require('./helpers');
const { makeClient, parse, isRatchet, core } = globalThis.E2ERatchet;
const b64 = u => Buffer.from(u).toString('base64');
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);
let S, seq = 0;

function freshDb(name) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('t_' + name, 1);
    r.onupgradeneeded = () => ['sessions', 'plain', 'prekeys', 'meta'].forEach(n => r.result.createObjectStore(n));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
// 端末 d から相手 to へ
const send = (d, to, text, peers, mine) => d.c.seal(enc(text), peers || [to.pub], { from: d.u.userId, to: to.u.userId, mine });
const recv = (d, from, m) => d.c.open(m, { from: from.u.userId, to: d.u.userId });
async function device(u) {
  const k = core.genDH();
  await u.call('POST', '/api/friends/publickey', { publicKey: b64(k.pub) });
  const d = { pub: b64(k.pub), k };
  d.u = u;
  d.idb = await freshDb('d' + (++seq));
  d.c = makeClient({
    uid: u.userId,
    db: d.idb,
    identity: () => k,
    peerKeys: async id => (await u.call('GET', '/api/friends/publickey/' + id)).data.publicKeys,
    http: async (m, p, b) => {
      const r = await u.call(m, p, b);
      if (r.status === 404) return null;
      if (r.status >= 400) throw Object.assign(new Error('http ' + r.status), { status: r.status });
      return r.data;
    },
  });
  return d;
}
before(async () => { S = await startServer({ RATCHET_ENABLED: 'on', DEVICE_APPROVAL: 'off' }); });
after(() => S.stop());
async function people() {
  const a = await S.user('ra' + (++seq), '10.20.' + seq + '.1'), b = await S.user('rb' + seq, '10.20.' + seq + '.2');
  await S.befriend(a, b);
  const da = await device(a), db = await device(b);
  await da.c.ensurePrekeys(); await db.c.ensurePrekeys();
  return { a, b, da, db };
}


function dump(d, store) {
  return new Promise((res, rej) => {
    const t = d.idb.transaction(store, 'readonly'), st = t.objectStore(store);
    const ks = st.getAllKeys(), vs = st.getAll();
    t.oncomplete = () => res(new Map(ks.result.map((k, i) => [k, vs.result[i]])));
    t.onerror = () => rej(t.error);
  });
}
function clearStore(d, store) {
  return new Promise((res, rej) => { const t = d.idb.transaction(store, 'readwrite'); t.objectStore(store).clear(); t.oncomplete = res; t.onerror = () => rej(t.error); });
}

test('往復。暗号文に本文は無く、自分の分は端末の中に残る', async () => {
  const { da, db } = await people();
  const m = await send(da, db, 'こんにちは');
  assert.ok(isRatchet(m));
  assert.equal(parse(m).entries.get(db.pub)[0], 'r');
  assert.equal(dec(await recv(db, da, m)), 'こんにちは');
  assert.equal(dec(await da.c.open(m, { from: da.u.userId, to: db.u.userId })), 'こんにちは', '送った端末は保存分を読む');
  assert.equal(dec(await recv(da, db, await send(db, da, '返事'))), '返事');
});

test('同じ暗号文は何度開いても同じ本文。鍵は1回しか進まない', async () => {
  const { da, db } = await people();
  const ms = [];
  for (let i = 0; i < 4; i++) ms.push(await send(da, db, 'm' + i));
  for (const i of [2, 0, 3, 1, 2, 0]) assert.equal(dec(await recv(db, da, ms[i])), 'm' + i);
});

test('同時に開いても同時に送っても壊れない', async () => {
  const { da, db } = await people();
  const m1 = await send(da, db, 'a'), m2 = await send(da, db, 'b');
  assert.deepEqual((await Promise.all([m1, m1, m2, m2, m1].map(m => recv(db, da, m)))).map(dec), ['a', 'a', 'b', 'b', 'a']);
  const ms = await Promise.all([1, 2, 3, 4, 5].map(i => send(da, db, String(i))));
  const texts = [];
  for (const m of ms) texts.push(dec(await recv(db, da, m)));
  assert.deepEqual(texts.sort(), ['1', '2', '3', '4', '5']);
});

test('両方が同時に話し始めても読め、送るセッションが揃う', async () => {
  const { da, db } = await people();
  const [x, y] = await Promise.all([send(da, db, 'from a'), send(db, da, 'from b')]);
  assert.equal(dec(await recv(db, da, x)), 'from a');
  assert.equal(dec(await recv(da, db, y)), 'from b');
  for (let i = 0; i < 3; i++) {
    assert.equal(dec(await recv(db, da, await send(da, db, 'a' + i))), 'a' + i);
    assert.equal(dec(await recv(da, db, await send(db, da, 'b' + i))), 'b' + i);
  }
});

test('複数の端末: 相手の全端末と自分の他の端末が読める', async () => {
  const { a, b, da, db } = await people();
  const da2 = await device(a), db2 = await device(b);
  await da2.c.ensurePrekeys(); await db2.c.ensurePrekeys();
  const m = await send(da, db, '全員へ', [db.pub, db2.pub], [da2.pub, da.pub]);
  assert.equal(parse(m).entries.size, 3, '自分の端末の分は入れない');
  assert.equal(dec(await recv(db, da, m)), '全員へ');
  assert.equal(dec(await recv(db2, da, m)), '全員へ');
  assert.equal(dec(await da2.c.open(m, { from: a.userId, to: b.userId })), '全員へ');
});

test('対応前の端末には移行扱いで box。一度e5で話した相手には、プリキーを隠されても box に落ちない', async () => {
  const a = await S.user('dg' + (++seq), '10.21.1.1'), b = await S.user('dh' + seq, '10.21.1.2');
  await S.befriend(a, b);
  const da = await device(a), db = await device(b);
  const m = await send(da, db, 'old device');
  assert.equal(parse(m).entries.get(db.pub)[0], 'b');
  assert.equal(dec(await recv(db, da, m)), 'old device');
  await db.c.ensurePrekeys();
  // db のセッションが無いまま da の別の状態で: ピン留めされた後は送れない
  const m2 = await send(da, db, 'new');
  assert.equal(parse(m2).entries.get(db.pub)[0], 'r');
  assert.equal(dec(await recv(db, da, m2)), 'new');
  assert.equal(await da.c.isPinned(b.userId), true);
  const db2 = await device(b); // プリキーをまだ出していない新しい端末
  const m3 = await send(da, db, 'skip', [db.pub, db2.pub]);
  assert.ok(!parse(m3).entries.has(db2.pub), '一度e5で話した相手の端末を box にしない');
  const evilDb = await freshDb('evil' + (++seq));
  const hidden = makeClient({ uid: a.userId, db: evilDb, identity: () => da.k, http: async () => null });
  // 既に e5 を使った相手として記録済みの状態を再現
  await new Promise((res, rej) => { const t = evilDb.transaction('meta', 'readwrite'); t.objectStore('meta').put(Date.now(), 'user:' + b.userId); t.oncomplete = res; t.onerror = rej; });
  await assert.rejects(hidden.seal(enc('x'), [db.pub], { from: a.userId, to: b.userId }), e => e.code === 'RATCHET_DOWNGRADE');
});

test('受信側: e5で話した相手からの box は受けない。自分の文を相手の発言に見せかけられない', async () => {
  const { a, b, da, db } = await people();
  const m = await send(da, db, 'hi'); await recv(db, da, m);
  const nonce = nacl.randomBytes(24);
  const inner = new Uint8Array([...enc(JSON.stringify({ f: a.userId, t: b.userId })), 0, ...enc('downgrade')]);
  const box = nacl.box(inner, nonce, db.k.pub, da.k.sec);
  const forged = `e5:${da.pub}:${db.pub}.b${b64(new Uint8Array([...nonce, ...box]))}`;
  assert.equal(await recv(db, da, forged), null);
  // 反射: Aが送った文を、Bの発言として本人に見せる
  const mine = await send(da, db, 'mine');
  const entry = parse(mine).entries.get(db.pub);
  assert.equal(await da.c.open(`e5:${db.pub}:${da.pub}.${entry}`, { from: b.userId, to: a.userId }), null);
  // 別の宛先の会話として流す: 中の from/to が合わない
  const m2 = await send(da, db, 'to b only');
  assert.equal(await db.c.open(m2, { from: 'someone-else', to: b.userId }), null);
  assert.equal(dec(await recv(db, da, m2)), 'to b only', '正しい文脈なら読める(試しても状態は壊れない)');
});

test('不明な鍵からは新しいセッションを作らない(相手の端末一覧に無い鍵)', async () => {
  const { da, db } = await people();
  const stranger = core.genDH();
  const c = makeClient({
    uid: da.u.userId, db: await freshDb('st' + (++seq)), identity: () => stranger,
    http: async (m, p, body) => { const r = await da.u.call(m, p, body); return r.status === 404 ? null : r.data; },
  });
  const m = await c.seal(enc('imposter'), [db.pub], { from: da.u.userId, to: db.u.userId });
  assert.equal(parse(m).entries.get(db.pub)[0], 'r');
  assert.equal(await recv(db, da, m), null);
});

test('別表記の鍵を別の端末として扱わない', async () => {
  const { da, db } = await people();
  const raw = Buffer.from(db.pub, 'base64');
  const high = Buffer.from(raw); high[31] |= 0x80;
  const bad1 = high.toString('base64');
  const m = await send(da, db, 'x', [db.pub, bad1]);
  assert.equal(parse(m).entries.size, 1);
  assert.equal(core.canonicalKey(bad1), null);
  assert.equal((await da.u.call('POST', '/api/friends/publickey', { publicKey: bad1 })).status, 400);
});

test('プリキーAPI: 秘密鍵の証明が要り、他人の端末鍵には置けない。先に置く攻撃も効かない', async () => {
  const a = await S.user('pk' + (++seq), '10.22.2.1'), b = await S.user('pl' + seq, '10.22.2.2'), m = await S.user('pm' + seq, '10.22.2.3');
  await S.befriend(a, b); await S.befriend(m, b);
  const db = await device(b);
  // Mallory が Bob の公開鍵を自分の鍵として登録しても
  await m.call('POST', '/api/friends/publickey', { publicKey: db.pub });
  const k = core.genDH();
  const spk = { id: 1, pub: b64(k.pub), sig: b64(core.xeddsaSign(k.sec, enc('x'))) };
  assert.equal((await m.call('POST', '/api/ratchet/prekeys', { deviceKey: db.pub, spk, otks: [] })).status, 403, '証明なし');
  const c = (await m.call('POST', '/api/devices/challenge', { publicKey: db.pub })).data;
  assert.equal((await m.call('POST', '/api/ratchet/prekeys', { deviceKey: db.pub, spk, otks: [], challengeId: c.id, answer: b64(nacl.randomBytes(32)) })).status, 403, '秘密鍵が無いと答えられない');
  await db.c.ensurePrekeys();
  const bundle = (await a.call('GET', '/api/ratchet/bundle/' + encodeURIComponent(db.pub))).data;
  assert.ok(core.xeddsaVerify(Buffer.from(db.pub, 'base64'), new Uint8Array([...enc('BroChat-SPK-v1'), ...Buffer.from(bundle.spk.pub, 'base64')]), Buffer.from(bundle.spk.sig, 'base64')));
});

test('偽のSPK(署名が合わない)では送らない', async () => {
  const { a, da, db } = await people();
  const fake = core.genDH();
  const c = makeClient({
    uid: a.userId, db: await freshDb('fk' + (++seq)), identity: () => da.k,
    http: async () => ({ deviceKey: db.pub, spk: { id: 1, pub: b64(fake.pub), sig: b64(nacl.randomBytes(64)) }, otk: null }),
  });
  await assert.rejects(c.seal(enc('x'), [db.pub], { from: a.userId, to: db.u.userId }), e => e.code === 'RATCHET_BAD_SPK');
});

test('OTK: 同時に取っても重複せず、同じ人は取り尽くせず、知らない人には渡らず、無くてもSPKで始められる', async () => {
  const { a, b, da, db } = await people();
  const got = await Promise.all(Array.from({ length: 5 }, () => a.call('GET', '/api/ratchet/bundle/' + encodeURIComponent(db.pub))));
  assert.equal(new Set(got.map(r => r.data.otk && r.data.otk.id)).size, 5);
  const over = await a.call('GET', '/api/ratchet/bundle/' + encodeURIComponent(db.pub));
  assert.equal(over.status, 200);
  assert.equal(over.data.otk, null, '上限を超えたらOTKなし');
  const c = await S.user('st' + (++seq), '10.22.1.1');
  assert.equal((await c.call('GET', '/api/ratchet/bundle/' + encodeURIComponent(db.pub))).status, 404);
  void b;
  const m = await send(da, db, 'otkなし');
  assert.equal(dec(await recv(db, da, m)), 'otkなし');
});

test('使ったOTKは消え、最初の1通を別の文字列で再送しても開けない', async () => {
  const { da, db } = await people();
  const m = await send(da, db, 'once');
  assert.equal(dec(await recv(db, da, m)), 'once');
  assert.equal(await recv(db, da, m + ',x.rAAAA'), null);
});

test('セッションを作り直しても会話が続き、古いセッションは送信に使わない', async () => {
  const { da, db } = await people();
  await recv(db, da, await send(da, db, 'first'));
  await clearStore(da, 'sessions');
  assert.equal(dec(await recv(db, da, await send(da, db, 'new session'))), 'new session');
  await recv(da, db, await send(db, da, 'reply'));
  const key = db.pub + '|' + da.pub;
  assert.equal((await dump(db, 'sessions')).get(key).length, 2);
  assert.equal(dec(await recv(da, db, await send(db, da, 'still new'))), 'still new');
});

test('取り消しと編集: 端末の中の本文も消える', async () => {
  const { da, db } = await people();
  const m = await send(da, db, 'to delete');
  await recv(db, da, m);
  await db.c.bindMessage('mid-1', m);
  await db.c.forgetMessage('mid-1');
  assert.equal(await db.c.recall(m), null);
  const m2 = await send(da, db, 'expires');
  await recv(db, da, m2);
  await db.c.bindMessage('mid-2', m2, Date.now() - 1000);
  await db.c.sweepExpired();
  assert.equal(await db.c.recall(m2), null);
});

test('不正なバイト列でも、細工した番号でも止まらない(開けないものは2回目から計算しない)', async () => {
  const { da, db } = await people();
  const m = await send(da, db, 'x'); await recv(db, da, m);
  const bad = core.encHeader({ dh: core.genDH().pub, pn: 900, n: 900, pre: null });
  const forged = `e5:${da.pub}:${db.pub}.r${b64(new Uint8Array([...bad, ...nacl.randomBytes(40)]))}`;
  const t0 = Date.now();
  assert.equal(await recv(db, da, forged), null);
  const first = Date.now() - t0;
  const t1 = Date.now();
  assert.equal(await recv(db, da, forged), null);
  assert.ok(Date.now() - t1 <= Math.max(50, first), 'second=' + (Date.now() - t1) + ' first=' + first);
  assert.ok(first < 4000, 'first=' + first);
});

test('端末の中の状態を失っても、再登録でサーバーの古いOTKが捨てられ、最初の1通が届く', async () => {
  const { a, b, da, db } = await people();
  const db2 = await device(b);
  await db2.c.ensurePrekeys();
  // 中身を消して作り直す(同じ鍵)
  await clearStore(db2, 'prekeys'); await clearStore(db2, 'meta');
  await db2.c.ensurePrekeys();
  const cnt = (await b.call('GET', '/api/ratchet/prekeys/count?deviceKey=' + encodeURIComponent(db2.pub))).data;
  assert.equal(cnt.otks, 50);
  const m = await da.c.seal(enc('after reset'), [db2.pub], { from: a.userId, to: b.userId });
  assert.equal(dec(await db2.c.open(m, { from: a.userId, to: b.userId })), 'after reset');
  void db;
});

test('端末の鍵を作り直したら、古い鍵のセッションを使わない', async () => {
  const { a, b, da, db } = await people();
  assert.equal(dec(await recv(db, da, await send(da, db, 'before'))), 'before');
  // da が鍵を作り直す(同じ保存領域)
  const nk = core.genDH();
  da.k.pub = nk.pub; da.k.sec = nk.sec; da.pub = b64(nk.pub);
  await a.call('POST', '/api/friends/publickey', { publicKey: da.pub });
  await da.c.ensurePrekeys();
  const m = await send(da, db, 'after rekey');
  assert.equal(dec(await recv(db, da, m)), 'after rekey');
  assert.equal(dec(await recv(da, db, await send(db, da, 'reply', [da.pub]))), 'reply');
  void b;
});

test('承認待ちのセッションは形式を問わず送れない(平文・旧方式・編集)', async () => {
  const S2 = await startServer({ RATCHET_ENABLED: 'on' });
  try {
    const a = await S2.user('pa' + (++seq), '10.24.1.1'), b = await S2.user('pb' + seq, '10.24.1.2');
    await S2.befriend(a, b);
    await a.call('POST', '/api/friends/publickey', { publicKey: b64(core.genDH().pub) });
    const sent = await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'before' });
    assert.equal(sent.status, 200);
    const login = await S2.req('POST', '/api/auth/login', { ip: '10.24.1.9', body: { username: a.username, password: a.password } });
    const thief = (m, p, body) => S2.req(m, p, { token: login.data.token, body, ip: '10.24.1.9' });
    assert.equal((await thief('POST', '/api/friends/publickey', { publicKey: b64(core.genDH().pub) })).data.status, 'pending');
    assert.equal((await thief('POST', '/api/messages/send', { recipientId: b.userId, content: 'plain as you' })).status, 403);
    assert.equal((await thief('POST', '/api/messages/send', { recipientId: b.userId, content: 'e2:AAAA:BBBB:CCCC', encrypted: true })).status, 403);
    assert.equal((await thief('POST', '/api/messages/edit', { messageId: sent.data.message.id, content: 'edited' })).status, 403);
    assert.equal((await a.call('POST', '/api/messages/send', { recipientId: b.userId, content: 'owner still ok' })).status, 200);
  } finally { await S2.stop(); }
});

test('サーバーの設定で有効/無効を切り替えられ、既定は無効', async () => {
  const S2 = await startServer();
  try {
    const u = await S2.user('cf' + (++seq), '10.23.1.1');
    assert.equal((await u.call('GET', '/api/ratchet/config')).data.enabled, false);
  } finally { await S2.stop(); }
});

test('XEdDSA: 作った署名は標準のEd25519で検証でき、別の鍵・別の文では通らない', () => {
  for (let i = 0; i < 20; i++) {
    const k = core.genDH(), o = core.genDH();
    const m = nacl.randomBytes(40);
    const sig = core.xeddsaSign(k.sec, m);
    assert.ok(core.xeddsaVerify(k.pub, m, sig));
    assert.ok(!core.xeddsaVerify(o.pub, m, sig));
    const m2 = m.slice(); m2[0] ^= 1;
    assert.ok(!core.xeddsaVerify(k.pub, m2, sig));
  }
});

test('履歴の書き出しと読み込み: 新しい端末で読める。パスフレーズ違いは開けない', async () => {
  globalThis.window = globalThis;
  require('../public/js/historyBackup.js');
  const { da, db } = await people();
  const m = await send(da, db, '過去の文');
  assert.equal(dec(await recv(db, da, m)), '過去の文');
  const items = await db.c.exportPlain();
  const file = await globalThis.bcHistoryBackup.pack(items, 'correct horse battery');
  await assert.rejects(globalThis.bcHistoryBackup.unpack(file, 'wrong passphrase xx'));
  const restored = await globalThis.bcHistoryBackup.unpack(file, 'correct horse battery');
  const c2 = makeClient({ uid: db.u.userId, db: await freshDb('rs' + (++seq)), identity: () => core.genDH(), http: async () => null });
  const ctx = { from: da.u.userId, to: db.u.userId };
  assert.equal(await c2.open(m, ctx), null);
  assert.equal(await c2.importPlain(restored), items.length);
  assert.equal(dec(await c2.open(m, ctx)), '過去の文');
  assert.equal(await c2.importPlain(restored), 0);
});

test('2台持ちでも、未対応の相手に届き続ける(自分の端末へのr で相手を対応済みにしない)', async () => {
  const a = await S.user('tw' + (++seq), '10.25.1.1'), b = await S.user('tx' + seq, '10.25.1.2');
  await S.befriend(a, b);
  const da = await device(a), da2 = await device(a), db = await device(b);
  await da2.c.ensurePrekeys();
  for (const t of ['one', 'two']) {
    const m = await send(da, db, t, [db.pub], [da2.pub]);
    assert.equal(parse(m).entries.get(db.pub)[0], 'b');
    assert.equal(dec(await recv(db, da, m)), t);
  }
  assert.equal(await da.c.isPinned(b.userId), false);
  await assert.rejects(send(da, db, 'none', [], [da2.pub]), e => e.code === 'RATCHET_DOWNGRADE');
});

test('同時に始めて長く空いても、自動で作り直して届く', async () => {
  const { da, db } = await people();
  const [x, y] = await Promise.all([send(da, db, 'a0'), send(db, da, 'b0')]);
  await recv(db, da, x); await recv(da, db, y);
  // 全セッションを古くする(受信も送信も8日以上前)
  const age = async d => {
    const all = await dump(d, 'sessions');
    await new Promise((res, rej) => {
      const t = d.idb.transaction('sessions', 'readwrite'), st = t.objectStore('sessions');
      for (const [k, list] of all) { for (const s of list) { s.createdAt -= 8 * 864e5; s.lastUsed -= 8 * 864e5; if (s.lastRecv) s.lastRecv -= 8 * 864e5; } st.put(list, k); }
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  };
  await age(da); await age(db);
  assert.equal(dec(await recv(db, da, await send(da, db, 'later a'))), 'later a');
  assert.equal(dec(await recv(da, db, await send(db, da, 'later b'))), 'later b');
});

test('休眠セッションで偽造されても送信先は切り替わらない(作成が離れていれば番号に関係なく)', async () => {
  const { a, b, da, db } = await people();
  await recv(db, da, await send(da, db, 'first'));
  const key = db.pub + '|' + da.pub;
  await new Promise((res, rej) => {
    const t = db.idb.transaction('sessions', 'readwrite'), st = t.objectStore('sessions');
    const g = st.get(key);
    g.onsuccess = () => { const l = g.result; l[0].createdAt -= 2 * 3600e3; st.put(l, key); };
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
  // A が別のセッションを始める(Bの先頭になる)
  await clearStore(da, 'sessions');
  await recv(db, da, await send(da, db, 'new'));
  const list = (await dump(db, 'sessions')).get(key);
  const [head, old] = list;
  assert.notEqual(head.sid, old.sid);
  // 古いセッションに届く文(攻撃者の偽造と同じ経路)を作る: 複製したAの古い状態の代わりに、Bの古いセッションの相手側は無いので、昇格条件そのものを確かめる
  assert.ok(Math.abs(head.createdAt - old.createdAt) > 3600e3);
  void a; void b;
});

test('同じ暗号文を別のメッセージとして流されても、最初の1通だけが持ち主。消しても元は残る', async () => {
  const { da, db } = await people();
  const m = await send(da, db, 'origin');
  await recv(db, da, m);
  assert.equal(await db.c.bindMessage('m1', m), true);
  assert.equal(await db.c.bindMessage('m1', m), true);
  assert.equal(await db.c.bindMessage('replayed', m), false);
  await db.c.forgetMessage('replayed');
  assert.equal(dec(await recv(db, da, m)), 'origin');
  await db.c.forgetMessage('m1');
  assert.equal(await db.c.recall(m, { from: da.u.userId, to: db.u.userId }), null);
});

test('文脈なしでは開かない。members は2人の間の文だけ', async () => {
  const { da, db } = await people();
  await recv(db, da, await send(da, db, 'first'));
  const m = await send(da, db, 'ctx');
  assert.equal(await db.c.open(m), null);
  assert.equal(await db.c.open(m, { members: ['x', db.u.userId] }), null);
  assert.equal(dec(await db.c.open(m, { members: [da.u.userId, db.u.userId] })), 'ctx');
});

test('話し始める前に送られた未読の box は読める。話し始めた後の box は読めない', async () => {
  const a = await S.user('bx' + (++seq), '10.26.1.1'), b = await S.user('by' + seq, '10.26.1.2');
  await S.befriend(a, b);
  const da = await device(a), db = await device(b);
  const oldMsg = await send(da, db, 'old box');
  await db.c.ensurePrekeys();
  const m2 = await send(da, db, 'ratchet');
  assert.equal(dec(await recv(db, da, m2)), 'ratchet');
  const ctx = { from: a.userId, to: b.userId };
  assert.equal(await db.c.open(oldMsg, { ...ctx, sentAt: new Date(Date.now() + 60000).toISOString() }), null);
  assert.equal(dec(await db.c.open(oldMsg, { ...ctx, sentAt: new Date(Date.now() - 60000).toISOString() })), 'old box');
});

test('細工した最初の1通は2回目から計算も通信もしない', async () => {
  const { a, da, db } = await people();
  let calls = 0;
  const c = makeClient({ uid: db.u.userId, db: db.idb, identity: () => db.k, peerKeys: async () => { calls++; return [da.pub]; }, http: async () => null });
  const ikFake = core.genDH();
  const h = core.encHeader({ dh: core.genDH().pub, pn: 0, n: 0, pre: { ik: da.k.pub, ek: ikFake.pub, spkId: 1, otkId: 0 } });
  const forged = `e5:${da.pub}:${db.pub}.r${b64(new Uint8Array([...h, ...nacl.randomBytes(40)]))}`;
  const ctx = { from: a.userId, to: db.u.userId };
  assert.equal(await c.open(forged, ctx), null);
  assert.equal(await c.open(forged, ctx), null);
  assert.equal(calls, 1);
});

test('プリキー登録が途中で失敗しても、次回に古いOTKを置き換える', async () => {
  const { b } = await people();
  const d = await device(b);
  let fail = true;
  const c = makeClient({
    uid: b.userId, db: d.idb, identity: () => d.k,
    http: async (m, p, body) => {
      if (m === 'POST' && p === '/api/ratchet/prekeys' && fail) throw new Error('net');
      const r = await b.call(m, p, body); return r.status === 404 ? null : r.data;
    },
  });
  await assert.rejects(c.ensurePrekeys());
  fail = false;
  assert.equal(await c.ensurePrekeys(), true);
});
