-- ==============================================================================
-- DATABASE v2: apply_carry_charges_v1
-- Deducts overnight carry fees from user profiles and logs transactions.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.apply_carry_charges_v1(
  p_position_id      uuid,
  p_charge_amount    numeric,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_symbol text;
    v_product_type text;
    v_status text;
    v_current_balance numeric;
    v_new_balance numeric;
    v_ref_id text;
BEGIN
    -- ISOLATE V1 TRIGGERS
    PERFORM set_config('app.is_v2', 'true', true);

    v_ref_id := COALESCE(p_idempotency_key, 'EOD_CARRY_' || p_position_id::text || '_' || to_char(now(), 'YYYYMMDD'));

    -- Lock and validate position
    SELECT user_id, symbol, product_type, status
    INTO v_user_id, v_symbol, v_product_type, v_status
    FROM public.positions
    WHERE id = p_position_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Position not found.';
    END IF;

    -- IDEMPOTENCY CHECK (Scoped to user to avoid global reference collisions)
    IF EXISTS (
        SELECT 1 FROM public.transactions 
        WHERE user_id = v_user_id AND ref_id = v_ref_id
    ) THEN
        RETURN 0; -- Charge already applied
    END IF;

    IF v_status <> 'open' THEN
        RAISE EXCEPTION 'Position is not open.';
    END IF;

    IF v_product_type <> 'CARRY' THEN
        RAISE EXCEPTION 'Cannot apply carry charges to non-CARRY position.';
    END IF;

    -- Lock and update profile balance
    SELECT balance INTO v_current_balance
    FROM public.profiles
    WHERE id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User profile not found.';
    END IF;

    v_new_balance := v_current_balance - p_charge_amount;

    UPDATE public.profiles
    SET balance = v_new_balance
    WHERE id = v_user_id;

    -- Log transaction
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_user_id, 'FEE', p_charge_amount, 'APPROVED', v_ref_id);

    RETURN p_charge_amount;
END;
$$;
