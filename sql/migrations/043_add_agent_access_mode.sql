-- Server-side agent permission policy.
--
-- The "Agent Permissions" control lived entirely in browser localStorage, so it
-- was a UI speed bump: anything calling the API directly (including the agent
-- itself, or an MCP client) bypassed it completely. Storing the policy here
-- makes it enforceable and auditable.
--
--   ask         - agent may read and advise, but not create or deploy
--   auto_review - agent may act only when the request is explicitly approved
--   full_access - agent may act autonomously

ALTER TABLE ai_preferences
    ADD COLUMN IF NOT EXISTS agent_access_mode VARCHAR(20) NOT NULL DEFAULT 'ask';

ALTER TABLE ai_preferences DROP CONSTRAINT IF EXISTS ai_preferences_agent_access_mode_check;
ALTER TABLE ai_preferences
    ADD CONSTRAINT ai_preferences_agent_access_mode_check
    CHECK (agent_access_mode IN ('ask', 'auto_review', 'full_access'));
