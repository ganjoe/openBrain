-- 07-x-first-mentions.sql
-- Pre-computed First Mention tracking table and optimized RPC lookup
SET search_path = public, extensions;

-- 1. Table structure for per-influencer ticker first mentions
CREATE TABLE IF NOT EXISTS x_first_mentions (
  ticker             TEXT NOT NULL,
  author             TEXT NOT NULL,
  first_mentioned_at TIMESTAMPTZ NOT NULL,
  post_id            UUID NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ticker, author)
);

CREATE INDEX IF NOT EXISTS idx_x_first_mentions_ticker ON x_first_mentions (ticker);
CREATE INDEX IF NOT EXISTS idx_x_first_mentions_author ON x_first_mentions (author);
CREATE INDEX IF NOT EXISTS idx_x_first_mentions_date ON x_first_mentions (first_mentioned_at DESC);

-- 2. Initial backfill from existing agent_workspace posts
INSERT INTO x_first_mentions (ticker, author, first_mentioned_at, post_id)
WITH expanded AS (
  SELECT
    t.id AS post_id,
    LOWER(t.metadata->>'author') AS author,
    (t.metadata->>'published_at')::timestamptz AS published_at,
    UPPER(ticker_text) AS ticker
  FROM agent_workspace t,
  jsonb_array_elements_text(t.metadata->'tickers') AS ticker_text
  WHERE t.artifact_type = 'x_post'
    AND t.metadata->>'published_at' IS NOT NULL
),
first_mentions AS (
  SELECT DISTINCT ON (e.ticker, e.author)
    e.ticker,
    e.author,
    e.published_at AS first_mentioned_at,
    e.post_id
  FROM expanded e
  ORDER BY e.ticker, e.author, e.published_at ASC
)
SELECT ticker, author, first_mentioned_at, post_id
FROM first_mentions
ON CONFLICT (ticker, author) DO UPDATE 
SET first_mentioned_at = EXCLUDED.first_mentioned_at,
    post_id = EXCLUDED.post_id
WHERE EXCLUDED.first_mentioned_at < x_first_mentions.first_mentioned_at;

-- 3. Optimized query RPC for discover_ticker_mentions tool
CREATE OR REPLACE FUNCTION get_first_mentions_v2(
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
  SELECT 
    fm.ticker AS keyword,
    fm.first_mentioned_at,
    fm.author,
    w.content AS post_content,
    fm.post_id
  FROM x_first_mentions fm
  JOIN agent_workspace w ON w.id = fm.post_id
  WHERE (p_keywords IS NULL OR array_length(p_keywords, 1) IS NULL OR UPPER(fm.ticker) = ANY(
    SELECT UPPER(regexp_replace(k, '^[$#]', '')) FROM unnest(p_keywords) k
  ))
    AND (p_authors IS NULL OR array_length(p_authors, 1) IS NULL OR LOWER(fm.author) = ANY(
      SELECT LOWER(CASE WHEN a LIKE '@%' THEN a ELSE '@' || a END) FROM unnest(p_authors) a
    ))
    AND (p_start_date IS NULL OR fm.first_mentioned_at >= p_start_date)
  ORDER BY fm.first_mentioned_at DESC
  LIMIT p_limit;
END;
$$;

-- 4. Grants
GRANT ALL ON TABLE public.x_first_mentions TO anon;
GRANT ALL ON TABLE public.x_first_mentions TO service_role;
GRANT EXECUTE ON FUNCTION get_first_mentions_v2 TO anon;
GRANT EXECUTE ON FUNCTION get_first_mentions_v2 TO service_role;
