-- Stories: 24-hour expiring media/text stories
CREATE TABLE IF NOT EXISTS stories (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_url           TEXT,
  is_video            BOOLEAN     NOT NULL DEFAULT false,
  text                TEXT,
  text_bg_color_value BIGINT      NOT NULL DEFAULT 4283953362,  -- 0xFF1976D2
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Track which users have viewed each story
CREATE TABLE IF NOT EXISTS story_views (
  story_id   UUID        NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id  UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (story_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS idx_stories_user_id    ON stories(user_id);
CREATE INDEX IF NOT EXISTS idx_stories_expires_at ON stories(expires_at);
