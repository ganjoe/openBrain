-- 20-youtube-schema.sql
-- YouTube integration for CCO agent
-- Mirrors the X integration pattern: yt_channels (analog x_users) + agent_workspace (artifact_type = 'yt_chunk')
SET search_path = public, extensions;

-- ─────────────────────────────────────────────────────────────
-- TABLE 1: yt_channels (analog x_users + 05-influencers.sql)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS yt_channels (
  handle        TEXT PRIMARY KEY,                -- "@markminervini"
  channel_id    TEXT NOT NULL,                   -- "UCxyz..." (YouTube internal ID)
  title         TEXT,                            -- "Mark Minervini"
  notes         TEXT,                            -- "Trading educator, VCP/SEPA methodology"
  embedding     vector(4096),                    -- For fuzzy search (like x_users)
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- TABLE 2: yt_videos (Pipeline-Tracking)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS yt_videos (
  video_id          TEXT PRIMARY KEY,            -- YouTube Video-ID ("dQw4w9WgXcQ")
  channel           TEXT REFERENCES yt_channels(handle),
  title             TEXT NOT NULL,
  duration          INTEGER,                     -- Seconds
  published_at      TIMESTAMPTZ,
  status            TEXT DEFAULT 'pending',      -- pending → downloaded → processing → embedded → failed
  chunk_count       INTEGER DEFAULT 0,
  error_msg         TEXT,                        -- Last error (for retry)
  transcript        TEXT,                        -- Raw transcript text (downloaded phase)
  language          TEXT DEFAULT 'en',           -- Detected language ('en', 'de', etc.)

  -- Future fields (Phase 2/3, created now to avoid migration later):
  transcript_source TEXT DEFAULT 'auto_captions', -- 'auto_captions' | 'whisper' (Phase 2)
  media_path        TEXT,                        -- Path to downloaded video file (Phase 2)
  frames_path       TEXT,                        -- Path to 2fps frames directory (Phase 3)
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_yt_videos_channel ON yt_videos (channel);
CREATE INDEX IF NOT EXISTS idx_yt_videos_status ON yt_videos (status);

-- ─────────────────────────────────────────────────────────────
-- FUNCTION: search_yt_channels (analog search_influencers)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION search_yt_channels(
  query_embedding vector(4096),
  query_text text,
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  handle text,
  title text,
  notes text,
  similarity float,
  match_quality int
)
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.handle,
    t.title,
    t.notes,
    CASE WHEN query_embedding IS NOT NULL
         THEN 1 - (t.embedding <=> query_embedding)::float
         ELSE 0.0 END AS similarity,
    CASE
      WHEN lower(t.handle) = lower(query_text) THEN 400
      WHEN lower(coalesce(t.title, '')) = lower(query_text) THEN 350
      WHEN t.handle ILIKE query_text || '%' THEN 300
      WHEN t.title ILIKE query_text || '%' THEN 250
      WHEN t.handle ILIKE '%' || query_text || '%' THEN 200
      WHEN t.title ILIKE '%' || query_text || '%' THEN 150
      WHEN t.notes ILIKE '%' || query_text || '%' THEN 100
      ELSE 0
    END AS match_quality
  FROM yt_channels t
  WHERE t.is_active = TRUE
    AND (
      (query_embedding IS NOT NULL AND 1 - (t.embedding <=> query_embedding) > match_threshold)
      OR t.handle ILIKE '%' || query_text || '%'
      OR t.title ILIKE '%' || query_text || '%'
      OR t.notes ILIKE '%' || query_text || '%'
    )
  ORDER BY match_quality DESC, similarity DESC NULLS LAST, t.handle ASC
  LIMIT match_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- GRANTS
-- ─────────────────────────────────────────────────────────────
GRANT ALL ON TABLE public.yt_channels TO anon;
GRANT ALL ON TABLE public.yt_channels TO service_role;
GRANT ALL ON TABLE public.yt_videos TO anon;
GRANT ALL ON TABLE public.yt_videos TO service_role;
GRANT EXECUTE ON FUNCTION search_yt_channels TO anon;
GRANT EXECUTE ON FUNCTION search_yt_channels TO service_role;
