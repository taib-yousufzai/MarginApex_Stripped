-- Description: Optimize sync_profile_balance trigger to do incremental updates for trade transactions,
-- preventing O(N^2) full-history rebaselining during batch order exits (which caused 19-second statement timeouts).

CREATE OR REPLACE FUNCTION public.sync_profile_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id       uuid;
  v_change        numeric;
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.type IN ('MARGIN_DEBIT', 'MARGIN_CREDIT') THEN
      RETURN NEW;
    END IF;
    v_user_id := NEW.user_id;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.type IN ('MARGIN_DEBIT', 'MARGIN_CREDIT') THEN
      RETURN OLD;
    END IF;
    v_user_id := OLD.user_id;
  END IF;

  -- PERFORMANCE OPTIMIZATION: For standard trading transactions (PNL, brokerage, buffer fees),
  -- do a fast incremental balance update. Only perform a full-history rebaselining for 
  -- administrative/deposit/withdraw transaction types.
  IF TG_OP = 'INSERT' AND NEW.status = 'APPROVED' AND NEW.type IN ('PNL_CREDIT', 'PNL_DEBIT', 'BROKERAGE_DEBIT', 'BUFFER_FEE_DEBIT') THEN
    v_change := CASE 
                  WHEN NEW.type = 'PNL_CREDIT' THEN NEW.amount
                  ELSE -NEW.amount
                END;
    UPDATE public.profiles
    SET balance = balance + v_change,
        updated_at = now()
    WHERE id = NEW.user_id;
  ELSE
    -- Fallback to full rebaseline for deposits, withdrawals, or updates
    IF v_user_id IS NOT NULL THEN
      PERFORM public.rebaseline_user_profile_balance(v_user_id);
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
