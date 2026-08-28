// utils/authMiddleware.js
// -----------------------------------------------------------------------
// JWT認証ロジックの単一の実装。
//
// 以前は auth.js / friends.js / messages.js / push.js がそれぞれ個別に
// ほぼ同じ内容の認証ミドルウェア(またはverifyToken関数)を持っていた
// (JWT_SECRETのハードコード値が4箇所に重複していたのと同じ構造の問題)。
// この重複は、後からセキュリティ強化(今回のトークン失効チェック等)を
// 加える際に一部のファイルだけ直し忘れる事故につながるため、
// 1箇所にまとめてrequireし合う形に統一する。
//
// トークン失効の仕組み:
// JWTはステートレスな性質上、発行後は署名が正しい限りサーバー側で
// 個別に無効化できない。これは「端末を盗まれた」「XSS等でトークンが
// 漏洩した疑いがある」といった場合に、パスワード変更を待たずして
// 即座に既存の全セッションを失効させる手段が無いことを意味する。
// そこで users.token_revoked_at に「このタイムスタンプより前に発行された
// トークンは無効」という基準時刻を持たせ、検証のたびにJWTのiat(発行時刻)と
// 比較する。これにより「全端末からサインアウト」が実現できる。
const jwt = require('jsonwebtoken');
const db = require('../db/db');
const { JWT_SECRET } = require('./jwtSecret');

// トークン失効チェック込みの検証。有効なら { userId, username, ... } を返し、
// 無効(署名不正・期限切れ・失効済み)なら null を返す。
async function verifyTokenWithRevocation(token) {
  let payload;
  try {
    // algorithms を明示的に HS256 のみに限定する。
    // 指定しない場合ライブラリのデフォルト挙動に依存することになり、
    // "alg":"none" を許容する設定や実装の取り違えを機械的に防げなくなるため、
    // 攻撃者がヘッダーを書き換えて署名検証をバイパスする"alg:none"攻撃への
    // 防御として明示指定しておく。
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (e) {
    return null;
  }

  if (!payload || !payload.userId) return null;

  const user = await db.get('SELECT token_revoked_at FROM users WHERE id = ?', [payload.userId]);
  if (!user) return null; // ユーザーが削除されている等

  if (user.token_revoked_at) {
    const revokedAtMs = new Date(user.token_revoked_at).getTime();
    const issuedAtMs = (payload.iat || 0) * 1000;
    // JWTのiatとDBのタイムスタンプはどちらも秒単位の精度しかないため、
    // 「同じ秒内に発行と失効が起きた」場合、厳密な未満(<)判定だと
    // 失効漏れが起きうる(実際に発生を確認したレースコンディション)。
    // セキュリティ機能としては「疑わしきは失効させる」方が安全なため、
    // 以下(<=)判定にして同一秒のトークンも失効対象に含める。
    if (issuedAtMs <= revokedAtMs) {
      return null; // 失効時刻以前に発行されたトークンは無効
    }
  }

  return payload;
}

// Express用ミドルウェア。req.user (payload全体) と req.userId (互換性のため)
// の両方を設定する。既存コードには req.user.userId を使う箇所と
// req.userId を直接使う箇所が混在しているため、両方満たしておく。
function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '認証トークンがありません' });
  }
  const token = header.slice(7);

  verifyTokenWithRevocation(token).then(payload => {
    if (!payload) {
      return res.status(401).json({ error: 'トークンが無効です' });
    }
    req.user = payload;
    req.userId = payload.userId;
    next();
  }).catch(err => {
    console.error('[auth] verifyToken error:', err.message);
    res.status(401).json({ error: 'トークンが無効です' });
  });
}

module.exports = { verifyToken, verifyTokenWithRevocation };
