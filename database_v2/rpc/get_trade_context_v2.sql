-- Migration: Create get_trade_context_v1 RPC and add performance indexes

-- 1. Create optimized trade context fetching RPC
CREATE OR REPLACE FUNCTION get_trade_context_v1(p_user_id UUID, p_symbols TEXT[])
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
    v_profile JSON;
    v_positions JSON;
    v_orders JSON;
    v_instruments JSON;
    v_script_settings JSON;
    v_is_blocked JSON;
BEGIN
    -- Fetch Profile
    SELECT json_build_object(
        'id', id,
        'active', active,
        'read_only', read_only,
        'segments', segments,
        'parent_id', parent_id,
        'balance', balance,
        'trading_mode', trading_mode,
        'template_id', template_id
    ) INTO v_profile
    FROM public.profiles
    WHERE id = p_user_id;

    -- Fetch Open Positions
    SELECT COALESCE(json_agg(row_to_json(p)), '[]'::json) INTO v_positions
    FROM public.positions p
    WHERE p.user_id = p_user_id 
      AND p.status IN ('open', 'OPEN', 'active', 'ACTIVE');

    -- Fetch Pending Orders
    SELECT COALESCE(json_agg(row_to_json(o)), '[]'::json) INTO v_orders
    FROM public.orders o
    WHERE o.user_id = p_user_id 
      AND o.status = 'PENDING';

    -- Fetch Instruments
    -- Use ILIKE for case-insensitive matching
    SELECT COALESCE(json_agg(json_build_object(
        'name', name,
        'expiry', expiry,
        'lot_size', lot_size,
        'tradingsymbol', tradingsymbol,
        'id', id
    )), '[]'::json) INTO v_instruments
    FROM public.instruments
    WHERE tradingsymbol ILIKE ANY(p_symbols);

    -- Fetch Script Settings
    SELECT COALESCE(json_agg(json_build_object(
        'symbol', symbol,
        'lot_size', lot_size
    )), '[]'::json) INTO v_script_settings
    FROM public.script_settings
    WHERE symbol ILIKE ANY(p_symbols);

    -- Fetch Blocked Scripts List
    SELECT COALESCE(json_agg(json_build_object(
        'symbol', symbol
    )), '[]'::json) INTO v_is_blocked
    FROM public.user_blocked_scripts 
    WHERE user_id = p_user_id 
      AND symbol ILIKE ANY(p_symbols);

    -- Return consolidated JSON payload
    RETURN json_build_object(
        'profile', v_profile,
        'open_positions', v_positions,
        'pending_orders', v_orders,
        'instruments', v_instruments,
        'script_settings', v_script_settings,
        'is_blocked', v_is_blocked
    );
END;
$$;

-- 2. Add composite indexes to support instant execution of the above queries
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON public.orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_instruments_tradingsymbol ON public.instruments(tradingsymbol);
CREATE INDEX IF NOT EXISTS idx_script_settings_symbol ON public.script_settings(symbol);
CREATE INDEX IF NOT EXISTS idx_user_blocked_scripts_user_symbol ON public.user_blocked_scripts(user_id, symbol);
