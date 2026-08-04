'use client';

import React, { useState } from 'react';

interface Instrument {
  name: string;
  symbol: string;
  segment: string;
}

interface Segment {
  name: string;
  icon: string;
  count: number;
  subCategories?: { name: string; instruments: Instrument[] }[];
  instruments?: Instrument[];
}

const TRADING_SEGMENTS: Segment[] = [
  {
    name: 'Index-fut',
    icon: 'fa-chart-line',
    count: 5,
    instruments: [
      { name: 'NIFTY FUT', symbol: 'NIFTY_FUT', segment: 'NSE - Futures' },
      { name: 'SENSEX FUT', symbol: 'SENSEX_FUT', segment: 'BSE - Futures' },
      { name: 'BANKNIFTY FUT', symbol: 'BANKNIFTY_FUT', segment: 'NSE - Futures' },
      { name: 'FINNIFTY FUT', symbol: 'FINNIFTY_FUT', segment: 'NSE - Futures' },
      { name: 'MIDCAP NIFTY FUT', symbol: 'MIDCP_FUT', segment: 'NSE - Futures' },
    ]
  },
  {
    name: 'Index-opt',
    icon: 'fa-chart-gantt',
    count: 8,
    subCategories: [
      {
        name: 'NIFTY Options',
        instruments: [
          { name: 'NIFTY 22300 PE', symbol: 'NIFTY22300PE', segment: 'NSE - Options' },
          { name: 'NIFTY 22400 PE', symbol: 'NIFTY22400PE', segment: 'NSE - Options' },
          { name: 'NIFTY 22500 CE', symbol: 'NIFTY22500CE', segment: 'NSE - Options' },
          { name: 'NIFTY 22600 CE', symbol: 'NIFTY22600CE', segment: 'NSE - Options' },
          { name: 'NIFTY 22700 CE', symbol: 'NIFTY22700CE', segment: 'NSE - Options' }
        ]
      },
      {
        name: 'SENSEX Options',
        instruments: [
          { name: 'SENSEX 74100 PE', symbol: 'SENSEX741PE', segment: 'BSE - Options' },
          { name: 'SENSEX 74500 CE', symbol: 'SENSEX745CE', segment: 'BSE - Options' },
          { name: 'SENSEX 74900 CE', symbol: 'SENSEX749CE', segment: 'BSE - Options' }
        ]
      },
      {
        name: 'BANKEX Options',
        instruments: [
          { name: 'BANKEX 51800 PE', symbol: 'BANKEX518PE', segment: 'BSE - Options' },
          { name: 'BANKEX 52000 CE', symbol: 'BANKEX520CE', segment: 'BSE - Options' }
        ]
      },
      {
        name: 'BANKNIFTY Options',
        instruments: [
          { name: 'BANKNIFTY 47800 PE', symbol: 'BN47800PE', segment: 'NSE - Options' },
          { name: 'BANKNIFTY 48000 PE', symbol: 'BN48000PE', segment: 'NSE - Options' },
          { name: 'BANKNIFTY 48200 CE', symbol: 'BN48200CE', segment: 'NSE - Options' },
          { name: 'BANKNIFTY 48500 CE', symbol: 'BN48500CE', segment: 'NSE - Options' },
          { name: 'BANKNIFTY 48800 CE', symbol: 'BN48800CE', segment: 'NSE - Options' },
          { name: 'BANKNIFTY 49000 CE', symbol: 'BN49000CE', segment: 'NSE - Options' }
        ]
      },
      {
        name: 'FINNIFTY Options',
        instruments: [
          { name: 'FINNIFTY 21300 PE', symbol: 'FIN21300PE', segment: 'NSE - Options' },
          { name: 'FINNIFTY 21500 CE', symbol: 'FIN21500CE', segment: 'NSE - Options' },
          { name: 'FINNIFTY 21700 CE', symbol: 'FIN21700CE', segment: 'NSE - Options' }
        ]
      },
      {
        name: 'MID CAP NIFTY Options',
        instruments: [
          { name: 'MIDCPNIFTY 11800 CE', symbol: 'MIDCP118CE', segment: 'NSE - Options' },
          { name: 'MIDCPNIFTY 12000 CE', symbol: 'MIDCP120CE', segment: 'NSE - Options' }
        ]
      }
    ]
  },
  {
    name: 'Mcx-fut',
    icon: 'fa-coins',
    count: 3,
    instruments: [
      { name: 'GOLD FUT', symbol: 'GOLD_FUT', segment: 'MCX - Futures' },
      { name: 'SILVER FUT', symbol: 'SILVER_FUT', segment: 'MCX - Futures' },
      { name: 'CRUDEOIL FUT', symbol: 'CRUDEOIL_FUT', segment: 'MCX - Futures' }
    ]
  },
  {
    name: 'Mcx-opt',
    icon: 'fa-circle-dot',
    count: 3,
    instruments: [
      { name: 'GOLD OPT', symbol: 'GOLD_OPT', segment: 'MCX - Options' },
      { name: 'SILVER OPT', symbol: 'SILVER_OPT', segment: 'MCX - Options' },
      { name: 'CRUDEOIL OPT', symbol: 'CRUDEOIL_OPT', segment: 'MCX - Options' }
    ]
  },
  {
    name: 'Stock-fut',
    icon: 'fa-building',
    count: 3,
    instruments: [
      { name: 'RELIANCE FUT', symbol: 'RELIANCE_FUT', segment: 'NSE - Stock Futures' },
      { name: 'TCS FUT', symbol: 'TCS_FUT', segment: 'NSE - Stock Futures' },
      { name: 'HDFCBANK FUT', symbol: 'HDFCBANK_FUT', segment: 'NSE - Stock Futures' }
    ]
  },
  {
    name: 'Stock-opt',
    icon: 'fa-layer-group',
    count: 3,
    instruments: [
      { name: 'RELIANCE OPT', symbol: 'RELIANCE_OPT', segment: 'NSE - Stock Options' },
      { name: 'TCS OPT', symbol: 'TCS_OPT', segment: 'NSE - Stock Options' },
      { name: 'HDFCBANK OPT', symbol: 'HDFCBANK_OPT', segment: 'NSE - Stock Options' }
    ]
  },
  {
    name: 'Nse-eq',
    icon: 'fa-landmark',
    count: 4,
    instruments: [
      { name: 'RELIANCE', symbol: 'RELIANCE_EQ', segment: 'NSE - Equity' },
      { name: 'TCS', symbol: 'TCS_EQ', segment: 'NSE - Equity' },
      { name: 'HDFCBANK', symbol: 'HDFCBANK_EQ', segment: 'NSE - Equity' },
      { name: 'INFY', symbol: 'INFY_EQ', segment: 'NSE - Equity' }
    ]
  },
  {
    name: 'Crypto',
    icon: 'fa-bitcoin-sign',
    count: 3,
    instruments: [
      { name: 'BTC/USDT', symbol: 'BTCUSDT', segment: 'Crypto' },
      { name: 'ETH/USDT', symbol: 'ETHUSDT', segment: 'Crypto' },
      { name: 'DOGE/USDT', symbol: 'DOGEUSDT', segment: 'Crypto' }
    ]
  },
  {
    name: 'Comex',
    icon: 'fa-gem',
    count: 4,
    instruments: [
      { name: 'Gold', symbol: 'GOLD_FUT', segment: 'MCX - Futures' },
      { name: 'Silver', symbol: 'SILVER_FUT', segment: 'MCX - Futures' },
      { name: 'Crude Oil', symbol: 'CRUDEOIL_FUT', segment: 'MCX - Futures' },
      { name: 'Copper', symbol: 'COPPER_FUT', segment: 'MCX - Futures' }
    ]
  },
  {
    name: 'Forex',
    icon: 'fa-globe',
    count: 4,
    instruments: [
      { name: 'USD/INR', symbol: 'USDINR_FUT', segment: 'CDS - Futures' },
      { name: 'EUR/INR', symbol: 'EURINR_FUT', segment: 'CDS - Futures' },
      { name: 'GBP/INR', symbol: 'GBPINR_FUT', segment: 'CDS - Futures' },
      { name: 'JPY/INR', symbol: 'JPYINR_FUT', segment: 'CDS - Futures' }
    ]
  }
];

