// Incremental migrations — each entry is idempotent and runs on every deploy.
export const MIGRATIONS: string[] = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT`,
  // Create posts table (no-op if already exists from Firebase import)
  `CREATE TABLE IF NOT EXISTS posts (
    id         TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::text,
    created_at BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
    payload    JSONB   NOT NULL DEFAULT '{}',
    is_hidden  BOOLEAN NOT NULL DEFAULT false
  )`,
  // App-level likes — post_id is TEXT to match posts.id
  `CREATE TABLE IF NOT EXISTS post_likes (
    post_id    TEXT        NOT NULL,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (post_id, user_id)
  )`,
  // App-level comments
  `CREATE TABLE IF NOT EXISTS post_comments (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    TEXT        NOT NULL,
    author_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_likes_post    ON post_likes    (post_id)`,
  `CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments (post_id, created_at DESC)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS e2ee_public_key TEXT`,
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS username VARCHAR(50) UNIQUE`,
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS invite_token VARCHAR(32) UNIQUE`,
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS pinned_message_id UUID REFERENCES messages(id) ON DELETE SET NULL`,

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

  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin    BOOLEAN NOT NULL DEFAULT FALSE`,

  // ── Mini App Platform ──────────────────────────────────────────────────────

  `CREATE TABLE IF NOT EXISTS developer_accounts (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name      VARCHAR(100) NOT NULL,
    website_url       VARCHAR(500),
    description       TEXT,
    avatar_url        TEXT,
    is_verified       BOOLEAN     NOT NULL DEFAULT FALSE,
    is_suspended      BOOLEAN     NOT NULL DEFAULT FALSE,
    suspension_reason TEXT,
    total_installs    BIGINT      NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS mini_apps (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id        UUID         NOT NULL REFERENCES developer_accounts(id) ON DELETE CASCADE,
    name                VARCHAR(100) NOT NULL,
    slug                VARCHAR(100) NOT NULL,
    short_description   VARCHAR(200) NOT NULL DEFAULT '',
    description         TEXT         NOT NULL DEFAULT '',
    icon_url            TEXT,
    banner_url          TEXT,
    category            VARCHAR(50)  NOT NULL DEFAULT 'utilities',
    tags                TEXT[]       NOT NULL DEFAULT '{}',
    status              VARCHAR(20)  NOT NULL DEFAULT 'draft',
    is_featured         BOOLEAN      NOT NULL DEFAULT FALSE,
    featured_order      SMALLINT,
    current_version_id  UUID,
    privacy_policy_url  TEXT,
    terms_url           TEXT,
    support_url         TEXT,
    contact_email       VARCHAR(200),
    allowed_domains     TEXT[]       NOT NULL DEFAULT '{}',
    total_installs      BIGINT       NOT NULL DEFAULT 0,
    active_installs     BIGINT       NOT NULL DEFAULT 0,
    rating_average      NUMERIC(3,2) NOT NULL DEFAULT 0,
    rating_count        INTEGER      NOT NULL DEFAULT 0,
    trending_score      NUMERIC(10,4) NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(slug)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_mini_apps_status    ON mini_apps(status)`,
  `CREATE INDEX IF NOT EXISTS idx_mini_apps_category  ON mini_apps(category) WHERE status = 'published'`,
  `CREATE INDEX IF NOT EXISTS idx_mini_apps_trending  ON mini_apps(trending_score DESC) WHERE status = 'published'`,
  `CREATE INDEX IF NOT EXISTS idx_mini_apps_installs  ON mini_apps(total_installs DESC) WHERE status = 'published'`,
  `CREATE INDEX IF NOT EXISTS idx_mini_apps_featured  ON mini_apps(featured_order ASC) WHERE is_featured = TRUE`,

  `CREATE TABLE IF NOT EXISTS mini_app_versions (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    mini_app_id          UUID        NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
    version              VARCHAR(20) NOT NULL,
    changelog            TEXT,
    app_url              TEXT        NOT NULL,
    bundle_hash          CHAR(64),
    min_goseen_version   VARCHAR(20),
    screenshots          JSONB       NOT NULL DEFAULT '[]',
    status               VARCHAR(20) NOT NULL DEFAULT 'draft',
    rejection_reason     TEXT,
    security_scan_result JSONB,
    submitted_at         TIMESTAMPTZ,
    reviewed_at          TIMESTAMPTZ,
    published_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(mini_app_id, version)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_versions_mini_app ON mini_app_versions(mini_app_id)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_status   ON mini_app_versions(status)`,

  `CREATE TABLE IF NOT EXISTS mini_app_permissions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    mini_app_id  UUID        NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
    scope        VARCHAR(50) NOT NULL,
    reason       TEXT        NOT NULL DEFAULT '',
    is_required  BOOLEAN     NOT NULL DEFAULT FALSE,
    UNIQUE(mini_app_id, scope)
  )`,

  `CREATE TABLE IF NOT EXISTS mini_app_installs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mini_app_id         UUID        NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
    version_id          UUID        REFERENCES mini_app_versions(id) ON DELETE SET NULL,
    granted_permissions TEXT[]      NOT NULL DEFAULT '{}',
    denied_permissions  TEXT[]      NOT NULL DEFAULT '{}',
    is_pinned           BOOLEAN     NOT NULL DEFAULT FALSE,
    open_count          INTEGER     NOT NULL DEFAULT 0,
    last_opened_at      TIMESTAMPTZ,
    installed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, mini_app_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_installs_user       ON mini_app_installs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_installs_mini_app   ON mini_app_installs(mini_app_id)`,
  `CREATE INDEX IF NOT EXISTS idx_installs_last_open  ON mini_app_installs(last_opened_at DESC)`,

  `CREATE TABLE IF NOT EXISTS mini_app_reviews (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mini_app_id          UUID        NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
    version_reviewed     VARCHAR(20),
    rating               SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review_text          TEXT,
    is_hidden            BOOLEAN     NOT NULL DEFAULT FALSE,
    developer_reply      TEXT,
    developer_replied_at TIMESTAMPTZ,
    helpful_count        INTEGER     NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, mini_app_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_reviews_mini_app ON mini_app_reviews(mini_app_id, rating DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_recent   ON mini_app_reviews(mini_app_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS developer_api_keys (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id UUID        NOT NULL REFERENCES developer_accounts(id) ON DELETE CASCADE,
    name         VARCHAR(100) NOT NULL,
    key_prefix   VARCHAR(16)  NOT NULL,
    key_hash     VARCHAR(64)  NOT NULL,
    last_four    CHAR(4)      NOT NULL,
    scopes       TEXT[]       NOT NULL DEFAULT '{}',
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_dev_api_keys_hash      ON developer_api_keys(key_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_dev_api_keys_developer ON developer_api_keys(developer_id)`,

  `CREATE TABLE IF NOT EXISTS mini_app_storage (
    mini_app_id UUID        NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key         VARCHAR(200) NOT NULL,
    value       TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (mini_app_id, user_id, key)
  )`,

  `CREATE TABLE IF NOT EXISTS analytics_events (
    id             UUID        NOT NULL DEFAULT gen_random_uuid(),
    mini_app_id    UUID        NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
    user_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
    event_type     VARCHAR(50) NOT NULL,
    event_name     VARCHAR(100),
    event_data     JSONB       NOT NULL DEFAULT '{}',
    session_id     UUID,
    platform       VARCHAR(20),
    app_version    VARCHAR(20),
    goseen_version VARCHAR(20),
    duration_ms    INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_analytics_app_time ON analytics_events(mini_app_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_user     ON analytics_events(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS app_review_queue (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id           UUID        NOT NULL REFERENCES mini_app_versions(id) ON DELETE CASCADE,
    mini_app_id          UUID        NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
    status               VARCHAR(20) NOT NULL DEFAULT 'pending',
    reviewer_id          UUID,
    security_scan_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    security_scan_result JSONB,
    review_notes         TEXT,
    assigned_at          TIMESTAMPTZ,
    completed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_review_queue_status ON app_review_queue(status, created_at)`,

  // Ensure bundle_hash column exists for DBs created before it was added to the DDL
  `ALTER TABLE mini_app_versions ADD COLUMN IF NOT EXISTS bundle_hash CHAR(64)`,

  // Bot-chat: store the mini app slug so we can navigate back to the right app
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS mini_app_slug VARCHAR(100)`,

  // Stories: drop legacy Firebase-era table (id TEXT, payload JSONB) if present,
  // then recreate with normalized UUID schema.
  `DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'stories' AND column_name = 'author_uid'
    ) THEN
      DROP TABLE IF EXISTS stories CASCADE;
    END IF;
  END $$`,

  `CREATE TABLE IF NOT EXISTS stories (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_url           TEXT,
    is_video            BOOLEAN     NOT NULL DEFAULT false,
    text                TEXT,
    text_bg_color_value BIGINT      NOT NULL DEFAULT 4283953362,
    overlays_json       TEXT,
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS story_views (
    story_id  UUID        NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (story_id, viewer_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_stories_user_id    ON stories(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stories_expires_at ON stories(expires_at)`,

  // Add overlays_json to existing stories tables that predate this column
  `ALTER TABLE stories ADD COLUMN IF NOT EXISTS overlays_json TEXT`,

  // Story reactions — one emoji per user per story (upsert changes emoji)
  `CREATE TABLE IF NOT EXISTS story_reactions (
    story_id   UUID        NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    emoji      VARCHAR(10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (story_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_story_reactions_story ON story_reactions (story_id)`,
  `CREATE INDEX IF NOT EXISTS idx_story_reactions_user  ON story_reactions (user_id)`,

  // metadata for story_reply message type (and future rich message types)
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB`,

  // ── Credits & Premium ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS user_credits (
    user_id            UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance            INT         NOT NULL DEFAULT 0 CHECK (balance >= 0),
    lifetime_earned    INT         NOT NULL DEFAULT 0,
    ads_watched_today  INT         NOT NULL DEFAULT 0,
    ad_date            DATE,
    streak_days        INT         NOT NULL DEFAULT 0,
    last_activity      DATE,
    cooldown_until     TIMESTAMPTZ,
    premium_expires_at TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Add columns that may be absent if the table was created by admin setup.sql
  `ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS ads_watched_today  INT         NOT NULL DEFAULT 0`,
  `ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS ad_date            DATE`,
  `ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS streak_days        INT         NOT NULL DEFAULT 0`,
  `ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS last_activity      DATE`,
  `ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS cooldown_until     TIMESTAMPTZ`,
  `ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMPTZ`,

  `CREATE TABLE IF NOT EXISTS credit_transactions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount      INT         NOT NULL,
    type        TEXT        NOT NULL DEFAULT 'other',
    description TEXT        NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credit_txs_user ON credit_transactions (user_id, created_at DESC)`,

  // ── Profile views counter ─────────────────────────────────────────────────
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_views INT NOT NULL DEFAULT 0`,

  // ── Profile view log (one row per unique visitor) ─────────────────────────
  `CREATE TABLE IF NOT EXISTS profile_view_logs (
    viewer_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (viewer_id, profile_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pvl_profile ON profile_view_logs (profile_id, viewed_at DESC)`,

  // ── Device sessions (multi-session support) ───────────────────────────────
  `CREATE TABLE IF NOT EXISTS device_sessions (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT        NOT NULL,
    platform           VARCHAR(20),
    device_name        VARCHAR(100),
    ip_address         VARCHAR(45),
    last_active_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_sessions_user ON device_sessions (user_id, last_active_at DESC)`,
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
