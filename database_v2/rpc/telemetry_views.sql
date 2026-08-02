-- ==============================================================================
-- DATABASE v2: Telemetry Views for Position Engine Observability
-- Provides live visibility into database lock contention, financial integrity,
-- RPC latencies, and transaction error rates.
-- ==============================================================================

-- 1. Locking Observability View
CREATE OR REPLACE VIEW public.v_telemetry_locking AS
SELECT
    a.pid AS blocked_pid,
    a.usename AS blocked_user,
    ka.pid AS blocking_pid,
    ka.usename AS blocking_user,
    a.query AS blocked_query,
    ka.query AS blocking_query,
    age(now(), a.query_start) AS wait_duration
FROM pg_catalog.pg_stat_activity a
JOIN pg_catalog.pg_locks l ON a.pid = l.pid AND NOT l.granted
JOIN pg_catalog.pg_locks kl ON kl.locktype = l.locktype
    AND kl.database IS NOT DISTINCT FROM l.database
    AND kl.relation IS NOT DISTINCT FROM l.relation
    AND kl.page IS NOT DISTINCT FROM l.page
    AND kl.tuple IS NOT DISTINCT FROM l.tuple
    AND kl.virtualxid IS NOT DISTINCT FROM l.virtualxid
    AND kl.transactionid IS NOT DISTINCT FROM l.transactionid
    AND kl.classid IS NOT DISTINCT FROM l.classid
    AND kl.objid IS NOT DISTINCT FROM l.objid
    AND kl.objsubid IS NOT DISTINCT FROM l.objsubid
    AND kl.pid != l.pid
JOIN pg_catalog.pg_stat_activity ka ON ka.pid = kl.pid;

-- 2. Financial Integrity / Reconciliation View
CREATE OR REPLACE VIEW public.v_telemetry_financial_recon AS
SELECT
    p.id AS user_id,
    p.client_id,
    p.balance AS current_balance,
    COALESCE(sum(
        CASE 
            WHEN t.type IN ('PNL_CREDIT', 'DEPOSIT') THEN t.amount
            WHEN t.type IN ('PNL_DEBIT', 'BROKERAGE_DEBIT', 'BUFFER_FEE_DEBIT', 'WITHDRAWAL') THEN -t.amount
            ELSE 0 
        END
    ), 0) AS transaction_ledger_sum,
    -- Balance discrepancy calculation
    p.balance - COALESCE(sum(
        CASE 
            WHEN t.type IN ('PNL_CREDIT', 'DEPOSIT') THEN t.amount
            WHEN t.type IN ('PNL_DEBIT', 'BROKERAGE_DEBIT', 'BUFFER_FEE_DEBIT', 'WITHDRAWAL') THEN -t.amount
            ELSE 0 
        END
    ), 0) AS ledger_discrepancy,
    -- Total locked margin
    COALESCE((SELECT sum(locked_margin) FROM public.positions WHERE user_id = p.id AND status = 'open'), 0) AS total_locked_margin
FROM public.profiles p
LEFT JOIN public.transactions t ON t.user_id = p.id AND t.status = 'APPROVED'
GROUP BY p.id, p.client_id, p.balance;

-- 3. Database Index & Scan Efficiency View
CREATE OR REPLACE VIEW public.v_telemetry_db_efficiency AS
SELECT
    schemaname,
    relname AS table_name,
    seq_scan AS sequential_scans,
    idx_scan AS index_scans,
    CASE 
        WHEN (seq_scan + idx_scan) = 0 THEN 0
        ELSE round((idx_scan::numeric / (seq_scan + idx_scan)) * 100, 2)
    END AS index_usage_percentage
FROM pg_stat_user_tables
WHERE schemaname = 'public';

-- 4. Shadow Mode Parity Logs View
CREATE OR REPLACE VIEW public.v_telemetry_shadow_logs AS
SELECT
    correlation_id,
    order_id,
    created_at,
    diff,
    legacy_output->'balance' AS legacy_balance,
    v2_output->'balance' AS v2_balance
FROM public.shadow_mismatch_logs
ORDER BY created_at DESC;
