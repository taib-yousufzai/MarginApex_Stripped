'use client';

import React, { useState } from 'react';
import { QuoteData } from '@/hooks/useMarketQuotes';
import { ComexQuoteData } from '@/contexts/ComexDataContext';
import TickFlash from '@/components/TickFlash';

export interface WatchlistItem {
  name: string;
  comexName?: string;
  symbol: string;
  kiteSymbol: string;
  binanceSymbol?: string;
  comexSymbol?: string;
  price: number;
  change: string;
  segment: string;
  contractDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface InstrumentRowProps {
  item: WatchlistItem;
  quote?: QuoteData;
  binanceQuote?: QuoteData;
  comexQuote?: ComexQuoteData;
  onTrade: (item: WatchlistItem, side?: 'BUY' | 'SELL' | 'BOTH') => void;
  onDetail?: (item: WatchlistItem) => void;
  basketMode?: boolean;
  onBasketBuy?: (item: WatchlistItem) => void;
  onBasketSell?: (item: WatchlistItem) => void;
}

const CRYPTO_BASES = ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'];

function getExchangeBadge(segment: string, name?: string, symbol?: string) {
  if (name || symbol) {
    const combined = `${name || ''} ${symbol || ''}`.toUpperCase();
    if (combined.includes('INDEX') || combined.startsWith('NIFTY') || combined.startsWith('BANKNIFTY') || combined.startsWith('FINNIFTY') || combined.startsWith('SENSEX')) {
      if (!combined.includes(' CE') && !combined.includes(' PE') && !combined.includes(' FUT')) {
        return combined.includes('SENSEX') || combined.includes('BSE') ? 'BSE' : 'NSE';
      }
    }
  }
  if (!segment) return 'OTH';
  if (segment === 'STOCK-FUT' || segment.includes('Stock Futures')) return 'Stock - Stock Fut';
  if (segment === 'STOCK-OPT' || segment.includes('Stock Options')) return 'Stock - Stock Opt';
  if (segment.startsWith('NSE') && segment !== 'NSE - Equity') return 'NFO';
  if (segment.startsWith('BSE') && segment !== 'BSE - Equity') return 'BFO';
  if (segment.startsWith('MCX') || segment.includes('MCX')) return 'MCX';
  if (segment.startsWith('CDS') || segment.includes('FOREX')) return 'CDS';
  if (segment.includes('CRYPTO') || segment === 'Crypto') return 'CRYPTO';
  if (segment === 'NSE - Equity') return 'NSE';
  if (segment === 'BSE - Equity') return 'BSE';
  return 'OTH';
}

function getPctClass(pct: number) {
  return pct >= 0 ? 'pos' : 'neg';
}

export default function InstrumentRow({ item, quote, binanceQuote, comexQuote, onTrade }: InstrumentRowProps) {
  const [priceView, setPriceView] = useState<'kite' | 'comex'>('kite');

  const symUp = (item.symbol || '').toUpperCase().trim();
  const segUpper = (item.segment || '').toUpperCase();

  const isCrypto = !!item.binanceSymbol ||
                   segUpper === 'CRYPTO' ||
                   segUpper === 'CRYPTO-FUT' ||
                   symUp.endsWith('USDT') ||
                   CRYPTO_BASES.some(c => symUp === c || symUp.startsWith(`${c}USDT`) || symUp.startsWith(`${c}/`));

  const isUs = symUp.startsWith('US:') ||
               segUpper.includes('US') ||
               (item.kiteSymbol && item.kiteSymbol.startsWith('US:')) ||
               ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'AMD', 'INTC', 'SPY', 'QQQ', 'DIA', 'ES=F', 'NQ=F', 'YM=F'].includes(symUp.replace(/^US:/, ''));

  const isStock = !isCrypto && !isUs && (
    segUpper === 'STOCK-FUT' ||
    segUpper === 'STOCK-OPT' ||
    segUpper.includes('STOCK') ||
    segUpper.includes('STOCKS')
  );

  const hasDualView = !!item.kiteSymbol && !!item.comexSymbol;
  const showComex = hasDualView && priceView === 'comex';

  const activeCryptoQuote = quote || binanceQuote;

