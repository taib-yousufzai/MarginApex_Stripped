-- ==============================================================================
-- MIGRATION: Unified Order and Position Execution Logic
-- Date: 2026-07-31
-- ==============================================================================
-- This migration fixes the Limit orders executing immediately bug and addresses
-- ==============================================================================

-- Drop old signatures to prevent Postgres function overloading (creating duplicate functions)
DROP FUNCTION IF EXISTS public.process_executed_position(uuid);
DROP FUNCTION IF EXISTS public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean, numeric);

CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid, p_info text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order record;
  v_pos record;
  v_closed_pos_id uuid;
  v_pnl numeric;
  v_pnl_type text;
  v_remaining_qty numeric;
  v_close_qty numeric;
  v_chunk_brokerage numeric;
  v_closed_entry_brokerage numeric;
  v_closed_brokerage numeric;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status <> 'EXECUTED' THEN
    RAISE EXCEPTION 'Order must be EXECUTED to process positioning';
  END IF;

  IF v_order.fill_price IS NULL THEN
    RAISE EXCEPTION 'EXECUTED order must have fill_price set';
  END IF;

  -- 1. Deduct Brokerage and Buffer Fee (Single Source of Truth)
  IF COALESCE(v_order.brokerage, 0) > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_order.brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  IF COALESCE(v_order.buffer_fee, 0) > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BUFFER_FEE_DEBIT', v_order.buffer_fee, 'APPROVED', 'BUF_' || v_order.id::text);
  END IF;

  -- Defensive Guard
  IF v_order.qty <= 0 THEN
    RAISE EXCEPTION 'Order qty must be > 0 to execute';
  END IF;

  IF v_order.is_exit THEN
    -- 2. EXIT LOGIC
    v_remaining_qty := v_order.qty;

    FOR v_pos IN
      SELECT * 
      FROM public.positions
      WHERE user_id = v_order.user_id 
        AND symbol = v_order.symbol 
        AND status IN ('open', 'active') 
        AND product_type = v_order.product_type
        AND side != v_order.side
        AND (p_info IS NULL OR id::text = p_info)
      ORDER BY entry_time ASC
      FOR UPDATE
    LOOP
      IF v_remaining_qty <= 0 THEN
        EXIT;
      END IF;

      IF v_pos.qty_open <= 0 THEN
        CONTINUE;
      END IF;

      v_close_qty := LEAST(v_remaining_qty, v_pos.qty_open);
      v_chunk_brokerage := (v_order.brokerage * v_close_qty) / v_order.qty;

      -- Calculate realized P&L
      IF v_pos.side = 'BUY' THEN
        v_pnl := (v_order.fill_price - v_pos.entry_price) * v_close_qty;
      ELSE
        v_pnl := (v_pos.entry_price - v_order.fill_price) * v_close_qty;
      END IF;

      IF v_close_qty = v_pos.qty_open THEN
        -- FULL EXIT
        UPDATE public.positions
        SET
          status = 'closed',
          qty_open = 0,
          exit_price = v_order.fill_price,
          exit_time = now(),
          pnl = v_pnl,
          exit_brokerage = exit_brokerage + v_chunk_brokerage,
          brokerage = brokerage + v_chunk_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;

        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        IF v_pnl <> 0 THEN
          INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
          VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);
        END IF;

      ELSE
        -- PARTIAL EXIT: Split position
        v_closed_entry_brokerage := (v_pos.entry_brokerage * v_close_qty) / v_pos.qty_open;
        v_closed_brokerage := (v_pos.brokerage * v_close_qty) / v_pos.qty_open;

        UPDATE public.positions
        SET
          qty_open = qty_open - v_close_qty,
          qty_total = qty_total - v_close_qty,
          entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
          brokerage = brokerage - v_closed_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;

        INSERT INTO public.positions (
          user_id, symbol, side, status,
          qty_total, qty_open,
          avg_price, entry_price, ltp,
          settlement, product_type, exit_price, exit_time, pnl, 
          entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
        )
        VALUES (
          v_order.user_id, v_order.symbol, v_pos.side, 'closed',
          v_close_qty, 0,
          v_pos.avg_price, v_pos.entry_price, COALESCE(v_order.fill_price, v_order.ltp_at_entry),
          v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
          v_closed_entry_brokerage, v_chunk_brokerage, v_closed_entry_brokerage + v_chunk_brokerage, now(), now()
        )
        RETURNING id INTO v_closed_pos_id;

        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        IF v_pnl <> 0 THEN
          INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
          VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);
        END IF;
      END IF;

      v_remaining_qty := v_remaining_qty - v_close_qty;
    END LOOP;

    IF v_remaining_qty > 0 THEN
       RAISE EXCEPTION 'Exit quantity cannot exceed total open position quantity';
    END IF;

  ELSE
    -- 3. ENTRY LOGIC
    INSERT INTO public.positions (
      user_id, symbol, side, status,
      qty_total, qty_open,
      avg_price, entry_price, ltp,
      settlement, product_type, stop_loss, target, 
      entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
    )
    VALUES (
      v_order.user_id, v_order.symbol, v_order.side, 'open',
      v_order.qty, v_order.qty,
      v_order.fill_price, v_order.fill_price, COALESCE(v_order.fill_price, v_order.ltp_at_entry),
      v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, 
      v_order.brokerage, 0, v_order.brokerage, now(), now()
    );
  END IF;

