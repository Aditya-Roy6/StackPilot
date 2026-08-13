-- Store the desired runtime URL scheme at project level and snapshot it per deployment.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS runtime_scheme VARCHAR(10) NOT NULL DEFAULT 'http',
    ADD COLUMN IF NOT EXISTS local_https_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Only normalize rows that are missing or invalid. The original unconditional
-- rewrite reverted a user's manual http/https choice on every restart.
UPDATE projects
SET runtime_scheme = CASE
    WHEN local_https_enabled THEN 'https'
    ELSE 'http'
END
WHERE runtime_scheme IS NULL
   OR runtime_scheme NOT IN ('http', 'https');

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_runtime_scheme_check;
ALTER TABLE projects
    ADD CONSTRAINT projects_runtime_scheme_check CHECK (runtime_scheme IN ('http', 'https'));
