-- ==============================================================================
-- DATABASE v2: convert_position_v1
-- Updates product_type, margin limits, and optionally charges carry brokerage.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.convert_position_v1(
  p_position_id         uuid,
  p_user_id             uuid,
  p_new_product_type    text,
  p_new_margin         numeric,
  p_carry_brokerage     numeric,
  p_idempotency_key     text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_symbol text;
    v_side text;
    v_current_balance numeric;
    v_ref_id text;
    v_actual_user_id uuid;
    v_status text;
BEGIN
    -- ISOLATE V1 TRIGGERS
    PERFORM set_config('app.is_v2', 'true', true);

    -- Lock and validate position
    SELECT user_id, symbol, side, status
    INTO v_actual_user_id, v_symbol, v_side, v_status
    FROM public.positions
    WHERE id = p_position_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Position not found.';
    END IF;

    IF v_actual_user_id <> p_user_id THEN
        RAISE EXCEPTION 'Unauthorized.';
    END IF;

    IF v_status <> 'open' THEN
        RAISE EXCEPTION 'Only open positions can be converted.';
    END IF;

    -- Lock and validate profile balance if there is carry brokerage to charge
    IF p_carry_brokerage > 0 THEN
        v_ref_id := COALESCE(p_idempotency_key, 'CONV_BRK_' || p_position_id::text);
        
        SELECT balance INTO v_current_balance
        FROM public.profiles
        WHERE id = p_user_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Profile not found.';
        END IF;

        IF v_current_balance < p_carry_brokerage THEN
            RAISE EXCEPTION 'Insufficient balance to pay carry brokerage.';
        END IF;

        -- Check idempotency to ensure we don't deduct multiple times
        IF NOT EXISTS (
            SELECT 1 FROM public.transactions 
            WHERE ref_id = v_ref_id
        ) THEN
            -- Deduct balance
            UPDATE public.profiles
            SET balance = balance - p_carry_brokerage
            WHERE id = p_user_id;

            -- Log transaction
            INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
            VALUES (p_user_id, 'BROKERAGE_DEBIT', p_carry_brokerage, 'APPROVED', v_ref_id);
        END IF;
    END IF;

    -- Update the position
    UPDATE public.positions
    SET product_type = p_new_product_type,
        margin_required = p_new_margin,
        locked_margin = p_new_margin,
        carry_brokerage_paid = CASE WHEN p_carry_brokerage > 0 THEN true ELSE carry_brokerage_paid END,
        updated_at = now()
    WHERE id = p_position_id;

    -- Update all executed orders for consistency
    UPDATE public.orders
    SET product_type = p_new_product_type,
        updated_at = now()
    WHERE user_id = p_user_id
      AND symbol = v_symbol
      AND side = v_side
      AND status = 'EXECUTED';

    RETURN true;
END;
$$;
