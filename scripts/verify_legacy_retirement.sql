-- ==============================================================================
-- LEGACY RETIREMENT VERIFICATION
-- Run this against production before executing demolition_script.sql.
-- Goal: confirm place_order / process_executed_position have zero runtime
--       invocations over the observation window.
--
-- The v2 write path (ExecutionService) always appends a margin/brokerage
-- suffix to act_log reason: " | Margin Req: ₹X | Bkg: ₹X | Buf: ₹X"
-- Any act_log entry of type ORDER_EXECUTION / ORDER_PLACED *without* that
-- suffix was written by the legacy place_order -> process_executed_position
-- path and indicates the old RPC is still being called.
-- ==============================================================================

-- ─── 1. Legacy invocation check via act_logs (last 72 hours) ─────────────────
-- Expected result: 0 rows. Any rows here = legacy path still active.
SELECT
    id,
    created_at,
    user_id,
    type,
    symbol,
    reason
FROM public.act_logs
WHERE type IN ('ORDER_EXECUTION', 'ORDER_PLACED')
  AND reason NOT LIKE '%Margin Req%'
  AND created_at >= now() - interval '72 hours'
ORDER BY created_at DESC;

-- ─── 2. Hourly legacy invocation count (last 7 days) ─────────────────────────
-- Shows trend. Should be all zeros for >= 72 hours before demolition.
SELECT
    date_trunc('hour', created_at) AS hour,
    count(*) AS legacy_invocations
FROM public.act_logs
WHERE type IN ('ORDER_EXECUTION', 'ORDER_PLACED')
  AND reason NOT LIKE '%Margin Req%'
  AND created_at >= now() - interval '7 days'
GROUP BY hour
ORDER BY hour DESC;

-- ─── 3. Confirm legacy functions still exist (pre-demolition check) ──────────
-- These should return rows before demolition; zero rows after.
SELECT
    p.proname AS function_name,
    p.pronargs AS arg_count
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('place_order', 'process_executed_position', 'close_position')
ORDER BY p.proname;

-- ─── 4. Legacy trigger check ─────────────────────────────────────────────────
-- These triggers should not exist after demolition.
SELECT
    trigger_name,
    event_object_table AS table_name,
    action_timing,
    event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND trigger_name IN (
      'trg_order_executed_update',
      'positions_calculate_margin',
      'positions_margin_debit'
  );

-- ─── 5. Financial reconciliation spot-check ──────────────────────────────────
-- Any non-zero ledger_discrepancy must be resolved before demolition.
SELECT
    user_id,
    client_id,
    current_balance,
    transaction_ledger_sum,
    ledger_discrepancy,
    total_locked_margin
FROM public.v_telemetry_financial_recon
WHERE abs(ledger_discrepancy) > 1.0
ORDER BY abs(ledger_discrepancy) DESC
LIMIT 20;
