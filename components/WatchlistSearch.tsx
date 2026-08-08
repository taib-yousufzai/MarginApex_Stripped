'use client';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { WatchlistItem, TabLabel, getTabForItem, getDefaultWatchlistItems } from '@/app/watchlist/page';
import AnimatedLoader from '@/components/AnimatedLoader';
import { api } from '@/lib/api';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';

interface WatchlistSearchProps {
  activeTab: TabLabel;
  addedSymbols?: Set<string>;
  onAdd: (item: WatchlistItem) => void;
  onRemove?: (item: WatchlistItem) => void;
  token?: string;
}

// Map a watchlist item to an option chain root symbol (null if not eligible)
function getOcSymbol(item: WatchlistItem): string | null {
  const seg = (item.segment || '').toLowerCase();
  if (!seg.includes('future') && !seg.includes('option') && !seg.includes('fut') && !seg.includes('opt')) return null;

  const name = (item.name || item.symbol || '').toUpperCase().replace(/\s+/g, '');
  // MCX commodities
  if (name.includes('GOLD')) return 'GOLD';
  if (name.includes('SILVER')) return 'SILVER';
  if (name.includes('CRUDEOIL') || name.includes('CRUDE')) return 'CRUDEOIL';
  if (name.includes('NATURALGAS') || name.includes('NATGAS')) return 'NATURALGAS';
  // Indices
  if (name.includes('BANKNIFTY') || name.includes('BANKN')) return 'BANKNIFTY';
  if (name.includes('FINNIFTY')) return 'FINNIFTY';
  if (name.includes('MIDCAP') || name.includes('MIDCP')) return 'MIDCPNIFTY';
  if (name.includes('SENSEX')) return 'SENSEX';
  if (name.includes('BANKEX')) return 'BANKEX';
  if (name.includes('NIFTY')) return 'NIFTY';
  return null;
}

interface OcData {
  strikes: any[];
  expiry: string;
  expiries: string[];
  underlyingPrice: number;
  underlyingSymbol?: string;
}

