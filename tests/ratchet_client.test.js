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

async function device(u) {
  const k = core.genDH();
  await u.call('POST', '/api/friends/publickey', { publicKey: b64(k.pub) });
  const d = { pub: b64(k.pub), k };
  d.c = makeClient({
    uid: 'd' + (++seq),
    identity: () => k,
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

test('往復。暗号文に本文は無く、自分の分は端末の中に残る', async () => {
  const { da, db } = await people();
  const m = await da.c.seal(enc('こんにちは'), [db.pub]);
  assert.ok(isRatchet(m));
  assert.ok(!m.includes(b64(enc('こんにちは'))));
  assert.equal(parse(m).entries.get(db.pub)[0], 'r');
  assert.equal(dec(await db.c.open(m)), 'こんにちは');
  assert.equal(dec(await da.c.open(m)), 'こんにちは', '送った端末は保存分を読む');
  const r = await db.c.seal(enc('返事'), [da.pub]);
  assert.equal(dec(await da.c.open(r)), '返事');
});

test('同じ暗号文は何度開いても同じ本文(履歴の再表示)。鍵は1回しか進まない', async () => {
  const { da, db } = await people();
  const ms = [];
  for (let i = 0; i < 4; i++) ms.push(await da.c.seal(enc('m' + i), [db.pub]));
  for (const i of [2, 0, 3, 1, 2, 0]) assert.equal(dec(await db.c.open(ms[i])), 'm' + i);
});

test('同時に開いても(ページとService Workerなど)壊れない', async () => {
  const { da, db } = await people();
  const m1 = await da.c.seal(enc('a'), [db.pub]);
  const m2 = await da.c.seal(enc('b'), [db.pub]);
  const rs = await Promise.all([db.c.open(m1), db.c.open(m1), db.c.open(m2), db.c.open(m2), db.c.open(m1)]);
  assert.deepEqual(rs.map(dec), ['a', 'a', 'b', 'b', 'a']);
});

test('同時に送っても、同じ鍵を使い回さない', async () => {
  const { da, db } = await people();
  await da.c.seal(enc('0'), [db.pub]);
  const ms = await Promise.all([1, 2, 3, 4, 5].map(i => da.c.seal(enc(String(i)), [db.pub])));
  const texts = [];
  for (const m of ms) texts.push(dec(await db.c.open(m)));
  assert.deepEqual(texts.sort(), ['1', '2', '3', '4', '5']);
});

test('両方が同時に話し始めても、両方の通が読める', async () => {
  const { da, db } = await people();
  const [x, y] = await Promise.all([da.c.seal(enc('from a'), [db.pub]), db.c.seal(enc('from b'), [da.pub])]);
  assert.equal(dec(await db.c.open(x)), 'from a');
  assert.equal(dec(await da.c.open(y)), 'from b');
  assert.equal(dec(await db.c.open(await da.c.seal(enc('next a'), [db.pub]))), 'next a');
  assert.equal(dec(await da.c.open(await db.c.seal(enc('next b'), [da.pub]))), 'next b');
});

test('複数の端末: 相手の全端末と自分の他の端末が読める', async () => {
  const { a, b, da, db } = await people();
  const da2 = await device(a), db2 = await device(b);
  await da2.c.ensurePrekeys(); await db2.c.ensurePrekeys();
  const m = await da.c.seal(enc('全員へ'), [db.pub, db2.pub, da2.pub, da.pub]);
  assert.equal(parse(m).entries.size, 3, '自分の端末の分は入れない');
  for (const d of [db, db2, da2]) assert.equal(dec(await d.c.open(m)), '全員へ');
});

test('まだ対応していない端末には移行期間だけ box で届く。対応後の端末は box に戻らない(サーバーがプリキーを隠しても)', async () => {
  const a = await S.user('dg' + (++seq), '10.21.1.1'), b = await S.user('dh' + seq, '10.21.1.2');
  await S.befriend(a, b);
  const da = await device(a), db = await device(b);
  const m = await da.c.seal(enc('old device'), [db.pub]);
  assert.equal(parse(m).entries.get(db.pub)[0], 'b');
  assert.equal(dec(await db.c.open(m)), 'old device');
  await db.c.ensurePrekeys();
  const db2 = await device(b);
  await db2.c.ensurePrekeys();
  const m2 = await da.c.seal(enc('new'), [db2.pub]);
  assert.equal(parse(m2).entries.get(db2.pub)[0], 'r');
  // プリキーを隠すサーバーの場合: 対応を知っている端末へ、セッションが無くなった後に box で送らない
  const uid = 'hide' + (++seq);
  let hide = false;
  const real = async (m, p) => { const r = await a.call(m, p); return r.status === 200 ? r.data : null; };
  const c2 = makeClient({ uid, identity: () => da.k, http: (m, p) => (hide ? Promise.resolve(null) : real(m, p)) });
  assert.equal(parse(await c2.seal(enc('r'), [db2.pub])).entries.get(db2.pub)[0], 'r');
  await new Promise((res, rej) => {
    const o = indexedDB.open('bc_e5_' + uid, 1);
    o.onsuccess = () => { const t = o.result.transaction('sessions', 'readwrite'); t.objectStore('sessions').clear(); t.oncomplete = res; t.onerror = rej; };
    o.onerror = rej;
  });
  hide = true;
  await assert.rejects(c2.seal(enc('x'), [db2.pub]), e => e.code === 'RATCHET_DOWNGRADE');
});

test('プリキーAPI: OTKは同時に取っても重複せず、知らない人には渡らず、他人の端末には置けない', async () => {
  const { a, b, da, db } = await people();
  const got = await Promise.all(Array.from({ length: 10 }, () => a.call('GET', '/api/ratchet/bundle/' + encodeURIComponent(db.pub))));
  const ids = got.map(r => r.data.otk && r.data.otk.id);
  assert.equal(new Set(ids).size, 10);
  const c = await S.user('st' + (++seq), '10.22.1.1');
  assert.equal((await c.call('GET', '/api/ratchet/bundle/' + encodeURIComponent(db.pub))).status, 404);
  const spk = { id: 9, pub: b64(core.genDH().pub) };
  assert.equal((await c.call('POST', '/api/ratchet/prekeys', { deviceKey: db.pub, spk, otks: [] })).status, 403);
  // 使い切ってもSPKだけで始められる
  for (let i = 0; i < 60; i++) await a.call('GET', '/api/ratchet/bundle/' + encodeURIComponent(db.pub));
  const last = await a.call('GET', '/api/ratchet/bundle/' + encodeURIComponent(db.pub));
  assert.equal(last.status, 200);
  assert.equal(last.data.otk, null);
  const m = await da.c.seal(enc('otkなし'), [db.pub]);
  assert.equal(dec(await db.c.open(m)), 'otkなし');
});

test('使ったOTKの秘密鍵は端末から消え、最初の1通の再送を受け付けない', async () => {
  const { da, db } = await people();
  const m = await da.c.seal(enc('once'), [db.pub]);
  assert.equal(dec(await db.c.open(m)), 'once');
  // 保存された本文を消して、鍵だけで開こうとする(本文の保存を飛ばして再送された想定)
  const entries = m.split(':');
  const tampered = 'e5:' + entries[1] + ':' + entries[2] + (entries[3] ? ':' + entries[3] : '') + ',x.r' ;
  assert.equal(await db.c.open(tampered), null, '同じ本体を別の文字列として送っても開けない');
});

test('サーバーの設定で有効/無効を切り替えられ、既定は無効', async () => {
  const S2 = await startServer();
  try {
    const u = await S2.user('cf' + (++seq), '10.23.1.1');
    assert.equal((await u.call('GET', '/api/ratchet/config')).data.enabled, false);
  } finally { await S2.stop(); }
  const S3 = await startServer({ RATCHET_USERS: 'NOPE' });
  try {
    const u = await S3.user('cg' + (++seq), '10.23.1.2');
    assert.equal((await u.call('GET', '/api/ratchet/config')).data.enabled, false);
  } finally { await S3.stop(); }
});

test('履歴の書き出しと読み込み: 新しい端末で過去の本文が読める。パスフレーズが違えば開けない。鍵は移らない', async () => {
  globalThis.window = globalThis;
  globalThis.bcE5 = null;
  require('../public/js/historyBackup.js');
  const { da, db } = await people();
  const m = await da.c.seal(enc('過去の文'), [db.pub]);
  assert.equal(dec(await db.c.open(m)), '過去の文');
  const items = await db.c.exportPlain();
  assert.equal(items.length, 1);
  const file = await globalThis.bcHistoryBackup.pack(items, 'correct horse battery');
  assert.ok(!file.includes(b64(enc('過去の文'))));
  await assert.rejects(globalThis.bcHistoryBackup.unpack(file, 'wrong passphrase xx'));
  const restored = await globalThis.bcHistoryBackup.unpack(file, 'correct horse battery');
  const nw = core.genDH();
  const c2 = makeClient({ uid: 'restore' + (++seq), identity: () => nw, http: async () => null });
  assert.equal(await c2.open(m), null, '読み込む前は読めない');
  assert.equal(await c2.importPlain(restored), 1);
  assert.equal(dec(await c2.open(m)), '過去の文');
  assert.equal(await c2.importPlain(restored), 0, '二重に入らない');
});
