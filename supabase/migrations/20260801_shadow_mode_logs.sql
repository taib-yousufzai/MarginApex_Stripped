-- ==============================================================================
-- DATABASE v2: Shadow Mode Mismatch Logs & Stats
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.shadow_mismatch_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id text NOT NULL UNIQUE,
    order_id uuid,
    payload jsonb NOT NULL,
    legacy_output jsonb NOT NULL,
    v2_output jsonb NOT NULL,
    diff jsonb NOT NULL,
    created_at timestamptz DEFAULT now()
);

-- Index for correlation_id lookup
CREATE INDEX IF NOT EXISTS idx_shadow_mismatch_corr ON public.shadow_mismatch_logs(correlation_id);

-- Shadow Mode state and stats tracking table
CREATE TABLE IF NOT EXISTS public.shadow_mode_config (
    id integer PRIMARY KEY DEFAULT 1,
    enabled boolean DEFAULT true,
    mismatch_count integer DEFAULT 0,
    total_runs integer DEFAULT 0,
    max_mismatch_rate numeric DEFAULT 0.01, -- 1% threshold
    updated_at timestamptz DEFAULT now()
);

INSERT INTO public.shadow_mode_config (id, enabled, mismatch_count, total_runs, max_mismatch_rate)
VALUES (1, true, 0, 0, 0.01)
ON CONFLICT (id) DO NOTHING;
