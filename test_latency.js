const start = Date.now();
fetch('http://localhost:3000/api/positions/00000000-0000-0000-0000-000000000000/close', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ symbol: 'RELIANCE', settlement: 'EQ', side: 'BUY' })
}).then(res => {
  const elapsed = Date.now() - start;
  console.log(`Elapsed time: ${elapsed} ms`);
  console.log(`Status: ${res.status}`);
}).catch(err => {
  console.error('Error:', err);
});
