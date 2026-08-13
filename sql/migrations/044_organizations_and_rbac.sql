-- ============================================================
-- 044_organizations_and_rbac.sql
-- ============================================================
-- Until now every row was reachable by exactly one user, expressed as
-- `WHERE ... user_id = $1` in 94 places across 15 files. Adding team access by
-- rewriting 94 predicates by hand is how you end up with 93 correct ones and a
-- data leak, so this migration puts the decision in a single SQL function and
-- leaves the call sites saying only "may this user touch this project".
--
-- Existing behaviour is preserved exactly: every user gets a personal
-- organization containing the projects they already owned, and they are its
-- owner. A single-user install sees no change.

BEGIN;

CREATE TABLE IF NOT EXISTS organizations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(120) NOT NULL,
    slug        VARCHAR(80)  NOT NULL UNIQUE,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    -- A personal org is created implicitly for each user and cannot be left or
    -- deleted; it is what keeps "no organization" from being a state the rest
    -- of the platform has to handle.
    is_personal BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_members (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- viewer < member < admin < owner. Kept as text rather than an enum so a
    -- future role does not require an ALTER TYPE inside a migration.
    role            VARCHAR(20) NOT NULL
                    CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    invited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

-- ── backfill ────────────────────────────────────────────────────
-- One personal organization per existing user, holding the projects they
-- already own. The slug is derived from the user id rather than the username
-- so it cannot collide and does not leak a rename.
INSERT INTO organizations (name, slug, created_by, is_personal)
SELECT
    COALESCE(NULLIF(u.full_name, ''), u.username) || '''s workspace',
    'personal-' || REPLACE(u.id::text, '-', ''),
    u.id,
    TRUE
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM organizations o WHERE o.created_by = u.id AND o.is_personal
);

INSERT INTO organization_members (organization_id, user_id, role)
SELECT o.id, o.created_by, 'owner'
FROM organizations o
WHERE o.is_personal AND o.created_by IS NOT NULL
ON CONFLICT (organization_id, user_id) DO NOTHING;

UPDATE projects p
SET organization_id = o.id
FROM organizations o
WHERE p.organization_id IS NULL
  AND o.is_personal
  AND o.created_by = p.user_id;

-- Every project must belong to an organization from here on. If the backfill
-- missed one, that is a bug worth failing the migration for rather than
-- discovering later as a project nobody can see.
DO $$
DECLARE orphans INTEGER;
BEGIN
    SELECT COUNT(*) INTO orphans FROM projects WHERE organization_id IS NULL;
    IF orphans > 0 THEN
        RAISE EXCEPTION 'migration 044: % project(s) could not be assigned to an organization', orphans;
    END IF;
END $$;

ALTER TABLE projects ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_organization ON projects(organization_id);

-- ── the authorization primitive ─────────────────────────────────

-- Numeric rank so callers can express "at least member" without repeating the
-- ordering. Unknown roles rank 0, below viewer, so a typo denies rather than
-- grants.
CREATE OR REPLACE FUNCTION role_rank(p_role TEXT)
RETURNS INTEGER
LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE p_role
        WHEN 'owner'  THEN 4
        WHEN 'admin'  THEN 3
        WHEN 'member' THEN 2
        WHEN 'viewer' THEN 1
        ELSE 0
    END;
$$;

-- The user's role on a project, or NULL when they have none.
CREATE OR REPLACE FUNCTION project_role(p_project UUID, p_user UUID)
RETURNS TEXT
LANGUAGE SQL STABLE PARALLEL SAFE AS $$
    SELECT m.role
    FROM projects p
    JOIN organization_members m ON m.organization_id = p.organization_id
    WHERE p.id = p_project AND m.user_id = p_user;
$$;

-- The single question every call site asks. Defaults to 'viewer' so an
-- unqualified call means "can see it at all", and a caller that forgets to
-- name a role gets the least privilege rather than the most.
CREATE OR REPLACE FUNCTION has_project_access(p_project UUID, p_user UUID, p_min_role TEXT DEFAULT 'viewer')
RETURNS BOOLEAN
LANGUAGE SQL STABLE PARALLEL SAFE AS $$
    SELECT COALESCE(role_rank(project_role(p_project, p_user)) >= role_rank(p_min_role), FALSE);
$$;

COMMIT;
