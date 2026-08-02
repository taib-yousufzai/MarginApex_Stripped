-- ==============================================================================
-- DATABASE v2: run_shadow_close_v2 (Shadow Mode Rollback Runner for Exits)
-- Runs close_position_v2 transactionally and rolls it back, returning financial state.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.run_shadow_close_v2(
  p_position_id        uuid,
  p_close_qty          numeric,
  p_close_price        numeric,
  p_closed_by          text,
  p_expected_brokerage numeric DEFAULT 0,
  p_idempotency_key    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_res_json jsonb;
    v_user_id uuid;
BEGIN
    -- Force app.is_v2 config to be true for this block
    PERFORM set_config('app.is_v2', 'true', true);

    SELECT user_id INTO v_user_id FROM public.positions WHERE id = p_position_id;

    BEGIN
        -- 1. Call close_position_v2 inside nested transaction block
        PERFORM public.close_position_v2(
            p_position_id, p_close_qty, p_close_price, p_closed_by,
            p_expected_brokerage, p_idempotency_key
        );

        -- 2. Gather financial outcomes after execution (before rollback)
        SELECT jsonb_build_object(
            'balance', (SELECT balance FROM public.profiles WHERE id = v_user_id),
            'positions', (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'symbol', symbol,
                        'side', side,
                        'qty_open', qty_open,
                        'qty_total', qty_total,
                        'avg_price', avg_price,
                        'locked_margin', locked_margin,
                        'margin_required', margin_required,
                        'pnl', pnl,
                        'status', status
                    )
                )
                FROM public.positions
                WHERE user_id = v_user_id AND status = 'open'
            ),
            'ledger_entries', (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'type', type,
                        'amount', amount,
                        'status', status
                    )
                )
                FROM public.transactions
                WHERE user_id = v_user_id AND created_at >= (now() - interval '2 seconds')
            )
        ) INTO v_res_json;

        -- 3. Raise special exception to rollback all database changes
        RAISE EXCEPTION 'SHADOW_MODE_ROLLBACK_INTENTIONAL';

    EXCEPTION
        WHEN OTHERS THEN
            -- Check if it's our intentional rollback exception
            IF SQLERRM = 'SHADOW_MODE_ROLLBACK_INTENTIONAL' THEN
                RETURN v_res_json;
            ELSE
                -- Reraise unexpected errors
                RAISE;
            END IF;
    END;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.run_shadow_close_v2 FROM public;
