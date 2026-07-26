DROP FUNCTION IF EXISTS public.place_order(uuid,text,text,text,text,text,text,numeric,numeric,numeric,numeric,text,numeric,numeric,numeric,boolean,numeric);

CREATE OR REPLACE FUNCTION public.place_order(
  p_user_id uuid, p_symbol text, p_kite_inst text, p_segment text, p_side text, p_order_type text, p_product_type text, p_qty numeric, p_lots numeric, p_ltp numeric, p_fill_price numeric, p_info text, p_trigger_price numeric, p_stop_loss numeric, p_target numeric, p_is_exit boolean, p_buffer_fee numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order record;
  v_pos record;
  v_closed_pos_id uuid;
  v_pnl numeric;
  v_pnl_type text;
  
  -- Brokerage local vars
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
  v_lots integer := 1;
  v_lot_size integer;
  
  v_pos_found boolean := false;
  
BEGIN
  -- 1. Insert order
  INSERT INTO public.orders (
    user_id, symbol, segment, side, qty, lots,
    price, fill_price, ltp_at_entry, status, order_type, product_type,
    trigger_price, stop_loss, target, is_exit, buffer_fee
  )
  VALUES (
    p_user_id, p_symbol, p_segment, p_side, p_qty, p_lots,
    p_ltp, p_fill_price, p_ltp, 'EXECUTED', p_order_type, p_product_type,
    p_trigger_price, p_stop_loss, p_target, p_is_exit, p_buffer_fee
  )
  RETURNING * INTO v_order;

  -- Use p_info directly as linked_position_id (it is passed as text)

  -- Brokerage logic
  SELECT trading_mode INTO v_trading_mode
  FROM public.profiles
  WHERE id = v_order.user_id;

  IF v_trading_mode = 'scalper' THEN
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.scalper_segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  ELSE
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  END IF;

  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_gtt_comm_type IS NULL THEN
    v_gtt_comm_type := 'Per Trade';
    v_gtt_comm_val := 10;
  END IF;

  SELECT lot_size INTO v_lot_size 
  FROM public.instruments 
  WHERE tradingsymbol = p_kite_inst 
     OR tradingsymbol = v_order.symbol
  LIMIT 1;

  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    SELECT i.lot_size INTO v_lot_size
    FROM public.instruments i
    WHERE i.lot_size > 0
      AND v_order.symbol ILIKE i.name || '%'
    ORDER BY length(i.name) DESC
    LIMIT 1;
  END IF;

  IF v_lot_size > 0 THEN
    v_lots := CEIL(v_order.qty / v_lot_size);
  ELSE
    v_lots := v_order.qty;
  END IF;

  IF v_order.order_type = 'MARKET' OR v_order.order_type = 'LIMIT' OR v_order.order_type = 'SL' OR v_order.order_type = 'SLM' OR v_order.order_type = 'GTT' THEN
    IF v_comm_type = 'Per Crore' THEN
      v_raw_brokerage := (v_order.qty * v_order.fill_price * v_comm_val) / 10000000;
    ELSIF v_comm_type = 'Per Lot' THEN
      v_raw_brokerage := v_lots * v_comm_val;
    ELSIF v_comm_type = 'Per Trade' THEN
      v_raw_brokerage := v_comm_val;
    ELSE
      v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001);
    END IF;
  END IF;

  IF v_order.order_type = 'GTT' THEN
    IF v_gtt_comm_type = 'Per Crore' THEN
      v_gtt_brokerage := (v_order.qty * v_order.fill_price * v_gtt_comm_val) / 10000000;
    ELSIF v_gtt_comm_type = 'Per Lot' THEN
      v_gtt_brokerage := v_lots * v_gtt_comm_val;
    ELSIF v_gtt_comm_type = 'Per Trade' THEN
      v_gtt_brokerage := v_gtt_comm_val;
    ELSE
      v_gtt_brokerage := 0;
    END IF;
  END IF;

  v_brokerage := v_raw_brokerage + v_gtt_brokerage;

  UPDATE public.orders
  SET brokerage = v_brokerage,
      lots = v_lots
  WHERE id = v_order.id;

  IF v_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  IF COALESCE(v_order.buffer_fee, 0) > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BUFFER_FEE_DEBIT', v_order.buffer_fee, 'APPROVED', 'BUF_' || v_order.id::text);
  END IF;

  IF v_order.is_exit THEN
    IF p_info IS NOT NULL THEN
      SELECT * INTO v_pos
      FROM public.positions
      WHERE id = p_info::uuid
        AND user_id = v_order.user_id
      FOR UPDATE;
      v_pos_found := FOUND;
    ELSE
      SELECT * INTO v_pos
      FROM public.positions
      WHERE user_id = v_order.user_id 
        AND symbol = v_order.symbol 
        AND status IN ('open', 'active') 
        AND product_type = v_order.product_type
        AND side != v_order.side
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE;
      v_pos_found := FOUND;
    END IF;
  END IF;

  IF v_order.is_exit THEN
    -- ─── EXIT ORDER LOGIC ───
    IF NOT v_pos_found THEN
      RAISE EXCEPTION 'No active position exists to exit';
    END IF;

    IF v_pos.side = v_order.side THEN
      RAISE EXCEPTION 'Invalid exit side: exit order side must be opposite of position side';
    END IF;

    IF v_order.qty > v_pos.qty_open THEN
      RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
    END IF;

    -- Calculate realized P&L
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        total_pnl = total_pnl + v_pnl,
        exit_brokerage = exit_brokerage + v_brokerage,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;
      v_closed_pos_id := v_pos.id;
      
      IF v_pnl <> 0 THEN
        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);
      END IF;
    ELSE
      -- PARTIAL EXIT
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        total_pnl = total_pnl + v_pnl,
        exit_brokerage = exit_brokerage + v_brokerage,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;
      
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, exit_price,
        settlement, product_type,
        entry_brokerage, exit_brokerage, brokerage,
        pnl, total_pnl,
        entry_time, exit_time, created_at, updated_at
      )
      VALUES (
        v_pos.user_id, v_pos.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.entry_price, v_pos.entry_price, v_order.fill_price,
        v_pos.settlement, v_pos.product_type,
        0, v_brokerage, v_brokerage,
        v_pnl, v_pnl,
        v_pos.created_at, now(), v_pos.created_at, now()
      ) RETURNING id INTO v_closed_pos_id;
      
      IF v_pnl <> 0 THEN
        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);
      END IF;
    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC (DETAILED MODE: ALWAYS INSERT) ───
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
      v_order.fill_price, v_order.fill_price, v_order.ltp_at_entry,
      v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, 
      v_brokerage, 0, v_brokerage, now(), now()
    );
  END IF;

  RETURN v_order.id;
END;
$$;
