// utils/jwtSecret.js
// -----------------------------------------------------------------------
// JWT署名鍵の一元管理。
//
// 以前は各ルートファイルが個別に
//   const JWT_SECRET = process.env.JWT_SECRET || 'ring-dev-secret-CHANGE-IN-PRODUCTION'
// というフォールバック値を持っていた。この固定文字列は既にGitHub上の
// コミット履歴に残っており、Renderの環境変数JWT_SECRETが万一未設定/削除された場合、
// 誰でもこの文字列で有効なJWTを偽造してログインなしに任意ユーザーへなりすませる
// (認証システム全体が無力化される)重大なリスクだった。
//
// そのため本番運用(NODE_ENV=production、Renderは自動でこれを設定する)では
// JWT_SECRET環境変数が未設定の場合、起動時に例外を投げてプロセスを落とす。
// これによりデプロイ担当者が「秘密鍵を設定し忘れたまま公開してしまう」事故を
// 機械的に防ぐ。ローカル開発時(NODE_ENV未設定)のみ、開発用の固定値へ
// フォールバックしランダム値を使わない(再起動のたびに全セッションが
// 無効化されると開発体験が悪いため)。
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEV_FALLBACK_SECRET = 'ring-local-dev-only-secret-not-used-in-production';

function resolveJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 32) {
    return fromEnv;
  }
  if (IS_PRODUCTION) {
    throw new Error(
      '[FATAL] JWT_SECRET が環境変数に設定されていないか短すぎます(32文字以上必須)。' +
      'Renderのenvironmentタブで JWT_SECRET を強力なランダム値に設定してください。' +
      '安全のため起動を中止します。'
    );
  }
  console.warn('[jwtSecret] JWT_SECRET未設定のため開発用フォールバック値を使用します(本番では起動しません)');
  return DEV_FALLBACK_SECRET;
}

const JWT_SECRET = resolveJwtSecret();

module.exports = { JWT_SECRET };
