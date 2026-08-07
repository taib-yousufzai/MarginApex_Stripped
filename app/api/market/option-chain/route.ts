export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getRedisClient, isRedisMock } from '@/lib/redis';
import {
  loadStrikeConfig,
  applyExpiryFilter,
  applyStrikeRangeFilter,
  applyMcxStrikeRangeFilter,
  type Instrument,
} from '@/lib/filterEngine';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Helper function to map option symbol to DB key segment
function getOptionChainSegment(sym: string): string {
  const s = sym.toUpperCase().trim();
  if (['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(s)) {
    return 'INDEX-OPT';
  }
  if (['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI'].includes(s)) {
    return 'MCX-OPT';
  }
  return 'STOCK-OPT';
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    let symbol = (searchParams.get('symbol') || 'NIFTY').toUpperCase();
    if (symbol === 'MIDCAP') symbol = 'MIDCPNIFTY';
    const expiry = searchParams.get('expiry');
    const today = new Date().toISOString().split('T')[0];
    
    const cacheKey = `optionChain:${symbol}_${expiry || 'default'}`;
    const redis = getRedisClient();

    if (!isRedisMock()) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return NextResponse.json(JSON.parse(cached));
        }
      } catch (e) {
        console.error('Redis cache error for option chain:', e);
      }
    }

    let usedFallback = false;
    let atmPrice = 0;

    let targetExchanges = ['NFO', 'BFO'];
    if (['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI'].includes(symbol)) {
      targetExchanges = ['MCX'];
    }

    // 2. Parallelize Expiries query (Removed failing RPC to speed up fallback)
    const expiriesPromise = supabase
      .from('instruments')
      .select('expiry')
      .eq('name', symbol)
      .in('exchange', targetExchanges)
      .not('expiry', 'is', null)
      .gte('expiry', today)
      .in('option_type', ['CE', 'PE'])
      .order('expiry', { ascending: true });

    // 3. Parallelize Options query (if expiry is known upfront)
    let optionsPromise = null;
    if (expiry) {
      optionsPromise = supabase
        .from('instruments')
        .select('id, instrument_token, tradingsymbol, strike_price, option_type, exchange')
        .eq('name', symbol)
        .in('exchange', targetExchanges)
        .eq('expiry', expiry)
        .in('option_type', ['CE', 'PE'])
        .order('strike_price', { ascending: true });
    }

    // Wait for initial batch
    const [expiriesRes, optionsRes] = await Promise.all([
      expiriesPromise,
      optionsPromise || Promise.resolve({ data: null, error: null })
    ]);

    if (expiriesRes.error) throw expiriesRes.error;

    const allExpiries = Array.from(new Set(expiriesRes.data.map((e: any) => e.expiry))) as string[];
    // Collapse to nearest active expiry only (Requirement 4.2, 4.4)
    const activeExpiries = applyExpiryFilter(allExpiries, today);
    const uniqueExpiries = activeExpiries; // expose only the nearest active expiry
    const selectedExpiry = expiry || uniqueExpiries[0];
    let options = optionsRes?.data;

    // 4. Fetch Options if expiry was NOT known upfront (first page load)
    if (!expiry && selectedExpiry) {
      const secondRes = await supabase
        .from('instruments')
        .select('id, instrument_token, tradingsymbol, strike_price, option_type, exchange')
        .eq('name', symbol)
        .in('exchange', targetExchanges)
        .eq('expiry', selectedExpiry)
        .in('option_type', ['CE', 'PE'])
        .order('strike_price', { ascending: true });
      
      if (secondRes.error) throw secondRes.error;
      options = secondRes.data;
    }

    if (!selectedExpiry || !options) {
      return NextResponse.json({ 
        success: true, 
        expiries: uniqueExpiries, 
        strikes: [],
        message: 'No options found for this symbol' 
      });
    }

    let underlyingSymbol: string | undefined = undefined;

    // 5. Apply strike range filter using Redis ATM price
    if (options && options.length > 0) {
      try {
        const strikeConfig = await loadStrikeConfig(supabase);

        // Determine the segment to pick the right strike range
        const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(symbol);
        const isMcx = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI'].includes(symbol);
        const range = isMcx ? strikeConfig.mcxOptionsRange : strikeConfig.indexOptionsRange;

        const kiteIdMap: Record<string, string> = {
          'NIFTY': 'NSE:NIFTY 50', 'BANKNIFTY': 'NSE:NIFTY BANK',
          'FINNIFTY': 'NSE:NIFTY FIN SERVICE', 'MIDCPNIFTY': 'NSE:NIFTY MID SELECT',
          'SENSEX': 'BSE:SENSEX', 'BANKEX': 'BSE:BANKEX',
        };
        underlyingSymbol = kiteIdMap[symbol] ?? `MCX:${symbol}`;

        const spotParam = searchParams.get('spotPrice');
        if (spotParam) {
          atmPrice = parseFloat(spotParam) || 0;
        }

        if (!atmPrice) {

        if (isMcx) {
          let baseSymbol = symbol;
          if (symbol === 'GOLDM') baseSymbol = 'GOLD';
          else if (symbol === 'SILVERM') baseSymbol = 'SILVER';
          else if (symbol === 'CRUDEOILM') baseSymbol = 'CRUDEOIL';
          else if (symbol === 'NATGASMINI') baseSymbol = 'NATURALGAS';

          const futRes = await supabase
            .from('instruments')
            .select('tradingsymbol')
            .eq('name', baseSymbol)
            .eq('segment', 'MCX-FUT')
            .gte('expiry', today)
            .order('expiry', { ascending: true })
            .limit(1);

          if (futRes.data && futRes.data.length > 0) {
            const futSymbol = futRes.data[0].tradingsymbol;
            underlyingSymbol = `MCX:${futSymbol}`;
            const futCached = await redis.hget('market:quotes', underlyingSymbol);
            if (futCached) {
              const q = JSON.parse(futCached);
              atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
            }
          }

          if (!atmPrice) {
            const directFutRes = await supabase
              .from('instruments')
              .select('tradingsymbol')
              .eq('name', symbol)
              .eq('segment', 'MCX-FUT')
              .gte('expiry', today)
              .order('expiry', { ascending: true })
              .limit(1);
            if (directFutRes.data && directFutRes.data.length > 0) {
              const directFutSymbol = directFutRes.data[0].tradingsymbol;
              const directUnderlyingSymbol = `MCX:${directFutSymbol}`;
              const directFutCached = await redis.hget('market:quotes', directUnderlyingSymbol);
              if (directFutCached) {
                const q = JSON.parse(directFutCached);
                atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
                underlyingSymbol = directUnderlyingSymbol;
              }
            }
          }
        } else {
          // For indices, rely on the kiteId cache
          const cached = await redis.hget('market:quotes', underlyingSymbol);
          if (cached) {
            const q = JSON.parse(cached);
            atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
          }
          if (!atmPrice) {
            const altKey = underlyingSymbol.split(':')[1] || symbol;
            const altCached = await redis.hget('market:quotes', altKey);
            if (altCached) {
              const q = JSON.parse(altCached);
              atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
            }
          }
        }
      }

      if (!atmPrice && options.length > 0) {
          console.warn(`[option-chain] Redis ATM price unavailable for ${symbol}, falling back to median strike`);
          usedFallback = true;
          const middleIndex = Math.floor(options.length / 2);
          atmPrice = (options as any[])[middleIndex]?.strike_price || 0;
        }
        if (atmPrice) {
          if (isMcx) {
            options = applyMcxStrikeRangeFilter(options as any[], atmPrice) as any[];
          } else {
            options = applyStrikeRangeFilter(options as any[], atmPrice, range) as any[];
          }
        }
      } catch (e) {
        console.error(`[option-chain] Strike range filter error for ${symbol}:`, e);
      }
    }

    // 6. Group by strike price
    const strikeMap: Record<number, any> = {};
    options.forEach(opt => {
      const strike = opt.strike_price;
      if (!strikeMap[strike]) {
        strikeMap[strike] = { strike };
      }
      const kiteId = `${opt.exchange}:${opt.tradingsymbol}`;
      if (opt.option_type === 'CE') {
        strikeMap[strike].ce = {
          token: opt.instrument_token,
          symbol: opt.tradingsymbol,
          id: kiteId
        };
      } else {
        strikeMap[strike].pe = {
          token: opt.instrument_token,
          symbol: opt.tradingsymbol,
          id: kiteId
        };
      }
    });

    const sortedStrikes = Object.values(strikeMap).sort((a: any, b: any) => a.strike - b.strike);

    const kiteIdMapFallback: Record<string, string> = {
      'NIFTY': 'NSE:NIFTY 50', 'BANKNIFTY': 'NSE:NIFTY BANK',
      'FINNIFTY': 'NSE:NIFTY FIN SERVICE', 'MIDCPNIFTY': 'NSE:NIFTY MID SELECT',
      'SENSEX': 'BSE:SENSEX', 'BANKEX': 'BSE:BANKEX',
    };
    let finalUnderlyingSymbol = underlyingSymbol || kiteIdMapFallback[symbol] || `MCX:${symbol}`;

    const responseData = {
      success: true,
      symbol,
      expiry: selectedExpiry,
      expiries: uniqueExpiries,
      strikes: sortedStrikes,
      underlyingPrice: atmPrice,
      underlyingSymbol: (typeof underlyingSymbol !== 'undefined') ? underlyingSymbol : finalUnderlyingSymbol
    };

    // Store in cache only if we got a real spot price
    if (!usedFallback && !isRedisMock()) {
      try {
        await redis.setex(cacheKey, 60, JSON.stringify(responseData));
        await redis.setex(`optionChain:${symbol}_${selectedExpiry}`, 60, JSON.stringify(responseData));
      } catch (e) {
        console.error('Redis cache set error for option chain:', e);
      }
    }

    return NextResponse.json(responseData);
  } catch (error: any) {
    console.error('[Option Chain API] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
