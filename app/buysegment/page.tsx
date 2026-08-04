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

  // Expose order bridge so the public JS can call the authenticated API
  useEffect(() => {
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
    return () => { delete window.__executeOrderViaBridge; };
  }, []);

  // Load init script from public/ — keeps JS out of .tsx so Turbopack
  // never parses template literals / async syntax as TypeScript.
  useEffect(() => {
    const script = document.createElement('script');
    script.src = '/buysegment-init.js';
    script.async = true;
    document.body.appendChild(script);
    return () => { if (document.body.contains(script)) document.body.removeChild(script); };
  }, []);

  const html = [
    '<div class="mobile-app">',
    '  <div class="app-header">',
    '    <div class="header-top">',
    '      <div class="logo-area"><div class="logo-text">Watchlist</div></div>',
    '      <div class="folder-btn" id="openFolderMobileBtn"><i class="fas fa-folder"></i><span>Scripts Library</span><i class="fas fa-chevron-right"></i></div>',
    '    </div>',
    '    <div class="search-wrapper">',
    '      <i class="fas fa-search search-icon"></i>',
    '      <input type="text" class="search-input" id="globalSearchInput" placeholder="Search stocks, futures, crypto...">',
    '      <i class="fas fa-times-circle clear-search" id="clearSearchBtn"></i>',
    '    </div>',
    '  </div>',
    '  <div class="main-content">',
    '    <div id="searchResultsArea" class="search-results-section" style="display:none">',
    '      <div class="section-subtitle"><i class="fas fa-search"></i> SEARCH RESULTS <span id="searchResultCount"></span></div>',
    '      <div id="searchResultsList"></div>',
    '    </div>',
    '    <div class="watchlist-section">',
    '      <div class="watchlist-header">',
    '        <div class="watchlist-title-section">',
    '          <div class="watchlist-title"><i class="fas fa-chart-line"></i> MY WATCHLIST</div>',
    '          <div class="watchlist-count" id="mobileWatchlistCounter">0 items</div>',
    '        </div>',
    '        <div class="action-hint"><i class="fas fa-arrows-left-right"></i> Swipe | Tap to trade</div>',
    '      </div>',
    '      <div style="margin-bottom:12px"><span class="add-hint"><i class="fas fa-plus-circle"></i> Add scripts from Scripts Library</span></div>',
    '      <div id="multiSelectBar" style="display:none">',
    '        <div class="multi-select-bar">',
    '          <div class="multi-select-row top-row">',
    '            <div class="select-actions">',
    '              <button class="select-all-btn" id="selectAllBtn"><i class="fas fa-check-double"></i> Select All</button>',
    '              <button class="unselect-all-btn" id="unselectAllBtn"><i class="fas fa-times-circle"></i> Unselect All</button>',
    '            </div>',
    '            <span class="selected-count" id="selectedCount">0 selected</span>',
    '          </div>',
    '          <div class="multi-select-row bottom-row">',
    '            <button class="exit-selection-btn" id="exitSelectionBtn"><i class="fas fa-times"></i> Cancel</button>',
    '            <button class="delete-selected-btn" id="deleteSelectedBtn"><i class="fas fa-trash-alt"></i> Delete</button>',
    '          </div>',
    '        </div>',
    '      </div>',
    '      <div class="watchlist-cards-container"><div id="watchlistMobileContainer"></div></div>',
    '    </div>',
    '  </div>',
    '</div>',
    '<div id="tradeSheetOverlay" class="trade-sheet-overlay"></div>',
    '<div id="tradeSheet" class="trade-sheet">',
    '  <div class="sheet-handle"><div class="handle-bar"></div></div>',
    '  <div class="sheet-header">',
    '    <div class="sheet-header-row">',
    '      <div>',
    '        <div class="sheet-script-name" id="tradeScriptName">NIFTY FUT</div>',
    '        <span class="sheet-segment" id="tradeSegment">NSE - Futures</span>',
    '      </div>',
    '      <div class="sheet-cmp-area">',
    '        <div class="sheet-cmp-label">CMP</div>',
    '        <div class="sheet-cmp-value" id="tradeCmpValue">0.00</div>',
    '        <div><span class="sheet-change" id="tradeChange">+0.00%</span></div>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="sheet-bidask">',
    '    <div class="sheet-bid"><div class="sheet-bidask-label">BID</div><div class="sheet-bid-value" id="tradeBid">0.00</div></div>',
    '    <div class="sheet-divider"></div>',
    '    <div class="sheet-ask"><div class="sheet-bidask-label">ASK</div><div class="sheet-ask-value" id="tradeAsk">0.00</div></div>',
    '  </div>',
    '  <div class="sheet-actions">',
    '    <button class="sheet-btn-buy" id="proceedToOrderBuy"><i class="fas fa-arrow-up"></i> BUY</button>',
    '    <button class="sheet-btn-sell" id="proceedToOrderSell"><i class="fas fa-arrow-down"></i> SELL</button>',
    '  </div>',
    '</div>',
    '<div id="orderFullpageOverlay" class="order-fullpage-overlay"></div>',
    '<div id="orderFullpage" class="order-fullpage">',
    '  <div class="order-header">',
    '    <div style="display:flex;align-items:center">',
    '      <button class="back-icon" id="backToTradeSheetBtn"><i class="fas fa-arrow-left"></i></button>',
    '      <div class="order-script-info">',
    '        <div class="order-script-name" id="orderScriptName">NIFTY FUT</div>',
    '        <span class="order-segment" id="orderSegment">NSE - Futures</span>',
    '      </div>',
    '    </div>',
    '    <div class="order-right-area">',
    '      <div class="order-cmp-value" id="orderCmpValue">0.00</div>',
    '      <div><span class="order-change" id="orderChange">+0.00%</span></div>',
    '      <div class="order-bidask-mini">',
    '        <div class="order-bidask-mini-item"><span class="order-bidask-mini-label">BID</span><span class="order-bid-value-mini" id="orderBid">0.00</span></div>',
    '        <div class="order-bidask-mini-item"><span class="order-bidask-mini-label">ASK</span><span class="order-ask-value-mini" id="orderAsk">0.00</span></div>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="order-content">',
    '    <div class="switch-container">',
    '      <span class="switch-label"><i class="fas fa-layer-group"></i> Order Type</span>',
    '      <div><span class="switch-text">Qty</span><label class="switch"><input type="checkbox" id="qtyLotSwitch"><span class="slider"></span></label><span class="switch-text">Lot</span></div>',
    '    </div>',
    '    <div class="lot-info-row">',
    '      <div class="lot-info-item"><span class="lot-info-label">Lot Size</span><span class="lot-info-value" id="lotSizeValue">50</span></div>',
    '      <div class="lot-info-item"><span class="lot-info-label">Max Lots</span><span class="lot-info-value" id="maxLotsValue">100</span></div>',
    '      <div class="lot-info-item"><span class="lot-info-label">Order Lots</span><span class="lot-info-value" id="orderLotsValue">1</span></div>',
    '      <div class="lot-info-item"><span class="lot-info-label">Total Qty</span><span class="lot-info-value" id="totalQtyValue">50</span></div>',
    '    </div>',
    '    <div class="qty-section">',
    '      <div class="qty-label" id="qtyLabel">QUANTITY</div>',
    '      <div class="qty-control">',
    '        <button class="qty-btn" id="orderQtyMinus"><i class="fas fa-minus"></i></button>',
    '        <input type="number" class="qty-input" id="orderQtyInput" value="1" step="any">',
    '        <button class="qty-btn" id="orderQtyPlus"><i class="fas fa-plus"></i></button>',
    '      </div>',
    '      <div class="lot-size-info" id="lotSizeInfo">Lot Size: 50 | 1 Lot = 50 Units</div>',
    '    </div>',
    '    <div class="type-section">',
    '      <div class="section-label"><i class="fas fa-shopping-cart"></i> ORDER TYPE</div>',
    '      <div class="type-buttons">',
    '        <button class="type-btn active" data-order-type="market">MARKET</button>',
    '        <button class="type-btn" data-order-type="limit">LIMIT</button>',
    '        <button class="type-btn" data-order-type="slm">SL-M</button>',
    '        <button class="type-btn" data-order-type="gtt">GTT</button>',
    '      </div>',
    '      <div id="limitPriceContainer" class="price-input-container"><input type="text" id="limitPriceInput" class="price-input" placeholder="Limit Price (Rs)"></div>',
    '      <div id="slmContainer" class="price-input-container"><input type="text" id="slmStopPrice" class="price-input" placeholder="Stop Loss Price (Trigger)"></div>',
    '      <div id="gttContainer" class="price-input-container">',
    '        <input type="text" id="gttStopPrice" class="price-input" placeholder="Stop Loss Price">',
    '        <input type="text" id="gttLimitPrice" class="price-input" placeholder="Limit Price" style="margin-top:8px">',
    '      </div>',
    '    </div>',
    '    <div class="type-section">',
    '      <div class="section-label"><i class="fas fa-clock"></i> PRODUCT TYPE</div>',
    '      <div class="type-buttons">',
    '        <button class="type-btn active" data-product-type="intraday">INTRADAY</button>',
    '        <button class="type-btn" data-product-type="carry">CARRY</button>',
    '      </div>',
    '    </div>',
    '    <div class="margin-details">',
    '      <div class="margin-title"><i class="fas fa-chart-pie"></i> MARGIN</div>',
    '      <div class="margin-row"><span class="margin-label">Available</span><span class="margin-value positive" id="availableMargin">0.00</span></div>',
    '      <div class="margin-row"><span class="margin-label">Required</span><span class="margin-value" id="requiredMargin">0.00</span></div>',
    '      <div class="margin-row"><span class="margin-label">Carry (Overnight)</span><span class="margin-value" id="carryMargin">0.00</span></div>',
    '      <div class="brokerage-row" id="brokerageRow">',
    '        <div style="display:flex;justify-content:space-between">',
    '          <span class="margin-label">GTT Brokerage</span>',
    '          <span class="margin-value" id="brokerageAmount">0.00</span>',
    '        </div>',
    '      </div>',
    '    </div>',
    '    <div class="order-actions">',
    '      <button class="btn-confirm-buy" id="confirmBuyBtn"><i class="fas fa-arrow-up"></i> BUY</button>',
    '      <button class="btn-confirm-sell" id="confirmSellBtn"><i class="fas fa-arrow-down"></i> SELL</button>',
    '    </div>',
    '  </div>',
    '</div>',
    '<div id="drawerOverlay" class="drawer-overlay"></div>',
    '<div id="scriptsFolderDrawer" class="folder-drawer">',
    '  <div class="drawer-header">',
    '    <h3><i class="fas fa-folder"></i> Trading Segments</h3>',
    '    <button class="close-drawer" id="closeFolderDrawerBtn"><i class="fas fa-times"></i></button>',
    '  </div>',
    '  <div class="folder-tree-scroll" id="folderTreeMobile"></div>',
    '  <div class="drawer-footer"><i class="fas fa-plus-circle"></i> Tap Add to watchlist</div>',
    '</div>',
    '<div id="toastMessageMobile" class="mobile-toast" style="opacity:0"></div>',
  ].join('\n');

  return (
    <div
      ref={containerRef}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
