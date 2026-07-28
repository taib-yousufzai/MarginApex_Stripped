const fs = require('fs');
let code = fs.readFileSync('app/position/page.tsx', 'utf8');

// Fix handleExit
code = code.replace(
  'const res = await closePosition(posId, posToClose?.ltp ?? undefined, posToClose?.symbol ?? undefined, posToClose?.settlement ?? undefined, posToClose?.side ?? undefined);',
  \const [res] = await Promise.all([
        closePosition(posId, posToClose?.ltp ?? undefined, posToClose?.symbol ?? undefined, posToClose?.settlement ?? undefined, posToClose?.side ?? undefined),
        new Promise(r => setTimeout(r, 800)) // Force animation to play for at least 800ms
      ]);\
);

// Fix handleExitAllConfirm (first instance of closePositionsBatch)
code = code.replace(
  'const result = await closePositionsBatch(posIds);',
  \const [result] = await Promise.all([
      closePositionsBatch(posIds),
      new Promise(r => setTimeout(r, 800)) // Force animation to play for at least 800ms
    ]);\
);

// Fix handleGroupExitAll (second instance of closePositionsBatch)
code = code.replace(
  'const result = await closePositionsBatch(posIds);',
  \const [result] = await Promise.all([
      closePositionsBatch(posIds),
      new Promise(r => setTimeout(r, 800)) // Force animation to play for at least 800ms
    ]);\
);

fs.writeFileSync('app/position/page.tsx', code);