END;
$$;


CREATE OR REPLACE FUNCTION public.place_order(
  p_user_id uuid, p_symbol text, p_kite_inst text, p_segment text, p_side text, p_order_type text, p_product_type text, p_qty numeric, p_lots numeric, p_ltp numeric, p_fill_price numeric, p_info text, p_trigger_price numeric, p_stop_loss numeric, p_target numeric, p_is_exit boolean, p_buffer_fee numeric, p_status text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order record;
  v_trading_mode text;
  v_comm_type text;
  v_comm_val numeric;
  v_carry_comm_type text;
  v_carry_comm_val numeric;
  v_gtt_comm_type text;
  v_gtt_comm_val numeric;
  
  v_raw_brokerage numeric := 0;
  v_gtt_brokerage numeric := 0;
  v_brokerage numeric := 0;
  v_lots numeric := 1;
  v_lot_size integer;
BEGIN

  IF p_qty <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than 0';
  END IF;

  -- 1. Brokerage logic pre-computation
  SELECT trading_mode INTO v_trading_mode
  FROM public.profiles
  WHERE id = p_user_id;

  IF v_trading_mode = 'scalper' THEN
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.scalper_segment_settings
    WHERE user_id = p_user_id AND segment = p_segment AND side = p_side;
  ELSE
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.segment_settings
    WHERE user_id = p_user_id AND segment = p_segment AND side = p_side;
  END IF;

  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN p_segment = 'FOREX' THEN 2000 WHEN p_segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_gtt_comm_type IS NULL THEN
    v_gtt_comm_type := 'Per Trade';
    v_gtt_comm_val := 10;
  END IF;

  -- Handle lots definition correctly by ensuring we don't blindly trust an invalid p_lots
  IF p_lots > 0 THEN
    v_lots := p_lots;
  ELSE
    SELECT lot_size INTO v_lot_size 
    FROM public.instruments 
    WHERE tradingsymbol = p_kite_inst 
       OR tradingsymbol = p_symbol
    LIMIT 1;

    IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
      SELECT i.lot_size INTO v_lot_size
      FROM public.instruments i
      WHERE i.lot_size > 0
        AND p_symbol ILIKE i.name || '%'
      ORDER BY length(i.name) DESC
      LIMIT 1;
    END IF;

    IF v_lot_size > 0 THEN
      v_lots := CEIL(p_qty / v_lot_size);
    ELSE
      v_lots := p_qty;
    END IF;
  END IF;

  -- Brokerage calculation
  IF p_order_type IN ('MARKET', 'LIMIT', 'SL', 'SLM', 'GTT') THEN
    IF v_comm_type = 'Per Crore' THEN
      v_raw_brokerage := (p_qty * COALESCE(p_fill_price, p_ltp) * v_comm_val) / 10000000;
    ELSIF v_comm_type = 'Per Lot' THEN
      v_raw_brokerage := v_lots * v_comm_val;
    ELSIF v_comm_type = 'Per Trade' THEN
      v_raw_brokerage := v_comm_val;
    ELSE
      v_raw_brokerage := (p_qty * COALESCE(p_fill_price, p_ltp) * 0.001);
    END IF;
  END IF;

  IF p_order_type = 'GTT' THEN
    IF v_gtt_comm_type = 'Per Crore' THEN
      v_gtt_brokerage := (p_qty * COALESCE(p_fill_price, p_ltp) * v_gtt_comm_val) / 10000000;
    ELSIF v_gtt_comm_type = 'Per Lot' THEN
      v_gtt_brokerage := v_lots * v_gtt_comm_val;
    ELSIF v_gtt_comm_type = 'Per Trade' THEN
      v_gtt_brokerage := v_gtt_comm_val;
    ELSE
      v_gtt_brokerage := 0;
    END IF;
  END IF;

  v_brokerage := v_raw_brokerage + v_gtt_brokerage;

  -- 2. Insert order with all computed fields
  INSERT INTO public.orders (
    user_id, symbol, segment, side, qty, lots,
    price, fill_price, ltp_at_entry, status, order_type, product_type,
    trigger_price, stop_loss, target, is_exit, buffer_fee, brokerage
  )
  VALUES (
    p_user_id, p_symbol, p_segment, p_side, p_qty, v_lots,
    p_ltp, p_fill_price, p_ltp, p_status, p_order_type, p_product_type,
    p_trigger_price, p_stop_loss, p_target, p_is_exit, p_buffer_fee, v_brokerage
  )
  RETURNING * INTO v_order;

  -- 3. Stop here if the order is pending
  IF p_status = 'PENDING' THEN
    RETURN v_order.id;
  END IF;

  -- 4. For executed orders, defer to the single source of truth function
  PERFORM public.process_executed_position(v_order.id, p_info);

  RETURN v_order.id;
END;
$$;
