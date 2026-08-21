import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { getAdminClient } from '../lib/adminClient';
import { getRedisClient } from '../lib/redis';

async function main() {
  const admin = getAdminClient();
  const redis = getRedisClient();
  const today = new Date().toISOString().split('T')[0];

  console.log('=== 1. DB INSTRUMENT RESOLUTION FOR GOLD 31 AUG OPTIONS (158500, 159000, 159500) ===');
  const { data: instruments, error } = await admin
    .from('instruments')
    .select('id, instrument_token, tradingsymbol, name, exchange, segment, strike_price, option_type, expiry')
    .eq('name', 'GOLD')
    .in('expiry', ['2026-08-31', '2026-08-28'])
    .in('strike_price', [158500, 159000, 159500])
    .order('strike_price')
    .order('option_type');

  if (error) {
    console.error('DB Error:', error);
    process.exit(1);
  }

  console.table(instruments);

  console.log('\n=== 2. REDIS QUOTE SNAPSHOT FOR THESE TOKENS & IDS ===');
  const keysToQuery: string[] = [];
  instruments?.forEach(inst => {
    keysToQuery.push(inst.id); // e.g. MCX:GOLD26AUG159000CE or NCO:GOLD26AUG159000CE
    keysToQuery.push(`MCX:${inst.tradingsymbol}`);
    keysToQuery.push(`NCO:${inst.tradingsymbol}`);
    keysToQuery.push(String(inst.instrument_token));
  });

  const redisQuotes = await redis.hmget('market:quotes', ...keysToQuery);
  keysToQuery.forEach((key, idx) => {
    const raw = redisQuotes[idx];
    if (raw) {
      console.log(`[REDIS KEY MATCH] ${key} =>`, JSON.parse(raw as string));
    } else {
      console.log(`[REDIS KEY MISSING] ${key}`);
    }
  });

  process.exit(0);
}

main();
