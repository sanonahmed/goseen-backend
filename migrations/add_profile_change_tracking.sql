-- Track when display_name and username were last changed
-- Used to enforce the 7-day cooldown on profile identity fields.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMPTZ;
