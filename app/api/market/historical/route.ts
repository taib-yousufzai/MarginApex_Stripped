import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSharedKiteSession } from '@/lib/kiteSession';
import { getRedisClient, isRedisMock } from '@/lib/redis';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Resolve a symbol to an instrument_token.
 * Runs strategies in parallel for speed.
 */
/**
 * Resolve a symbol to { token, canonicalId }.
 * Returns both in one call so the caller avoids a serial reverse-lookup.
 * Result is cached in Redis for 24 h.
 */
export async function resolveInstrument(symbol: string): Promise<{ token: number; canonicalId: string } | null> {
  const redis = getRedisClient();
  const cacheKey = `instrument_v2:${symbol}`;

  if (!isRedisMock()) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {}
  }

  const select = 'id, instrument_token';
  const toResult = (data: any) => data?.instrument_token ? { token: data.instrument_token as number, canonicalId: data.id as string } : null;

  // Fast path: fully-qualified id (e.g. "NFO:NIFTY2661623700CE")
  if (symbol.includes(':')) {
    const { data } = await supabase.from('instruments').select(select).eq('id', symbol).single();
    const r = toResult(data);
    if (r) { await cacheResult(redis, cacheKey, r); return r; }
  }

  const cleanSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  const upperSymbol = cleanSymbol.toUpperCase().trim();

  // Index shortcuts
  const baseIndices: Record<string, string> = {
    'NIFTY': 'NSE:NIFTY 50', 'NIFTY 50': 'NSE:NIFTY 50',
    'BANKNIFTY': 'NSE:NIFTY BANK', 'NIFTY BANK': 'NSE:NIFTY BANK',
    'FINNIFTY': 'NSE:NIFTY FIN SERVICE',
    'SENSEX': 'BSE:SENSEX', 'BANKEX': 'BSE:BANKEX',
  };
  if (baseIndices[upperSymbol]) {
    const { data } = await supabase.from('instruments').select(select).eq('id', baseIndices[upperSymbol]).single();
    const r = toResult(data);
    if (r) { await cacheResult(redis, cacheKey, r); return r; }
  }

  // Commodity/currency front-month
  const baseCommodities = ['GOLD', 'CRUDEOIL', 'SILVER', 'NATURALGAS', 'USDINR'];
  if (baseCommodities.includes(upperSymbol)) {
    const isCurrency = upperSymbol === 'USDINR';
    const exchange = isCurrency ? 'CDS' : 'MCX';
    const instrumentTypes = isCurrency ? ['FUT'] : ['FUTCOM', 'FUT', 'MAPPED_FUT'];
    const { data } = await supabase.from('instruments').select(select)
      .eq('name', upperSymbol).eq('exchange', exchange).in('instrument_type', instrumentTypes)
      .gte('expiry', new Date().toISOString().split('T')[0])
      .order('expiry', { ascending: true }).limit(1).maybeSingle();
    const r = toResult(data);
    if (r) { await cacheResult(redis, cacheKey, r); return r; }
  }

  // Slow path: fire strategies in parallel
  const exchanges = ['NSE', 'NFO', 'MCX', 'BSE', 'BFO', 'CDS'];
  const hasUnderscore = symbol.includes('_');
  const baseName = hasUnderscore ? symbol.split('_')[0] : symbol;

  const queries: PromiseLike<{ token: number; canonicalId: string } | null>[] = [
    supabase.from('instruments').select(select).eq('id', symbol).single().then(r => toResult(r.data)),
    supabase.from('instruments').select(select).eq('tradingsymbol', symbol).limit(1).single().then(r => toResult(r.data)),
    ...exchanges.map(ex => supabase.from('instruments').select(select).eq('id', `${ex}:${symbol}`).single().then(r => toResult(r.data))),
  ];
  if (hasUnderscore) {
    queries.push(...exchanges.map(ex =>
      supabase.from('instruments').select(select).eq('id', `${ex}:${baseName}`).eq('instrument_type', 'MAPPED_FUT').single().then(r => toResult(r.data))
    ));
    queries.push(
      supabase.from('instruments').select(select + ', instrument_type')
        .ilike('tradingsymbol', symbol.replace(/_/g, '%')).in('exchange', exchanges)
        .order('instrument_type', { ascending: true }).limit(5)
        .then(r => {
          if (!r.data?.length) return null;
          const mapped = r.data.find((m: any) => m.instrument_type === 'MAPPED_FUT');
          return toResult(mapped || r.data[0]);
        })
    );
  }

  const results = await Promise.all(queries);
  const found = results.find(r => r !== null) ?? null;
  if (found) await cacheResult(redis, cacheKey, found);
  return found;
}

