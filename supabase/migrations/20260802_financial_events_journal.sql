-- ==============================================================================
-- Financial Event Journal
--
-- Append-only operational audit trail for debugging, incident post-mortems,
-- and timeline reconstruction. This is NOT the accounting ledger — that is
-- the transactions table. This table records named business events with
-- enough context to answer "what happened and when" without touching the
-- ledger or position tables.
--
-- Design constraints:
--  - Append-only: no UPDATE, no DELETE (enforced by RLS policy below).
--  - Written asynchronously from EngineClient after RPC success — never
--    inside a financial transaction, never able to affect trade execution.
--  - A missing event is acceptable; a journal write blocking a trade is not.
--  - correlation_id links this event to rpc_metrics, act_logs, and order IDs.
--
-- Example event_type values (not exhaustive):
--   ORDER_PLACED, ORDER_REJECTED, POSITION_OPENED, POSITION_REDUCED,
--   POSITION_CLOSED, CARRY_CHARGED, POSITION_CONVERTED, ROLLOVER_COMPLETED,
--   LIQUIDATION_TRIGGERED, MARGIN_CALL_ISSUED
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.financial_events (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at       timestamptz NOT NULL DEFAULT now(),
    event_type       text        NOT NULL,
    correlation_id   text        NOT NULL,
    user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    engine_version   text        NOT NULL,
    contract_version text        NOT NULL,
    -- Flexible payload: caller decides what context is relevant per event type
    payload          jsonb       NOT NULL DEFAULT '{}'
);

-- Lookup by correlation_id (primary investigation path — links to rpc_metrics)
CREATE INDEX IF NOT EXISTS idx_financial_events_correlation
    ON public.financial_events(correlation_id);

-- Lookup by user + time (user timeline reconstruction)
CREATE INDEX IF NOT EXISTS idx_financial_events_user_time
    ON public.financial_events(user_id, created_at DESC);

-- Lookup by event type + time (aggregate analysis, e.g. all LIQUIDATION events)
CREATE INDEX IF NOT EXISTS idx_financial_events_type_time
    ON public.financial_events(event_type, created_at DESC);

-- ─── Append-only enforcement ──────────────────────────────────────────────────
-- service_role can INSERT but not UPDATE or DELETE.
-- This is intentional: the journal is tamper-evident by design.
--
-- Immutability is enforced with hard errors, not silent no-ops.
-- If something attempts to UPDATE or DELETE a journal row it receives an
-- exception immediately — a failing write is detectable; a silently ignored
-- one is not.

ALTER TABLE public.financial_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS financial_events_insert_only ON public.financial_events;
CREATE POLICY financial_events_insert_only
    ON public.financial_events
    FOR INSERT
    TO service_role
    WITH CHECK (true);

-- Hard-deny UPDATE: raise an error instead of silently ignoring the attempt
CREATE OR REPLACE FUNCTION public.financial_events_deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'financial_events is append-only. UPDATE and DELETE are not permitted.';
END;
$$;

DROP TRIGGER IF EXISTS financial_events_deny_update ON public.financial_events;
CREATE TRIGGER financial_events_deny_update
    BEFORE UPDATE ON public.financial_events
    FOR EACH ROW EXECUTE FUNCTION public.financial_events_deny_mutation();

DROP TRIGGER IF EXISTS financial_events_deny_delete ON public.financial_events;
CREATE TRIGGER financial_events_deny_delete
    BEFORE DELETE ON public.financial_events
    FOR EACH ROW EXECUTE FUNCTION public.financial_events_deny_mutation();
