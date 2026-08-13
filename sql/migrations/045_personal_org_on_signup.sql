-- ============================================================
-- 045_personal_org_on_signup.sql
-- ============================================================
-- Migration 044 backfilled a personal organization for existing users, but a
-- newly registered user would have none — and projects.organization_id is NOT
-- NULL, so their first project would fail to insert.
--
-- A trigger rather than code in the handlers: there are three ways to become a
-- user (local registration, Google, GitHub), and a fourth would be added
-- without remembering this. The database is the only place that sees all of
-- them.

BEGIN;

CREATE OR REPLACE FUNCTION create_personal_organization()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    new_org_id UUID;
BEGIN
    INSERT INTO organizations (name, slug, created_by, is_personal)
    VALUES (
        COALESCE(NULLIF(NEW.full_name, ''), NEW.username) || '''s workspace',
        'personal-' || REPLACE(NEW.id::text, '-', ''),
        NEW.id,
        TRUE
    )
    RETURNING id INTO new_org_id;

    INSERT INTO organization_members (organization_id, user_id, role)
    VALUES (new_org_id, NEW.id, 'owner');

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_create_personal_org ON users;
CREATE TRIGGER users_create_personal_org
    AFTER INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION create_personal_organization();

COMMIT;
