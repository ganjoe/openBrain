-- Tabelle für historische und aktuelle Wechselkurse
CREATE TABLE IF NOT EXISTS exchange_rates (
  date DATE NOT NULL,
  base_currency TEXT NOT NULL,
  target_currency TEXT NOT NULL,
  rate NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (date, base_currency, target_currency)
);

-- Indizes für schnelle Abfragen
CREATE INDEX IF NOT EXISTS idx_exchange_rates_date ON exchange_rates(date);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_target ON exchange_rates(target_currency);

-- Berechtigungen
GRANT ALL ON TABLE public.exchange_rates TO anon;
GRANT ALL ON TABLE public.exchange_rates TO service_role;
