import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { getAdminClient } from '../lib/adminClient';
import { getRedisClient } from '../lib/redis';

async function main() {
  console.log('====================================================');
  console.log('   GOLD MCX OPTION QUOTE LINEAGE DIAGNOSTIC SCRIPT  ');
  console.log('====================================================\n');

  const admin = getAdminClient();
  const redis = getRedisClient();

  // 1. Query Database for GOLD 159000 CE and PE
  const { data: dbInstruments, error: dbErr } = await admin
    .from('instruments')
    .select('*')
    .eq('name', 'GOLD')
    .eq('strike_price', 159000)
    .in('option_type', ['CE', 'PE'])
    .order('expiry', { ascending: true });

  if (dbErr) {
    console.error('Database query error:', dbErr);
    process.exit(1);
  }

  console.log('--- 1. DATABASE INSTRUMENT MASTER RECORDS ---');
  dbInstruments?.forEach(inst => {
    console.log(`[${inst.exchange}] ${inst.tradingsymbol}`);
    console.log(`   ID: ${inst.id}`);
    console.log(`   Token: ${inst.instrument_token}`);
    console.log(`   Expiry: ${inst.expiry}`);
    console.log(`   OptionType: ${inst.option_type}`);
    console.log(`   Strike: ${inst.strike_price}`);
    console.log(`   LotSize: ${inst.lot_size}`);
    console.log(`   Underlying: ${inst.underlying_symbol}\n`);
  });

  // 2. Inspect Redis for each database instrument record key
  console.log('--- 2. REDIS QUOTE KEYS INSPECTION ---');
  for (const inst of dbInstruments || []) {
    const redisKey = inst.id;
    const tokenKey = String(inst.instrument_token);
    const symKey = inst.tradingsymbol;

    const valRedis = await redis.hget('market:quotes', redisKey);
    const valToken = await redis.hget('market:quotes', tokenKey);
    const valSym = await redis.hget('market:quotes', symKey);

    console.log(`Check Instrument: ${inst.id} (Token: ${inst.instrument_token})`);
    console.log(`  Key [market:quotes -> ${redisKey}]:`, valRedis ? JSON.parse(valRedis) : 'NULL');
    console.log(`  Key [market:quotes -> ${tokenKey}]:`, valToken ? JSON.parse(valToken) : 'NULL');
    console.log(`  Key [market:quotes -> ${symKey}]:`, valSym ? JSON.parse(valSym) : 'NULL');
    console.log('');
  }

  // 3. Inspect Redis for all keys starting with MCX:GOLD or containing GOLD
  console.log('--- 3. ALL REDIS MARKET:QUOTES KEYS CONTAINING GOLD ---');
  const allQuotes = await redis.hgetall('market:quotes');
  if (allQuotes) {
    const goldKeys = Object.keys(allQuotes).filter(k => k.toUpperCase().includes('GOLD'));
    console.log(`Found ${goldKeys.length} GOLD keys in Redis:`);
    goldKeys.slice(0, 20).forEach(k => {
      try {
        const q = JSON.parse(allQuotes[k]);
        console.log(`  ${k} => LTP: ${q.last_price || q.lastPrice || q.price}, Bid: ${q.bid}, Ask: ${q.ask}, Time: ${q.timestamp}`);
      } catch {
        console.log(`  ${k} => ${allQuotes[k]}`);
      }
    });
  } else {
    console.log('No market:quotes found in Redis.');
  }

  // 4. Test Option Chain API directly
  console.log('\n--- 4. OPTION CHAIN API BACKEND CALL ---');
  try {
    const { GET } = await import('../app/api/market/option-chain/route');
    const req = new Request('http://localhost/api/market/option-chain?symbol=GOLD');
    const res = await GET(req);
    const json = await res.json();

    console.log(`API Response Success: ${json.success}`);
    console.log(`API Symbol: ${json.symbol}, Expiry: ${json.expiry}, UnderlyingPrice: ${json.underlyingPrice}, UnderlyingSymbol: ${json.underlyingSymbol}`);

    const strike159k = json.strikes?.find((s: any) => s.strike === 159000);
    console.log('\nAPI Row for Strike 159000:');
    console.log('  CE =>', strike159k?.ce);
    console.log('  PE =>', strike159k?.pe);
  } catch (err) {
    console.error('API call error:', err);
  }

  process.exit(0);
}

main();
