-- Migration 054: Add metadata column to deployment_jobs for AI repair and custom job attributes
ALTER TABLE deployment_jobs ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_deployment_jobs_metadata ON deployment_jobs USING gin (metadata);
