-- ==============================================================================
-- MIGRATION: Add idempotency_key to orders table
-- Date: 2026-08-01
-- ==============================================================================
-- Prevents duplicate order execution on network retries.
-- The column is nullable (legacy orders won't have it) with a unique constraint
-- on non-null values.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key 
  ON public.orders (idempotency_key) 
  WHERE idempotency_key IS NOT NULL;
