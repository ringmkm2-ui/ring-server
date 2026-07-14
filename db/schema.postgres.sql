-- =========================================================
-- 本番用 PostgreSQL スキーマ (Railway Postgres 想定)
-- ID は全てアプリ側 (uuidv4) で生成した TEXT を使う設計にして、
-- SQLite版 (db.sqlite.js) と全く同じ SQL 文がそのまま動くようにしてある。
-- pgcrypto 等の拡張は不要。
-- =========================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  profile_pic TEXT,
  bio TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY,
  user_a_id TEXT NOT NULL REFERENCES users(id),
  user_b_id TEXT NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMP DEFAULT now(),
  accepted_at TIMESTAMP,
  UNIQUE(user_a_id, user_b_id),
  CHECK (user_a_id < user_b_id)
);

CREATE TABLE IF NOT EXISTS identity_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  identity_pubkey TEXT NOT NULL,
  signed_prekey_pub TEXT NOT NULL,
  signed_prekey_sig TEXT NOT NULL,
  registration_id INTEGER,
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS one_time_prekeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_id INTEGER NOT NULL,
  pubkey TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  key_version INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMP DEFAULT now(),
  left_at TIMESTAMP,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_key_distributions (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  encrypted_group_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  msg_type TEXT DEFAULT 'text',
  created_at TIMESTAMP DEFAULT now(),
  read_at TIMESTAMP,
  edited_at TIMESTAMP,
  deleted_at TIMESTAMP,
  pinned_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS offline_queue (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  msg_uuid TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  chunk_total INTEGER,
  chunk_received INTEGER DEFAULT 0,
  status TEXT DEFAULT 'uploading',
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offline_queue_recipient ON offline_queue(recipient_id);
CREATE INDEX IF NOT EXISTS idx_media_expires ON media_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
