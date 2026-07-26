-- ==============================================================================
-- MIGRATION: rollover_carry_position
-- Date: 2026-07-26
-- Description: RPC to automatically rollover open CARRY positions at a new LTP.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rollover_carry_position(
  p_position_id uuid,
  p_ltp         numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_old_pos    record;
  v_new_pos_id uuid;
  v_user_id    uuid;
BEGIN
  -- 1. Fetch & lock the old position to ensure it hasn't been closed
  SELECT * INTO v_old_pos
  FROM public.positions
  WHERE id = p_position_id AND status = 'open' AND product_type = 'CARRY'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Carry position not found or already closed';
  END IF;

  v_user_id := v_old_pos.user_id;

  -- 2. Call the existing close_position function to realize P&L and refund margin
  -- We don't charge brokerage for rollover exit (pass 0).
  PERFORM public.close_position(p_position_id, v_user_id, p_ltp, p_ltp, 'WEEKLY_ROLLOVER', 0);

  -- 3. Create the new carry position at the new LTP
  INSERT INTO public.positions (
    user_id, symbol, name, settlement, side, product_type,
    qty_total, qty_open, entry_price, status, entry_time, created_at, updated_at
  ) VALUES (
    v_user_id, v_old_pos.symbol, v_old_pos.name, v_old_pos.settlement, v_old_pos.side, 'CARRY',
    v_old_pos.qty_open, v_old_pos.qty_open, p_ltp, 'open', now(), now(), now()
  ) RETURNING id INTO v_new_pos_id;
  
  RETURN v_new_pos_id;
END;
$$;
