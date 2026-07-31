-- ==============================================================================
-- DATABASE v2: close_position_v2
-- Atomic, synchronous closure of a position. No triggers required.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.close_position_v2(
  p_position_id    uuid,
  p_close_qty      numeric,
  p_close_price    numeric,
  p_closed_by      text,
  p_expected_brokerage numeric DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_symbol text;
    v_side text;
    v_qty_open numeric;
    v_avg_price numeric;
    
    v_pnl numeric;
    v_margin_released numeric; -- Requires fetching required margin based on closed qty
    -- For simplicity in v2, margin release could be derived from the proportional open qty 
    -- or provided explicitly by TS and verified here.
    v_expected_margin_credit numeric;
BEGIN
    -- ISOLATE V1 TRIGGERS (Strangler Fig)
    PERFORM set_config('app.is_v2', 'true', true);

    -- STEP 1: Lock Position
    SELECT user_id, symbol, side, qty_open, avg_price
    INTO v_user_id, v_symbol, v_side, v_qty_open, v_avg_price
    FROM public.positions
    WHERE id = p_position_id AND status IN ('open', 'active')
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Position not found or already closed.';
    END IF;

    IF p_close_qty > v_qty_open THEN
        RAISE EXCEPTION 'Cannot close more than open quantity (%). Requested: %', v_qty_open, p_close_qty;
    END IF;

    -- STEP 2: Calculate Realized PnL natively in DB to prevent tampering
    IF v_side = 'BUY' THEN
        v_pnl := (p_close_price - v_avg_price) * p_close_qty;
    ELSE
        v_pnl := (v_avg_price - p_close_price) * p_close_qty;
    END IF;

    -- STEP 3: Update Position
    UPDATE public.positions
    SET qty_open = qty_open - p_close_qty,
        pnl = pnl + v_pnl,
        exit_price = p_close_price,
        status = CASE WHEN (qty_open - p_close_qty) <= 0 THEN 'closed' ELSE status END,
        closed_by = p_closed_by,
        updated_at = now()
    WHERE id = p_position_id;

    -- STEP 4: Write to Ledger
    -- Brokerage
    IF p_expected_brokerage > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'BROKERAGE_DEBIT', p_expected_brokerage, 'APPROVED', 'BRK_' || p_position_id);
    END IF;

    -- PnL
    IF v_pnl > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'PNL_CREDIT', v_pnl, 'APPROVED', 'PNL_' || p_position_id);
    ELSIF v_pnl < 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'PNL_DEBIT', ABS(v_pnl), 'APPROVED', 'PNL_' || p_position_id);
    END IF;

    -- (Margin Release logic omitted for brevity in this architectural draft,
    -- but ideally TS passes p_expected_margin_credit and DB verifies it).

    RETURN p_position_id;
END;
$$;
