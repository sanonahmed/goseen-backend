-- ═══════════════════════════════════════════════════════════════════════════
-- GoSeen — Initial Schema
-- Run once against a fresh PostgreSQL database
-- ═══════════════════════════════════════════════════════════════════════════

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email            VARCHAR(255) UNIQUE NOT NULL,
  username         VARCHAR(50)  UNIQUE,
  display_name     VARCHAR(100),
  avatar_url       TEXT,
  bio              TEXT,
  is_online        BOOLEAN      NOT NULL DEFAULT FALSE,
  last_seen        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- OTP auth
  otp_code         VARCHAR(6),
  otp_expires_at   TIMESTAMPTZ,
  -- JWT refresh
  refresh_token_hash TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Chats ──────────────────────────────────────────────────────────────────
-- type: personal | group | channel | bot
CREATE TABLE IF NOT EXISTS chats (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type             VARCHAR(20)  NOT NULL DEFAULT 'personal',
  name             VARCHAR(100),
  description      TEXT,
  avatar_url       TEXT,
  is_public        BOOLEAN      NOT NULL DEFAULT FALSE,
  created_by       UUID         REFERENCES users(id) ON DELETE SET NULL,
  last_message_id  UUID,        -- FK added after messages table
  last_message_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Chat Members ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_members (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      UUID        NOT NULL REFERENCES chats(id)  ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role         VARCHAR(20)  NOT NULL DEFAULT 'member',  -- owner | admin | member
  is_muted     BOOLEAN      NOT NULL DEFAULT FALSE,
  is_pinned    BOOLEAN      NOT NULL DEFAULT FALSE,
  unread_count INT          NOT NULL DEFAULT 0,
  last_read_at TIMESTAMPTZ,
  joined_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, user_id)
);

-- ─── Messages ───────────────────────────────────────────────────────────────
-- type: text | image | video | voice | file | sticker
CREATE TABLE IF NOT EXISTS messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id         UUID        NOT NULL REFERENCES chats(id)     ON DELETE CASCADE,
  sender_id       UUID        NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  reply_to_id     UUID        REFERENCES messages(id)           ON DELETE SET NULL,
  type            VARCHAR(20)  NOT NULL DEFAULT 'text',
  text            TEXT,
  media_url       TEXT,
  media_file_id   UUID,        -- FK to media_files added below
  voice_duration  INT,         -- seconds
  is_edited       BOOLEAN      NOT NULL DEFAULT FALSE,
  is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Back-fill FK on chats
ALTER TABLE chats
  ADD CONSTRAINT fk_last_message
  FOREIGN KEY (last_message_id)
  REFERENCES messages(id)
  ON DELETE SET NULL
  NOT VALID;   -- skip validation on existing rows (none yet)

-- ─── Message Status ─────────────────────────────────────────────────────────
-- Per-recipient delivery / seen receipt
CREATE TABLE IF NOT EXISTS message_status (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  status      VARCHAR(20)  NOT NULL DEFAULT 'delivered',  -- sent | delivered | seen
  seen_at     TIMESTAMPTZ,
  UNIQUE (message_id, user_id)
);

-- ─── Message Reactions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_reactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  emoji       VARCHAR(10)  NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id, emoji)
);

-- ─── Media Files (Cloudflare R2) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_files (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          VARCHAR(20)  NOT NULL,  -- avatar | image | video | voice | file
  original_name VARCHAR(255),
  mime_type     VARCHAR(100),
  size_bytes    BIGINT,
  r2_key        TEXT         NOT NULL,  -- Cloudflare R2 object key
  public_url    TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Back-fill FK on messages
ALTER TABLE messages
  ADD CONSTRAINT fk_media_file
  FOREIGN KEY (media_file_id)
  REFERENCES media_files(id)
  ON DELETE SET NULL
  NOT VALID;

-- ─── Notifications ──────────────────────────────────────────────────────────
-- type: new_message | mention | follow | like | comment
CREATE TABLE IF NOT EXISTS notifications (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id      UUID        REFERENCES users(id) ON DELETE SET NULL,
  type          VARCHAR(50)  NOT NULL,
  title         TEXT,
  body          TEXT,
  data          JSONB,
  is_read       BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Connections (Follow system) ────────────────────────────────────────────
-- status: pending | accepted | declined
CREATE TABLE IF NOT EXISTS connections (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (follower_id, following_id)
);

-- ─── Indexes ────────────────────────────────────────────────────────────────
-- Messages: primary access pattern is per-chat, ordered by time DESC
CREATE INDEX IF NOT EXISTS idx_messages_chat_time
  ON messages (chat_id, created_at DESC)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_messages_sender
  ON messages (sender_id);

-- Chat members: look up by user to get all their chats
CREATE INDEX IF NOT EXISTS idx_chat_members_user
  ON chat_members (user_id);

CREATE INDEX IF NOT EXISTS idx_chat_members_chat
  ON chat_members (chat_id);

-- Message status: mark/query seen receipts fast
CREATE INDEX IF NOT EXISTS idx_msg_status_message
  ON message_status (message_id);

CREATE INDEX IF NOT EXISTS idx_msg_status_user
  ON message_status (user_id);

-- Notifications: unread inbox query
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread
  ON notifications (recipient_id, is_read, created_at DESC);

-- Connections
CREATE INDEX IF NOT EXISTS idx_connections_follower
  ON connections (follower_id);

CREATE INDEX IF NOT EXISTS idx_connections_following
  ON connections (following_id);

-- Chats: last activity
CREATE INDEX IF NOT EXISTS idx_chats_last_message_at
  ON chats (last_message_at DESC);

-- ─── Auto-update updated_at ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER chats_updated_at
  BEFORE UPDATE ON chats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER messages_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
