// 個人チャットの暗号(X3DH + Double Ratchet)の中核。テストは暗号の性質そのものを確かめる
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
globalThis.nacl = require('../public/js/nacl.min.js');
globalThis.nacl.util = require('../public/js/nacl-util.min.js');
require('../public/js/ratchet.js');
const R = globalThis.E2ERatchet.core;
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);

function pair(withOtk = true) {
  const ikA = R.genDH(), ikB = R.genDH(), spk = R.genDH(), otk = R.genDH();
  const a = R.x3dhInitiate(ikA, { ik: ikB.pub, spk: { id: 1, pub: spk.pub }, otk: withOtk ? { id: 7, pub: otk.pub } : null });
  const first = R.ratchetEncrypt(a, enc('first'));
  const h = R.decHeader(first);
  const b = R.x3dhRespond(ikB, spk, withOtk ? otk : null, h.pre);
  assert.equal(dec(R.ratchetDecrypt(b, first)), 'first');
  return { a, b, ikA, ikB, spk, otk };
}

test('HMAC-SHA512 と HKDF は標準の実装と一致する', () => {
  const k = crypto.randomBytes(40), m = crypto.randomBytes(300);
  assert.equal(Buffer.from(R.hmac(new Uint8Array(k), new Uint8Array(m))).toString('hex'), crypto.createHmac('sha512', k).update(m).digest('hex'));
  const long = crypto.randomBytes(200);
  assert.equal(Buffer.from(R.hmac(new Uint8Array(long), new Uint8Array(m))).toString('hex'), crypto.createHmac('sha512', long).update(m).digest('hex'));
  const salt = crypto.randomBytes(32), info = Buffer.from('i');
  assert.equal(Buffer.from(R.hkdf(new Uint8Array(salt), new Uint8Array(m), new Uint8Array(info), 100)).toString('hex'), Buffer.from(crypto.hkdfSync('sha512', m, salt, info, 100)).toString('hex'));
});

test('往復できる。OTKなしでも同じ', () => {
  for (const w of [true, false]) {
    const { a, b } = pair(w);
    assert.equal(dec(R.ratchetDecrypt(a, R.ratchetEncrypt(b, enc('r1')))), 'r1');
    for (let i = 0; i < 5; i++) assert.equal(dec(R.ratchetDecrypt(b, R.ratchetEncrypt(a, enc('m' + i)))), 'm' + i);
    assert.equal(dec(R.ratchetDecrypt(a, R.ratchetEncrypt(b, enc('r2')))), 'r2');
  }
});

test('順番が入れ替わっても読める', () => {
  const { a, b } = pair();
  const msgs = [0, 1, 2, 3, 4].map(i => R.ratchetEncrypt(a, enc('m' + i)));
  for (const i of [3, 0, 4, 2, 1]) assert.equal(dec(R.ratchetDecrypt(b, msgs[i])), 'm' + i);
  // チェーンをまたいでも
  const old = R.ratchetEncrypt(a, enc('old'));
  const rep = R.ratchetEncrypt(b, enc('rep'));
  assert.equal(dec(R.ratchetDecrypt(a, rep)), 'rep');
  const nw = R.ratchetEncrypt(a, enc('new'));
  assert.equal(dec(R.ratchetDecrypt(b, nw)), 'new');
  assert.equal(dec(R.ratchetDecrypt(b, old)), 'old');
});

test('同じ暗号文の再送は開けない', () => {
  const { a, b } = pair();
  const m = R.ratchetEncrypt(a, enc('once'));
  assert.equal(dec(R.ratchetDecrypt(b, m)), 'once');
  assert.throws(() => R.ratchetDecrypt(b, m));
});

test('前方秘匿性: 今の状態を全部盗んでも、受信済みの暗号文は開けない', () => {
  const { a, b } = pair();
  const past = [];
  for (let i = 0; i < 3; i++) { const m = R.ratchetEncrypt(a, enc('secret' + i)); past.push(m); R.ratchetDecrypt(b, m); }
  const m2 = R.ratchetEncrypt(b, enc('x')); R.ratchetDecrypt(a, m2);
  const m3 = R.ratchetEncrypt(a, enc('secret3')); past.push(m3); R.ratchetDecrypt(b, m3);
  const stolen = R.cloneState(b);
  for (const m of past) assert.throws(() => R.ratchetDecrypt(R.cloneState(stolen), m));
});

