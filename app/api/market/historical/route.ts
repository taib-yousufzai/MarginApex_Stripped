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
interface ResolvedInstrument {
  token: number;
  /** The canonical DB id (e.g. "NSE:NIFTY 50"). Equals the input symbol when we can't determine it. */
  canonicalId: string;
}

/**
 * Process-lifetime in-memory cache for resolved instruments.
 * Survives across requests in the same Node.js worker.
 * Crucial when Redis is mocked (dev) or DB indexes are absent:
 * the TV widget calls getBars 5–15 times per chart open, each needing resolution.
 * After the first hit this map returns in < 1ms.
 */
const memCache = new Map<string, ResolvedInstrument>();

/**
 * Statically known instrument tokens for the most-frequently viewed symbols.
 * These never change and eliminate any DB/Redis round-trip for common indices,
 * making resolution instant (<1ms) even on cold starts.
 */
const STATIC_TOKENS: Record<string, ResolvedInstrument> = {
  'NIFTY':              { token: 256265,  canonicalId: 'NSE:NIFTY 50' },
  'NIFTY 50':           { token: 256265,  canonicalId: 'NSE:NIFTY 50' },
  'NSE:NIFTY 50':       { token: 256265,  canonicalId: 'NSE:NIFTY 50' },
  'BANKNIFTY':          { token: 260105,  canonicalId: 'NSE:NIFTY BANK' },
  'NIFTY BANK':         { token: 260105,  canonicalId: 'NSE:NIFTY BANK' },
  'NSE:NIFTY BANK':     { token: 260105,  canonicalId: 'NSE:NIFTY BANK' },
  'FINNIFTY':           { token: 257801,  canonicalId: 'NSE:NIFTY FIN SERVICE' },
  'NSE:NIFTY FIN SERVICE': { token: 257801, canonicalId: 'NSE:NIFTY FIN SERVICE' },
  'MIDCPNIFTY':         { token: 288009,  canonicalId: 'NSE:NIFTY MID SELECT' },
  'NSE:NIFTY MID SELECT': { token: 288009, canonicalId: 'NSE:NIFTY MID SELECT' },
  'SENSEX':             { token: 265,     canonicalId: 'BSE:SENSEX' },
  'BSE:SENSEX':         { token: 265,     canonicalId: 'BSE:SENSEX' },
  'BANKEX':             { token: 274441,  canonicalId: 'BSE:BANKEX' },
  'BSE:BANKEX':         { token: 274441,  canonicalId: 'BSE:BANKEX' },
};

