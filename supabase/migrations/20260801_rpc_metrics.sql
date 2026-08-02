-- ==============================================================================
-- DATABASE v2: Historical RPC Metrics Logging Table
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.rpc_metrics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz DEFAULT now(),
    rpc_name text NOT NULL,
    latency_ms numeric NOT NULL,
    rows_affected integer DEFAULT 0,
    lock_wait_ms numeric DEFAULT 0,
    success boolean NOT NULL,
    error_code text,
    user_id uuid
);

-- Index for temporal metrics querying
CREATE INDEX IF NOT EXISTS idx_rpc_metrics_time ON public.rpc_metrics(created_at, rpc_name);
