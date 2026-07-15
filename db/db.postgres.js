// db.postgres.js
// -----------------------------------------------------------------------
// Railway (本番) 用 PostgreSQL 実装。
// routes/ 側は db.sqlite.js と全く同じ呼び方 (run/get/all で `?` プレースホルダ)
// を使えるように、内部で `?` を `$1,$2,...` に変換してから pg に渡している。
// -----------------------------------------------------------------------
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// `?` を `$1, $2, ...` に変換 (SQLite版と同じクエリ文字列を使い回すため)
function toPgQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function initDB() {
  const schemaPath = path.join(__dirname, 'schema.postgres.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  await pool.query(schema);

  // マイグレーション: 既存のusersテーブルにpublic_keyカラムがなければ追加
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS public_key TEXT');
  } catch (e) {
    console.log('[db] public_key migration skip:', e.message);
  }

  // マイグレーション: 既存のmessagesテーブルにencryptedカラムがなければ追加
  try {
    await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS encrypted BOOLEAN DEFAULT false');
  } catch (e) {
    console.log('[db] encrypted migration skip:', e.message);
  }

  console.log('[db] PostgreSQL に接続・スキーマ初期化しました ✅');
}

async function run(sql, params = []) {
  await pool.query(toPgQuery(sql), params);
}

async function get(sql, params = []) {
  const res = await pool.query(toPgQuery(sql), params);
  return res.rows[0] || null;
}

async function all(sql, params = []) {
  const res = await pool.query(toPgQuery(sql), params);
  return res.rows;
}

module.exports = { initDB, run, get, all };
