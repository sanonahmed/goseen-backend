// Incremental migrations — each entry is idempotent and runs on every deploy.
export const MIGRATIONS: string[] = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS e2ee_public_key TEXT`,
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS username VARCHAR(50) UNIQUE`,

  `CREATE TABLE IF NOT EXISTS call_logs (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_name     TEXT        NOT NULL UNIQUE,
    caller_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    call_type        VARCHAR(10) NOT NULL,
    status           VARCHAR(20) NOT NULL,
    duration_seconds INT,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at      TIMESTAMPTZ,
    ended_at         TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs (caller_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_call_logs_callee ON call_logs (callee_id, started_at DESC)`,
];

export const DROP_SCHEMA = `
DROP TABLE IF EXISTS connections        CASCADE;
DROP TABLE IF EXISTS notifications      CASCADE;
DROP TABLE IF EXISTS media_files        CASCADE;
DROP TABLE IF EXISTS message_reactions  CASCADE;
DROP TABLE IF EXISTS message_status     CASCADE;
DROP TABLE IF EXISTS messages           CASCADE;
DROP TABLE IF EXISTS chat_members       CASCADE;
DROP TABLE IF EXISTS chats              CASCADE;
DROP TABLE IF EXISTS users              CASCADE;
DROP FUNCTION IF EXISTS set_updated_at  CASCADE;
`;

// Auto-imported by run-migration.ts — compiles into dist so no file copying needed.
export const INITIAL_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email              VARCHAR(255) UNIQUE NOT NULL,
  username           VARCHAR(50)  UNIQUE,
  display_name       VARCHAR(100),
  avatar_url         TEXT,
  bio                TEXT,
  is_online          BOOLEAN      NOT NULL DEFAULT FALSE,
  last_seen          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  otp_code           VARCHAR(6),
  otp_expires_at     TIMESTAMPTZ,
  refresh_token_hash TEXT,
  fcm_token          TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chats (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type            VARCHAR(20) NOT NULL DEFAULT 'personal',
  name            VARCHAR(100),
  description     TEXT,
  avatar_url      TEXT,
  is_public       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  last_message_id UUID,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_members (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      UUID        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         VARCHAR(20) NOT NULL DEFAULT 'member',
  is_muted     BOOLEAN     NOT NULL DEFAULT FALSE,
  is_pinned    BOOLEAN     NOT NULL DEFAULT FALSE,
  unread_count INT         NOT NULL DEFAULT 0,
  last_read_at TIMESTAMPTZ,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id        UUID        NOT NULL REFERENCES chats(id)    ON DELETE CASCADE,
  sender_id      UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  reply_to_id    UUID        REFERENCES messages(id)          ON DELETE SET NULL,
  type           VARCHAR(20) NOT NULL DEFAULT 'text',
  text           TEXT,
  media_url      TEXT,
  media_file_id  UUID,
  voice_duration INT,
  is_edited      BOOLEAN     NOT NULL DEFAULT FALSE,
  is_deleted     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE chats ADD CONSTRAINT fk_last_message
    FOREIGN KEY (last_message_id) REFERENCES messages(id) ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS message_status (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  status     VARCHAR(20) NOT NULL DEFAULT 'delivered',
  seen_at    TIMESTAMPTZ,
  UNIQUE (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  emoji      VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS media_files (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id   UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          VARCHAR(20)  NOT NULL,
  original_name VARCHAR(255),
  mime_type     VARCHAR(100),
  size_bytes    BIGINT,
  r2_key        TEXT         NOT NULL,
  public_url    TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE messages ADD CONSTRAINT fk_media_file
    FOREIGN KEY (media_file_id) REFERENCES media_files(id) ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS notifications (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  type         VARCHAR(50) NOT NULL,
  title        TEXT,
  body         TEXT,
  data         JSONB,
  is_read      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connections (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (follower_id, following_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_id, created_at DESC) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_messages_sender    ON messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_user  ON chat_members (user_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_chat  ON chat_members (chat_id);
CREATE INDEX IF NOT EXISTS idx_msg_status_message ON message_status (message_id);
CREATE INDEX IF NOT EXISTS idx_msg_status_user    ON message_status (user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (recipient_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connections_follower  ON connections (follower_id);
CREATE INDEX IF NOT EXISTS idx_connections_following ON connections (following_id);
CREATE INDEX IF NOT EXISTS idx_chats_last_msg_at ON chats (last_message_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER users_updated_at    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER chats_updated_at    BEFORE UPDATE ON chats    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER messages_updated_at BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;
