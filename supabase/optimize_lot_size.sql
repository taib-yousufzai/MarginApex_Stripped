-- Redefine process_executed_position to optimize lot size lookup and prevent database timeouts on Crypto/Forex orders
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid)
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
  v_new_avg_price numeric;
  
  -- Brokerage local vars
  v_trading_mode text;
  v_comm_type text;
  v_comm_val numeric;
  v_carry_comm_type text;
  v_carry_comm_val numeric;
  v_gtt_comm_type text;
  v_gtt_comm_val numeric;
  v_raw_brokerage numeric := 0;
  v_carry_brokerage numeric := 0;
  v_gtt_brokerage numeric := 0;
  v_brokerage numeric := 0;
  v_closed_brokerage numeric := 0;
  v_closed_entry_brokerage numeric := 0;
  v_pos_found boolean;
  v_lot_size numeric;
  v_lots numeric;
  
  -- Referral / First Trade Bonus vars
  v_has_traded boolean;
  v_parent_id_text text;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status != 'EXECUTED' THEN
    RETURN;
  END IF;

  -- ─── CALCULATE & CHARGE BROKERAGE FOR THIS ORDER ───
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

  -- Defaults fallback
  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_carry_comm_type IS NULL THEN
    v_carry_comm_type := 'Per Crore';
    v_carry_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_gtt_comm_type IS NULL THEN
    v_gtt_comm_type := 'Per Trade';
    v_gtt_comm_val := 10;
  END IF;

  -- Optimize Lot Size lookup: Bypass slow instruments table query for Crypto & Forex
  IF v_order.segment = 'CRYPTO' OR v_order.segment = 'FOREX' THEN
    v_lot_size := 1;
  ELSE
    -- First try fetching exact lot size from instruments table
    SELECT lot_size INTO v_lot_size 
    FROM public.instruments 
    WHERE tradingsymbol = v_order.kite_instrument 
       OR tradingsymbol = v_order.symbol
    LIMIT 1;

    -- Fallback: match by underlying name prefix
    IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
      SELECT i.lot_size INTO v_lot_size
      FROM public.instruments i
      WHERE i.lot_size > 0
        AND v_order.symbol ILIKE i.name || '%'
      ORDER BY length(i.name) DESC
      LIMIT 1;
    END IF;
  END IF;

  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE v_order.symbol ILIKE '%' || symbol || '%' ORDER BY length(symbol) DESC LIMIT 1;
  END IF;

  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    IF v_order.symbol ILIKE '%BANKNIFTY%' OR v_order.symbol ILIKE '%BANKEX%' THEN
      v_lot_size := 30;
    ELSIF v_order.symbol ILIKE '%FINNIFTY%' THEN
      v_lot_size := 40;
    ELSIF v_order.symbol ILIKE '%MIDCP%' OR v_order.symbol ILIKE '%MIDCAP%' THEN
      v_lot_size := 75;
    ELSIF v_order.symbol ILIKE '%SENSEX%' THEN
      v_lot_size := 20;
    ELSIF v_order.symbol ILIKE '%NIFTY%' THEN
      v_lot_size := 75;
    ELSIF v_order.symbol ILIKE '%GOLDM%' THEN
      v_lot_size := 10;
    ELSIF v_order.symbol ILIKE '%GOLD%' THEN
      v_lot_size := 100;
    ELSIF v_order.symbol ILIKE '%SILVERM%' THEN
      v_lot_size := 5;
    ELSIF v_order.symbol ILIKE '%SILVER%' THEN
      v_lot_size := 30;
    ELSIF v_order.symbol ILIKE '%CRUDEOIL%' THEN
      v_lot_size := 100;
    ELSIF v_order.symbol ILIKE '%NATURALGAS%' THEN
      v_lot_size := 1250;
    ELSE
      v_lot_size := 1;
    END IF;
  END IF;

  v_lots := COALESCE(NULLIF(v_order.lots, 0), v_order.qty / v_lot_size);

  -- 1. Intraday Commission (ALWAYS applied)
  IF v_comm_type = 'Per Crore' THEN
    v_raw_brokerage := (v_order.qty * v_order.fill_price * v_comm_val) / 10000000;
  ELSIF v_comm_type = 'Per Lot' THEN
    v_raw_brokerage := v_lots * v_comm_val;
  ELSIF v_comm_type = 'Per Trade' THEN
    v_raw_brokerage := v_comm_val;
  ELSE
    v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
  END IF;

  -- 2. Carry Commission — DEFERRED TO EXIT TIME
  -- Carry brokerage is NOT charged at entry anymore. It is calculated and charged
  -- when the position is closed via close_position() RPC's p_brokerage parameter.

  -- 3. GTT Commission (only if GTT order, stacked on top)
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

  v_brokerage := (v_raw_brokerage + v_gtt_brokerage) * 2;

  -- Save brokerage and lots to the order
  UPDATE public.orders
  SET brokerage = v_brokerage,
      lots = v_lots
  WHERE id = v_order.id;

  -- Debit user's balance immediately via transaction
  IF v_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  -- Debit buffer fee
  IF v_order.buffer_fee > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BUFFER_FEE_DEBIT', v_order.buffer_fee, 'APPROVED', 'BUF_' || v_order.id::text);
  END IF;

  -- Lock and fetch active position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE user_id = v_order.user_id 
    AND symbol = v_order.symbol 
    AND status = 'open' 
    AND product_type = v_order.product_type
  FOR UPDATE;

  v_pos_found := FOUND;

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

    -- Calculate realized P&L (BUY = exit - entry, SELL = entry - exit)
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT: Close active position row and add exit brokerage
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
        exit_brokerage = exit_brokerage + v_brokerage,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- Record PNL transaction
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);

    ELSE
      -- PARTIAL EXIT: Split position
      -- Calculate proportional entry brokerage for the closed portion
      v_closed_entry_brokerage := (v_pos.entry_brokerage * v_order.qty) / v_pos.qty_open;
      v_closed_brokerage := (v_pos.brokerage * v_order.qty) / v_pos.qty_open;

      -- 1. Reduce quantity, entry brokerage and total brokerage of the active open position
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        qty_total = qty_total - v_order.qty,
        entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
        brokerage = brokerage - v_closed_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- 2. Create a new CLOSED position representing the exited portion (entry share + exit brokerage)
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, exit_price, exit_time, pnl, duration_seconds, 
        entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.avg_price, v_pos.entry_price, v_order.ltp_at_entry,
        v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
        EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer, 
        v_closed_entry_brokerage, v_brokerage, v_closed_entry_brokerage + v_brokerage, now(), now()
      )
      RETURNING id INTO v_closed_pos_id;

      -- 3. Record PNL transaction for the closed portion
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);

    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC ───
    -- D. Accumulate/create position
    IF v_pos_found THEN
      -- If same side, accumulate quantity & compute weighted average price
      IF v_pos.side = v_order.side THEN
        v_new_avg_price := ((v_pos.avg_price * v_pos.qty_open) + (v_order.fill_price * v_order.qty)) / (v_pos.qty_open + v_order.qty);

        UPDATE public.positions
        SET
          qty_open = qty_open + v_order.qty,
          qty_total = qty_total + v_order.qty,
          avg_price = v_new_avg_price,
          entry_price = v_new_avg_price,
          entry_brokerage = entry_brokerage + v_brokerage,
          brokerage = brokerage + v_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;
      ELSE
        RAISE EXCEPTION 'Cannot open opposite position while existing position is active';
      END IF;
    ELSE
      -- Insert a brand new open position
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
  END IF;

  -- ─── FIRST TRADE BONUS LOGIC ───
  SELECT has_traded, parent_id INTO v_has_traded, v_parent_id_text
  FROM public.profiles WHERE id = v_order.user_id;

  IF NOT v_has_traded THEN
    UPDATE public.profiles SET has_traded = TRUE WHERE id = v_order.user_id;
    IF v_parent_id_text IS NOT NULL THEN
      UPDATE public.profiles
      SET balance = balance + 100
      WHERE id = v_parent_id_text::uuid;

      INSERT INTO public.transactions (user_id, type, amount, status, description)
      VALUES (v_parent_id_text::uuid, 'REFERRAL_BONUS', 100, 'APPROVED', 'Referral bonus from first trade of user: ' || v_order.user_id::text);
    END IF;
  END IF;
END;
$$;
