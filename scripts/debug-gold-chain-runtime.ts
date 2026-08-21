import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { getAdminClient } from '../lib/adminClient';
import { getRedisClient } from '../lib/redis';

async function main() {
  const admin = getAdminClient();
  const redis = getRedisClient();

  console.log('=== 1. Searching DB for GOLD option instruments ===');
  const today = new Date().toISOString().split('T')[0];
  const { data: options, error } = await admin
    .from('instruments')
    .select('id, instrument_token, tradingsymbol, name, exchange, segment, strike_price, option_type, expiry')
    .eq('name', 'GOLD')
    .gte('expiry', today)
    .in('option_type', ['CE', 'PE'])
    .order('expiry', { ascending: true })
    .order('strike_price', { ascending: true })
    .limit(30);

  if (error) {
    console.error('DB error:', error);
    process.exit(1);
  }

  console.log(`Found ${options?.length || 0} GOLD option instruments:`);
  console.log(options?.slice(0, 10));

  if (!options?.length) {
    console.log('No GOLD options found. Searching without expiry filter...');
    const { data: allOpt } = await admin
      .from('instruments')
      .select('id, instrument_token, tradingsymbol, name, exchange, segment, strike_price, option_type, expiry')
      .eq('name', 'GOLD')
      .in('option_type', ['CE', 'PE'])
      .limit(10);
    console.log('Sample GOLD options without expiry filter:', allOpt);
    process.exit(0);
  }

  const sampleExpiries = Array.from(new Set(options.map(o => o.expiry)));
  console.log('GOLD Option Expiries:', sampleExpiries);

  const nearestExpiry = sampleExpiries[0];
  const expiryOpts = options.filter(o => o.expiry === nearestExpiry);
  console.log(`\nOptions for nearest expiry ${nearestExpiry} (${expiryOpts.length} rows):`);

  // Check Redis quote keys
  const keysToCheck: string[] = [];
  expiryOpts.forEach(o => {
    keysToCheck.push(o.id);
    keysToCheck.push(`MCX:${o.tradingsymbol}`);
    keysToCheck.push(`NCO:${o.tradingsymbol}`);
    keysToCheck.push(String(o.instrument_token));
  });

  console.log('\n=== 2. Checking Redis market:quotes for sample keys ===');
  const redisQuotes = await redis.hmget('market:quotes', ...keysToCheck);
  keysToCheck.forEach((key, i) => {
    const val = redisQuotes[i];
    if (val) {
      console.log(`[Redis FOUND] ${key} => ${val}`);
    } else {
      console.log(`[Redis NULL] ${key}`);
    }
  });

  console.log('\n=== 3. Calling /api/market/option-chain?symbol=GOLD ===');
  const { GET } = await import('../app/api/market/option-chain/route');
  const req = new Request('http://localhost/api/market/option-chain?symbol=GOLD');
  const res = await GET(req as any);
  const json = await res.json();
  console.log('Option chain API result metadata:', {
    success: json.success,
    symbol: json.symbol,
    expiry: json.expiry,
    underlyingPrice: json.underlyingPrice,
    underlyingSymbol: json.underlyingSymbol,
    strikesCount: json.strikes?.length,
  });

  if (json.strikes?.length) {
    console.log('\nFirst 5 strikes from option chain API:');
    console.log(JSON.stringify(json.strikes.slice(0, 5), null, 2));
    
    // Find ATM strike
    const atmPrice = json.underlyingPrice || 159000;
    let closestStrike = json.strikes[0];
    let minDiff = Infinity;
    for (const s of json.strikes) {
      const diff = Math.abs(s.strike - atmPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closestStrike = s;
      }
    }
    console.log(`\nATM Strike around ${atmPrice}:`, closestStrike);
  }

  process.exit(0);
}

main();
