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
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 20,
  statement_timeout: 30000,
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

  // マイグレーション: 全端末サインアウト機能用のtoken_revoked_atカラム。
  // このタイムスタンプより前に発行された(iatが古い)JWTは、たとえ署名が正しくても
  // 無効として扱う。トークン漏洩が疑われた際に、パスワード変更を待たずして
  // 即座に既存の全セッションを失効させられるようにするための仕組み。
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_revoked_at TIMESTAMP');
  } catch (e) {
    console.log('[db] token_revoked_at migration skip:', e.message);
  }

  // マイグレーション: 既存のmessagesテーブルにencryptedカラムがなければ追加
  try {
    await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS encrypted BOOLEAN DEFAULT false');
  } catch (e) {
    console.log('[db] encrypted migration skip:', e.message);
  }

  // マイグレーション: 既存のmessagesテーブルにreplied_to_idカラムがなければ追加（リプライ機能）
  try {
    await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS replied_to_id TEXT REFERENCES messages(id)');
  } catch (e) {
    console.log('[db] replied_to_id migration skip:', e.message);
  }

  // マイグレーション: identity_keysにsigning_pubkey(Ed25519署名検証鍵)を追加。
  // これが無いとsigned_prekey_sigの検証が一切できず、X3DH鍵交換がMITM攻撃に
  // 対して無防備になる(なりすましのsigned prekeyを検知できない)。
  try {
    await pool.query('ALTER TABLE identity_keys ADD COLUMN IF NOT EXISTS signing_pubkey TEXT');
  } catch (e) {
    console.log('[db] signing_pubkey migration skip:', e.message);
  }

  // マイグレーション: push_subscriptionsテーブル（CREATE TABLE IF NOT EXISTSでschema.sqlから作成されるが念のため明示）
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT now()
      )
    `);
  } catch (e) {
    console.log('[db] push_subscriptions migration skip:', e.message);
  }

  // マイグレーション: Call Assist機能(通話メモ・要約)用テーブル。
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_notes (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        owner_id TEXT NOT NULL REFERENCES users(id),
        other_id TEXT REFERENCES users(id),
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now(),
        UNIQUE(call_id, owner_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_summaries (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        owner_id TEXT NOT NULL REFERENCES users(id),
        other_id TEXT REFERENCES users(id),
        summary TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT now(),
        UNIQUE(call_id, owner_id)
      )
    `);
  } catch (e) {
    console.log('[db] call_notes/call_summaries migration skip:', e.message);
  }

  // コミュニティ機能
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS communities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        icon_url TEXT,
        owner_id TEXT NOT NULL REFERENCES users(id),
        invite_code TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS community_members (
        community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT now(),
        PRIMARY KEY (community_id, user_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS community_channels (
        id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS community_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES community_channels(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id),
        content TEXT NOT NULL,
        media_url TEXT,
        media_type TEXT,
        created_at TIMESTAMP DEFAULT now(),
        edited_at TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);
  } catch (e) {
    console.log('[db] communities migration skip:', e.message);
  }

  // FCMトークン管理
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fcm_tokens (
        user_id TEXT NOT NULL REFERENCES users(id),
        token TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT now(),
        PRIMARY KEY (user_id, token)
      )
    `);
  } catch (e) {
    console.log('[db] fcm_tokens migration skip:', e.message);
  }

  console.log('[db] PostgreSQL に接続・スキーマ初期化しました');
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
