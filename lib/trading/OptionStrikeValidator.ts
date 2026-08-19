import { getAdminClient } from '@/lib/adminClient';
import { parseOptionSymbol } from '@/lib/parseOptionSymbol';
import { fetchSpeedQuotes, fetchKiteQuotes } from '@/lib/datafeed/MarketDataService';
import { getCenteredStrikeWindow } from '@/lib/trading/optionStrikeWindow';

export interface StrikeValidationResult {
  allowed: boolean;
  orderStrike: number;
  minAllowed: number;
  maxAllowed: number;
  reason?: string;
}

const MCX_UNDERLYINGS = new Set([
  'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'SILVERMIC',
  'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI',
  'COPPER', 'ZINC', 'ZINCMINI', 'LEAD', 'LEADMINI',
  'ALUMINIUM', 'ALUMINI',
]);

const MCX_BASE_MAP: Record<string, string> = {
  'GOLDM': 'GOLD', 'SILVERM': 'SILVER', 'SILVERMIC': 'SILVER',
  'CRUDEOILM': 'CRUDEOIL', 'NATGASMINI': 'NATURALGAS',
  'ALUMINI': 'ALUMINIUM', 'ZINCMINI': 'ZINC', 'LEADMINI': 'LEAD',
};

/**
 * Resolves the underlying Kite instrument key for an option symbol.
 */
export async function resolveUnderlyingKiteId(symbol: string, underlying: string): Promise<string> {
  const undUpper = underlying.toUpperCase();
  const isMcx = MCX_UNDERLYINGS.has(undUpper);

  if (isMcx) {
    const baseName = MCX_BASE_MAP[undUpper] || undUpper;
    const admin = getAdminClient();
    const today = new Date().toISOString().split('T')[0];

    const { data: mcxFuts } = await admin
      .from('instruments')
      .select('tradingsymbol, exchange')
      .eq('name', baseName)
      .eq('segment', 'MCX-FUT')
      .gte('expiry', today)
      .order('expiry', { ascending: true })
      .limit(1);

    if (mcxFuts?.[0]?.tradingsymbol) {
      return `${mcxFuts[0].exchange || 'MCX'}:${mcxFuts[0].tradingsymbol}`;
    }
    return `MCX:${baseName}`;
  }

  if (undUpper === 'BANKNIFTY') return 'NSE:NIFTY BANK';
  if (undUpper === 'FINNIFTY') return 'NSE:NIFTY FIN SERVICE';
  if (undUpper === 'SENSEX') return 'BSE:SENSEX';
  if (undUpper === 'BANKEX') return 'BSE:BANKEX';
  if (undUpper === 'MIDCPNIFTY') return 'NSE:NIFTY MID SELECT';
  if (undUpper === 'NIFTY') return 'NSE:NIFTY 50';
  return `NSE:${undUpper}`;
}

/**
 * Validates an option order strike price against the active 11-strike option-chain window
 * and any configured per-user strike_range.
 */
