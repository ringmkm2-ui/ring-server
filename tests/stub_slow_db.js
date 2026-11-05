// テスト用: ローカルのSQLiteは1回の問い合わせがほぼ瞬時で、同時に来たリクエストの間に割り込む隙が無い。
// PostgreSQL(本番)と同じように1回ごとに往復の時間を入れて、「読んでから書く」競合を手元で再現できるようにする。
// NODE_OPTIONS="--require tests/stub_slow_db.js" でサーバーより先に読み込ませる(テストの中だけ)。
const { isMainThread } = require('worker_threads');
if (isMainThread) {
  const path = require('path');
  const db = require(path.join(__dirname, '..', 'db', 'db.js'));
  const wait = () => new Promise(r => setTimeout(r, 6));
  for (const k of ['get', 'run', 'all']) {
    const orig = db[k];
    db[k] = async (...a) => { await wait(); const v = await orig.apply(db, a); await wait(); return v; };
  }
}
