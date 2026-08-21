import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const { GET } = await import('../app/api/market/instruments/search/route');
  
  // Test searching Gold in FOREX tab
  const reqGold = new Request('http://localhost/api/market/instruments/search?q=Gold&tab=FOREX');
  const resGold = await GET(reqGold as any);
  const jsonGold = await resGold.json();
  console.log('Search "Gold" under FOREX tab returns:', jsonGold);

  // Test searching currency pairs under FOREX tab
  const pairs = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'USD/CAD', 'AUD/USD', 'NZD/USD', 'USD/INR', 'EUR/INR', 'GBP/INR', 'JPY/INR'];
  for (const pair of pairs) {
    const reqPair = new Request(`http://localhost/api/market/instruments/search?q=${encodeURIComponent(pair)}&tab=FOREX`);
    const resPair = await GET(reqPair as any);
    const jsonPair = await resPair.json();
    console.log(`Search "${pair}" under FOREX tab returns ${jsonPair.length || 0} results:`, jsonPair.map((r: any) => r.name || r.symbol));
  }

  process.exit(0);
}

main();
