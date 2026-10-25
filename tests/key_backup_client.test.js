// public/js/keyBackup.js(ブラウザ用)の、登録直後の案内とログアウト時の鍵の扱いを確かめる。
// 本物の keyBackup.js / nacl を Node の vm で動かし、localStorage・fetch・最小限のDOMだけ差し替える。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { webcrypto } = require('crypto');

const JS = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const DAY = 24 * 3600 * 1000;
const PASS = 'correct-Horse-battery-7';

class El {
  constructor(tag, all) { this.tag = tag; this.style = {}; this.children = []; this.textContent = ''; this.value = ''; all.push(this); }
  appendChild(c) { this.children.push(c); return c; }
  set innerHTML(v) { this.html = String(v); this.textContent = String(v).replace(/<[^>]*>/g, ''); }
  get innerHTML() { return this.html || ''; }
  remove() {}
  focus() { this.focusCount = (this.focusCount || 0) + 1; }
}

function makeEnv({ withKeyFactory = true } = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  // 偽のサーバー(key-backup と公開鍵登録だけ)
  const server = { blob: null, strong: null, failPut: false, puts: 0 };
  const fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    let body = {};
    if (url.startsWith('/api/friends/key-backup')) {
      if (method === 'PUT') {
        server.puts++;
        if (server.failPut) return { json: async () => ({ ok: false, error: 'down' }) };
        const b = JSON.parse(opts.body);
        server.blob = b.blob;
        if (typeof b.strong === 'boolean') server.strong = b.strong;
        body = { ok: true };
      } else if (!server.blob) body = { exists: false };
      else body = url.includes('full=1') ? { exists: true, blob: server.blob, strong: !!server.strong } : { exists: true, strong: !!server.strong };
    } else body = { ok: true };
    return { json: async () => body };
  };

  const all = [];
  const document = {
    body: new El('body', all),
    createElement: (tag) => new El(tag, all),
  };
  const calls = { confirm: 0, confirmAnswer: true, keyFactory: 0, coarse: false };
  const ctx = {
    console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, Promise, JSON, Date, Math, Array, Object, Set, String, Number,
    crypto: webcrypto, localStorage, fetch, document, atob, btoa,
    confirm: () => { calls.confirm++; return calls.confirmAnswer; },
    // coarse=true はスマホ(指で操作する端末)。ダークモードの判定は常に false
    matchMedia: (q) => ({ matches: !!(calls.coarse && /pointer:\s*coarse/.test(q)) }),
  };
  ctx.window = ctx; ctx.self = ctx; ctx.location = { reload() {} };
  vm.createContext(ctx);
  vm.runInContext(JS('nacl.min.js'), ctx);
  vm.runInContext(JS('nacl-util.min.js'), ctx);
  const nacl = ctx.nacl;

  localStorage.setItem('ring_userId', 'u1');
  localStorage.setItem('ring_token', 'tok');

  const newPair = () => {
    const k = nacl.box.keyPair();
    return { publicKey: Array.from(k.publicKey), secretKey: Array.from(k.secretKey) };
  };
  const setPersonalKey = (kp) => {
    localStorage.setItem('e2e_keypair_u1', JSON.stringify(kp));
    localStorage.setItem('e2e_keyring_u1', JSON.stringify([kp]));
  };
  // 登録直後の getOrCreateMyKeyPair の代わり(鍵を作って保存する)
  if (withKeyFactory) {
    ctx.getOrCreateMyKeyPair = async () => { calls.keyFactory++; setPersonalKey(newPair()); };
  }
  vm.runInContext(JS('keyBackup.js'), ctx);
  return { ctx, store, localStorage, server, all, document, calls, newPair, setPersonalKey, kb: ctx.bcKeyBackup };
}

