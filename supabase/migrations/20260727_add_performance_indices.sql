CREATE INDEX IF NOT EXISTS idx_positions_user_status_symbol ON public.positions(user_id, status, symbol);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON public.orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_user_status ON public.transactions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_transactions_ref_id ON public.transactions(ref_id);