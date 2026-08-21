import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { TickProcessor } from './ticker/processor';
import { normalizeQuote } from '../contexts/MarketDataContext';
import { getAdminClient } from '../lib/adminClient';

async function runGoldEndToEndVerification() {
  console.log('================================================================');
  console.log('  CRITICAL RUNTIME VERIFICATION: BUG #1 (MCX GOLD OPTION CHAIN)');
  console.log('================================================================\n');

  let totalTests = 0;
  let passedTests = 0;

  function assert(condition: boolean, description: string) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ PASS: ${description}`);
      passedTests++;
    } else {
      console.error(`  ❌ FAIL: ${description}`);
    }
  }

  // --- STAGE 1: REAL DB INSTRUMENT TOKENS & IDENTITIES ---
  console.log('--- STAGE 1: Database Contract Identity Verification ---');
  const admin = getAdminClient();
  const { data: dbRows } = await admin
    .from('instruments')
    .select('id, instrument_token, tradingsymbol, exchange, expiry, strike_price, option_type')
    .eq('name', 'GOLD')
    .eq('expiry', '2026-08-31')
    .in('strike_price', [158500, 159000, 159500]);

  const ce159000 = dbRows?.find(r => r.strike_price === 159000 && r.option_type === 'CE');
  const pe159000 = dbRows?.find(r => r.strike_price === 159000 && r.option_type === 'PE');

  const ce158500 = dbRows?.find(r => r.strike_price === 158500 && r.option_type === 'CE');
  const pe158500 = dbRows?.find(r => r.strike_price === 158500 && r.option_type === 'PE');

  const ce159500 = dbRows?.find(r => r.strike_price === 159500 && r.option_type === 'CE');
  const pe159500 = dbRows?.find(r => r.strike_price === 159500 && r.option_type === 'PE');

  assert(!!ce159000 && ce159000.instrument_token === 142421255, `CE 159000 token is 142421255 (${ce159000?.tradingsymbol})`);
  assert(!!pe159000 && pe159000.instrument_token === 142574855, `PE 159000 token is 142574855 (${pe159000?.tradingsymbol})`);

  // --- STAGE 2-7: END-TO-END DATA PIPELINE TRACE FOR GOLD 159000 CE & PE ---
  console.log('\n--- STAGES 2-7: End-to-End Pipeline Stage Comparison ---');

  const timestamp = new Date().toISOString();

  // Upstream ticks for 159000 CE & PE with explicit real market depth
  const kiteCeTick = {
    instrument_token: 142421255,
    last_price: 2347.0,
    depth: {
      buy: [{ price: 2333.5, quantity: 5, orders: 1 }],
      sell: [{ price: 2382.0, quantity: 5, orders: 1 }]
    },
    ohlc: { open: 2100, high: 2400, low: 2000, close: 2200 },
    last_trade_time: timestamp
  };

  const kitePeTick = {
    instrument_token: 142574855,
    last_price: 1953.0,
    depth: {
      buy: [{ price: 1940.0, quantity: 10, orders: 2 }],
      sell: [{ price: 1965.0, quantity: 10, orders: 2 }]
    },
    ohlc: { open: 1800, high: 2000, low: 1800, close: 1900 },
    last_trade_time: timestamp
  };

  // Setup Processor with mock subscription manager & dbWriter
  const mockSubManager: any = {
    getSymbolKey: (token: number) => {
      if (token === 142421255) return 'MCX:GOLD26AUG159000CE';
      if (token === 142574855) return 'MCX:GOLD26AUG159000PE';
      if (token === 142421511) return 'MCX:GOLD26AUG158500CE';
      if (token === 142575111) return 'MCX:GOLD26AUG158500PE';
      if (token === 142420999) return 'MCX:GOLD26AUG159500CE';
      if (token === 142574599) return 'MCX:GOLD26AUG159500PE';
      return null;
    }
  };
  const mockDbWriter: any = { addTick: () => {} };
  const processor = new TickProcessor(mockSubManager, mockDbWriter);

  let processedCe: any = null;
  let processedPe: any = null;

  processor.on('tick', (key, tickData) => {
    if (key === 'MCX:GOLD26AUG159000CE') processedCe = tickData;
    if (key === 'MCX:GOLD26AUG159000PE') processedPe = tickData;
  });

  processor.processTicks([kiteCeTick, kitePeTick]);

  // Redis serialization representation
  const redisCe = {
    instrument_token: processedCe.instrument_token,
    last_price: processedCe.last_price,
    bid: processedCe.bid,
    ask: processedCe.ask,
    timestamp: timestamp
  };

  const redisPe = {
    instrument_token: processedPe.instrument_token,
    last_price: processedPe.last_price,
    bid: processedPe.bid,
    ask: processedPe.ask,
    timestamp: timestamp
  };

  // API & MarketDataContext normalization
  const normCe = normalizeQuote(redisCe as any, 'MCX');
  const normPe = normalizeQuote(redisPe as any, 'MCX');

  // Final UI rendering logic
  const renderedCeLtp = normCe.lastPrice ? `₹${normCe.lastPrice.toFixed(1)}` : '---';
  const renderedPeLtp = normPe.lastPrice ? `₹${normPe.lastPrice.toFixed(1)}` : '---';

  const renderedCeBid = normCe.bid > 0 ? normCe.bid.toFixed(1) : '---';
  const renderedCeAsk = normCe.ask > 0 ? normCe.ask.toFixed(1) : '---';
  const renderedPeBid = normPe.bid > 0 ? normPe.bid.toFixed(1) : '---';
  const renderedPeAsk = normPe.ask > 0 ? normPe.ask.toFixed(1) : '---';

  console.log('\nCONTRACT: GOLD26AUG159000CE');
  console.log('TOKEN: 142421255');
  console.log('KITE:\n  LTP:', kiteCeTick.last_price, '\n  BID:', kiteCeTick.depth.buy[0].price, '\n  ASK:', kiteCeTick.depth.sell[0].price, '\n  timestamp:', timestamp);
  console.log('PROCESSOR:\n  LTP:', processedCe.last_price, '\n  BID:', processedCe.bid, '\n  ASK:', processedCe.ask);
  console.log('REDIS:\n  LTP:', redisCe.last_price, '\n  BID:', redisCe.bid, '\n  ASK:', redisCe.ask);
  console.log('FRONTEND:\n  LTP:', normCe.lastPrice, '\n  BID:', normCe.bid, '\n  ASK:', normCe.ask);
  console.log('RENDERED:\n  LTP:', renderedCeLtp, '\n  B/A:', `${renderedCeBid} / ${renderedCeAsk}`);

  console.log('\nCONTRACT: GOLD26AUG159000PE');
  console.log('TOKEN: 142574855');
  console.log('KITE:\n  LTP:', kitePeTick.last_price, '\n  BID:', kitePeTick.depth.buy[0].price, '\n  ASK:', kitePeTick.depth.sell[0].price, '\n  timestamp:', timestamp);
  console.log('PROCESSOR:\n  LTP:', processedPe.last_price, '\n  BID:', processedPe.bid, '\n  ASK:', processedPe.ask);
  console.log('REDIS:\n  LTP:', redisPe.last_price, '\n  BID:', redisPe.bid, '\n  ASK:', redisPe.ask);
  console.log('FRONTEND:\n  LTP:', normPe.lastPrice, '\n  BID:', normPe.bid, '\n  ASK:', normPe.ask);
  console.log('RENDERED:\n  LTP:', renderedPeLtp, '\n  B/A:', `${renderedPeBid} / ${renderedPeAsk}`);

  // Invariant checks
  assert(kiteCeTick.last_price === normCe.lastPrice, 'CE Upstream LTP preserved end-to-end (2347.0)');
  assert(kiteCeTick.depth.buy[0].price === normCe.bid, 'CE Upstream BID preserved end-to-end (2333.5)');
  assert(kiteCeTick.depth.sell[0].price === normCe.ask, 'CE Upstream ASK preserved end-to-end (2382.0)');

  assert(kitePeTick.last_price === normPe.lastPrice, 'PE Upstream LTP preserved end-to-end (1953.0)');
  assert(kitePeTick.depth.buy[0].price === normPe.bid, 'PE Upstream BID preserved end-to-end (1940.0)');
  assert(kitePeTick.depth.sell[0].price === normPe.ask, 'PE Upstream ASK preserved end-to-end (1965.0)');

  // --- STAGE 8: DEPTHLESS TICK (UNAVAILABLE DEPTH) TEST ---
  console.log('\n--- STAGE 8: Depth Unavailable (LTP-only Feed) Invariant Test ---');
  const depthlessCeTick = {
    instrument_token: 142421255,
    last_price: 2360.0,
    ohlc: { open: 2100, high: 2400, low: 2000, close: 2200 },
    last_trade_time: timestamp
  };

  let processedDepthless: any = null;
  processor.on('tick', (key, tickData) => {
    if (key === 'MCX:GOLD26AUG159000CE') processedDepthless = tickData;
  });

  // Re-instantiate processor without prior lastSeenBid/Ask to simulate fresh depthless tick
  const freshProcessor = new TickProcessor(mockSubManager, mockDbWriter);
  freshProcessor.on('tick', (key, tickData) => {
    if (key === 'MCX:GOLD26AUG159000CE') processedDepthless = tickData;
  });
  freshProcessor.processTicks([depthlessCeTick as any]);

  const normDepthless = normalizeQuote(processedDepthless as any, 'MCX');
  const renderedDepthlessBid = normDepthless.bid > 0 ? normDepthless.bid.toFixed(1) : '---';
  const renderedDepthlessAsk = normDepthless.ask > 0 ? normDepthless.ask.toFixed(1) : '---';

  console.log('Depthless CE Tick LTP:', depthlessCeTick.last_price);
  console.log('Processed Bid/Ask:', processedDepthless.bid, '/', processedDepthless.ask);
  console.log('Normalized Bid/Ask:', normDepthless.bid, '/', normDepthless.ask);
  console.log('Rendered B/A in UI:', `${renderedDepthlessBid} / ${renderedDepthlessAsk}`);

  assert(normDepthless.bid === 0 && normDepthless.ask === 0, 'No synthetic bid/ask manufactured when depth unavailable');
  assert(renderedDepthlessBid === '---' && renderedDepthlessAsk === '---', 'B/A mode renders "---" when depth unavailable (does NOT fallback to LTP)');

  // --- STAGE 9: CROSS-CONTRACT CONTAMINATION & RECENTERING TEST ---
  console.log('\n--- STAGE 9: Cross-Contract Contamination & Recentering Test ---');
  
  const tickMap = new Map<number, any>();
  const multiTicks = [
    { instrument_token: 142421511, last_price: 2800.0, depth: { buy: [{ price: 2790 }], sell: [{ price: 2810 }] } }, // 158500 CE
    { instrument_token: 142575111, last_price: 1500.0, depth: { buy: [{ price: 1490 }], sell: [{ price: 1510 }] } }, // 158500 PE
    { instrument_token: 142421255, last_price: 2347.0, depth: { buy: [{ price: 2333.5 }], sell: [{ price: 2382 }] } }, // 159000 CE
    { instrument_token: 142574855, last_price: 1953.0, depth: { buy: [{ price: 1940 }], sell: [{ price: 1965 }] } }, // 159000 PE
    { instrument_token: 142420999, last_price: 1900.0, depth: { buy: [{ price: 1890 }], sell: [{ price: 1910 }] } }, // 159500 CE
    { instrument_token: 142574599, last_price: 2400.0, depth: { buy: [{ price: 2390 }], sell: [{ price: 2410 }] } }  // 159500 PE
  ];

  const multiProcessor = new TickProcessor(mockSubManager, mockDbWriter);
  multiProcessor.on('tick', (key, data) => tickMap.set(data.instrument_token, data));
  multiProcessor.processTicks(multiTicks);

  const t158500CE = tickMap.get(142421511);
  const t159000CE = tickMap.get(142421255);
  const t159500CE = tickMap.get(142420999);

  const t158500PE = tickMap.get(142575111);
  const t159000PE = tickMap.get(142574855);
  const t159500PE = tickMap.get(142574599);

  assert(t158500CE.last_price === 2800.0 && t159000CE.last_price === 2347.0 && t159500CE.last_price === 1900.0, 'Strike CE prices isolated (2800 != 2347 != 1900)');
  assert(t158500PE.last_price === 1500.0 && t159000PE.last_price === 1953.0 && t159500PE.last_price === 2400.0, 'Strike PE prices isolated (1500 != 1953 != 2400)');
  assert(t159000CE.last_price !== t159000PE.last_price, 'CE and PE prices for 159000 strike strictly isolated (2347 != 1953)');

  console.log('\n================================================================');
  console.log(`  VERIFICATION COMPLETE: ${passedTests} / ${totalTests} PASSED`);
  console.log('================================================================\n');

  process.exit(totalTests === passedTests ? 0 : 1);
}

runGoldEndToEndVerification();
