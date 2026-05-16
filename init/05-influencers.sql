-- 05-influencers.sql
-- Expand x_users to act as a full influencer directory
SET search_path = public, extensions;

ALTER TABLE x_users ADD COLUMN IF NOT EXISTS screen_name TEXT;
ALTER TABLE x_users ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE x_users ADD COLUMN IF NOT EXISTS embedding vector(4096);
ALTER TABLE x_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- Create an index for vector similarity search (Removed HNSW due to 4096 dim limit, seq scan is fine for small tables)

-- Hybrid search function for influencers
CREATE OR REPLACE FUNCTION search_influencers(
  query_embedding vector(4096),
  query_text text,
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  username text,
  screen_name text,
  notes text,
  similarity float
)
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT t.username, t.screen_name, t.notes,
    CASE WHEN query_embedding IS NOT NULL 
         THEN 1 - (t.embedding <=> query_embedding)::float 
         ELSE 0.0 END AS similarity
  FROM x_users t
  WHERE t.is_active = TRUE
    AND (
      (query_embedding IS NOT NULL AND 1 - (t.embedding <=> query_embedding) > match_threshold)
      OR t.username ILIKE '%' || query_text || '%'
      OR t.screen_name ILIKE '%' || query_text || '%'
      OR t.notes ILIKE '%' || query_text || '%'
    )
  ORDER BY similarity DESC NULLS LAST
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION search_influencers TO anon;
GRANT EXECUTE ON FUNCTION search_influencers TO service_role;
