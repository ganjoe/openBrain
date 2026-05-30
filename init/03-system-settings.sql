-- 03-system-settings.sql
-- Table for persisting system-wide configuration (e.g. LLM providers per agent)

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Function to auto-update the updated_at column
CREATE OR REPLACE FUNCTION update_system_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger
DROP TRIGGER IF EXISTS trg_system_settings_updated_at ON system_settings;
CREATE TRIGGER trg_system_settings_updated_at
BEFORE UPDATE ON system_settings
FOR EACH ROW
EXECUTE FUNCTION update_system_settings_updated_at();

-- Initial Data: Default all agents to local
INSERT INTO system_settings (key, value) 
VALUES ('provider_config', '{"ea": "local", "cco": "local", "pca": "local"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Grants
GRANT ALL ON TABLE public.system_settings TO anon;
GRANT ALL ON TABLE public.system_settings TO service_role;
