-- ============================================================
-- 052_user_preferences_and_appearance.sql
-- ============================================================
-- Persist complete user settings, appearance, theme, color mode,
-- sidebar states, and personal UI preferences in PostgreSQL so they
-- follow the user across all devices and browsers.

BEGIN;

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ui_theme          VARCHAR(32) NOT NULL DEFAULT 'shadcn',
    color_mode        VARCHAR(32) NOT NULL DEFAULT 'system',
    sidebar_collapsed BOOLEAN NOT NULL DEFAULT FALSE,
    icon_mode         VARCHAR(32) NOT NULL DEFAULT 'custom',
    icon_pack         VARCHAR(32) NOT NULL DEFAULT 'duotone',
    icon_overrides    JSONB NOT NULL DEFAULT '{}'::jsonb,
    preferences       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill from user_icon_settings if exists
INSERT INTO user_preferences (user_id, icon_mode, icon_pack, icon_overrides, updated_at)
SELECT user_id, mode, pack, overrides, updated_at
FROM user_icon_settings
ON CONFLICT (user_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id);

COMMIT;
