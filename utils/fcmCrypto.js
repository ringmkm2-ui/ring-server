// utils/fcmCrypto.js — FCM の data を端末ごとの鍵で暗号化する
//
// FCM(Firebase Cloud Messaging)は Google のサーバーを通る。これまでは data に送信者名・グループ名・
// 通知の文言・E2Eの暗号文などを平文で入れていたので、Google 側からは「誰から・どのグループに」が読めた。
// Signal と同じく、Google には「起こすための中身の無い箱」だけを渡し、中身は端末でしか開けないようにする。
//
// 仕組み:
//   - APK は FCM トークンを登録するときに、32バイトのランダム鍵(push_key)を作ってサーバーへ HTTPS で送る。
//     鍵は端末側では Android Keystore の鍵で包んで保存する(FcmPushKey.java)。
//   - サーバーは data 全体を JSON にして、その鍵で暗号化し、data は {v:'2', n:nonce, c:暗号文} だけにする。
//   - 鍵を送ってこない古い APK のトークンには、今まで通り平文で送る(互換のため。新しい APK を入れれば暗号化される)。
//
// 方式は AES-256-GCM にした(nacl.secretbox = XSalsa20-Poly1305 ではなく)。理由:
//   - Node の crypto と Android の javax.crypto の両方に最初から入っていて、追加のライブラリが要らない。
//     (APK には TweetNaclFast.java もあるが、AES-GCM なら Java 側の復号をパソコンの JVM の JUnit でそのまま試せる)
//   - 多くの端末で AES 命令がハードウェアで速く、着信の処理を遅らせない。
//   - nonce は毎回 12 バイトの乱数。1つの鍵で 2^32 回を大きく下回る通数しか送らないので、乱数 nonce で安全な範囲。
// AAD に固定の文字列を入れ、この鍵で作った別用途の暗号文を FCM の中身として受け入れないようにしている。
const crypto = require('crypto');

const VERSION = '2';
const AAD = Buffer.from('brochat-fcm-v2', 'utf8');
const NONCE_LEN = 12;
const TAG_LEN = 16;

// 端末から届いた鍵の形式を確かめる。標準 Base64 で、デコードするとちょうど 32 バイト。
// 全部 0 のような明らかに壊れた鍵も受け付けない(端末側の乱数が動いていない時の保険)。
function isValidPushKey(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) return false;
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) return false;
  if (raw.every(b => b === raw[0])) return false;
  return true;
}

// data(値は全部文字列)を暗号化して FCM に載せる形にする。nonce はテストで固定したい時だけ渡す
function sealData(data, keyB64, nonce) {
  if (!isValidPushKey(keyB64)) throw new Error('invalid push key');
  const key = Buffer.from(keyB64, 'base64');
  const n = nonce || crypto.randomBytes(NONCE_LEN);
  if (n.length !== NONCE_LEN) throw new Error('invalid nonce');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, n, { authTagLength: TAG_LEN });
  cipher.setAAD(AAD);
  const plain = Buffer.from(JSON.stringify(data), 'utf8');
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { v: VERSION, n: n.toString('base64'), c: ct.toString('base64') };
}

// テストと調査用。端末側(PushCrypto.java)と同じ手順で開く。改ざんされていれば例外
function openData(sealed, keyB64) {
  if (!sealed || sealed.v !== VERSION) throw new Error('unknown version');
  const key = Buffer.from(keyB64, 'base64');
  const n = Buffer.from(sealed.n, 'base64');
  const all = Buffer.from(sealed.c, 'base64');
  if (key.length !== 32 || n.length !== NONCE_LEN || all.length < TAG_LEN) throw new Error('bad input');
  const d = crypto.createDecipheriv('aes-256-gcm', key, n, { authTagLength: TAG_LEN });
  d.setAAD(AAD);
  d.setAuthTag(all.subarray(all.length - TAG_LEN));
  const plain = Buffer.concat([d.update(all.subarray(0, all.length - TAG_LEN)), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// FCM の data は合計 4KB まで。暗号化すると Base64 で約 4/3 倍になるので、平文のときは入っていた
// 長めの E2E 暗号文が入りきらないことがある。その時は大きい項目から順に落として入れ直す
// (平文に戻して送ることはしない。本文が出ないだけで、通知そのものは届く)。
const MAX_SEALED_BYTES = 3800; // 鍵名 v/n/c と FCM 側の余白を引いた目安
const DROP_ORDER = [['cipher', 'sender_pub'], ['sender_avatar', 'caller_avatar']];

function sealedSize(s) { return s.v.length + s.n.length + s.c.length + 3; }

function sealDataFitting(data, keyB64) {
  let d = { ...data };
  let s = sealData(d, keyB64);
  for (const keys of DROP_ORDER) {
    if (sealedSize(s) <= MAX_SEALED_BYTES) return s;
    let changed = false;
    for (const k of keys) if (d[k]) { d[k] = ''; changed = true; }
    if (changed) s = sealData(d, keyB64);
  }
  // それでも大きければ通知の文言を短くする(送信者名・種類・ID は残す)
  if (sealedSize(s) > MAX_SEALED_BYTES && typeof d.content === 'string' && d.content.length > 40) {
    d = { ...d, content: d.content.slice(0, 40) + '...' };
    s = sealData(d, keyB64);
  }
  return s;
}

module.exports = { VERSION, AAD, isValidPushKey, sealData, sealDataFitting, openData, MAX_SEALED_BYTES };
