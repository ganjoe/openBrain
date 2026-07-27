-- 06-x-sync-logs.sql
-- Sync activity logging and pipeline status tracking for X integration
SET search_path = public, extensions;

-- 1. X Sync Logs table for tracking sync activity
CREATE TABLE IF NOT EXISTS x_sync_logs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  action_type TEXT NOT NULL,  -- 'discovery', 'embedding', 'categorization', 'error', 'info'
  username    TEXT,
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_x_sync_logs_created ON x_sync_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x_sync_logs_username ON x_sync_logs (username);

-- 2. Add status column to agent_workspace for pipeline tracking
ALTER TABLE agent_workspace ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'embedded';

-- Set existing posts with llm_categorized flag to 'categorized'
UPDATE agent_workspace SET status = 'categorized' 
  WHERE artifact_type = 'x_post' AND metadata->>'llm_categorized' = 'true' AND (status IS NULL OR status = 'embedded');

-- Set remaining x_posts without embeddings to 'pending'
UPDATE agent_workspace SET status = 'pending'
  WHERE artifact_type = 'x_post' AND embedding IS NULL AND status IS NULL;

-- Index for efficient pipeline queries
CREATE INDEX IF NOT EXISTS idx_workspace_status ON agent_workspace (status) WHERE artifact_type = 'x_post';

-- 3. Grants
GRANT ALL ON TABLE public.x_sync_logs TO anon;
GRANT ALL ON TABLE public.x_sync_logs TO service_role;
