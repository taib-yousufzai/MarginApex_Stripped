const fs = require('fs');
let content = fs.readFileSync('components/TradeSheet.tsx', 'utf8');

const regex = /<<<<<<< Updated upstream[\s\S]*?=======\r?\n([\s\S]*?)>>>>>>> Stashed changes/;
content = content.replace(regex, \      } else {
        setIsClosing(true);
        setTimeout(() => {
          setIsClosing(false);
          onClose();
        }, 150); // Reduced timeout for snappy animation
      }\);

fs.writeFileSync('components/TradeSheet.tsx', content);
