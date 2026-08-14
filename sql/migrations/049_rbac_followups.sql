-- ============================================================
-- 049_rbac_followups.sql
-- ============================================================
-- Two consequences of making projects shareable that were not consequences
-- when a project belonged to exactly one person.

BEGIN;

-- projects.user_id was ON DELETE CASCADE. That was harmless when a project
-- belonged to one user. Now that a project belongs to an organization other
-- people are members of, deleting a user silently destroys team
-- infrastructure -- an ordinary offboarding action causing data loss with no
-- error and no warning.
--
-- RESTRICT forces an explicit decision: reassign the projects, or delete them
-- deliberately.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_user_id_fkey;
ALTER TABLE projects
    ADD CONSTRAINT projects_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

COMMIT;
