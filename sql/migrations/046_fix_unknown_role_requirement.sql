-- ============================================================
-- 046_fix_unknown_role_requirement.sql
-- ============================================================
-- has_project_access() compared role_rank(held) >= role_rank(required), and
-- role_rank() returns 0 for anything it does not recognise. That is the right
-- answer for a role somebody *holds* — an unknown role should grant nothing —
-- but it is exactly backwards for a role a caller *requires*: every user
-- cleared a bar of zero.
--
-- So has_project_access(project, user, 'superuser') returned TRUE for any
-- member of the organization, and a typo in a required role — 'admins',
-- 'Admin', a constant renamed on one side only — turned a privileged gate into
-- an open one. It fails open, which is the worst direction for the function
-- that guards all 41 project queries.
--
-- Requiring a role that does not exist is a programming error. The safe
-- reading of it is "nobody qualifies", which matches what Authz::roleAtLeast()
-- already does in C++.

BEGIN;

CREATE OR REPLACE FUNCTION has_project_access(p_project UUID, p_user UUID, p_min_role TEXT DEFAULT 'viewer')
RETURNS BOOLEAN
LANGUAGE SQL STABLE PARALLEL SAFE AS $$
    SELECT CASE
        -- Unrecognised requirement: deny rather than admit everyone.
        WHEN role_rank(p_min_role) = 0 THEN FALSE
        ELSE COALESCE(role_rank(project_role(p_project, p_user)) >= role_rank(p_min_role), FALSE)
    END;
$$;

COMMIT;
