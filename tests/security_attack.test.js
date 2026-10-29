// 攻撃テスト(2026-10-29 のセキュリティ監査で見つけた穴)。
// 実際に攻撃者と同じ手順でローカルのサーバーを叩き、「攻撃が通らない」ことを確かめる。
// 本番には一切触らない(サーバーはこのテストの中で起動する一時的なもの)。
const test = require('node:test');
const assert = require('node:assert');
const { startServer, sleep } = require('./helpers');
const { startSmtpSink } = require('./smtp_sink');

const FAKE_KEY = (n) => ('A'.repeat(40) + String(n)).slice(-43) + '=';
async function uploadKeys(u, otkCount = 0) {
  const oneTimePrekeys = [];
  for (let i = 0; i < otkCount; i++) oneTimePrekeys.push({ keyId: i + 1, pubkey: FAKE_KEY('o' + i + u.userId.slice(0, 4)) });
  const r = await u.call('POST', '/api/prekeys/upload', {
    identityPubkey: FAKE_KEY('i' + u.userId.slice(0, 6)),
    signedPrekeyPub: FAKE_KEY('s' + u.userId.slice(0, 6)),
    signedPrekeySig: FAKE_KEY('g' + u.userId.slice(0, 6)) + FAKE_KEY('h'),
    registrationId: 1,
    oneTimePrekeys,
  });
  assert.strictEqual(r.status, 200, 'prekey upload: ' + JSON.stringify(r));
}
const groupIdOf = r => (r.data && (r.data.groupId || r.data.id || (r.data.group && r.data.group.id)));
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return false; };

