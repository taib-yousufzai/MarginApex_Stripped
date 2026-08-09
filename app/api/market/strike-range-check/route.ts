/**
 * GET /api/market/strike-range-check?symbol=GOLD26AUG153500PE
 *
 * Checks whether a given option symbol's strike price falls within the
 * user's allowed range — using the exact same algorithm as TradeEngine.
 *
 * Returns:
 *   { allowed: true }
 *   { allowed: false, min: number, max: number, strike: number }
 *   { allowed: true }  — when range cannot be determined (fail open, same as TradeEngine)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, getAdminClient } from '@/lib/adminClient';
import { parseOptionSymbol } from '@/lib/positionStore';
import { fetchSpeedQuotes, fetchKiteQuotes } from '@/lib/datafeed/MarketDataService';

export const dynamic = 'force-dynamic';

const MCX_UNDERLYINGS = new Set([
  'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'SILVERMIC',
  'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI',
  'COPPER', 'ZINC', 'ZINCMINI', 'LEAD', 'LEADMINI',
  'ALUMINIUM', 'ALUMINI',
]);

const MCX_BASE_MAP: Record<string, string> = {
  'GOLDM': 'GOLD', 'SILVERM': 'SILVER', 'SILVERMIC': 'SILVER',
  'CRUDEOILM': 'CRUDEOIL', 'NATGASMINI': 'NATURALGAS',
  'ALUMINI': 'ALUMINIUM', 'ZINCMINI': 'ZINC', 'LEADMINI': 'LEAD',
};

function getUnderlyingKiteId(underlying: string): string {
  if (underlying === 'BANKNIFTY') return 'NSE:NIFTY BANK';
  if (underlying === 'FINNIFTY') return 'NSE:NIFTY FIN SERVICE';
  if (underlying === 'SENSEX') return 'BSE:SENSEX';
  if (underlying === 'BANKEX') return 'BSE:BANKEX';
  if (underlying === 'MIDCPNIFTY') return 'NSE:NIFTY MID SELECT';
  if (underlying === 'NIFTY') return 'NSE:NIFTY 50';
  // For MCX options we resolve the nearest futures contract below
  return `NSE:${underlying}`;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get('symbol') || '').trim().toUpperCase();

    if (!symbol) {
      return NextResponse.json({ allowed: true });
    }

    // Only applies to options
    const parsed = parseOptionSymbol(symbol);
    if (!parsed) {
      return NextResponse.json({ allowed: true });
    }

    const { underlying, strike: orderStrike } = parsed;
    const admin = getAdminClient();
    const today = new Date().toISOString().split('T')[0];

    // ── 1. Get the user's strike_range setting ───────────────────────────
    const user = await getUserFromRequest(request);
    let strikeRange = 0;

    if (user) {
      const { data: profile } = await admin
        .from('profiles')
        .select('parent_id, trading_mode')
        .eq('id', user.id)
        .single();

      if (profile) {
        const isMcx = MCX_UNDERLYINGS.has(underlying);
        const dbSegment = isMcx ? 'MCX-OPT' : (
          ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(underlying)
            ? 'INDEX-OPT'
            : 'STOCK-OPT'
        );

        const settingsTable = profile.trading_mode === 'scalper'
          ? 'scalper_segment_settings'
          : 'segment_settings';
        const lookupId = profile.parent_id ?? user.id;

        const { data: segRows } = await admin
          .from(settingsTable)
          .select('strike_range')
          .eq('user_id', lookupId)
          .eq('segment', dbSegment)
          .limit(1);

        if (segRows && segRows.length > 0) {
          strikeRange = Number(segRows[0].strike_range || 0);
        }
      }
    }

    // ── 2. Resolve underlying live price ────────────────────────────────
    let underlyingKiteId: string;
    let underlyingPrice = 0;

    const isMcx = MCX_UNDERLYINGS.has(underlying);

    if (isMcx) {
      // Resolve the future contract matching this option's specific expiry cycle
      const cleanSym = symbol.includes(':') ? symbol.split(':')[1] : symbol;
      const mcxMatch = cleanSym.toUpperCase().match(/^([A-Z]+)(\d{2}[A-Z]{3})\d+(?:CE|PE)$/);
      let resolvedFut: string | null = null;
      if (mcxMatch) {
        resolvedFut = `${mcxMatch[1]}${mcxMatch[2]}FUT`;
      }

      if (resolvedFut) {
        underlyingKiteId = `MCX:${resolvedFut}`;
      } else {
        // For MCX options, look up the nearest futures contract
        const baseName = MCX_BASE_MAP[underlying] || underlying;
        const { data: mcxFuts } = await admin
          .from('instruments')
          .select('tradingsymbol, exchange')
          .eq('exchange', 'MCX')
          .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
          .eq('name', baseName)
          .gte('expiry', today)
          .order('expiry', { ascending: true })
          .limit(1);

        underlyingKiteId = mcxFuts?.[0]
          ? `${mcxFuts[0].exchange}:${mcxFuts[0].tradingsymbol}`
          : `MCX:${baseName}`;
      }
    } else {
      underlyingKiteId = getUnderlyingKiteId(underlying);
    }

    // Try speed quotes first (Redis / ticker daemon), then Kite REST
    try {
      const speedMap = await fetchSpeedQuotes([underlyingKiteId]);
      underlyingPrice = speedMap?.[underlyingKiteId] ?? 0;
    } catch { /* ignore */ }

    if (!underlyingPrice || underlyingPrice <= 0) {
      try {
        const restMap = await fetchKiteQuotes([underlyingKiteId]);
        underlyingPrice = restMap?.[underlyingKiteId] ?? 0;
      } catch { /* ignore */ }
    }

    // Can't get live price → fail open (same as TradeEngine)
    if (!underlyingPrice || underlyingPrice <= 0) {
      return NextResponse.json({ allowed: true });
    }

    // ── 3. Validate ──────────────────────────────────────────────────────
    if (strikeRange > 0) {
      // Per-user distance-based check
      const diff = Math.abs(orderStrike - underlyingPrice);
      if (diff > strikeRange) {
        const min = Math.round(underlyingPrice - strikeRange);
        const max = Math.round(underlyingPrice + strikeRange);
        return NextResponse.json({ allowed: false, strike: orderStrike, min, max });
      }
      return NextResponse.json({ allowed: true });
    }

    // ── 4. Admin 11-strike window (strikeRange === 0) ────────────────────
    // Find the option's expiry
    const { data: instrRow } = await admin
      .from('instruments')
      .select('expiry')
      .eq('tradingsymbol', symbol)
      .limit(1)
      .single();

    if (!instrRow?.expiry) {
      return NextResponse.json({ allowed: true });
    }

    // Fetch all sibling strikes for this underlying + expiry
    const { data: siblingRows } = await admin
      .from('instruments')
      .select('strike_price')
      .eq('name', underlying)
      .eq('expiry', instrRow.expiry)
      .in('option_type', ['CE', 'PE']);

    if (!siblingRows || siblingRows.length === 0) {
      return NextResponse.json({ allowed: true });
    }

    const uniqueStrikes = Array.from(new Set(siblingRows.map(s => Number(s.strike_price))))
      .filter(s => s > 0)
      .sort((a, b) => a - b);

    if (uniqueStrikes.length === 0) {
      return NextResponse.json({ allowed: true });
    }

    // Find ATM index
    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < uniqueStrikes.length; i++) {
      const diff = Math.abs(uniqueStrikes[i] - underlyingPrice);
      if (diff < minDiff) { minDiff = diff; closestIdx = i; }
    }

    // Build 11-strike window centred on ATM
    const rangeCount = 11;
    const half = Math.floor(rangeCount / 2);
    let startIdx = closestIdx - half;
    let endIdx = closestIdx + half;
    if (startIdx < 0) { endIdx += Math.abs(startIdx); startIdx = 0; }
    if (endIdx >= uniqueStrikes.length) {
      startIdx = Math.max(0, startIdx - (endIdx - (uniqueStrikes.length - 1)));
      endIdx = uniqueStrikes.length - 1;
    }

    const allowedStrikes = uniqueStrikes.slice(startIdx, endIdx + 1);

    if (!allowedStrikes.includes(orderStrike)) {
      return NextResponse.json({
        allowed: false,
        strike: orderStrike,
        min: allowedStrikes[0],
        max: allowedStrikes[allowedStrikes.length - 1],
      });
    }

    return NextResponse.json({ allowed: true });

  } catch (err: any) {
    console.error('[strike-range-check]', err?.message);
    // Fail open — same as TradeEngine behaviour
    return NextResponse.json({ allowed: true });
  }
}
