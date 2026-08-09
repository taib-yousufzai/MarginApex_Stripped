'use client';

import React from 'react';
import { QuoteData } from '@/hooks/useMarketQuotes';

interface StrikeData {
  strike: number;
  ce?: {
    token: number;
    symbol: string;
    id: string;
    price?: number;
  };
  pe?: {
    token: number;
    symbol: string;
    id: string;
    price?: number;
  };
}

interface OptionChainTableProps {
  strikes: StrikeData[];
  quotes: Record<string, QuoteData>;
  spotPrice: number;
  onTrade: (symbol: string, side: 'BUY' | 'SELL') => void;
  priceMode?: 'BA' | 'LTP';
  stickyTop?: number;
  hideMainHeader?: boolean;
  /**
   * User's allowed strike range from segment settings.
   * Strikes outside this distance from spotPrice are dimmed and non-tradeable.
   * 0 means no restriction.
   */
  strikeRange?: number;
}

export default function OptionChainTable({ strikes, quotes, spotPrice, onTrade, priceMode = 'LTP', stickyTop = 58, hideMainHeader = false, strikeRange = 0 }: OptionChainTableProps) {
  const atmRef = React.useRef<HTMLDivElement>(null);
  const tableHeaderRef = React.useRef<HTMLDivElement>(null);
  const scrollContainerRef = React.useRef<HTMLElement | null>(null);
  const [subheadFloating, setSubheadFloating] = React.useState(false);

  // Filter strikes to only show those within the allowed range
  const visibleStrikes = React.useMemo(() => {
    if (strikeRange <= 0 || spotPrice <= 0) return strikes;
    return strikes.filter(s => Math.abs(s.strike - spotPrice) <= strikeRange);
  }, [strikes, spotPrice, strikeRange]);

  const atmIndex = React.useMemo(() => {
    if (spotPrice <= 0 || visibleStrikes.length === 0) return -1;
    let bestIdx = 0;
    let minDiff = Infinity;
    visibleStrikes.forEach((s, i) => {
      const diff = Math.abs(s.strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = i;
      }
    });
    return bestIdx;
  }, [visibleStrikes, spotPrice]);

  const atmStrike = atmIndex >= 0 ? visibleStrikes[atmIndex] : null;

  // Slice strikes so ATM is always the middle element (position 5 of 11).
  // ATM is always rendered at the vertical center with no scrolling needed.
  const centeredStrikes = React.useMemo(() => {
    if (atmIndex < 0 || visibleStrikes.length === 0) return visibleStrikes;
    const half = 5;
    const lo = Math.max(0, atmIndex - half);
    const hi = Math.min(visibleStrikes.length - 1, atmIndex + half);
    return visibleStrikes.slice(lo, hi + 1);
  }, [visibleStrikes, atmIndex]);

  // ATM index within the centered slice
  const centeredAtmIndex = React.useMemo(() => {
    if (atmIndex < 0 || visibleStrikes.length === 0) return -1;
    const half = 5;
    const lo = Math.max(0, atmIndex - half);
    return atmIndex - lo;
  }, [atmIndex, visibleStrikes]);

  // Subheader floating detection only — no scroll logic
  React.useEffect(() => {
    const scrollEl = tableHeaderRef.current?.closest('.main-content') as HTMLElement | null;
    if (!scrollEl) return;
    scrollContainerRef.current = scrollEl;
    const onScroll = () => {
      if (!tableHeaderRef.current) return;
      const rect = tableHeaderRef.current.getBoundingClientRect();
      setSubheadFloating(rect.bottom <= stickyTop);
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, []);

  const getQuote = (id?: string, token?: number) => {
    if (!id && !token) return null;
    if (id && quotes[id]) return quotes[id];
    if (token && quotes[String(token)]) return quotes[String(token)];

    if (id) {
      const parts = id.split(':');
      const symbolOnly = parts.length > 1 ? parts[1] : id;
      if (quotes[symbolOnly]) return quotes[symbolOnly];
    }

    return null;
  };

  return (
    <div className="oct-wrap">
      {/* Single outer container */}
      <div className="oct-table">

        {/* Header row (scrolls away) */}
        {!hideMainHeader && (
          <div className="oct-head" ref={tableHeaderRef}>
            <div className="oct-head-calls">{priceMode === 'LTP' ? 'CALL LTP' : 'CALLS'}</div>
            <div className="oct-head-strike">STRIKE</div>
            <div className="oct-head-puts">{priceMode === 'LTP' ? 'PUT LTP' : 'PUTS'}</div>
          </div>
        )}

        {/* Sub-header: sticky */}
        <div className={`oct-subhead${subheadFloating ? ' floating' : ''}`}>
          <div className="oct-sub-calls">
            {priceMode === 'BA' ? <><span>BID</span><span>ASK</span></> : <span>{hideMainHeader ? 'CALL' : 'LTP'}</span>}
          </div>
          <div className="oct-sub-strike">&#8377;</div>
          <div className="oct-sub-puts">
            {priceMode === 'BA' ? <><span>BID</span><span>ASK</span></> : <span>{hideMainHeader ? 'PUT' : 'LTP'}</span>}
          </div>
        </div>

        {/* Data rows */}
        <div className="oct-body">
          {centeredStrikes.map((s, index) => {
            const ceQuote = getQuote(s.ce?.id, s.ce?.token);
            const peQuote = getQuote(s.pe?.id, s.pe?.token);
            const isAtm = index === centeredAtmIndex;

            const ceLtpVal = ceQuote ? ceQuote.lastPrice : s.ce?.price;
            const peLtpVal = peQuote ? peQuote.lastPrice : s.pe?.price;

            const ceBidVal = ceQuote?.bid && ceQuote.bid > 0 ? ceQuote.bid : null;
            const ceAskVal = ceQuote?.ask && ceQuote.ask > 0 ? ceQuote.ask : null;
            const peBidVal = peQuote?.bid && peQuote.bid > 0 ? peQuote.bid : null;
            const peAskVal = peQuote?.ask && peQuote.ask > 0 ? peQuote.ask : null;

            // Use real bid/ask if valid (both present and bid < ask).
            // Fall back to a tight synthetic spread around LTP only when missing or crossed.
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

            const ceLtp = ceLtpVal ? `\u20b9${ceLtpVal.toFixed(1)}` : '---';
            const peLtp = peLtpVal ? `\u20b9${peLtpVal.toFixed(1)}` : '---';

            const handleTradeClick = (e: React.MouseEvent, symbol?: string, side?: 'BUY' | 'SELL') => {
              e.stopPropagation();
              if (symbol && side) onTrade(symbol, side);
            };

            return (
              <div
                key={s.strike}
                ref={isAtm ? atmRef : null}
                className={`oct-row${isAtm ? ' atm' : ''}`}
              >
                {/* Calls */}
                <div
                  className="oct-cell-calls"
                  onClick={(e) => handleTradeClick(e, s.ce?.symbol, 'BUY')}
                >
                  {priceMode === 'BA' ? (
                    <>
                      <span className="oct-val call">{ceBid}</span>
                      <span className="oct-val call">{ceAsk}</span>
                    </>
                  ) : (
                    <span className="oct-val call ltp-single">{ceLtp}</span>
                  )}
                  {s.ce && (
                    <div className="hover-actions">
                      <button className="btn-buy" onClick={(e) => handleTradeClick(e, s.ce?.symbol, 'BUY')}>B</button>
                      <button className="btn-sell" onClick={(e) => handleTradeClick(e, s.ce?.symbol, 'SELL')}>S</button>
                    </div>
                  )}
                </div>

                {/* Strike */}
                <div className={`oct-cell-strike${isAtm ? ' atm' : ''}`}>
                  <span className={`oct-strike-val${isAtm ? ' atm' : ''}`}>
                    {s.strike.toLocaleString('en-IN')}
                  </span>
                </div>

                {/* Puts */}
                <div
                  className="oct-cell-puts"
                  onClick={(e) => handleTradeClick(e, s.pe?.symbol, 'BUY')}
                >
                  {priceMode === 'BA' ? (
                    <>
                      <span className="oct-val put">{peBid}</span>
                      <span className="oct-val put">{peAsk}</span>
                    </>
                  ) : (
                    <span className="oct-val put ltp-single">{peLtp}</span>
                  )}
                  {s.pe && (
                    <div className="hover-actions">
                      <button className="btn-buy" onClick={(e) => handleTradeClick(e, s.pe?.symbol, 'BUY')}>B</button>
                      <button className="btn-sell" onClick={(e) => handleTradeClick(e, s.pe?.symbol, 'SELL')}>S</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <style jsx>{`
        .oct-wrap {
          width: 100%;
          padding: 0 0 80px 0;
        }

        .oct-table {
          width: 100%;
          background: #fff;
          border-radius: 20px;
          overflow: clip;
          border: 1px solid #e8eaf0;
          box-shadow: 0 2px 12px rgba(0,0,0,0.05);
          font-family: 'Inter', sans-serif;
        }

        :global(body.dark) .oct-table {
          background: #141414;
          border-color: #2a2a2a;
          box-shadow: 0 2px 16px rgba(0,0,0,0.4);
        }

        /* Header */
        .oct-head {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          font-size: 0.925rem;
          font-weight: 800;
          letter-spacing: 0.5px;
          font-family: 'Inter', sans-serif;
        }

        .oct-head-calls {
          background: #edf7f0;
          color: #000000;
          text-align: center;
          padding: 14px 0 18px 0;
        }
        .oct-head-strike {
          background: #fefbe8;
          color: #000000;
          text-align: center;
          padding: 14px 0 18px 0;
        }
        .oct-head-puts {
          background: #fff0eb;
          color: #000000;
          text-align: center;
          padding: 14px 0 18px 0;
        }

        :global(body.dark) .oct-head-calls  { background: #1a2e1c; color: #ffffff; }
        :global(body.dark) .oct-head-puts   { background: #2e1a1a; color: #ffffff; }
        :global(body.dark) .oct-head-strike { background: #252010; color: #ffffff; }

        /* Sticky sub-header */
        .oct-subhead {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          font-size: 0.845rem;
          font-weight: 700;
          font-family: 'Inter', sans-serif;
          position: sticky;
          top: ${stickyTop}px;
          z-index: 20;
          border-bottom: 1px solid #e8eaf0;
          transition: border-radius 0.15s ease, box-shadow 0.15s ease;
        }

        .oct-subhead.floating {
          border-radius: 20px 20px 0 0;
          box-shadow: 0 4px 16px rgba(0,0,0,0.1);
          overflow: hidden;
        }
        .oct-subhead.floating .oct-sub-calls { border-radius: 20px 0 0 0; }
        .oct-subhead.floating .oct-sub-puts  { border-radius: 0 20px 0 0; }

        :global(body.dark) .oct-subhead { border-bottom-color: #252525; }
        :global(body.dark) .oct-subhead.floating { box-shadow: 0 4px 16px rgba(0,0,0,0.5); }

        .oct-sub-calls {
          background: #ffffff;
          color: #000000;
          display: flex;
          justify-content: space-around;
          align-items: center;
          padding: 10px 8px;
        }
        .oct-sub-strike {
          background: #ffffff;
          color: #000000;
          text-align: center;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 10px 0;
          font-size: 0.975rem;
        }
        .oct-sub-puts {
          background: #ffffff;
          color: #000000;
          display: flex;
          justify-content: space-around;
          align-items: center;
          padding: 10px 8px;
        }

        :global(body.dark) .oct-sub-calls  { background: #141414; color: #a3a3a3; }
        :global(body.dark) .oct-sub-puts   { background: #141414; color: #a3a3a3; }
        :global(body.dark) .oct-sub-strike { background: #141414; color: #a3a3a3; }

        /* Body */
        .oct-body {
          display: flex;
          flex-direction: column;
        }

        /* Row */
        .oct-row {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          border-bottom: 1px solid #f0f2f5;
          transition: opacity 0.1s;
        }
        .oct-row:last-child { border-bottom: none; }
        .oct-row:active { opacity: 0.7; }

        .oct-row.atm {
          border-top: 2px solid rgba(198,46,46,0.5);
          border-bottom: 2px solid rgba(198,46,46,0.5);
        }

        :global(body.dark) .oct-row { border-bottom-color: #1f1f1f; }

        /* Cells */
        .oct-cell-calls {
          position: relative;
          background: #f4fbf4;
          display: flex;
          justify-content: space-around;
          align-items: center;
          padding: 11px 8px;
          cursor: pointer;
          gap: 4px;
        }
        .oct-cell-strike {
          background: #fefef8;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 11px 4px;
        }
        .oct-cell-puts {
          position: relative;
          background: #fff7f3;
          display: flex;
          justify-content: space-around;
          align-items: center;
          padding: 11px 8px;
          cursor: pointer;
          gap: 4px;
        }

        .oct-cell-calls:active,
        .oct-cell-puts:active { opacity: 0.7; }

        .oct-cell-strike.atm { background: #fff8f0; }

        :global(body.dark) .oct-cell-calls  { background: #161c17; }
        :global(body.dark) .oct-cell-puts   { background: #1c1616; }
        :global(body.dark) .oct-cell-strike { background: #141414; }
        :global(body.dark) .oct-cell-strike.atm { background: #1e1414; }

        /* Values */
        .oct-val {
          font-size: 14px;
          font-weight: 700;
          font-family: 'Inter', sans-serif;
        }
        .oct-val.call { color: #1e293b; }
        .oct-val.put  { color: #1e293b; }
        .oct-val.ltp-single { font-size: 14px; font-weight: 700; }

        :global(body.dark) .oct-val.call { color: #f1f5f9; }
        :global(body.dark) .oct-val.put  { color: #f1f5f9; }

        /* Strike value */
        .oct-strike-val {
          font-size: 14px;
          font-weight: 700;
          color: #C62E2E;
          font-family: 'Inter', sans-serif;
        }
        .oct-strike-val.atm {
          color: #C62E2E;
          font-weight: 800;
          font-size: 14px;
        }

        :global(body.dark) .oct-strike-val     { color: #f87171; }
        :global(body.dark) .oct-strike-val.atm { color: #ff6b6b; font-weight: 800; }

        /* Hover actions */
        .hover-actions {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          background: rgba(255,255,255,0.95);
          opacity: 0;
          transition: opacity 0.15s ease-in-out;
          pointer-events: none;
        }
        :global(body.dark) .hover-actions { background: rgba(20,20,20,0.95); }

        .oct-cell-calls:hover .hover-actions,
        .oct-cell-puts:hover .hover-actions {
          opacity: 1;
          pointer-events: auto;
        }

        .btn-buy, .btn-sell {
          width: 24px;
          height: 24px;
          border-radius: 4px;
          border: none;
          font-size: 11px;
          font-weight: 800;
          color: white;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.1s;
        }
        .btn-buy:active, .btn-sell:active { transform: scale(0.9); }
        .btn-buy  { background: #12B76A; }
        .btn-sell { background: #F04438; }
      `}</style>
    </div>
  );
}
