// utils/rateLimits.js
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

// ログイン済みの操作は「人ごと」に数える。以前はIPごとだったので、学校や家の同じWi-Fiから
// 何十人も使うと、全員分がまとめて数えられてすぐ「多すぎます」になった。
// トークンが無い・正しくない時だけIPで数える(署名は確かめるので、偽のIDで回避はできない)
function userOrIpKey(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const { JWT_SECRET } = require('./jwtSecret');
      const p = jwt.verify(h.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
      if (p && p.userId) return 'u:' + p.userId;
    } catch (_) {}
  }
  return 'ip:' + req.ip;
}
const perUser = { keyGenerator: userOrIpKey, validate: { keyGeneratorIpFallback: false } };

// ログイン・Google認証・認証コード系: IP単位のブルートフォース/クレデンシャルスタッフィング対策。15分に30回まで。
// 特定アカウントへの総当たりは、アカウント単位のロック(連続8回失敗で15分)が別に止める。
// 10回だと、同じWi-Fi(学校・家族)から複数人がログインするだけで弾かれるため緩めた。
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // 同じWi-Fiから大勢がログインしても止まらない程度に。総当たりはアカウントごとのロックで防いでいる
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ログイン試行が多すぎます。しばらくしてから再度お試しください。' },
});

// 新規登録: スパムアカウント大量作成を抑制。1時間に5回まで。
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  // 教室など同じWi-Fiからみんなで登録できるように(以前は1時間に5人まで)
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登録試行が多すぎます。しばらくしてから再度お試しください。' },
});

// API全体: 1分120req（通常利用では引っかからない値、スクリプト連打防止）
const apiLimiter = rateLimit({
  ...perUser,
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。しばらくしてから再度お試しください。' },
  skip: (req) => req.path === '/health',
});

// メッセージ送信: DoS・スパム対策。1分に30件まで。
// 通常会話で1分に30件は十分すぎる余裕がある。
const messageSendLimiter = rateLimit({
  ...perUser,
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'メッセージ送信が多すぎます。しばらくしてからお試しください。' },
});

// メディア・ファイルアップロード: 重い処理のため厳しめ。1分に10件まで。
const mediaUploadLimiter = rateLimit({
  ...perUser,
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'アップロードが多すぎます。しばらくしてからお試しください。' },
});

// プリキー補充: X3DH鍵配布。1時間に20回まで（通常は補充頻度が低い）。
const prekeyLimiter = rateLimit({
  ...perUser,
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。' },
});

// 友達検索: 1分に20回まで（連打スクレイピング防止）。
const searchLimiter = rateLimit({
  ...perUser,
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '検索が多すぎます。しばらくしてからお試しください。' },
});

module.exports = {
  loginLimiter,
  registerLimiter,
  apiLimiter,
  messageSendLimiter,
  mediaUploadLimiter,
  prekeyLimiter,
  searchLimiter,
};
