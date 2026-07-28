(Get-Content components\TradeSheet.tsx) -replace '(?s)<<<<<<< Updated upstream.*?=======.*?(?=>+)', '      } else {
        setIsClosing(true);
        setTimeout(() => {
          setIsClosing(false);
          onClose();
        }, 380); // match CSS transition time
      }' -replace '>>>>>>> Stashed changes', '' | Set-Content components\TradeSheet.tsx

(Get-Content app\watchlist\page.tsx) -replace '(?s)<<<<<<< Updated upstream.*?=======', '                    return next;
                  });' -replace '>>>>>>> Stashed changes', '' | Set-Content app\watchlist\page.tsx
