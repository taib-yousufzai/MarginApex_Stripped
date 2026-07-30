'use client';
import React, { useState, useEffect, useRef } from 'react';
import { WatchlistItem, TabLabel, getTabForItem, getDefaultWatchlistItems } from '@/app/watchlist/page';
import AnimatedLoader from '@/components/AnimatedLoader';

interface WatchlistSearchProps {
  activeTab: TabLabel;
  addedSymbols?: Set<string>;
  onAdd: (item: WatchlistItem) => void;
  onRemove?: (item: WatchlistItem) => void;
  token?: string;
}

export default function WatchlistSearch({ activeTab, addedSymbols, onAdd, onRemove, token }: WatchlistSearchProps) {
  const localScripts = getDefaultWatchlistItems();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WatchlistItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Normalization: trim and collapse spaces
  const normalizedQuery = query.replace(/\s+/g, ' ').trim();

  // Handle clicking outside to close
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        const target = event.target as Element;
        if (target && target.closest('.seg-tab-bar')) {
          return; // Don't close if clicking a segment tab
        }
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const fetchLiveResults = async (q: string, tab: string, signal: AbortSignal) => {
    try {
      const res = await fetch(`/api/market/instruments/search?q=${encodeURIComponent(q)}&tab=${encodeURIComponent(tab)}`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        signal
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error('Search API error:', err);
      return [];
    }
  };

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

  // Effect to perform the search
  useEffect(() => {
    if (!isOpen) return;

    setIsSearching(true);
    const abortController = new AbortController();
    
    // Debounce timer
    const timer = setTimeout(async () => {
      // If query is empty, use the default for the active tab (like Script Management)
      const actualQuery = normalizedQuery.length >= 2 ? normalizedQuery : (SEGMENT_DEFAULTS[activeTab] || 'NIFTY');
      const qLower = actualQuery.toLowerCase();
      
      // 1. Filter local scripts first for immediate results (e.g. Crypto/Forex/Indexes)
      const localMatches = localScripts.filter(s => {
        const match = wordStartMatch(s.name, qLower) || wordStartMatch(s.symbol, qLower);
        if (!match) return false;
        if (activeTab === 'All') return true;
        return getTabForItem(s) === activeTab;
      });

      // 2. Fetch live results from API
      const liveMatches = await fetchLiveResults(actualQuery, activeTab, abortController.signal);
      
      // 3. Merge and deduplicate
      const merged = [...liveMatches];
      const liveSymbols = new Set(liveMatches.map((r: any) => r.symbol));
      
      for (const local of localMatches) {
        if (!liveSymbols.has(local.symbol)) {
          merged.push(local);
          liveSymbols.add(local.symbol);
        }
      }

      setResults(merged);
      setIsSearching(false);
    }, 300);

    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [normalizedQuery, activeTab, token, isOpen]);

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setIsOpen(false);
  };

  const isAdded = (symbol: string) => {
    return addedSymbols ? addedSymbols.has(symbol) : false;
  };

  const handleToggleClick = (item: WatchlistItem) => {
    if (isAdded(item.symbol)) {
      if (onRemove) onRemove(item);
    } else {
      onAdd(item);
    }
  };

  return (
    <div className={`search-wrapper ${query ? 'has-text' : ''}`} ref={searchContainerRef} style={{ position: 'relative', width: '100%' }}>
      <svg className="search-icon" width="18" height="18" viewBox="0 0 16 16" fill="none">
        <path d="M7.33333 12.6667C10.2789 12.6667 12.6667 10.2789 12.6667 7.33333C12.6667 4.38781 10.2789 2 7.33333 2C4.38781 2 2 4.38781 2 7.33333C2 10.2789 4.38781 12.6667 7.33333 12.6667Z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M14 14.0001L11.1 11.1001" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <input 
        className="search-input"
        placeholder="Search instruments…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!isOpen) setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        autoComplete="off"
      />

      <button 
        className="clear-search-btn"
        onClick={handleClear}
        aria-label="Clear search"
        style={{ opacity: query ? 1 : 0.35 }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* Results Overlay */}
      {isOpen && (
        <div className="search-results-section" style={{ display: 'flex', flexDirection: 'column', position: 'absolute', top: 'calc(100% + 12px)', left: '-16px', right: '-16px', bottom: 'auto', height: 'calc(100vh - 130px)', zIndex: 1000, marginTop: 0, maxHeight: 'none', overflowY: 'hidden', boxShadow: 'none', border: 'none', borderRadius: 0, background: '#FFFFFF' }}>
          <div className="section-subtitle" style={{ padding: '12px 16px', margin: 0, borderBottom: '1px solid #EFF2F8', display: 'flex', justifyContent: 'space-between', flexShrink: 0 }}>
            <span><i className="fas fa-search"></i> SEARCH RESULTS</span>
            <span id="searchResultCount" style={{ color: '#8F9BB3', display: 'flex', alignItems: 'center', gap: '8px' }}>
              {isSearching ? <AnimatedLoader size="small" text="SEARCHING..." /> : `${results.length} MATCHES`}
            </span>
          </div>
          <div id="searchResultsList" style={{ paddingBottom: '8px', flex: 1, overflowY: 'auto' }}>
            {results.length === 0 && !isSearching && (
              <div className="no-results">
                No instruments found for "{normalizedQuery}"
              </div>
            )}
            {results.map((r, i) => (
              <div key={`${r.kiteSymbol || r.symbol}-${i}`} className="search-result-item" onClick={() => handleToggleClick(r)} style={{ cursor: 'pointer', transition: 'background 0.2s', padding: '12px 16px' }} onMouseEnter={(e) => e.currentTarget.style.background = '#F8F9FC'} onMouseLeave={(e) => e.currentTarget.style.background = '#FFFFFF'}>
                <div className="sri-left">
                  <div className="sri-name">{r.name || r.symbol}</div>
                  <div className="sri-symbol">
                    {r.segment} {r.contractDate ? `• ${r.contractDate}` : ''}
                  </div>
                </div>
                <div className="sri-right" style={{ display: 'flex', alignItems: 'center' }}>
                  <div className="search-result-price">{(r.price ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                  <button 
                    className="add-smart-btn"
                    onClick={(e) => { e.stopPropagation(); handleToggleClick(r); }}
                    style={isAdded(r.symbol) ? { background: '#2C8E5A', color: 'white', border: 'none' } : undefined}
                  >
                    {isAdded(r.symbol) ? 'ADDED' : 'ADD'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
