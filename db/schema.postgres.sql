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
  public_key TEXT,
  token_revoked_at TIMESTAMP,
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

-- グループメッセージ本体。個人チャットのmessagesと違い、既読は
-- 複数メンバー分あるためread_atのような単一カラムでは表現できず、
-- 既読は別途group_message_readsで管理する。
CREATE TABLE IF NOT EXISTS group_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  msg_type TEXT DEFAULT 'text',
  encrypted BOOLEAN DEFAULT false,
  key_version INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT now(),
  edited_at TIMESTAMP,
  deleted_at TIMESTAMP,
  pinned_at TIMESTAMP
);

-- グループメッセージの既読状況(メンバーごとに1行)
CREATE TABLE IF NOT EXISTS group_message_reads (
  message_id TEXT NOT NULL REFERENCES group_messages(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  read_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  msg_type TEXT DEFAULT 'text',
  encrypted BOOLEAN DEFAULT false,
  replied_to_id TEXT REFERENCES messages(id),
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

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

-- 投稿(タイムライン)機能。友達関係を問わず、アプリ内の全ユーザーに公開される。
-- メディア(画像/動画)はメッセージと同じくBase64のままcontentに含めず、
-- media_url に直接データURIまたは保存先を持たせるシンプルな設計にする
-- (投稿は全員に見える前提なのでE2E暗号化は行わない)。
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  text TEXT,
  media_url TEXT,
  media_type TEXT,
  created_at TIMESTAMP DEFAULT now(),
  edited_at TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id TEXT NOT NULL REFERENCES posts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  deleted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_offline_queue_recipient ON offline_queue(recipient_id);
CREATE INDEX IF NOT EXISTS idx_media_expires ON media_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id);
CREATE INDEX IF NOT EXISTS idx_group_messages_pinned ON group_messages(pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_group_message_reads_message ON group_message_reads(message_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id);
CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id) WHERE deleted_at IS NULL;
