-- ==============================================================================
-- MIGRATION: Action Logs (Audit Trail)
-- Date: 2026-07-31
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.action_logs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at timestamptz DEFAULT now() NOT NULL,
    user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    username text,
    role text,
    session_id text,
    ip_address text,
    user_agent text,
    device text,
    browser text,
    platform text,
    action_type text NOT NULL,
    module text NOT NULL,
    api_endpoint text,
    http_method text,
    request_payload jsonb,
    response_status integer,
    is_success boolean DEFAULT true NOT NULL,
    error_message text,
    stack_trace text,
    trade_id uuid,
    order_id uuid,
    position_id uuid,
    wallet_before numeric(20, 2),
    wallet_after numeric(20, 2),
    margin_before numeric(20, 2),
    margin_after numeric(20, 2),
    metadata jsonb
);

CREATE INDEX IF NOT EXISTS action_logs_created_at_idx ON public.action_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS action_logs_user_id_idx ON public.action_logs (user_id);
CREATE INDEX IF NOT EXISTS action_logs_action_type_idx ON public.action_logs (action_type);
CREATE INDEX IF NOT EXISTS action_logs_module_idx ON public.action_logs (module);
CREATE INDEX IF NOT EXISTS action_logs_ip_address_idx ON public.action_logs (ip_address);
CREATE INDEX IF NOT EXISTS action_logs_trade_id_idx ON public.action_logs (trade_id);
CREATE INDEX IF NOT EXISTS action_logs_order_id_idx ON public.action_logs (order_id);
CREATE INDEX IF NOT EXISTS action_logs_position_id_idx ON public.action_logs (position_id);

-- RLS Policies
ALTER TABLE public.action_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Super Admins can view all action logs" ON public.action_logs;
DROP POLICY IF EXISTS "Users can insert action logs" ON public.action_logs;

CREATE POLICY "Super Admins can view all action logs" ON public.action_logs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid() AND (profiles.role = 'super_admin' OR profiles.role = 'admin')
        )
    );

-- Ensure columns are updated to numeric(20,2) if the table was previously created with (15,2)
ALTER TABLE public.action_logs ALTER COLUMN wallet_before TYPE numeric(20, 2);
ALTER TABLE public.action_logs ALTER COLUMN wallet_after TYPE numeric(20, 2);
ALTER TABLE public.action_logs ALTER COLUMN margin_before TYPE numeric(20, 2);
ALTER TABLE public.action_logs ALTER COLUMN margin_after TYPE numeric(20, 2);