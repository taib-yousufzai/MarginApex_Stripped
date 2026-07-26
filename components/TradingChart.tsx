'use client';

import React, { useEffect, useRef, useState, useMemo } from 'react';
import ChartContainer from '@/components/chart/ChartContainer';
import { Candle } from '@/components/chart/types';
import { useMyOrders } from '@/hooks/useMyOrders';
import type { MyOrder } from '@/lib/types/order';
import { useMyPositions, EnrichedPosition } from '@/hooks/useMyPositions';
import { useOrderEntry } from '@/hooks/useOrderEntry';
import { supabase } from '@/lib/supabaseClient';
import OptionChainTable from '@/app/option-chain/OptionChainTable';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import useSWR from 'swr';
import { parseOptionSymbol } from '@/lib/parseOptionSymbol';
import { calculateMarginPortion } from '@/lib/marginCalculator';
import { formatShortName } from '@/lib/datafeed/symbolResolver';
import './trading-chart.css';

const fetcher = (url: string) => fetch(url).then(res => res.json());

const getUnderlyingSymbol = (sym: string) => {
  if (sym.includes('NIFTY 50')) return 'NIFTY';
  if (sym.includes('NIFTY BANK')) return 'BANKNIFTY';
  if (sym.includes('NIFTY FIN SERVICE')) return 'FINNIFTY';
  if (sym.includes('NIFTY MID SELECT')) return 'MIDCPNIFTY';
  if (sym.includes('SENSEX')) return 'SENSEX';
  if (sym.includes('BANKEX')) return 'BANKEX';

  const clean = sym.includes(':') ? sym.split(':')[1] : sym;

  const parsed = parseOptionSymbol(clean);
  if (parsed) {
    return parsed.underlying;
  }

  // Handle Futures e.g. CRUDEOIL26AUGFUT or NIFTY24SEPFUT
  const futMatch = clean.match(/^([A-Z]+)(\d{2}[A-Z0-9]{3})FUT$/i);
  if (futMatch) {
    return futMatch[1].toUpperCase();
  }

  return clean;
};

interface TradingChartProps {
  symbol: string;         // e.g., "BTCUSDT" or "NSE:INFY"
  segment: string;        // e.g., "CRYPTO" or "EQ"
  liveQuote?: any;        // Live quote object to update the last candle
}

type Timeframe = '1m' | '5m' | '15m' | '60m' | 'day';

function getLotSize(name: string, scriptSettings?: { symbol: string; lot_size: number }[]): number {
  const n = name.toUpperCase();
  if (scriptSettings && scriptSettings.length > 0) {
    const sortedSettings = [...scriptSettings].sort((a, b) => b.symbol.length - a.symbol.length);
    const match = sortedSettings.find(s => n.includes(s.symbol.toUpperCase()));
    if (match) return Number(match.lot_size);
  }
  if (n.includes('BANKNIFTY') || n.includes('BANKEX')) return 30;
  if (n.includes('FINNIFTY')) return 60;
  if (n.includes('MIDCP') || n.includes('MIDCAP')) return 120;
  if (n.includes('SENSEX')) return 20;
  if (n.includes('NIFTY')) return 65;
  if (n.includes('GOLDM')) return 10;
  if (n.includes('GOLD')) return 100;
  if (n.includes('SILVERM')) return 5;
  if (n.includes('SILVER')) return 30;
  if (n.includes('CRUDEOILM')) return 10;
  if (n.includes('CRUDEOIL')) return 100;
  if (n.includes('NATGASMINI')) return 250;
  if (n.includes('NATURALGAS')) return 1250;
  return 1;
}

function mapSegmentToDbSegment(s: string): string {
  if (!s) return '';
  const trimmed = s.trim();
  if (['NSE - Futures', 'BSE - Futures', 'NFO - Futures', 'BFO - Futures'].includes(trimmed)) return 'INDEX-FUT';
  if (['NSE - Options', 'BSE - Options', 'NFO - Options', 'BFO - Options'].includes(trimmed)) return 'INDEX-OPT';
  if (['NSE - Stock Futures', 'BSE - Stock Futures', 'NFO - Stock Futures', 'BFO - Stock Futures'].includes(trimmed)) return 'STOCK-FUT';
  if (['NSE - Stock Options', 'BSE - Stock Options', 'NFO - Stock Options', 'BFO - Stock Options'].includes(trimmed)) return 'STOCK-OPT';
  if (trimmed === 'MCX - Futures') return 'MCX-FUT';
  if (trimmed === 'MCX - Options') return 'MCX-OPT';
  if (['NSE - Equity', 'BSE - Equity'].includes(trimmed)) return 'NSE-EQ';
  if (trimmed === 'Crypto' || trimmed === 'CRYPTO') return 'CRYPTO';
  if (trimmed === 'Forex' || trimmed === 'FOREX' || trimmed === 'CDS - Futures' || trimmed === 'CDS - Options') return 'FOREX';
  if (trimmed === 'COMEX - Futures' || trimmed === 'COMEX - Options' || trimmed === 'COMEX' || trimmed === 'COI') return 'COMEX';
  // Already-mapped DB keys — pass through directly
  if (['INDEX-FUT', 'INDEX-OPT', 'STOCK-FUT', 'STOCK-OPT', 'MCX-FUT', 'MCX-OPT', 'NSE-EQ', 'CRYPTO', 'FOREX', 'COMEX'].includes(trimmed)) return trimmed;
  // Legacy alias used by older code paths
  if (trimmed === 'NFO-OPT') return 'INDEX-OPT';
  if (trimmed === 'BFO-OPT') return 'INDEX-OPT';
  if (trimmed === 'NFO-FUT') return 'INDEX-FUT';
  return trimmed;
}

const SwipeableItem = ({ children, onDelete }: { children: React.ReactNode, onDelete: () => void }) => {
  const [translateX, setTranslateX] = useState(0);
  const startX = useRef(0);
  const currentX = useRef(0);
  const isSwiping = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    isSwiping.current = true;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isSwiping.current) return;
    currentX.current = e.touches[0].clientX;
    const diff = currentX.current - startX.current;
    if (diff < 0) {
      setTranslateX(Math.max(diff, -80));
    } else {
      setTranslateX(Math.min(diff, 0));
    }
  };

  const handleTouchEnd = () => {
    isSwiping.current = false;
    if (translateX < -40) {
      setTranslateX(-80);
    } else {
      setTranslateX(0);
    }
  };

  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: '12px' }}>
      <div style={{
        position: 'absolute', top: 0, bottom: 0, right: 0, width: '80px',
        background: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'white', zIndex: 0, opacity: translateX < 0 ? 1 : 0, transition: 'opacity 0.2s ease'
      }}>
        <button style={{ background: 'transparent', border: 'none', color: 'white', height: '100%', width: '100%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { e.stopPropagation(); onDelete(); setTranslateX(0); }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" /></svg>
        </button>
      </div>
      <div
        className={translateX < 0 ? 'swipe-active' : ''}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          transform: `translateX(${translateX}px)`,
          transition: isSwiping.current ? 'none' : 'transform 0.2s ease',
          position: 'relative',
          zIndex: 1,
          background: 'transparent',
          width: '100%'
        }}
      >
        {children}
      </div>
    </div>
  )
}

const SEGMENT_TAB_MAP: Record<string, string> = {
  'NSE - Futures': 'INDEX-FUT',
  'BSE - Futures': 'INDEX-FUT',
  'NSE - Options': 'INDEX-OPT',
  'BSE - Options': 'INDEX-OPT',
  'NSE - Stock Futures': 'STOCK-FUT',
  'BSE - Stock Futures': 'STOCK-FUT',
  'NSE - Stock Options': 'STOCK-OPT',
  'BSE - Stock Options': 'STOCK-OPT',
  'MCX - Futures': 'MCX-FUT',
  'MCX - Options': 'MCX-OPT',
  'NSE - Equity': 'NSE-EQ',
  'BSE - Equity': 'NSE-EQ',
  'Crypto': 'CRYPTO',
  'CRYPTO': 'CRYPTO',
  'Forex': 'FOREX',
  'FOREX': 'FOREX',
  'CDS - Futures': 'FOREX',
  'CDS - Options': 'FOREX',
  'COMEX - Futures': 'COMEX',
  'COMEX - Options': 'COMEX',
  'COMEX': 'COMEX',
  'COI': 'COMEX',
};

const DEFAULT_CRYPTO_ITEMS = [
  { name: 'Bitcoin', symbol: 'BTC', kiteSymbol: '', binanceSymbol: 'BTCUSDT', price: 0, change: '0%', segment: 'Crypto', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'CRYPTO' },
  { name: 'Ethereum', symbol: 'ETH', kiteSymbol: '', binanceSymbol: 'ETHUSDT', price: 0, change: '0%', segment: 'Crypto', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'CRYPTO' },
  { name: 'Dogecoin', symbol: 'DOGE', kiteSymbol: '', binanceSymbol: 'DOGEUSDT', price: 0, change: '0%', segment: 'Crypto', contractDate: '', open: 0, high: 0, low: 0, close: 0, category: 'CRYPTO' },
];

const DEFAULT_FOREX_ITEMS = [
  { name: 'USD/INR', symbol: 'USDINR_FUT', kiteSymbol: 'CDS:USDINR26JULFUT', price: 0, change: '0%', segment: 'CDS - Futures', contractDate: 'Jul 2026', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'EUR/INR', symbol: 'EURINR_FUT', kiteSymbol: 'CDS:EURINR26JULFUT', price: 0, change: '0%', segment: 'CDS - Futures', contractDate: 'Jul 2026', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'GBP/INR', symbol: 'GBPINR_FUT', kiteSymbol: 'CDS:GBPINR26JULFUT', price: 0, change: '0%', segment: 'CDS - Futures', contractDate: 'Jul 2026', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
  { name: 'JPY/INR', symbol: 'JPYINR_FUT', kiteSymbol: 'CDS:JPYINR26JULFUT', price: 0, change: '0%', segment: 'CDS - Futures', contractDate: 'Jul 2026', open: 0, high: 0, low: 0, close: 0, category: 'FOREX' },
];

const DEFAULT_COMEX_ITEMS = [
  { name: 'Gold', symbol: 'GOLD_FUT', kiteSymbol: 'MCX:GOLD26AUGFUT', comexSymbol: 'GC=F', price: 0, change: '0%', segment: 'MCX - Futures', contractDate: 'Aug 2026', open: 0, high: 0, low: 0, close: 0, category: 'COI' },
  { name: 'Silver', symbol: 'SILVER_FUT', kiteSymbol: 'MCX:SILVER26SEPFUT', comexSymbol: 'SI=F', price: 0, change: '0%', segment: 'MCX - Futures', contractDate: 'Sep 2026', open: 0, high: 0, low: 0, close: 0, category: 'COI' },
  { name: 'Crude Oil', symbol: 'CRUDEOIL_FUT', kiteSymbol: 'MCX:CRUDEOIL26AUGFUT', comexSymbol: 'CL=F', price: 0, change: '0%', segment: 'MCX - Futures', contractDate: 'Aug 2026', open: 0, high: 0, low: 0, close: 0, category: 'COI' },
  { name: 'Copper', symbol: 'COPPER_FUT', kiteSymbol: 'MCX:COPPER26AUGFUT', comexSymbol: 'HG=F', price: 0, change: '0%', segment: 'MCX - Futures', contractDate: 'Aug 2026', open: 0, high: 0, low: 0, close: 0, category: 'COI' },
];

function getDefaultWatchlistItems() {
  return [
    { name: 'NIFTY 50 INDEX', symbol: 'NIFTY_INDEX', kiteSymbol: 'NSE:NIFTY 50', price: 22456.80, change: '+0.45%', segment: 'NSE - Futures', contractDate: '28 Mar 2025', open: 22350, high: 22580, low: 22320, close: 22456.80 },
    { name: 'BANKNIFTY INDEX', symbol: 'BANKNIFTY_INDEX', kiteSymbol: 'NSE:NIFTY BANK', price: 48210.50, change: '-0.21%', segment: 'NSE - Futures', contractDate: '28 Mar 2025', open: 48350, high: 48500, low: 48100, close: 48210.50 },
    { name: 'SENSEX INDEX', symbol: 'SENSEX_INDEX', kiteSymbol: 'BSE:SENSEX', price: 74230.15, change: '+0.32%', segment: 'BSE - Futures', contractDate: '28 Mar 2025', open: 73950, high: 74500, low: 73800, close: 74230.15 },
    ...DEFAULT_CRYPTO_ITEMS,
    ...DEFAULT_FOREX_ITEMS,
    ...DEFAULT_COMEX_ITEMS,
  ];
}

function getStoredWatchlistItems() {
  if (typeof window !== 'undefined' && (window as any).__watchlistItems && (window as any).__watchlistItems.length > 0) {
    return (window as any).__watchlistItems;
  }
  try {
    let bestKey = 'marginApex_watchlist';
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('marginApex_watchlist_')) {
        bestKey = key;
        break;
      }
    }
    const rawUser = localStorage.getItem(bestKey);
    if (rawUser && rawUser !== 'null') {
      const parsed = JSON.parse(rawUser);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) { }
  return getDefaultWatchlistItems();
}

function getTabForItem(item: any): string {
  if (item.category) {
    const c = item.category.toUpperCase();
    if (c.includes('INDEX - FUTURE')) return 'INDEX-FUT';
    if (c.includes('INDEX - OPTIONS')) return 'INDEX-OPT';
    if (c.includes('STOCKS - FUTURE')) return 'STOCK-FUT';
    if (c.includes('MCX - FUTURE')) return 'MCX-FUT';
    if (c.includes('MCX - OPTIONS')) return 'MCX-OPT';
    if (c.includes('CRYPTO')) return 'CRYPTO';
    if (c.includes('FOREX')) return 'FOREX';
    if (c.includes('COMEX')) return 'COMEX';
  }

  if (item.segment && SEGMENT_TAB_MAP[item.segment]) {
    return SEGMENT_TAB_MAP[item.segment];
  }
  return 'INDEX-FUT'; // Fallback
}

