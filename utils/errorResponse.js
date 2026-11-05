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
  // パスワード照合の待ち行列が満杯の時は、壊れたのではなく混んでいるだけ(utils/passwordHash.js)
  if (err && err.code === 'PASSWORD_BUSY') return sendBusy(res);
  console.error(`[error]${context ? ' ' + context : ''}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'サーバーエラーが発生しました。しばらくしてから再度お試しください。' });
}

function sendBusy(res) {
  if (res.headersSent) return;
  res.set('Retry-After', '5');
  res.status(503).json({ error: '混み合っています。少し待ってからもう一度お試しください' });
}

module.exports = { sendServerError, sendBusy };
