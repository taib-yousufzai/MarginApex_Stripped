-- ----------------------------------------------------
-- Migration: Add Performance Indexes to instruments Table
-- Target Column: tradingsymbol, name, instrument_token
-- ----------------------------------------------------

-- 1. Index on tradingsymbol for exact lookups
CREATE INDEX IF NOT EXISTS idx_instruments_tradingsymbol 
  ON public.instruments(tradingsymbol);

-- 2. Index on name for commodity/index name filtering
CREATE INDEX IF NOT EXISTS idx_instruments_name 
  ON public.instruments(name);

-- 3. Index on instrument_token for token-to-symbol resolution
CREATE INDEX IF NOT EXISTS idx_instruments_token 
  ON public.instruments(instrument_token);

-- 4. Index on exchange for composite queries
CREATE INDEX IF NOT EXISTS idx_instruments_exchange 
  ON public.instruments(exchange);