async function cacheResult(redis: any, key: string, value: any) {
  if (!isRedisMock()) {
    try { await redis.setex(key, 86400, JSON.stringify(value)); } catch {}
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');
    const rawInterval = searchParams.get('interval') || 'day';
    
    // Map standard chart interval codes to Zerodha Kite API compatible strings
    const mapInterval = (inter: string): string => {
      const normalized = inter.toLowerCase().trim();
      if (normalized === '1m' || normalized === '1min' || normalized === 'minute') return 'minute';
      if (normalized === '3m' || normalized === '3min' || normalized === '3minute') return '3minute';
      if (normalized === '5m' || normalized === '5min' || normalized === '5minute') return '5minute';
      if (normalized === '10m' || normalized === '10min' || normalized === '10minute') return '10minute';
      if (normalized === '15m' || normalized === '15min' || normalized === '15minute') return '15minute';
      if (normalized === '30m' || normalized === '30min' || normalized === '30minute') return '30minute';
      if (normalized === '60m' || normalized === '60min' || normalized === '60minute' || normalized === '1h' || normalized === 'hour') return '60minute';
      if (normalized === 'day' || normalized === 'd' || normalized === '1d') return 'day';
      return inter;
    };
    
    const interval = mapInterval(rawInterval);
    const toVal = searchParams.get('to') || new Date().toISOString().slice(0, 10);
    let fromVal = searchParams.get('from');
    if (!fromVal) {
      const fromDate = new Date();
      if (interval.includes('minute') || interval.includes('min') || interval === '60m' || interval === '30m' || interval === '15m' || interval === '5m' || interval === '1m') {
        fromDate.setDate(fromDate.getDate() - 7); // 7 days ago for intraday
      } else {
        fromDate.setFullYear(fromDate.getFullYear() - 1); // 1 year ago for daily/weekly
      }
      fromVal = fromDate.toISOString().slice(0, 10);
    }

    if (!symbol) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const from = fromVal;
    const to = toVal;

    // Run session fetch and symbol resolution in PARALLEL (they're independent)
    const [session, instrument] = await Promise.all([
      getSharedKiteSession(),
      resolveInstrument(symbol)
    ]);

    if (!session) {
      return NextResponse.json({ error: 'No active Kite session found' }, { status: 401 });
    }
    if (!instrument) {
      return NextResponse.json({ error: `Instrument not found for symbol: ${symbol}` }, { status: 404 });
    }

    const instrumentToken = instrument.token;
    const canonicalSymbol = instrument.canonicalId || symbol;

    const redis = getRedisClient();
    const cacheKey = `historical:${instrumentToken}:${interval}:${from}:${to}`;

    if (!isRedisMock()) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return NextResponse.json(JSON.parse(cached));
        }
      } catch (e) {
        console.error('Redis cache error for historical data:', e);
      }
    }

    // Fetch from Kite Historical API
    let candlesData: any[] | null = null;
    let kiteError: string | null = null;
    
    try {
      const url = `https://api.kite.trade/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      // Use shorter timeout for intraday (user feels the wait more) vs daily charts
      const kiteTimeoutMs = interval === 'day' || interval === 'week' ? 3000 : 2000;
      const response = await fetch(url, {
        headers: {
          'X-Kite-Version': '3',
          'Authorization': `token ${process.env.KITE_API_KEY || process.env.NEXT_PUBLIC_KITE_API_KEY}:${session.accessToken}`
        },
        signal: AbortSignal.timeout(kiteTimeoutMs)
      });
      const data = await response.json();
      if (response.ok && data.status === 'success' && data.data && Array.isArray(data.data.candles)) {
        candlesData = data.data.candles;
      } else {
        kiteError = data.message || data.error_type || 'Kite API error';
      }
    } catch (err: any) {
      kiteError = err.message || 'Kite fetch exception';
    }

    // Fallback 1: Query local historical_candles DB table (highly useful for MCX Options and Kite outages)
    if (!candlesData || candlesData.length === 0) {
      console.warn(`[historical] Kite fetch unavailable or returned empty for ${canonicalSymbol} (Reason: ${kiteError}). Falling back to local DB historical_candles.`);
      try {
        const { data: dbData, error: dbError } = await supabase
          .from('historical_candles')
          .select('timestamp, open, high, low, close, volume')
          .eq('symbol', canonicalSymbol)
          .eq('interval', interval)
          .gte('timestamp', from)
          .lte('timestamp', to)
          .order('timestamp', { ascending: true })
          .limit(1000);
        
        if (!dbError && dbData && dbData.length > 0) {
          candlesData = dbData.map((c: any) => [
            c.timestamp,
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume
          ]);
        }
      } catch (dbErr) {
        console.error('[historical] Failed to query local fallback candles:', dbErr);
      }
    }

    // Fallback 2: Synthesize a sequence of flat placeholder candles using the latest LTP
    if (!candlesData || candlesData.length === 0) {
      console.warn(`[historical] No historical data found in Kite or DB for ${canonicalSymbol}. Synthesizing flat-line placeholder candles.`);
      let lastPrice = 0;
      try {
        const cachedQuote = await redis.hget('market:quotes', canonicalSymbol);
        if (cachedQuote) {
          const parsed = JSON.parse(cachedQuote);
          lastPrice = parsed.last_price || parsed.close || 0;
        }
      } catch (e) {}

      if (lastPrice === 0) {
        try {
          const { data: instData } = await supabase
            .from('instruments')
            .select('last_price')
            .eq('id', canonicalSymbol)
            .single();
          if (instData?.last_price) {
            lastPrice = Number(instData.last_price);
          }
        } catch (e) {}
      }

      if (lastPrice > 0) {
        let spacingMs = 60 * 1000;
        const normalized = interval.toLowerCase();
        if (normalized.includes('3min')) spacingMs = 3 * 60 * 1000;
        else if (normalized.includes('5min')) spacingMs = 5 * 60 * 1000;
        else if (normalized.includes('10min')) spacingMs = 10 * 60 * 1000;
        else if (normalized.includes('15min')) spacingMs = 15 * 60 * 1000;
        else if (normalized.includes('30min')) spacingMs = 30 * 60 * 1000;
        else if (normalized.includes('60min') || normalized.includes('hour')) spacingMs = 60 * 60 * 1000;
        else if (normalized.includes('day') || normalized.includes('1d')) spacingMs = 24 * 60 * 60 * 1000;

        const nowMs = Date.now();
        candlesData = [];
        for (let i = 99; i >= 0; i--) {
          const candleTime = new Date(nowMs - i * spacingMs).toISOString();
          candlesData.push([
            candleTime,
            lastPrice,
            lastPrice,
            lastPrice,
            lastPrice,
            0
          ]);
        }
      } else {
        candlesData = [];
      }
    }

    const result = { candles: candlesData };

    // Intraday TTL: 60s  |  Daily/Weekly TTL: 1h
    const ttl = (interval === 'day' || interval === 'week') ? 3600 : 60;

    if (!isRedisMock() && candlesData && candlesData.length > 0) {
      try {
        await redis.setex(cacheKey, ttl, JSON.stringify(result));
      } catch (e) {
        console.error('Redis cache set error for historical data:', e);
      }
    }

    // Let the browser cache the response too (reduces repeat fetches on same symbol/timeframe)
    const cacheControl = interval === 'day' || interval === 'week'
      ? 'public, max-age=300, stale-while-revalidate=3600'  // daily: 5m fresh, 1h stale
      : 'public, max-age=30, stale-while-revalidate=60';     // intraday: 30s fresh

    return NextResponse.json(result, {
      headers: { 'Cache-Control': cacheControl },
    });

  } catch (error: any) {
    console.error('Historical API Error:', error);
    return NextResponse.json({ error: 'Internal Server Error', message: error.message }, { status: 500 });
  }
}
