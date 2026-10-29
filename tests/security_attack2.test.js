// 攻撃テスト 2回目(2026-10-29)。1回目で残した穴:
//  1) サーバー(または乗っ取った人)がグループ鍵やDMの送り手を偽る
//  2) Cloudinaryの署名なしアップロード(誰でも置ける)
//  3) Googleドライブの置き場所の制限(本物のGoogleには繋がず、偽物に差し替えて本物のルートを叩く)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { startServer } = require('./helpers');

// ---------- 1) 端末側の暗号(ブラウザと同じJSをそのまま動かす) ----------
function browserCtx(myUserId) {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
    clear: () => store.clear(),
  };
  const ctx = { console, localStorage, crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout, Buffer, atob, btoa };
  ctx.window = ctx; ctx.self = ctx; ctx.myUserId = myUserId;
  vm.createContext(ctx);
  for (const f of ['nacl.min.js', 'nacl-util.min.js', 'e2eMulti.js', 'safetyNumber.js', 'groupE2E.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}
const b64 = (ctx, u8) => ctx.nacl.util.encodeBase64(u8);

test('攻撃: サーバーが自分の鍵でグループ鍵を配り、メンバーが配ったことにする', async () => {
  const bob = browserCtx('bob');
  const nacl = bob.nacl;
  const bobKp = nacl.box.keyPair();
  bob.localStorage.setItem('e2e_keypair_bob', JSON.stringify({ publicKey: Array.from(bobKp.publicKey), secretKey: Array.from(bobKp.secretKey) }));
  bob.getOrCreateMyKeyPair = async () => bobKp;
  const alice = nacl.box.keyPair();      // 本物のアリスの端末
  const server = nacl.box.keyPair();     // サーバーがこっそり作った鍵
  const groupKey = nacl.randomBytes(32);
  const sealBy = (kp, from) => JSON.stringify({ e3: bob.E2EMulti.seal(groupKey, kp.secretKey, b64(bob, kp.publicKey), [b64(bob, bobKp.publicKey)]), fromUserId: from });

  // ボブは以前アリスとトークして、アリスの鍵を覚えている(そして安全番号を確認済み)
  bob.SafetyNumber.observe('bob', 'alice', [b64(bob, alice.publicKey)]);
  bob.SafetyNumber.setVerified('bob', 'alice', [b64(bob, alice.publicKey)], true);

  // 本物のアリスが配った鍵は受け取れる
  const ok = await bob.groupE2E.decryptGroupKey(sealBy(alice, 'alice'));
  assert.strictEqual(Buffer.from(ok).toString('hex'), Buffer.from(groupKey).toString('hex'));

  // サーバーが自分の鍵で包んで「アリスが配った」と書いた鍵は拒否する
  await assert.rejects(() => bob.groupE2E.decryptGroupKey(sealBy(server, 'alice')), e => e.code === 'UNVERIFIED_DISTRIBUTOR', '確認済みのメンバーを名乗る偽の鍵を受け取った');
  // 配り手が書かれていない/自分を名乗るのも拒否
  await assert.rejects(() => bob.groupE2E.decryptGroupKey(sealBy(server, '')));
  await assert.rejects(() => bob.groupE2E.decryptGroupKey(sealBy(server, 'bob')));

  // 確認していない相手(キャロル)を名乗った場合: 受け取るが「鍵が変わりました」が出る
  const carol = nacl.box.keyPair();
  bob.SafetyNumber.observe('bob', 'carol', [b64(bob, carol.publicKey)]);
  await bob.groupE2E.decryptGroupKey(sealBy(server, 'carol'));
  const st = bob.SafetyNumber.status('bob', 'carol', [b64(bob, carol.publicKey)]);
  assert.ok(st.alert && st.alert.added.includes(b64(bob, server.publicKey)), '知らない鍵で配られたのに警告が出ない');
});

test('攻撃: サーバーが相手になりすましてDMを差し込む(送り手の鍵の確認)', () => {
  const bob = browserCtx('bob');
  const nacl = bob.nacl;
  const alice = nacl.box.keyPair();
  const server = nacl.box.keyPair();
  const A = b64(bob, alice.publicKey), S = b64(bob, server.publicKey);
  // 初めての相手は覚えるだけ
  assert.deepStrictEqual({ ...bob.SafetyNumber.checkSender('bob', 'alice', A) }, { ok: true, added: false });
  assert.strictEqual(bob.SafetyNumber.checkSender('bob', 'alice', A).ok, true);
  // 確認済みにした後、知らない鍵で届いたら「確認できない」
  bob.SafetyNumber.setVerified('bob', 'alice', [A], true);
  const r = bob.SafetyNumber.checkSender('bob', 'alice', S);
  assert.strictEqual(r.ok, false, '確認済みの相手を名乗る知らない鍵のメッセージを本物扱いした');
  // そのまま送ろうとすると止まる(既存の安全番号の仕組み)
  const st = bob.SafetyNumber.status('bob', 'alice', [A, S]);
  assert.strictEqual(st.hold, true);
  // 確認待ちの鍵にはグループ鍵を配らない
  assert.deepStrictEqual([...bob.SafetyNumber.unconfirmedKeys('bob', 'alice')], [S]);
});

// ---------- 2) 3) サーバー ----------
test('攻撃: アップロードの置き場所(Cloudinary署名・Googleドライブ)', { timeout: 120000 }, async (t) => {
  const s = await startServer({
    CLOUDINARY_CLOUD_NAME: 'a6rxinoz', CLOUDINARY_API_KEY: 'k123', CLOUDINARY_API_SECRET: 'secret-for-test',
    NODE_OPTIONS: `--require ${path.join(__dirname, 'stub_gdrive.js')}`,
  });
  try {
    const A = await s.user('Alice');
    const B = await s.user('Bob');
    const X = await s.user('Stranger');
    await s.befriend(A, B);
    const dm = `brochat/dm/${[A.userId, B.userId].sort().join('_')}`;

    await t.test('署名: 自分の会話には出る / 他人の会話・好きな場所・ログイン無しには出ない', async () => {
      const ok = await A.call('POST', '/api/media/sign', { folder: dm + '/file123' });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok));
      const crypto = require('crypto');
      const want = crypto.createHash('sha256').update(`folder=${dm}/file123&timestamp=${ok.data.timestamp}secret-for-test`).digest('hex');
      assert.strictEqual(ok.data.signature, want, '署名の作り方がCloudinaryの仕様と違う');
      assert.strictEqual((await X.call('POST', '/api/media/sign', { folder: dm + '/file123' })).status, 403, '他人の会話の署名が出た');
      assert.strictEqual((await A.call('POST', '/api/media/sign', { folder: 'malware' })).status, 403, '好きなフォルダの署名が出た');
      assert.strictEqual((await A.call('POST', '/api/media/sign', { folder: `brochat/dm/${A.userId}` })).status, 403, '相手のいないDMの署名が出た');
      assert.strictEqual((await A.call('POST', '/api/media/sign', { folder: `brochat/posts/${B.userId}` })).status, 403, '他人の投稿フォルダの署名が出た');
      assert.strictEqual((await s.req('POST', '/api/media/sign', { body: { folder: 'brochat/reports' } })).status, 401, 'ログイン無しで署名が出た');
    });

    const put = (u, scope, bytes) => fetch(s.base + '/api/drive/upload', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + u.token, 'content-type': 'application/octet-stream', 'x-scope': scope, 'x-forwarded-for': u.ip, 'content-length': String(bytes.length) },
      body: bytes,
    });

    await t.test('ドライブ: 相手のいない "brochat/dm/<自分>" で公式ドライブを埋める', async () => {
      const r = await put(A, `brochat/dm/${A.userId}`, Buffer.alloc(1024));
      assert.strictEqual(r.status, 403, '相手のいないDMに置けた');
      const r2 = await put(X, dm, Buffer.alloc(1024));
      assert.strictEqual(r2.status, 403, '他人のDMに置けた');
      const ok = await put(A, dm, Buffer.alloc(1024));
      assert.strictEqual(ok.status, 200, '友だちとのDMに置けない: ' + ok.status);
    });

    await t.test('ドライブ: 1日の上限を超えて置く', async () => {
      const s2 = await startServer({ NODE_OPTIONS: `--require ${path.join(__dirname, 'stub_gdrive.js')}`, DRIVE_DAILY_BYTES_PER_USER: String(3 * 1024 * 1024) });
      try {
        const C = await s2.user('C'); const D = await s2.user('D');
        await s2.befriend(C, D);
        const scope = `brochat/dm/${[C.userId, D.userId].sort().join('_')}`;
        const up = () => fetch(s2.base + '/api/drive/upload', { method: 'POST', headers: { authorization: 'Bearer ' + C.token, 'content-type': 'application/octet-stream', 'x-scope': scope, 'x-forwarded-for': C.ip, 'content-length': String(1024 * 1024) }, body: Buffer.alloc(1024 * 1024) });
        const codes = [];
        for (let i = 0; i < 5; i++) codes.push((await up()).status);
        assert.deepStrictEqual(codes.slice(0, 3), [200, 200, 200]);
        assert.strictEqual(codes[4], 429, '1日の上限を超えても置けた: ' + codes.join(','));
      } finally { await s2.stop(); }
    });
  } finally { await s.stop(); }
});
