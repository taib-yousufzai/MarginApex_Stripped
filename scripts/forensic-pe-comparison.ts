import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { getAdminClient } from '../lib/adminClient';
import { Redis } from 'ioredis';

async function forensicAudit() {
  const admin = getAdminClient();
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  // 1. Get active Kite session
  const { data: session } = await admin
    .from('kite_sessions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  console.log('Kite Session User:', session?.user_id, 'Token present:', !!session?.access_token);

  const targetSymbols = [
    { contract: '159500 PE', key: 'MCX:GOLD26AUG159500PE', token: 142574599 },
    { contract: '160000 PE', key: 'MCX:GOLD26AUG160000PE', token: 142574343 },
    { contract: '160500 PE', key: 'MCX:GOLD26AUG160500PE', token: 142574087 },
    { contract: '161500 PE', key: 'MCX:GOLD26AUG161500PE', token: 142573575 },
    { contract: '163000 PE', key: 'MCX:GOLD26AUG163000PE', token: 142572807 },
  ];

  // 2. Fetch KiteConnect API quotes directly if access token exists
  let kiteQuotes: Record<string, any> = {};
  if (session?.access_token && process.env.KITE_API_KEY) {
    try {
      const { KiteConnect } = await import('kiteconnect');
      const kc = new KiteConnect({ api_key: process.env.KITE_API_KEY, access_token: session.access_token });
      const keys = targetSymbols.map(s => s.key);
      kiteQuotes = await kc.getQuote(keys);
      console.log('Successfully fetched live KiteConnect quotes!');
    } catch (err: any) {
      console.error('KiteConnect API error:', err.message);
    }
  }

  // 3. Fetch Redis market:quotes
  const redisQuotesRaw = await redis.hmget('market:quotes', ...targetSymbols.map(s => s.key));

  console.log('\n=================== FORENSIC COMPARISON TABLE ===================');
  console.log('CONTRACT   | TOKEN     | KITE LTP | KITE TS                  | REDIS LTP | REDIS TS                 | BID / ASK');
  console.log('---------------------------------------------------------------------------------------------------------------');

  for (let i = 0; i < targetSymbols.length; i++) {
    const s = targetSymbols[i];
    const kq = kiteQuotes[s.key] || {};
    const rq = redisQuotesRaw[i] ? JSON.parse(redisQuotesRaw[i]!) : {};

    const kiteLtp = kq.last_price ?? 'N/A';
    const kiteTs = kq.timestamp ? new Date(kq.timestamp).toISOString() : 'N/A';
    const redisLtp = rq.last_price ?? 'N/A';
    const redisTs = rq.timestamp ? new Date(rq.timestamp).toISOString() : 'N/A';
    const buyPrice = kq.depth?.buy?.[0]?.price ?? 0;
    const sellPrice = kq.depth?.sell?.[0]?.price ?? 0;
    const bidAsk = `${buyPrice} / ${sellPrice}`;

    console.log(
      s.contract.padEnd(10) + ' | ' +
      String(s.token).padEnd(9) + ' | ' +
      String(kiteLtp).padEnd(8) + ' | ' +
      String(kiteTs).padEnd(24) + ' | ' +
      String(redisLtp).padEnd(9) + ' | ' +
      String(redisTs).padEnd(24) + ' | ' +
      bidAsk
    );
  }

  console.log('=================================================================\n');

  // Print full detail of target PEs from KiteConnect
  for (const s of targetSymbols) {
    const kq = kiteQuotes[s.key];
    if (kq) {
      console.log(`--- FULL KITE QUOTE: ${s.key} ---`);
      console.log(JSON.stringify({
        instrument_token: kq.instrument_token,
        last_price: kq.last_price,
        last_quantity: kq.last_quantity,
        last_trade_time: kq.last_trade_time,
        volume: kq.volume,
        buy_quantity: kq.buy_quantity,
        sell_quantity: kq.sell_quantity,
        open_interest: kq.oi,
        timestamp: kq.timestamp,
        depth: kq.depth
      }, null, 2));
    }
  }

  await redis.quit();
}

forensicAudit().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
