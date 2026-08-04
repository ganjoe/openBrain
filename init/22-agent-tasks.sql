-- 22-agent-tasks.sql
-- Persistent task store for background jobs with original request context.
-- Enables async continuation: when a background job completes, the owning
-- agent wakes up with the full original request to fulfill it.

CREATE TABLE IF NOT EXISTS agent_tasks (
  id              TEXT PRIMARY KEY,                    -- e.g. "sync_1722729600_abc123"
  agent_id        TEXT NOT NULL,                       -- e.g. "cco"
  task_type       TEXT NOT NULL,                       -- e.g. "x_sync", "yt_sync"
  status          TEXT NOT NULL DEFAULT 'running',     -- running | completed | failed
  original_request TEXT NOT NULL DEFAULT '',           -- The original boss request text
  context         JSONB DEFAULT '{}'::jsonb,           -- Flexible context object (author, limit, etc.)
  result          JSONB,                               -- Result after completion
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent ON agent_tasks (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created ON agent_tasks (created_at DESC);

-- Grants
GRANT ALL ON TABLE public.agent_tasks TO anon;
GRANT ALL ON TABLE public.agent_tasks TO service_role;
