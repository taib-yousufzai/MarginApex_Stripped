-- Platform-wide key-value settings table
CREATE TABLE IF NOT EXISTS platform_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default values
INSERT INTO platform_settings (key, value)
VALUES
  ('EXIT_PRICE_MODE', 'BID_ASK')
ON CONFLICT (key) DO NOTHING;

-- Allow admin service role full access
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON platform_settings
  FOR ALL USING (true) WITH CHECK (true);
