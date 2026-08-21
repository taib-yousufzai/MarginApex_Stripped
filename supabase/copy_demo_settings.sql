CREATE OR REPLACE FUNCTION public.copy_demo_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_demo_id uuid;
BEGIN
  -- Find the demo user's ID
  SELECT id INTO v_demo_id 
  FROM public.profiles 
  WHERE email ILIKE '%demo%'
  LIMIT 1;

  IF v_demo_id IS NOT NULL THEN
    -- Copy segment_settings from demo user
    INSERT INTO public.segment_settings (
      user_id, segment, side, commission_type, commission_value, profit_hold_sec, loss_hold_sec, 
      strike_range, max_lot, max_order_lot, intraday_leverage, intraday_type, holding_leverage, 
      entry_buffer, bid_buffer, holding_type, exit_buffer, trade_allowed, top_limit, min_limit,
      gtt_commission_type, gtt_commission_value, carry_commission_type, carry_commission_value
    )
    SELECT 
      NEW.id, segment, side, commission_type, commission_value, profit_hold_sec, loss_hold_sec, 
      strike_range, max_lot, max_order_lot, intraday_leverage, intraday_type, holding_leverage, 
      entry_buffer, COALESCE(bid_buffer, entry_buffer, 0.3), holding_type, exit_buffer, trade_allowed, top_limit, min_limit,
      gtt_commission_type, gtt_commission_value, carry_commission_type, carry_commission_value
    FROM public.segment_settings
    WHERE user_id = v_demo_id
    ON CONFLICT DO NOTHING;
    
    -- Copy scalper_segment_settings from demo user
    INSERT INTO public.scalper_segment_settings (
      user_id, segment, side, commission_type, commission_value, profit_hold_sec, loss_hold_sec, 
      strike_range, max_lot, max_order_lot, intraday_leverage, intraday_type, holding_leverage, 
      entry_buffer, bid_buffer, holding_type, exit_buffer, trade_allowed, top_limit, min_limit,
      gtt_commission_type, gtt_commission_value, carry_commission_type, carry_commission_value
    )
    SELECT 
      NEW.id, segment, side, commission_type, commission_value, profit_hold_sec, loss_hold_sec, 
      strike_range, max_lot, max_order_lot, intraday_leverage, intraday_type, holding_leverage, 
      entry_buffer, COALESCE(bid_buffer, entry_buffer, 0.3), holding_type, exit_buffer, trade_allowed, top_limit, min_limit,
      gtt_commission_type, gtt_commission_value, carry_commission_type, carry_commission_value
    FROM public.scalper_segment_settings
    WHERE user_id = v_demo_id
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'copy_demo_settings failed for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_profile_created_copy_demo_settings ON public.profiles;
CREATE TRIGGER on_profile_created_copy_demo_settings
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE PROCEDURE public.copy_demo_settings();
