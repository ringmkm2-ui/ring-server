// utils/rateLimits.js
// -----------------------------------------------------------------------
// エンドポイントの性質ごとに異なるレート制限を定義する。
//
// 以前はレート制限が一切無く、以下がいずれも無制限に実行できた:
//   - /api/auth/login への総当たり攻撃(パスワード推測)
//   - /api/auth/register の大量アカウント作成(スパム・DoS)
//   - /api/messages/send 等での大量送信によるサーバー・DB負荷
//   - API全体への高頻度リクエストによるサービス妨害
// -----------------------------------------------------------------------
const rateLimit = require('express-rate-limit');

// ログイン試行: 短時間の総当たりを防ぐため厳しめ。
// 15分に10回まで。正規ユーザーが打ち間違える分には十分な余裕がある回数。
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ログイン試行が多すぎます。しばらくしてから再度お試しください。' },
});

// 新規登録: スパムアカウント大量作成を抑制。1時間に5回まで。
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登録試行が多すぎます。しばらくしてから再度お試しください。' },
});

// API全体にかける緩めの制限。通常利用では絶対に引っかからない値にし、
// スクリプトによる連打・スクレイピングだけを防ぐ。1分に120リクエストまで。
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。しばらくしてから再度お試しください。' },
  // ヘルスチェックはインフラ監視・Renderの死活監視で高頻度に叩かれるため除外
  skip: (req) => req.path === '/health',
});

module.exports = { loginLimiter, registerLimiter, apiLimiter };
