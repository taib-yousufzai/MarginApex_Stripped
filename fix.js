const fs = require('fs');
let code = fs.readFileSync('app/api/positions/[id]/close/route.ts', 'utf8');

code = code.split('fetchLtp(speculativeSymbol, speculativeSegment)').join('(clientPrice ? Promise.resolve(null) : fetchLtp(speculativeSymbol, speculativeSegment))');

code = code.split('} else if (!finalKiteLtp) {').join('} else if (!clientPrice && !finalKiteLtp) {');

code = code.split('const basePrice = clientPrice || (pos.side === \\'BUY\\' ? finalKiteLtp.bid : finalKiteLtp.ask);').join('const basePrice = clientPrice || (pos.side === \\'BUY\\' ? finalKiteLtp!.bid : finalKiteLtp!.ask);');

fs.writeFileSync('app/api/positions/[id]/close/route.ts', code);
