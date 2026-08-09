'use client';

import React from 'react';
import { QuoteData } from '@/hooks/useMarketQuotes';

interface StrikeData {
  strike: number;
  ce?: { token: number; symbol: string; id: string; price?: number };
  pe?: { token: number; symbol: string; id: string; price?: number };
}

interface OptionChainTableProps {
  strikes: StrikeData[];
  quotes: Record<string, QuoteData>;
  spotPrice: number;
  onTrade: (symbol: string, side: 'BUY' | 'SELL') => void;
  priceMode?: 'BA' | 'LTP';
  stickyTop?: number;
  hideMainHeader?: boolean;
  strikeRange?: number;
}

// ─── Memoized row — only re-renders when its own quote values change ──────────
interface StrikeRowProps {
  strike: number;
  ceId?: string;
  ceSymbol?: string;
  ceToken?: number;
  ceStaticPrice?: number;
  peId?: string;
  peSymbol?: string;
  peToken?: number;
  peStaticPrice?: number;
  ceQuote: QuoteData | null;
  peQuote: QuoteData | null;
  isAtm: boolean;
  atmRef: React.RefObject<HTMLDivElement>;
  priceMode: 'BA' | 'LTP';
  onTrade: (symbol: string, side: 'BUY' | 'SELL') => void;
}

