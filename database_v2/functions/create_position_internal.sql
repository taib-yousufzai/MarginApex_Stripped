-- ==============================================================================
-- DATABASE v2: create_position_internal
-- Internal helper to initialize a new open position.
-- ==============================================================================

DROP FUNCTION IF EXISTS public.create_position_internal(uuid, text, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, numeric, numeric);
DROP FUNCTION IF EXISTS public.create_position_internal(uuid, text, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.create_position_internal(
  p_user_id        uuid,
  p_symbol         text,
  p_side           text,
  p_qty            numeric,
  p_price          numeric,
  p_ltp            numeric,
  p_product_type   text,
  p_settlement     text,
  p_stop_loss      numeric,
  p_target         numeric,
  p_locked_margin  numeric,
  p_margin_required numeric,
  p_brokerage      numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_position_id uuid;
BEGIN
    INSERT INTO public.positions (
        user_id, symbol, side, status, qty_open, qty_total, avg_price, entry_price, ltp,
        product_type, settlement, stop_loss, target, locked_margin, margin_required,
        entry_brokerage, brokerage, entry_time, created_at, updated_at
    ) VALUES (
        p_user_id, p_symbol, p_side, 'open', p_qty, p_qty, p_price, p_price, p_ltp,
        p_product_type, p_settlement, p_stop_loss, p_target, p_locked_margin, p_margin_required,
        p_brokerage, p_brokerage, now(), now(), now()
    ) RETURNING id INTO v_position_id;

    RETURN v_position_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_position_internal FROM public;
