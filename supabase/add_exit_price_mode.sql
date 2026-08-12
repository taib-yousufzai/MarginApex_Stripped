ALTER TABLE public.segment_settings
  ADD COLUMN IF NOT EXISTS exit_price_mode text NOT NULL DEFAULT 'BID_ASK'
  CHECK (exit_price_mode IN ('BID_ASK', 'LTP'));

ALTER TABLE public.scalper_segment_settings
  ADD COLUMN IF NOT EXISTS exit_price_mode text NOT NULL DEFAULT 'BID_ASK'
  CHECK (exit_price_mode IN ('BID_ASK', 'LTP'));