test('侵害後の回復: 状態を盗まれても、相手が新しいDH鍵を受け取った後は読めない', () => {
  const { a, b } = pair();
  const stolen = R.cloneState(b);
  const before = R.ratchetEncrypt(a, enc('still readable'));
  assert.equal(dec(R.ratchetDecrypt(R.cloneState(stolen), before)), 'still readable', '回復前は読まれる(理論どおり)');
  R.ratchetDecrypt(b, before);
  R.ratchetDecrypt(a, R.ratchetEncrypt(b, enc('reply')));
  // Bの次のDH鍵は盗まれた後に作られるので、AがそれとDHした後の本文は盗んだ状態では開けない
  const m1 = R.ratchetEncrypt(a, enc('m1'));
  assert.equal(dec(R.ratchetDecrypt(b, m1)), 'm1');
  R.ratchetDecrypt(a, R.ratchetEncrypt(b, enc('reply2')));
  const after = R.ratchetEncrypt(a, enc('after'));
  assert.equal(dec(R.ratchetDecrypt(b, after)), 'after');
  assert.throws(() => R.ratchetDecrypt(R.cloneState(stolen), after));
});

test('改ざんは開けない: 本文・見出しの番号・DH鍵・前の長さ', () => {
  const { a, b } = pair();
  const m = R.ratchetEncrypt(a, enc('integrity'));
  const flip = i => { const c = m.slice(); c[i] ^= 1; return c; };
  for (const i of [m.length - 1, 2, 34 + 3, 38 + 3]) assert.throws(() => R.ratchetDecrypt(R.cloneState(b), flip(i)), 'at ' + i);
  assert.equal(dec(R.ratchetDecrypt(R.cloneState(b), m)), 'integrity');
});

test('別の相手あての暗号文は開けない(宛先が認証される)', () => {
  const p1 = pair(), p2 = pair();
  assert.throws(() => R.ratchetDecrypt(R.cloneState(p2.b), R.ratchetEncrypt(p1.a, enc('x'))));
});

test('開けない暗号文を送られても、状態を複製して試せば壊れない', () => {
  const { a, b } = pair();
  const good = R.ratchetEncrypt(a, enc('good'));
  const bad = good.slice(); bad[bad.length - 1] ^= 1;
  assert.throws(() => R.ratchetDecrypt(R.cloneState(b), bad));
  assert.equal(dec(R.ratchetDecrypt(b, good)), 'good');
});

test('巨大な番号で計算を止められない', () => {
  const { a, b } = pair();
  const m = R.ratchetEncrypt(a, enc('x'));
  const big = m.slice(); new DataView(big.buffer).setUint32(38, 0xfffffff0);
  const t = Date.now();
  assert.throws(() => R.ratchetDecrypt(R.cloneState(b), big));
  assert.ok(Date.now() - t < 200);
});

test('小さな部分群の公開鍵(共有鍵が0になる)を拒否する', () => {
  const me = R.genDH();
  assert.throws(() => R.dh(me.sec, new Uint8Array(32)));
  const low = new Uint8Array(32); low[0] = 1;
  assert.throws(() => R.dh(me.sec, low));
});

test('同じ鍵は2回使わない: 連続した暗号文の本文は全部違う', () => {
  const { a } = pair();
  const seen = new Set();
  for (let i = 0; i < 50; i++) { const h = Buffer.from(R.ratchetEncrypt(a, enc('same'))).toString('base64'); assert.ok(!seen.has(h)); seen.add(h); }
});

test('3000通続けても遅くならない', () => {
  const { a, b } = pair();
  const t = Date.now();
  for (let i = 0; i < 3000; i++) R.ratchetDecrypt(b, R.ratchetEncrypt(a, enc('load')));
  assert.ok(Date.now() - t < 15000, 'ms=' + (Date.now() - t));
});
