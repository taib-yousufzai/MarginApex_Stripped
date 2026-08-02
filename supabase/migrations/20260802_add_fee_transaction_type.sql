-- ==============================================================================
-- Add FEE transaction type to the constraint.
-- FEE is used by apply_carry_charges_v1 for overnight carry fee deductions.
-- All other types are already present from prior migrations.
-- ==============================================================================

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN (
    'DEPOSIT', 'WITHDRAWAL',
    'PNL_CREDIT', 'PNL_DEBIT',
    'BROKERAGE_DEBIT', 'BUFFER_FEE_DEBIT',
    'MARGIN_ADJ_CREDIT', 'MARGIN_ADJ_DEBIT',
    'LIQUIDATION_DEBIT',
    'MARGIN_DEBIT', 'MARGIN_CREDIT',
    'FEE'
  ));
