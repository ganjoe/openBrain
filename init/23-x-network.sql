-- 23-x-network.sql
-- Influencer Network Graph: Speichert die Following-Listen aller überwachten Influencer
-- für Netzwerkanalyse (Wer folgt wem, Cluster-Erkennung, Influencer-Vorschläge)
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS x_follows (
  source_username  TEXT NOT NULL,          -- Unser überwachter Influencer (FK → x_users.username)
  target_x_id      TEXT NOT NULL,          -- X-ID des gefolgten Profils
  target_username  TEXT NOT NULL,          -- Username des gefolgten Profils
  target_name      TEXT,                   -- Anzeigename
  target_bio       TEXT,                   -- Profil-Biografie (gekürzt)
  target_followers INTEGER,               -- Follower-Anzahl des Zielprofils
  target_following INTEGER,               -- Following-Anzahl des Zielprofils
  target_tweets    INTEGER,               -- Tweet-Anzahl des Zielprofils
  target_verified  BOOLEAN DEFAULT FALSE,
  synced_at        TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (source_username, target_x_id)
);

-- Reverse-Lookup Index (auskommentiert — bei Bedarf aktivieren für „Wer folgt diesem Account?"-Queries)
-- CREATE INDEX IF NOT EXISTS idx_x_follows_target ON x_follows (target_username);

-- PostgREST Grants
GRANT ALL ON TABLE public.x_follows TO anon;
GRANT ALL ON TABLE public.x_follows TO service_role;
