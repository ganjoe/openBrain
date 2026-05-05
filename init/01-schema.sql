-- Open Brain Local: Database Schema
-- Adapted from docs/01-getting-started.md for local self-hosted stack
-- Vector dimension: 4096 (Qwen3-Embedding-8B via Ollama)
-- Note: HNSW index requires <=2000 dims, so we skip it for 4096-dim vectors.
--       Exact search works fine for small-to-medium datasets.

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create roles for PostgREST
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOLOGIN;
    GRANT anon TO authenticator;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin WITH LOGIN SUPERUSER PASSWORD '1e13dc85555d32f7b507090393ccd36e';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin WITH LOGIN SUPERUSER PASSWORD '1e13dc85555d32f7b507090393ccd36e';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
    CREATE ROLE supabase_storage_admin WITH LOGIN SUPERUSER PASSWORD '1e13dc85555d32f7b507090393ccd36e';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon;

-- 3. Create the thoughts table
CREATE TABLE IF NOT EXISTS thoughts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content text NOT NULL,
  embedding vector(4096),
  metadata jsonb DEFAULT '{}'::jsonb,
  content_fingerprint text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 4. Indexes (no HNSW for >2000 dims, exact search for now)
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata
  ON thoughts USING gin (metadata);

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at
  ON thoughts (created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_fingerprint
  ON thoughts (content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

-- 5. Auto-update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS thoughts_updated_at ON thoughts;
CREATE TRIGGER thoughts_updated_at
  BEFORE UPDATE ON thoughts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- 6. Semantic search function
CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(4096),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10,
  filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) AS similarity,
    t.created_at
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 6b. Keyword search function
CREATE OR REPLACE FUNCTION search_thoughts_keyword(
  query_text text,
  match_count int DEFAULT 10,
  filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    t.created_at
  FROM thoughts t
  WHERE (t.content ILIKE '%' || query_text || '%'
         OR t.metadata::text ILIKE '%' || query_text || '%')
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.created_at DESC
  LIMIT match_count;
END;
$$;

-- 6c. Hybrid search function (combines semantic + keyword with deduplication)
CREATE OR REPLACE FUNCTION hybrid_search_thoughts(
  query_embedding vector(4096),
  query_text text,
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 20,
  filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_semantic_ids uuid[];
  v_keyword_ids uuid[];
  v_semantic_count int;
BEGIN
  -- Step 1: Collect semantic match IDs (up to match_count)
  SELECT array_agg(t.id ORDER BY t.embedding <=> query_embedding)
  INTO v_semantic_ids
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter);

  v_semantic_count := COALESCE(array_length(v_semantic_ids, 1), 0);

  -- Step 2: Find keyword matches NOT already in semantic results (fill up to match_count)
  IF v_semantic_count < match_count THEN
    SELECT array_agg(t.id ORDER BY t.created_at DESC)
    INTO v_keyword_ids
    FROM thoughts t
    WHERE (t.content ILIKE '%' || query_text || '%'
         OR t.metadata::text ILIKE '%' || query_text || '%')
      AND (v_semantic_ids IS NULL OR t.id != ALL(v_semantic_ids))
      AND (filter = '{}'::jsonb OR t.metadata @> filter)
    LIMIT match_count - v_semantic_count;
  END IF;

  -- Step 3: Return semantic results first, then keyword fill-ups
  RETURN QUERY
  SELECT t.id, t.content, t.metadata,
    1 - (t.embedding <=> query_embedding)::float AS similarity,
    t.created_at
  FROM thoughts t
  WHERE v_semantic_ids IS NOT NULL AND t.id = ANY(v_semantic_ids)
  ORDER BY t.embedding <=> query_embedding;

  RETURN QUERY
  SELECT t.id, t.content, t.metadata,
    NULL::float AS similarity,
    t.created_at
  FROM thoughts t
  WHERE v_keyword_ids IS NOT NULL AND t.id = ANY(v_keyword_ids);
END;
$$;


-- 7. Upsert function with content fingerprint deduplication
CREATE OR REPLACE FUNCTION upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')
RETURNS JSONB AS $$
DECLARE
  v_fingerprint TEXT;
  v_result JSONB;
  v_id UUID;
BEGIN
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');

  INSERT INTO thoughts (content, content_fingerprint, metadata)
  VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb))
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
  SET updated_at = now(),
      metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id INTO v_id;

  v_result := jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- 8. Row Level Security
ALTER TABLE thoughts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON thoughts;
CREATE POLICY "Service role full access"
  ON thoughts
  FOR ALL
  USING (true);

-- 9. Grant permissions
GRANT ALL ON TABLE public.thoughts TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thoughts TO anon;
GRANT EXECUTE ON FUNCTION match_thoughts TO anon;
GRANT EXECUTE ON FUNCTION search_thoughts_keyword TO anon;
GRANT EXECUTE ON FUNCTION hybrid_search_thoughts TO anon;
GRANT EXECUTE ON FUNCTION upsert_thought TO anon;

-- ============================================================
-- 10. Nexus Message Log
--     Stores all inter-agent MQTT messages in full JSONB form.
--     The Nexus-Service writes here; the dashboard reads here.
-- ============================================================
CREATE TABLE IF NOT EXISTS nexus_messages (
  id          BIGSERIAL PRIMARY KEY,
  from_agent  TEXT      NOT NULL,
  to_agent    TEXT      NOT NULL,
  msg_type    TEXT      NOT NULL DEFAULT 'chat',
  unix_ts     BIGINT    NOT NULL,
  date_str    TEXT,
  full_json   JSONB     NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Agenten-Vektor index: fast bidirectional lookup (ea<->cco, boss<->ea, ...)
CREATE INDEX IF NOT EXISTS idx_nexus_vector
  ON nexus_messages (from_agent, to_agent);

-- Time index: History-Provider (since=unix_ts)
CREATE INDEX IF NOT EXISTS idx_nexus_unix
  ON nexus_messages (unix_ts);

-- Type index: Status-Channel + MCP-Stream filter
CREATE INDEX IF NOT EXISTS idx_nexus_type
  ON nexus_messages (msg_type);

-- RLS + Permissions
ALTER TABLE nexus_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Nexus full access" ON nexus_messages;
CREATE POLICY "Nexus full access"
  ON nexus_messages
  FOR ALL
  USING (true);

GRANT ALL ON TABLE public.nexus_messages TO postgres;
GRANT ALL ON TABLE public.nexus_messages TO service_role;
GRANT ALL ON TABLE public.nexus_messages TO authenticator;
GRANT ALL ON TABLE public.nexus_messages TO anon;
GRANT ALL ON SEQUENCE public.nexus_messages_id_seq TO postgres;
GRANT ALL ON SEQUENCE public.nexus_messages_id_seq TO service_role;
GRANT ALL ON SEQUENCE public.nexus_messages_id_seq TO authenticator;
GRANT ALL ON SEQUENCE public.nexus_messages_id_seq TO anon;
