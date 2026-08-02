-- ==============================================================================
-- Add correlation_id and engine_version columns to rpc_metrics.
-- correlation_id links a single EngineClient call across logs, journal, and
-- telemetry views. engine_version / contract_version let you slice metrics
-- by engine release when multiple versions coexist during staged rollout.
-- ==============================================================================

ALTER TABLE public.rpc_metrics
    ADD COLUMN IF NOT EXISTS correlation_id  text,
    ADD COLUMN IF NOT EXISTS engine_version  text,
    ADD COLUMN IF NOT EXISTS contract_version text;

-- Index for correlation_id lookups (incident investigation path)
CREATE INDEX IF NOT EXISTS idx_rpc_metrics_correlation
    ON public.rpc_metrics(correlation_id)
    WHERE correlation_id IS NOT NULL;
