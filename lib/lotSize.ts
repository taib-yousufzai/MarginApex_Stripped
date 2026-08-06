/**
 * lotSize.ts
 *
 * Dynamic lot size resolution for F&O instruments.
 *
 * Priority:
 *  1. DB instruments table (populated by sync-instruments cron from Zerodha CSV)
 *  2. DB script_settings table (admin-overrides per symbol)
 *  3. Hardcoded fallbacks (last resort — only if DB is empty/stale)
 *
 * Hardcoded values are current as of July 2026.
 * NSE revises lot sizes periodically — always prefer the DB value.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Hardcoded fallbacks (current as of Jul 2026)
// ---------------------------------------------------------------------------
// Keep these updated when NSE revises lot sizes, but they're only used when
// the instruments table hasn't been synced yet.
const FALLBACK_LOT_SIZES: Record<string, number> = {
  BANKNIFTY:   30,
  BANKEX:      30,
  FINNIFTY:    60,
  MIDCPNIFTY:  120,
  MIDCP:       120,
  MIDCAP:      120,
  NIFTY:       25,
  SENSEX:      20,
  GOLD:        100,
  GOLDM:       10,
  SILVER:      30,
  SILVERM:     5,
  CRUDEOIL:    100,
  CRUDEOILM:   10,
  NATURALGAS:  1250,
  NATGASMINI:  250,
};

/**
 * Resolve lot size from the DB instruments table by symbol prefix matching.
 * Falls back to script_settings overrides, then hardcoded values.
 *
 * @param symbol - tradingsymbol or underlying name (e.g. "BANKNIFTY26JUL57700PE" or "BANKNIFTY")
 * @param supabase - admin Supabase client
 * @returns lot size (always >= 1)
 */
export async function getLotSizeFromDB(symbol: string, supabase: SupabaseClient): Promise<number> {
  const n = symbol.toUpperCase().replace(/^(NFO:|BFO:|MCX:|NSE:|BSE:|CDS:)/, '');

  // 1. Check script_settings (admin overrides)
  try {
    const { data: scriptSettings } = await supabase
      .from('script_settings')
      .select('symbol, lot_size')
      .gt('lot_size', 0);

    if (scriptSettings && scriptSettings.length > 0) {
      const sorted = [...scriptSettings].sort((a, b) => (b.symbol || '').length - (a.symbol || '').length);
      const match = sorted.find(s => s.symbol && n.includes(s.symbol.toUpperCase()));
      if (match && Number(match.lot_size) > 0) return Number(match.lot_size);
    }
  } catch { /* fall through */ }

  // 2. Check instruments table — look up by underlying name match
  try {
    const { data: instruments, error: instErr } = await supabase
      .from('instruments')
      .select('name, lot_size')
      .gt('lot_size', 0)
      .limit(100);

    // If lot_size column doesn't exist yet (migration pending), skip silently
    if (instErr && (instErr as any).code === '42703') {
      console.warn('[getLotSizeFromDB] lot_size column missing — run migration 20260705_add_lot_size_to_instruments.sql in Supabase SQL editor');
    } else if (instruments && instruments.length > 0) {
      // Sort by name length descending so more specific names match first
      // (e.g. CRUDEOILM before CRUDEOIL, GOLDM before GOLD)
      const sorted = [...instruments].sort((a, b) => (b.name || '').length - (a.name || '').length);
      const match = sorted.find(s => s.name && n.startsWith(s.name.toUpperCase()));
      if (match && Number(match.lot_size) > 0) return Number(match.lot_size);
    }
  } catch { /* fall through */ }

  // 3. Hardcoded fallback
  return getLotSizeFallback(symbol);
}

/**
 * Synchronous fallback lot size resolution using hardcoded values.
 * Use this only when you don't have an async context or the DB isn't available.
 * Pass pre-fetched dbSettings from script_settings to avoid DB hardcoding.
 */
export function getLotSizeFallback(
  symbol: string,
  dbSettings?: { symbol: string; lot_size: number }[],
): number {
  const n = symbol.toUpperCase().replace(/^(NFO:|BFO:|MCX:|NSE:|BSE:|CDS:)/, '');

  // 1. script_settings override
  if (dbSettings && dbSettings.length > 0) {
    const sorted = [...dbSettings].sort((a, b) => (b.symbol || '').length - (a.symbol || '').length);
    const exactMatch = sorted.find(s => s.symbol && n === s.symbol.toUpperCase());
    if (exactMatch && Number(exactMatch.lot_size) > 0) return Number(exactMatch.lot_size);

    const prefixMatch = sorted.find(s => s.symbol && n.startsWith(s.symbol.toUpperCase()));
    if (prefixMatch && Number(prefixMatch.lot_size) > 0) return Number(prefixMatch.lot_size);
  }

  // 2. Hardcoded — longest match first (CRUDEOILM before CRUDEOIL)
  const sorted = Object.entries(FALLBACK_LOT_SIZES).sort((a, b) => b[0].length - a[0].length);
  for (const [key, size] of sorted) {
    if (n.startsWith(key)) return size;
  }

  return 1;
}
