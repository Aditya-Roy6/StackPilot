-- ============================================================
-- 047_drift_cost_and_previews.sql
-- ============================================================
-- Schema for three features that share a spine: they all describe a deployment
-- over time rather than at a point.
--
--   drift    what the cluster actually looks like vs what we asked for
--   cost     what a deployment consumed while it was running
--   preview  short-lived deployments tied to a pull request
--
-- Kept in one migration because previews are the main consumer of the other
-- two: a preview that silently drifts or quietly costs money is the exact
-- failure mode ephemeral environments are notorious for.

BEGIN;

-- ── drift ───────────────────────────────────────────────────────
-- One row per check, not one per finding. A check that found nothing is still
-- worth recording: "we looked at 14:02 and it was fine" is the difference
-- between healthy and unmonitored, and without it a silent detector is
-- indistinguishable from a clean cluster.
CREATE TABLE IF NOT EXISTS deployment_drift_checks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- ok | drifted | unreachable. `unreachable` is deliberately not `drifted`:
    -- not being able to see the cluster is an operational problem, not a
    -- statement about the cluster's contents.
    status        VARCHAR(20) NOT NULL CHECK (status IN ('ok', 'drifted', 'unreachable')),
    findings      JSONB NOT NULL DEFAULT '[]'::jsonb,
    summary       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_drift_deployment ON deployment_drift_checks(deployment_id, checked_at DESC);

-- ── cost ────────────────────────────────────────────────────────
-- Samples rather than a running total. A total cannot be recomputed when the
-- rate card changes or a bug is found in the accrual; samples can.
CREATE TABLE IF NOT EXISTS deployment_cost_samples (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id     UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sampled_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The window this sample accounts for, so gaps in sampling (a restart, a
    -- paused worker) under-report rather than silently inventing usage.
    window_seconds    INTEGER NOT NULL CHECK (window_seconds > 0),
    replicas          INTEGER NOT NULL DEFAULT 1,
    cpu_millicores    INTEGER NOT NULL DEFAULT 0,
    memory_mb         INTEGER NOT NULL DEFAULT 0,
    -- Stored in millicents to keep the arithmetic in integers. Floating point
    -- money is a bug waiting for a big enough invoice.
    accrued_millicents BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cost_org_time ON deployment_cost_samples(organization_id, sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_project_time ON deployment_cost_samples(project_id, sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_deployment ON deployment_cost_samples(deployment_id, sampled_at DESC);

-- ── preview environments ────────────────────────────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_environments_enabled BOOLEAN NOT NULL DEFAULT FALSE;
-- Previews are cheap to create and easy to forget. A TTL means the default
-- outcome of walking away is cleanup, not a bill.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_ttl_hours INTEGER NOT NULL DEFAULT 72;

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS is_preview BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS pr_number INTEGER;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS pr_title TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS pr_author VARCHAR(255);
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS preview_expires_at TIMESTAMPTZ;

-- One live preview per (project, PR). Pushing to a PR replaces its preview
-- rather than accumulating one deployment per commit -- the behaviour that
-- makes preview environments a cost story instead of a feature.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_active_preview
    ON deployments(project_id, pr_number)
    WHERE is_preview AND status NOT IN ('destroyed', 'failed', 'superseded');

CREATE INDEX IF NOT EXISTS idx_deployments_preview_expiry
    ON deployments(preview_expires_at)
    WHERE is_preview AND preview_expires_at IS NOT NULL;

COMMIT;
