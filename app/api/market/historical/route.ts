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
async function resolveInstrumentToken(symbol: string): Promise<number | null> {
  const redis = getRedisClient();
  const cacheKey = `instrument_token:${symbol}`;
  
  if (!isRedisMock()) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return parseInt(cached, 10);
    } catch (e) {
      console.error('Redis cache error for instrument token:', e);
    }
  }

  // Fast path: symbol contains ':' (e.g. "NFO:NIFTY2661623700CE") — exact id match
  if (symbol.includes(':')) {
    const { data } = await supabase
      .from('instruments')
      .select('instrument_token')
      .eq('id', symbol)
      .single();
    return data?.instrument_token ?? null;
  }

  // Slow path: short symbol like "GOLD_FUT" — run ALL strategies in parallel
  const exchanges = ['NSE', 'NFO', 'MCX', 'BSE', 'BFO', 'CDS'];
  const hasUnderscore = symbol.includes('_');
  const baseName = hasUnderscore ? symbol.split('_')[0] : symbol;

  // Build all queries to run in parallel
  const queries: PromiseLike<number | null>[] = [];

  // Strategy 1: Exact id match
  queries.push(
    supabase.from('instruments').select('instrument_token').eq('id', symbol).single()
      .then(r => r.data?.instrument_token ?? null)
  );

  // Strategy 2: tradingsymbol match
  queries.push(
    supabase.from('instruments').select('instrument_token').eq('tradingsymbol', symbol).limit(1).single()
      .then(r => r.data?.instrument_token ?? null)
  );

  // Strategy 3: Exchange prefix matches (all in parallel)
  for (const exchange of exchanges) {
    queries.push(
      supabase.from('instruments').select('instrument_token').eq('id', `${exchange}:${symbol}`).single()
        .then(r => r.data?.instrument_token ?? null)
    );
  }

  // Strategy 4a: Mapped continuous contracts (for underscored symbols)
  if (hasUnderscore) {
    for (const exchange of exchanges) {
      queries.push(
        supabase.from('instruments').select('instrument_token')
          .eq('id', `${exchange}:${baseName}`).eq('instrument_type', 'MAPPED_FUT').single()
          .then(r => r.data?.instrument_token ?? null)
      );
    }
  }

  // Strategy 4b: Fuzzy tradingsymbol match (for underscored symbols)
  if (hasUnderscore) {
    const fuzzyPattern = symbol.replace(/_/g, '%');
    queries.push(
      supabase.from('instruments').select('instrument_token, instrument_type')
        .ilike('tradingsymbol', fuzzyPattern).in('exchange', exchanges)
        .order('instrument_type', { ascending: true }).limit(5)
        .then(r => {
          if (!r.data?.length) return null;
          const mapped = r.data.find((m: any) => m.instrument_type === 'MAPPED_FUT');
          return (mapped || r.data[0]).instrument_token;
        })
    );
  }

  // Run all queries in parallel, return first non-null result
  // Priority: exact > tradingsymbol > prefix > mapped > fuzzy
  const results = await Promise.all(queries);
  const token = results.find(r => r !== null) ?? null;
  
  if (token && !isRedisMock()) {
      try {
          // Cache for 24 hours
          await redis.setex(cacheKey, 86400, token.toString());
      } catch (e) {
          console.error('Redis cache set error for instrument token:', e);
      }
  }
  return token;
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
    const [session, instrumentToken] = await Promise.all([
      getSharedKiteSession(),
      resolveInstrumentToken(symbol)
    ]);

    if (!session) {
      return NextResponse.json({ error: 'No active Kite session found' }, { status: 401 });
    }
    if (!instrumentToken) {
      return NextResponse.json({ error: `Instrument not found for symbol: ${symbol}` }, { status: 404 });
    }

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
    const url = `https://api.kite.trade/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    
    const response = await fetch(url, {
      headers: {
        'X-Kite-Version': '3',
        'Authorization': `token ${process.env.KITE_API_KEY || process.env.NEXT_PUBLIC_KITE_API_KEY}:${session.accessToken}`
      }
    });

    const data = await response.json();

    if (!response.ok || data.status !== 'success') {
      const errorMessage = data.message || data.error_type || 'Kite API error';
      return NextResponse.json({ error: errorMessage, details: data }, { status: response.status || 500 });
    }

    if (!isRedisMock()) {
      try {
        // Cache daily data longer, intraday data shorter
        const ttl = (interval === 'day' || interval === 'week') ? 3600 : (interval.includes('minute') || interval.includes('min') || ['1m','5m','15m','30m','60m'].includes(interval)) ? 60 : 300;
        await redis.setex(cacheKey, ttl, JSON.stringify(data.data));
      } catch (e) {
        console.error('Redis cache set error for historical data:', e);
      }
    }

    return NextResponse.json(data.data);

  } catch (error: any) {
    console.error('Historical API Error:', error);
    return NextResponse.json({ error: 'Internal Server Error', message: error.message }, { status: 500 });
  }
}
