-- ==============================================================================
-- DATABASE v2: place_order_v2
-- Synchronous Financial Transaction Block routing into the Position Engine.
-- Uses FIFO (First-In, First-Out) lot selection for cumulative exits.
-- ==============================================================================

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
  p_expected_brokerage numeric DEFAULT 0,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_order_id uuid;
    v_profile_balance numeric;
    v_position_id uuid;
    v_pos RECORD;
    v_pos_qty_open numeric;
    v_pos_side text;
    v_remaining_qty numeric;
    v_closed_qty numeric;
BEGIN
    -- ISOLATE V1 TRIGGERS (Strangler Fig)
    PERFORM set_config('app.is_v2', 'true', true);

    -- IDEMPOTENCY CHECK: If this exact request was already processed, return the existing order (Scoped to user)
    IF p_idempotency_key IS NOT NULL THEN
        SELECT id INTO v_order_id 
        FROM public.orders 
        WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key
        LIMIT 1;
        IF FOUND THEN
            RETURN v_order_id;
        END IF;
    END IF;

    -- STEP 1: VALIDATE MARGIN (Calculate vs Validate Rule)
    SELECT balance INTO v_profile_balance
    FROM public.profiles
    WHERE id = p_user_id FOR UPDATE;

    IF v_profile_balance < (p_expected_margin + p_expected_brokerage + p_buffer_fee) AND p_is_exit = false THEN
        RAISE EXCEPTION 'Insufficient balance. Available: %, Required: %', v_profile_balance, (p_expected_margin + p_expected_brokerage + p_buffer_fee);
    END IF;

    -- STEP 2: INSERT ORDER (Gracefully handle concurrent idempotency race conditions)
    BEGIN
        INSERT INTO public.orders (
            user_id, symbol, side, status, qty, price, order_type, info, buffer_fee, idempotency_key
        ) VALUES (
            p_user_id, p_symbol, p_side, p_status, p_qty, p_fill_price, p_order_type, p_info, p_buffer_fee, p_idempotency_key
        ) RETURNING id INTO v_order_id;
    EXCEPTION WHEN unique_violation THEN
        SELECT id INTO v_order_id 
        FROM public.orders 
        WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key
        LIMIT 1;
        
        IF FOUND THEN
            RETURN v_order_id;
        ELSE
            RAISE;
        END IF;
    END;

    -- STEP 3: ROUTE INTO POSITION ENGINE (Only if immediate execution)
    IF p_status = 'EXECUTED' THEN
        -- Find if an open position exists for this symbol
        SELECT id, qty_open, side
        INTO v_position_id, v_pos_qty_open, v_pos_side
        FROM public.positions
        WHERE user_id = p_user_id AND symbol = p_symbol AND status = 'open'
        ORDER BY entry_time DESC
        LIMIT 1
        FOR UPDATE;

        IF NOT FOUND OR v_pos_side = p_side THEN
            -- Lifecycle: Create Position Lot (Same-side additions create separate lots for FIFO)
            PERFORM public.create_position_internal(
                p_user_id, p_symbol, p_side, p_qty, p_fill_price, p_ltp,
                p_product_type, p_segment, p_stop_loss, p_target,
                p_expected_margin, p_expected_margin, p_expected_brokerage
            );

            -- Ledger entries for new position margin
            IF p_expected_margin > 0 THEN
                INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
                VALUES (p_user_id, 'MARGIN_DEBIT', p_expected_margin, 'APPROVED', 'MRG_' || v_order_id::text);
            END IF;

        ELSE
            -- Lifecycle: Opposite-Side Netting/Exiting (FIFO Order Consuming Oldest First)
            v_remaining_qty := p_qty;
            
            FOR v_pos IN 
                SELECT id, qty_open 
                FROM public.positions
                WHERE user_id = p_user_id AND symbol = p_symbol AND status = 'open' AND side = v_pos_side
                ORDER BY entry_time ASC
                FOR UPDATE
            LOOP
                IF v_remaining_qty <= 0 THEN
                    EXIT;
                END IF;

                IF v_pos.qty_open > v_remaining_qty THEN
                    -- Lifecycle: Reduce Position (Partial Close lot)
                    v_closed_qty := v_remaining_qty;
                    PERFORM public.reduce_position_internal(
                        v_pos.id, v_closed_qty, p_fill_price, p_ltp,
                        0, p_idempotency_key || '_' || v_pos.id::text -- unique per lot
                    );
                    v_remaining_qty := 0;
                ELSE
                    -- Lifecycle: Close Position (Full Close lot)
                    v_closed_qty := v_pos.qty_open;
                    PERFORM public.close_position_v2(
                        v_pos.id, v_closed_qty, p_fill_price,
                        'FIFO_EXIT', 0, p_idempotency_key || '_' || v_pos.id::text -- unique per lot
                    );
                    v_remaining_qty := v_remaining_qty - v_closed_qty;
                END IF;
            END LOOP;

            -- Lifecycle: Reverse Position (Create new opposite side position if remaining quantity exists)
            IF v_remaining_qty > 0 THEN
                PERFORM public.create_position_internal(
                    p_user_id, p_symbol, p_side, v_remaining_qty, p_fill_price, p_ltp,
                    p_product_type, p_segment, p_stop_loss, p_target,
                    p_expected_margin, p_expected_margin, p_expected_brokerage
                );

                -- Ledger entries for reversed side entry margin debit
                IF p_expected_margin > 0 THEN
                    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
                    VALUES (p_user_id, 'MARGIN_DEBIT', p_expected_margin, 'APPROVED', 'MRG_' || v_order_id::text);
                END IF;
            END IF;
        END IF;

        -- Write brokerage transaction once at order execution level
        IF p_expected_brokerage > 0 THEN
            INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
            VALUES (p_user_id, 'BROKERAGE_DEBIT', p_expected_brokerage, 'APPROVED', 'BRK_' || v_order_id::text);
        END IF;

        -- Write buffer fee transaction once at order execution level
        IF p_buffer_fee > 0 THEN
            INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
            VALUES (p_user_id, 'BUFFER_FEE_DEBIT', p_buffer_fee, 'APPROVED', 'BUF_' || v_order_id::text);
        END IF;
    END IF;

    RETURN v_order_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.place_order_v2 FROM public;
