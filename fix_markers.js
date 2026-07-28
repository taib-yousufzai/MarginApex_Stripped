const fs = require('fs');

let wl = fs.readFileSync('app/watchlist/page.tsx', 'utf8');
const searchString = \<<<<<<< Updated upstream
                    return next;
                  });
=======\;
wl = wl.replace(searchString, \                    return next;
                  });\);
fs.writeFileSync('app/watchlist/page.tsx', wl);
