// utils/moderation.js
// 禁止語(Fワード)を使ったら、そのアカウントを自動で3日間利用停止にする。
//
// 個人チャットとグループのメッセージはE2E暗号化されていてサーバーには中身が見えないので、
// 送る側の端末が送信前に調べ、引っかかったら送らずに /api/moderation/self-report で
// 自分の停止をサーバーに伝える(他人を停止させることはできない。自分のアカウントだけ)。
// 投稿・コメント・コミュニティ・名前など平文で届く物は、サーバーがここで直接調べる。
// 判定の中身は public/js/profanity.js と同じにしておくこと。
const db = require('../db/db');

const BAN_MS = 3 * 24 * 60 * 60 * 1000;

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '$': 's', '!': 'i', '|': 'i', '©': 'c', '(': 'c', '¢': 'c', '@': '*', '#': '*', '%': '*' };

function containsBannedWord(text) {
  if (typeof text !== 'string' || !text) return false;
  const base = text.normalize('NFKC').toLowerCase();
  // カタカナ・ひらがな
  // (「ファクト」「ファックス」は普通の言葉なので除く)
  if (/ファ[ー・\s]*ッ+[ー・\s]*ク(?!ス)|ふぁ[ー・\s]*っ+[ー・\s]*く(?!す)/.test(base)) return true;
  // 英字: 記号置き換え(f@ck, fu(k 等)を戻し、空白や記号の区切り(f u c k / f.u.c.k)を詰め、
  // 同じ文字の連続(fuuuuck)を1文字にしてから見る。* は伏せ字としてそのまま残す
  const latin = base
    .split('').map(c => LEET[c] || c).join('')
    .replace(/[^a-z*]/g, '')
    .replace(/(.)\1+/g, '$1');
  // fuck / fvck / fxck / f*ck / f*k / fck / phuck。
  // 「fuk」単体はローマ字(fukuoka・fuku 等)とぶつかるので含めない
  return /f[uvx*]ck|f\*k|fck|phuck|phuk/.test(latin);
}

async function banUser(userId, reason) {
  const until = Date.now() + BAN_MS;
  await db.run(
    'UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ? AND (banned_until IS NULL OR banned_until < ?)',
    [until, String(reason || 'profanity').slice(0, 100), userId, until]
  );
  // 繋がっているWebSocketにも知らせて切る(循環requireを避けるため遅延読み込み)
  try { require('../ws/wsServer').disconnectBanned(userId, until); } catch (e) {}
  console.log(`[moderation] user ${userId} banned until ${new Date(until).toISOString()} (${reason})`);
  return until;
}

// 平文の入力を調べ、禁止語があれば投稿者を停止して 403 を返す。返り値 true なら呼び出し側は処理を止める
async function rejectIfProfane(req, res, ...texts) {
  if (!texts.some(containsBannedWord)) return false;
  const until = await banUser(req.user.userId, 'profanity');
  res.status(403).json({ error: '禁止されている言葉を使ったため、3日間利用停止になりました', banned: true, bannedUntil: until });
  return true;
}

module.exports = { containsBannedWord, banUser, rejectIfProfane, BAN_MS };