export async function validateOptionStrike(params: {
  symbol: string;
  isExit?: boolean;
  strikeRangeSetting?: number;
  knownQuotesMap?: Record<string, any>;
}): Promise<StrikeValidationResult> {
  const { symbol, isExit, strikeRangeSetting = 0, knownQuotesMap } = params;

  // Exit orders always bypass strike range validation
  if (isExit) {
    return { allowed: true, orderStrike: 0, minAllowed: 0, maxAllowed: 0 };
  }

  const parsed = parseOptionSymbol(symbol);
  if (!parsed || parsed.strike <= 0) {
    return { allowed: true, orderStrike: 0, minAllowed: 0, maxAllowed: 0 };
  }

  const { underlying, strike: orderStrike } = parsed;
  const admin = getAdminClient();
  const cleanSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;

  // 1. Fetch contract instrument row to get exact name, expiry, and exchange
  const { data: instrRow } = await admin
    .from('instruments')
    .select('name, expiry, exchange')
    .or(`tradingsymbol.eq.${cleanSymbol},tradingsymbol.eq.${symbol}`)
    .limit(1)
    .maybeSingle();

  if (!instrRow?.expiry) {
    return { allowed: true, orderStrike, minAllowed: 0, maxAllowed: 0 };
  }

  // 2. Fetch sibling contract strikes for the exact underlying, expiry, and exchange
  const { data: siblingRows } = await admin
    .from('instruments')
    .select('strike_price')
    .eq('name', instrRow.name || underlying)
    .eq('expiry', instrRow.expiry)
    .eq('exchange', instrRow.exchange || 'MCX')
    .in('option_type', ['CE', 'PE']);

  if (!siblingRows || siblingRows.length === 0) {
    return { allowed: true, orderStrike, minAllowed: 0, maxAllowed: 0 };
  }

  const rawStrikes = siblingRows.map(s => ({ strike: Number(s.strike_price) })).filter(s => s.strike > 0);
  const strikeMap = new Map<number, { strike: number }>();
  rawStrikes.forEach(s => strikeMap.set(s.strike, s));
  const sortedStrikes = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);

  if (sortedStrikes.length === 0) {
    return { allowed: true, orderStrike, minAllowed: 0, maxAllowed: 0 };
  }

  // 3. Resolve live spot price
  const underlyingKiteId = await resolveUnderlyingKiteId(symbol, underlying);
  const baseSymbol = underlying.toUpperCase();
  const mcxBase = MCX_BASE_MAP[baseSymbol] || baseSymbol;

  let underlyingPrice = 0;
  if (knownQuotesMap) {
    const candidates = [underlyingKiteId, `MCX:${mcxBase}`, `MCX:${baseSymbol}`, baseSymbol, symbol];
    for (const key of candidates) {
      const raw = knownQuotesMap[key];
      if (raw !== undefined) {
        const val = typeof raw === 'number' ? raw : (raw?.last_price ?? raw?.lastPrice ?? 0);
        if (val > 0) {
          underlyingPrice = val;
          break;
        }
      }
    }
  }

  if (!underlyingPrice || underlyingPrice <= 0) {
    try {
      const speedMap = await fetchSpeedQuotes([underlyingKiteId, `MCX:${mcxBase}`]);
      underlyingPrice = speedMap?.[underlyingKiteId] || speedMap?.[`MCX:${mcxBase}`] || 0;
    } catch { /* ignore */ }
  }

  if (!underlyingPrice || underlyingPrice <= 0) {
    try {
      const restMap = await fetchKiteQuotes([underlyingKiteId, `MCX:${mcxBase}`]);
      underlyingPrice = restMap?.[underlyingKiteId] || restMap?.[`MCX:${mcxBase}`] || 0;
    } catch { /* ignore */ }
  }

  // FAIL OPEN: If live spot price cannot be retrieved (> 0), never block orders
  if (!underlyingPrice || underlyingPrice <= 0 || isNaN(underlyingPrice)) {
    return { allowed: true, orderStrike, minAllowed: 0, maxAllowed: 0 };
  }

  // 4. Compute canonical 11-strike active option chain window using getCenteredStrikeWindow
  const { centeredStrikes } = getCenteredStrikeWindow(sortedStrikes, underlyingPrice);

  if (centeredStrikes.length === 0) {
    return { allowed: true, orderStrike, minAllowed: 0, maxAllowed: 0 };
  }

  const minVisible = centeredStrikes[0].strike;
  const maxVisible = centeredStrikes[centeredStrikes.length - 1].strike;
  const isVisibleInChain = centeredStrikes.some(s => s.strike === orderStrike);

  // If visible in the active option chain window, ALWAYS ALLOW
  if (isVisibleInChain) {
    return { allowed: true, orderStrike, minAllowed: minVisible, maxAllowed: maxVisible };
  }

  // If user has a configured distance-based strike_range (> 0), check distance from spot
  if (strikeRangeSetting > 0) {
    const diff = Math.abs(orderStrike - underlyingPrice);
    if (diff <= strikeRangeSetting) {
      return { allowed: true, orderStrike, minAllowed: minVisible, maxAllowed: maxVisible };
    }
  }

  // Strike is outside both the visible 11-strike option-chain window and the configured range
  return {
    allowed: false,
    orderStrike,
    minAllowed: minVisible,
    maxAllowed: maxVisible,
    reason: `Strike price ${orderStrike} is outside the allowed active option chain window (${minVisible} to ${maxVisible}).`,
  };
}
