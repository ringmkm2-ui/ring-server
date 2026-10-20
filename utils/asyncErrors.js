// utils/asyncErrors.js
// Express 4 は、async のルート内で例外が出ても(try/catchを書き忘れていると)何も返さず、
// しかも未処理のPromise rejectionになる。Node 15以降はこれでサーバーのプロセスごと落ちる。
// DBが一時的に詰まった時にログインや登録の1件の失敗でサーバー全体が再起動していた。
// ルートが返したPromiseの失敗を next(err) に回し、index.js のエラーハンドラ(500を返す)に届ける。
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__asyncPatched) {
  Layer.prototype.__asyncPatched = true;
  Layer.prototype.handle_request = function handle_request(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // エラーハンドラはここでは動かさない
    try {
      const ret = fn(req, res, next);
      if (ret && typeof ret.catch === 'function') ret.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

// 最後の砦: どこかで拾い損ねた失敗でプロセスが落ちないよう、ログだけ残して動き続ける
let installed = false;
function installProcessGuards() {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  });
}

module.exports = { installProcessGuards };
