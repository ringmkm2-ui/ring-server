// utils/errorResponse.js
// -----------------------------------------------------------------------
// 想定外エラー(500)発生時、クライアントには詳細を返さず一般的なメッセージのみ
// 返すための共通ヘルパー。
//
// 以前は各ルートで `res.status(500).json({ error: e.message })` のように
// 例外オブジェクトのmessageをそのままクライアントへ返していた。
// スタックトレース(.stack)は元々送っていなかったが、e.messageにはDBドライバ
// (pg/sql.js)が生成するエラー文だったりコード内部の変数名・想定外の型など、
// 攻撃者にとってシステム内部構造の手がかりになりうる情報が混ざることがある。
// 詳細は必ずサーバーのログにだけ残し、クライアントへは一般的な文言のみ返す。
function sendServerError(res, err, context) {
  console.error(`[error]${context ? ' ' + context : ''}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'サーバーエラーが発生しました。しばらくしてから再度お試しください。' });
}

module.exports = { sendServerError };
