import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { TickProcessor } from './ticker/processor';
import { normalizeQuote } from '../contexts/MarketDataContext';

async function run7StagePipelineTest() {
  console.log('================================================================');
  console.log('  RUNNING 7-STAGE PIPELINE TRACE FOR GOLD 159000 CE & PE');
  console.log('================================================================\n');

  // Stage 1: Contract Identity (DB / Upstream Metadata)
  const ceContract = {
    id: 'MCX:GOLD26AUG159000CE',
    instrument_token: 142421255,
    tradingsymbol: 'GOLD26AUG159000CE',
    exchange: 'MCX',
    expiry: '2026-08-31',
    strike: 159000,
    type: 'CE'
  };

  const peContract = {
    id: 'MCX:GOLD26AUG159000PE',
    instrument_token: 142574855,
    tradingsymbol: 'GOLD26AUG159000PE',
    exchange: 'MCX',
    expiry: '2026-08-31',
    strike: 159000,
    type: 'PE'
  };

  console.log('STAGE 1: DB / Upstream Contract Identity');
  console.log('CE:', ceContract);
  console.log('PE:', peContract);

  // Stage 2: Upstream Tick Ingress
  const timestamp = new Date().toISOString();
  const rawCeTick = {
    instrument_token: 142421255,
    last_price: 2347.0,
    depth: {
      buy: [{ price: 2333.5, quantity: 5, orders: 1 }],
      sell: [{ price: 2382.0, quantity: 5, orders: 1 }]
    },
    ohlc: { open: 2100, high: 2400, low: 2000, close: 2200 },
    last_trade_time: timestamp
  };

  const rawPeTick = {
    instrument_token: 142574855,
    last_price: 1953.0,
    depth: {
      buy: [{ price: 1940.0, quantity: 10, orders: 2 }],
      sell: [{ price: 1965.0, quantity: 10, orders: 2 }]
    },
    ohlc: { open: 1800, high: 2000, low: 1800, close: 1900 },
    last_trade_time: timestamp
  };

  console.log('\nSTAGE 2: Upstream Tick Ingress');
  console.log('CE Tick:', { token: rawCeTick.instrument_token, ltp: rawCeTick.last_price, bid: rawCeTick.depth.buy[0].price, ask: rawCeTick.depth.sell[0].price });
  console.log('PE Tick:', { token: rawPeTick.instrument_token, ltp: rawPeTick.last_price, bid: rawPeTick.depth.buy[0].price, ask: rawPeTick.depth.sell[0].price });

  // Stage 3: Processor Output
  const mockSubManager: any = {
    getSymbolKey: (token: number) => {
      if (token === 142421255) return 'MCX:GOLD26AUG159000CE';
      if (token === 142574855) return 'MCX:GOLD26AUG159000PE';
      return null;
    }
  };
  const mockDbWriter: any = { addTick: () => {} };

  const processor = new TickProcessor(mockSubManager, mockDbWriter);
  let ceProcessed: any = null;
  let peProcessed: any = null;

  processor.on('tick', (key, tickData) => {
    if (key === 'MCX:GOLD26AUG159000CE') ceProcessed = tickData;
    if (key === 'MCX:GOLD26AUG159000PE') peProcessed = tickData;
  });

  processor.processTicks([rawCeTick, rawPeTick]);

  console.log('\nSTAGE 3: Processor Output');
  console.log('CE Processed:', { token: ceProcessed.instrument_token, ltp: ceProcessed.last_price, bid: ceProcessed.bid, ask: ceProcessed.ask });
  console.log('PE Processed:', { token: peProcessed.instrument_token, ltp: peProcessed.last_price, bid: peProcessed.bid, ask: peProcessed.ask });

  // Stage 4: Redis Serialization & Retrieval
  const redisCeQuote = {
    instrument_token: ceProcessed.instrument_token,
    last_price: ceProcessed.last_price,
    bid: ceProcessed.bid,
    ask: ceProcessed.ask,
    open: ceProcessed.ohlc.open,
    high: ceProcessed.ohlc.high,
    low: ceProcessed.ohlc.low,
    close: ceProcessed.ohlc.close,
    change: ceProcessed.last_price - ceProcessed.ohlc.close,
    changePercent: ((ceProcessed.last_price - ceProcessed.ohlc.close) / ceProcessed.ohlc.close) * 100,
    timestamp: timestamp
  };

  const redisPeQuote = {
    instrument_token: peProcessed.instrument_token,
    last_price: peProcessed.last_price,
    bid: peProcessed.bid,
    ask: peProcessed.ask,
    open: peProcessed.ohlc.open,
    high: peProcessed.ohlc.high,
    low: peProcessed.ohlc.low,
    close: peProcessed.ohlc.close,
    change: peProcessed.last_price - peProcessed.ohlc.close,
    changePercent: ((peProcessed.last_price - peProcessed.ohlc.close) / peProcessed.ohlc.close) * 100,
    timestamp: timestamp
  };

  console.log('\nSTAGE 4: Redis Quote Object');
  console.log('CE Redis Quote:', redisCeQuote);
  console.log('PE Redis Quote:', redisPeQuote);

  // Stage 5: MarketDataContext normalizeQuote
  const normalizedCe = normalizeQuote(redisCeQuote as any, 'MCX');
  const normalizedPe = normalizeQuote(redisPeQuote as any, 'MCX');

  console.log('\nSTAGE 5: MarketDataContext normalizeQuote Output');
  console.log('CE Normalized:', normalizedCe);
  console.log('PE Normalized:', normalizedPe);

  // Stage 6 & 7: OptionChainTable Rendering Simulation
  console.log('\nSTAGE 6 & 7: OptionChainTable Rendering Simulation');
  
  // LTP Mode Simulation
  const ceLtpRendered = normalizedCe.lastPrice ? `₹${normalizedCe.lastPrice.toFixed(1)}` : '---';
  const peLtpRendered = normalizedPe.lastPrice ? `₹${normalizedPe.lastPrice.toFixed(1)}` : '---';

  // B/A Mode Simulation
  const ceBidRendered = normalizedCe.bid > 0 ? normalizedCe.bid.toFixed(1) : '--- (depth unavailable)';
  const ceAskRendered = normalizedCe.ask > 0 ? normalizedCe.ask.toFixed(1) : '--- (depth unavailable)';
  const peBidRendered = normalizedPe.bid > 0 ? normalizedPe.bid.toFixed(1) : '--- (depth unavailable)';
  const peAskRendered = normalizedPe.ask > 0 ? normalizedPe.ask.toFixed(1) : '--- (depth unavailable)';

  console.log('LTP MODE RENDERED:');
  console.log('  159000 CE LTP:', ceLtpRendered);
  console.log('  159000 PE LTP:', peLtpRendered);

  console.log('B/A MODE RENDERED:');
  console.log('  159000 CE BID / ASK:', `${ceBidRendered} / ${ceAskRendered}`);
  console.log('  159000 PE BID / ASK:', `${peBidRendered} / ${peAskRendered}`);

  // Verification of Invariants
  console.log('\n================================================================');
  console.log('  INVARIANT COMPARISON ACROSS PIPELINE');
  console.log('================================================================');

  const ceLtpMatches = rawCeTick.last_price === normalizedCe.lastPrice;
  const ceBidMatches = rawCeTick.depth.buy[0].price === normalizedCe.bid;
  const ceAskMatches = rawCeTick.depth.sell[0].price === normalizedCe.ask;

  const peLtpMatches = rawPeTick.last_price === normalizedPe.lastPrice;
  const peBidMatches = rawPeTick.depth.buy[0].price === normalizedPe.bid;
  const peAskMatches = rawPeTick.depth.sell[0].price === normalizedPe.ask;

  console.log(`CE LTP Preserved: ${ceLtpMatches ? '✅ PASS' : '❌ FAIL'} (${rawCeTick.last_price} -> ${normalizedCe.lastPrice})`);
  console.log(`CE BID Preserved: ${ceBidMatches ? '✅ PASS' : '❌ FAIL'} (${rawCeTick.depth.buy[0].price} -> ${normalizedCe.bid})`);
  console.log(`CE ASK Preserved: ${ceAskMatches ? '✅ PASS' : '❌ FAIL'} (${rawCeTick.depth.sell[0].price} -> ${normalizedCe.ask})`);

  console.log(`PE LTP Preserved: ${peLtpMatches ? '✅ PASS' : '❌ FAIL'} (${rawPeTick.last_price} -> ${normalizedPe.lastPrice})`);
  console.log(`PE BID Preserved: ${peBidMatches ? '✅ PASS' : '❌ FAIL'} (${rawPeTick.depth.buy[0].price} -> ${normalizedPe.bid})`);
  console.log(`PE ASK Preserved: ${peAskMatches ? '✅ PASS' : '❌ FAIL'} (${rawPeTick.depth.sell[0].price} -> ${normalizedPe.ask})`);

  // Depthless tick test
  console.log('\n--- TESTING DEPTHLESS TICK (LTP-ONLY FEED) ---');
  const depthlessTick = {
    instrument_token: 142421255,
    last_price: 2355.0,
    ohlc: { open: 2100, high: 2400, low: 2000, close: 2200 },
    last_trade_time: timestamp
  };

  let depthlessProcessed: any = null;
  processor.on('tick', (key, tickData) => {
    if (key === 'MCX:GOLD26AUG159000CE') depthlessProcessed = tickData;
  });

  processor.processTicks([depthlessTick as any]);
  const normalizedDepthless = normalizeQuote(depthlessProcessed as any, 'MCX');

  console.log('Depthless Raw Tick:', { token: depthlessTick.instrument_token, ltp: depthlessTick.last_price, depth: 'NONE' });
  console.log('Processed Output:', { bid: depthlessProcessed.bid, ask: depthlessProcessed.ask });
  console.log('Normalized Output:', { bid: normalizedDepthless.bid, ask: normalizedDepthless.ask });

  assert(normalizedDepthless.bid === 2333.5, 'Preserves previous real depth bid without synthetic delta drift');
}

function assert(condition: boolean, message: string) {
  if (condition) console.log(`✅ PASS: ${message}`);
  else console.error(`❌ FAIL: ${message}`);
}

run7StagePipelineTest();
