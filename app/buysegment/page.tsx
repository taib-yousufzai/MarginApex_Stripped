
'use client';
import { useEffect, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError } from '@/lib/api';
import './page.css';

declare global {
  interface Window {
    __executeOrderViaBridge?: (payload: {
      symbol: string;
      kite_instrument: string;
      segment: string;
      side: string;
      order_type: string;
      product_type: string;
      qty: number;
      lots: number;
      client_price: number;
    }) => Promise<{ ok: boolean; fill_price?: number; error?: string }>;
  }
}

export default function Page() {
  useAuth();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Expose an order bridge that uses the shared api client (auth injected automatically)
    window.__executeOrderViaBridge = async (payload) => {
      try {
        const result = await api.post<{ fill_price: number }>('/api/orders', payload);
        return { ok: true, fill_price: result.fill_price };
      } catch (err) {
        const message = err instanceof ApiError
          ? (err.details as any)?.error ?? `API error ${err.status}`
          : 'Network error';
        return { ok: false, error: message };
      }
    };

    return () => {
      delete window.__executeOrderViaBridge;
    };
  }, []);

  useEffect(() => {
    let injectedScript: HTMLScriptElement | null = null;

    const script = document.createElement('script');
    injectedScript = script;
    // Use String.raw to prevent Turbopack from parsing the JS string as TypeScript
    script.textContent = String.raw`
    // COMPLETE TRADING DATABASE
    var allScripts = [
        { name: "NIFTY FUT",     symbol: "NIFTY_FUT",     kiteInstrument: "NFO:NIFTY25MAYFUT",     price: 22456.80, change: "+0.45%", segment: "INDEX - FUTURE",  lotSize: 65,  maxLots: 100,  marginPercent: 0.12 },
        { name: "SENSEX FUT",    symbol: "SENSEX_FUT",    kiteInstrument: "BSE:SENSEX",             price: 74230.15, change: "+0.32%", segment: "INDEX - FUTURE",  lotSize: 20,  maxLots: 100,  marginPercent: 0.12 },
        { name: "BANKNIFTY FUT", symbol: "BANKNIFTY_FUT", kiteInstrument: "NFO:BANKNIFTY25MAYFUT", price: 48210.50, change: "-0.21%", segment: "INDEX - FUTURE",  lotSize: 30,  maxLots: 150,  marginPercent: 0.12 },
        { name: "RELIANCE FUT",  symbol: "RELIANCE_FUT",  kiteInstrument: "NFO:RELIANCE25MAYFUT",  price: 2856.40,  change: "+0.75%", segment: "STOCKS - FUTURE", lotSize: 250, maxLots: 50,   marginPercent: 0.15 },
        { name: "RELIANCE EQ",   symbol: "RELIANCE",      kiteInstrument: "NSE:RELIANCE",           price: 2845.30,  change: "+0.68%", segment: "NSE - EQ",        lotSize: 1,   maxLots: 5000, marginPercent: 0.20 },
        { name: "BTC/USDT",      symbol: "BTCUSDT",       kiteInstrument: "CRYPTO:BTC",             price: 68450.20, change: "+2.1%",  segment: "CRYPTO",          lotSize: 0.01,maxLots: 100,  marginPercent: 0.05 },
        { name: "GOLD FUT",      symbol: "GOLD_FUT",      kiteInstrument: "MCX:GOLD25MAYFUT",      price: 62340.00, change: "+0.28%", segment: "MCX - FUTURE",    lotSize: 1,   maxLots: 100,  marginPercent: 0.08 }
    ];

    var watchlistItems = [], selectedIndices = new Set(), selectionMode = false;
    var currentScript = null, currentTradeType = null, selectedAction = null, currentIsLotMode = false, currentOrderType = "market", currentProductType = "intraday", currentQuantity = 1;
    var BROKERAGE_FLAT = 5;

    
    setTimeout(() => {
       document.querySelectorAll('.footer-tab').forEach(tab => {
           tab.classList.remove('active');
           if (tab.getAttribute('data-tab') === 'buysegment') tab.classList.add('active');
       });
    }, 100);
         
    // DOM Elements
    var watchlistContainer = document.getElementById('watchlistMobileContainer');
    var watchlistCounter = document.getElementById('mobileWatchlistCounter');
    var multiSelectBar = document.getElementById('multiSelectBar');
    var selectedCountSpan = document.getElementById('selectedCount');
    var selectAllBtn = document.getElementById('selectAllBtn');
    var unselectAllBtn = document.getElementById('unselectAllBtn');
    var deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
    var exitSelectionBtn = document.getElementById('exitSelectionBtn');
    var searchInput = document.getElementById('globalSearchInput');
    var clearSearchBtn = document.getElementById('clearSearchBtn');
    var searchResultsArea = document.getElementById('searchResultsArea');
    var searchResultsList = document.getElementById('searchResultsList');
    var searchResultCount = document.getElementById('searchResultCount');
    var tradeSheet = document.getElementById('tradeSheet');
    var tradeSheetOverlay = document.getElementById('tradeSheetOverlay');
    var orderFullpage = document.getElementById('orderFullpage');
    var orderFullpageOverlay = document.getElementById('orderFullpageOverlay');
    var folderDrawer = document.getElementById('scriptsFolderDrawer');
    var openBtn = document.getElementById('openFolderMobileBtn');
    var closeDrawerBtn = document.getElementById('closeFolderDrawerBtn');
    var overlay = document.getElementById('drawerOverlay');
    var toastEl = document.getElementById('toastMessageMobile');
    var toastTimeout = null, longPressTimer = null;

    function showToast(msg, isError = false) { 
        if (toastTimeout) clearTimeout(toastTimeout); 
        toastEl.textContent = msg; 
        toastEl.style.background = isError ? "#C62E2E" : "#2C8E5A"; 
        toastEl.style.opacity = "1"; 
        toastTimeout = setTimeout(() => toastEl.style.opacity = "0", 2000); 
    }

    function formatPrice(price) { 
        var num = typeof price === 'number' ? price : parseFloat(price); 
        return \`₹\${num.toLocaleString('en-IN', { minimumFractionDigits: 2 })}\`; 
    }
    
    function formatPriceNumber(price) {
        var num = typeof price === 'number' ? price : parseFloat(price);
        return num.toLocaleString('en-IN', { minimumFractionDigits: 2 });
    }

    function generateBidAsk(script) {
        var price = script.price;
        return { bid: price * 0.9995, ask: price * 1.0005 }; 
    }

    function openTradeSheet(script) {
        currentScript = script; 
        document.getElementById('tradeScriptName').innerText = script.name; 
        document.getElementById('tradeSegment').innerText = script.segment;
        document.getElementById('tradeCmpValue').innerText = formatPrice(script.price);
        var isPositive = script.change.includes('+'); 
        document.getElementById('tradeChange').innerText = script.change;
        document.getElementById('tradeChange').className = \`sheet-change \${isPositive ? 'positive' : 'negative'}\`;
        const { bid, ask } = generateBidAsk(script); 
        document.getElementById('tradeBid').innerText = formatPrice(bid); 
        document.getElementById('tradeAsk').innerText = formatPrice(ask);
        tradeSheet.classList.add('open'); 
        tradeSheetOverlay.classList.add('active');
    }

    function closeTradeSheet() { 
        tradeSheet.classList.remove('open'); 
        tradeSheetOverlay.classList.remove('active'); 
    }

    function closeOrderFullpage() { 
        orderFullpage.classList.remove('open'); 
        orderFullpageOverlay.classList.remove('active'); 
    }

    function updateLotInfoDisplay() {
        var lotSize = currentScript.lotSize || 1, maxLots = currentScript.maxLots || 100;
        var orderLots = currentIsLotMode ? currentQuantity : Math.floor(currentQuantity / lotSize);
        if (!currentIsLotMode && currentQuantity < lotSize) orderLots = 0;
        var totalQty = currentIsLotMode ? currentQuantity * lotSize : currentQuantity;
        document.getElementById('lotSizeValue').innerText = lotSize; 
        document.getElementById('maxLotsValue').innerText = maxLots;
        document.getElementById('orderLotsValue').innerText = orderLots; 
        document.getElementById('totalQtyValue').innerText = totalQty;
    }

    function updateMarginDisplay() {
        var lotSize = currentScript.lotSize || 1, actualQty = currentIsLotMode ? currentQuantity * lotSize : currentQuantity;
        var exposure = actualQty * currentScript.price, marginPercent = currentScript.marginPercent || 0.12;
        var requiredMargin = exposure * marginPercent, carryMargin = exposure * marginPercent * 1.5, availableMargin = 125000;
        document.getElementById('requiredMargin').innerHTML = formatPrice(requiredMargin);
        document.getElementById('carryMargin').innerHTML = formatPrice(carryMargin);
        document.getElementById('availableMargin').innerHTML = formatPrice(availableMargin);
        
        var brokerageRow = document.getElementById('brokerageRow');
        if (currentOrderType === 'gtt') {
            brokerageRow.style.display = 'block';
            document.getElementById('brokerageAmount').innerHTML = \`₹\${BROKERAGE_FLAT}.00\`;
        } else {
            brokerageRow.style.display = 'none';
        }
    }

    function openOrderFullpage(type) {
        currentTradeType = type;
        selectedAction = type;
        currentQuantity = 1; 
        currentIsLotMode = false; 
        currentOrderType = "market";
        document.getElementById('qtyLotSwitch').checked = false;
        document.getElementById('orderScriptName').innerText = currentScript.name; 
        document.getElementById('orderSegment').innerText = currentScript.segment;
        document.getElementById('orderCmpValue').innerText = formatPrice(currentScript.price);
        var isPositive = currentScript.change.includes('+');
        document.getElementById('orderChange').innerText = currentScript.change;
        document.getElementById('orderChange').className = \`order-change \${isPositive ? 'positive' : 'negative'}\`;
        const { bid, ask } = generateBidAsk(currentScript.price);
        document.getElementById('orderBid').innerText = formatPriceNumber(bid);
        document.getElementById('orderAsk').innerText = formatPriceNumber(ask);
        document.getElementById('orderQtyInput').value = currentQuantity;
        updateQuantityModeDisplay(); 
        updateMarginDisplay(); 
        updateLotInfoDisplay();
        document.querySelectorAll('[data-order-type]').forEach(btn => btn.classList.remove('active'));
        document.querySelector('[data-order-type="market"]').classList.add('active');
        document.getElementById('limitPriceContainer').style.display = 'none';
        document.getElementById('slmContainer').style.display = 'none';
        document.getElementById('gttContainer').style.display = 'none';
        document.querySelectorAll('[data-product-type]').forEach(btn => btn.classList.remove('active'));
        document.querySelector('[data-product-type="intraday"]').classList.add('active');
        var buyBtn = document.getElementById('confirmBuyBtn');
        var sellBtn = document.getElementById('confirmSellBtn');
        if (selectedAction === 'buy') {
            buyBtn.style.display = 'flex';
            buyBtn.style.width = '100%';
            sellBtn.style.display = 'none';
        } else {
            sellBtn.style.display = 'flex';
            sellBtn.style.width = '100%';
            buyBtn.style.display = 'none';
        }
        closeTradeSheet(); 
        orderFullpage.classList.add('open'); 
        orderFullpageOverlay.classList.add('active');
    }

    function updateQuantityModeDisplay() {
        var lotSize = currentScript.lotSize || 1;
        document.getElementById('qtyLabel').innerHTML = currentIsLotMode ? \`LOTS (1 Lot = \${lotSize} units)\` : "QUANTITY";
        document.getElementById('lotSizeInfo').innerHTML = currentIsLotMode ? \`Lot Size: \${lotSize} | \${currentQuantity} Lot = \${currentQuantity * lotSize} Units\` : \`Lot Size: \${lotSize} | 1 Lot = \${lotSize} Units\`;
        document.getElementById('orderQtyInput').value = currentQuantity;
        updateLotInfoDisplay(); 
        updateMarginDisplay();
    }

    function updateQuantity(value) {
        var lotSize = currentScript.lotSize || 1, maxLots = currentScript.maxLots || 100;
        var newVal = Math.max(1, Math.min(value, currentIsLotMode ? maxLots : maxLots * lotSize));
        currentQuantity = newVal;
        document.getElementById('orderQtyInput').value = currentQuantity;
        updateLotInfoDisplay(); 
        updateMarginDisplay();
    }

    async function executeFinalOrder() {
        var lotSize = currentScript.lotSize || 1;
        var actualQty = currentIsLotMode ? currentQuantity * lotSize : currentQuantity;
        var price = currentScript.price;
        if (currentOrderType === 'limit') { var lp = parseFloat(document.getElementById('limitPriceInput')?.value); if (lp && lp > 0) price = lp; }
        var orderTypeMap = { market: 'MARKET', limit: 'LIMIT', slm: 'SLM', gtt: 'GTT' };
        var btn = document.getElementById(selectedAction === 'buy' ? 'confirmBuyBtn' : 'confirmSellBtn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Placing...'; }
        try {
            var bridge = window.__executeOrderViaBridge;
            var result = bridge ? await bridge({
                    symbol: currentScript.symbol,
                    kite_instrument: currentScript.kiteInstrument || currentScript.symbol,
                    segment: currentScript.segment,
                    side: currentTradeType.toUpperCase(),
                    order_type: orderTypeMap[currentOrderType] || 'MARKET',
                    product_type: currentProductType === 'intraday' ? 'INTRADAY' : 'CARRY',
                    qty: actualQty,
                    lots: currentIsLotMode ? currentQuantity : Math.floor(actualQty / lotSize),
                    client_price: price
                }) : { ok: false, error: 'Order bridge not ready' };
            if (result.ok) {
                showToast('\u2713 Order placed @ \u20b9' + result.fill_price.toLocaleString('en-IN', {minimumFractionDigits: 2}));
            } else {
                showToast(result.error || 'Order failed. Try again.', true);
            }
        } catch(e) {
            showToast('Network error. Please try again.', true);
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = selectedAction === 'buy' ? '<i class="fas fa-arrow-up"></i> BUY' : '<i class="fas fa-arrow-down"></i> SELL'; }
        }
        closeOrderFullpage();
    }

    // Event Listeners
    document.getElementById('qtyLotSwitch').addEventListener('change', (e) => { currentIsLotMode = e.target.checked; updateQuantityModeDisplay(); });
    document.getElementById('orderQtyMinus').addEventListener('click', () => updateQuantity(currentQuantity - 1));
    document.getElementById('orderQtyPlus').addEventListener('click', () => updateQuantity(currentQuantity + 1));
    document.getElementById('orderQtyInput').addEventListener('change', (e) => updateQuantity(parseFloat(e.target.value) || 1));
    
    document.querySelectorAll('[data-order-type]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-order-type]').forEach(b => b.classList.remove('active')); 
            btn.classList.add('active');
            currentOrderType = btn.getAttribute('data-order-type');
            document.getElementById('limitPriceContainer').style.display = currentOrderType === 'limit' ? 'block' : 'none';
            document.getElementById('slmContainer').style.display = currentOrderType === 'slm' ? 'block' : 'none';
            document.getElementById('gttContainer').style.display = currentOrderType === 'gtt' ? 'block' : 'none';
            updateMarginDisplay();
        });
    });
    document.querySelectorAll('[data-product-type]').forEach(btn => {
        btn.addEventListener('click', () => { 
            document.querySelectorAll('[data-product-type]').forEach(b => b.classList.remove('active')); 
            btn.classList.add('active'); 
            currentProductType = btn.getAttribute('data-product-type'); 
        });
    });
    document.getElementById('confirmBuyBtn').addEventListener('click', () => { currentTradeType = 'buy'; executeFinalOrder(); });
    document.getElementById('confirmSellBtn').addEventListener('click', () => { currentTradeType = 'sell'; executeFinalOrder(); });
    document.getElementById('backToTradeSheetBtn').addEventListener('click', () => { closeOrderFullpage(); openTradeSheet(currentScript); });
    document.getElementById('proceedToOrderBuy').addEventListener('click', () => openOrderFullpage('buy'));
    document.getElementById('proceedToOrderSell').addEventListener('click', () => openOrderFullpage('sell'));
    tradeSheetOverlay.addEventListener('click', closeTradeSheet); 
    orderFullpageOverlay.addEventListener('click', closeOrderFullpage);

    // Simplified Watchlist Functions
    function renderWatchlist() {
        if (watchlistItems.length === 0) {
            watchlistContainer.innerHTML = \`<div class="empty-watchlist"><i class="fas fa-plus-circle"></i><p>Your watchlist is empty</p><p>Search or tap Scripts Library +</p></div>\`;
            watchlistCounter.innerText = \`0 items\`;
            return;
        }
        var html = \`<div class="watchlist-card-list">\`;
        watchlistItems.forEach((item, idx) => {
            var isPositive = item.change.includes('+'), changeClass = isPositive ? 'positive' : 'negative';
            html += \`<div class="swipe-container" data-idx="\${idx}"><div class="delete-background"><i class="fas fa-trash-alt"></i> Delete</div><div class="instrument-card" data-name="\${escapeHtml(item.name)}" data-price="\${item.price}" data-change="\${item.change}" data-segment="\${escapeHtml(item.segment)}" data-lotsize="\${item.lotSize}" data-maxlots="\${item.maxLots}" data-margin="\${item.marginPercent}"><div class="instrument-info"><div class="instrument-symbol">\${escapeHtml(item.name)}</div><div class="instrument-name">\${escapeHtml(item.symbol)}</div></div><div class="instrument-price-area"><div class="price-value">\${item.price}</div><div class="change-badge \${changeClass}">\${item.change}</div></div></div></div>\`;
        });
        html += \`</div>\`;
        watchlistContainer.innerHTML = html;
        watchlistCounter.innerText = \`\${watchlistItems.length} items\`;
        
        document.querySelectorAll('.instrument-card').forEach(card => {
            var name = card.dataset.name, price = parseFloat(card.dataset.price), change = card.dataset.change, segment = card.dataset.segment;
            var lotSize = parseInt(card.dataset.lotsize), maxLots = parseInt(card.dataset.maxlots), marginPercent = parseFloat(card.dataset.margin);
            card.addEventListener('click', () => openTradeSheet({ name, price, change, segment, lotSize, maxLots, marginPercent }));
        });
        
        // Simple swipe delete
        document.querySelectorAll('.swipe-container').forEach(container => {
            var idx = parseInt(container.dataset.idx), startX = 0, isSwiping = false, card = container.querySelector('.instrument-card');
            function handleStart(e) { startX = e.touches ? e.touches[0].clientX : e.clientX; isSwiping = true; container.classList.add('swiping'); card.style.transition = 'none'; e.preventDefault(); }
            function handleMove(e) { if (!isSwiping) return; var delta = (e.touches ? e.touches[0].clientX : e.clientX) - startX; var offset = Math.min(Math.max(delta, -80), 80); card.style.transform = \`translateX(\${offset}px)\`; e.preventDefault(); }
            function handleEnd(e) { if (!isSwiping) return; isSwiping = false; container.classList.remove('swiping'); card.style.transition = 'transform 0.3s'; if (Math.abs(startX - (e.changedTouches ? e.changedTouches[0].clientX : e.clientX)) > 45) { watchlistItems.splice(idx, 1); renderWatchlist(); showToast(\`Removed\`); } else { card.style.transform = 'translateX(0px)'; } }
            card.addEventListener('touchstart', handleStart, { passive: false }); card.addEventListener('touchmove', handleMove, { passive: false }); card.addEventListener('touchend', handleEnd);
        });
    }
    
    function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
    function addToWatchlist(inst) { 
        if (watchlistItems.some(i => i.symbol === inst.symbol)) { showToast(\`Already in watchlist\`, true); return false; } 
        watchlistItems.push(inst); 
        renderWatchlist(); 
        showToast(\`✓ \${inst.name} added\`); 
        return true; 
    }
    function performSearch(query) {
        var term = query.trim().toLowerCase();
        if (!term) { searchResultsArea.style.display = 'none'; clearSearchBtn.classList.remove('visible'); return; }
        clearSearchBtn.classList.add('visible');
        var filtered = allScripts.filter(s => s.name.toLowerCase().includes(term) || s.symbol.toLowerCase().includes(term));
        if (!filtered.length) { searchResultsArea.style.display = 'block'; searchResultCount.innerText = \`0 results\`; searchResultsList.innerHTML = \`<div class="no-results">No results</div>\`; return; }
        searchResultCount.innerText = \`\${filtered.length} results\`;
        var html = \`<div class="search-result-list">\`;
        filtered.forEach(s => { html += \`<div class="search-result-item"><div><div class="search-result-name">\${escapeHtml(s.name)}</div><div class="search-result-symbol">\${escapeHtml(s.symbol)}</div></div><div>\${s.price}</div><button class="add-smart-btn" data-name="\${escapeHtml(s.name)}" data-symbol="\${escapeHtml(s.symbol)}" data-price="\${s.price}" data-change="\${s.change}" data-segment="\${escapeHtml(s.segment)}" data-lotsize="\${s.lotSize}" data-maxlots="\${s.maxLots}" data-margin="\${s.marginPercent}">Add</button></div>\`; });
        html += \`</div>\`;
        searchResultsList.innerHTML = html;
        searchResultsArea.style.display = 'block';
        document.querySelectorAll('.add-smart-btn').forEach(btn => btn.addEventListener('click', () => addToWatchlist({ name: btn.dataset.name, symbol: btn.dataset.symbol, price: parseFloat(btn.dataset.price), change: btn.dataset.change, segment: btn.dataset.segment, lotSize: parseInt(btn.dataset.lotsize), maxLots: parseInt(btn.dataset.maxlots), marginPercent: parseFloat(btn.dataset.margin) })));
    }
    searchInput.addEventListener('input', (e) => performSearch(e.target.value));
    clearSearchBtn.addEventListener('click', () => { searchInput.value = ''; performSearch(''); });
    function buildFolderTree() { var container = document.getElementById('folderTreeMobile'); if (!container) return; container.innerHTML = '<div style="padding:16px">Scripts Library - Tap + to add</div>'; }
    function openDrawer() { folderDrawer.classList.add('open'); overlay.classList.add('active'); }
    function closeDrawer() { folderDrawer.classList.remove('open'); overlay.classList.remove('active'); }
    openBtn.addEventListener('click', openDrawer); closeDrawerBtn.addEventListener('click', closeDrawer); overlay.addEventListener('click', closeDrawer);
    renderWatchlist(); buildFolderTree();
`;
      document.body.appendChild(script);
    })();

    return () => {
      if (injectedScript && document.body.contains(injectedScript)) {
        document.body.removeChild(injectedScript);
      }
    };
  }, []);

  return (
    <div 
      ref={containerRef}
      dangerouslySetInnerHTML={{ __html: `
<div class="mobile-app">
    <div class="app-header">
        <div class="header-top">
            <div class="logo-area"><div class="logo-text">Watchlist</div></div>
            <div class="folder-btn" id="openFolderMobileBtn"><i class="fas fa-folder"></i><span>Scripts Library</span><i class="fas fa-chevron-right"></i></div>
        </div>
        <div class="search-wrapper">
            <i class="fas fa-search search-icon"></i>
            <input type="text" class="search-input" id="globalSearchInput" placeholder="Search stocks, futures, crypto...">
            <i class="fas fa-times-circle clear-search" id="clearSearchBtn"></i>
        </div>
    </div>
    <div class="main-content">
        <div id="searchResultsArea" class="search-results-section" style="display: none;"><div class="section-subtitle"><i class="fas fa-search"></i> SEARCH RESULTS <span id="searchResultCount"></span></div><div id="searchResultsList"></div></div>
        <div class="watchlist-section">
            <div class="watchlist-header"><div class="watchlist-title-section"><div class="watchlist-title"><i class="fas fa-chart-line"></i> MY WATCHLIST</div><div class="watchlist-count" id="mobileWatchlistCounter">0 items</div></div><div class="action-hint"><i class="fas fa-arrows-left-right"></i> Swipe | <i class="fas fa-fingerprint"></i> Hold to select | <i class="fas fa-tap"></i> Tap to trade</div></div>
            <div style="margin-bottom: 12px;"><span class="add-hint"><i class="fas fa-plus-circle"></i> Add scripts to watchlist from Scripts Library</span></div>
            <div id="multiSelectBar" style="display: none;"><div class="multi-select-bar"><div class="multi-select-row top-row"><div class="select-actions"><button class="select-all-btn" id="selectAllBtn"><i class="fas fa-check-double"></i> Select All</button><button class="unselect-all-btn" id="unselectAllBtn"><i class="fas fa-times-circle"></i> Unselect All</button></div><span class="selected-count" id="selectedCount">0 selected</span></div><div class="multi-select-row bottom-row"><div class="delete-actions"><button class="exit-selection-btn" id="exitSelectionBtn"><i class="fas fa-times"></i> Cancel</button><button class="delete-selected-btn" id="deleteSelectedBtn"><i class="fas fa-trash-alt"></i> Delete</button></div></div></div></div>
            <div class="watchlist-cards-container"><div id="watchlistMobileContainer"></div></div>
        </div>
    </div>
</div>

<!-- 2nd Page: Trade Sheet -->

  


<div id="tradeSheetOverlay" class="trade-sheet-overlay"></div>
<div id="tradeSheet" class="trade-sheet">
    <div class="sheet-handle"><div class="handle-bar"></div></div>
    <div class="sheet-header"><div class="sheet-header-row"><div><div class="sheet-script-name" id="tradeScriptName">NIFTY FUT</div><span class="sheet-segment" id="tradeSegment">NSE - Futures</span></div><div class="sheet-cmp-area"><div class="sheet-cmp-label">CMP</div><div class="sheet-cmp-value" id="tradeCmpValue">₹22,456.80</div><div><span class="sheet-change" id="tradeChange">+0.45%</span></div></div></div></div>
    <div class="sheet-bidask"><div class="sheet-bid"><div class="sheet-bidask-label">BID</div><div class="sheet-bid-value" id="tradeBid">₹22,434.20</div></div><div class="sheet-divider"></div><div class="sheet-ask"><div class="sheet-bidask-label">ASK</div><div class="sheet-ask-value" id="tradeAsk">₹22,479.40</div></div></div>
    <div class="sheet-actions"><button class="sheet-btn-buy" id="proceedToOrderBuy"><i class="fas fa-arrow-up"></i> BUY</button><button class="sheet-btn-sell" id="proceedToOrderSell"><i class="fas fa-arrow-down"></i> SELL</button></div>
</div>

<!-- 3RD PAGE - SLIGHTLY EXPANDED WITH BID/ASK BELOW CMP AT TOP RIGHT -->
<div id="orderFullpageOverlay" class="order-fullpage-overlay"></div>
<div id="orderFullpage" class="order-fullpage">
    <div class="order-header">
        <div style="display: flex; align-items: center;">
            <button class="back-icon" id="backToTradeSheetBtn"><i class="fas fa-arrow-left"></i></button>
            <div class="order-script-info">
                <div class="order-script-name" id="orderScriptName">NIFTY FUT</div>
                <span class="order-segment" id="orderSegment">NSE - Futures</span>
            </div>
        </div>
        <div class="order-right-area">
            <div class="order-cmp-value" id="orderCmpValue">₹22,456.80</div>
            <div><span class="order-change" id="orderChange">+0.45%</span></div>
            <!-- Bid/Ask below CMP - Smaller and compact -->
            <div class="order-bidask-mini">
                <div class="order-bidask-mini-item"><span class="order-bidask-mini-label">BID</span><span class="order-bid-value-mini" id="orderBid">22,434.20</span></div>
                <div class="order-bidask-mini-item"><span class="order-bidask-mini-label">ASK</span><span class="order-ask-value-mini" id="orderAsk">22,479.40</span></div>
            </div>
        </div>
    </div>
    
    <div class="order-content">
        <div class="switch-container"><span class="switch-label"><i class="fas fa-layer-group"></i> Order Type</span><div><span class="switch-text">Qty</span><label class="switch"><input type="checkbox" id="qtyLotSwitch"><span class="slider"></span></label><span class="switch-text">Lot</span></div></div>
        
        <div class="lot-info-row">
            <div class="lot-info-item"><span class="lot-info-label">Lot Size</span><span class="lot-info-value" id="lotSizeValue">50</span></div>
            <div class="lot-info-item"><span class="lot-info-label">Max Lots</span><span class="lot-info-value" id="maxLotsValue">100</span></div>
            <div class="lot-info-item"><span class="lot-info-label">Order Lots</span><span class="lot-info-value" id="orderLotsValue">1</span></div>
            <div class="lot-info-item"><span class="lot-info-label">Total Qty</span><span class="lot-info-value" id="totalQtyValue">50</span></div>
        </div>
        
        <div class="qty-section"><div class="qty-label" id="qtyLabel">QUANTITY</div><div class="qty-control"><button class="qty-btn" id="orderQtyMinus"><i class="fas fa-minus"></i></button><input type="number" class="qty-input" id="orderQtyInput" value="1" step="any"><button class="qty-btn" id="orderQtyPlus"><i class="fas fa-plus"></i></button></div><div class="lot-size-info" id="lotSizeInfo">Lot Size: 50 | 1 Lot = 50 Units</div></div>
        
        <div class="type-section"><div class="section-label"><i class="fas fa-shopping-cart"></i> ORDER TYPE</div><div class="type-buttons">
            <button class="type-btn active" data-order-type="market">MARKET</button>
            <button class="type-btn" data-order-type="limit">LIMIT</button>
            <button class="type-btn" data-order-type="slm">SL-M</button>
            <button class="type-btn" data-order-type="gtt">GTT</button>
        </div>
            <div id="limitPriceContainer" class="price-input-container"><input type="text" id="limitPriceInput" class="price-input" placeholder="Limit Price (₹)"></div>
            <div id="slmContainer" class="price-input-container"><input type="text" id="slmStopPrice" class="price-input" placeholder="Stop Loss Price (Trigger)"></div>
            <div id="gttContainer" class="price-input-container"><input type="text" id="gttStopPrice" class="price-input" placeholder="Stop Loss Price"><input type="text" id="gttLimitPrice" class="price-input" placeholder="Limit Price" style="margin-top: 8px;"></div>
        </div>
        
        <div class="type-section"><div class="section-label"><i class="fas fa-clock"></i> PRODUCT TYPE</div><div class="type-buttons"><button class="type-btn active" data-product-type="intraday">INTRADAY</button><button class="type-btn" data-product-type="carry">CARRY</button></div></div>
        
        <div class="margin-details"><div class="margin-title"><i class="fas fa-chart-pie"></i> MARGIN</div>
            <div class="margin-row"><span class="margin-label">Available</span><span class="margin-value positive" id="availableMargin">₹1,25,000</span></div>
            <div class="margin-row"><span class="margin-label">Required</span><span class="margin-value" id="requiredMargin">₹22,456.80</span></div>
            <div class="margin-row"><span class="margin-label">Carry (Overnight)</span><span class="margin-value" id="carryMargin">₹44,913.60</span></div>
            <div class="brokerage-row" id="brokerageRow"><div style="display: flex; justify-content: space-between;"><span class="margin-label">GTT Brokerage</span><span class="margin-value" id="brokerageAmount">₹5.00</span></div></div>
        </div>
        
        <div class="order-actions"><button class="btn-confirm-buy" id="confirmBuyBtn"><i class="fas fa-arrow-up"></i> BUY</button><button class="btn-confirm-sell" id="confirmSellBtn"><i class="fas fa-arrow-down"></i> SELL</button></div>
    </div>
</div>

<div id="drawerOverlay" class="drawer-overlay"></div>
<div id="scriptsFolderDrawer" class="folder-drawer">
    <div class="drawer-header"><h3><i class="fas fa-folder"></i> Trading Segments</h3><button class="close-drawer" id="closeFolderDrawerBtn"><i class="fas fa-times"></i></button></div>
    <div class="folder-tree-scroll" id="folderTreeMobile"></div>
    <div class="drawer-footer"><i class="fas fa-plus-circle"></i> Tap Add to watchlist</div>
</div>
<div id="toastMessageMobile" class="mobile-toast" style="opacity:0;"></div>



` }} 
    />
  );
}