// ── Inline Option Chain Panel ─────────────────────────────────────────────────
function InlineOptionChain({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const [data, setData] = useState<OcData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null);
  const [priceMode, setPriceMode] = useState<'BA' | 'LTP'>('BA');
  const atmRowRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // Fetch option chain when symbol or expiry changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const url = `/api/market/option-chain?symbol=${encodeURIComponent(symbol)}${selectedExpiry ? `&expiry=${selectedExpiry}` : ''}&_t=${Date.now()}`;
    api.get<any>(url)
      .then(json => {
        if (cancelled) return;
        if (json.success) {
          setData(json);
          if (!selectedExpiry && json.expiry) setSelectedExpiry(json.expiry);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, selectedExpiry]);

  // Subscribe to live quotes
  const instrumentIds = React.useMemo(() => {
    if (!data) return [];
    const ids: string[] = data.underlyingSymbol ? [data.underlyingSymbol] : [];
    data.strikes.forEach((s: any) => {
      if (s.ce?.id) ids.push(s.ce.id);
      if (s.pe?.id) ids.push(s.pe.id);
    });
    return ids;
  }, [data]);

  const { quotes } = useMarketQuotes(instrumentIds);

  // Derive spot price from live quotes or API value
  const spotPrice = React.useMemo(() => {
    if (data?.underlyingSymbol) {
      const sym = data.underlyingSymbol;
      const q = quotes[sym] || quotes[(sym.split(':').pop() || sym)];
      if (q?.lastPrice && q.lastPrice > 0) return q.lastPrice;
    }
    return data?.underlyingPrice || 0;
  }, [quotes, data]);

  const getQuote = useCallback((id?: string, token?: number) => {
    if (!id && !token) return null;
    if (id && quotes[id]) return quotes[id];
    if (token && quotes[String(token)]) return quotes[String(token)];
    if (id) {
      const sym = id.split(':').pop();
      if (sym && quotes[sym]) return quotes[sym];
    }
    return null;
  }, [quotes]);

  const atmIndex = React.useMemo(() => {
    if (!data || spotPrice <= 0) return -1;
    let best = 0, minDiff = Infinity;
    data.strikes.forEach((s: any, i: number) => {
      const d = Math.abs(s.strike - spotPrice);
      if (d < minDiff) { minDiff = d; best = i; }
    });
    return best;
  }, [data, spotPrice]);

  // Scroll ATM row to center when data loads
  useEffect(() => {
    if (!atmRowRef.current || !tableRef.current) return;
    const container = tableRef.current;
    const el = atmRowRef.current;
    const t = setTimeout(() => {
      const top = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
      container.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    }, 80);
    return () => clearTimeout(t);
  }, [atmIndex, loading]);

  const fmt1 = (v: number | null | undefined) => (v && v > 0) ? v.toFixed(1) : '---';

  return (
    <div style={{ background: '#fff', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>

      {/* Panel header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #EFF2F8', flexShrink: 0, background: '#FAFBFE' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={onClose} style={{ background: '#F0F2F5', border: 'none', borderRadius: '50%', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, color: '#4B5563' }}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3L9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          </button>
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#C62E2E', letterSpacing: '-0.3px' }}>{symbol}</div>
            <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#15803D', background: '#E9F6EF', padding: '1px 7px', borderRadius: 20, display: 'inline-block', letterSpacing: 0.3 }}>OPTION CHAIN</div>
          </div>
          {spotPrice > 0 && (
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#1A1A1A', background: '#F0F2F5', padding: '3px 10px', borderRadius: 20 }}>
              &#8377;{spotPrice.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          )}
        </div>
        {/* B/A | LTP toggle */}
        <div style={{ display: 'flex', background: '#F0F2F5', borderRadius: 30, padding: 2, gap: 2, border: '1px solid #E8EAF0' }}>
          {(['BA', 'LTP'] as const).map(m => (
            <button key={m} onClick={() => setPriceMode(m)} style={{ padding: '3px 10px', borderRadius: 30, fontSize: '0.65rem', fontWeight: 800, border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: priceMode === m ? '#C62E2E' : 'transparent', color: priceMode === m ? '#fff' : '#6B7280', transition: 'all 0.15s' }}>
              {m === 'BA' ? 'B/A' : 'LTP'}
            </button>
          ))}
        </div>
      </div>

      {/* Expiry tabs */}
      {data?.expiries && data.expiries.length > 0 && (
        <div style={{ display: 'flex', overflowX: 'auto', padding: '6px 14px', gap: 6, borderBottom: '1px solid #EFF2F8', flexShrink: 0, scrollbarWidth: 'none' }}>
          {data.expiries.map(exp => {
            const [y, m, d] = exp.split('-').map(Number);
            const label = `${d} ${new Date(y, m - 1, d).toLocaleDateString('en-IN', { month: 'short' })} ${String(y).slice(2)}`;
            return (
              <button key={exp} onClick={() => setSelectedExpiry(exp)} style={{ flexShrink: 0, padding: '3px 12px', borderRadius: 30, fontSize: '0.65rem', fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', background: selectedExpiry === exp ? '#C62E2E' : '#F0F2F5', color: selectedExpiry === exp ? '#fff' : '#4B5563', transition: 'all 0.15s' }}>
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 0', flex: 1 }}>
          <AnimatedLoader size="small" text="Loading strikes..." />
        </div>
      ) : !data || data.strikes.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 16px', color: '#9CA3AF', fontSize: '0.8rem', flex: 1 }}>
          No strikes found for {symbol}
        </div>
      ) : (
        <>
          {/* Column headers — sticky */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 1fr', flexShrink: 0, fontSize: '0.6rem', fontWeight: 800, letterSpacing: 0.5, position: 'sticky', top: 0, zIndex: 2 }}>
            <div style={{ background: '#EDF7F0', textAlign: 'center', padding: '7px 0' }}>{priceMode === 'BA' ? 'CALLS (BID / ASK)' : 'CALL LTP'}</div>
            <div style={{ background: '#FEFBE8', textAlign: 'center', padding: '7px 0' }}>STRIKE</div>
            <div style={{ background: '#FFF0EB', textAlign: 'center', padding: '7px 0' }}>{priceMode === 'BA' ? 'PUTS (BID / ASK)' : 'PUT LTP'}</div>
          </div>

          {/* Strike rows */}
          <div ref={tableRef} style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
            {data.strikes.map((s: any, idx: number) => {
              const ceQ = getQuote(s.ce?.id, s.ce?.token);
              const peQ = getQuote(s.pe?.id, s.pe?.token);
              const isAtm = idx === atmIndex;

              const ceLtp = (ceQ?.lastPrice || s.ce?.price) ?? 0;
              const peLtp = (peQ?.lastPrice || s.pe?.price) ?? 0;

              const ceBid = (ceQ?.bid && ceQ.bid > 0) ? ceQ.bid : (ceLtp ? ceLtp * 0.9995 : null);
              const ceAsk = (ceQ?.ask && ceQ.ask > 0) ? ceQ.ask : (ceLtp ? ceLtp * 1.0005 : null);
              const peBid = (peQ?.bid && peQ.bid > 0) ? peQ.bid : (peLtp ? peLtp * 0.9995 : null);
              const peAsk = (peQ?.ask && peQ.ask > 0) ? peQ.ask : (peLtp ? peLtp * 1.0005 : null);

              return (
                <div
                  key={s.strike}
                  ref={isAtm ? atmRowRef : null}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr 80px 1fr',
                    borderTop: isAtm ? '2px solid rgba(198,46,46,0.4)' : undefined,
                    borderBottom: isAtm ? '2px solid rgba(198,46,46,0.4)' : '1px solid #F3F4F6',
                  }}
                >
                  {/* CE cell */}
                  <div style={{ background: isAtm ? '#F0FBF2' : '#F8FBF8', display: 'flex', justifyContent: priceMode === 'BA' ? 'space-around' : 'center', alignItems: 'center', padding: '9px 6px' }}>
                    {priceMode === 'BA' ? (
                      <>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#155724', fontFamily: 'Inter,sans-serif' }}>{fmt1(ceBid)}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#1e293b', fontFamily: 'Inter,sans-serif' }}>{fmt1(ceAsk)}</span>
                      </>
                    ) : (
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#155724', fontFamily: 'Inter,sans-serif' }}>{ceLtp ? `\u20b9${ceLtp.toFixed(1)}` : '---'}</span>
                    )}
                  </div>

                  {/* Strike cell */}
                  <div style={{ background: isAtm ? '#FFF4F4' : '#FEFEF8', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '9px 2px' }}>
                    <span style={{ fontSize: 12, fontWeight: isAtm ? 900 : 700, color: '#C62E2E', fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap' }}>
                      {s.strike.toLocaleString('en-IN')}
                    </span>
                  </div>

                  {/* PE cell */}
                  <div style={{ background: isAtm ? '#FFF6F3' : '#FBF8F8', display: 'flex', justifyContent: priceMode === 'BA' ? 'space-around' : 'center', alignItems: 'center', padding: '9px 6px' }}>
                    {priceMode === 'BA' ? (
                      <>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#7f1d1d', fontFamily: 'Inter,sans-serif' }}>{fmt1(peBid)}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#1e293b', fontFamily: 'Inter,sans-serif' }}>{fmt1(peAsk)}</span>
                      </>
                    ) : (
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#7f1d1d', fontFamily: 'Inter,sans-serif' }}>{peLtp ? `\u20b9${peLtp.toFixed(1)}` : '---'}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Main WatchlistSearch ──────────────────────────────────────────────────────
export default function WatchlistSearch({ activeTab, addedSymbols, onAdd, onRemove, token }: WatchlistSearchProps) {
  const localScripts = getDefaultWatchlistItems();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WatchlistItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [expandedOcSymbol, setExpandedOcSymbol] = useState<string | null>(null);

  const searchContainerRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.replace(/\s+/g, ' ').trim();

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        const target = event.target as Element;
        if (target && target.closest('.seg-tab-bar')) return;
        setIsOpen(false);
        setExpandedOcSymbol(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchLiveResults = async (q: string, tab: string, signal: AbortSignal) => {
    try {
      const data = await api.get<WatchlistItem[]>(
        `/api/market/instruments/search?q=${encodeURIComponent(q)}&tab=${encodeURIComponent(tab)}`,
        { signal }
      );
      return Array.isArray(data) ? data : [];
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error('Search API error:', err);
      return [];
    }
  };

  function wordStartMatch(text: string, term: string): boolean {
    if (!text) return false;
    const t = text.toLowerCase(), q = term.toLowerCase();
    if (t.startsWith(q)) return true;
    return t.split(/[\s\-_\/]/).some(w => w.startsWith(q));
  }

  const SEGMENT_DEFAULTS: Record<string, string> = {
    'INDEX-FUT': 'NIFTY', 'INDEX-OPT': 'NIFTY',
    'STOCK-FUT': 'RELIANCE', 'STOCK-OPT': 'RELIANCE',
    'NSE-EQ': 'RELIANCE', 'MCX-FUT': 'GOLD', 'MCX-OPT': 'GOLD',
    'COMEX': 'GOLD', 'CRYPTO': 'BTC', 'FOREX': 'USDINR',
  };

  useEffect(() => {
    if (!isOpen) return;
    setIsSearching(true);
    const abortController = new AbortController();
    const timer = setTimeout(async () => {
      const actualQuery = normalizedQuery.length >= 2 ? normalizedQuery : (SEGMENT_DEFAULTS[activeTab] || 'NIFTY');
      const qLower = actualQuery.toLowerCase();

      const localMatches = localScripts.filter(s => {
        const match = wordStartMatch(s.name, qLower) || wordStartMatch(s.symbol, qLower);
        if (!match) return false;
        return activeTab === 'All' || getTabForItem(s) === activeTab;
      });

      const liveMatches = await fetchLiveResults(actualQuery, activeTab, abortController.signal);
      const merged = [...liveMatches];
      const liveSymbols = new Set(liveMatches.map((r: any) => r.symbol));
      for (const local of localMatches) {
        if (!liveSymbols.has(local.symbol)) { merged.push(local); liveSymbols.add(local.symbol); }
      }
      setResults(merged);
      setIsSearching(false);
    }, 300);

    return () => { clearTimeout(timer); abortController.abort(); };
  }, [normalizedQuery, activeTab, token, isOpen]);

  const handleClear = () => { setQuery(''); setResults([]); setIsOpen(false); setExpandedOcSymbol(null); };
  const isAdded = (symbol: string) => addedSymbols ? addedSymbols.has(symbol) : false;
  const handleToggleClick = (item: WatchlistItem) => {
    if (isAdded(item.symbol)) { if (onRemove) onRemove(item); } else { onAdd(item); }
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
        onChange={(e) => { setQuery(e.target.value); if (!isOpen) setIsOpen(true); setExpandedOcSymbol(null); }}
        onFocus={() => setIsOpen(true)}
        autoComplete="off"
      />
      <button className="clear-search-btn" onClick={handleClear} aria-label="Clear search" style={{ opacity: query ? 1 : 0.35 }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {isOpen && (
        <div className="search-results-section" style={{ display: 'flex', flexDirection: 'column', position: 'absolute', top: 'calc(100% + 12px)', left: '-16px', right: '-16px', bottom: 'auto', height: 'calc(100vh - 130px)', zIndex: 1000, marginTop: 0, maxHeight: 'none', overflowY: 'hidden', boxShadow: 'none', border: 'none', borderRadius: 0, background: '#FFFFFF' }}>

          {expandedOcSymbol ? (
            <InlineOptionChain symbol={expandedOcSymbol} onClose={() => setExpandedOcSymbol(null)} />
          ) : (
            <>
              <div className="section-subtitle" style={{ padding: '12px 16px', margin: 0, borderBottom: '1px solid #EFF2F8', display: 'flex', justifyContent: 'space-between', flexShrink: 0 }}>
                <span><i className="fas fa-search"></i> SEARCH RESULTS</span>
                <span id="searchResultCount" style={{ color: '#8F9BB3', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {isSearching ? <AnimatedLoader size="small" text="SEARCHING..." /> : `${results.length} MATCHES`}
                </span>
              </div>

              <div id="searchResultsList" style={{ paddingBottom: '8px', flex: 1, overflowY: 'auto' }}>
                {results.length === 0 && !isSearching && (
                  <div className="no-results">No instruments found for &quot;{normalizedQuery}&quot;</div>
                )}
                {results.map((r, i) => {
                  const ocSymbol = getOcSymbol(r);
                  return (
                    <div
                      key={`${r.kiteSymbol || r.symbol}-${i}`}
                      className="search-result-item"
                      style={{ cursor: 'pointer', transition: 'background 0.2s', padding: '10px 16px' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#F8F9FC'}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#FFFFFF'}
                    >
                      {/* Instrument row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => handleToggleClick(r)}>
                        <div className="sri-left" style={{ flex: 1, minWidth: 0 }}>
                          <div className="sri-name">{r.name || r.symbol}</div>
                          <div className="sri-symbol">{r.segment}{r.contractDate ? ` • ${r.contractDate}` : ''}</div>
                        </div>
                        <div className="sri-right" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
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

                      {/* VIEW OPTION CHAIN button — only for MCX/Index futures */}
                      {ocSymbol && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setExpandedOcSymbol(ocSymbol); }}
                          style={{
                            marginTop: 7, width: '100%', padding: '5px 0',
                            border: '1px solid rgba(198,46,46,0.3)', borderRadius: 30,
                            background: 'rgba(198,46,46,0.04)', color: '#C62E2E',
                            fontSize: '0.65rem', fontWeight: 800, cursor: 'pointer',
                            fontFamily: 'Inter, sans-serif', letterSpacing: 0.5,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                            transition: 'all 0.15s',
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(198,46,46,0.1)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(198,46,46,0.04)'; }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <rect x="3" y="3" width="18" height="18" rx="2"/>
                            <line x1="3" y1="9" x2="21" y2="9"/>
                            <line x1="3" y1="15" x2="21" y2="15"/>
                            <line x1="9" y1="3" x2="9" y2="21"/>
                            <line x1="15" y1="3" x2="15" y2="21"/>
                          </svg>
                          VIEW OPTION CHAIN
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}


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
      const data = await api.get<WatchlistItem[]>(
        `/api/market/instruments/search?q=${encodeURIComponent(q)}&tab=${encodeURIComponent(tab)}`,
        { signal }
      );
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
