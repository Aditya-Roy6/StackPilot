-- ============================================================
-- 050_organization_invitations_and_management.sql
-- ============================================================
-- Support inviting teammates before they have registered an account,
-- and automatically claiming invitations upon signup/login.

BEGIN;

CREATE TABLE IF NOT EXISTS organization_invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           VARCHAR(255) NOT NULL,
    role            VARCHAR(20) NOT NULL
                    CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    token           VARCHAR(64) NOT NULL UNIQUE,
    invited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    CONSTRAINT unique_org_invite_email UNIQUE (organization_id, email)
);

CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON organization_invitations(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON organization_invitations(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON organization_invitations(token);

-- Auto-claim pending invitations when a new user registers
CREATE OR REPLACE FUNCTION claim_organization_invitations()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO organization_members (organization_id, user_id, role, invited_by)
    SELECT i.organization_id, NEW.id, i.role, i.invited_by
    FROM organization_invitations i
    WHERE LOWER(i.email) = LOWER(NEW.email)
      AND i.expires_at > NOW()
    ON CONFLICT (organization_id, user_id) DO UPDATE
    SET role = EXCLUDED.role;

    DELETE FROM organization_invitations
    WHERE LOWER(email) = LOWER(NEW.email);

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_claim_org_invitations ON users;
CREATE TRIGGER users_claim_org_invitations
    AFTER INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION claim_organization_invitations();

COMMIT;
