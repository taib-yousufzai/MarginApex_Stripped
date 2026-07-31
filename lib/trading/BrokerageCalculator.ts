/**
 * Brokerage Calculator
 *
 * Single source of truth for all commission calculations on this platform.
 *
 * Commission types supported:
 *   'Per Crore'        → (exposure × rate) / 10,000,000
 *   'Per Lot'          → lots × rate
 *   'Per Trade'/'Flat' → flat rate per trade
 *   (fallback)         → exposure × 0.001  (0.1%)
 *
 * Two public functions:
 *   calculateSingleLegCharge  — one trade leg, no doubling (used by order entry)
 *   calculateCarryBrokerage   — both legs × 2, CARRY only (used at close / conversion)
 */

// ─── Shared commission params (used by both functions) ──────────────────────

export interface CommissionParams {
  /** Notional exposure = qty × price */
  exposure: number;
  /** Number of lots for 'Per Lot' calculations */
  lots: number;
  /** 'Per Crore' | 'Per Lot' | 'Per Trade' | 'Flat' */
  commissionType: string;
  /** Numeric rate corresponding to the commission type */
  commissionValue: number;
}

/**
 * Calculate the brokerage charge for a single trade leg.
 * No doubling — caller is responsible for multiplying if both legs are needed.
 */
export function calculateSingleLegCharge({
  exposure,
  lots,
  commissionType,
  commissionValue,
}: CommissionParams): number {
  if (commissionValue <= 0) return 0;

  if (commissionType === 'Per Crore') {
    return (exposure * commissionValue) / 10_000_000;
  }
  if (commissionType === 'Per Lot') {
    return lots * commissionValue;
  }
  if (commissionType === 'Per Trade' || commissionType === 'Flat') {
    return commissionValue;
  }
  // Unknown type — fall back to 0.1%
  return exposure * 0.001;
}

// ─── Carry brokerage (legacy interface — backward-compatible) ────────────────

export interface CarryBrokerageParams {
  /** Position's product_type at close time */
  productType: string;
  /** Quantity being closed */
  qty: number;
  /** Entry price used for exposure calculation */
  entryPrice: number;
  /** Number of lots (falls back to qty if omitted) */
  lots?: number;
  /** carry_commission_type from segment_settings (preferred) */
  carryCommissionType?: string | null;
  /** carry_commission_value from segment_settings (preferred) */
  carryCommissionValue?: number | null;
  /** commission_type from segment_settings (fallback) */
  commissionType?: string | null;
  /** commission_value from segment_settings (fallback) */
  commissionValue?: number | null;
}

/**
 * Calculate carry brokerage for a position being closed.
 *
 * Returns 0 for non-CARRY positions.
 * Returns the total charge for both legs (entry + exit = × 2).
 */
export function calculateCarryBrokerage(params: CarryBrokerageParams): number {
  if (params.productType !== 'CARRY') return 0;

  const commType = params.carryCommissionType || params.commissionType || 'Per Crore';
  const commVal = Number(params.carryCommissionValue ?? params.commissionValue ?? 0);

  const exposure = params.qty * params.entryPrice;
  const lots = params.lots ?? params.qty;

  const singleLeg = calculateSingleLegCharge({
    exposure,
    lots,
    commissionType: commType,
    commissionValue: commVal,
  });

  return Math.max(0, Math.round(singleLeg * 2 * 100) / 100);
}
