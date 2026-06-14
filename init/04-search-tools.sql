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
  p_exact_keyword text DEFAULT NULL,
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
      p_exact_keyword IS NULL 
      OR p_exact_keyword = '' 
      OR t.metadata->'tickers' @> to_jsonb(p_exact_keyword)
      OR t.metadata->'keywords' @> to_jsonb(p_exact_keyword)
      OR t.metadata->'topics' @> to_jsonb(p_exact_keyword)
      OR UPPER(t.metadata->>'author') = UPPER(p_exact_keyword)
      OR t.content ILIKE '%' || p_exact_keyword || '%'
    )
  ORDER BY t.created_at DESC
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION semantic_search_workspace(vector, float, int, text, text, int) TO anon;
GRANT EXECUTE ON FUNCTION exact_search_workspace(text, int, text, text, int) TO anon;
GRANT EXECUTE ON FUNCTION semantic_search_workspace(vector, float, int, text, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION exact_search_workspace(text, int, text, text, int) TO service_role;

-- Consolidated First Mentions & Discovery
CREATE OR REPLACE FUNCTION discover_first_mentions(
  p_keywords text[] DEFAULT NULL,
  p_authors text[] DEFAULT NULL,
  p_start_date timestamptz DEFAULT NULL,
  p_limit int DEFAULT 10
)
RETURNS TABLE (
  keyword text,
  first_mentioned_at timestamptz,
  author text,
  post_content text,
  post_id uuid
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH source_data AS (
    SELECT 
      p.id AS post_id,
      p.content,
      p.created_at,
      p.metadata->>'author' AS author,
      (p.metadata->>'published_at')::timestamptz AS published_at,
      p.metadata->'tickers' AS tickers
    FROM agent_workspace p
    WHERE p.artifact_type = 'x_post'
      AND p.metadata->>'published_at' IS NOT NULL
      AND (p_authors IS NULL OR array_length(p_authors, 1) IS NULL OR LOWER(p.metadata->>'author') = ANY(p_authors))
  ),
  keyword_matches AS (
    SELECT 
      k.keyword,
      s.post_id,
      s.content,
      s.author,
      s.published_at
    FROM source_data s
    -- Cross Join with provided keywords OR extracted metadata tickers
    CROSS JOIN LATERAL (
      SELECT k_val AS keyword FROM (
        SELECT jsonb_array_elements_text(s.tickers) AS k_val
        WHERE p_keywords IS NULL OR array_length(p_keywords, 1) IS NULL
        UNION ALL
        SELECT unnest(p_keywords) AS k_val
        WHERE p_keywords IS NOT NULL AND array_length(p_keywords, 1) IS NOT NULL
      ) sub
    ) AS k
    WHERE 
      -- If discovery mode, the keyword is already from the row's tickers
      (p_keywords IS NULL OR array_length(p_keywords, 1) IS NULL)
      -- If keyword mode, check if the keyword matches (using word boundaries or JSON array)
      OR (
        s.content ~* ('\m' || regexp_replace(k.keyword, '^[$#]', '') || '\M')
        OR s.tickers @> to_jsonb(k.keyword)
        OR s.tickers @> to_jsonb(regexp_replace(k.keyword, '^[$#]', ''))
      )
  ),
  first_mentions AS (
    SELECT DISTINCT ON (m.keyword)
      m.keyword,
      m.published_at,
      m.author,
      m.content,
      m.post_id
    FROM keyword_matches m
    ORDER BY m.keyword, m.published_at ASC
  )
  SELECT
    fm.keyword,
    fm.published_at,
    fm.author,
    fm.content,
    fm.post_id
  FROM first_mentions fm
  WHERE p_start_date IS NULL OR fm.published_at >= p_start_date
  ORDER BY fm.published_at DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION discover_first_mentions(text[], text[], timestamptz, int) TO anon;
GRANT EXECUTE ON FUNCTION discover_first_mentions(text[], text[], timestamptz, int) TO service_role;

-- Drop the old function
DROP FUNCTION IF EXISTS find_first_keyword_mentions(text[], text[], int);
