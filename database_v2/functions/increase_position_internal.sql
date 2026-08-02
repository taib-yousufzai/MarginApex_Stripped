-- ==============================================================================
-- DATABASE v2: increase_position_internal
-- Internal helper to average same-side additions into an open position.
-- ==============================================================================

DROP FUNCTION IF EXISTS public.increase_position_internal(uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric);
DROP FUNCTION IF EXISTS public.increase_position_internal(uuid, numeric, numeric, numeric, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.increase_position_internal(
  p_position_id    uuid,
  p_qty            numeric,
  p_price          numeric,
  p_ltp            numeric,
  p_locked_margin  numeric,
  p_margin_required numeric,
  p_brokerage      numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_qty_open numeric;
    v_qty_total numeric;
    v_avg_price numeric;
BEGIN
    SELECT qty_open, qty_total, avg_price
    INTO v_qty_open, v_qty_total, v_avg_price
    FROM public.positions
    WHERE id = p_position_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Position not found for averaging.';
    END IF;

    v_avg_price := round(((v_avg_price * v_qty_open) + (p_price * p_qty)) / (v_qty_open + p_qty), 2);
    v_qty_open := v_qty_open + p_qty;
    v_qty_total := v_qty_total + p_qty;

    UPDATE public.positions
    SET qty_open = v_qty_open,
        qty_total = v_qty_total,
        avg_price = v_avg_price,
        ltp = p_ltp,
        locked_margin = locked_margin + p_locked_margin,
        margin_required = margin_required + p_margin_required,
        brokerage = brokerage + p_brokerage,
        updated_at = now()
    WHERE id = p_position_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increase_position_internal FROM public;
