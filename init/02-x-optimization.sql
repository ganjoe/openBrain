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

-- 3. Generated Column & Unique Index for Deduplication
-- Add the generated column to allow explicit targeting for sorting and upsert conflicts
ALTER TABLE agent_workspace ADD COLUMN IF NOT EXISTS x_external_id text GENERATED ALWAYS AS (metadata->>'external_id') STORED;

-- Create the unique index on the actual column
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_x_id ON agent_workspace (x_external_id);

-- 4. Grants
GRANT ALL ON TABLE public.x_users TO anon;
GRANT ALL ON TABLE public.x_users TO service_role;
GRANT ALL ON TABLE public.x_sync_locks TO anon;
GRANT ALL ON TABLE public.x_sync_locks TO service_role;
