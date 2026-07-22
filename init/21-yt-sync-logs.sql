-- 21-yt-sync-logs.sql
-- Logging table for YouTube Sync-Tool (Phase 2)
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS yt_sync_logs (
  id            SERIAL PRIMARY KEY,
  action_type   TEXT NOT NULL,               -- e.g., 'started', 'stopped', 'info', 'error'
  channel       TEXT,                        -- optional, if related to a specific channel
  message       TEXT NOT NULL,               -- e.g., 'Sync gestartet', '3 neue Videos heruntergeladen'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_yt_sync_logs_created_at ON yt_sync_logs (created_at DESC);

GRANT ALL ON TABLE public.yt_sync_logs TO anon;
GRANT ALL ON TABLE public.yt_sync_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE yt_sync_logs_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE yt_sync_logs_id_seq TO service_role;
