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
  const [subheadFloating, setSubheadFloating] = React.useState(false);
  const isFirstScrollRef = React.useRef(true);

  const atmIndex = React.useMemo(() => {
    if (spotPrice <= 0 || strikes.length === 0) return -1;
    let bestIdx = 0;
    let minDiff = Infinity;
    strikes.forEach((s, i) => {
      const diff = Math.abs(s.strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = i;
      }
    });
    return bestIdx;
  }, [strikes, spotPrice]);

  const atmStrike = atmIndex >= 0 ? strikes[atmIndex] : null;

  // Reset so we do an instant scroll on the next data load
  React.useEffect(() => {
    isFirstScrollRef.current = true;
  }, [strikes]);

  // Always keep the ATM row centered.
  // Fires on first data load AND whenever the spot crosses into a new strike.
  React.useEffect(() => {
    if (!atmRef.current || strikes.length === 0 || spotPrice <= 0 || !atmStrike) return;

    const el = atmRef.current;
    const behavior: ScrollBehavior = isFirstScrollRef.current ? 'instant' : 'smooth';
    isFirstScrollRef.current = false;

    const doScroll = () => {
      el.scrollIntoView({ block: 'center', behavior });
    };

    // Small delay so the DOM has finished painting before we measure
    const t = setTimeout(doScroll, behavior === 'instant' ? 100 : 0);
    return () => clearTimeout(t);
  }, [atmStrike]);


  React.useEffect(() => {
    const scrollEl = tableHeaderRef.current?.closest('.main-content') as HTMLElement | null;
    if (!scrollEl) return;
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
          {strikes.map((s, index) => {
            const ceQuote = getQuote(s.ce?.id, s.ce?.token);
            const peQuote = getQuote(s.pe?.id, s.pe?.token);
            const isAtm = index === atmIndex;

            // Out-of-range: strike is more than strikeRange points from spot
            const isOutOfRange = strikeRange > 0 && spotPrice > 0 &&
              Math.abs(s.strike - spotPrice) > strikeRange;

            const ceLtpVal = ceQuote ? ceQuote.lastPrice : s.ce?.price;
            const peLtpVal = peQuote ? peQuote.lastPrice : s.pe?.price;

            const ceBidVal = ceQuote && ceQuote.bid !== undefined && ceQuote.bid !== 0 ? ceQuote.bid : ceLtpVal;
            const ceAskVal = ceQuote && ceQuote.ask !== undefined && ceQuote.ask !== 0 ? ceQuote.ask : ceLtpVal;
            const peBidVal = peQuote && peQuote.bid !== undefined && peQuote.bid !== 0 ? peQuote.bid : peLtpVal;
            const peAskVal = peQuote && peQuote.ask !== undefined && peQuote.ask !== 0 ? peQuote.ask : peLtpVal;

            const ceBid = ceBidVal ? ceBidVal.toFixed(1) : '---';
            const ceAsk = ceAskVal ? ceAskVal.toFixed(1) : '---';
            const peBid = peBidVal ? peBidVal.toFixed(1) : '---';
            const peAsk = peAskVal ? peAskVal.toFixed(1) : '---';

            const ceLtp = ceLtpVal ? `\u20b9${ceLtpVal.toFixed(1)}` : '---';
            const peLtp = peLtpVal ? `\u20b9${peLtpVal.toFixed(1)}` : '---';

            const handleTradeClick = (e: React.MouseEvent, symbol?: string, side?: 'BUY' | 'SELL') => {
              e.stopPropagation();
              if (isOutOfRange) return; // silently block out-of-range trades in the UI
              if (symbol && side) onTrade(symbol, side);
            };

            return (
              <div
                key={s.strike}
                ref={isAtm ? atmRef : null}
                className={`oct-row${isAtm ? ' atm' : ''}${isOutOfRange ? ' out-of-range' : ''}`}
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
        .oct-row.out-of-range {
          opacity: 0.4;
          background: #fdfdfd;
        }
        :global(body.dark) .oct-row.out-of-range {
          background: #111;
        }

        .oct-row.atm {
          border-top: 2px solid rgba(198,46,46,0.25);
          border-bottom: 2px solid rgba(198,46,46,0.25);
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