async function resolveInstrument(symbol: string): Promise<ResolvedInstrument | null> {
  // 0. Fastest path: compile-time static tokens (zero I/O, zero cache lookup)
  const staticHit = STATIC_TOKENS[symbol] ?? STATIC_TOKENS[symbol.toUpperCase().trim()];
  if (staticHit) {
    memCache.set(symbol, staticHit); // backfill mem cache for subsequent paths
    return staticHit;
  }

  // 1. Fastest path: process-level in-memory cache (always checked first)
  const memHit = memCache.get(symbol);
  if (memHit) return memHit;

  const redis = getRedisClient();
  const cacheKey = `instrument_token:${symbol}`;
  
  if (!isRedisMock()) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        // Cached value may be "token" or "token|canonicalId"
        const parts = cached.split('|');
        const result: ResolvedInstrument = { token: parseInt(parts[0], 10), canonicalId: parts[1] ?? symbol };
        memCache.set(symbol, result); // backfill so next call skips Redis too
        return result;
      }
    } catch (e) {
      console.error('Redis cache error for instrument token:', e);
    }
  }

  const save = async (token: number, canonicalId: string): Promise<ResolvedInstrument> => {
    const result: ResolvedInstrument = { token, canonicalId };
    // Always write to process-level cache — survives across requests in same worker
    memCache.set(symbol, result);
    if (!isRedisMock()) {
      try {
        await redis.setex(cacheKey, 86400, `${token}|${canonicalId}`);
      } catch (e) {
        console.error('Redis cache set error for instrument token:', e);
      }
    }
    return result;
  };

  // Fast path: symbol contains ':' (e.g. "NFO:NIFTY2661623700CE") — exact id match
  // We already know the canonical ID; no reverse lookup needed.
  if (symbol.includes(':')) {
    const { data } = await supabase
      .from('instruments')
      .select('instrument_token')
      .eq('id', symbol)
      .single();
    if (data?.instrument_token) return save(data.instrument_token, symbol);
  }

  const cleanSymbol = (symbol.includes(':') ? symbol.split(':')[1] : symbol).replace(/\//g, '');
  const upperSymbol = cleanSymbol.toUpperCase().trim();

  // Handle index shortcuts (e.g. NIFTY, BANKNIFTY)
  // Covered by STATIC_TOKENS above for the common cases. This branch now only
  // runs for unusual variants that didn't match the static map.
  const baseIndices: Record<string, string> = {
    'NIFTY': 'NSE:NIFTY 50',
    'NIFTY 50': 'NSE:NIFTY 50',
    'BANKNIFTY': 'NSE:NIFTY BANK',
    'NIFTY BANK': 'NSE:NIFTY BANK',
    'FINNIFTY': 'NSE:NIFTY FIN SERVICE',
    'SENSEX': 'BSE:SENSEX',
    'BANKEX': 'BSE:BANKEX',
  };
  if (baseIndices[upperSymbol]) {
    const resolvedSymbol = baseIndices[upperSymbol];
    const { data } = await supabase
      .from('instruments')
      .select('instrument_token')
      .eq('id', resolvedSymbol)
      .single();
    if (data?.instrument_token) return save(data.instrument_token, resolvedSymbol);
  }

  // Handle base commodity and currency shortcuts to resolve to active front-month contracts
  const baseCommodities = ['GOLD', 'CRUDEOIL', 'SILVER', 'NATURALGAS', 'USDINR'];
  const isOption = upperSymbol.endsWith('CE') || upperSymbol.endsWith('PE');
  if (!isOption) {
    const matchedCommodity = baseCommodities.find(c => upperSymbol.includes(c));
    if (matchedCommodity) {
      const isCurrency = matchedCommodity === 'USDINR';
      const exchange = isCurrency ? 'CDS' : 'MCX';
      const instrumentTypes = isCurrency ? ['FUT'] : ['FUTCOM', 'FUT', 'MAPPED_FUT'];
      
      const { data } = await supabase
        .from('instruments')
        .select('instrument_token, tradingsymbol')
        .eq('name', matchedCommodity)
        .eq('exchange', exchange)
        .in('instrument_type', instrumentTypes)
        .gte('expiry', new Date().toISOString().split('T')[0])
        .order('expiry', { ascending: true })
        .limit(1)
        .maybeSingle();
        
      if (data?.instrument_token) {
        const canonicalId = `${exchange}:${data.tradingsymbol}`;
        return save(data.instrument_token, canonicalId);
      }
    }
  }

  // Slow path: short symbol — run ALL strategies in parallel
  const exchanges = ['NSE', 'NFO', 'MCX', 'BSE', 'BFO', 'CDS'];
  const hasUnderscore = symbol.includes('_');
  const baseName = hasUnderscore ? symbol.split('_')[0] : symbol;

  const queries: PromiseLike<{ token: number; canonicalId: string } | null>[] = [];

  // Strategy 1: Exact id match
  queries.push(
    supabase.from('instruments').select('instrument_token').eq('id', symbol).single()
      .then(r => r.data?.instrument_token ? { token: r.data.instrument_token, canonicalId: symbol } : null)
  );

  // Strategy 2: tradingsymbol match
  queries.push(
    supabase.from('instruments').select('instrument_token, exchange, tradingsymbol').eq('tradingsymbol', symbol).limit(1).single()
      .then(r => r.data?.instrument_token ? { token: r.data.instrument_token, canonicalId: `${r.data.exchange}:${r.data.tradingsymbol}` } : null)
  );

  // Strategy 3: Exchange prefix matches (all in parallel)
  for (const exchange of exchanges) {
    const prefixed = `${exchange}:${symbol}`;
    queries.push(
      supabase.from('instruments').select('instrument_token').eq('id', prefixed).single()
        .then(r => r.data?.instrument_token ? { token: r.data.instrument_token, canonicalId: prefixed } : null)
    );
  }

  // Strategy 4a: Mapped continuous contracts (for underscored symbols)
  if (hasUnderscore) {
    for (const exchange of exchanges) {
      const prefixed = `${exchange}:${baseName}`;
      queries.push(
        supabase.from('instruments').select('instrument_token')
          .eq('id', prefixed).eq('instrument_type', 'MAPPED_FUT').single()
          .then(r => r.data?.instrument_token ? { token: r.data.instrument_token, canonicalId: prefixed } : null)
      );
    }
  }

  // Strategy 4b: Fuzzy tradingsymbol match (for underscored symbols)
  if (hasUnderscore) {
    const fuzzyPattern = symbol.replace(/_/g, '%');
    queries.push(
      supabase.from('instruments').select('instrument_token, instrument_type, exchange, tradingsymbol')
        .ilike('tradingsymbol', fuzzyPattern).in('exchange', exchanges)
        .order('instrument_type', { ascending: true }).limit(5)
        .then(r => {
          if (!r.data?.length) return null;
          const mapped = r.data.find((m: any) => m.instrument_type === 'MAPPED_FUT');
          const row = mapped || r.data[0];
          return { token: row.instrument_token, canonicalId: `${row.exchange}:${row.tradingsymbol}` };
        })
    );
  }

  const results = await Promise.all(queries);
  const resolved = results.find(r => r !== null) ?? null;
  if (resolved) return save(resolved.token, resolved.canonicalId);
  return null;
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
    const [session, resolved] = await Promise.all([
      getSharedKiteSession(),
      resolveInstrument(symbol)
    ]);

    if (!session) {
      return NextResponse.json({ error: 'No active Kite session found' }, { status: 401 });
    }
    if (!resolved) {
      return NextResponse.json({ error: `Instrument not found for symbol: ${symbol}` }, { status: 404 });
    }

    const instrumentToken = resolved.token;
    // canonicalId comes directly from resolution — no extra round-trip needed.
    const canonicalSymbol = resolved.canonicalId;

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
      const response = await fetch(url, {
        headers: {
          'X-Kite-Version': '3',
          'Authorization': `token ${process.env.KITE_API_KEY || process.env.NEXT_PUBLIC_KITE_API_KEY}:${session.accessToken}`
        },
        signal: AbortSignal.timeout(4000)
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

    if (!isRedisMock() && candlesData && candlesData.length > 0) {
      try {
        const ttl = (interval === 'day' || interval === 'week') ? 3600 : (interval.includes('minute') || interval.includes('min') || ['1m','5m','15m','30m','60m'].includes(interval)) ? 60 : 300;
        await redis.setex(cacheKey, ttl, JSON.stringify(result));
      } catch (e) {
        console.error('Redis cache set error for historical data:', e);
      }
    }

    return NextResponse.json(result);

  } catch (error: any) {
    console.error('Historical API Error:', error);
    return NextResponse.json({ error: 'Internal Server Error', message: error.message }, { status: 500 });
  }
}
