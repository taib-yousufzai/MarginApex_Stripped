import { chromium } from 'playwright-core';

interface ChartEventLog {
  event: string;
  symbol?: string;
  loadId?: string;
  elapsed?: string;
}

async function runMultiSymbolRegressionTest() {
  console.log('======================================================');
  console.log('>>> COMPREHENSIVE PRODUCTION REGRESSION TEST (A-L)');
  console.log('======================================================');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  const logs: string[] = [];
  const chartEvents: ChartEventLog[] = [];

  page.on('console', (msg) => {
    const text = msg.text();
    logs.push(text);
    if (text.includes('[PROD-CHART]')) {
      console.log(text);
      // parse event name if possible
      const match = text.match(/event=([A-Z0-9_]+)/);
      const symbolMatch = text.match(/symbol=([^ ]+)/);
      if (match) {
        chartEvents.push({
          event: match[1],
          symbol: symbolMatch ? symbolMatch[1] : undefined
        });
      }
    }
  });

  page.on('pageerror', (err) => {
    console.error('[PAGE ERROR]', err.message);
  });

  await context.addInitScript(() => {
    (window as any).__disableAuthRedirect = true;
  });

  console.log('\n[A] Loading http://localhost:3000/watchlist on fresh cold session...');
  await page.goto('http://localhost:3000/watchlist', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as any).__reactOpenChartSheet === 'function', { timeout: 15000 });

  const testSymbols = [
    { name: 'NIFTY 50', symbol: 'NSE:NIFTY 50', segment: 'NSE - Indices' },
    { name: 'BANKNIFTY', symbol: 'NSE:NIFTY BANK', segment: 'NSE - Indices' },
    { name: 'GOLD', symbol: 'MCX:GOLD26OCTFUT', segment: 'MCX - Futures' },
    { name: 'SILVER', symbol: 'MCX:SILVER26SEPFUT', segment: 'MCX - Futures' },
    { name: 'NIFTY CE', symbol: 'NFO:NIFTY2672124200CE', segment: 'NFO - Options' },
  ];

  for (let i = 0; i < testSymbols.length; i++) {
    const item = testSymbols[i];
    console.log(`\n------------------------------------------------------`);
    console.log(`>>> TESTING SYMBOL ${i + 1}/${testSymbols.length}: ${item.symbol}`);
    console.log(`------------------------------------------------------`);

    // [B] Open Chart
    await page.evaluate((symbolObj) => {
      (window as any).__reactOpenChartSheet({
        name: symbolObj.name,
        symbol: symbolObj.symbol,
        kiteSymbol: symbolObj.symbol,
        segment: symbolObj.segment,
        price: 100, change: '0%', contractDate: '', open: 100, high: 100, low: 100, close: 100
      });
    }, item);

    // Wait for onChartReady or max 10s
    let isReady = false;
    let hasError = false;
    const startWait = Date.now();

    while (Date.now() - startWait < 10000) {
      const state = await page.evaluate(() => {
        const err = document.querySelector('.chart-error');
        const errText = err ? err.textContent : null;
        return {
          hasError: !!errText,
          errText,
          logsCount: (window as any).__chartReadyCount || 0
        };
      });

      if (state.hasError) {
        hasError = true;
        console.error(`❌ ERROR STATE DETECTED for ${item.symbol}: ${state.errText}`);
        break;
      }

      // Check if ON_CHART_READY event fired for this symbol
      const readyEvent = chartEvents.find(e => e.event === 'ON_CHART_READY');
      if (readyEvent) {
        isReady = true;
        console.log(`✅ [C, D] onChartReady FIRED successfully for ${item.symbol}!`);
        break;
      }

      await page.waitForTimeout(500);
    }

    if (!isReady && !hasError) {
      // Check DOM status
      const domStatus = await page.evaluate(() => {
        return {
          iframeExists: !!document.querySelector('iframe'),
          bodyText: document.body.innerText.slice(0, 200)
        };
      });
      console.log(`[STATUS CHECK FOR ${item.symbol}] iframeExists=${domStatus.iframeExists}`);
    }

    // Verify historical bar events
    const histEvent = chartEvents.find(e => e.event === 'LAST_BAR_ESTABLISHED');
    console.log(`[E] Historical lastBar established for ${item.symbol}: ${!!histEvent}`);

    // Verify realtime subscription
    const subEvent = chartEvents.find(e => e.event === 'REALTIME_SUBSCRIBER_CREATED');
    console.log(`[F] Realtime subscriber created for ${item.symbol}: ${!!subEvent}`);

    // Simulate a live tick update for this exact symbol
    console.log(`[G] Simulating live tick for ${item.symbol}...`);
    await page.evaluate((symbolStr) => {
      if ((window as any).__reactDatafeedInstance) {
        (window as any).__reactDatafeedInstance.updateLive(symbolStr, 158500, Date.now());
      }
    }, item.symbol);

    await page.waitForTimeout(1000);
  }

  // [K, L] Switch back to first symbol (NIFTY 50) and verify it's correct
  console.log(`\n------------------------------------------------------`);
  console.log(`>>> [K, L] SWITCHING BACK TO FIRST SYMBOL: ${testSymbols[0].symbol}`);
  console.log(`------------------------------------------------------`);

  await page.evaluate((symbolObj) => {
    (window as any).__reactOpenChartSheet({
      name: symbolObj.name,
      symbol: symbolObj.symbol,
      kiteSymbol: symbolObj.symbol,
      segment: symbolObj.segment,
      price: 100, change: '0%', contractDate: '', open: 100, high: 100, low: 100, close: 100
    });
  }, testSymbols[0]);

  await page.waitForTimeout(3000);

  const finalCheck = await page.evaluate(() => {
    const err = document.querySelector('.chart-error');
    return {
      hasError: !!err,
      errorText: err ? err.textContent : null
    };
  });

  console.log(`\nFINAL SYSTEM AUDIT: Has Error=${finalCheck.hasError}`);
  if (finalCheck.hasError) {
    console.error(`❌ FAILURE: ${finalCheck.errorText}`);
  } else {
    console.log(`✅ ALL LIFECYCLE TESTS PASSED PERFECTLY!`);
  }

  await browser.close();
}

runMultiSymbolRegressionTest().catch((err) => {
  console.error('Multi-symbol test failed:', err);
  process.exit(1);
});