const ChartSearchOverlay = ({ onClose, onSelect, starredInstruments, toggleStar }: any) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [activeSearchTab, setActiveSearchTab] = useState('All');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => searchInputRef.current?.focus(), 100);
  }, []);

  const localScripts = getDefaultWatchlistItems();
  const normalizedQuery = searchQuery.replace(/\s+/g, ' ').trim();

  function wordStartMatch(text: string, term: string): boolean {
    if (!text) return false;
    const t = text.toLowerCase();
    const q = term.toLowerCase();
    if (t.startsWith(q)) return true;
    const words = t.split(/[\s\-_\/]/);
    return words.some(w => w.startsWith(q));
  }

  const SEGMENT_DEFAULTS: Record<string, string> = {
    'INDEX-FUT': 'NIFTY',
    'INDEX-OPT': 'NIFTY',
    'STOCK-FUT': 'RELIANCE',
    'STOCK-OPT': 'RELIANCE',
    'NSE-EQ': 'RELIANCE',
    'MCX-FUT': 'GOLD',
    'MCX-OPT': 'GOLD',
    'COMEX': 'GOLD',
    'CRYPTO': 'BTC',
    'FOREX': 'USDINR',
  };

  useEffect(() => {
    setIsSearching(true);
    const abortController = new AbortController();

    const timer = setTimeout(async () => {
      const actualQuery = normalizedQuery.length >= 2 ? normalizedQuery : (SEGMENT_DEFAULTS[activeSearchTab] || 'NIFTY');
      const qLower = actualQuery.toLowerCase();

      const localMatches = localScripts.filter(s => {
        const match = wordStartMatch(s.name, qLower) || wordStartMatch(s.symbol, qLower);
        if (!match) return false;
        if (activeSearchTab === 'All') return true;
        return getTabForItem(s) === activeSearchTab;
      });

      let liveMatches: any[] = [];
      try {
        const url = activeSearchTab === 'All'
          ? `/api/market/instruments/search?q=${encodeURIComponent(actualQuery)}`
          : `/api/market/instruments/search?q=${encodeURIComponent(actualQuery)}&tab=${encodeURIComponent(activeSearchTab)}`;
        const res = await fetch(url, { signal: abortController.signal });
        if (res.ok) {
          const data = await res.json();
          liveMatches = Array.isArray(data) ? data : [];
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') console.error(err);
      }

      const merged = [...liveMatches];
      const liveSymbols = new Set(liveMatches.map((r: any) => r.symbol));

      for (const local of localMatches) {
        if (!liveSymbols.has(local.symbol)) {
          merged.push(local);
          liveSymbols.add(local.symbol);
        }
      }

      setSearchResults(merged);
      setIsSearching(false);
    }, 300);

    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [normalizedQuery, activeSearchTab]);

  return (
    <div className="tc-search-overlay-fullscreen">
      <div className="tc-search-header-fs" style={{ padding: '12px 16px', gap: '0', background: 'var(--container-bg, #FFFFFF)', zIndex: 10 }}>
        <div style={{ position: 'relative', width: '100%', display: 'flex', alignItems: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: '12px', zIndex: 1 }}>
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            ref={searchInputRef}
            className="tc-search-input-fs"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search stocks, options, futures..."
            style={{ width: '100%', paddingRight: '40px', paddingLeft: '40px' }}
          />
          <button
            className="tc-icon-btn"
            onClick={onClose}
            style={{ position: 'absolute', right: '8px', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px', color: '#9CA3AF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>
      <div className="tc-search-body-fs">
        <div className="tc-search-tabs">
          {['All', 'INDEX-FUT', 'INDEX-OPT', 'MCX-FUT', 'MCX-OPT', 'STOCK-FUT', 'STOCK-OPT', 'NSE-EQ', 'CRYPTO', 'COMEX', 'FOREX'].map(tab => (
            <div
              key={tab}
              className={`tc-search-tab ${activeSearchTab === tab ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setActiveSearchTab(tab); }}
            >
              {tab}
            </div>
          ))}
        </div>
        <div className="tc-search-results-fs">
          {isSearching ? <div className="tc-search-msg">Searching...</div> :
            searchQuery.trim().length === 0 && activeSearchTab === 'All' ? (
              starredInstruments.length > 0 ? (
                starredInstruments.map((res: any, idx: number) => (
                  <SwipeableItem key={`${res.kiteSymbol}-${idx}`} onDelete={() => toggleStar(res)}>
                    <div className="tc-search-result-item" style={{ borderBottom: 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          className="tc-star-btn"
                          onClick={(e) => { e.stopPropagation(); toggleStar(res); }}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '24px', color: '#F59E0B', display: 'flex', alignItems: 'center' }}
                        >
                          ★
                        </button>
                        <div className="tc-res-info">
                          <div className="tc-res-name">{res.name}</div>
                          <div className="tc-res-segment">{res.segment}</div>
                        </div>
                      </div>
                      <button className="tc-res-open-btn" onClick={(e) => {
                        e.stopPropagation();
                        onSelect(res);
                      }}>Open</button>
                    </div>
                  </SwipeableItem>
                ))
              ) : <div className="tc-search-msg">Type to search for an instrument</div>
            ) : (
              searchResults.length > 0 ? (
                searchResults.map((res: any, idx: number) => {
                  const isStarred = starredInstruments.some((p: any) => p.kiteSymbol === res.kiteSymbol);
                  return (
                    <div key={`${res.kiteSymbol}-${idx}`} className="tc-search-result-item">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          className="tc-star-btn"
                          onClick={(e) => { e.stopPropagation(); toggleStar(res); }}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '24px', color: isStarred ? '#F59E0B' : '#D1D5DB', display: 'flex', alignItems: 'center' }}
                        >
                          {isStarred ? '★' : '☆'}
                        </button>
                        <div className="tc-res-info">
                          <div className="tc-res-name">{res.name}</div>
                          <div className="tc-res-segment">{res.segment}</div>
                        </div>
                      </div>
                      <button className="tc-res-open-btn" onClick={(e) => {
                        e.stopPropagation();
                        onSelect(res);
                      }}>Open</button>
                    </div>
                  )
                })
              ) : <div className="tc-search-msg">No results found</div>
            )
          }
        </div>
      </div>
    </div>
  );
};

export default function TradingChart({ symbol: propSymbol, segment: propSegment = '', liveQuote: propLiveQuote }: TradingChartProps) {
  const [symbol, setSymbol] = useState(propSymbol);
  const [segment, setSegment] = useState(propSegment);

  useEffect(() => {
    if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch (e) {}
    }
    return () => {
      if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('portrait').catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    setSymbol(propSymbol);
    setSegment(propSegment);
  }, [propSymbol, propSegment]);

  const [timeframe, setTimeframe] = useState<Timeframe>('5m');
  const [chartType, setChartType] = useState<'candle' | 'area' | 'bar' | 'baseline'>('candle');
  const [openTopFlyout, setOpenTopFlyout] = useState<string | null>(null);
  const [isLandscape, setIsLandscape] = useState(false);
  const [isCssLandscape, setIsCssLandscape] = useState(false);
  const [loading, setLoading] = useState<boolean>(true);
  const hasLoadedData = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [historicalCandles, setHistoricalCandles] = useState<Candle[]>([]);

  const [isSearchActive, setIsSearchActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [starredInstruments, setStarredInstruments] = useState<any[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('marginApex_starred_instruments');
      if (stored) setStarredInstruments(JSON.parse(stored));
    } catch (e) { }
  }, []);

  // Landscape detection
  useEffect(() => {
    const checkLandscape = () => {
      const isSmallScreen = window.innerWidth <= 950;
      const landscape = window.innerWidth > window.innerHeight;
      setIsLandscape(isSmallScreen && landscape);
    };
    checkLandscape();

    const handleOrientationChange = () => {
      // Browsers often need a slight delay to update innerWidth/innerHeight after rotation
      setTimeout(() => {
        checkLandscape();
        window.dispatchEvent(new Event('resize'));
      }, 200);
    };

    window.addEventListener('resize', checkLandscape);
    window.addEventListener('orientationchange', handleOrientationChange);
    return () => {
      window.removeEventListener('resize', checkLandscape);
      window.removeEventListener('orientationchange', handleOrientationChange);
    };
  }, []);

  // Gyroscope-based rotation detection (bypasses OS/manifest portrait lock)
  const lastPhysicalOrientation = useRef<'portrait' | 'landscape' | null>(null);
  const targetOrientation = useRef<'portrait' | 'landscape' | null>(null);
  const orientationTimeout = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleDeviceOrientation = (event: any) => {
      const gamma = event.gamma;
      const beta = event.beta;
      if (gamma === null || beta === null) return;

      const absGamma = Math.abs(gamma);
      const absBeta = Math.abs(beta);

      let detected: 'portrait' | 'landscape' | null = null;
      
      // Phone is tilted sideways (landscape)
      if (absGamma > 50 && absBeta < 40) {
        detected = 'landscape';
      }
      // Phone is held upright (portrait)
      else if (absBeta > 50 && absGamma < 40) {
        detected = 'portrait';
      }

      if (detected && detected !== targetOrientation.current) {
        targetOrientation.current = detected;
        
        if (orientationTimeout.current) {
          clearTimeout(orientationTimeout.current);
        }
        
        // Add a 350ms delay so the rotation feels natural and doesn't flicker
        orientationTimeout.current = setTimeout(() => {
          if (lastPhysicalOrientation.current !== detected) {
            lastPhysicalOrientation.current = detected;
            setIsCssLandscape(detected === 'landscape');
          }
        }, 350);
      }
    };

    if (typeof window !== 'undefined' && window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', handleDeviceOrientation);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('deviceorientation', handleDeviceOrientation);
      }
    };
  }, []);

  const toggleStar = (item: any) => {
    setStarredInstruments(prev => {
      const isStarred = prev.some(p => p.kiteSymbol === item.kiteSymbol);
      const next = isStarred ? prev.filter(p => p.kiteSymbol !== item.kiteSymbol) : [...prev, item];
      try { localStorage.setItem('marginApex_starred_instruments', JSON.stringify(next)); } catch (e) { }
      return next;
    });
  };



  // For the legend overlay
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [priceChange, setPriceChange] = useState<number>(0);
  const [priceChangePct, setPriceChangePct] = useState<number>(0);

  // Active Drawing Tool state
  const [activeDrawingTool, setActiveDrawingTool] = useState<string | null>(null);

  const isCrypto = segment.toUpperCase() === 'CRYPTO' || symbol.endsWith('USDT');

  const isUnderlyingIndex = useMemo(() => {
    const s = symbol.toUpperCase();
    const spotIndices = [
      'NIFTY 50', 'NIFTY BANK', 'SENSEX', 'NIFTY FIN SERVICE', 'NIFTY MID SELECT', 'BANKEX',
      'NSE:NIFTY 50', 'NSE:NIFTY BANK', 'BSE:SENSEX', 'NSE:NIFTY FIN SERVICE', 'NSE:NIFTY MID SELECT', 'BSE:BANKEX',
      'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'
    ];
    return spotIndices.includes(s) || s.endsWith('_INDEX');
  }, [symbol]);

  // --- Real Data Hooks ---
  const { orders, cancelOrder, refresh: refreshOrders } = useMyOrders();
  const { positions, refresh: refreshPositions } = useMyPositions();
  const { placeOrder, closePosition } = useOrderEntry();

  // --- Dashboard States ---
  const [isOrderBlockVisible, setIsOrderBlockVisible] = useState<boolean>(false);
  const [isTradeOnChartActive, setIsTradeOnChartActive] = useState<boolean>(false);
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL'>('BUY');
  const [useLots, setUseLots] = useState<boolean>(() => {
    const s = (propSegment || '').toUpperCase();
    return !(s.includes('EQUITY') || s === 'NSE-EQ' || s.includes('CRYPTO'));
  });
  const [qtyValue, setQtyValue] = useState<number | string>(1);
  const [orderCarry, setOrderCarry] = useState<'normal' | 'carry'>('normal');
  const [orderType, setOrderType] = useState<'market' | 'limit' | 'slm' | 'gtt' | 'sl'>('market');
  const [limitPrice, setLimitPrice] = useState<string>('');
  const [triggerPrice, setTriggerPrice] = useState<string>('');
  const [gttSlPrice, setGttSlPrice] = useState<string>('');
  const [gttTargetPrice, setGttTargetPrice] = useState<string>('');
  const [chainContract, setChainContract] = useState<{ name: string; expiry: string; ltp: number; iv: number; bid: number; ask: number; kiteId?: string } | null>(null);
  const [activeSegment, setActiveSegment] = useState<'chain' | 'orders' | 'positions'>('orders');
  const [isPanelExpanded, setIsPanelExpanded] = useState<boolean>(false);
  const [isInfoPanelCollapsed, setIsInfoPanelCollapsed] = useState<boolean>(true);
  const [isBottomSectionVisible, setIsBottomSectionVisible] = useState<boolean>(true);
  const [balance, setBalance] = useState<number>(50000);
  const [toast, setToast] = useState<{ visible: boolean; msg: string; isError?: boolean }>({ visible: false, msg: '' });
  const [segmentSettings, setSegmentSettings] = useState<any[]>([]);
  const [scriptSettings, setScriptSettings] = useState<{ symbol: string; lot_size: number }[]>([]);
  const [profile, setProfile] = useState<{ trading_mode?: string } | null>(null);

  // ── CHARTINH Integration States ──
  const [activeOrderTab, setActiveOrderTab] = useState<'open' | 'executed'>('open');
  const [isExitFlow, setIsExitFlow] = useState<boolean>(false);
  const [isAddMoreFlow, setIsAddMoreFlow] = useState<boolean>(false);
  const [exitPositionId, setExitPositionId] = useState<string | null>(null);
  const [addMoreSymbol, setAddMoreSymbol] = useState<string | null>(null);
  const [addMoreSegment, setAddMoreSegment] = useState<string | null>(null);
  const [addMoreLtp, setAddMoreLtp] = useState<number | null>(null);
  const [addMoreKiteInst, setAddMoreKiteInst] = useState<string | null>(null);
  const [postOrderSegment, setPostOrderSegment] = useState<'chain' | 'orders' | 'positions' | 'main' | null>(null);
  const [orderBlockTitle, setOrderBlockTitle] = useState<string>(symbol);
  const [modifyOrderId, setModifyOrderId] = useState<string | null>(null);
  const [showCharges, setShowCharges] = useState(false);

  const underlyingSym = getUnderlyingSymbol(symbol);
  const isIndex = (symbol.includes('NIFTY') || symbol.includes('SENSEX') || symbol.includes('BANKEX') || symbol === 'INDIA VIX') && !symbol.includes('FUT') && !symbol.includes('OPT') && !symbol.match(/(CE|PE)$/i);

  const { data: chainData, isLoading: chainLoading } = useSWR(
    activeSegment === 'chain' && !isCrypto && !segment.toUpperCase().includes('FOREX')
      ? `/api/market/option-chain?symbol=${underlyingSym}`
      : null,
    fetcher
  );

  const chainStrikes = useMemo(() => chainData?.strikes || [], [chainData]);
  const chainExpiry = chainData?.selectedExpiry || '';

  const symbolsToFetch = useMemo(() => {
    const syms: string[] = [symbol];
    // When in add-more or exit flow for a different instrument, also subscribe to its quotes
    if ((isAddMoreFlow || isExitFlow) && addMoreSymbol && addMoreSymbol !== symbol) {
      syms.push(addMoreSymbol);
    }
    if (activeSegment === 'chain' && chainStrikes.length) {
      chainStrikes.forEach((s: any) => {
        if (s.ce?.id) syms.push(s.ce.id);
        if (s.pe?.id) syms.push(s.pe.id);
      });
    }
    return syms;
  }, [symbol, activeSegment, chainStrikes, isAddMoreFlow, isExitFlow, addMoreSymbol]);

  const { quotes: marketQuotes } = useMarketQuotes(symbolsToFetch);
  const activeLiveQuote = marketQuotes[symbol] || (symbol === propSymbol ? propLiveQuote : null);

  const openChainOrder = (defaultAction: 'BUY' | 'SELL', contractName: string, expiry: string, ltp: number, iv: number, kiteId?: string) => {
    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
    else setIsPanelExpanded(false);
    const bid = ltp;
    const ask = parseFloat((ltp + Math.max(0.05, ltp * 0.005)).toFixed(2));
    const contract = { name: contractName, expiry, ltp, iv, bid, ask, kiteId };
    setChainContract(contract);
    setOrderSide(defaultAction);
    const displayPrice = defaultAction === 'BUY' ? ask : bid;
    setLimitPrice(displayPrice.toFixed(2));
    setTriggerPrice(displayPrice.toFixed(2));
    setGttSlPrice((displayPrice * 0.99).toFixed(2));
    setGttTargetPrice((displayPrice * 1.01).toFixed(2));
    setOrderType('market');
    setOrderCarry('normal');
    const isQtyDefault = segment.toUpperCase().includes('EQUITY') || segment.toUpperCase() === 'NSE-EQ' || segment.toUpperCase().includes('CRYPTO');
    setUseLots(!isQtyDefault);
    setQtyValue(1);
    setIsExitFlow(false);
    setIsAddMoreFlow(false);
    setExitPositionId(null);
    setPostOrderSegment('chain');
    setIsOrderBlockVisible(true);
  };

  // ── Advanced Drawing States & Toggles ──
  const [overlayIds, setOverlayIds] = useState<string[]>([]);
  const [isMagnetMode, setIsMagnetMode] = useState<boolean>(false);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [keepDrawingMode, setKeepDrawingMode] = useState<boolean>(false);
  const [hideDrawings, setHideDrawings] = useState<boolean>(false);
  const [openFlyout, setOpenFlyout] = useState<string | null>(null);
  // Maps each flyout group to its currently selected (last-used) tool
  const [groupSelected, setGroupSelected] = useState<Record<string, string>>({
    lines: 'segment',
    fibonacci: 'fibonacciRetracement',
    channels: 'parallelStraightLine',
    shapes: 'circle',
    annotation: 'simpleAnnotation',
    measure: 'priceRange',
  });

  const toggleLockDrawings = () => {
    setIsLocked(!isLocked);
    showToast("Drawing tools are coming soon in the modernized engine");
  };

  const toggleHideDrawings = () => {
    setHideDrawings(!hideDrawings);
    showToast("Drawing tools are coming soon in the modernized engine");
  };

  const clearAllDrawings = () => {
    setOverlayIds([]);
    setActiveDrawingTool(null);
    showToast("Drawing tools are coming soon in the modernized engine");
  };

  // Get lot size of instrument
  const lotSize = useMemo(() => getLotSize(symbol, scriptSettings), [symbol, scriptSettings]);

  // Update qtyValue when lotSize changes (if user hasn't typed a custom qty yet)
  useEffect(() => {
    if (!useLots && qtyValue === getLotSize(symbol, [])) {
      setQtyValue(lotSize);
    }
  }, [lotSize]);

  // Toast helper
  const showToast = (msg: string, isError = false) => {
    setToast({ visible: true, msg, isError });
    setTimeout(() => setToast({ visible: false, msg: '' }), 2000);
  };

  // Convert timeframe to Binance or Kite interval string
  const getIntervalString = () => {
    if (isCrypto) {
      switch (timeframe) {
        case '1m': return '1m';
        case '5m': return '5m';
        case '15m': return '15m';
        case '60m': return '1h';
        case 'day': return '1d';
        default: return '5m';
      }
    } else {
      switch (timeframe) {
        case '1m': return 'minute';
        case '5m': return '5minute';
        case '15m': return '15minute';
        case '60m': return '60minute';
        case 'day': return 'day';
        default: return '5minute';
      }
    }
  };

  const fetchBalance = async () => {
    let token = '';
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      token = sessionData.session?.access_token || '';
      if (!token) return;

      const res = await fetch('/api/pay/balance', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (typeof data.balance === 'number') {
        setBalance(data.balance);
      }
    } catch (err) {
      console.warn('Failed to fetch balance:', err);
    }

    if (!token) return;

    // Fetch profile trading_mode
    let mode = 'normal';
    try {
      const profileRes = await supabase.from('profiles').select('trading_mode').single();
      mode = profileRes.data?.trading_mode || 'normal';
      console.log('[TradingChart] Profile trading_mode:', mode, 'error:', profileRes.error?.message);
      setProfile({ trading_mode: mode });
      // Initialize Scalp toggle based on user's saved preference or default trading mode
      const savedMode = localStorage.getItem('isTradeOnChartActive');
      if (savedMode !== null) {
        setIsTradeOnChartActive(savedMode === 'true');
      } else {
        setIsTradeOnChartActive(mode === 'scalper');
      }
    } catch (err) {
      console.warn('Failed to fetch profile:', err);
    }

    // Fetch segment + script settings
    try {
      const [settingsRes, scriptRes] = await Promise.all([
        fetch(`/api/user/segments?mode=${mode}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/user/script-settings', { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        setSegmentSettings(settingsData || []);
      }
      if (scriptRes.ok) {
        const ssData = await scriptRes.json();
        setScriptSettings(ssData || []);
      }
    } catch (err) {
      console.warn('Failed to fetch segment or script settings:', err);
    }
  };

  // Get user's actual funds balance
  useEffect(() => {
    fetchBalance();
  }, []);

  // Ensure default quantity is reset to 1 when the symbol changes
  useEffect(() => {
    const isQtyDefault = segment.toUpperCase().includes('EQUITY') || segment.toUpperCase() === 'NSE-EQ' || segment.toUpperCase().includes('CRYPTO');
    setUseLots(!isQtyDefault);
    setQtyValue(1);
  }, [symbol]);


  // Fetch Historical Data
  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        let data: Candle[] = [];

        if (isCrypto) {
          const interval = getIntervalString();
          const res = await fetch(`/api/market/historical-crypto?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=500`);
          const json = await res.json();
          if (!Array.isArray(json)) throw new Error(json.error || json.msg || 'Failed to fetch');
          data = json.map((k: any) => ({
            timestamp: parseInt(k[0]),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
          }));
        } else {
          const toDate = new Date();
          let fromDate = new Date();

          if (timeframe === 'day') {
            fromDate.setFullYear(fromDate.getFullYear() - 1);
          } else if (timeframe === '60m') {
            fromDate.setDate(fromDate.getDate() - 30);
          } else if (timeframe === '15m') {
            fromDate.setDate(fromDate.getDate() - 10);
          } else {
            fromDate.setDate(fromDate.getDate() - 4);
          }

          const from = fromDate.toISOString().split('T')[0];
          const to = toDate.toISOString().split('T')[0];
          const interval = getIntervalString();

          const res = await fetch(`/api/market/historical?symbol=${encodeURIComponent(symbol)}&interval=${interval}&from=${from}&to=${to}`);
          const json = await res.json();

          if (res.ok && json.candles) {
            data = json.candles.map((c: any) => {
              const dt = new Date(c[0]);
              return {
                timestamp: dt.getTime(),
                open: c[1],
                high: c[2],
                low: c[3],
                close: c[4],
                volume: c[5] || 0,
              };
            });
          } else {
            throw new Error(json.error || 'Failed to load historical data');
          }
        }

        if (isMounted) {
          const uniqueData = Array.from(new Map(data.map(item => [item.timestamp, item])).values());
          uniqueData.sort((a, b) => a.timestamp - b.timestamp);

          setHistoricalCandles(uniqueData);
          if (uniqueData.length > 0) hasLoadedData.current = true;
          setLoading(false);

          if (uniqueData.length > 0) {
            const last = uniqueData[uniqueData.length - 1];
            setCurrentPrice(last.close);
            setLimitPrice(last.close.toFixed(2));
            if (uniqueData.length > 1) {
              const prev = uniqueData[uniqueData.length - 2];
              const change = last.close - prev.close;
              setPriceChange(change);
              setPriceChangePct((change / prev.close) * 100);
            }
          }
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err.message);
          setLoading(false);
        }
      }
    };

    fetchData();

    return () => { isMounted = false; };
  }, [symbol, timeframe, isCrypto]);

  // Update with activeLiveQuote — only when the chart is showing an underlying (index/equity),
  // not a derivative. When viewing an option/futures chart, activeLiveQuote is the underlying's
  // price and must not overwrite currentPrice (which comes from the option's candle data).
  useEffect(() => {
    if (!activeLiveQuote || loading) return;
    if (symbol.includes('CE') || symbol.includes('PE') || symbol.includes('FUT')) return;

    const lastPrice = activeLiveQuote.lastPrice;
    if (!lastPrice) return;

    setCurrentPrice(lastPrice);
    if (limitPrice === '') setLimitPrice(lastPrice.toFixed(2));

    const lastCandle = historicalCandles.length > 0 ? historicalCandles[historicalCandles.length - 1] : null;
    setPriceChange(activeLiveQuote.change || (lastPrice - (lastCandle?.open || lastPrice)));
    setPriceChangePct(activeLiveQuote.changePercent || 0);
  }, [activeLiveQuote, loading, historicalCandles]);

  const displayExchange = isCrypto ? 'BINANCE' : (symbol.includes('SENSEX') || symbol.includes('BANKEX')) ? 'BSE' : 'NSE';
  const isUp = priceChange >= 0;

  // Drawing Tools Click handler
  const handleDrawingTool = (toolName: string) => {
    setActiveDrawingTool(activeDrawingTool === toolName ? null : toolName);
    showToast("Drawing tools are coming soon in the modernized engine");
  };

  // Stepper for quantity
  // In Lot mode: step by 0.5. In Qty mode: step by lotSize (whole units)
  const handleQtyStep = (delta: number) => {
    if (useLots) {
      setQtyValue(prev => Math.max(0.5, parseFloat((Number(prev) + delta * 0.5).toFixed(1))));
    } else {
      const step = isCrypto ? 0.01 : lotSize;
      const minQty = isCrypto ? 0.01 : lotSize;
      setQtyValue(prev => Math.max(minQty, parseFloat((Number(prev) + delta * step).toFixed(isCrypto ? 2 : 0))));
    }
  };

  // Toggle Lots vs Qty
  const handleUnitChange = (lotsActive: boolean) => {
    setUseLots(lotsActive);
    setQtyValue(prev => {
      const p = Number(prev);
      if (lotsActive) {
        // Convert qty -> lots, allow decimal (e.g. 12.5 qty / 25 lotSize = 0.5 lots)
        return Math.max(0.5, parseFloat((p / lotSize).toFixed(1)));
      } else {
        // Convert lots -> qty (always whole number except for crypto)
        return isCrypto ? parseFloat((p * lotSize).toFixed(2)) : Math.round(p * lotSize);
      }
    });
  };

  // Place actual order
  const handleSubmitOrder = async () => {
    const qVal = Number(qtyValue) || 0;
    if (qVal <= 0) {
      showToast("Invalid quantity", true);
      return;
    }
    const finalQty = useLots ? (isCrypto ? qVal * lotSize : Math.round(qVal * lotSize)) : (isCrypto ? qVal : Math.round(qVal));
    const finalLots = useLots ? qVal : (finalQty / lotSize);

    // Determine the base execution price
    // For add-more/exit flow on a different instrument, use that position's LTP not the chart price
    // For chain contract orders, use the option contract's LTP not the underlying index price
    const basePrice = ((isAddMoreFlow || isExitFlow) && addMoreLtp) ? addMoreLtp : (chainContract ? chainContract.ltp : currentPrice);
    let finalPrice = basePrice;
    if (orderType === 'limit' || orderType === 'gtt') {
      finalPrice = parseFloat(limitPrice);
      if (isNaN(finalPrice) || finalPrice <= 0) {
        showToast('Please enter a valid price', true);
        return;
      }
    } else if (orderType === 'sl' || orderType === 'slm') {
      finalPrice = parseFloat(triggerPrice);
      if (isNaN(finalPrice) || finalPrice <= 0) {
        showToast('Please enter a valid trigger price', true);
        return;
      }
    }

    // Use the option segment for lookup when placing a chain contract order,
    // not the chart's underlying segment which may be "NSE - Equity" etc.
    const submitDbSeg = (() => {
      if (chainContract) {
        const name = chainContract.name.toUpperCase();
        const indexOptSymbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
        return indexOptSymbols.some(s => name.includes(s)) ? 'INDEX-OPT' : 'STOCK-OPT';
      }
      return mapSegmentToDbSegment(segment);
    })();
    const buySetting = segmentSettings.find(s => s.segment === submitDbSeg && s.side === 'BUY');
    const sellSetting = segmentSettings.find(s => s.segment === submitDbSeg && s.side === 'SELL');
    const segSetting = orderSide === 'SELL' ? sellSetting : buySetting;

    const intradayLeverage = segSetting?.intraday_leverage ?? 10;
    const holdingLeverage = segSetting?.holding_leverage ?? 10;
    const leverage = orderCarry === 'carry' ? holdingLeverage : intradayLeverage;
    const intradayType = segSetting?.intraday_type ?? 'Multiplier';
    const holdingType = segSetting?.holding_type ?? 'Multiplier';
    const levType = orderCarry === 'carry' ? holdingType : intradayType;

    const reqMargin = Math.round(levType === '%' ? (finalPrice * finalQty) * (leverage / 100) : (levType === 'Fixed' ? (finalQty / lotSize) * leverage : (finalPrice * finalQty) / leverage));
    if (reqMargin > balance) {
      showToast('Insufficient margin', true);
      return;
    }

    // Determine target symbol and segment — use position's symbol when in add-more or exit flow
    let orderSymbol = symbol;
    let orderSegment = segment;

    if (isAddMoreFlow && addMoreSymbol) {
      orderSymbol = addMoreSymbol;
      orderSegment = addMoreSegment || segment;
    } else if (isExitFlow && exitPositionId) {
      const p = positions.find(x => x.id === exitPositionId);
      if (p) {
        orderSymbol = p.symbol;
        orderSegment = p.settlement || p.segment || segment;
      }
    }

    let orderKiteInstrument = (isAddMoreFlow || isExitFlow) && addMoreKiteInst ? addMoreKiteInst : orderSymbol;

    if (chainContract) {
      orderSymbol = chainContract.name;

      const underlying = symbol.toUpperCase().replace('_INDEX', '').replace('NSE:', '').replace('INDEX', '').trim();
      let prefix = 'NFO';
      if (underlying.includes('SENSEX') || underlying.includes('BANKEX')) prefix = 'BFO';
      else if (['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD'].some(c => underlying.startsWith(c))) prefix = 'MCX';

      orderKiteInstrument = chainContract.kiteId || `${prefix}:${orderSymbol}`;
      orderSegment = 'INDEX-OPT';
    } else {
      // For exit/add-more flows on options and futures, ensure kite instrument has prefix
      if (orderSymbol && (orderSymbol.endsWith('CE') || orderSymbol.endsWith('PE') || orderSymbol.endsWith('FUT') || orderSymbol.includes('FUT')) && !orderKiteInstrument.includes(':')) {
        let prefix = 'NFO';
        if (orderSymbol.startsWith('SENSEX') || orderSymbol.startsWith('BANKEX')) prefix = 'BFO';
        else if (['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD'].some(c => orderSymbol.startsWith(c))) prefix = 'MCX';
        else if (orderSymbol.startsWith('EURINR') || orderSymbol.startsWith('USDINR') || orderSymbol.startsWith('GBPINR') || orderSymbol.startsWith('JPYINR')) prefix = 'CDS';
        orderKiteInstrument = `${prefix}:${orderSymbol}`;
      }
    }

    if (modifyOrderId) {
      showToast('Modifying order...');
      const cancelRes = await cancelOrder(modifyOrderId);
      if (!cancelRes.success) {
        showToast(cancelRes.error || 'Failed to modify order (cancel failed)', true);
        return;
      }
    } else {
      showToast('Placing order...');
    }

    // Optimistic UI: Immediately close panel and show processing state
    if (modifyOrderId) {
      setModifyOrderId(null);
    }
    setIsOrderBlockVisible(false);
    setChainContract(null);
    setIsExitFlow(false);
    setIsAddMoreFlow(false);
    setAddMoreSymbol(null);
    setAddMoreSegment(null);
    setAddMoreLtp(null);
    setAddMoreKiteInst(null);
    setExitPositionId(null);
    setOrderBlockTitle(symbol);
    
    const returnTo = postOrderSegment;
    setPostOrderSegment(null);
    if (returnTo && returnTo !== 'main') {
      setActiveSegment(returnTo as 'chain' | 'orders' | 'positions');
      setIsPanelExpanded(true);
    }

    placeOrder({
      symbol: orderSymbol,
      kite_instrument: orderKiteInstrument,
      segment: orderSegment,
      side: orderSide,
      qty: finalQty,
      lots: finalLots,
      order_type: orderType.toUpperCase() as any,
      product_type: orderCarry === 'carry' ? 'CARRY' : 'INTRADAY',
      client_price: finalPrice,
      trigger_price: (orderType === 'sl' || orderType === 'slm') ? parseFloat(triggerPrice) : undefined,
      stop_loss: gttSlPrice ? parseFloat(gttSlPrice) : undefined,
      target: gttTargetPrice ? parseFloat(gttTargetPrice) : undefined,
      is_exit: isExitFlow
    }).then(res => {
      if (res.success) {
        showToast(modifyOrderId ? 'Order Modified Successfully!' : `${orderSide} Order Placed Successfully!`);
        refreshOrders();
        refreshPositions();
        fetchBalance();
        window.dispatchEvent(new CustomEvent('position-closed'));
      } else {
        showToast(res.error || 'Failed to place order', true);
      }
    }).catch(err => {
      showToast(err?.message || 'Failed to place order', true);
    });
  };

  // Cancel actual order
  const handleCancelOrder = async (id: string) => {
    showToast('Cancelling order...');
    const res = await cancelOrder(id);
    if (res.success) {
      showToast('Order cancelled');
      refreshOrders();
      fetchBalance();
      if (modifyOrderId === id) {
        setModifyOrderId(null);
        setIsOrderBlockVisible(false);
        setOrderBlockTitle(symbol);
      }
    } else {
      showToast(res.error || 'Cancel failed', true);
    }
  };

  const handleModifyOrder = (o: MyOrder) => {
    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
    else setIsPanelExpanded(false);
    setModifyOrderId(o.id);
    setOrderSide(o.side);
    setQtyValue(o.qty);
    setUseLots(false);
    setOrderCarry(o.product_type === 'CARRY' ? 'carry' : 'normal');
    setOrderType(o.order_type.toLowerCase() as any);
    setLimitPrice(o.client_price ? o.client_price.toString() : '');
    setTriggerPrice(o.trigger_price ? o.trigger_price.toString() : '');
    setGttSlPrice(o.stop_loss ? o.stop_loss.toString() : '');
    setGttTargetPrice(o.target ? o.target.toString() : '');
    setIsExitFlow(false);
    setIsAddMoreFlow(false);
    setOrderBlockTitle(`Modify · ${o.symbol}`);
    setPostOrderSegment('orders');
    setIsOrderBlockVisible(true);
  };

  // Exit position via order panel (allows choosing Market/SL)
  const handleExitPosition = (pos: EnrichedPosition) => {
    if (isTradeOnChartActive) {
      handleQuickExit(pos);
      return;
    }

    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
    else setIsPanelExpanded(false);
    setIsExitFlow(true);
    setIsAddMoreFlow(false);
    setExitPositionId(pos.id);

    // Also set the target symbol info so the order block UI shows the correct position prices
    // instead of the chart's current instrument prices
    setAddMoreSymbol(pos.symbol);
    setAddMoreSegment(pos.settlement || pos.segment || segment);
    setAddMoreKiteInst(pos.kite_instrument || pos.symbol);
    setAddMoreLtp(pos.current_ltp || pos.avg_price || pos.entry_price);

    setOrderSide(pos.side === 'BUY' ? 'SELL' : 'BUY');
    setQtyValue(pos.qty_open);
    setUseLots(false);
    setOrderCarry(pos.product_type === 'CARRY' ? 'carry' : 'normal');
    setOrderType('market');
    const posPrice = pos.current_ltp || pos.avg_price || pos.entry_price || currentPrice;
    setLimitPrice(posPrice.toFixed(2));
    setTriggerPrice(posPrice.toFixed(2));
    setOrderBlockTitle(`Exit · ${pos.symbol}`);
    setPostOrderSegment('main');
    setIsOrderBlockVisible(true);
  };

  const quickExitLock = useRef(false);
  const exitingPosIds = useRef<Set<string>>(new Set());
  const [, setForceRender] = useState(0);

  // Direct quick-exit (instant market close of selected lot size)
  const handleQuickExit = async (pos: EnrichedPosition) => {
    if (quickExitLock.current || exitingPosIds.current.has(pos.id)) return;
    quickExitLock.current = true;
    exitingPosIds.current.add(pos.id);
    setForceRender(prev => prev + 1);

    const qVal = Number(qtyValue) || 0;
    if (qVal <= 0) {
      showToast("Invalid quantity", true);
      quickExitLock.current = false;
      exitingPosIds.current.delete(pos.id);
      setForceRender(prev => prev + 1);
      return;
    }
    const isScalper = profile?.trading_mode === 'scalper';
    const effectiveUseLots = isScalper ? true : useLots;
    const posLotSize = getLotSize(pos.symbol, scriptSettings);
    const requestedQty = effectiveUseLots ? (isCrypto ? qVal * posLotSize : Math.round(qVal * posLotSize)) : (isCrypto ? qVal : Math.round(qVal));
    
    // Cap at the open position quantity to prevent flipping the position accidentally
    const finalQty = Math.min(requestedQty, pos.qty_open);

    if (finalQty <= 0) return;

    const exitSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const effectiveLots = effectiveUseLots ? (finalQty / posLotSize) : (finalQty / posLotSize);

    showToast(`Placing quick exit order...`);
    const res = await placeOrder({
      symbol: pos.symbol,
      kite_instrument: pos.kite_instrument || pos.symbol,
      segment: pos.settlement || segment,
      side: exitSide,
      qty: finalQty,
      lots: effectiveLots,
      order_type: 'MARKET',
      product_type: pos.product_type || 'INTRADAY',
      is_exit: true,
      linked_position_id: pos.id
    });

    if (res.success) {
      showToast(`Quick exit order placed`);
      refreshOrders();
      setTimeout(() => {
        refreshPositions();
        fetchBalance();
        quickExitLock.current = false;
        // Do NOT remove from exitingPosIds on success. 
        // It should stay permanently locked until the position disappears from the UI.
      }, 1000); // Give DB time to match
    } else {
      showToast(res.error || 'Exit failed', true);
      quickExitLock.current = false;
      exitingPosIds.current.delete(pos.id);
      setForceRender(prev => prev + 1);
    }
  };

  // Add more to a position (may be a different symbol from the current chart)
  const handleAddMorePosition = (pos: EnrichedPosition) => {
    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
    else setIsPanelExpanded(false);
    setIsExitFlow(false);
    setIsAddMoreFlow(true);
    setExitPositionId(null);
    setAddMoreSymbol(pos.symbol);
    setAddMoreSegment(pos.settlement || segment);
    setAddMoreLtp(pos.current_ltp || pos.avg_price || pos.entry_price);
    setAddMoreKiteInst(pos.kite_instrument || pos.symbol);
    setOrderSide(pos.side);
    setQtyValue(pos.qty_open);
    setUseLots(false);
    setOrderCarry(pos.product_type === 'CARRY' ? 'carry' : 'normal');
    setOrderType('market');
    setOrderBlockTitle(`Add More · ${pos.symbol}`);
    setPostOrderSegment('main');
    setIsOrderBlockVisible(true);
  };

  const quickEntryLock = useRef(false);

  const handleQuickMarketOrder = async (side: 'BUY' | 'SELL') => {
    if (quickEntryLock.current) return;
    quickEntryLock.current = true;

    const qVal = Number(qtyValue) || 0;
    if (qVal <= 0) {
      showToast("Invalid quantity", true);
      quickEntryLock.current = false;
      return;
    }
    const isScalper = profile?.trading_mode === 'scalper';
    const effectiveUseLots = isScalper ? true : useLots;
    const finalQty = effectiveUseLots ? (isCrypto ? qVal * lotSize : Math.round(qVal * lotSize)) : (isCrypto ? qVal : Math.round(qVal));

    const dbSeg = mapSegmentToDbSegment(segment);
    const segSetting = segmentSettings.find(s => s.segment === dbSeg && s.side === side);
    const intradayLeverage = segSetting?.intraday_leverage ?? 10;
    const intradayType = segSetting?.intraday_type ?? 'Multiplier';
    const required = Math.round(intradayType === '%' ? (currentPrice * finalQty) * (intradayLeverage / 100) : (intradayType === 'Fixed' ? (finalQty / lotSize) * intradayLeverage : (currentPrice * finalQty) / intradayLeverage));

    if (required > balance) {
      showToast(`Insufficient margin! Need ₹${required.toLocaleString('en-IN')}`, true);
      return;
    }

    showToast(`Placing quick ${side} order...`);
    const res = await placeOrder({
      symbol: symbol,
      kite_instrument: symbol,
      segment: segment,
      side: side,
      qty: finalQty,
      lots: effectiveUseLots ? qVal : (finalQty / lotSize),
      order_type: 'MARKET',
      product_type: 'INTRADAY',
      client_price: 0,
      is_exit: false
    });

    if (res.success) {
      showToast(`Quick ${side} Order Placed Successfully!`);
      // Flash the button
      const btn = document.getElementById(side === 'BUY' ? 'buyButton' : 'sellButton');
      if (btn) {
        btn.classList.remove('quick-flash');
        void btn.offsetWidth; // force reflow
        btn.classList.add('quick-flash');
      }
      refreshOrders();
      refreshPositions();
      fetchBalance();
      window.dispatchEvent(new CustomEvent('position-closed'));
    } else {
      showToast(res.error || 'Failed to place quick order', true);
    }
    
    // Release entry lock after a short debounce to prevent mouse-bounces
    setTimeout(() => { quickEntryLock.current = false; }, 500);
  };

  const handleQuickAddPosition = async (pos: EnrichedPosition) => {
    if (quickEntryLock.current) return;
    quickEntryLock.current = true;

    const addQty = pos.qty_open;
    const dbSeg = mapSegmentToDbSegment(segment);
    const segSetting = segmentSettings.find(s => s.segment === dbSeg && s.side === pos.side);
    const leverage = pos.product_type === 'CARRY' ? (segSetting?.holding_leverage ?? 10) : (segSetting?.intraday_leverage ?? 10);
    const levType = pos.product_type === 'CARRY' ? (segSetting?.holding_type ?? 'Multiplier') : (segSetting?.intraday_type ?? 'Multiplier');
    const required = Math.round(levType === '%' ? (currentPrice * addQty) * (leverage / 100) : (levType === 'Fixed' ? (addQty / lotSize) * leverage : (currentPrice * addQty) / leverage));

    if (required > balance) {
      showToast(`Insufficient margin! Need ₹${required.toLocaleString('en-IN')}`, true);
      quickEntryLock.current = false;
      return;
    }

    showToast(`Adding ${addQty} to ${pos.side} position...`);
    const res = await placeOrder({
      symbol: symbol,
      kite_instrument: symbol,
      segment: segment,
      side: pos.side,
      qty: addQty,
      lots: 0,
      order_type: 'MARKET',
      product_type: pos.product_type === 'CARRY' ? 'CARRY' : 'INTRADAY',
      client_price: 0,
      is_exit: false
    });

    if (res.success) {
      showToast(`Successfully added ${addQty} to position!`);
      refreshOrders();
      refreshPositions();
      fetchBalance();
      window.dispatchEvent(new CustomEvent('position-closed'));
    } else {
      showToast(res.error || 'Failed to add to position', true);
    }
    
    // Release entry lock after a short debounce to prevent mouse-bounces
    setTimeout(() => { quickEntryLock.current = false; }, 500);
  };

  // All open/active positions (not filtered by symbol)
  const currentSymbolPositions = positions.filter(p => (p.status === 'open' || p.status === 'active'));
  // Sum pre-computed unrealised P&L (uses correct per-symbol LTP from useMyPositions)
  const pnlTotal = currentSymbolPositions.reduce((acc, pos) => acc + (pos.unrealised_pnl ?? 0), 0);

  // Instrument-specific position: find open position matching the currently viewed chart symbol
  const currentInstrumentPosition = useMemo(() => {
    const matchingPositions = positions.filter(p => {
      if (p.status !== 'open' && p.status !== 'active') return false;
      if (p.symbol === symbol) return true;
      if (p.kite_instrument === symbol) return true;
      if (p.symbol + 'USDT' === symbol) return true;
      if (symbol + 'USDT' === p.symbol) return true;
      return false;
    });
    if (matchingPositions.length === 0) return null;

    // Group them like Cumulative view
    const totalQty = matchingPositions.reduce((sum, p) => sum + p.qty_open, 0);
    const repPos = matchingPositions[0]; // just take first for other metadata
    return { ...repPos, qty_open: totalQty };
  }, [positions, symbol]);

  // Calculated Required Margin for current order block state
  // Determine if the current chart symbol is itself an option/futures contract
  // (not the underlying index). In that case, activeLiveQuote belongs to the underlying
  // so we must NOT use its bid/ask for placing an option order.
  const symbolIsDerivative = symbol.includes('CE') || symbol.includes('PE') || symbol.includes('FUT');

  // When in add-more or exit flow for a different instrument, use that instrument's live quote
  // instead of the chart's current symbol's quote for bid/ask/LTP/margin
  const isTargetFlow = ((isAddMoreFlow || isExitFlow) && addMoreSymbol && addMoreSymbol !== symbol);
  const addMoreQuote = isTargetFlow ? marketQuotes[addMoreSymbol!] : null;

  const rawBid = isTargetFlow
    ? (addMoreQuote?.bid || addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
    : ((!symbolIsDerivative && activeLiveQuote)
      ? (activeLiveQuote.bid || activeLiveQuote.lastPrice || currentPrice)
      : currentPrice);
  const rawAsk = isTargetFlow
    ? (addMoreQuote?.ask || addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
    : ((!symbolIsDerivative && activeLiveQuote)
      ? (activeLiveQuote.ask || activeLiveQuote.lastPrice || currentPrice)
      : currentPrice);
  const underlyingPriceOfScript = orderSide === 'SELL' ? rawBid : rawAsk;
  // When a chain contract is open, use the option's bid/ask price, not the underlying index price
  const priceOfScript = chainContract
    ? (orderSide === 'SELL' ? chainContract.bid : chainContract.ask)
    : underlyingPriceOfScript;

  const orderQty = useLots ? (parseFloat(String(qtyValue)) || 0) * lotSize : (parseFloat(String(qtyValue)) || 0);
  // Fall back to currentPrice if activeLiveQuote bid/ask is missing or zero
  const resolvedPrice = priceOfScript > 0 ? priceOfScript : currentPrice;
  const executionPrice = orderType === 'limit'
    ? (parseFloat(limitPrice) > 0 ? parseFloat(limitPrice) : resolvedPrice)
    : resolvedPrice;

  const liveOptionQuote = (chainContract && chainContract.kiteId) ? marketQuotes[chainContract.kiteId] : null;
  const liveAsk = isTargetFlow
    ? (addMoreQuote?.ask || addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
    : (chainContract
      ? (liveOptionQuote?.ask || chainContract.ask)
      : rawAsk);
  const liveBid = isTargetFlow
    ? (addMoreQuote?.bid || addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
    : (chainContract
      ? (liveOptionQuote?.bid || chainContract.bid)
      : rawBid);
  const liveLTP = isTargetFlow
    ? (addMoreQuote?.lastPrice || addMoreLtp || currentPrice)
    : (chainContract
      ? (liveOptionQuote?.lastPrice || chainContract.ltp)
      : (!symbolIsDerivative && activeLiveQuote ? (activeLiveQuote.lastPrice || currentPrice) : currentPrice));

  // When a chain contract is open, the option segment must be used for settings lookup,
  // not the chart's underlying segment (e.g. "NSE - Equity" for NIFTY 50).
  const effectiveDbSeg = (() => {
    if (chainContract) {
      const name = chainContract.name.toUpperCase();
      const stockOptSymbols = ['SENSEX', 'BANKEX'];
      const indexOptSymbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
      const isIndexOpt = indexOptSymbols.some(s => name.includes(s)) || !stockOptSymbols.some(s => name.includes(s));
      return isIndexOpt ? 'INDEX-OPT' : 'STOCK-OPT';
    }
    // When in add-more or exit flow, use the position's segment for settings lookup
    if ((isAddMoreFlow || isExitFlow) && addMoreSegment) {
      return mapSegmentToDbSegment(addMoreSegment);
    }
    return mapSegmentToDbSegment(segment);
  })();

  const dbSeg = effectiveDbSeg;
  const buySetting = segmentSettings.find(s => s.segment === dbSeg && s.side === 'BUY');
  const sellSetting = segmentSettings.find(s => s.segment === dbSeg && s.side === 'SELL');
  const segSetting = orderSide === 'SELL' ? sellSetting : buySetting;

  const intradayLeverage = segSetting?.intraday_leverage ?? 10;
  const holdingLeverage = segSetting?.holding_leverage ?? 10;
  const leverage = orderCarry === 'carry' ? holdingLeverage : intradayLeverage;
  const intradayType = segSetting?.intraday_type ?? 'Multiplier';
  const holdingType = segSetting?.holding_type ?? 'Multiplier';
  const leverageType = orderCarry === 'carry' ? holdingType : intradayType;

  const chargePrice = orderType === 'limit' && limitPrice && parseFloat(limitPrice) > 0
    ? parseFloat(limitPrice) : resolvedPrice;
  const chargeQty = orderQty;
  const chargeExposure = chargeQty * chargePrice;

  const computeCharge = (commType: string, commVal: number) => {
    if (commType === 'Per Crore') return (chargeExposure * commVal) / 10000000;
    if (commType === 'Per Lot') return (chargeQty / lotSize) * commVal;
    if (commType === 'Per Trade' || commType === 'Flat') return commVal;
    return chargeExposure * 0.001;
  };

  const multiplier = (isExitFlow || isAddMoreFlow || modifyOrderId) ? 1 : 2;

  // Brokerage preview: Only intraday + GTT shown at entry.
  // Carry brokerage is DEFERRED to exit time (charged when position is closed as CARRY).
  const intradayCharge = (segSetting ? computeCharge(
    segSetting.commission_type || 'Per Crore',
    segSetting.commission_value ?? 0
  ) : 0) * multiplier;

  const gttCharge = (segSetting ? computeCharge(
    segSetting.gtt_commission_type || 'Per Trade',
    segSetting.gtt_commission_value ?? 10
  ) : 0) * multiplier;

  const carryCharge = (segSetting ? computeCharge(
    segSetting.carry_commission_type || segSetting.commission_type || 'Per Crore',
    segSetting.carry_commission_value ?? segSetting.commission_value ?? 0
  ) : 0) * multiplier;

  const totalBrokerage = (
    intradayCharge +
    (orderCarry === 'carry' ? carryCharge : 0) +
    (orderType === 'gtt' ? gttCharge : 0)
  );
  const marginPortion = calculateMarginPortion({
    segment: dbSeg,
    side: orderSide,
    leverageType,
    leverage,
    totalQty: orderQty,
    lotSize,
    baseExposure: executionPrice * orderQty
  });
  const reqMargin = Math.round(marginPortion + totalBrokerage);

  // Render collapsible panel tabs content
  const renderPanelContent = () => {
    if (activeSegment === 'chain') {
      if (isCrypto || segment.toUpperCase().includes('FOREX')) {
        return <div className="empty-state">Option Chain not available for this segment.</div>;
      }
      if (chainLoading) {
        return <div className="empty-state">Loading chain...</div>;
      }
      if (!chainStrikes || chainStrikes.length === 0) {
        return <div className="empty-state">Option chain data is currently unavailable for {symbol}.</div>;
      }

      const handleTableTrade = (tradeSymbol: string, defaultAction: 'BUY' | 'SELL') => {
        // tradeSymbol = "NIFTY26JUN24000CE|221.45|0|NFO:NIFTY26JUN24000CE"
        const parts = tradeSymbol.split('|');
        if (parts.length < 2) return;
        const contractName = parts[0];
        const ltp = parseFloat(parts[1]) || 0;
        const kiteId = parts[3] || '';
        openChainOrder(defaultAction, contractName, chainExpiry, ltp, 0, kiteId);
      };

      // Transform real strikes for TradingChart format (needs tradeSymbol with | format for handleTableTrade)
      const mappedStrikes = chainStrikes.map((r: any) => {
        const ceQuote = r.ce?.id ? marketQuotes[r.ce.id] : null;
        const peQuote = r.pe?.id ? marketQuotes[r.pe.id] : null;
        const ceLtp = ceQuote ? ceQuote.lastPrice : (r.ce?.price || 0);
        const peLtp = peQuote ? peQuote.lastPrice : (r.pe?.price || 0);

        return {
          strike: r.strike,
          ce: { ...r.ce, symbol: r.ce ? `${r.ce.symbol}|${ceLtp}|0|${r.ce.id}` : '' },
          pe: { ...r.pe, symbol: r.pe ? `${r.pe.symbol}|${peLtp}|0|${r.pe.id}` : '' }
        };
      });

      return (
        <div className="tc-chain-container" style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
          <OptionChainTable
            strikes={mappedStrikes}
            quotes={marketQuotes}
            spotPrice={chainData?.underlyingPrice || currentPrice || 71.00}
            onTrade={handleTableTrade}
            priceMode="LTP"
            stickyTop={0}
            hideMainHeader={true}
          />
        </div>
      );
    }

    if (activeSegment === 'orders') {
      const openOrders = orders.filter(o => o.status === 'PENDING');

      return (
        <>
          {openOrders.length === 0 ? (
            <div className="empty-state">No open orders.</div>
          ) : (
            openOrders.map(o => {
              const isBuy = o.side === 'BUY';
              const label = o.side;
              const labelBg = isBuy ? 'var(--green-bg)' : 'var(--red-bg)';
              const labelClr = isBuy ? 'var(--green-text)' : 'var(--red-text)';
              const timeStr = o.created_at ? new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
              return (
                <div key={o.id} className="order-row">
                  <div className="order-info-row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 0%', minWidth: 0 }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{o.symbol}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span style={{ fontWeight: 700, color: labelClr, fontSize: '10px', background: labelBg, padding: '1px 6px', borderRadius: '4px' }}>{label}</span>
                        <span style={{ color: 'var(--pill-text)', fontSize: '11px' }}>{o.qty} qty</span>
                        {o.order_type && (
                          <span style={{ fontSize: '9px', background: 'var(--blue-bg)', color: 'var(--blue-text)', padding: '1px 6px', borderRadius: '4px', fontWeight: 600 }}>
                            {o.order_type.toUpperCase()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', flexShrink: 0 }}>
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '12px' }}>
                        ₹{(() => {
                          const type = (o.order_type || '').toUpperCase();
                          if (type === 'GTT') {
                            if (o.stop_loss && o.target) return `SL ${o.stop_loss.toFixed(2)} / TP ${o.target.toFixed(2)}`;
                            if (o.stop_loss) return `SL ₹${o.stop_loss.toFixed(2)}`;
                            if (o.target) return `TP ₹${o.target.toFixed(2)}`;
                          }
                          if (type === 'SL' || type === 'SLM') return (o.trigger_price ?? o.client_price ?? 0).toFixed(2);
                          return (o.client_price ?? o.fill_price ?? o.ltp_at_entry ?? 0).toFixed(2);
                        })()}
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{timeStr}</span>
                    </div>
                  </div>
                  {o.status === 'PENDING' && (
                    <div className="order-actions">
                      <button className="order-action-btn modify-order-btn" onClick={() => handleModifyOrder(o)}>Modify</button>
                      <button className="order-action-btn delete-order-btn" onClick={() => handleCancelOrder(o.id)}>Delete</button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </>
      );
    }

    // Positions — Rich Layout matching CHARTINH.html exactly
    if (currentSymbolPositions.length === 0) {
      return <div className="empty-state">No active positions.</div>;
    }

    // Group positions by symbol, side, and product_type to show cumulative totals
    const groupedPositionsMap = new Map();
    for (const pos of currentSymbolPositions) {
      const key = `${pos.symbol}|${pos.side}|${pos.product_type}`;
      if (!groupedPositionsMap.has(key)) {
        groupedPositionsMap.set(key, { ...pos });
      } else {
        const existing = groupedPositionsMap.get(key);
        const entryA = existing.avg_price || existing.entry_price || 0;
        const entryB = pos.avg_price || pos.entry_price || 0;
        const totalValue = (existing.qty_open * entryA) + (pos.qty_open * entryB);
        existing.qty_open += pos.qty_open;
        existing.entry_price = totalValue / existing.qty_open;
        existing.avg_price = totalValue / existing.qty_open;
        existing.unrealised_pnl = (existing.unrealised_pnl || 0) + (pos.unrealised_pnl || 0);
        // Do NOT aggregate 'id' to a string, just keep the first representative pos ID for handleExitPosition
      }
    }
    const groupedPositions = Array.from(groupedPositionsMap.values());

    return groupedPositions.map((pos) => {
      const entryPrice = pos.avg_price || pos.entry_price;
      const pnl = pos.unrealised_pnl ?? 0;
      const pnlColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
      const sideBg = pos.side === 'BUY' ? 'var(--green-bg)' : 'var(--red-bg)';
      const sideClr = pos.side === 'BUY' ? 'var(--green-text)' : 'var(--red-text)';
      return (
        <div key={pos.id} className="position-row">
          <div className="position-info-row">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{pos.symbol}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span style={{ fontWeight: 700, color: sideClr, fontSize: '10px', background: sideBg, padding: '1px 6px', borderRadius: '4px' }}>
                  {pos.side}
                </span>
                <span style={{ color: 'var(--pill-text)', fontSize: '11px' }}>{pos.qty_open} qty</span>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', rowGap: '2px', columnGap: '6px', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>Entry</span>
              <span style={{ color: 'var(--text-primary)', fontSize: '11px', fontWeight: 500 }}>₹{entryPrice.toFixed(2)}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>LTP</span>
              <span style={{ color: 'var(--text-primary)', fontSize: '11px', fontWeight: 500 }}>₹{(pos.current_ltp ?? pos.ltp ?? pos.avg_price ?? pos.entry_price ?? 0).toFixed(2)}</span>
            </div>
            <div style={{ color: pnlColor, fontWeight: 700 }}>
              {pnl >= 0 ? '+' : '-'}₹{Math.abs(pnl).toFixed(2)}
            </div>
          </div>
          <div className="position-actions">
            <button className="position-action-btn add-position-btn" onClick={() => handleAddMorePosition(pos)}>+ Add More</button>
            <button 
              className="position-action-btn exit-position-btn" 
              onClick={() => handleExitPosition(pos)}
              disabled={exitingPosIds.current.has(pos.id)}
              style={{ opacity: exitingPosIds.current.has(pos.id) ? 0.5 : 1, cursor: exitingPosIds.current.has(pos.id) ? 'not-allowed' : 'pointer' }}
            >
              {exitingPosIds.current.has(pos.id) ? 'Exiting...' : 'Exit'}
            </button>
          </div>
        </div>
      );
    });
  };

  return (
    <div
      className={`tc-wrapper ${isPanelExpanded && !(isLandscape || isCssLandscape) ? 'panel-expanded' : ''}`}
      style={(isLandscape || isCssLandscape) ? {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: isCssLandscape ? '100dvh' : '100vw',
        height: isCssLandscape ? '100vw' : '100dvh',
        zIndex: 999999,
        borderRadius: 0,
        margin: 0,
        overflow: 'hidden',
        transform: isCssLandscape ? 'rotate(90deg) translateY(-100%)' : 'none',
        transformOrigin: isCssLandscape ? 'top left' : 'center',
        background: 'var(--container-bg, #FFFFFF)',
      } : undefined}
    >
      {/* Top Toolbar */}
      <div className="tc-top-toolbar" onMouseLeave={() => setOpenTopFlyout(null)}>
        {/* ── Back button ── */}
        <button
          className="tc-icon-btn"
          style={{ marginRight: '-6px' }}
          onClick={() => {
            const sheet = document.getElementById('chartSheet');
            const overlay = document.getElementById('chartSheetOverlay');
            if (sheet) sheet.classList.remove('open');
            if (overlay) overlay.classList.remove('active');
            setTimeout(() => {
              setIsCssLandscape(false);
            }, 350);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M10 3L5 8l5 5" />
          </svg>
        </button>

        {/* ── Symbol ── */}
        {isSearchActive ? (
          <ChartSearchOverlay
            starredInstruments={starredInstruments}
            toggleStar={toggleStar}
            onClose={() => setIsSearchActive(false)}
            onSelect={(res: any) => {
              // Reset all chart state for new symbol
              setHistoricalCandles([]);
              setCurrentPrice(0);
              setPriceChange(0);
              setPriceChangePct(0);
              setLoading(true);
              setError(null);
              hasLoadedData.current = false;

              // Reset order block
              setChainContract(null);
              setIsOrderBlockVisible(false);
              setIsPanelExpanded(false);
              setIsExitFlow(false);
              setIsAddMoreFlow(false);
              setExitPositionId(null);
              setActiveSegment('orders');

              // Set new symbol/segment — use binanceSymbol for crypto, kiteSymbol for others
              const isCryptoRes = !!res.binanceSymbol || (res.segment || '').toUpperCase().includes('CRYPTO');
              const newSymbol = isCryptoRes
                ? (res.binanceSymbol || res.kiteSymbol || res.symbol)
                : (res.kiteSymbol || res.symbol);
              const newSegment = isCryptoRes ? 'CRYPTO' : res.segment;
              setSymbol(newSymbol);
              setSegment(newSegment);
              setIsSearchActive(false);
              setOrderBlockTitle(newSymbol);
            }}
          />
        ) : (
          <div className="tc-symbol-btn" onClick={() => {
            setIsSearchActive(true);
            setTimeout(() => searchInputRef.current?.focus(), 100);
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px', opacity: 0.7 }}>
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <span className="tc-symbol-name">{formatShortName(symbol.replace(/NSE:|BSE:|NFO:|BFO:|MCX:/g, ''))}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{ opacity: 0.5 }}><path d="M2 3l3 4 3-4z" /></svg>
          </div>
        )}

        <div className="tc-divider"></div>

        {/* ── Interval flyout ── */}
        {(() => {
          const intervals: { label: string; tf: Timeframe }[] = [
            { label: '1m', tf: '1m' },
            { label: '2m', tf: '2m' },
            { label: '3m', tf: '3m' },
            { label: '5m', tf: '5m' },
            { label: '10m', tf: '10m' },
            { label: '15m', tf: '15m' },
            { label: '30m', tf: '30m' },
            { label: '1H', tf: '60m' },
            { label: 'D', tf: 'day' },
          ];
          const current = intervals.find(i => i.tf === timeframe) || intervals[1];
          return (
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <div
                className={`tc-tb-btn ${openTopFlyout === 'interval' ? 'tc-tb-btn-open' : ''}`}
                onMouseEnter={() => setOpenTopFlyout('interval')}
                onClick={() => setOpenTopFlyout(openTopFlyout === 'interval' ? null : 'interval')}
                title="Interval"
              >
                <span style={{ fontWeight: 700, fontSize: '13px' }}>{current.label}</span>
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M1 2l3 4 3-4z" /></svg>
              </div>
              
              {/* Native React Countdown - Bypasses TradingView entirely */}
              {(() => {
                if (timeframe === 'day') return null;
                const [timeLeft, setTimeLeft] = useState('');
                useEffect(() => {
                  const resMs = 
                    timeframe === '1m' ? 60000 : timeframe === '2m' ? 120000 : timeframe === '3m' ? 180000 :
                    timeframe === '5m' ? 300000 : timeframe === '10m' ? 600000 : timeframe === '15m' ? 900000 :
                    timeframe === '30m' ? 1800000 : timeframe === '60m' ? 3600000 : 0;
                  if (!resMs) return;
                  const interval = setInterval(() => {
                    const nowMs = Date.now();
                    // Anchor to 09:15 for non-crypto 60m candles if needed, but standard modulo works for all intraday
                    // The modulo handles the standard UTC epoch offsets perfectly for all timeframes <= 60m
                    const next = Math.ceil(nowMs / resMs) * resMs;
                    const diff = Math.max(0, next - nowMs);
                    const m = Math.floor(diff / 60000);
                    const s = Math.floor((diff % 60000) / 1000);
                    setTimeLeft(`${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
                  }, 1000);
                  return () => clearInterval(interval);
                }, [timeframe]);
                return timeLeft ? (
                  <div style={{ marginLeft: '4px', fontSize: '12px', fontWeight: 600, color: '#f23645' }}>
                    ({timeLeft})
                  </div>
                ) : null;
              })()}

              {openTopFlyout === 'interval' && (
                <div className="tc-top-flyout" style={{ minWidth: '110px' }}>
                  <div className="tc-flyout-title">Interval</div>
                  {intervals.map(i => (
                    <div
                      key={i.tf}
                      className={`tc-flyout-item ${timeframe === i.tf ? 'active' : ''}`}
                      onClick={() => { setTimeframe(i.tf); setOpenTopFlyout(null); }}
                    >
                      <span>{i.label}</span>
                      {timeframe === i.tf && <span className="tc-flyout-check">✓</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        <div className="tc-divider"></div>

        {/* ── Chart Type flyout ── */}
        {(() => {
          const types: { key: 'candle' | 'area' | 'bar' | 'baseline'; label: string; icon: React.ReactNode }[] = [
            { key: 'candle', label: 'Candles', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3" y="4" width="3" height="6" fill="currentColor" /><line x1="4.5" y1="1" x2="4.5" y2="4" /><line x1="4.5" y1="10" x2="4.5" y2="13" /><rect x="8" y="3" width="3" height="5" fill="none" /><line x1="9.5" y1="1" x2="9.5" y2="3" /><line x1="9.5" y1="8" x2="9.5" y2="13" /></svg> },
            { key: 'bar', label: 'Bars', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="4" y1="2" x2="4" y2="12" /><line x1="1" y1="5" x2="4" y2="5" /><line x1="4" y1="9" x2="7" y2="9" /><line x1="10" y1="3" x2="10" y2="11" /><line x1="7" y1="6" x2="10" y2="6" /><line x1="10" y1="8" x2="13" y2="8" /></svg> },
            { key: 'area', label: 'Area', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1 11 Q4 4 7 6 Q10 8 13 3" /><path d="M1 11 Q4 4 7 6 Q10 8 13 3 V11 Z" fill="currentColor" opacity="0.2" stroke="none" /></svg> },
            { key: 'baseline', label: 'Baseline', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><line x1="1" y1="7" x2="13" y2="7" strokeDasharray="2 1" /><path d="M1 7 Q4 3 7 5 Q10 7 13 4" /><path d="M1 7 Q4 11 7 9 Q10 7 13 10" /></svg> },
          ];
          const cur = types.find(t => t.key === chartType) || types[0];
          return (
            <div style={{ position: 'relative' }}>
              <div
                className={`tc-tb-btn ${openTopFlyout === 'charttype' ? 'tc-tb-btn-open' : ''}`}
                onMouseEnter={() => setOpenTopFlyout('charttype')}
                onClick={() => setOpenTopFlyout(openTopFlyout === 'charttype' ? null : 'charttype')}
                title="Chart Type"
              >
                {cur.icon}
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M1 2l3 4 3-4z" /></svg>
              </div>
              {openTopFlyout === 'charttype' && (
                <div className="tc-top-flyout" style={{ minWidth: '140px' }}>
                  <div className="tc-flyout-title">Chart Type</div>
                  {types.map(t => (
                    <div
                      key={t.key}
                      className={`tc-flyout-item ${chartType === t.key ? 'active' : ''}`}
                      onClick={() => {
                        setChartType(t.key);
                        setOpenTopFlyout(null);
                      }}
                    >
                      <span className="tc-flyout-icon">{t.icon}</span>
                      <span>{t.label}</span>
                      {chartType === t.key && <span className="tc-flyout-check">✓</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        <div className="tc-divider"></div>

        {/* ── Indicators ── */}
        <div
          className="tc-tb-btn tc-tb-indicators"
          title="Indicators"
          onClick={() => document.dispatchEvent(new CustomEvent('tv-show-indicators'))}
        >
          <span style={{ fontSize: '14px', fontWeight: 700, fontStyle: 'italic' }}>Fx</span>
        </div>

        <div className="tc-divider"></div>

        {/* ── Tools ── */}
        <div
          className="tc-tb-btn tc-tb-indicators"
          title="Drawing Tools"
          onClick={() => document.dispatchEvent(new CustomEvent('tv-toggle-drawings'))}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M11 2l-7 7-2 4 4-2 7-7-2-2z" />
          </svg>
        </div>

        {/* ── Compare ── HIDDEN */}
        {/* ── Snapshot ── HIDDEN */}
        
        <div className="tc-divider"></div>

        {/* ── Mobile Rotate Screen (Moved next to tools) ── */}
        <div className="tc-tb-icon mobile-only" title="Toggle Landscape Layout" onClick={() => setIsCssLandscape(!isCssLandscape)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: isCssLandscape ? 'rotate(-90deg)' : 'none', transition: 'transform 0.3s ease' }}>
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
            <line x1="12" y1="18" x2="12.01" y2="18"></line>
          </svg>
        </div>

        {/* ── Right side ── */}
        <div className="tc-top-right">

          {/* Settings */}
          <div className="tc-tb-icon" title="Chart Settings" onClick={() => showToast('Settings coming soon')} style={{ display: 'none' }}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="7.5" cy="7.5" r="2" />
              <path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M3 3l1.4 1.4M10.6 10.6L12 12M12 3l-1.4 1.4M4.4 10.6L3 12" />
            </svg>
          </div>

          {/* Fullscreen */}
          <div className="tc-tb-icon desktop-only" title="Fullscreen" onClick={() => {
            const el = document.getElementById('chartSheet');
            if (el) el.requestFullscreen?.();
          }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" />
            </svg>
          </div>
        </div>
      </div>

      {/* Content Split Container */}
      <div style={{ display: 'flex', flexDirection: (isLandscape || isCssLandscape) ? 'row' : 'column', flex: 1, overflow: 'hidden' }}>

        {/* Main Area */}
        <div className="tc-main-area" style={{ flex: 1, minWidth: 0, position: 'relative' }}>


          {/* Chart Container */}
          <div className="tc-chart-container" style={{ position: 'relative', overflow: 'hidden' }}>

            {/* Floating Rotate Screen Button removed and moved to header */}

            {/* Floating Order Panel Toggle */}
            {(isLandscape || isCssLandscape) && (
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  zIndex: 10,
                  width: '24px',
                  height: '56px',
                  background: 'var(--bg-card, #1E222D)',
                  border: '1px solid var(--border-color, #2B3139)',
                  borderRight: 'none',
                  borderRadius: '6px 0 0 6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  boxShadow: '-2px 0 12px rgba(0,0,0,0.2)',
                  color: 'var(--text-secondary, #787B86)',
                  transition: 'all 0.2s ease'
                }}
                onClick={() => setIsPanelExpanded(!isPanelExpanded)}
              >
                <i className={`ti ${isPanelExpanded ? 'ti-chevron-right' : 'ti-chevron-left'}`} style={{ fontSize: '18px' }}></i>
              </div>
            )}

            {/* BUY/price/SELL widget — HIDDEN */}

            <ChartContainer
              key={`${symbol}-${segment}`}
              symbol={symbol}
              segment={segment}
              timeframe={timeframe}
              chartType={chartType}
              candles={historicalCandles}
              liveQuote={activeLiveQuote}
              loading={loading}
              error={error}
            />
          </div>
        </div>

        <div
          style={(isLandscape || isCssLandscape) ? {
            width: isPanelExpanded ? '340px' : '0px',
            display: isPanelExpanded ? 'flex' : 'none',
            flexDirection: 'column',
            justifyContent: 'flex-start',
            borderLeft: '1px solid var(--border-color, #eaecef)',
            background: 'var(--surface, #FFFFFF)',
            zIndex: 10,
            flexShrink: 0,
            height: '100%',
            overflow: 'hidden'
          } : {
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            flexShrink: 0,
            zIndex: 10
          }}
        >

          {/* In landscape mode: push content to bottom ONLY if the info panel is collapsed */}
          {(isLandscape || isCssLandscape) && isInfoPanelCollapsed && <div style={{ flex: 1 }} />}

          {/* P&L Card */}
        {!isOrderBlockVisible && (
          <div className="pnl-card" id="pnlCard" style={(isLandscape || isCssLandscape) && !isInfoPanelCollapsed ? { display: 'none' } : {}}>
              {isTradeOnChartActive ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="pnl-toggle-btn" onClick={() => setIsBottomSectionVisible(!isBottomSectionVisible)} style={{ cursor: 'pointer' }}>
                      <i className={`ti ${isBottomSectionVisible ? 'ti-chevron-up' : 'ti-chevron-down'}`}></i>
                    </div>
                    <div>
                      <span className="pnl-text">P/L: </span>
                      <span className={`pnl-amount ${pnlTotal >= 0 ? 'positive' : 'negative'}`}>
                        {pnlTotal >= 0 ? '+' : ''}₹{pnlTotal.toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button className="trade-btn sell" onClick={() => showToast('Available soon')} style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'transparent', border: '1.5px solid var(--red, #e53935)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                      <span className="btn-label" style={{ color: 'var(--red, #e53935)', fontSize: '11px', fontWeight: 600 }}>SL</span>
                    </button>
                    <button className="trade-btn buy" onClick={() => showToast('Available soon')} style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'transparent', border: '1.5px solid var(--green, #1db954)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                      <span className="btn-label" style={{ color: 'var(--green, #1db954)', fontSize: '11px', fontWeight: 600 }}>TP</span>
                    </button>
                    <div className="pnl-toggle-btn" onClick={() => { setIsTradeOnChartActive(false); localStorage.setItem('isTradeOnChartActive', 'false'); }} style={{ background: 'var(--pill-bg, #1a2432)', color: 'var(--text-primary)', cursor: 'pointer', marginLeft: '4px' }}>
                      <i className="ti ti-x"></i>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <span className="pnl-text">P/L: </span>
                    <span className={`pnl-amount ${pnlTotal >= 0 ? 'positive' : 'negative'}`}>
                      {pnlTotal >= 0 ? '+' : ''}₹{pnlTotal.toFixed(2)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div
                      title="Scalp"
                      onClick={() => {
                        const nextState = !isTradeOnChartActive;
                        setIsTradeOnChartActive(nextState);
                        localStorage.setItem('isTradeOnChartActive', nextState.toString());
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '4px 14px',
                        borderRadius: '4px',
                        background: isTradeOnChartActive ? 'var(--green-bg, #e8f5e9)' : 'transparent',
                        color: 'var(--green, #1db954)',
                        cursor: 'pointer',
                        border: '1px solid var(--green, #1db954)',
                      }}
                    >
                      <span style={{ fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap' }}>Scalp</span>
                    </div>
                    <div className="pnl-toggle-btn" onClick={() => setIsBottomSectionVisible(!isBottomSectionVisible)} style={{ cursor: 'pointer' }}>
                      <i className={`ti ${isBottomSectionVisible ? 'ti-chevron-up' : 'ti-chevron-down'}`}></i>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Bottom Section */}
          <div
            className={`bottom-section ${(!isBottomSectionVisible && !(isLandscape || isCssLandscape)) ? 'collapsed' : ''}`}
            id="bottomSection"
            style={(isLandscape || isCssLandscape) ? { display: 'flex', flexDirection: 'column', flex: !isInfoPanelCollapsed ? 1 : undefined, minHeight: !isInfoPanelCollapsed ? 0 : undefined } : {}}
          >
            {/* Trade Buttons — show Exit when position exists for current symbol, else Buy/Sell */}
            {!isUnderlyingIndex && !isOrderBlockVisible && (
              currentInstrumentPosition ? (
                <div className="trade-buttons" id="tradeButtons" style={(isLandscape || isCssLandscape) && !isInfoPanelCollapsed ? { display: 'none' } : {}}>
                  {currentInstrumentPosition.side === 'BUY' ? (
                    <>
                      <button 
                        className="trade-btn exit-position-chart-btn" 
                        onClick={() => handleExitPosition(currentInstrumentPosition)}
                        disabled={exitingPosIds.current.has(currentInstrumentPosition.id)}
                        style={{ opacity: exitingPosIds.current.has(currentInstrumentPosition.id) ? 0.5 : 1 }}
                      >
                        <span className="btn-label">
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ marginRight: '6px', verticalAlign: 'middle' }}>
                            <path d="M10 1l3 3-3 3" /><path d="M13 4H5" /><path d="M7 13H2a1 1 0 01-1-1V2a1 1 0 011-1h5" />
                          </svg>
                          {exitingPosIds.current.has(currentInstrumentPosition.id) ? 'EXITING...' : 'EXIT LONG'}
                        </span>
                      </button>
                      <button id="buyButton" className="trade-btn buy" onClick={() => {
                        if (isTradeOnChartActive) {
                          handleQuickMarketOrder('BUY');
                        } else {
                          if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                          else setIsPanelExpanded(false);
                          setIsExitFlow(false);
                          setIsAddMoreFlow(false);
                          setExitPositionId(null);
                          setOrderBlockTitle(symbol);
                          setPostOrderSegment('main');
                          setIsOrderBlockVisible(true);
                          setOrderSide('BUY');
                        }
                      }}>
                        <span className="btn-label">BUY</span>
                      </button>
                    </>
                  ) : (
                    <>
                      <button id="sellButton" className="trade-btn sell" onClick={() => {
                        if (isTradeOnChartActive) {
                          handleQuickMarketOrder('SELL');
                        } else {
                          if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                          else setIsPanelExpanded(false);
                          setIsExitFlow(false);
                          setIsAddMoreFlow(false);
                          setExitPositionId(null);
                          setOrderBlockTitle(symbol);
                          setPostOrderSegment('main');
                          setIsOrderBlockVisible(true);
                          setOrderSide('SELL');
                        }
                      }}>
                        <span className="btn-label">SELL</span>
                      </button>
                      <button 
                        className="trade-btn exit-position-chart-btn" 
                        onClick={() => handleExitPosition(currentInstrumentPosition)}
                        disabled={exitingPosIds.current.has(currentInstrumentPosition.id)}
                        style={{ opacity: exitingPosIds.current.has(currentInstrumentPosition.id) ? 0.5 : 1 }}
                      >
                        <span className="btn-label">
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ marginRight: '6px', verticalAlign: 'middle' }}>
                            <path d="M10 1l3 3-3 3" /><path d="M13 4H5" /><path d="M7 13H2a1 1 0 01-1-1V2a1 1 0 011-1h5" />
                          </svg>
                          {exitingPosIds.current.has(currentInstrumentPosition.id) ? 'EXITING...' : 'EXIT SHORT'}
                        </span>
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className="trade-buttons" id="tradeButtons" style={(isLandscape || isCssLandscape) && !isInfoPanelCollapsed ? { display: 'none' } : {}}>
                  <button id="sellButton" className="trade-btn sell" onClick={() => {
                    if (isTradeOnChartActive) {
                      handleQuickMarketOrder('SELL');
                    } else {
                      if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                      else setIsPanelExpanded(false);
                      setIsExitFlow(false);
                      setIsAddMoreFlow(false);
                      setExitPositionId(null);
                      setOrderBlockTitle(symbol);
                      setPostOrderSegment('main');
                      setIsOrderBlockVisible(true);
                      setOrderSide('SELL');
                    }
                  }}>
                    <span className="btn-label">SELL</span>
                  </button>
                  <button id="buyButton" className="trade-btn buy" onClick={() => {
                    if (isTradeOnChartActive) {
                      handleQuickMarketOrder('BUY');
                    } else {
                      if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                      else setIsPanelExpanded(false);
                      setIsExitFlow(false);
                      setIsAddMoreFlow(false);
                      setExitPositionId(null);
                      setOrderBlockTitle(symbol);
                      setPostOrderSegment('main');
                      setIsOrderBlockVisible(true);
                      setOrderSide('BUY');
                    }
                  }}>
                    <span className="btn-label">BUY</span>
                  </button>
                </div>
              )
            )}

            {/* Order Block */}
            {isOrderBlockVisible && (
              <div className="order-block visible" id="orderBlock">
                <div className="order-block-header">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
                    <span className="order-block-title" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {(chainContract ? chainContract.name : orderBlockTitle).replace(/NFO[:\s]?/gi, '').trim()}
                    </span>
                    <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', marginTop: '2px' }}>
                      <span style={{
                        color: orderSide === 'BUY' ? '#1db954' : '#e53935',
                        background: 'transparent',
                        padding: '0',
                        fontWeight: '600',
                        fontSize: '11px'
                      }}>
                        {orderSide === 'BUY' ? 'Ask' : 'Bid'}: ₹{Number(orderSide === 'BUY' ? liveAsk : liveBid).toFixed(2)}
                      </span>
                      <span style={{ color: '#8b949e', fontSize: '11px', fontWeight: '500' }}>
                        LTP: <span style={{ color: 'var(--text-primary)', fontWeight: '700' }}>₹{Number(liveLTP).toFixed(2)}</span>
                      </span>
                      {chainContract && chainContract.expiry && (
                        <span style={{ background: '#F0F2F5', color: '#8B92A8', padding: '1px 5px', borderRadius: '4px', fontSize: '10px', whiteSpace: 'nowrap' }}>
                          {chainContract.expiry}
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <div
                      style={{ marginRight: '8px', cursor: 'pointer', background: 'var(--pill-bg, #1a2432)', width: '26px', height: '26px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--green, #1db954)', border: '1.2px solid var(--green, #1db954)' }}
                      onClick={() => {
                        const targetSymbol = chainContract ? chainContract.name : orderBlockTitle.replace(/Add More · |Exit · |Modify · /g, '').trim();
                        
                        // For exit/add-more flows on options and futures, ensure kite instrument has prefix
                        // Use the stored addMoreKiteInst if available, else derive from orderBlockTitle/chain
                        const baseKiteInst = (isAddMoreFlow || isExitFlow) && addMoreKiteInst 
                          ? addMoreKiteInst 
                          : (chainContract ? chainContract.name : ((isAddMoreFlow || isExitFlow || modifyOrderId) ? targetSymbol : symbol));
                          
                        let kiteInstForOrder = baseKiteInst;
                        
                        if (['OPTIDX', 'FUTIDX', 'OPTSTK', 'FUTSTK', 'OPTCOM', 'FUTCOM', 'OPTCUR', 'FUTCUR'].includes(dbSeg)) {
                          kiteInstForOrder = isMcx ? `MCX:${baseKiteInst}` : `NFO:${baseKiteInst}`;
                        }
                        
                        setSymbol(targetSymbol);
                        // Derive the correct display segment so mapSegmentToDbSegment works
                        if (chainContract) {
                          const n = chainContract.name.toUpperCase();
                          const isBse = n.includes('SENSEX') || n.includes('BANKEX');
                          const isMcx = ['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD'].some(c => n.includes(c));
                          if (isMcx) {
                            setSegment('MCX - Options');
                          } else if (isBse) {
                            setSegment('BSE - Options');
                          } else {
                            setSegment('NSE - Options');
                          }
                        } else if (targetSymbol.includes('CE') || targetSymbol.includes('PE')) {
                          setSegment('NSE - Options');
                        }
                        setIsPanelExpanded(false);
                        setIsOrderBlockVisible(false);
                        setChainContract(null);
                      }}
                      title="Open Chart"
                    >
                      <svg viewBox="0 0 24 24" style={{ width: '16px', height: '16px', display: 'block' }}>
                        <rect x="4" y="16" width="2.5" height="4" rx="0.5" fill="currentColor" />
                        <rect x="9" y="13" width="2.5" height="7" rx="0.5" fill="currentColor" />
                        <rect x="14" y="14" width="2.5" height="6" rx="0.5" fill="currentColor" />
                        <rect x="19" y="11" width="2.5" height="9" rx="0.5" fill="currentColor" />
                        <path d="M 4 14 L 8 9 L 13 12 L 20 4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                        <polyline points="15 4 20 4 20 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>

                    <div className="close-order-block" onClick={() => {
                      setIsOrderBlockVisible(false);
                      setChainContract(null);
                      if (isExitFlow || isAddMoreFlow) setIsPanelExpanded(true);
                      setIsExitFlow(false);
                      setIsAddMoreFlow(false);
                      setExitPositionId(null);
                      setOrderBlockTitle(symbol);
                    }}>
                      <i className="ti ti-x"></i>
                    </div>
                  </div>
                </div>
                <div className="order-block-content">
                  {chainContract && (
                    <div id="chainBSToggle" style={{ display: 'flex', gap: '6px', padding: '0 0 8px' }}>
                      <button
                        onClick={() => {
                          setOrderSide('SELL');
                          const bid = chainContract.bid;
                          setLimitPrice(bid.toFixed(2));
                          setTriggerPrice(bid.toFixed(2));
                        }}
                        style={{
                          flex: 1, padding: '8px', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: '600', cursor: 'pointer', transition: 'all .2s', fontFamily: 'Inter,sans-serif', letterSpacing: '0.4px',
                          background: orderSide === 'SELL' ? '#e53935' : '#F0F2F5', color: orderSide === 'SELL' ? '#fff' : '#8B92A8'
                        }}
                      >
                        SELL
                      </button>
                      <button
                        onClick={() => {
                          setOrderSide('BUY');
                          const ask = chainContract.ask;
                          setLimitPrice(ask.toFixed(2));
                          setTriggerPrice(ask.toFixed(2));
                        }}
                        style={{
                          flex: 1, padding: '8px', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: '600', cursor: 'pointer', transition: 'all .2s', fontFamily: 'Inter,sans-serif', letterSpacing: '0.4px',
                          background: orderSide === 'BUY' ? '#1db954' : '#F0F2F5', color: orderSide === 'BUY' ? '#fff' : '#8B92A8'
                        }}
                      >
                        BUY
                      </button>
                    </div>
                  )}

                  {/* chainContractDetail moved to header */}

                  <div className="top-row">
                    <div className="quantity-box">
                      <div className="qty-controls">
                        <button className="qty-btn" onClick={() => handleQtyStep(-1)}>−</button>
                        <input
                          type="number"
                          className="qty-value"
                          value={qtyValue}
                          step={useLots ? 0.5 : lotSize}
                          min={useLots ? 0.5 : lotSize}
                          onChange={(e) => {
                            setQtyValue(e.target.value);
                          }}
                          onBlur={() => {
                            const val = parseFloat(String(qtyValue));
                            if (useLots) {
                              setQtyValue(isNaN(val) || val <= 0 ? 0.5 : val);
                            } else {
                              const minVal = isCrypto ? 0.01 : lotSize;
                              setQtyValue(isNaN(val) || val <= 0 ? minVal : val);
                            }
                          }}
                        />
                        <button className="qty-btn" onClick={() => handleQtyStep(1)}>+</button>
                      </div>
                      <div className="unit-toggle" id="unitSwitch">
                        <div className={`unit-btn ${!useLots ? 'active' : ''}`} onClick={() => handleUnitChange(false)}>Qty</div>
                        <div className={`unit-btn ${useLots ? 'active' : ''}`} onClick={() => handleUnitChange(true)}>Lot</div>
                      </div>
                    </div>
                    <div className="carry-box" id="carryGroup">
                      <div className={`carry-option ${orderCarry === 'normal' ? 'active' : ''}`} onClick={() => setOrderCarry('normal')}>Intraday</div>
                      <div className={`carry-option ${orderCarry === 'carry' ? 'active' : ''}`} onClick={() => setOrderCarry('carry')}>Carry</div>
                    </div>
                  </div>

                  <div className="bottom-row">
                    <div className="market-limit-box" id="orderTypeGroup" style={{ flex: 6 }}>
                      <div className={`market-option ${orderType === 'market' ? 'active' : ''}`} onClick={() => setOrderType('market')}>Mkt</div>
                      <div className={`market-option ${orderType === 'limit' ? 'active' : ''}`} onClick={() => setOrderType('limit')}>{isExitFlow ? 'Tgt' : 'Lmt'}</div>
                      {!isExitFlow && <div className={`market-option ${orderType === 'slm' ? 'active' : ''}`} onClick={() => setOrderType('slm')}>SLM</div>}
                      {isExitFlow && <div className={`market-option ${orderType === 'sl' ? 'active' : ''}`} onClick={() => setOrderType('sl')}>SL</div>}
                      <div className={`market-option ${orderType === 'gtt' ? 'active' : ''}`} onClick={() => setOrderType('gtt')}>GTT</div>
                    </div>
                    {(orderType === 'limit' || (orderType === 'gtt' && !isExitFlow)) && (
                      <div className="limit-price-box visible" id="limitPriceBox" style={{ flex: 4 }}>
                        <span className="price-symbol">₹</span>
                        <input
                          type="number"
                          step="0.05"
                          value={limitPrice}
                          onChange={(e) => setLimitPrice(e.target.value)}
                          placeholder="price"
                        />
                      </div>
                    )}
                    {(orderType === 'sl' || orderType === 'slm') && (
                      <div className="limit-price-box visible" id="triggerPriceBox" style={{ flex: 4 }}>
                        <span className="price-symbol" style={{ fontSize: '9px', color: '#8B92A8', fontWeight: 'bold', letterSpacing: '.3px', whiteSpace: 'nowrap' }}>Trigger ₹</span>
                        <input
                          type="number"
                          step="0.05"
                          value={triggerPrice}
                          onChange={(e) => setTriggerPrice(e.target.value)}
                          placeholder="trigger"
                        />
                      </div>
                    )}
                  </div>

                  {orderType === 'gtt' && (
                    <div className="gtt-row visible">
                      <div className="gtt-field sl-field">
                        <span className="gtt-tag">SL ₹</span>
                        <input
                          type="number"
                          step="0.05"
                          value={gttSlPrice}
                          onChange={(e) => setGttSlPrice(e.target.value)}
                          placeholder="Optional"
                        />
                      </div>
                      <div className="gtt-field tgt-field">
                        <span className="gtt-tag">Target ₹</span>
                        <input
                          type="number"
                          step="0.05"
                          value={gttTargetPrice}
                          onChange={(e) => setGttTargetPrice(e.target.value)}
                          placeholder="Optional"
                        />
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '0 4px', marginBottom: '8px' }}>
                    <span style={{ color: '#8b949e', fontWeight: 500 }}>Free Margin: <span style={{ color: 'var(--text-primary, #000)', fontWeight: 800 }}>₹{balance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span></span>
                    <span style={{ color: '#8b949e', fontWeight: 500 }}>Required Margin: <span className={`${reqMargin > balance ? 'negative' : ''}`} style={{ color: 'var(--text-primary, #000)', fontWeight: 800 }}>₹{reqMargin.toLocaleString('en-IN')}</span></span>
                  </div>
                  <div className="order-margin-simple" style={{ flexDirection: 'column', gap: '0', alignItems: 'stretch', background: 'var(--pill-bg, rgba(139, 148, 158, 0.1))', border: 'none', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px' }}>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        width: '100%',
                        boxSizing: 'border-box'
                      }}
                    >
                      <div
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
                        onClick={() => setShowCharges(!showCharges)}
                      >
                        <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>
                          Charges Breakdown {showCharges ? '▲' : '▼'}
                        </span>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--green)' }}>
                          ₹{totalBrokerage.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                      {showCharges && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '2px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px' }}>
                            <span style={{ color: 'var(--text-muted)' }}>Intraday Brokerage</span>
                            <span style={{ color: 'var(--green)', fontWeight: 700 }}>
                              ₹{intradayCharge.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px' }}>
                            <span style={{ color: 'var(--text-muted)' }}>Carry Charges</span>
                            <span style={{ color: (orderCarry === 'carry' || orderType === 'gtt') ? 'var(--green)' : 'var(--text-muted)', fontWeight: 700 }}>
                              ₹{(orderCarry === 'carry' || orderType === 'gtt' ? carryCharge : 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px' }}>
                            <span style={{ color: 'var(--text-muted)' }}>GTT Charges</span>
                            <span style={{ color: orderType === 'gtt' ? 'var(--green)' : 'var(--text-muted)', fontWeight: 700 }}>
                              ₹{(orderType === 'gtt' ? gttCharge : 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <button
                    className={`submit-btn ${orderSide === 'BUY' ? 'submit-buy' : 'submit-sell'}`}
                    onClick={handleSubmitOrder}
                  >
                    {modifyOrderId ? 'Update Order' : `${orderSide} ${useLots ? `${qtyValue} Lot` : `${qtyValue} Qty`}`}
                  </button>
                </div>
              </div>
            )}

            {/* Segment Row */}
            <div className="segment-row">
              <div className="segment-pills">
                <button className={`segment-pill ${activeSegment === 'chain' ? 'active' : ''}`} onClick={() => {
                  if (activeSegment === 'chain') {
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                    else if (isPanelExpanded) setIsPanelExpanded(false);
                  } else {
                    setActiveSegment('chain');
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(false);
                    else setIsPanelExpanded(true);
                    setIsOrderBlockVisible(false);
                  }
                }}>
                  <i className="ti ti-stack-2"></i>Chain
                </button>
                <button className={`segment-pill ${activeSegment === 'orders' ? 'active' : ''}`} onClick={() => {
                  if (activeSegment === 'orders') {
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                    else if (isPanelExpanded) setIsPanelExpanded(false);
                  } else {
                    setActiveSegment('orders');
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(false);
                    else setIsPanelExpanded(true);
                    setIsOrderBlockVisible(false);
                  }
                }}>
                  <i className="ti ti-list-check"></i>Orders
                </button>
                <button className={`segment-pill ${activeSegment === 'positions' ? 'active' : ''}`} onClick={() => {
                  if (activeSegment === 'positions') {
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(true);
                    else if (isPanelExpanded) setIsPanelExpanded(false);
                  } else {
                    setActiveSegment('positions');
                    if (isLandscape || isCssLandscape) setIsInfoPanelCollapsed(false);
                    else setIsPanelExpanded(true);
                    setIsOrderBlockVisible(false);
                  }
                }}>
                  <i className="ti ti-briefcase"></i>Positions
                </button>
              </div>
              <div className="toggle-panel-btn" onClick={() => {
                if (isLandscape || isCssLandscape) {
                  setIsInfoPanelCollapsed(!isInfoPanelCollapsed);
                } else {
                  setIsPanelExpanded(!isPanelExpanded);
                  if (!isPanelExpanded) setIsOrderBlockVisible(false);
                }
              }}>
                <i className={`ti ${((isLandscape || isCssLandscape) ? !isInfoPanelCollapsed : isPanelExpanded) ? 'ti-chevron-up' : 'ti-chevron-down'}`}></i>
              </div>
            </div>

            <div
              className={`info-panel ${(!isPanelExpanded && !(isLandscape || isCssLandscape)) ? 'collapsed' : ''}`}
              id="infoPanel"
              style={(isLandscape || isCssLandscape) ? { display: isInfoPanelCollapsed ? 'none' : 'flex', flexDirection: 'column', width: '100%', flex: 1, minHeight: 0 } : {}}
            >
              <div
                className={`panel-content ${activeSegment === 'chain' ? 'chain-mode' : ''}`}
                style={(isLandscape || isCssLandscape) ? { flex: 1, minHeight: 0, maxHeight: 'none' } : {}}
              >
                {renderPanelContent()}
              </div>
            </div>
          </div>
        </div>
        {/* End of Right / Bottom Panel Area */}
      </div>
      {/* End of Content Split Container */}
      {toast.visible && (
        <div className={`toast-message toast-show ${toast.isError ? 'neg' : ''}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