  let ltp = 0;
  let prevClose = 0;
  if (isCrypto) {
    ltp = activeCryptoQuote?.lastPrice ?? item.price ?? 0;
    prevClose = activeCryptoQuote?.close || item.close || ltp;
  } else if (showComex) {
    ltp = comexQuote?.lastPrice ?? item.price ?? 0;
    prevClose = comexQuote?.close || item.close || ltp;
  } else {
    ltp = quote?.lastPrice ?? item.price ?? 0;
    prevClose = quote?.close || item.close || ltp;
  }

  const absoluteChange = ltp - prevClose;
  const percentChange = prevClose !== 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
  const isLoading = isCrypto ? (!activeCryptoQuote && ltp === 0) : showComex ? (!comexQuote && ltp === 0) : (!quote && ltp === 0);

  const handleCardClick = (e: React.MouseEvent) => {
    // If clicking a sub-button like delete or view toggle, don't trigger trade
    if ((e.target as HTMLElement).closest('.wc-action-btn') || (e.target as HTMLElement).closest('.dual-view-toggle')) {
      return;
    }
    onTrade({ ...item, preferredView: priceView } as any);
  };

  return (
    <div className="instr-row watchlist-card" data-symbol={item.symbol} onClick={handleCardClick} style={{ cursor: 'pointer' }}>
      <div className="wc-swipe-actions">
        <button className="wc-action-btn delete-btn" onClick={(e) => { e.stopPropagation(); (window as any).removeFromWatchlist?.(item.symbol); }}>
          <i className="fas fa-trash-alt"></i>
        </button>
      </div>
      <div className="wc-content instr-row__content">
        <div className="instr-row__left">
          <div className="instr-row__name-line">
            <span className="instr-row__name">{showComex ? (comexQuote?.contractSymbol ?? item.comexName ?? item.name) : item.name}</span>
            <span className="exchange-badge" style={
              isCrypto ? { background: '#F0A500', color: '#fff' } :
                showComex ? { background: '#4A148C', color: '#fff' } :
                  isUs ? { background: '#2563EB', color: '#fff' } :
                    isStock ? { background: '#059669', color: '#fff' } : {}
            }>
              {isCrypto
                ? 'CRYPTO'
                : showComex
                  ? 'COMEX'
                  : isUs
                    ? 'US'
                    : isStock
                      ? (segUpper.includes('FUT') ? 'Stock - Stock Fut' : segUpper.includes('OPT') ? 'Stock - Stock Opt' : 'Stock')
                      : getExchangeBadge(item.segment, item.name, item.symbol)}
            </span>
          </div>
          {item.contractDate && (
            <div className="instr-row__date">{item.contractDate}</div>
          )}
          {isCrypto && (
            <div className="instr-row__date" style={{ color: '#6B7280', fontSize: '0.7rem' }}>{item.binanceSymbol}</div>
          )}
          {hasDualView && (
            <div
              className="dual-view-toggle"
              onClick={(e) => { e.stopPropagation(); setPriceView(v => v === 'kite' ? 'comex' : 'kite'); }}
              style={{ fontSize: '0.62rem', fontWeight: '700', color: showComex ? '#4A148C' : '#2C8E5A', background: showComex ? '#EDE7F6' : '#E9F6EF', padding: '2px 8px', borderRadius: '20px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '3px', userSelect: 'none' }}
            >
              {showComex ? '₹ COMEX ⇄ ₹ MCX' : '₹ MCX ⇄ ₹ COMEX'}
            </div>
          )}
        </div>
        <div className="instr-row__right">
          {isLoading ? (
            <div className="instr-row__ltp" style={{ color: '#9CA3AF' }}>Loading…</div>
          ) : (
            <>
              <div className="instr-row__ltp">
                <TickFlash value={ltp}>
                  {isCrypto
                    ? `₹${ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : showComex
                      ? `₹${ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : isUs
                        ? `$${ltp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : `LTP: ${ltp.toFixed(2)}`}
                </TickFlash>
              </div>
              <div className="instr-row__abs-change">
                <TickFlash value={absoluteChange}>
                  {absoluteChange >= 0 ? '+' : ''}{absoluteChange.toFixed(2)}
                </TickFlash>
              </div>
              <div className={`instr-row__pct-change ${getPctClass(percentChange)}`}>
                {percentChange >= 0 ? '+' : ''}{percentChange.toFixed(2)}%
              </div>
            </>
          )}
        </div>
        <div className="wc-checkbox-wrapper" style={{ display: 'none' }}>
          <input type="checkbox" className="wc-checkbox" onClick={(e) => e.stopPropagation()} />
        </div>
      </div>
    </div>
  );
}
