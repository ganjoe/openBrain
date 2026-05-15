SET search_path = public, extensions;

-- Pure Semantic Search (No Text Fallback)
CREATE OR REPLACE FUNCTION semantic_search_workspace(
  query_embedding vector(4096),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 200,
  p_agent_id text DEFAULT NULL,
  p_artifact_type text DEFAULT NULL,
  p_days_back int DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  agent_id text,
  artifact_type text,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
LANGUAGE plpgsql SET search_path = public, extensions AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.agent_id, t.artifact_type, t.content, t.metadata,
    1 - (t.embedding <=> query_embedding)::float AS similarity,
    t.created_at
  FROM agent_workspace t
  WHERE (p_agent_id IS NULL OR t.agent_id = p_agent_id)
    AND (p_artifact_type IS NULL OR t.artifact_type = p_artifact_type)
    AND (p_days_back IS NULL OR t.created_at >= NOW() - (p_days_back || ' days')::interval)
    AND (1 - (t.embedding <=> query_embedding) > match_threshold)
  ORDER BY similarity DESC NULLS LAST, t.created_at DESC
  LIMIT match_count;
END;
$$;

-- Exact Keyword Search (JSONB Native)
CREATE OR REPLACE FUNCTION exact_search_workspace(
  p_exact_keyword text,
  match_count int DEFAULT 200,
  p_agent_id text DEFAULT NULL,
  p_artifact_type text DEFAULT NULL,
  p_days_back int DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  agent_id text,
  artifact_type text,
  content text,
  metadata jsonb,
  created_at timestamptz
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.agent_id, t.artifact_type, t.content, t.metadata, t.created_at
  FROM agent_workspace t
  WHERE (p_agent_id IS NULL OR t.agent_id = p_agent_id)
    AND (p_artifact_type IS NULL OR t.artifact_type = p_artifact_type)
    AND (p_days_back IS NULL OR t.created_at >= NOW() - (p_days_back || ' days')::interval)
    AND (
      t.metadata->'tickers' @> to_jsonb(p_exact_keyword)
      OR t.metadata->'keywords' @> to_jsonb(p_exact_keyword)
      OR t.metadata->'topics' @> to_jsonb(p_exact_keyword)
      OR UPPER(t.metadata->>'author') = UPPER(p_exact_keyword)
    )
  ORDER BY t.created_at DESC
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION semantic_search_workspace(vector, float, int, text, text, int) TO anon;
GRANT EXECUTE ON FUNCTION exact_search_workspace(text, int, text, text, int) TO anon;
GRANT EXECUTE ON FUNCTION semantic_search_workspace(vector, float, int, text, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION exact_search_workspace(text, int, text, text, int) TO service_role;
