const fs = require('fs');
const files = [
  'app/api/orders/route.ts',
  'app/api/positions/close/route.ts',
  'app/api/positions/[id]/close/route.ts'
];

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  // First, let's revert any manual Promise.race hacks I did previously if they exist
  content = content.replace(/const timeoutPromise = new Promise[\s\S]*?const res = await Promise\.race\[\(kitePromise, timeoutPromise\)\]\.catch\(\(\) => null\);/g, '');
  content = content.replace(/const kitePromise = fetch/g, 'const res = await fetch');
  content = content.replace(/const res = await Promise\.race\(\[kitePromise, timeoutPromise\]\)\.catch\(\(\) => null\);/g, '');
  content = content.replace(/const timeoutPromise = new Promise<Response>\(\(_, reject\) => setTimeout\(\(\) => reject\(new Error\('Kite timeout'\)\), 300\)\);/g, '');
  
  // Now add signal: AbortSignal.timeout(300) to every fetch options block
  content = content.replace(/cache:\s*'no-store'/g, "cache: 'no-store', signal: AbortSignal.timeout(300)");
  
  // Clean up any double additions
  content = content.replace(/signal:\s*AbortSignal\.timeout\(300\),\s*signal:\s*AbortSignal\.timeout\(300\)/g, "signal: AbortSignal.timeout(300)");

  fs.writeFileSync(file, content);
  console.log('Fixed', file);
});
