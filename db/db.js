// db.js
// -----------------------------------------------------------------------
// DATABASE_URL 環境変数があれば PostgreSQL (Railway本番用) を使う。
// なければ sql.js (SQLiteファイル、ローカル開発用) を使う。
// どちらの場合も同じ非同期インターフェース (initDB, run, get, all) を
// 提供するので、routes/ 側のコードは一切変更不要。
// -----------------------------------------------------------------------
const USE_POSTGRES = !!process.env.DATABASE_URL;

const impl = USE_POSTGRES ? require('./db.postgres.js') : require('./db.sqlite.js');

if (USE_POSTGRES) {
  console.log('[db] DATABASE_URL 検出 → PostgreSQL モードで起動します');
} else {
  console.log('[db] DATABASE_URL 未設定 → SQLite (ローカル開発) モードで起動します');
}

module.exports = impl;
