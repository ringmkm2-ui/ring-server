// utils/asyncHandler.js
// -----------------------------------------------------------------------
// Express 4系は async (req, res) => {...} 形式のルートハンドラ内で
// 例外が投げられても(あるいはawaitしたPromiseがrejectされても)、
// 自動的には next(err) を呼ばない。つまりtry/catchを書き忘れた
// asyncルートで予期しないエラーが起きると、レスポンスが一切返らないまま
// リクエストがハングし、グローバルエラーハンドラにも到達しない。
// (Express 5では自動対応されるが、本プロジェクトはExpress 4系を使用)
//
// このラッパーで包むことで、async関数が投げた例外を確実にnext(err)へ
// 転送し、index.jsのグローバルエラーハンドラ(スタックトレースを
// クライアントに漏らさず、ログにだけ残して一般的なメッセージを返す)
// まで確実に届くようにする。
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
