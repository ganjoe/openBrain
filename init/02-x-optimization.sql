-- Optimization for X API integration

-- 1. Persistent User Mapping
CREATE TABLE IF NOT EXISTS x_users (
  username TEXT PRIMARY KEY,
  x_id     TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Persistent Locks for Background Sync
CREATE TABLE IF NOT EXISTS x_sync_locks (
  username   TEXT PRIMARY KEY,
  locked_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Unique Index for Deduplication
-- Using (metadata->>'external_id') as requested.
-- Note: We filter for artifact_type = 'x_post' to keep it clean.
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_external_id ON agent_workspace ((metadata->>'external_id')) WHERE (artifact_type = 'x_post');

-- 4. Grants
GRANT ALL ON TABLE public.x_users TO anon;
GRANT ALL ON TABLE public.x_users TO service_role;
GRANT ALL ON TABLE public.x_sync_locks TO anon;
GRANT ALL ON TABLE public.x_sync_locks TO service_role;