interface TradingSegmentsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect?: (item: any) => void;
}

export default function TradingSegmentsDrawer({ isOpen, onClose, onSelect }: TradingSegmentsDrawerProps) {
  const [mounted, setMounted] = React.useState(false);
  const [expandedSegment, setExpandedSegment] = useState<string | null>(null);
  const [expandedSubcategories, setExpandedSubcategories] = useState<Record<string, boolean>>({});
  const [allowedSegments, setAllowedSegments] = useState<string[]>([]);

  React.useEffect(() => {
    setMounted(true);
    const fetchAllowedSegments = async () => {
      try {
        const { api } = await import('@/lib/api');
        const profile = await api.get<{ segments?: string[] }>('/api/user/profile');
        if (profile && profile.segments) {
          setAllowedSegments(profile.segments);
        }
      } catch (err) {
        console.error('Failed to fetch allowed segments', err);
      }
    };
    fetchAllowedSegments();
  }, []);

  if (!mounted) return null;

  const handleSegmentClick = (name: string) => {
    setExpandedSegment(expandedSegment === name ? null : name);
  };

  // Map drawer segment names to the DB segment keys stored in profile.segments
  const SEGMENT_NAME_TO_DB_KEY: Record<string, string> = {
    'Index-fut':   'INDEX-FUT',
    'Index-opt':  'INDEX-OPT',
    'Mcx-fut':     'MCX-FUT',
    'Mcx-opt':    'MCX-OPT',
    'Stock-fut':  'STOCK-FUT',
    'Stock-opt': 'STOCK-OPT',
    'Nse-eq':     'NSE-EQ',
    'Crypto':           'CRYPTO',
    'Comex':            'COMEX',
    'Forex':            'FOREX',
  };

  const visibleSegments = TRADING_SEGMENTS.filter(seg => {
    if (allowedSegments.length === 0) return true;
    const dbKey = SEGMENT_NAME_TO_DB_KEY[seg.name] ?? seg.name.toUpperCase();
    return allowedSegments.includes(dbKey);
  });

  return (
    <>
      <div 
        className={`lib-overlay ${isOpen ? 'active' : ''}`} 
        onClick={onClose}
      />
      <div className={`lib-drawer ${isOpen ? 'open' : ''}`}>
        <div className="lib-header">
          <div className="lib-title-grp">
            <i className="fas fa-folder lib-folder-icon"></i>
            <h3 className="lib-main-title">Trading Segments</h3>
          </div>
          <button className="lib-close-x" onClick={onClose}>
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div className="lib-scroll-content">
          {visibleSegments.map((seg) => (
            <div key={seg.name} className="lib-seg-group">
              <div 
                className={`lib-seg-header ${expandedSegment === seg.name ? 'is-expanded' : ''}`}
                onClick={() => handleSegmentClick(seg.name)}
              >
                <i className={`fas fa-chevron-right lib-arrow ${expandedSegment === seg.name ? 'is-down' : ''}`}></i>
                <div className="lib-seg-info">
                  <i className={`fas ${seg.icon} lib-seg-icon`}></i>
                  <span className="lib-seg-name">{seg.name}</span>
                </div>
                <span className="lib-seg-count">{seg.count}</span>
              </div>

              {expandedSegment === seg.name && (
                <div className="lib-seg-children">
                  {seg.instruments?.map(inst => (
                    <div key={inst.symbol} className="lib-inst-item" onClick={() => onSelect?.(inst)}>
                      <span className="lib-inst-name">{inst.name}</span>
                      <button className="lib-add-btn">+ Add</button>
                    </div>
                  ))}
                  {seg.subCategories?.map(sub => {
                    const isSubOpen = !!expandedSubcategories[sub.name];
                    return (
                    <div key={sub.name} className="lib-subcat">
                      <div 
                        className="lib-subcat-header"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedSubcategories(prev => ({ ...prev, [sub.name]: !isSubOpen }));
                        }}
                      >
                        <i 
                          className={`fas fa-chevron-right lib-arrow ${isSubOpen ? 'is-down' : ''}`}
                          style={{ fontSize: '0.55rem', marginRight: '6px' }}
                        ></i>
                        {sub.name}
                      </div>
                      {isSubOpen && sub.instruments.map(inst => (
                        <div key={inst.symbol} className="lib-inst-item" onClick={() => onSelect?.(inst)}>
                          <span className="lib-inst-name">{inst.name}</span>
                          <button className="lib-add-btn">+ Add</button>
                        </div>
                      ))}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="lib-footer">
          <p><i className="fas fa-plus-circle"></i> Tap <span className="lib-red-text">+ Add</span> to watchlist | Browse all segments</p>
        </div>
      </div>

      <style jsx>{`
        .lib-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(4px);
          opacity: 0;
          visibility: hidden;
          transition: all 0.3s ease;
          z-index: 10000;
        }
        .lib-overlay.active {
          opacity: 1;
          visibility: visible;
        }

        .lib-drawer {
          position: fixed;
          top: 0;
          right: -420px;
          width: 100%;
          max-width: 400px;
          height: 100vh;
          background: #ffffff;
          z-index: 10001;
          transition: right 0.4s cubic-bezier(0.16, 1, 0.3, 1);
          display: flex;
          flex-direction: column;
          box-shadow: -10px 0 50px rgba(0,0,0,0.2);
        }
        .lib-drawer.open {
          right: 0;
        }

        .lib-header {
          padding: 24px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #f0f3f6;
          background: #fff;
        }

        .lib-title-grp {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .lib-folder-icon { color: #C62E2E; font-size: 1.25rem; }
        .lib-main-title { 
            margin: 0 !important; 
            font-size: 1.1rem !important; 
            font-weight: 800 !important; 
            color: #1a1a1a !important;
            text-transform: none !important;
            letter-spacing: normal !important;
        }

        .lib-close-x {
          background: #f3f4f6;
          border: none;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #4b5563;
          cursor: pointer;
          font-size: 1rem;
        }

        .lib-scroll-content {
          flex: 1;
          overflow-y: auto;
          padding: 10px 0;
          background: #fff;
        }

        .lib-seg-header {
          padding: 16px 20px;
          display: flex;
          align-items: center;
          cursor: pointer;
          transition: background 0.2s;
          border-bottom: 1px solid #f9fafb;
        }
        .lib-seg-header:hover { background: #f9fafb; }

        .lib-arrow {
          font-size: 0.7rem;
          color: #9ca3af;
          margin-right: 14px;
          transition: transform 0.2s;
        }
        .lib-arrow.is-down { transform: rotate(90deg); }

        .lib-seg-info {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .lib-seg-icon { font-size: 1.05rem; color: #C62E2E; width: 24px; text-align: center; }
        .lib-seg-name { font-size: 0.85rem; font-weight: 700; color: #1f2937; }

        .lib-seg-count {
          background: #f3f4f6;
          color: #6b7280;
          font-size: 0.7rem;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 10px;
        }

        .lib-seg-children {
          background: #fcfcfd;
          border-bottom: 1px solid #f3f4f6;
        }

        .lib-subcat-header {
          padding: 12px 20px 8px 40px;
          font-size: 0.7rem;
          font-weight: 800;
          color: #9ca3af;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          display: flex;
          align-items: center;
          cursor: pointer;
        }
        .lib-subcat-header:hover { color: #6b7280; }

        .lib-inst-item {
          padding: 12px 20px 12px 58px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: pointer;
          transition: background 0.2s;
        }
        .lib-inst-item:hover { background: #f3f4f6; }
        .lib-inst-name { font-size: 0.85rem; font-weight: 600; color: #374151; }

        .lib-add-btn {
          background: #fff;
          border: 1px solid #e5e7eb;
          padding: 5px 12px;
          border-radius: 8px;
          font-size: 0.7rem;
          font-weight: 700;
          color: #C62E2E;
          cursor: pointer;
          transition: all 0.2s;
        }
        .lib-add-btn:hover { background: #C62E2E; color: #fff; border-color: #C62E2E; }

        .lib-footer {
          padding: 18px 20px;
          border-top: 1px solid #f0f3f6;
          font-size: 0.75rem;
          color: #6b7280;
          font-weight: 600;
          background: #fff;
        }
        .lib-red-text { color: #C62E2E; }

        /* Dark Mode */
        :global(.dark) .lib-drawer, 
        :global(.dark) .lib-header,
        :global(.dark) .lib-scroll-content,
        :global(.dark) .lib-footer { background: #111827; border-color: #1f2937; }
        
        :global(.dark) .lib-main-title,
        :global(.dark) .lib-seg-name { color: #f9fafb !important; }
        
        :global(.dark) .lib-inst-name { color: #d1d5db; }
        :global(.dark) .lib-seg-header:hover { background: #1f2937; }
        :global(.dark) .lib-seg-children { background: #0b0f1a; border-color: #1f2937; }
        :global(.dark) .lib-inst-item:hover { background: #1f2937; }
        :global(.dark) .lib-add-btn { background: #1f2937; border-color: #374151; }
        :global(.dark) .lib-seg-count { background: #374151; color: #9ca3af; }
        :global(.dark) .lib-close-x { background: #1f2937; color: #9ca3af; }
      `}</style>
    </>
  );
}
