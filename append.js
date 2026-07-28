const fs = require('fs');
let c = fs.readFileSync('app/index.css', 'utf8');

c += \n
/* Skeleton Loader */
@keyframes bm-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

.bm-skeleton {
  background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 50%, #e5e7eb 75%);
  background-size: 200% 100%;
  animation: bm-shimmer 2s infinite linear;
  border-radius: 4px;
}

.dark .bm-skeleton {
  background: linear-gradient(90deg, #1f2937 25%, #374151 50%, #1f2937 75%);
  background-size: 200% 100%;
}
;

fs.writeFileSync('app/index.css', c);
console.log('Added .bm-skeleton to app/index.css');
