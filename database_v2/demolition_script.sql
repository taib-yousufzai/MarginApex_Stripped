-- ==============================================================================
-- MIGRATION: Phase D - Demolition of Legacy Architecture
-- Date: 2026-07-31
-- ==============================================================================
-- This migration executes the final phase of the Strangler Fig pattern.
-- All traffic has been successfully migrated to Database v2.
-- We now sever and permanently delete the organic, side-effect trigger chains.

-- 1. Drop the legacy orchestration triggers
DROP TRIGGER IF EXISTS trg_order_executed_update ON public.orders;
DROP TRIGGER IF EXISTS positions_calculate_margin ON public.positions;
DROP TRIGGER IF EXISTS positions_margin_debit ON public.positions;

-- 2. Drop the trigger functions
DROP FUNCTION IF EXISTS public.handle_order_execution();
DROP FUNCTION IF EXISTS public.calculate_position_margin();
DROP FUNCTION IF EXISTS public.position_insert_margin_debit();

-- 3. Drop the legacy orchestration helpers
DROP FUNCTION IF EXISTS public.process_executed_position(uuid);
DROP FUNCTION IF EXISTS public.process_executed_position(uuid, text);

-- 4. Drop the legacy v1 RPC entry points
-- (Note: Dropping overloaded functions requires specifying parameter types, 
-- but since this is a cleanup, we assume exact signatures from v1)
DROP FUNCTION IF EXISTS public.place_order(
  uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, boolean, numeric, text, numeric, numeric, numeric, text
);
DROP FUNCTION IF EXISTS public.close_position(
  uuid, uuid, numeric, numeric, text, numeric
);
