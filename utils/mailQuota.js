// utils/mailQuota.js
// メールを送ってよいかの判定。登録と再送は「他人のアドレスを入れるだけ」で相手にメールが届くので、
// 第三者へのメール爆撃と、送信枠(Resend)の使い切りの両方に使えた。
// 宛先ごとの上限と、サーバー全体の上限を置く。超えた時の扱いは呼び出し側で決める。
const { consume, refund, sha } = require('./attemptLimit');

const DAY_MS = 24 * 3600 * 1000;
const PER_ADDRESS = 5;
const globalMax = () => Number(process.env.MAIL_DAILY_MAX) || 300;
// 登録・再送は未登録のアドレスにも送れるので、ここで全体の枠を使い切らせない。
// 残りの2割はパスワード再設定とゲストの設定のために取っておく(こちらは登録済みの人にしか届かないか、ログインが要る)
const SIGNUP_SHARE = 0.8;

// kind: 'signup'(登録・認証コードの再送) / 'account'(再設定など)。送ってよければ true
async function takeMailQuota(to, kind = 'account') {
  const max = globalMax();
  const limit = kind === 'signup' ? Math.max(1, Math.floor(max * SIGNUP_SHARE)) : max;
  if (!(await consume('mailall', limit, DAY_MS))) return false;
  if (await consume('mailto:' + sha(String(to).toLowerCase()), PER_ADDRESS, DAY_MS)) return true;
  // 宛先の上限で送らなかった分は、全体の枠に戻す
  await refund('mailall');
  return false;
}

module.exports = { takeMailQuota };
