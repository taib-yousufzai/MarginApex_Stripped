const fs = require('fs');
let content = fs.readFileSync('app/api/positions/close/route.ts', 'utf8');

const originalLoop = \    // 4. Process closing for each position sequentially to avoid DB deadlocks
    const results = [];
    for (const { pos, lookupKey } of posSymbols) {\;

const newLoop = \    // 4. Process closing in small chunks to maximize speed while avoiding massive DB deadlock storms
    const results: any[] = [];
    const chunkSize = 10;
    
    for (let i = 0; i < posSymbols.length; i += chunkSize) {
      const chunk = posSymbols.slice(i, i + chunkSize);
      
      const chunkPromises = chunk.map(async ({ pos, lookupKey }) => {\;

const originalEnd = \          results.push({ positionId: pos.id, success: true, pnl: Number(pnl), exit_price: exitPrice });
        } catch (innerErr: any) {
          results.push({ positionId: pos.id, success: false, error: innerErr.message || 'Unknown error' });
        }
    }\;

const newEnd = \          results.push({ positionId: pos.id, success: true, pnl: Number(pnl), exit_price: exitPrice });
        } catch (innerErr: any) {
          results.push({ positionId: pos.id, success: false, error: innerErr.message || 'Unknown error' });
        }
      });
      
      await Promise.all(chunkPromises);
    }\;

if (content.includes(originalLoop) && content.includes(originalEnd)) {
    content = content.replace(originalLoop, newLoop);
    content = content.replace(originalEnd, newEnd);
    fs.writeFileSync('app/api/positions/close/route.ts', content);
    console.log("Chunking applied to app/api/positions/close/route.ts");
} else {
    console.log("Could not find loop signature.");
}
