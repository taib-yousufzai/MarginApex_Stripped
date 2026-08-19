/**
 * GET /api/market/strike-range-check?symbol=GOLD26AUG158500CE
 *
 * Checks whether a given option symbol's strike price falls within the
 * active 11-strike option-chain window or user's configured strike_range.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, getAdminClient } from '@/lib/adminClient';
import { parseOptionSymbol } from '@/lib/parseOptionSymbol';
import { validateOptionStrike } from '@/lib/trading/OptionStrikeValidator';

export const dynamic = 'force-dynamic';

const MCX_UNDERLYINGS = new Set([
  'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'SILVERMIC',
  'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI',
  'COPPER', 'ZINC', 'ZINCMINI', 'LEAD', 'LEADMINI',
  'ALUMINIUM', 'ALUMINI',
]);

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

    const { underlying } = parsed;
    const admin = getAdminClient();
    const user = await getUserFromRequest(request);
    let strikeRangeSetting = 0;

    if (user) {
      const { data: profile } = await admin
        .from('profiles')
        .select('parent_id, trading_mode')
        .eq('id', user.id)
        .single();

      if (profile) {
        const isMcx = MCX_UNDERLYINGS.has(underlying.toUpperCase());
        const dbSegment = isMcx ? 'MCX-OPT' : (
          ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(underlying.toUpperCase())
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
          strikeRangeSetting = Number(segRows[0].strike_range || 0);
        }
      }
    }

    const spotParam = searchParams.get('spotPrice');
    const spotPrice = spotParam ? parseFloat(spotParam) : 0;

    const valResult = await validateOptionStrike({
      symbol,
      isExit: false,
      knownQuotesMap: spotPrice > 0 ? { [symbol]: spotPrice, spotPrice } : undefined,
    });

    if (!valResult.allowed) {
      return NextResponse.json({
        allowed: false,
        strike: valResult.orderStrike,
        min: valResult.minAllowed,
        max: valResult.maxAllowed,
        reason: valResult.reason,
      });
    }

    return NextResponse.json({ allowed: true });
  } catch (err: any) {
    console.error('[strike-range-check]', err?.message);
    return NextResponse.json({ allowed: true });
  }
}
