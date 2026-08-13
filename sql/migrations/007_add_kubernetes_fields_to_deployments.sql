-- Add Kubernetes deployment tracking metadata
ALTER TABLE deployments
    ADD COLUMN IF NOT EXISTS k8s_namespace VARCHAR(100) DEFAULT '',
    ADD COLUMN IF NOT EXISTS k8s_deployment_name VARCHAR(150) DEFAULT '',
    ADD COLUMN IF NOT EXISTS k8s_service_name VARCHAR(150) DEFAULT '',
    ADD COLUMN IF NOT EXISTS desired_replicas INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS runtime_url TEXT DEFAULT '';

-- Backfill only genuinely missing values. The old `OR desired_replicas < 1`
-- clause resurrected deployments a user had deliberately scaled to zero.
UPDATE deployments
SET desired_replicas = 1
WHERE desired_replicas IS NULL;
