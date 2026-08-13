-- Project secrets: encrypted, write-only values scoped to a project and
-- optionally to a single environment.
--
-- Distinct from project_env_vars: env vars are ordinary configuration that the
-- UI happily displays, whereas a secret's value is never returned by the list
-- API, is revealed only through an explicitly audited endpoint, and records when
-- it was last read and by which deployment.

CREATE TABLE IF NOT EXISTS project_secrets (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- NULL environment_id means the secret applies to every environment.
    environment_id   UUID REFERENCES project_environments(id) ON DELETE CASCADE,
    key              VARCHAR(255) NOT NULL,
    value_encrypted  TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    version          INTEGER NOT NULL DEFAULT 1,
    last_accessed_at TIMESTAMPTZ,
    last_accessed_by VARCHAR(120) NOT NULL DEFAULT '',
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NULLS NOT DISTINCT (PostgreSQL 15+) makes a project-wide secret (NULL
-- environment) collide with another project-wide secret of the same key, which a
-- plain UNIQUE would not catch because NULLs compare as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_secrets_scope_key
    ON project_secrets(project_id, environment_id, key) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_project_secrets_project
    ON project_secrets(project_id);

CREATE INDEX IF NOT EXISTS idx_project_secrets_environment
    ON project_secrets(environment_id);
