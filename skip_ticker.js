const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory() && !file.includes('node_modules') && !file.includes('.git')) {
      results = results.concat(walk(file));
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      results.push(file);
    }
  });
  return results;
}

const files = walk('app');
let replacedCount = 0;

files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  let newContent = content;
  
  // Replace the tickerUrl fallback logic
  // Original: const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : 'http://localhost:8080');
  // New: const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : null);
  const regex = /const tickerUrl = process\.env\.NEXT_PUBLIC_TICKER_URL \|\| \(process\.env\.NODE_ENV === 'production' \? 'https:\/\/marginapexx-production\.up\.railway\.app' : 'http:\/\/localhost:8080'\);/g;
  
  newContent = newContent.replace(regex, "const tickerUrl = process.env.NEXT_PUBLIC_TICKER_URL || (process.env.NODE_ENV === 'production' ? 'https://marginapexx-production.up.railway.app' : null);");
  
  // Also guard the fetch so it doesn't run if tickerUrl is null
  // We can't easily replace the whole try/catch with regex, but if tickerUrl is null, `${tickerUrl}/quotes` will become `null/quotes`.
  // Wait, if it becomes `null/quotes`, it will try to fetch from localhost:3000/null/quotes and fail!
  // So we should replace the fetch line too:
  // Original: const resTicker = await fetch(`${tickerUrl}/quotes?...`);
  // New: if (!tickerUrl) throw new Error('No Ticker'); const resTicker = await fetch(`${tickerUrl}/quotes?...`);
  
  const fetchRegex = /const resTicker = await fetch\(`\$\{tickerUrl\}\/quotes\?\$\{params\}`/g;
  newContent = newContent.replace(fetchRegex, "if (!tickerUrl) throw new Error('No tickerUrl');\n      const resTicker = await fetch(`${tickerUrl}/quotes?${params}`");

  if (newContent !== content) {
    fs.writeFileSync(f, newContent);
    replacedCount++;
    console.log('Updated', f);
  }
});

console.log('Replaced in ' + replacedCount + ' files');
