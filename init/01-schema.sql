-- Open Brain Local: 3-Pillar Database Schema (V3)
-- 1. nexus_chat      - Pure MQTT communication log
-- 2. open_brain      - Exclusive long-term memory (thoughts)
-- 3. agent_workspace - Raw data, noisy imports, X-posts

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
END $$;

GRANT USAGE ON SCHEMA public TO anon;

-- ─────────────────────────────────────────────────────────────
-- TABLE 1: nexus_chat (Communication Log)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nexus_chat (
  id          BIGSERIAL PRIMARY KEY,
  from_agent  TEXT      NOT NULL,
  to_agent    TEXT      NOT NULL,
  message_type TEXT      NOT NULL DEFAULT 'chat',
  content     TEXT,
  raw_payload JSONB     NOT NULL,
  unix_ts     BIGINT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_chat_vector ON nexus_chat (from_agent, to_agent);
CREATE INDEX IF NOT EXISTS idx_nexus_chat_created ON nexus_chat (created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- TABLE 2: open_brain (Valuable Thoughts)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS open_brain (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  thought_type TEXT NOT NULL DEFAULT 'observation',
  content      TEXT NOT NULL,
  embedding    vector(4096),
  content_hash TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_open_brain_agent ON open_brain (agent_id);
CREATE INDEX IF NOT EXISTS idx_open_brain_type  ON open_brain (thought_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_open_brain_hash ON open_brain (content_hash) WHERE content_hash IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- TABLE 3: agent_workspace (Raw Data & Scrapes)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_workspace (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  artifact_type TEXT NOT NULL DEFAULT 'x_post',
  content       TEXT NOT NULL,
  embedding     vector(4096),
  metadata      jsonb DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent ON agent_workspace (agent_id);
CREATE INDEX IF NOT EXISTS idx_workspace_type  ON agent_workspace (artifact_type);

-- ─────────────────────────────────────────────────────────────
-- FUNCTIONS
-- ─────────────────────────────────────────────────────────────

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER open_brain_updated_at
  BEFORE UPDATE ON open_brain
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Hybrid search for open_brain
CREATE OR REPLACE FUNCTION hybrid_search_open_brain(
  query_embedding vector(4096),
  query_text text,
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 20,
  p_agent_id text DEFAULT NULL -- If NULL, EA mode (all)
)
RETURNS TABLE (
  id uuid,
  agent_id text,
  thought_type text,
  content text,
  similarity float,
  created_at timestamptz
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.agent_id, t.thought_type, t.content,
    1 - (t.embedding <=> query_embedding)::float AS similarity,
    t.created_at
  FROM open_brain t
  WHERE (p_agent_id IS NULL OR t.agent_id = p_agent_id)
    AND (
      1 - (t.embedding <=> query_embedding) > match_threshold
      OR t.content ILIKE '%' || query_text || '%'
    )
  ORDER BY similarity DESC NULLS LAST, t.created_at DESC
  LIMIT match_count;
END;
$$;

-- Upsert for open_brain (Deduplication via Hash)
CREATE OR REPLACE FUNCTION upsert_open_brain(
  p_agent_id TEXT,
  p_content TEXT,
  p_thought_type TEXT DEFAULT 'observation'
)
RETURNS JSONB AS $$
DECLARE
  v_hash TEXT;
  v_id UUID;
BEGIN
  v_hash := encode(sha256(convert_to(lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))), 'UTF8')), 'hex');

  INSERT INTO open_brain (agent_id, content, thought_type, content_hash)
  VALUES (p_agent_id, p_content, p_thought_type, v_hash)
  ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO UPDATE
  SET updated_at = now(),
      thought_type = EXCLUDED.thought_type
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'hash', v_hash);
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────
-- GRANTS
-- ─────────────────────────────────────────────────────────────
GRANT ALL ON TABLE public.nexus_chat TO anon;
GRANT ALL ON TABLE public.open_brain TO anon;
GRANT ALL ON TABLE public.agent_workspace TO anon;
GRANT ALL ON SEQUENCE nexus_chat_id_seq TO anon;
GRANT EXECUTE ON FUNCTION hybrid_search_open_brain TO anon;
GRANT EXECUTE ON FUNCTION upsert_open_brain TO anon;
