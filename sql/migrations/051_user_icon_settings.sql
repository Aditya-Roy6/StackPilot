-- ============================================================
-- 051_user_icon_settings.sql
-- ============================================================
-- Persist user icon configurations and custom vector overrides
-- so that custom icons survive browser cache clears.

BEGIN;

CREATE TABLE IF NOT EXISTS user_icon_settings (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mode        VARCHAR(32) NOT NULL DEFAULT 'custom',
    pack        VARCHAR(32) NOT NULL DEFAULT 'duotone',
    overrides   JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_icon_settings_user ON user_icon_settings(user_id);

COMMIT;
