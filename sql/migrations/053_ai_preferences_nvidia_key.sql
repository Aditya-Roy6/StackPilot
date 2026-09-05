-- Migration 053: Support per-user API key for NVIDIA NIM and custom providers
ALTER TABLE ai_preferences ADD COLUMN IF NOT EXISTS nvidia_api_key TEXT;