// モーダルが出るまで待ち、見出しを返す。dismiss なら「あとで」を押して閉じる
async function waitModal(env, dismiss) {
  for (let i = 0; i < 200; i++) {
    const later = env.all.find((e) => e.tag === 'button' && e.textContent === 'あとで');
    if (later) {
      const title = env.all.find((e) => e.tag === 'div' && /^(暗号鍵を設定しましょう|暗号鍵をバックアップ|暗号鍵を復元)$/.test(e.textContent));
      const t = title && title.textContent;
      if (dismiss) later.onclick();
      return t;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

// 全画面のセットアップ画面(ステップ式)を操作するための小道具
const latest = (env, id) => { const l = env.all.filter((e) => e.id === id); return l[l.length - 1] || null; };
async function waitId(env, id) {
  for (let i = 0; i < 400; i++) {
    // 古いステップの部品が残っていても、いま画面にあるのは「最後に作られたもの」
    if (latest(env, id)) return latest(env, id);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('not shown: ' + id);
}
const STRONG = 'Tq7-mWzK-92xB-vLpe';

// 預けたあとの「回復コード」の画面を通り抜けて、完了まで進める
async function passCodeStep(env) {
  await waitId(env, 'kbwCodeCheck');
  for (let i = 0; i < 400 && /作っています/.test(latest(env, 'kbwCode').textContent); i++) await new Promise((r) => setTimeout(r, 10));
  const code = latest(env, 'kbwCode').textContent;
  latest(env, 'kbwCodeCheck').onclick();
  latest(env, 'kbwCodeNext').onclick();
  return code;
}
// モーダルの部品(idが無いので、見た目で拾う)
const modalInputs = (env) => env.all.filter((e) => e.tag === 'input');
const modalBtn = (env, text) => { const l = env.all.filter((e) => e.tag === 'button' && e.textContent === text); return l[l.length - 1] || null; };

test('登録直後: 鍵ができるのを待って、全画面のセットアップを出し、「あとで」は1日あけて再案内する', async () => {
  const env = makeEnv();
  env.localStorage.setItem('bc_new_account', '1');
  assert.equal(env.localStorage.getItem('e2e_keypair_u1'), null); // 鍵はまだ無い
  const p = env.kb.init();
  await waitId(env, 'kbwContinue');
  assert.equal(latest(env, 'kbwTitle').textContent, '暗号鍵を設定しましょう');
  assert.equal(env.calls.keyFactory, 1, '鍵を作る処理を呼んだ');
  assert.ok(env.localStorage.getItem('e2e_keypair_u1'), '案内の時点で鍵がある');
  assert.equal(env.localStorage.getItem('bc_new_account'), '1', '画面が開いている間は印を残す(途中で閉じても、次に開いた時にまた出す)');
  latest(env, 'kbwSkip').onclick();
  await p;
  assert.equal(env.localStorage.getItem('bc_new_account'), null, '終えたら印を消す');
  const snooze = Number(env.localStorage.getItem('e2e_bk_snooze_u1'));
  assert.ok(Math.abs(snooze - (Date.now() + DAY)) < 60 * 1000, '再案内は約1日後');
  assert.equal(env.server.blob, null, 'あとでなら何も預けない');
});

test('セットアップ画面: 説明 → パスフレーズ → 控え → 完了まで進むと、鍵が預けられ端末が信頼済みになる', async () => {
  const env = makeEnv();
  env.localStorage.setItem('bc_new_account', '1');
  const p = env.kb.init();
  (await waitId(env, 'kbwContinue')).onclick();
  const p1 = await waitId(env, 'kbwPass1'); const p2 = await waitId(env, 'kbwPass2');
  p1.value = STRONG; p2.value = STRONG;
  latest(env, 'kbwNext').onclick();
  await waitId(env, 'kbwCheck');
  assert.equal(latest(env, 'kbwShown').textContent, STRONG, '決めたパスフレーズを見せて控えさせる');
  assert.equal(latest(env, 'kbwSave').disabled, true, '控えたと答えるまで預けられない');
  latest(env, 'kbwSave').onclick(); // 押しても何も起きない
  assert.equal(env.server.blob, null);
  latest(env, 'kbwCheck').onclick();
  assert.equal(latest(env, 'kbwSave').disabled, false);
  latest(env, 'kbwSave').onclick();
  const code = await passCodeStep(env);
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/, '回復コードが出る');
  (await waitId(env, 'kbwStart')).onclick();
  assert.equal(await p, undefined);
  assert.ok(env.server.blob, 'バックアップが預けられた');
  assert.equal(env.server.strong, true);
  assert.ok(env.localStorage.getItem('e2e_bk_key_u1'), 'この端末は信頼済みになる');
  assert.equal(env.localStorage.getItem('e2e_bk_snooze_u1'), null, '預けたので再案内の印は付かない');
  // 預けた中身が、この端末の鍵を全部含んでいる(=ログアウトで消しても戻せる)
  assert.ok(await env.kb._internal.backupCoversLocal());
});

test('セットアップ画面: 弱い/一致しないパスフレーズでは次へ進めない', async () => {
  const env = makeEnv();
  env.localStorage.setItem('bc_new_account', '1');
  const p = env.kb.init();
  (await waitId(env, 'kbwContinue')).onclick();
  let p1 = await waitId(env, 'kbwPass1'); let p2 = await waitId(env, 'kbwPass2');
  p1.value = 'password1234'; p2.value = 'password1234';
  latest(env, 'kbwNext').onclick();
  assert.match(latest(env, 'kbwMsg').textContent, /よく使われる言葉/);
  assert.equal(env.all.filter((e) => e.id === 'kbwCheck').length, 0, '3番目の画面には進まない');
  p1.value = STRONG; p2.value = STRONG + 'x';
  latest(env, 'kbwNext').onclick();
  assert.match(latest(env, 'kbwMsg').textContent, /一致しません/);
  assert.equal(env.all.filter((e) => e.id === 'kbwCheck').length, 0);
  latest(env, 'kbwSkip').onclick();
  await p;
});

async function toStep2(env) {
  env.localStorage.setItem('bc_new_account', '1');
  const p = env.kb.init();
  (await waitId(env, 'kbwContinue')).onclick();
  await waitId(env, 'kbwPass1');
  return { p }; // Promise をそのまま返すと、画面が閉じるまで待ってしまうので包む
}

test('セットアップ画面: スマホでは入力欄に自動で焦点を当てない(当てるとキーボードが出なくなる)', async () => {
  const env = makeEnv();
  env.calls.coarse = true;
  const { p } = await toStep2(env);
  await new Promise((r) => setTimeout(r, 500)); // 自動フォーカスがあるなら 320ms で走る
  assert.equal(latest(env, 'kbwPass1').focusCount || 0, 0);
  latest(env, 'kbwSkip').onclick();
  await p;
});

test('セットアップ画面: パソコンでは入力欄に自動で焦点を当てる', async () => {
  const env = makeEnv();
  const { p } = await toStep2(env);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(latest(env, 'kbwPass1').focusCount, 1);
  latest(env, 'kbwSkip').onclick();
  await p;
});

test('セットアップ画面: 目のボタンと「自動で作る」は、押しても入力欄から焦点を奪わない', async () => {
  const env = makeEnv();
  const { p } = await toStep2(env);
  for (const id of ['kbwEye', 'kbwGen']) {
    const b = latest(env, id);
    assert.equal(b.tabIndex, -1, id + ' はTabで焦点が当たらない');
    let prevented = false;
    b.onmousedown({ preventDefault() { prevented = true; } }); // 押した瞬間の既定動作(焦点移動)を止める
    assert.equal(prevented, true, id + ' の押下で焦点が移らない');
  }
  latest(env, 'kbwSkip').onclick();
  await p;
});

test('セットアップ画面: キーボードの「次へ」で2つ目の欄へ、「完了」で次の画面へ進む', async () => {
  const env = makeEnv();
  const { p } = await toStep2(env);
  const p1 = latest(env, 'kbwPass1'), p2 = latest(env, 'kbwPass2');
  p1.value = STRONG; p2.value = STRONG;
  let prevented = false;
  p1.onkeydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(p2.focusCount, 1, '2つ目の欄へ移る');
  p2.onkeydown({ key: 'Enter', preventDefault() {} });
  await waitId(env, 'kbwCheck'); // 次の画面(控えの確認)へ
  latest(env, 'kbwSkip').onclick();
  await p;
});

test('セットアップ画面: 預けるのに失敗したら画面に残って、エラーを出す(直ったら続けられる)', async () => {
  const env = makeEnv();
  env.localStorage.setItem('bc_new_account', '1');
  env.server.failPut = true;
  const p = env.kb.init();
  (await waitId(env, 'kbwContinue')).onclick();
  (await waitId(env, 'kbwPass1')).value = STRONG; (await waitId(env, 'kbwPass2')).value = STRONG;
  latest(env, 'kbwNext').onclick();
  (await waitId(env, 'kbwCheck')).onclick();
  latest(env, 'kbwSave').onclick();
  for (let i = 0; i < 400 && !/失敗/.test(latest(env, 'kbwMsg').textContent); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(latest(env, 'kbwMsg').textContent, /失敗しました/);
  assert.equal(env.all.filter((e) => e.id === 'kbwStart').length, 0, '完了にはならない');
  assert.equal(env.localStorage.getItem('e2e_bk_key_u1'), null, '信頼済みにもならない');
  env.server.failPut = false;
  latest(env, 'kbwSave').onclick();
  await passCodeStep(env);
  (await waitId(env, 'kbwStart')).onclick();
  await p;
  assert.ok(env.server.blob);
});

test('登録直後の印が無ければ、従来どおり汎用の案内(3日あける)', async () => {
  const env = makeEnv();
  env.setPersonalKey(env.newPair());
  const p = env.kb.init();
  const title = await waitModal(env, true);
  await p;
  assert.equal(title, '暗号鍵をバックアップ');
  const snooze = Number(env.localStorage.getItem('e2e_bk_snooze_u1'));
  assert.ok(Math.abs(snooze - (Date.now() + 3 * DAY)) < 60 * 1000);
});

test('登録直後でも、鍵が作れなかった時は案内を出さず、印を残して次回やり直す', async () => {
  const env = makeEnv({ withKeyFactory: false });
  env.localStorage.setItem('bc_new_account', '1');
  await env.kb.init();
  assert.equal(env.all.filter((e) => e.tag === 'button').length, 0, 'モーダルは出ない');
  assert.equal(env.localStorage.getItem('bc_new_account'), '1');
});

test('すでにバックアップがあるアカウントでは、登録直後の印は捨てる', async () => {
  const env = makeEnv();
  env.setPersonalKey(env.newPair());
  await env.kb._internal.upload(PASS, null, true);
  env.localStorage.setItem('bc_new_account', '1');
  await env.kb.init();
  assert.equal(env.localStorage.getItem('bc_new_account'), null);
});


// ---------- 回復コード(パスフレーズを忘れた時のもう1つの入口) ----------

// 預けてある状態を作り、回復コードまで用意する
async function backedUp(pass = PASS) {
  const env = makeEnv();
  env.setPersonalKey(env.newPair());
  env.localStorage.setItem('signal_identity_u1', JSON.stringify({ identity: { publicKey: 'IDPUB', privateKey: 'x' } }));
  env.localStorage.setItem('group_key_g1_v1', JSON.stringify(new Array(32).fill(7)));
  await env.kb._internal.upload(pass, null, true);
  const code = await env.kb._internal.makeRecoveryCode();
  return { env, code };
}
// 鍵を持たない別の端末(同じサーバーのバックアップを見る)
function otherDevice(from) {
  const env2 = makeEnv();
  env2.server.blob = from.server.blob;
  env2.server.strong = from.server.strong;
  return env2;
}

test('回復コード: 20文字で、区切りの有無や大小文字を問わない', async () => {
  const { env, code } = await backedUp();
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(env.kb._internal.normCode(code).length, 20);
  assert.equal(env.kb._internal.normCode(code.toLowerCase().replace(/-/g, ' ')), env.kb._internal.normCode(code));
});

test('回復コード: パスフレーズを知らなくても、別の端末で鍵を戻せる', async () => {
  const { env, code } = await backedUp();
  const want = env.localStorage.getItem('e2e_keypair_u1');
  const d2 = otherDevice(env);
  assert.equal(d2.localStorage.getItem('e2e_keypair_u1'), null);
  await d2.kb._internal.restore(code.toLowerCase(), true); // 小文字でも通る
  assert.equal(d2.localStorage.getItem('e2e_keypair_u1'), want, '個人鍵が戻る');
  assert.ok(d2.localStorage.getItem('signal_identity_u1'), 'グループの身元鍵も戻る');
  assert.ok(d2.localStorage.getItem('group_key_g1_v1'), 'グループ鍵も戻る');
  assert.equal(d2.localStorage.getItem('e2e_bk_key_u1'), null, 'パスフレーズは分からないので、まだ信頼済みにはしない');
});

test('回復コード: 違うコードでは戻せない', async () => {
  const { env } = await backedUp();
  const d2 = otherDevice(env);
  await assert.rejects(() => d2.kb._internal.restore('ABCDE-FGHJK-LMNPQ-RSTUV', true), (e) => e.code === 'WRONG');
  assert.equal(d2.localStorage.getItem('e2e_keypair_u1'), null);
});

test('回復コード: パスフレーズを変えても、前の回復コードはそのまま使える', async () => {
  const { env, code } = await backedUp();
  await env.kb._internal.upload('Zq4-nWvR-83mD-tLxe', null, true); // パスフレーズ変更
  const d2 = otherDevice(env);
  await d2.kb._internal.restore(code, true);
  assert.ok(d2.localStorage.getItem('e2e_keypair_u1'), '古いコードでも戻せる');
  // 新しいパスフレーズでも戻せる
  const d3 = otherDevice(env);
  await d3.kb._internal.restore('Zq4-nWvR-83mD-tLxe');
  assert.ok(d3.localStorage.getItem('e2e_keypair_u1'));
});

test('回復コード: 鍵が増えて自動で預け直されても、前の回復コードで全部戻せる', async () => {
  const { env, code } = await backedUp();
  env.localStorage.setItem('group_key_g2_v1', JSON.stringify(new Array(32).fill(9)));
  assert.equal(await env.kb.syncIfNeeded(), true);
  const d2 = otherDevice(env);
  await d2.kb._internal.restore(code, true);
  assert.ok(d2.localStorage.getItem('group_key_g2_v1'), 'あとから増えたグループ鍵も入っている');
});

test('回復コード: 作り直すと前のコードは使えなくなる(鍵とパスフレーズはそのまま)', async () => {
  const { env, code } = await backedUp();
  const code2 = await env.kb._internal.makeRecoveryCode();
  assert.notEqual(code, code2);
  const d2 = otherDevice(env);
  await assert.rejects(() => d2.kb._internal.restore(code, true), (e) => e.code === 'WRONG');
  await d2.kb._internal.restore(code2, true);
  assert.ok(d2.localStorage.getItem('e2e_keypair_u1'));
  const d3 = otherDevice(env);
  await d3.kb._internal.restore(PASS);
  assert.ok(d3.localStorage.getItem('e2e_keypair_u1'), 'パスフレーズも変わらない');
});

test('回復コード: 戻した端末が新しいパスフレーズで預け直しても、そのコードは使える', async () => {
  const { env, code } = await backedUp();
  const d2 = otherDevice(env);
  await d2.kb._internal.restore(code, true);
  await d2.kb._internal.upload('Mh6-pKwT-51cN-vBze', null, true);
  env.server.blob = d2.server.blob;
  const d3 = otherDevice(d2);
  await d3.kb._internal.restore(code, true);
  assert.ok(d3.localStorage.getItem('e2e_keypair_u1'), '同じコードで戻せる');
  const d4 = otherDevice(d2);
  await d4.kb._internal.restore('Mh6-pKwT-51cN-vBze');
  assert.ok(d4.localStorage.getItem('e2e_keypair_u1'), '新しいパスフレーズでも戻せる');
});

test('回復コードが無いバックアップに、コードで入ろうとしたら断る', async () => {
  const env = makeEnv();
  env.setPersonalKey(env.newPair());
  await env.kb._internal.upload(PASS, null, true); // コードは作らない
  const d2 = otherDevice(env);
  await assert.rejects(() => d2.kb._internal.restore('ABCDE-FGHJK-LMNPQ-RSTUV', true), (e) => e.code === 'NOCODE');
  assert.equal((await d2.kb.status()).code, false);
  assert.equal((await env.kb.status()).code, false);
  await env.kb._internal.makeRecoveryCode();
  assert.equal((await env.kb.status()).code, true);
});

test('古い形(bk1)で預けてあるバックアップも、そのまま復元できる', async () => {
  const env = makeEnv();
  env.setPersonalKey(env.newPair());
  await env.kb._internal.upload(PASS, null, true);
  // v1.28.283 までの形に作り直す: bk1.<公開鍵>.<salt>.<鍵一式をパスフレーズで暗号化>.<身元鍵>
  const nacl = env.ctx.nacl;
  const u = env.kb._internal.unpack(env.server.blob);
  const key = await env.kb._internal.deriveKey(PASS, u.salt);
  const kp = JSON.parse(env.localStorage.getItem('e2e_keypair_u1'));
  const payload = { keypair: kp, keyring: [kp], identity: null, groupKeys: {} };
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const boxed = nacl.secretbox(nacl.util.decodeUTF8(JSON.stringify(payload)), nonce, key);
  const full = new Uint8Array(nonce.length + boxed.length);
  full.set(nonce); full.set(boxed, nonce.length);
  env.server.blob = ['bk1', u.pub, nacl.util.encodeBase64(u.salt), nacl.util.encodeBase64(full), '-'].join('.');

  const d2 = otherDevice(env);
  await d2.kb._internal.restore(PASS);
  assert.equal(d2.localStorage.getItem('e2e_keypair_u1'), JSON.stringify(kp));
  // 古い形のままでも回復コードを作れて、そのコードで戻せる
  const code = await d2.kb._internal.makeRecoveryCode();
  const d3 = otherDevice(d2);
  await d3.kb._internal.restore(code, true);
  assert.ok(d3.localStorage.getItem('e2e_keypair_u1'));
});

test('設定の表示: 回復コードの有無が分かる / 作り直す画面はコードを出す', async () => {
  const { env } = await backedUp();
  const st = await env.kb.status();
  assert.deepEqual({ server: st.server, local: st.local, trusted: st.trusted, code: st.code }, { server: true, local: true, trusted: true, code: true });
  const p = env.kb.showRecoveryCode();
  const out = await waitId(env, 'kbCodeOut');
  for (let i = 0; i < 400 && /作っています/.test(latest(env, 'kbCodeOut').textContent); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(latest(env, 'kbCodeOut').textContent, /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  latest(env, 'kbCodeClose').onclick();
  assert.equal(await p, 'ok');
  const d2 = otherDevice(env);
  await d2.kb._internal.restore(latest(env, 'kbCodeOut').textContent, true);
  assert.ok(d2.localStorage.getItem('e2e_keypair_u1'), '画面に出たコードで実際に戻せる');
});

test('「必ず」は赤い太字で出す', async () => {
  const env = makeEnv();
  env.localStorage.setItem('bc_new_account', '1');
  const p = env.kb.init();
  (await waitId(env, 'kbwContinue')).onclick();
  (await waitId(env, 'kbwPass1')).value = STRONG; (await waitId(env, 'kbwPass2')).value = STRONG;
  latest(env, 'kbwNext').onclick();
  await waitId(env, 'kbwCheck');
  const warn = env.all.filter((e) => e.html && /必ず/.test(e.html));
  assert.ok(warn.length > 0, '控えを促す文に「必ず」がある');
  assert.match(warn[warn.length - 1].html, /<strong style="color:#ef4444;font-weight:800;white-space:nowrap">必ず<\/strong>/);
  latest(env, 'kbwSkip').onclick();
  await p;
});
