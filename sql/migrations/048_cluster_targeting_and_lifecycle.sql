-- ============================================================
-- 048_cluster_targeting_and_lifecycle.sql
-- ============================================================
-- Until now the Cluster Builder built a real k3s cluster, recorded its server
-- URL and join token, reported "ready" -- and then nothing could deploy to it.
-- KubernetesService reads one kubeconfig from the KUBECONFIG_PATH environment
-- variable, so every deployment landed on whatever cluster the backend
-- container happened to be pointed at, usually a local minikube.
--
-- The missing piece was never the provisioning. It was that a built cluster
-- had no kubeconfig stored and no way to be chosen as a target.

BEGIN;

-- ── make a built cluster usable ─────────────────────────────────
-- The admin kubeconfig k3s writes to /etc/rancher/k3s/k3s.yaml, with its
-- server: address rewritten from 127.0.0.1 to something the backend can
-- actually reach. Encrypted: it is a full cluster-admin credential.
ALTER TABLE kubernetes_clusters ADD COLUMN IF NOT EXISTS kubeconfig_encrypted TEXT;

-- Nodes joined before this migration have no recorded architecture; NULL means
-- "not yet inspected" rather than "unknown platform".
ALTER TABLE kubernetes_cluster_nodes ADD COLUMN IF NOT EXISTS architecture VARCHAR(20);
ALTER TABLE kubernetes_cluster_nodes ADD COLUMN IF NOT EXISTS os_image TEXT;
ALTER TABLE kubernetes_cluster_nodes ADD COLUMN IF NOT EXISTS kubelet_version VARCHAR(40);
-- Set when a node is removed rather than deleting the row, so the cluster
-- keeps a history of what was once part of it.
ALTER TABLE kubernetes_cluster_nodes ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

-- ── let a deployment choose where it lands ──────────────────────
-- NULL keeps today's behaviour exactly: fall back to KUBECONFIG_PATH. That
-- matters because every existing deployment has NULL here and must keep
-- working without being touched.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS target_cluster_id UUID
    REFERENCES kubernetes_clusters(id) ON DELETE SET NULL;

-- A project can pin a default cluster so new deployments inherit it.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_cluster_id UUID
    REFERENCES kubernetes_clusters(id) ON DELETE SET NULL;

-- An environment can override the project default, which is how "staging on
-- the cheap box, production on the big one" is expressed.
ALTER TABLE project_environments ADD COLUMN IF NOT EXISTS target_cluster_id UUID
    REFERENCES kubernetes_clusters(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deployments_target_cluster ON deployments(target_cluster_id);

-- ── autoscaling ─────────────────────────────────────────────────
-- The planner has emitted a valid autoscaling/v2 HorizontalPodAutoscaler for
-- some time, but no endpoint ever set enableHorizontalPodAutoscaler, so the
-- code was unreachable. These columns are what finally turn it on.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS autoscaling_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS autoscaling_min_replicas INTEGER NOT NULL DEFAULT 1;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS autoscaling_max_replicas INTEGER NOT NULL DEFAULT 3;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS autoscaling_cpu_target INTEGER NOT NULL DEFAULT 70;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so this migration was not
-- re-runnable: applying it twice failed with "constraint already exists" and
-- crash-looped the backend on boot. Dropping first makes it idempotent, which
-- every migration has to be regardless of what the ledger thinks it has seen.
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_autoscaling_range;
ALTER TABLE deployments ADD CONSTRAINT deployments_autoscaling_range
    CHECK (autoscaling_min_replicas >= 1
           AND autoscaling_max_replicas >= autoscaling_min_replicas
           AND autoscaling_cpu_target BETWEEN 1 AND 100);

-- ── high availability ───────────────────────────────────────────
-- A single control plane means one VM failure destroys the cluster. Recording
-- the role lets a second and third server node join the same etcd.
ALTER TABLE kubernetes_clusters ADD COLUMN IF NOT EXISTS ha_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
