-- Description: Fix negative balance issue. When balance drops below zero due to PNL or brokerage,
-- fallback to full rebaselining to correctly zero out the balance and transfer debt to settlement_amount.

CREATE OR REPLACE FUNCTION public.sync_profile_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id       uuid;
  v_change        numeric;
  v_current_bal   numeric;
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

  -- PERFORMANCE OPTIMIZATION: For standard trading transactions
  IF TG_OP = 'INSERT' AND NEW.status = 'APPROVED' AND NEW.type IN ('PNL_CREDIT', 'PNL_DEBIT', 'BROKERAGE_DEBIT', 'BUFFER_FEE_DEBIT') THEN
    v_change := CASE 
                  WHEN NEW.type = 'PNL_CREDIT' THEN NEW.amount
                  ELSE -NEW.amount
                END;
    
    -- Check if this would make balance negative
    SELECT balance INTO v_current_bal FROM public.profiles WHERE id = NEW.user_id;
    
    IF v_current_bal + v_change < 0 THEN
      -- Fallback to full rebaseline to properly handle settlement
      PERFORM public.rebaseline_user_profile_balance(NEW.user_id);
    ELSE
      UPDATE public.profiles
      SET balance = balance + v_change,
          updated_at = now()
      WHERE id = NEW.user_id;
    END IF;
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

-- Re-run rebaselining to fix anyone currently stuck in negative balance
SELECT public.rebaseline_profile_balances();
