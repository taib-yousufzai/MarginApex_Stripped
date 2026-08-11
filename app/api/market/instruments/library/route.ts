import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getRedisClient } from '@/lib/redis';
import {
  loadStrikeConfig,
  applyForexFilter,
  applyCryptoWhitelist,
  applyExpiryFilter,
  applyStrikeRangeFilter,
  applyMcxStrikeRangeFilter,
  type Instrument,
} from '@/lib/filterEngine';

export const dynamic = 'force-dynamic';

function safeOptName(i: any) {
  const isRealValue = (v: any) => v !== null && v !== undefined && String(v).toLowerCase() !== 'null' && String(v).trim() !== '';
  if (isRealValue(i.strike_price) && isRealValue(i.option_type)) {
    const underlying = isRealValue(i.underlying_symbol) ? i.underlying_symbol : (isRealValue(i.tradingsymbol) ? i.tradingsymbol : '');
    return `${underlying} ${i.strike_price} ${i.option_type}`.trim();
  }
  return isRealValue(i.tradingsymbol) ? i.tradingsymbol : 'Unknown';
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export async function GET() {
  try {
    const redis = getRedisClient();
    const cacheKey = 'market:library:segments';
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return NextResponse.json(JSON.parse(cached));
      }
    } catch (e) {
      console.error('[library] Redis get cache error:', e);
    }

    const today = new Date().toISOString().split('T')[0];
    const segments: any[] = [];
    let usedFallback = false;

    // Load strike config once for the entire request
    const strikeConfig = await loadStrikeConfig(getSupabase());

    // 1. Index-FUT
    const { data: indexFuts } = await getSupabase()
      .from('instruments')
      .select('tradingsymbol, name, exchange, instrument_type, segment, expiry')
      .in('name', ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'])
      .in('instrument_type', ['FUTIDX', 'FUT', 'MAPPED_FUT'])
      .gte('expiry', today)
      .order('expiry', { ascending: true })
      .limit(30);

    if (indexFuts && indexFuts.length > 0) {
      const earliestExpiries = new Map();
      indexFuts.forEach(f => {
        if (!earliestExpiries.has(f.name) || f.expiry < earliestExpiries.get(f.name).expiry) {
          earliestExpiries.set(f.name, f);
        }
      });
      segments.push({
        name: 'INDEX-FUT',
        icon: 'fa-chart-line',
        instruments: Array.from(earliestExpiries.values()).map(i => ({
          name: i.tradingsymbol, symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
          price: 0, change: '0%', segment: `${i.exchange === 'NFO' ? 'NSE' : i.exchange === 'BFO' ? 'BSE' : i.exchange} - Futures`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size
        }))
      });
    }

    // 2. Index-OPT — apply applyExpiryFilter + applyStrikeRangeFilter
    const kiteIdMap: Record<string, string> = {
      'NIFTY': 'NSE:NIFTY 50',
      'BANKNIFTY': 'NSE:NIFTY BANK',
      'FINNIFTY': 'NSE:NIFTY FIN SERVICE',
      'MIDCPNIFTY': 'NSE:NIFTY MID SELECT',
      'SENSEX': 'BSE:SENSEX',
      'BANKEX': 'BSE:BANKEX',
    };

    const indexOptCats = (await Promise.all(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].map(async (idx) => {
      const { data: expData } = await getSupabase().rpc('get_option_expiries', { p_symbol: idx, p_min_date: today });
      if (!expData || expData.length === 0) return null;

      // Apply expiry filter — nearest active only
      const allExpiries: string[] = expData.map((e: any) => e.expiry);
      const activeExpiries = applyExpiryFilter(allExpiries, today);
      if (activeExpiries.length === 0) return null;
      const nearestExpiry = activeExpiries[0];

      const { data: opts } = await getSupabase()
        .from('instruments')
        .select('tradingsymbol, name, exchange, instrument_type, strike_price, option_type, expiry, underlying_symbol')
        .eq('name', idx)
        .eq('expiry', nearestExpiry)
        .order('strike_price', { ascending: true });

      if (!opts || opts.length === 0) return null;

      // Apply strike range filter using Redis ATM price
      let selectedOpts: Instrument[] = opts as Instrument[];
      try {
        const kiteId = kiteIdMap[idx];
        if (kiteId) {
          const cached = await redis.hget('market:quotes', kiteId);
          let atmPrice = 0;
          if (cached) {
            const q = JSON.parse(cached);
            atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
          }
          if (!atmPrice) {
            const altKey = kiteId.split(':')[1] || idx;
            const altCached = await redis.hget('market:quotes', altKey);
            if (altCached) {
              const q = JSON.parse(altCached);
              atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
            }
          }
          if (!atmPrice && opts.length > 0) {
            console.warn(`[library] Redis ATM price unavailable for ${idx}, falling back to median strike`);
            usedFallback = true;
            const middleIndex = Math.floor(opts.length / 2);
            atmPrice = (opts as Instrument[])[middleIndex]?.strike_price || 0;
          }
          if (atmPrice) {
            selectedOpts = applyStrikeRangeFilter(opts as Instrument[], atmPrice, strikeConfig.indexOptionsRange);
          }
        }
      } catch (e) {
        console.error(`[library] Failed to apply strike range filter for ${idx}:`, e);
      }

      return {
        name: `${idx} Options`,
        instruments: selectedOpts.map((i: any) => ({
          name: safeOptName(i), symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
          price: 0, change: '0%', segment: `${i.exchange === 'NFO' ? 'NSE' : i.exchange === 'BFO' ? 'BSE' : i.exchange} - Options`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size
        }))
      };
    }))).filter(Boolean);
    if (indexOptCats.length > 0) segments.push({ name: 'INDEX-OPT', icon: 'fa-chart-pie', subCategories: indexOptCats });

    // 3. Mcx-FUT & Mcx-OPT — apply applyExpiryFilter + applyStrikeRangeFilter for OPT
    const commodities = ['CRUDEOIL', 'CRUDEOILM', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'SILVERMIC', 'NATURALGAS', 'NATGASMINI', 'ALUMINIUM', 'ALUMINI', 'ZINC', 'ZINCMINI', 'LEAD', 'LEADMINI', 'COPPER'];
    const mcxFutInstruments: any[] = [];  // flat list — no subCategories
    const mcxOptCats: any[] = [];

    await Promise.all(commodities.map(async (cmd) => {
      // FUT — collect directly into flat instruments array
      const { data: futs } = await getSupabase().from('instruments').select('*').eq('name', cmd).in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT']).gte('expiry', today).order('expiry', { ascending: true }).limit(2);
      if (futs && futs.length > 0) {
        futs.forEach((i: any) => mcxFutInstruments.push({
          name: i.tradingsymbol, symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
          price: 0, change: '0%', segment: `${i.exchange} - Futures`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size
        }));
      }
      // OPT — apply expiry + strike range filter
      const { data: expData } = await getSupabase().from('instruments').select('expiry').eq('name', cmd).in('instrument_type', ['CE', 'PE', 'FUTOPT']).gte('expiry', today);
      if (expData && expData.length > 0) {
        const allExpiries: string[] = [...new Set(expData.map((e: any) => e.expiry))];
        const activeExpiries = applyExpiryFilter(allExpiries, today);
        if (activeExpiries.length === 0) return;
        const nearestExpiry = activeExpiries[0];

        const { data: opts } = await getSupabase().from('instruments').select('*').eq('name', cmd).eq('expiry', nearestExpiry).order('strike_price', { ascending: true });
        if (opts && opts.length > 0) {
          let selectedOpts: Instrument[] = opts as Instrument[];
          try {
            // MCX ATM price — use nearest future's market quote instead of spot
            let atmPrice = 0;
            if (futs && futs.length > 0) {
              const nearestFut = futs[0];
              const kiteId = `${nearestFut.exchange}:${nearestFut.tradingsymbol}`;
              const cached = await redis.hget('market:quotes', kiteId);
              if (cached) {
                const q = JSON.parse(cached);
                atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
              }
              if (!atmPrice) {
                const altKey = nearestFut.tradingsymbol;
                const altCached = await redis.hget('market:quotes', altKey);
                if (altCached) {
                  const q = JSON.parse(altCached);
                  atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
                }
              }
            }
            if (!atmPrice && opts.length > 0) {
              console.warn(`[library] No ATM price for MCX ${cmd}, falling back to median strike`);
              usedFallback = true;
              const middleIndex = Math.floor(opts.length / 2);
              atmPrice = (opts as Instrument[])[middleIndex]?.strike_price || 0;
            }
            if (atmPrice) {
              selectedOpts = applyMcxStrikeRangeFilter(opts as Instrument[], atmPrice);
            }
          } catch (e) {
            console.error(`[library] Failed to apply strike range filter for MCX ${cmd}:`, e);
          }

          mcxOptCats.push({
            name: cmd,
            instruments: selectedOpts.map((i: any) => ({ name: safeOptName(i), symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`, price: 0, change: '0%', segment: `${i.exchange} - Options`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size }))
          });
        }
      }
    }));

    if (mcxFutInstruments.length > 0) segments.push({ name: 'MCX-FUT', icon: 'fa-oil-well', instruments: mcxFutInstruments });
    if (mcxOptCats.length > 0) segments.push({ name: 'MCX-OPT', icon: 'fa-oil-well', subCategories: mcxOptCats });

    // 4. Stock-FUT, Stock-OPT, Nse-EQ
    const topStocks = ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'ITC', 'TCS', 'LT', 'BHARTIARTL', 'SBIN', 'BAJFINANCE', 'AXISBANK', 'KOTAKBANK', 'M&M', 'TATAMOTORS', 'MARUTI', 'SUNPHARMA', 'ASIANPAINT', 'HCLTECH', 'TITAN', 'ULTRACEMCO'];
    const stockFutInstruments: any[] = [];  // flat
    const stockOptCats: any[] = [];
    const nseEqInstruments: any[] = [];     // flat

    await Promise.all(topStocks.map(async (stk) => {
      // FUT — flat into instruments array
      const { data: futs } = await getSupabase().from('instruments').select('*').eq('name', stk).in('instrument_type', ['FUTSTK', 'FUT', 'MAPPED_FUT']).gte('expiry', today).order('expiry', { ascending: true }).limit(2);
      if (futs && futs.length > 0) {
        futs.forEach((i: any) => stockFutInstruments.push({
          name: i.tradingsymbol, symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
          price: 0, change: '0%', segment: `${i.exchange === 'NFO' ? 'NSE' : i.exchange === 'BFO' ? 'BSE' : i.exchange} - Stock Futures`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size
        }));
      }
      // OPT
      const { data: expData } = await getSupabase().rpc('get_option_expiries', { p_symbol: stk, p_min_date: today });
      if (expData && expData.length > 0) {
        const nearestExpiry = expData[0].expiry;
        const { data: opts } = await getSupabase().from('instruments').select('*').eq('name', stk).eq('expiry', nearestExpiry).order('strike_price', { ascending: true });
        if (opts && opts.length > 0) {
          let selectedOpts: Instrument[] = opts as Instrument[];
          try {
            const kiteId = `NSE:${stk}`;
            const cached = await redis.hget('market:quotes', kiteId);
            let atmPrice = 0;
            if (cached) {
              const q = JSON.parse(cached);
              atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
            }
            if (!atmPrice) {
              const altKey = stk;
              const altCached = await redis.hget('market:quotes', altKey);
              if (altCached) {
                const q = JSON.parse(altCached);
                atmPrice = q.last_price || q.ohlc?.close || q.close || 0;
              }
            }
            if (!atmPrice && opts.length > 0) {
              console.warn(`[library] No ATM price for Stock ${stk}, falling back to median strike`);
              usedFallback = true;
              const middleIndex = Math.floor(opts.length / 2);
              atmPrice = (opts as Instrument[])[middleIndex]?.strike_price || 0;
            }
            if (atmPrice) {
              selectedOpts = applyStrikeRangeFilter(opts as Instrument[], atmPrice, strikeConfig.indexOptionsRange);
            }
          } catch (e) {
            console.error(`[library] Failed to apply strike range filter for Stock ${stk}:`, e);
          }

          stockOptCats.push({
            name: stk,
            instruments: selectedOpts.map((i: any) => ({ name: safeOptName(i), symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`, price: 0, change: '0%', segment: `${i.exchange === 'NFO' ? 'NSE' : i.exchange === 'BFO' ? 'BSE' : i.exchange} - Stock Options`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size }))
          });
        }
      }
      // EQ — flat into instruments array
      const { data: eq } = await getSupabase().from('instruments').select('*').eq('instrument_type', 'EQ').eq('tradingsymbol', stk).limit(1);
      if (eq && eq.length > 0) {
        eq.forEach((i: any) => nseEqInstruments.push({
          name: `${i.tradingsymbol} (EQ)`, symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`,
          price: 0, change: '0%', segment: `${i.exchange} - Equity`, contractDate: '', open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size
        }));
      }
    }));

    if (stockFutInstruments.length > 0) segments.push({ name: 'STOCK-FUT', icon: 'fa-building', instruments: stockFutInstruments });
    if (stockOptCats.length > 0) segments.push({ name: 'STOCK-OPT', icon: 'fa-building', subCategories: stockOptCats });
    if (nseEqInstruments.length > 0) segments.push({ name: 'NSE-EQ', icon: 'fa-building', instruments: nseEqInstruments });

    // 5. Crypto — apply applyCryptoWhitelist
    const { data: cryptos } = await getSupabase().from('instruments').select('*').eq('segment', 'CRYPTO').order('name', { ascending: true });
    if (cryptos && cryptos.length > 0) {
      const whitelisted = applyCryptoWhitelist(cryptos as Instrument[]);
      const uniqueCryptos = new Map();
      whitelisted.forEach((c: any) => {
        if (!uniqueCryptos.has(c.tradingsymbol) || c.id === c.tradingsymbol) {
          uniqueCryptos.set(c.tradingsymbol, c);
        }
      });
      if (uniqueCryptos.size > 0) {
        segments.push({
          name: 'Crypto',
          icon: 'fa-bitcoin',
          instruments: Array.from(uniqueCryptos.values()).map((i: any) => ({
            name: i.tradingsymbol, symbol: i.tradingsymbol, kiteSymbol: i.id,
            price: 0, change: '0%', segment: 'CRYPTO', contractDate: '', open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size
          }))
        });
      }
    }

    // 6. Comex
    const { data: comex } = await getSupabase().from('instruments').select('*').eq('segment', 'COMEX').order('name', { ascending: true });
    if (comex && comex.length > 0) {
      const { data: mcxFuts } = await getSupabase()
        .from('instruments')
        .select('tradingsymbol, name, exchange, expiry')
        .eq('exchange', 'MCX')
        .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
        .gte('expiry', today);

      const mcxMap = new Map();
      if (mcxFuts) {
        mcxFuts.forEach(f => {
          if (!mcxMap.has(f.name) || f.expiry < mcxMap.get(f.name).expiry) {
            mcxMap.set(f.name, f);
          }
        });
      }

      const tickerMap: Record<string, string> = {
        'GC=F': 'GOLD',
        'SI=F': 'SILVER',
        'CL=F': 'CRUDEOIL',
        'HG=F': 'COPPER',
      };

      const symbolMap: Record<string, string> = {
        'GC=F': 'GOLD_FUT',
        'SI=F': 'SILVER_FUT',
        'CL=F': 'CRUDEOIL_FUT',
        'HG=F': 'COPPER_FUT',
      };

      segments.push({
        name: 'COMEX',
        icon: 'fa-globe',
        instruments: comex.map((i: any) => {
          const mcxUnderlying = tickerMap[i.id];
          const matchedMcx = mcxUnderlying ? mcxMap.get(mcxUnderlying) : null;
          return {
            name: i.tradingsymbol,
            symbol: symbolMap[i.id] || i.tradingsymbol,
            kiteSymbol: matchedMcx ? `MCX:${matchedMcx.tradingsymbol}` : '',
            comexSymbol: i.id,
            price: 0,
            change: '0%',
            segment: matchedMcx ? 'MCX - Futures' : 'COMEX',
            contractDate: matchedMcx ? matchedMcx.expiry : '',
            open: 0,
            high: 0,
            low: 0,
            close: 0,
            category: 'COI'
          };
        })
      });
    }

    // 7. Forex — apply applyForexFilter (excludes CE/PE options, keeps Futures only)
    const currencies = ['USDINR', 'EURINR', 'GBPINR', 'JPYINR'];
    const forexInstruments: any[] = [];  // flat — no subCategories

    await Promise.all(currencies.map(async (curr) => {
      const { data: futs } = await getSupabase().from('instruments').select('*').eq('name', curr).in('instrument_type', ['FUTCUR', 'FUT', 'MAPPED_FUT']).gte('expiry', today).order('expiry', { ascending: true }).limit(2);
      const { data: expData } = await getSupabase().rpc('get_option_expiries', { p_symbol: curr, p_min_date: today });
      let opts: any[] | null = null;
      if (expData && expData.length > 0) {
        const nearestExpiry = expData[0].expiry;
        const { data } = await getSupabase().from('instruments').select('*').eq('name', curr).eq('expiry', nearestExpiry).order('strike_price', { ascending: true });
        opts = data;
      }

      // Combine futs + opts, apply forex filter (removes CE/PE), push flat
      const combined: Instrument[] = [...(futs ?? []), ...(opts ?? [])] as Instrument[];
      const filtered = applyForexFilter(combined);

      filtered.forEach((i: any) => {
        const entry = ['CE', 'PE'].includes(i.option_type)
          ? { name: safeOptName(i), symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`, price: 0, change: '0%', segment: `${i.exchange} - Options`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size }
          : { name: i.tradingsymbol, symbol: i.tradingsymbol, kiteSymbol: `${i.exchange}:${i.tradingsymbol}`, price: 0, change: '0%', segment: `${i.exchange} - Futures`, contractDate: i.expiry, open: 0, high: 0, low: 0, close: 0, lotSize: i.lot_size };
        forexInstruments.push(entry);
      });
    }));

    if (forexInstruments.length > 0) segments.push({ name: 'FOREX', icon: 'fa-coins', instruments: forexInstruments });

    try {
      // Cache for 15 mins when ATM prices were live; 2 mins when using fallback prices
      const ttl = usedFallback ? 120 : 900;
      await redis.set(cacheKey, JSON.stringify({ segments }), 'EX', ttl);
    } catch (e) {
      console.error('[library] Redis set cache error:', e);
    }

    return NextResponse.json({ segments });
  } catch (error: any) {
    console.error('Library API Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
