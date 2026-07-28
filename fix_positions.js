const fs = require('fs');

let content = fs.readFileSync('hooks/useMyPositions.ts', 'utf8');

// Add the event listener to clear global cache on order_placed
if (!content.includes('window.addEventListener(\\'order_placed\\', () => { globalPositionsCache')) {
  content = content.replace(
    /let globalPositionsCache: MyPosition\[\] = \[\];/g,
    \let globalPositionsCache: MyPosition[] = [];
if (typeof window !== 'undefined') {
  window.addEventListener('order_placed', () => { globalPositionsCache = []; });
}\
  );
  fs.writeFileSync('hooks/useMyPositions.ts', content);
}
