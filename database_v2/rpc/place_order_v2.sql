-- ==============================================================================
-- MIGRATION: place_order_v2 (Synchronous Financial Transaction Block)
-- Date: 2026-07-31
-- ==============================================================================

-- 1. Create the new transactional RPC
CREATE OR REPLACE FUNCTION public.place_order_v2(
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
  p_expected_brokerage numeric DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_order_id uuid;
    v_profile_balance numeric;
    v_position_id uuid;
    v_new_qty_open numeric;
    v_new_qty_total numeric;
    v_new_avg_price numeric;
BEGIN
    -- ISOLATE V1 TRIGGERS (Strangler Fig)
    PERFORM set_config('app.is_v2', 'true', true);

    -- STEP 1: VALIDATE MARGIN (Calculate vs Validate Rule)
    SELECT balance INTO v_profile_balance
    FROM public.profiles
    WHERE id = p_user_id FOR UPDATE;

    IF v_profile_balance < (p_expected_margin + p_expected_brokerage + p_buffer_fee) AND p_is_exit = false THEN
        RAISE EXCEPTION 'Insufficient balance. Available: %, Required: %', v_profile_balance, (p_expected_margin + p_expected_brokerage + p_buffer_fee);
    END IF;

    -- STEP 2: INSERT ORDER
    INSERT INTO public.orders (
        user_id, symbol, side, status, qty, price, order_type, info, buffer_fee
    ) VALUES (
        p_user_id, p_symbol, p_side, p_status, p_qty, p_fill_price, p_order_type, p_info, p_buffer_fee
    ) RETURNING id INTO v_order_id;

    -- STEP 3 & 4: UPSERT POSITION AND LEDGER (Only if immediate execution)
    IF p_status = 'EXECUTED' THEN
        
        -- See if position exists
        SELECT id, qty_open, qty_total, avg_price 
        INTO v_position_id, v_new_qty_open, v_new_qty_total, v_new_avg_price
        FROM public.positions
        WHERE user_id = p_user_id AND symbol = p_symbol AND status = 'open'
        FOR UPDATE;

        IF FOUND THEN
            -- Average it (Simplified logic for now to assume averaging)
            v_new_qty_total := v_new_qty_total + p_qty;
            v_new_qty_open := v_new_qty_open + p_qty;
            v_new_avg_price := ((v_new_avg_price * (v_new_qty_open - p_qty)) + (p_fill_price * p_qty)) / v_new_qty_open;

            UPDATE public.positions
            SET qty_open = v_new_qty_open,
                qty_total = v_new_qty_total,
                avg_price = v_new_avg_price,
                ltp = p_ltp,
                updated_at = now()
            WHERE id = v_position_id;
        ELSE
            -- New position
            INSERT INTO public.positions (
                user_id, symbol, side, status, qty_open, qty_total, avg_price, entry_price, ltp
            ) VALUES (
                p_user_id, p_symbol, p_side, 'open', p_qty, p_qty, p_fill_price, p_fill_price, p_ltp
            ) RETURNING id INTO v_position_id;
        END IF;

        -- STEP 4: WRITE TO LEDGER
        IF p_expected_margin > 0 THEN
            INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
            VALUES (p_user_id, 'MARGIN_DEBIT', p_expected_margin, 'APPROVED', 'MRG_' || v_order_id);
        END IF;

        IF p_expected_brokerage > 0 THEN
            INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
            VALUES (p_user_id, 'BROKERAGE_DEBIT', p_expected_brokerage, 'APPROVED', 'BRK_' || v_order_id);
        END IF;

        IF p_buffer_fee > 0 THEN
            INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
            VALUES (p_user_id, 'BUFFER_FEE_DEBIT', p_buffer_fee, 'APPROVED', 'BUF_' || v_order_id);
        END IF;

        -- STEP 5: DEDUCT PROFILE BALANCE
        -- The sync_profile_balance trigger on transactions handles the actual profile deduction for these types.
        -- We rely on that trigger (passive consistency) rather than manual deduction to prevent double-spending.
        -- Wait, the user said "passive consistency is fine". We will let the transactions trigger handle profile updates.

    END IF;

    RETURN v_order_id;
END;
$$;