// ---------- メールが要る攻撃(認証前アカウントの乗っ取り / 再設定コードの総当たり) ----------
test('攻撃: 認証前アカウントのパスワード差し替えで乗っ取る', async () => {
  const smtp = await startSmtpSink();
  const s = await startServer(smtp.env);
  try {
    const email = `victim_${Date.now()}@example.com`;
    const victimPw = 'Vq8!mZvictimxL2';
    const attackerPw = 'Vq8!mZattackxL9';
    // 1) 本人が登録(認証待ち)
    let r = await s.req('POST', '/api/auth/register', { body: { username: email, password: victimPw, displayName: 'V', realName: '山田 花子' } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.needsVerification);
    // 2) 攻撃者が同じメールで登録し直して、パスワードを自分のものに差し替える
    r = await s.req('POST', '/api/auth/register', { body: { username: email, password: attackerPw, displayName: 'V', realName: '山田 花子' } });
    // 3) 本人が届いたコードを入れる(古いアプリはパスワードを送らない / 新しいアプリは本人のパスワードを送る)
    await waitFor(() => smtp.lastCode(email));
    const code = smtp.lastCode(email);
    assert.ok(code, 'code mail not received');
    const old = await s.req('POST', '/api/auth/verify-email', { body: { username: email, code } });
    assert.notStrictEqual(old.status, 200, 'パスワード無しで認証が通った(乗っ取り可能)');
    const fresh = await s.req('POST', '/api/auth/verify-email', { body: { username: email, code, password: victimPw } });
    assert.notStrictEqual(fresh.status, 200, '他人に差し替えられたパスワードのまま認証が通った');
    // 4) 攻撃者が自分のパスワードでログイン → トークンが出てはいけない
    const atk = await s.req('POST', '/api/auth/login', { body: { username: email, password: attackerPw } });
    assert.ok(!(atk.data && atk.data.token), '攻撃者がログインできた: ' + JSON.stringify(atk));
    // 5) 本人が登録し直せば、本人のパスワードで認証できる
    r = await s.req('POST', '/api/auth/register', { body: { username: email, password: victimPw, displayName: 'V', realName: '山田 花子' } });
    await sleep(200);
    const ok = await s.req('POST', '/api/auth/verify-email', { body: { username: email, code: smtp.lastCode(email), password: victimPw } });
    assert.strictEqual(ok.status, 200, '本人の正しい手順が通らない: ' + JSON.stringify(ok));
    assert.ok(ok.data.token);
  } finally { await s.stop(); await smtp.close(); }
});

test('攻撃: パスワード再設定コードを何度も取り直して総当たり', { timeout: 240000 }, async () => {
  const smtp = await startSmtpSink();
  const s = await startServer(smtp.env);
  try {
    const email = `reset_${Date.now()}@example.com`;
    const pw = 'Vq8!mZresetxL2';
    await s.req('POST', '/api/auth/register', { body: { username: email, password: pw, displayName: 'R', realName: '山田 次郎' } });
    await waitFor(() => smtp.lastCode(email));
    const v = await s.req('POST', '/api/auth/verify-email', { body: { username: email, code: smtp.lastCode(email), password: pw } });
    assert.strictEqual(v.status, 200);
    // 攻撃者: 「コードを出させる → 5回外す」を3周(15回外す)。周ごとにIPを変える
    for (let round = 0; round < 3; round++) {
      if (round) await sleep(61000); // コードの再発行は1分に1回
      await s.req('POST', '/api/auth/forgot-password', { body: { username: email } });
      for (let i = 0; i < 5; i++) {
        await s.req('POST', '/api/auth/reset-password', { body: { username: email, code: String(100000 + round * 10 + i), newPassword: 'Hacked!Pw123x' } });
      }
    }
    // 4周目: 正しいコードを手に入れても(=総当たりが当たったのと同じ)、もう通ってはいけない
    await sleep(61000);
    await s.req('POST', '/api/auth/forgot-password', { body: { username: email } });
    await sleep(300);
    const code = smtp.lastCode(email);
    const hit = await s.req('POST', '/api/auth/reset-password', { body: { username: email, code: code || '000000', newPassword: 'Hacked!Pw123x' } });
    assert.notStrictEqual(hit.status, 200, '15回外した後も再設定が通った(1日の上限が効いていない)');
    const login = await s.req('POST', '/api/auth/login', { body: { username: email, password: pw } });
    assert.strictEqual(login.status, 200, '元のパスワードが変わってしまった');
  } finally { await s.stop(); await smtp.close(); }
});

// ---------- メール不要の攻撃 ----------
test('攻撃: API・WebSocketの権限すり抜けと資源の食いつぶし', { timeout: 120000 }, async (t) => {
  const s = await startServer({ CLOUDINARY_CLOUD_NAME: 'a6rxinoz', CLOUDINARY_API_KEY: 'fake', CLOUDINARY_API_SECRET: 'fake', DEEPGRAM_API_KEY: 'fake-key-for-test' });
  try {
    const A = await s.user('Alice');
    const B = await s.user('Bob');
    const C = await s.user('Carol');
    const X = await s.user('Stranger');
    await s.befriend(A, B);
    await s.befriend(A, C);
    await s.befriend(B, C);

    await t.test('1通に2MBの付帯情報を詰めてDBとメモリを埋める', async () => {
      const g = await A.call('POST', '/api/groups/create', { name: 'solo', memberIds: [] });
      const gid = groupIdOf(g);
      assert.ok(gid, JSON.stringify(g));
      const big = { encrypted: 'A'.repeat(1500 * 1024), nonce: 'n'.repeat(32) };
      const r = await A.call('POST', `/api/groups/${gid}/messages/send`, { content: 'x', mediaType: 'image', mediaUrl: 'https://res.cloudinary.com/a6rxinoz/raw/upload/v1/x.bin', encryptedMetadata: big });
      assert.strictEqual(r.status, 400, 'グループ: 巨大な付帯情報が保存された');
      const r2 = await A.call('POST', '/api/messages/send', { recipientId: B.userId, content: 'x', mediaType: 'image', mediaUrl: 'https://res.cloudinary.com/a6rxinoz/raw/upload/v1/x.bin', encryptedMetadata: big });
      assert.strictEqual(r2.status, 400, 'DM: 巨大な付帯情報が保存された');
      const r3 = await A.call('POST', '/api/messages/send', { recipientId: B.userId, content: 'x', mediaType: 'image', mediaUrl: 'https://res.cloudinary.com/a6rxinoz/raw/upload/v1/x.bin', chunkCount: 1e9 });
      assert.strictEqual(r3.status, 400, 'chunkCount に何でも入る');
      // 普通の大きさは通る
      const ok = await A.call('POST', '/api/messages/send', { recipientId: B.userId, content: 'x', mediaType: 'image', mediaUrl: 'https://res.cloudinary.com/a6rxinoz/raw/upload/v1/x.bin', encryptedMetadata: { encrypted: 'A'.repeat(2000), nonce: 'n'.repeat(32) }, chunkCount: 3 });
      assert.strictEqual(ok.status, 200, '普通の画像が送れない: ' + JSON.stringify(ok));
    });

    await t.test('他人のCloudinaryの画像を混ぜて、開いた時刻を集める', async () => {
      const r = await A.call('POST', '/api/messages/send', { recipientId: B.userId, content: 'x', mediaType: 'image', mediaUrl: 'https://res.cloudinary.com/attacker-cloud/image/upload/track.png' });
      assert.strictEqual(r.status, 400, '他人のクラウドのURLが通った');
    });

    await t.test('相手の画像の publicId を自分のメッセージに書いて、相手の画像を消す', async () => {
      const pid = `brochat/dm/${[A.userId, B.userId].sort().join('_')}/victim_photo`;
      const v = await A.call('POST', '/api/messages/send', { recipientId: B.userId, content: 'x', mediaType: 'image', mediaUrl: 'https://res.cloudinary.com/a6rxinoz/raw/upload/v1/victim.bin', mediaPublicId: pid });
      assert.strictEqual(v.status, 200);
      const fake = await B.call('POST', '/api/messages/send', { recipientId: A.userId, content: 'x', mediaType: 'image', mediaUrl: 'https://res.cloudinary.com/a6rxinoz/raw/upload/v1/other.bin', mediaPublicId: pid });
      assert.strictEqual(fake.status, 200);
      const del = await B.call('POST', '/api/media/delete', { publicId: pid });
      assert.strictEqual(del.status, 403, '他人の画像の削除がCloudinaryまで通った: ' + JSON.stringify(del));
    });

    await t.test('偽の「Banしました」を相手のトーク一覧に出す', async () => {
      await C.call('POST', '/api/messages/send', { recipientId: B.userId, content: JSON.stringify({ __notice__: { kind: 'ban', name: 'Ring' } }) });
      const talks = await B.call('GET', '/api/messages/talks');
      const row = (talks.data || []).find(x => x.userId === C.userId);
      assert.ok(row, JSON.stringify(talks.data));
      assert.notStrictEqual(row.lastKind, 'ban', '普通のメッセージで偽のBan通知が出た');
    });

    await t.test('知らない人の公開鍵と端末一覧を覗く', async () => {
      const r = await X.call('GET', '/api/friends/publickey/' + A.userId);
      assert.notStrictEqual(r.status, 200, '無関係な人が公開鍵を取れた');
      const ok = await B.call('GET', '/api/friends/publickey/' + A.userId);
      assert.strictEqual(ok.status, 200, '友だちが公開鍵を取れない');
    });

    await t.test('友だちの使い捨て鍵(500個)を使い切る', async () => {
      await uploadKeys(B, 30);
      let got = 0;
      for (let i = 0; i < 25; i++) {
        const r = await A.call('GET', '/api/prekeys/bundle/' + B.userId);
        assert.strictEqual(r.status, 200);
        if (r.data.oneTimePrekey) got++;
      }
      assert.ok(got <= 10, `1人で使い捨て鍵を${got}個消費できた`);
      const left = await B.call('GET', '/api/prekeys/count');
      assert.ok(Number(left.data.count ?? left.data.cnt ?? left.data.remaining ?? 0) >= 20 || got <= 10);
    });

    await t.test('グループの鍵を自分の分だけで作り直して、他の全員を読めなくする', async () => {
      await uploadKeys(A); await uploadKeys(C);
      const g = await A.call('POST', '/api/groups/create', { name: 'trio', memberIds: [B.userId, C.userId] });
      const gid = groupIdOf(g);
      assert.ok(gid, JSON.stringify(g));
      const info = await B.call('GET', `/api/groups/${gid}/key-status`);
      const ver = (info.data && (info.data.keyVersion ?? info.data.currentVersion)) || 1;
      const r = await B.call('POST', `/api/groups/${gid}/rotate-key`, { expectedVersion: ver, encryptedKeysForMembers: [{ userId: B.userId, encryptedGroupKey: 'junk-only-for-me' }] });
      assert.strictEqual(r.status, 400, 'オーナーでもないのに自分の分だけで鍵を作り直せた: ' + JSON.stringify(r));
    });

    await t.test('出てもらえない発信で字幕(Deepgram課金)を起動する', async () => {
      const wa = await s.connect(A);
      const wb = await s.connect(B);
      const callId = 'c' + Date.now();
      wa.send({ type: 'call_offer', recipientId: B.userId, callId, sdp: 'v=0', isVideo: false });
      await waitFor(() => wb.msgs.some(m => m.type === 'call_offer'));
      wa.send({ type: 'call_assist_start', callId, language: 'ja', track: 'mic' });
      await waitFor(() => wa.msgs.some(m => m.type === 'call_assist_error'));
      const err = wa.msgs.find(m => m.type === 'call_assist_error');
      assert.ok(err && /通話中のみ/.test(err.error), '応答前に字幕セッションが始まった: ' + JSON.stringify(err));
      wa.close(); wb.close();
    });

    await t.test('発信→即切りを繰り返して、相手の端末を鳴らし続ける', async () => {
      const wa = await s.connect(A);
      const wc = await s.connect(C);
      const before = wc.msgs.filter(m => m.type === 'call_offer').length;
      for (let i = 0; i < 12; i++) {
        const callId = 'f' + Date.now() + '_' + i;
        wa.send({ type: 'call_offer', recipientId: C.userId, callId, sdp: 'v=0', isVideo: false });
        await sleep(40);
        wa.send({ type: 'call_end', recipientId: C.userId, callId });
        await sleep(40);
      }
      await sleep(500);
      const rang = wc.msgs.filter(m => m.type === 'call_offer').length - before;
      assert.ok(rang <= 6, `1分で${rang}回鳴らせた`);
      wa.close(); wc.close();
    });

    await t.test('友だちを解除された後も、相手のオンライン/オフラインを受け取る', async () => {
      const D = await s.user('Dave');
      const E = await s.user('Eve');
      await s.befriend(D, E);
      await D.call('POST', '/api/messages/send', { recipientId: E.userId, content: 'hi' });
      await E.call('POST', '/api/friends/remove', { userId: D.userId });
      const we = await s.connect(E);
      const wd = await s.connect(D);
      wd.send({ type: 'chat_open' });
      await sleep(800);
      const leak = we.msgs.some(m => m.type === 'presence_update' && m.userId === D.userId);
      assert.ok(!leak, '元友だちにオンラインが届いた');
      wd.close(); we.close();
    });

    await t.test('中継サーバー(TURN)の認証情報を取り放題', async () => {
      const F = await s.user('Frank');
      let last = 0;
      for (let i = 0; i < 62; i++) last = (await F.call('GET', '/api/ice')).status;
      assert.strictEqual(last, 429, 'TURNの認証情報を1時間に62回以上取れた');
    });
  } finally { await s.stop(); }
});
