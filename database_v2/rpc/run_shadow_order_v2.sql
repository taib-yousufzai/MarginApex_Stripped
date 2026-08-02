-- ==============================================================================
-- DATABASE v2: run_shadow_order_v2 (Shadow Mode Rollback Runner)
-- Runs place_order_v2 transactionally and rolls it back, returning financial state.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.run_shadow_order_v2(
  p_user_id        uuid,
  p_symbol         text,
  p_kite_inst      text,
  p_segment        text,
  p_side           text,
  p_order_type     text,
  p_product_type   text,
  p_qty            numeric,
  p_lots           numeric,
  p_ltp            numeric,
  p_fill_price     numeric,
  p_is_exit        boolean,
  p_buffer_fee     numeric,
  p_status         text,
  p_trigger_price  numeric DEFAULT NULL,
  p_stop_loss      numeric DEFAULT NULL,
  p_target         numeric DEFAULT NULL,
  p_info           text DEFAULT NULL,
  p_expected_margin numeric DEFAULT 0,
  p_expected_brokerage numeric DEFAULT 0,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_res_json jsonb;
    v_order_id uuid;
BEGIN
    -- Force app.is_v2 config to be true for this block
    PERFORM set_config('app.is_v2', 'true', true);

    BEGIN
        -- 1. Call place_order_v2 inside a nested subtransaction block
        v_order_id := public.place_order_v2(
            p_user_id, p_symbol, p_kite_inst, p_segment, p_side,
            p_order_type, p_product_type, p_qty, p_lots, p_ltp, p_fill_price,
            p_is_exit, p_buffer_fee, p_status, p_trigger_price, p_stop_loss,
            p_target, p_info, p_expected_margin, p_expected_brokerage, p_idempotency_key
        );

        -- 2. Gather financial outcomes after the execution (before rollback)
        SELECT jsonb_build_object(
            'balance', (SELECT balance FROM public.profiles WHERE id = p_user_id),
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
                WHERE user_id = p_user_id AND status = 'open'
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
                WHERE user_id = p_user_id AND created_at >= (now() - interval '2 seconds')
            )
        ) INTO v_res_json;

        -- 3. Raise special exception to rollback all database inserts/updates
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

REVOKE EXECUTE ON FUNCTION public.run_shadow_order_v2 FROM public;
