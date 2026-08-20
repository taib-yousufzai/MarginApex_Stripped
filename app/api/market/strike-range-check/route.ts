/**
 * GET /api/market/strike-range-check?symbol=GOLD26AUG158500CE&spotPrice=157801
 *
 * Checks whether a given option symbol's strike price falls strictly within the
 * active 11-strike option-chain window centered around the live spot price.
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseOptionSymbol } from '@/lib/parseOptionSymbol';
import { validateOptionStrike } from '@/lib/trading/OptionStrikeValidator';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get('symbol') || '').trim().toUpperCase();

    if (!symbol) {
      return NextResponse.json({ allowed: true });
    }

    const parsed = parseOptionSymbol(symbol);
    if (!parsed) {
      return NextResponse.json({ allowed: true });
    }

    const valResult = await validateOptionStrike({
      symbol,
      isExit: false,
    });

    if (!valResult.allowed) {
      return NextResponse.json({
        allowed: false,
        strike: valResult.orderStrike,
        min: valResult.minAllowed,
        max: valResult.maxAllowed,
        reason: valResult.reason || `Strike price ${valResult.orderStrike} is outside the active option chain window (${valResult.minAllowed} to ${valResult.maxAllowed}).`,
      });
    }

    return NextResponse.json({ allowed: true, strike: valResult.orderStrike, min: valResult.minAllowed, max: valResult.maxAllowed });
  } catch (err: any) {
    console.error('[strike-range-check]', err?.message);
    return NextResponse.json({ allowed: true });
  }
}
