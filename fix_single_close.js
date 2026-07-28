const fs = require('fs');
let code = fs.readFileSync('app/api/positions/[id]/close/route.ts', 'utf8');

// 1. Add (clientPrice ? Promise.resolve(null) : ... )
code = code.replace(
  /fetchLtp\(speculativeSymbol, speculativeSegment\)/,
  \(clientPrice ? Promise.resolve(null) : fetchLtp(speculativeSymbol, speculativeSegment))\
);

// 2. Fix the error handling to allow clientPrice
code = code.replace(
  /} else if \(\!finalKiteLtp\) {/,
  } else if (!clientPrice && !finalKiteLtp) {
);

fs.writeFileSync('app/api/positions/[id]/close/route.ts', code);
