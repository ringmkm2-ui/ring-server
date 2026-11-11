// 通話の指紋の封(js/callAuth.js): サーバーが SDP をすり替えて中間者になるのを端末が見つけられること
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function ctxFor() {
  const store = new Map();
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const ctx = { console, localStorage, crypto: crypto.webcrypto, TextEncoder, TextDecoder, Uint8Array, Map, Set, JSON, Date, Buffer, atob, btoa };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ['nacl.min.js', 'nacl-util.min.js', 'e2eMulti.js', 'callAuth.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8'), ctx, { filename: f });
  return ctx;
}
const fp = () => Array.from(crypto.randomBytes(32), b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
const sdp = f => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ${f}\r\na=setup:actpass\r\n`;

function people() {
  const A = ctxFor(), B = ctxFor();
  const n = A.nacl;
  const kp = () => { const k = n.box.keyPair(); return { pk: n.util.encodeBase64(k.publicKey), sk: k.secretKey }; };
  const alice = kp(), bob = kp(), mallory = kp();
  return { A, B, alice, bob, mallory };
}
function offerSeal(ctx, from, toKeys, o) {
  return ctx.CallAuth.seal({ sdp: o.sdp, callId: o.callId, me: o.me, peer: o.peer, dir: 'offer', secretKey: from.sk, publicKeyB64: from.pk, recipientKeys: toKeys });
}
function bobSession(B, bob, aliceKeys, store, callId = 'c1') {
  return B.CallAuth.createSession({ callId, me: 'B', peer: 'A', ring: [bob], peerKeys: async () => aliceKeys, store });
}

test('正しい封と指紋なら通り、確認済みになる', async () => {
  const { A, B, alice, bob } = people();
  const f = fp(); const s = sdp(f);
  const seal = offerSeal(A, alice, [bob.pk], { sdp: s, callId: 'c1', me: 'A', peer: 'B' });
  assert.ok(seal);
  const v = await bobSession(B, bob, [alice.pk], B.CallAuth.memStore()).verifyRemote(s, seal, 'offer');
  assert.strictEqual(v.ok, true); assert.strictEqual(v.state, 'verified');
});

test('サーバーが SDP の指紋をすり替えると切る', async () => {
  const { A, B, alice, bob } = people();
  const s = sdp(fp());
  const seal = offerSeal(A, alice, [bob.pk], { sdp: s, callId: 'c1', me: 'A', peer: 'B' });
  const v = await bobSession(B, bob, [alice.pk], B.CallAuth.memStore()).verifyRemote(sdp(fp()), seal, 'offer');
  assert.strictEqual(v.ok, false); assert.strictEqual(v.reason, 'mismatch');
});

test('別人(サーバーが作った鍵)が封をしたものは拒否', async () => {
  const { A, B, alice, bob, mallory } = people();
  const s = sdp(fp());
  const seal = offerSeal(A, mallory, [bob.pk], { sdp: s, callId: 'c1', me: 'A', peer: 'B' });
  const v = await bobSession(B, bob, [alice.pk], B.CallAuth.memStore()).verifyRemote(s, seal, 'offer');
  assert.strictEqual(v.ok, false); assert.strictEqual(v.reason, 'unknown_device');
});

test('別の通話の封の使い回しは拒否', async () => {
  const { A, B, alice, bob } = people();
  const s = sdp(fp());
  const seal = offerSeal(A, alice, [bob.pk], { sdp: s, callId: 'old-call', me: 'A', peer: 'B' });
  const v = await bobSession(B, bob, [alice.pk], B.CallAuth.memStore(), 'c1').verifyRemote(s, seal, 'offer');
  assert.strictEqual(v.ok, false); assert.strictEqual(v.reason, 'wrong_call');
});

test('自分の封を跳ね返されても受け付けない', async () => {
  const { B, bob } = people();
  const s = sdp(fp());
  const seal = B.CallAuth.seal({ sdp: s, callId: 'c1', me: 'A', peer: 'B', dir: 'offer', secretKey: bob.sk, publicKeyB64: bob.pk, recipientKeys: [bob.pk] });
  const v = await bobSession(B, bob, [bob.pk], B.CallAuth.memStore()).verifyRemote(s, seal, 'offer');
  assert.strictEqual(v.ok, false);
});

test('応答(answer)は自分の指紋に結び付いている。別の通話の応答は拒否', async () => {
  const { A, B, alice, bob } = people();
  const aliceSdp = sdp(fp()), bobSdp = sdp(fp());
  const ans = B.CallAuth.seal({ sdp: bobSdp, remoteSdp: aliceSdp, callId: 'c1', me: 'B', peer: 'A', dir: 'answer', secretKey: bob.sk, publicKeyB64: bob.pk, recipientKeys: [alice.pk] });
  const mk = () => A.CallAuth.createSession({ callId: 'c1', me: 'A', peer: 'B', ring: [alice], peerKeys: async () => [bob.pk], store: A.CallAuth.memStore() });
  assert.strictEqual((await mk().verifyRemote(bobSdp, ans, 'answer', aliceSdp)).ok, true);
  const other = await mk().verifyRemote(bobSdp, ans, 'answer', sdp(fp()));
  assert.strictEqual(other.ok, false); assert.strictEqual(other.reason, 'wrong_call');
});

test('古いアプリ(封なし)は通すが未確認。一度封を見た相手が封なしならダウングレードとして切る', async () => {
  const { A, B, alice, bob } = people();
  const store = B.CallAuth.memStore();
  const s1 = sdp(fp());
  const legacy = await bobSession(B, bob, [alice.pk], store).verifyRemote(s1, undefined, 'offer');
  assert.strictEqual(legacy.ok, true); assert.strictEqual(legacy.state, 'legacy');
  const seal = offerSeal(A, alice, [bob.pk], { sdp: s1, callId: 'c2', me: 'A', peer: 'B' });
  assert.strictEqual((await bobSession(B, bob, [alice.pk], store, 'c2').verifyRemote(s1, seal, 'offer')).ok, true);
  const down = await bobSession(B, bob, [alice.pk], store, 'c3').verifyRemote(sdp(fp()), undefined, 'offer');
  assert.strictEqual(down.ok, false); assert.strictEqual(down.reason, 'downgrade');
});

test('通話の途中で指紋が変わったら切る', async () => {
  const { A, B, alice, bob } = people();
  const s = sdp(fp());
  const sess = bobSession(B, bob, [alice.pk], B.CallAuth.memStore());
  const seal = offerSeal(A, alice, [bob.pk], { sdp: s, callId: 'c1', me: 'A', peer: 'B' });
  assert.strictEqual((await sess.verifyRemote(s, seal, 'offer')).ok, true);
  const later = await sess.verifyRemote(sdp(fp()), undefined, 'offer');
  assert.strictEqual(later.ok, false);
});

test('壊れた指紋行・弱いハッシュは拒否', () => {
  const { B } = people();
  assert.strictEqual(B.CallAuth.checkSdp('a=fingerprint:sha-256 ZZ\r\n', ['sha-256 AA']).ok, false);
  const f = fp();
  assert.strictEqual(B.CallAuth.checkSdp(`a=fingerprint:sha-1 ${f}\r\n`, ['sha-1 ' + f]).reason, 'weak');
});

test('サーバーは形の合う封だけ中継する', () => {
  const { cleanFpSeal } = require('../ws/wsServer');
  const { A, alice, bob } = people();
  const good = offerSeal(A, alice, [bob.pk], { sdp: sdp(fp()), callId: 'c1', me: 'A', peer: 'B' });
  assert.strictEqual(cleanFpSeal(good), good);
  assert.strictEqual(cleanFpSeal('<script>'), undefined);
  assert.strictEqual(cleanFpSeal('e3:' + 'A'.repeat(30000)), undefined);
  assert.strictEqual(cleanFpSeal(123), undefined);
});

test('この通話で初めて見た端末の鍵なら「確認済み」にしない(サーバーが鍵を混ぜた場合)', async () => {
  const { A, B, alice, bob, mallory } = people();
  const s = sdp(fp());
  const seal = offerSeal(A, mallory, [bob.pk], { sdp: s, callId: 'c1', me: 'A', peer: 'B' });
  const sess = B.CallAuth.createSession({ callId: 'c1', me: 'B', peer: 'A', ring: [bob], peerKeys: async () => [alice.pk, mallory.pk], store: B.CallAuth.memStore(), checkSender: () => ({ ok: true, added: true }) });
  const v = await sess.verifyRemote(s, seal, 'offer');
  assert.strictEqual(v.ok, true); assert.strictEqual(v.state, 'new_key');
});

test('初めての相手(記録なし)も「確認済み」にしない。古い封(10分より前)は拒否', async () => {
  const { A, B, alice, bob } = people();
  const s = sdp(fp());
  const seal = offerSeal(A, alice, [bob.pk], { sdp: s, callId: 'c1', me: 'A', peer: 'B' });
  const sess = B.CallAuth.createSession({ callId: 'c1', me: 'B', peer: 'A', ring: [bob], peerKeys: async () => [alice.pk], store: B.CallAuth.memStore(), checkSender: () => ({ ok: true, added: false, first: true }) });
  assert.strictEqual((await sess.verifyRemote(s, seal, 'offer')).state, 'new_key');
  const old = A.CallAuth.seal({ sdp: s, callId: 'c1', me: 'A', peer: 'B', dir: 'offer', secretKey: alice.sk, publicKeyB64: alice.pk, recipientKeys: [bob.pk], now: Date.now() - 11 * 60 * 1000 });
  const v = await bobSession(B, bob, [alice.pk], B.CallAuth.memStore()).verifyRemote(s, old, 'offer');
  assert.strictEqual(v.ok, false); assert.strictEqual(v.reason, 'wrong_call');
});