const StrikeRow = React.memo(function StrikeRow({
  strike, ceId, ceSymbol, ceToken, ceStaticPrice,
  peId, peSymbol, peToken, peStaticPrice,
  ceQuote, peQuote, isAtm, atmRef, priceMode, onTrade,
}: StrikeRowProps) {
  const ceLtpVal = ceQuote?.lastPrice ?? ceStaticPrice;
  const peLtpVal = peQuote?.lastPrice ?? peStaticPrice;

  const ceBidVal = ceQuote?.bid && ceQuote.bid > 0 ? ceQuote.bid : null;
  const ceAskVal = ceQuote?.ask && ceQuote.ask > 0 ? ceQuote.ask : null;
  const peBidVal = peQuote?.bid && peQuote.bid > 0 ? peQuote.bid : null;
  const peAskVal = peQuote?.ask && peQuote.ask > 0 ? peQuote.ask : null;

  const ceHasValidSpread = ceBidVal && ceAskVal && ceBidVal < ceAskVal;
  const peHasValidSpread = peBidVal && peAskVal && peBidVal < peAskVal;

  const ceBidFinal = ceHasValidSpread ? ceBidVal : (ceLtpVal ? ceLtpVal * 0.9995 : null);
  const ceAskFinal = ceHasValidSpread ? ceAskVal : (ceLtpVal ? ceLtpVal * 1.0005 : null);
  const peBidFinal = peHasValidSpread ? peBidVal : (peLtpVal ? peLtpVal * 0.9995 : null);
  const peAskFinal = peHasValidSpread ? peAskVal : (peLtpVal ? peLtpVal * 1.0005 : null);

  const ceBid = ceBidFinal ? ceBidFinal.toFixed(1) : '---';
  const ceAsk = ceAskFinal ? ceAskFinal.toFixed(1) : '---';
  const peBid = peBidFinal ? peBidFinal.toFixed(1) : '---';
  const peAsk = peAskFinal ? peAskFinal.toFixed(1) : '---';
  const ceLtp = ceLtpVal ? `₹${ceLtpVal.toFixed(1)}` : '---';
  const peLtp = peLtpVal ? `₹${peLtpVal.toFixed(1)}` : '---';

  const handleClick = (e: React.MouseEvent, sym?: string, side?: 'BUY' | 'SELL') => {
    e.stopPropagation();
    if (sym && side) onTrade(sym, side);
  };

  // Inline styles for layout — avoids styled-jsx scope issues with memoized child components
  const rowStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    borderBottom: isAtm ? 'none' : '1px solid #f0f2f5',
    borderTop: isAtm ? '2px solid rgba(198,46,46,0.5)' : undefined,
    ...(isAtm ? { borderBottom: '2px solid rgba(198,46,46,0.5)' } : {}),
    flexShrink: 0,
  };
  const callStyle: React.CSSProperties = {
    position: 'relative', background: '#f4fbf4',
    display: 'flex', justifyContent: 'space-around', alignItems: 'center',
    padding: '11px 8px', cursor: 'pointer', gap: '4px',
  };
  const strikeStyle: React.CSSProperties = {
    background: isAtm ? '#fff8f0' : '#fefef8',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '11px 4px',
  };
  const putStyle: React.CSSProperties = {
    position: 'relative', background: '#fff7f3',
    display: 'flex', justifyContent: 'space-around', alignItems: 'center',
    padding: '11px 8px', cursor: 'pointer', gap: '4px',
  };
  const valStyle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: '#1e293b' };
  const strikeValStyle: React.CSSProperties = {
    fontSize: 14, fontWeight: isAtm ? 800 : 700, color: '#C62E2E',
  };
  const hoverActionsStyle: React.CSSProperties = {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    background: 'rgba(255,255,255,0.95)', opacity: 0, pointerEvents: 'none',
  };
  const btnBuyStyle: React.CSSProperties = {
    width: 24, height: 24, borderRadius: 4, border: 'none',
    fontSize: 11, fontWeight: 800, color: 'white', cursor: 'pointer',
    background: '#12B76A', display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
  const btnSellStyle: React.CSSProperties = { ...btnBuyStyle, background: '#F04438' };

  return (
    <div ref={isAtm ? atmRef : null} style={rowStyle}>
      {/* Calls */}
      <div style={callStyle} onClick={(e) => handleClick(e, ceSymbol, 'BUY')}
        onMouseEnter={e => { const h = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.ha'); if (h) { h.style.opacity = '1'; h.style.pointerEvents = 'auto'; } }}
        onMouseLeave={e => { const h = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.ha'); if (h) { h.style.opacity = '0'; h.style.pointerEvents = 'none'; } }}
      >
        {priceMode === 'BA' ? (
          <><span style={valStyle}>{ceBid}</span><span style={valStyle}>{ceAsk}</span></>
        ) : (
          <span style={valStyle}>{ceLtp}</span>
        )}
        {ceSymbol && (
          <div className="ha" style={hoverActionsStyle}>
            <button style={btnBuyStyle} onClick={(e) => handleClick(e, ceSymbol, 'BUY')}>B</button>
            <button style={btnSellStyle} onClick={(e) => handleClick(e, ceSymbol, 'SELL')}>S</button>
          </div>
        )}
      </div>

      {/* Strike */}
      <div style={strikeStyle}>
        <span style={strikeValStyle}>{strike.toLocaleString('en-IN')}</span>
      </div>

      {/* Puts */}
      <div style={putStyle} onClick={(e) => handleClick(e, peSymbol, 'BUY')}
        onMouseEnter={e => { const h = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.ha'); if (h) { h.style.opacity = '1'; h.style.pointerEvents = 'auto'; } }}
        onMouseLeave={e => { const h = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.ha'); if (h) { h.style.opacity = '0'; h.style.pointerEvents = 'none'; } }}
      >
        {priceMode === 'BA' ? (
          <><span style={valStyle}>{peBid}</span><span style={valStyle}>{peAsk}</span></>
        ) : (
          <span style={valStyle}>{peLtp}</span>
        )}
        {peSymbol && (
          <div className="ha" style={hoverActionsStyle}>
            <button style={btnBuyStyle} onClick={(e) => handleClick(e, peSymbol, 'BUY')}>B</button>
            <button style={btnSellStyle} onClick={(e) => handleClick(e, peSymbol, 'SELL')}>S</button>
          </div>
        )}
      </div>
    </div>
  );
}, (prev, next) => {
  // Only re-render if the values actually visible in this row changed
  if (prev.isAtm !== next.isAtm) return false;
  if (prev.priceMode !== next.priceMode) return false;
  // Compare CE quote fields
  const cpq = prev.ceQuote; const cnq = next.ceQuote;
  if (cpq?.lastPrice !== cnq?.lastPrice) return false;
  if (cpq?.bid !== cnq?.bid) return false;
  if (cpq?.ask !== cnq?.ask) return false;
  // Compare PE quote fields
  const ppq = prev.peQuote; const pnq = next.peQuote;
  if (ppq?.lastPrice !== pnq?.lastPrice) return false;
  if (ppq?.bid !== pnq?.bid) return false;
  if (ppq?.ask !== pnq?.ask) return false;
  return true; // nothing changed — skip re-render
});

// ─── Main component ───────────────────────────────────────────────────────────

export default function OptionChainTable({
  strikes, quotes, spotPrice, onTrade,
  priceMode = 'LTP', stickyTop = 58, hideMainHeader = false, strikeRange = 0,
}: OptionChainTableProps) {
  const atmRef = React.useRef<HTMLDivElement>(null);
  const tableHeaderRef = React.useRef<HTMLDivElement>(null);
  const tableBodyRef = React.useRef<HTMLDivElement>(null);
  const [subheadFloating, setSubheadFloating] = React.useState(false);

  // Filter to allowed range
  const visibleStrikes = React.useMemo(() => {
    if (strikeRange <= 0 || spotPrice <= 0) return strikes;
    return strikes.filter(s => Math.abs(s.strike - spotPrice) <= strikeRange);
  }, [strikes, spotPrice, strikeRange]);

  // Find ATM index
  const atmIndex = React.useMemo(() => {
    if (spotPrice <= 0 || visibleStrikes.length === 0) return -1;
    let bestIdx = 0, minDiff = Infinity;
    visibleStrikes.forEach((s, i) => {
      const d = Math.abs(s.strike - spotPrice);
      if (d < minDiff) { minDiff = d; bestIdx = i; }
    });
    return bestIdx;
  }, [visibleStrikes, spotPrice]);

  // Scroll ATM to center of the body div — synchronously before paint
  React.useLayoutEffect(() => {
    const atmEl = atmRef.current;
    const bodyEl = tableBodyRef.current;
    if (!atmEl || !bodyEl || atmIndex < 0) return;
    bodyEl.scrollTop = atmEl.offsetTop - bodyEl.clientHeight / 2 + atmEl.offsetHeight / 2;
  }, [visibleStrikes, atmIndex]);

  // Subheader floating on page scroll
  React.useEffect(() => {
    const scrollEl = tableHeaderRef.current?.closest('.main-content') as HTMLElement | null;
    if (!scrollEl) return;
    const onScroll = () => {
      if (!tableHeaderRef.current) return;
      setSubheadFloating(tableHeaderRef.current.getBoundingClientRect().bottom <= stickyTop);
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [stickyTop]);

  // Stable onTrade ref so memoized rows don't re-render on parent re-renders
  const onTradeRef = React.useRef(onTrade);
  React.useEffect(() => { onTradeRef.current = onTrade; }, [onTrade]);
  const stableOnTrade = React.useCallback(
    (sym: string, side: 'BUY' | 'SELL') => onTradeRef.current(sym, side),
    []
  );

  // Helper to resolve a quote from multiple possible key formats
  const getQuote = React.useCallback((id?: string, token?: number): QuoteData | null => {
    if (!id && !token) return null;
    if (id && quotes[id]) return quotes[id];
    if (token && quotes[String(token)]) return quotes[String(token)];
    if (id) {
      const sym = id.split(':').pop();
      if (sym && quotes[sym]) return quotes[sym];
    }
    return null;
  }, [quotes]);

  return (
    <div className="oct-wrap">
      <div className="oct-table">

        {/* Main header */}
        {!hideMainHeader && (
          <div className="oct-head" ref={tableHeaderRef}>
            <div className="oct-head-calls">{priceMode === 'LTP' ? 'CALL LTP' : 'CALLS'}</div>
            <div className="oct-head-strike">STRIKE</div>
            <div className="oct-head-puts">{priceMode === 'LTP' ? 'PUT LTP' : 'PUTS'}</div>
          </div>
        )}

        {/* Sticky sub-header */}
        <div className={`oct-subhead${subheadFloating ? ' floating' : ''}`}>
          <div className="oct-sub-calls">
            {priceMode === 'BA' ? <><span>BID</span><span>ASK</span></> : <span>{hideMainHeader ? 'CALL' : 'LTP'}</span>}
          </div>
          <div className="oct-sub-strike">&#8377;</div>
          <div className="oct-sub-puts">
            {priceMode === 'BA' ? <><span>BID</span><span>ASK</span></> : <span>{hideMainHeader ? 'PUT' : 'LTP'}</span>}
          </div>
        </div>

        {/* Strike rows — fixed-height scrollable body, ATM centered */}
        <div className="oct-body" ref={tableBodyRef}>
          {visibleStrikes.map((s, index) => (
            <StrikeRow
              key={s.strike}
              strike={s.strike}
              ceId={s.ce?.id}
              ceSymbol={s.ce?.symbol}
              ceToken={s.ce?.token}
              ceStaticPrice={s.ce?.price}
              peId={s.pe?.id}
              peSymbol={s.pe?.symbol}
              peToken={s.pe?.token}
              peStaticPrice={s.pe?.price}
              ceQuote={getQuote(s.ce?.id, s.ce?.token)}
              peQuote={getQuote(s.pe?.id, s.pe?.token)}
              isAtm={index === atmIndex}
              atmRef={atmRef}
              priceMode={priceMode}
              onTrade={stableOnTrade}
            />
          ))}
        </div>
      </div>

      <style jsx>{`
        .oct-wrap { width: 100%; padding: 0 0 80px 0; }

        .oct-table {
          width: 100%;
          background: #fff;
          border-radius: 20px;
          overflow: clip;
          border: 1px solid #e8eaf0;
          box-shadow: 0 2px 12px rgba(0,0,0,0.05);
          font-family: 'Inter', sans-serif;
        }
        :global(body.dark) .oct-table { background: #141414; border-color: #2a2a2a; box-shadow: 0 2px 16px rgba(0,0,0,0.4); }

        .oct-head {
          display: grid; grid-template-columns: 1fr 1fr 1fr;
          font-size: 0.925rem; font-weight: 800; letter-spacing: 0.5px;
        }
        .oct-head-calls  { background: #edf7f0; color: #000; text-align: center; padding: 14px 0 18px; }
        .oct-head-strike { background: #fefbe8; color: #000; text-align: center; padding: 14px 0 18px; }
        .oct-head-puts   { background: #fff0eb; color: #000; text-align: center; padding: 14px 0 18px; }
        :global(body.dark) .oct-head-calls  { background: #1a2e1c; color: #fff; }
        :global(body.dark) .oct-head-puts   { background: #2e1a1a; color: #fff; }
        :global(body.dark) .oct-head-strike { background: #252010; color: #fff; }

        .oct-subhead {
          display: grid; grid-template-columns: 1fr 1fr 1fr;
          font-size: 0.845rem; font-weight: 700;
          position: sticky; top: ${stickyTop}px; z-index: 20;
          border-bottom: 1px solid #e8eaf0;
          transition: border-radius 0.15s ease, box-shadow 0.15s ease;
        }
        .oct-subhead.floating { border-radius: 20px 20px 0 0; box-shadow: 0 4px 16px rgba(0,0,0,0.1); overflow: hidden; }
        .oct-subhead.floating .oct-sub-calls { border-radius: 20px 0 0 0; }
        .oct-subhead.floating .oct-sub-puts  { border-radius: 0 20px 0 0; }
        :global(body.dark) .oct-subhead { border-bottom-color: #252525; }

        .oct-sub-calls, .oct-sub-puts {
          background: #fff; color: #000;
          display: flex; justify-content: space-around; align-items: center; padding: 10px 8px;
        }
        .oct-sub-strike {
          background: #fff; color: #000; text-align: center;
          display: flex; align-items: center; justify-content: center;
          padding: 10px 0; font-size: 0.975rem;
        }
        :global(body.dark) .oct-sub-calls  { background: #141414; color: #a3a3a3; }
        :global(body.dark) .oct-sub-puts   { background: #141414; color: #a3a3a3; }
        :global(body.dark) .oct-sub-strike { background: #141414; color: #a3a3a3; }

        /* Fixed-height body — hides scrollbar, ATM centered via JS */
        .oct-body {
          display: flex; flex-direction: column;
          height: 462px;
          overflow-y: auto;
          scrollbar-width: none; -ms-overflow-style: none;
        }
        .oct-body::-webkit-scrollbar { display: none; }

        .oct-row {
          display: grid; grid-template-columns: 1fr 1fr 1fr;
          border-bottom: 1px solid #f0f2f5;
          flex-shrink: 0;
        }
        .oct-row:last-child { border-bottom: none; }
        .oct-row:active { opacity: 0.7; }
        .oct-row.atm {
          border-top: 2px solid rgba(198,46,46,0.5);
          border-bottom: 2px solid rgba(198,46,46,0.5);
        }
        :global(body.dark) .oct-row { border-bottom-color: #1f1f1f; }

        .oct-cell-calls {
          position: relative; background: #f4fbf4;
          display: flex; justify-content: space-around; align-items: center;
          padding: 11px 8px; cursor: pointer; gap: 4px;
        }
        .oct-cell-strike {
          background: #fefef8;
          display: flex; align-items: center; justify-content: center; padding: 11px 4px;
        }
        .oct-cell-puts {
          position: relative; background: #fff7f3;
          display: flex; justify-content: space-around; align-items: center;
          padding: 11px 8px; cursor: pointer; gap: 4px;
        }
        .oct-cell-calls:active, .oct-cell-puts:active { opacity: 0.7; }
        .oct-cell-strike.atm { background: #fff8f0; }
        :global(body.dark) .oct-cell-calls  { background: #161c17; }
        :global(body.dark) .oct-cell-puts   { background: #1c1616; }
        :global(body.dark) .oct-cell-strike { background: #141414; }
        :global(body.dark) .oct-cell-strike.atm { background: #1e1414; }

        .oct-val { font-size: 14px; font-weight: 700; }
        .oct-val.call { color: #1e293b; }
        .oct-val.put  { color: #1e293b; }
        :global(body.dark) .oct-val.call { color: #f1f5f9; }
        :global(body.dark) .oct-val.put  { color: #f1f5f9; }

        .oct-strike-val { font-size: 14px; font-weight: 700; color: #C62E2E; }
        .oct-strike-val.atm { font-weight: 800; }
        :global(body.dark) .oct-strike-val     { color: #f87171; }
        :global(body.dark) .oct-strike-val.atm { color: #ff6b6b; font-weight: 800; }

        .hover-actions {
          position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          display: flex; align-items: center; justify-content: center; gap: 6px;
          background: rgba(255,255,255,0.95);
          opacity: 0; transition: opacity 0.15s ease-in-out; pointer-events: none;
        }
        :global(body.dark) .hover-actions { background: rgba(20,20,20,0.95); }
        .oct-cell-calls:hover .hover-actions,
        .oct-cell-puts:hover .hover-actions { opacity: 1; pointer-events: auto; }

        .btn-buy, .btn-sell {
          width: 24px; height: 24px; border-radius: 4px; border: none;
          font-size: 11px; font-weight: 800; color: white; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: transform 0.1s;
        }
        .btn-buy:active, .btn-sell:active { transform: scale(0.9); }
        .btn-buy  { background: #12B76A; }
        .btn-sell { background: #F04438; }
      `}</style>
    </div>
  );
}
