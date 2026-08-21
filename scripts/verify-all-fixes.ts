import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function runRegressionVerification() {
  console.log('====================================================');
  console.log('  STARTING COMPREHENSIVE TRADING DATA AUDIT VERIFICATION');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${message}`);
      failed++;
    }
  }

  // 1. Verify FOREX Watchlist / Search Classification (Bug #2)
  console.log('--- 1. Testing Search API FOREX Tab Classification ---');
  const { GET: searchGET } = await import('../app/api/market/instruments/search/route');

  const reqGold = new Request('http://localhost/api/market/instruments/search?q=Gold&tab=FOREX');
  const resGold = await searchGET(reqGold as any);
  const jsonGold = await resGold.json();
  assert(
    Array.isArray(jsonGold) && jsonGold.length === 0,
    `Searching "Gold" under FOREX tab returns 0 results (Got ${jsonGold?.length ?? 0})`
  );

  const reqSilver = new Request('http://localhost/api/market/instruments/search?q=Silver&tab=FOREX');
  const resSilver = await searchGET(reqSilver as any);
  const jsonSilver = await resSilver.json();
  assert(
    Array.isArray(jsonSilver) && jsonSilver.length === 0,
    `Searching "Silver" under FOREX tab returns 0 results (Got ${jsonSilver?.length ?? 0})`
  );

  const reqCrude = new Request('http://localhost/api/market/instruments/search?q=Crude&tab=FOREX');
  const resCrude = await searchGET(reqCrude as any);
  const jsonCrude = await resCrude.json();
  assert(
    Array.isArray(jsonCrude) && jsonCrude.length === 0,
    `Searching "Crude" under FOREX tab returns 0 results (Got ${jsonCrude?.length ?? 0})`
  );

  // 2. Verify Currency Pair Search (Bug #2)
  console.log('\n--- 2. Testing Search API Currency Pairs Support ---');
  const currencyPairs = [
    'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'USD/CAD',
    'AUD/USD', 'NZD/USD', 'USD/INR', 'EUR/INR', 'GBP/INR', 'JPY/INR'
  ];

  for (const pair of currencyPairs) {
    const reqPair = new Request(`http://localhost/api/market/instruments/search?q=${encodeURIComponent(pair)}&tab=FOREX`);
    const resPair = await searchGET(reqPair as any);
    const jsonPair = await resPair.json();
    assert(
      Array.isArray(jsonPair) && jsonPair.length > 0,
      `Searching currency pair "${pair}" under FOREX tab returns results (${jsonPair?.length ?? 0} items found)`
    );
  }

  // 3. Verify MCX Option Chain API (Bug #1)
  console.log('\n--- 3. Testing MCX GOLD Option Chain API ---');
  const { GET: optionChainGET } = await import('../app/api/market/option-chain/route');
  const reqOc = new Request('http://localhost/api/market/option-chain?symbol=GOLD');
  const resOc = await optionChainGET(reqOc as any);
  const jsonOc = await resOc.json();

  assert(jsonOc.success === true, 'Option chain API returns success: true');
  assert(jsonOc.symbol === 'GOLD', 'Option chain API symbol is GOLD');
  assert(Array.isArray(jsonOc.expiries) && jsonOc.expiries.length > 0, `Option chain returns expiries: ${jsonOc.expiries?.join(', ')}`);
  assert(Array.isArray(jsonOc.strikes) && jsonOc.strikes.length > 0, `Option chain returns strikes count: ${jsonOc.strikes?.length}`);
  assert(jsonOc.underlyingPrice > 0, `Option chain underlying spot/future price is resolved (${jsonOc.underlyingPrice})`);

  // 4. Verify Ticker Subscription Manager active tokens resolution (Bug #1)
  console.log('\n--- 4. Testing Subscription Manager Core Futures Resolution ---');
  const { SubscriptionManager } = await import('../scripts/ticker/subscriptionManager');
  const manager = new SubscriptionManager();
  const activeInstruments = await manager.getActiveInstruments();
  assert(
    Array.isArray(activeInstruments) && activeInstruments.length > 0,
    `SubscriptionManager resolved active instruments (total ${activeInstruments.length})`
  );
  const goldSub = activeInstruments.find(i => i.symbolKey.includes('GOLD'));
  assert(!!goldSub, `SubscriptionManager resolved active GOLD contract: ${goldSub?.symbolKey}`);

  // Summary
  console.log('\n====================================================');
  console.log(`  VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runRegressionVerification();
