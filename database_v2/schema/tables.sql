-- ==============================================================================
-- DATABASE v2: PRISTINE SCHEMA (TABLES ONLY)
-- This file defines the core tables for the trading architecture.
-- It strips away historical migration baggage and relies exclusively on
-- the Database Constitution (no hidden workflow triggers).
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  active boolean DEFAULT true,
  role text DEFAULT 'USER',
  balance numeric NOT NULL DEFAULT 0,
  settlement_amount numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
  -- KYC/Personal fields omitted for brevity
);

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side in ('BUY','SELL')),
  status text NOT NULL CHECK (status in ('PENDING','EXECUTED','CANCELLED','REJECTED','FAILED')),
  qty numeric NOT NULL,
  price numeric NOT NULL,
  order_type text NOT NULL CHECK (order_type in ('MARKET','LIMIT','SL','SLM')),
  buffer_fee numeric NOT NULL DEFAULT 0,
  info text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side in ('BUY','SELL')),
  status text NOT NULL CHECK (status in ('open','active','closed')),
  pnl numeric NOT NULL DEFAULT 0,
  qty_open numeric NOT NULL DEFAULT 0,
  qty_total numeric NOT NULL DEFAULT 0,
  avg_price numeric NOT NULL DEFAULT 0,
  entry_price numeric NOT NULL DEFAULT 0,
  ltp numeric,
  exit_price numeric,
  brokerage numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type in (
    'DEPOSIT','WITHDRAWAL',
    'PNL_CREDIT','PNL_DEBIT',
    'BROKERAGE_DEBIT','BUFFER_FEE_DEBIT',
    'MARGIN_ADJ_CREDIT','MARGIN_ADJ_DEBIT',
    'LIQUIDATION_DEBIT',
    'MARGIN_DEBIT', 'MARGIN_CREDIT'
  )),
  amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status in ('APPROVED','PENDING','REJECTED')),
  ref_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.instruments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tradingsymbol text NOT NULL,
  name text,
  segment text,
  exchange text,
  expiry date,
  strike numeric,
  tick_size numeric,
  lot_size numeric,
  instrument_type text
);

CREATE TABLE IF NOT EXISTS public.script_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL UNIQUE,
  lot_size numeric NOT NULL DEFAULT 1,
  brokerage_type text NOT NULL DEFAULT 'PER_CRORE',
  brokerage_value numeric NOT NULL DEFAULT 0,
  margin_type text NOT NULL DEFAULT 'PERCENTAGE',
  margin_value numeric NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS public.user_blocked_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
