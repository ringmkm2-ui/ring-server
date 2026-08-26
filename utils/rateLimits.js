// utils/rateLimits.js
const rateLimit = require('express-rate-limit');

// ログイン・Google認証: ブルートフォース対策。15分に10回まで。
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

// API全体: 1分120req（通常利用では引っかからない値、スクリプト連打防止）
const apiLimiter = rateLimit({
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
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'メッセージ送信が多すぎます。しばらくしてからお試しください。' },
});

// メディア・ファイルアップロード: 重い処理のため厳しめ。1分に10件まで。
const mediaUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'アップロードが多すぎます。しばらくしてからお試しください。' },
});

// プリキー補充: X3DH鍵配布。1時間に20回まで（通常は補充頻度が低い）。
const prekeyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。' },
});

// 友達検索: 1分に20回まで（連打スクレイピング防止）。
const searchLimiter = rateLimit({
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
