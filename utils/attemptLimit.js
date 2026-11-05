// utils/attemptLimit.js
// 「この時間内に何回まで」をDBで数える共通処理。メモリだとRenderの再起動で消え、上限が効かなくなる。
// 行は auth_misses (key, n, since_ms) を使い回す。
//
// 1文のUPSERTで「上限の手前なら1つ増やす」まで済ませる。読んでから足すと、同時に何本も来た時に
// 全部が上限の手前で通ってしまう。試す前に1回分を確保し、失敗でなかった時に返す使い方をする。
const crypto = require('crypto');
const db = require('../db/db');

const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const KEEP_MS = 3 * 24 * 3600 * 1000; // いちばん長い窓(24時間)より十分長く
let lastCleanup = 0;

const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');

// 未登録のアドレスでも行が増えるので、放っておくと表が太り続ける。ここで数えるついでに古い行を消す。
// タイマーにしないのは、誰も使っていない間にNeonのDBを起こさないため(utils/activity.js と同じ考え方)
function cleanupSoon(now) {
  if (now - lastCleanup < CLEANUP_EVERY_MS) return;
  lastCleanup = now;
  db.run('DELETE FROM auth_misses WHERE since_ms < ?', [now - KEEP_MS]).catch(e => console.warn('[attemptLimit] cleanup failed:', e.message));
}

// 上限の手前なら1回分を確保して true。窓が過ぎていれば数え直す
async function consume(key, max, windowMs, now = Date.now()) {
  cleanupSoon(now);
  const cutoff = now - windowMs;
  const r = await db.run(
    `INSERT INTO auth_misses (key, n, since_ms) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       n = CASE WHEN auth_misses.since_ms <= ? THEN 1 ELSE auth_misses.n + 1 END,
       since_ms = CASE WHEN auth_misses.since_ms <= ? THEN excluded.since_ms ELSE auth_misses.since_ms END
     WHERE auth_misses.since_ms <= ? OR auth_misses.n < ?`,
    [key, now, cutoff, cutoff, cutoff, max]
  );
  return !!(r && r.changes);
}

// 上限なしで1つ足す(数えるだけ。判定は別の場所で行う所向け)
async function bump(key, windowMs, now = Date.now()) {
  cleanupSoon(now);
  const cutoff = now - windowMs;
  await db.run(
    `INSERT INTO auth_misses (key, n, since_ms) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       n = CASE WHEN auth_misses.since_ms <= ? THEN 1 ELSE auth_misses.n + 1 END,
       since_ms = CASE WHEN auth_misses.since_ms <= ? THEN excluded.since_ms ELSE auth_misses.since_ms END`,
    [key, now, cutoff, cutoff]
  );
}

async function refund(key) {
  await db.run('UPDATE auth_misses SET n = n - 1 WHERE key = ? AND n > 0', [key]);
}

async function clear(key) {
  await db.run('DELETE FROM auth_misses WHERE key = ?', [key]);
}

async function count(key, windowMs, now = Date.now()) {
  const r = await db.get('SELECT n, since_ms FROM auth_misses WHERE key = ?', [key]);
  if (!r || now - Number(r.since_ms) >= windowMs) return 0;
  return Number(r.n);
}

// --- ログイン・再設定コードの試行(第三者に本人を締め出させない数え方) ---
// アカウント全体だけで数えると、誰でも間違ったパスワードを8回送るだけで本人を15分締め出せた。
// 「アカウント+IP」を低い上限、「アカウント全体」を高い上限にして、他のIPにいる本人は普通に入れるようにする。
// 登録の有無に関係なくアドレスで数えるので、ロックされるかどうかでアカウントの有無を探ることもできない。
// アドレス(未登録のものも含む)をそのまま表に残さないよう、ハッシュにして使う。
const LOGIN_POLICY = { prefix: 'lk', perIp: 8, perAccount: 50, windowMs: 15 * 60 * 1000 };
const RESET_POLICY = { prefix: 'rk', perIp: 15, perAccount: 60, windowMs: 24 * 3600 * 1000 };

const accountHash = name => sha(String(name).toLowerCase());
const accountKey = (policy, name) => `${policy.prefix}:${accountHash(name)}`;
const accountIpKey = (policy, name, ip) => `${policy.prefix}ip:${accountHash(name)}:${sha(ip || '')}`;

function accountGuard(policy, name, ip) {
  const perIpKey = accountIpKey(policy, name, ip);
  const perAccountKey = accountKey(policy, name);
  return {
    // 試す前に1回分を確保する。false ならロック中
    async take() {
      if (!(await consume(perIpKey, policy.perIp, policy.windowMs))) return false;
      if (await consume(perAccountKey, policy.perAccount, policy.windowMs)) return true;
      await refund(perIpKey);
      return false;
    },
    // 判定できなかった(混雑など)、または失敗ではなかった時に、確保した1回分を返す
    async giveBack() {
      await refund(perIpKey);
      await refund(perAccountKey);
    },
    // 正解した。同じ場所からの失敗は忘れるが、アカウント全体の分は今回の1回を返すだけにする
    // (本人がログインするたびに全体の数が0に戻ると、散らしたIPからの総当たりを止められない)
    async succeed() {
      await clear(perIpKey);
      await refund(perAccountKey);
    },
    async accountFull() {
      return (await count(perAccountKey, policy.windowMs)) >= policy.perAccount;
    },
  };
}

// そのアカウントのロックを全部外す(管理者の解除、メールで本人確認が取れた時)
async function clearAccount(policy, name) {
  const h = accountHash(name); // 16進の文字だけなのでLIKEのエスケープは要らない
  await db.run('DELETE FROM auth_misses WHERE key = ? OR key LIKE ?', [`${policy.prefix}:${h}`, `${policy.prefix}ip:${h}:%`]);
}

// 管理画面に出すための、アカウント全体の失敗回数(username -> n)。users.locked_until はもう使っていない
async function accountFailCount(policy, names) {
  const now = Date.now();
  const out = new Map();
  if (!names.length) return out;
  const byKey = new Map(names.map(n => [accountKey(policy, n), n]));
  const rows = await db.all(`SELECT key, n, since_ms FROM auth_misses WHERE key IN (${[...byKey.keys()].map(() => '?').join(',')})`, [...byKey.keys()]);
  for (const r of rows) {
    if (now - Number(r.since_ms) < policy.windowMs) out.set(byKey.get(r.key), Number(r.n));
  }
  return out;
}

module.exports = {
  consume, bump, refund, clear, count, sha,
  LOGIN_POLICY, RESET_POLICY, accountGuard, clearAccount, accountFailCount,
};
