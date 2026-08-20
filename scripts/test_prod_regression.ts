import { chromium } from 'playwright-core';

async function runProdRegressionTest() {
  console.log('Launching browser to investigate production regression...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  // Test Session 1: Fresh Page Load (First Open)
  console.log('\n======================================================');
  console.log('>>> TEST 1: FRESH PAGE LOAD (First Open)');
  console.log('======================================================');

  const context1 = await browser.newContext();
  const page1 = await context1.newPage();

  page1.on('console', (msg) => {
    const text = msg.text();
    console.log(`[PAGE 1 LOG] ${text}`);
  });

  page1.on('pageerror', (err) => {
    console.error('[PAGE 1 ERROR]', err.message);
  });

  await context1.addInitScript(() => {
    (window as any).__disableAuthRedirect = true;
  });

  console.log('Navigating to http://localhost:3000/watchlist...');
  await page1.goto('http://localhost:3000/watchlist', { waitUntil: 'domcontentloaded' });

  await page1.waitForFunction(() => typeof (window as any).__reactOpenChartSheet === 'function', { timeout: 15000 });

  console.log('\nOpening chart for MCX:GOLD26OCTFUT...');
  await page1.evaluate(() => {
    (window as any).__reactOpenChartSheet({
      name: 'GOLD',
      symbol: 'MCX:GOLD26OCTFUT',
      kiteSymbol: 'MCX:GOLD26OCTFUT',
      segment: 'MCX - Futures',
      price: 0, change: '0%', contractDate: '', open: 0, high: 0, low: 0, close: 0
    });
  });

  await page1.waitForTimeout(1000);
  await page1.screenshot({ path: 'scratch/chart_page1_open.png' });

  console.log('Waiting 32 seconds to observe initial chart load / 30s timeout status...');
  await page1.waitForTimeout(31000);
  await page1.screenshot({ path: 'scratch/chart_page1_after_30s.png' });

  // Check chart status on Page 1 after 32 seconds
  const status1 = await page1.evaluate(() => {
    const errorEl = document.querySelector('.chart-error');
    const loadingEl = document.querySelector('.chart-loading');
    const iframeEl = document.querySelector('.chart-container iframe') || document.querySelector('iframe');
    return {
      hasErrorEl: !!errorEl,
      errorText: errorEl ? errorEl.textContent : null,
      hasLoadingEl: !!loadingEl,
      hasIframeEl: !!iframeEl
    };
  });
  console.log('\n[PAGE 1 CHART STATUS AFTER 32s]:', JSON.stringify(status1, null, 2));

  // Test Session 2: Navigating away and coming back (Second Open)
  console.log('\n======================================================');
  console.log('>>> TEST 2: NAVIGATING AWAY AND RETURNING (Second Open)');
  console.log('======================================================');

  console.log('Closing chart sheet on Page 1...');
  await page1.evaluate(() => {
    if (typeof (window as any).__reactSetChartItem === 'function') {
      (window as any).__reactSetChartItem(null);
    }
  });
  await page1.waitForTimeout(1000);

  console.log('Navigating away to http://localhost:3000/dashboard...');
  await page1.goto('http://localhost:3000/dashboard', { waitUntil: 'domcontentloaded' });
  await page1.waitForTimeout(2000);

  console.log('Returning to http://localhost:3000/watchlist...');
  await page1.goto('http://localhost:3000/watchlist', { waitUntil: 'domcontentloaded' });

  await page1.waitForFunction(() => typeof (window as any).__reactOpenChartSheet === 'function', { timeout: 15000 });

  console.log('\nReopening chart for MCX:GOLD26OCTFUT on second visit...');
  await page1.evaluate(() => {
    (window as any).__reactOpenChartSheet({
      name: 'GOLD',
      symbol: 'MCX:GOLD26OCTFUT',
      kiteSymbol: 'MCX:GOLD26OCTFUT',
      segment: 'MCX - Futures',
      price: 0, change: '0%', contractDate: '', open: 0, high: 0, low: 0, close: 0
    });
  });

  console.log('Waiting 5 seconds on second open...');
  await page1.waitForTimeout(5000);

  const status2 = await page1.evaluate(() => {
    const errorEl = document.querySelector('.chart-error');
    const loadingEl = document.querySelector('.chart-loading');
    const iframeEl = document.querySelector('.chart-container iframe');
    return {
      hasErrorEl: !!errorEl,
      errorText: errorEl ? errorEl.textContent : null,
      hasLoadingEl: !!loadingEl,
      hasIframeEl: !!iframeEl
    };
  });
  console.log('\n[PAGE 2 CHART STATUS ON SECOND VISIT]:', JSON.stringify(status2, null, 2));

  await browser.close();
  console.log('\n--- REGRESSION INVESTIGATION COMPLETED ---');
}

runProdRegressionTest().catch((err) => {
  console.error('Prod regression test failed:', err);
  process.exit(1);
});
