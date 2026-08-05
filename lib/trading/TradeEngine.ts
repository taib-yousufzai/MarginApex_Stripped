import { getAdminClient } from '@/lib/adminClient';
import { fetchBinanceQuote, fetchKiteQuotes } from '../datafeed/MarketDataService';
import { calculateBufferedPrice } from './BufferCalculator';
import { calculateMarginPortion } from './MarginCalculator';
import { calculateSingleLegCharge } from './BrokerageCalculator';
import { RiskValidation } from './RiskValidation';
import { OrderService } from './OrderService';
import { ExecutionService, ExecutionParams } from './ExecutionService';
import { ConfigurationService } from './ConfigurationService';
import { mapSegmentToDbSegment, mapSymbolToSegment } from './SymbolMapping';
import { SymbolNormalizer } from './SymbolNormalizer';
import { getLotSizeFallback } from '@/lib/lotSize';
import { parseOptionSymbol } from '../positionStore';
import { calculateFreeMarginFromPositions } from '@/lib/floatingPnl';

export interface PlaceOrderRequest {
  symbol: string;
  kite_instrument: string;
  segment: string;
  side: 'BUY' | 'SELL';
  order_type: 'MARKET' | 'LIMIT' | 'SL' | 'SLM' | 'GTT';
  product_type: 'INTRADAY' | 'CARRY';
  qty: number;
  lots: number;
  client_price?: number;
  trigger_price?: number;
  stop_loss?: number;
  target?: number;
  is_exit?: boolean;
  linked_position_id?: string;
}

export class TradeEngine {
  
  static async placeOrder(user: any, request: PlaceOrderRequest, ipAddress: string) {
    const admin = getAdminClient();
    let { symbol, kite_instrument: kiteInst, segment, side, order_type, product_type, qty, lots, client_price, trigger_price, stop_loss, target, is_exit, linked_position_id } = request;
    
    is_exit = is_exit === true || (is_exit as any) === 'true';
    kiteInst = kiteInst || symbol || '';

    let dbSegment = mapSegmentToDbSegment(segment);
    const symUp = symbol.toUpperCase();

    // 1. Initial Profile Fetch handled entirely within get_trade_context later!
    // But we need to early exit if no user... Wait, user is already verified by API layer.
    // Let's just resolve segment first.
    if (dbSegment === 'CRYPTO' || ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'].some(c => symUp === c || symUp.startsWith(c + 'USDT'))) {
       dbSegment = 'CRYPTO';
       const kiUpper = kiteInst.toUpperCase();
       kiteInst = kiUpper.endsWith('USDT') ? kiUpper : kiUpper + 'USDT';
       // Keep `symbol` in the same format as stored in DB (e.g. BTCUSDT or BTC)
    } else if (dbSegment !== 'COMEX' && (symUp.includes('GOLD') || symUp.includes('SILVER') || symUp.includes('CRUDE') || symUp.includes('NATGAS') || symUp.includes('NATURALGAS'))) {
       dbSegment = (symUp.endsWith('CE') || symUp.endsWith('PE')) ? 'MCX-OPT' : 'MCX-FUT';
     } else if (!dbSegment) {
       // Only fallback if not mapped from UI segment
       dbSegment = mapSymbolToSegment(symbol);
    }

    // Determine segments for market hours
    const segUpper = dbSegment.toUpperCase();
    let segmentId = 'nse';
    if (segUpper.includes('MCX')) segmentId = 'mcx';
    else if (segUpper.includes('BSE') || segUpper.includes('BFO')) segmentId = 'bse';
    else if (segUpper.includes('CDS') || segUpper.includes('FOREX')) segmentId = 'forex';
    else if (segUpper.includes('COMEX')) segmentId = 'comex';
    else if (segUpper.includes('CRYPTO')) segmentId = 'crypto';

    // ── Resolve kiteInst to a fully-qualified Kite key (EXCHANGE:TRADINGSYMBOL) ──
    // When exiting from the positions page, the positions table has no
    // kite_instrument column, so kiteInst falls back to the raw `symbol`
    // (e.g. "CRUDEOIL_FUT"). We must resolve it to a valid Kite key before
    // the quote fetch, otherwise the price lookup will fail.
    if (kiteInst && !kiteInst.includes(':')) {
      const kiUpper = kiteInst.toUpperCase();
      if (segUpper.includes('MCX') || segUpper.includes('CDS') || segUpper.includes('FOREX')) {
        // COMEX/FOREX synthetic symbols like CRUDEOIL_FUT or JPYINR_FUT → strip _FUT and resolve
        // to the nearest active futures contract
        const prefix = segUpper.includes('MCX') ? 'MCX' : 'CDS';
        let baseName = kiUpper;
        if (baseName.endsWith('_FUT')) baseName = baseName.slice(0, -4);
        
        const cacheKey = `nearest_fut_${prefix}_${baseName}`;
        const { getRedisClient } = require('@/lib/redis');
        const redis = getRedisClient();
        
        let resolvedSymbol = await redis.get(cacheKey);
        
        if (!resolvedSymbol) {
          const { data: nearestFut } = await admin
            .from('instruments')
            .select('tradingsymbol')
            .eq('name', baseName)
            .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
            .gte('expiry', new Date().toISOString().split('T')[0])
            .order('expiry', { ascending: true })
            .limit(1)
            .maybeSingle();
            
          if (nearestFut?.tradingsymbol) {
            resolvedSymbol = nearestFut.tradingsymbol;
            await redis.setex(cacheKey, 3600, resolvedSymbol); // Cache for 1 hour
          }
        }
        
        if (resolvedSymbol) {
          kiteInst = `${prefix}:${resolvedSymbol}`;
        } else {
          kiteInst = `${prefix}:${kiteInst}`;
        }
      } else if (segUpper.includes('BSE') || segUpper.includes('BFO')) {
        kiteInst = `BFO:${kiteInst}`;
        if (!kiteInst.match(/\d/)) kiteInst = `BSE:${kiUpper}`; // bare index
      } else if (segUpper.includes('OPT') || segUpper.includes('FUT') || segUpper.includes('NFO')) {
        kiteInst = `NFO:${kiteInst}`;
        if (!kiteInst.match(/\d/)) kiteInst = `NSE:${kiUpper}`; // bare index
      }
    }

    const isOption = dbSegment.includes('OPT');
    let underlyingId = 'NSE:NIFTY 50';
    
    if (isOption) {
      const parsed = parseOptionSymbol(symbol);
      const u = parsed?.underlying || 'NIFTY';
      
      if (u === 'BANKNIFTY') underlyingId = 'NSE:NIFTY BANK';
      else if (u === 'FINNIFTY') underlyingId = 'NSE:NIFTY FIN SERVICE';
      else if (u === 'SENSEX') underlyingId = 'BSE:SENSEX';
      else if (u === 'BANKEX') underlyingId = 'BSE:BANKEX';
      else if (u === 'MIDCPNIFTY') underlyingId = 'NSE:NIFTY MID SELECT';
      else if (u !== 'NIFTY') underlyingId = `NSE:${u}`;
    }

    const symbolsToFetch = [
      dbSegment === 'CRYPTO' ? SymbolNormalizer.normalizeCryptoSymbol(symbol) : symbol,
      kiteInst,
      underlyingId
    ];

    // Single DB Round-Trip for all user context, positions, and instrument settings
    const [
      tradeContextResult,
      marketHoursResult,
      segmentSettingsResult,
      quotesMap
    ] = await Promise.all([
      admin.rpc('get_trade_context_v1', { p_user_id: user.id, p_symbols: symbolsToFetch }),
      ConfigurationService.getMarketHours(segmentId),
      ConfigurationService.getSegmentSettings(dbSegment),
      (async () => {
        if (dbSegment === 'CRYPTO') {
          const q = await fetchBinanceQuote(symbol);
          if (!q) return {};
          // Store under both `symbol` (e.g. BTC) and `kiteInst` (e.g. BTCUSDT)
          // so the price lookup at quotesMap[kiteInst] succeeds
          const map: Record<string, number> = {
            [symbol]: q.bid, [`${symbol}_bid`]: q.bid, [`${symbol}_ask`]: q.ask,
          };
          if (kiteInst && kiteInst !== symbol) {
            map[kiteInst] = q.bid;
            map[`${kiteInst}_bid`] = q.bid;
            map[`${kiteInst}_ask`] = q.ask;
          }
          return map;
        }
        const instrumentsToFetch = [kiteInst];
        if (isOption && underlyingId !== kiteInst) instrumentsToFetch.push(underlyingId);
        return fetchKiteQuotes(instrumentsToFetch);
      })()
    ]);

    if (tradeContextResult.error) {
      throw new Error(`Failed to fetch trade context: ${tradeContextResult.error.message}`);
    }

    const ctx = tradeContextResult.data;
    const profile = ctx.profile;
    
    if (!profile) throw new Error('User profile not found.');
    if (!profile.active) throw new Error('Account is inactive');

    // Database segments use format like 'NSE-EQ', 'MCX-FUT', 'CRYPTO'.
    // TradeEngine segmentId uses short codes: 'nse', 'mcx', 'crypto', etc.
    // Map each segmentId to the DB segment values that grant access to it.
    const SEGMENT_MAP: Record<string, string[]> = {
      nse:    ['NSE-EQ', 'NSE-FUT', 'INDEX-FUT', 'INDEX-OPT', 'STOCK-FUT', 'STOCK-OPT'],
      mcx:    ['MCX-FUT', 'MCX-OPT'],
      bse:    ['BSE-EQ', 'BSE-FUT', 'BFO-FUT', 'BFO-OPT'],
      forex:  ['FOREX', 'CDS-FUT', 'CDS-OPT'],
      crypto: ['CRYPTO'],
      comex:  ['COMEX'],
    };
    const allowedDbSegments = SEGMENT_MAP[segmentId] ?? [segmentId.toUpperCase()];
    const userSegments: string[] = profile.segments ?? [];
    if (!allowedDbSegments.some((s: string) => userSegments.includes(s))) {
      throw new Error('Segment is not enabled for this account');
    }

    const openPositions = ctx.open_positions || [];
    const pendingOrders = ctx.pending_orders || [];
    const instrumentDetail = ctx.instruments?.find((i: any) => i.tradingsymbol === kiteInst || i.tradingsymbol === symbol);
    
    // Fallbacks from script settings if instrument table is missing data
    const scriptSetting = ctx.script_settings?.find((s: any) => s.symbol === symbol || s.symbol === kiteInst || s.symbol === underlyingId);
    let symbolLotSize = Number(instrumentDetail?.lot_size || scriptSetting?.lot_size || getLotSizeFallback(symbol, ctx.script_settings));

    const isBlocked = ctx.is_blocked?.some((b: any) => b.symbol === symbol || b.symbol === kiteInst);
    
    if (isBlocked) {
      throw new Error('Trading Not Allowed In This Script. Please Contact Admin.');
    }
    const isCarry = product_type === 'CARRY';

    // Fetch per-user segment settings to get actual commission_type/commission_value.
    // The global ConfigurationService.getSegmentSettings() returns a different table
    // (segment-level admin config) and has commission_value = 0.
    // The real per-user settings are in segment_settings / scalper_segment_settings
    // filtered by user_id and segment.
    const tradingMode = profile.trading_mode || 'normal';
    const settingsTable = tradingMode === 'scalper' ? 'scalper_segment_settings' : 'segment_settings';
    const { data: userSegRows } = await admin
      .from(settingsTable)
      .select('side, trade_allowed, max_lot, max_order_lot, intraday_leverage, holding_leverage, intraday_type, holding_type, commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value, profit_hold_sec, loss_hold_sec, strike_range, entry_buffer, exit_buffer, top_limit, min_limit, intraday_commission_type, intraday_commission_value')
      .eq('user_id', user.id)
      .eq('segment', dbSegment);

    const userBuySetting  = userSegRows?.find((s: any) => s.side === 'BUY')  ?? null;
    const userSellSetting = userSegRows?.find((s: any) => s.side === 'SELL') ?? null;

    // Merge: user-specific settings take priority over global fallback defaults
    let buySetting = { side: 'BUY', trade_allowed: true, max_lot: 50, max_order_lot: 50, intraday_leverage: 10, holding_leverage: 10, intraday_type: 'Multiplier', holding_type: 'Multiplier', commission_type: 'Per Crore', commission_value: 0, ...segmentSettingsResult, ...(userBuySetting ?? {}) };
    let sellSetting = { side: 'SELL', trade_allowed: true, max_lot: 50, max_order_lot: 50, intraday_leverage: 10, holding_leverage: 10, intraday_type: 'Multiplier', holding_type: 'Multiplier', commission_type: 'Per Crore', commission_value: 0, ...segmentSettingsResult, ...(userSellSetting ?? {}) };
    
    const segSetting = side === 'BUY' ? buySetting : sellSetting;

    // 1b. Check Instrument Blocked Status again just in case the name logic caught it
    if (instrumentDetail?.name && isBlocked) {
      throw new Error('Trading Not Allowed In This Script. Please Contact Admin.');
    }

    if (segmentId !== 'crypto' && !RiskValidation.validateTradingHours(marketHoursResult)) {
      throw new Error('market is closed');
    }

    if (!segSetting || !segSetting.trade_allowed) {
      throw new Error('Trading Not Allowed In This Script. Please Contact Admin.');
    }

    // Expiry Check
    if (!is_exit && !dbSegment.includes('CRYPTO') && instrumentDetail?.expiry) {
      const expiryDay = new Date(instrumentDetail.expiry);
      expiryDay.setHours(0,0,0,0);
      const todayDay = new Date();
      todayDay.setHours(0,0,0,0);
      if (expiryDay.getTime() < todayDay.getTime()) {
        throw new Error('This contract has expired. You cannot open new positions.');
      }
    }

    // Lot Size & Quantity Validation
    if (!symbolLotSize || symbolLotSize <= 0) {
      throw new Error('Invalid lot size for symbol');
    }

    if (!RiskValidation.validateLotSize(qty, symbolLotSize)) {
      throw new Error(`Quantity must be a multiple of lot size (${symbolLotSize})`);
    }

    const maxQty = Number(segSetting.max_order_lot || 50) * symbolLotSize;
    if (!is_exit && !RiskValidation.validateFreezeQuantity(qty, maxQty)) {
      throw new Error(`Order exceeds maximum allowed order limit of ${segSetting.max_order_lot} lots (${maxQty} units)`);
    }

    // Cumulative Position limit check
    let totalOpenLots = 0;
    const ctxScriptSettings = ctx.script_settings || [];

    for (const pos of openPositions) {
      if (pos.symbol === symbol) {
        const pLot = Number(
          ctxScriptSettings.find((s: any) => s.symbol === pos.symbol)?.lot_size
          || getLotSizeFallback(pos.symbol, dbSegment)
        );
        if (pLot > 0) totalOpenLots += Number(pos.qty_open) / pLot;
      }
    }

    for (const po of pendingOrders) {
      if (!po.is_exit && po.symbol === symbol) {
        const poLot = Number(
          ctxScriptSettings.find((s: any) => s.symbol === po.symbol)?.lot_size
          || getLotSizeFallback(po.symbol, dbSegment)
        );
        if (poLot > 0) {
          totalOpenLots += Number(po.lots) > 0
            ? Number(po.lots)
            : (Number(po.qty) / poLot);
        }
      }
    }
    const newOrderLots = qty / symbolLotSize;
    if (!is_exit && !RiskValidation.validateMaxLotLimit(totalOpenLots + newOrderLots, Number(segSetting.max_lot || 50))) {
      throw new Error(`Order exceeds maximum position limit of ${segSetting.max_lot} lots for ${symbol}.`);
    }

    const activePosition = openPositions.find((p: any) => p.symbol === symbol && p.product_type === (product_type || 'INTRADAY'));
    // DB RPC place_order_v2 natively handles opposite-side netting and splitting.
    if (activePosition && activePosition.side !== side) {
      is_exit = true;
    }

    let kiteLtp = quotesMap[kiteInst] ?? null;
    let kiteBid = quotesMap[`${kiteInst}_bid`] || kiteLtp;
    let kiteAsk = quotesMap[`${kiteInst}_ask`] || kiteLtp;

    if (!kiteLtp || kiteLtp <= 0) {
      throw new Error('Could not determine market price. Try again.');
    }

    const clientPriceNum = client_price || 0;
    const limitErr = OrderService.validateLimitPrice(order_type, side, clientPriceNum, kiteLtp, is_exit);
    if (limitErr) throw new Error(limitErr);

    const slErr = OrderService.validateStopLoss(order_type, side, trigger_price || null, kiteLtp, is_exit);
    if (slErr) throw new Error(slErr);

    const targetErr = OrderService.validateTargetAndStopLoss(is_exit, (is_exit && activePosition) ? activePosition.side === 'BUY' : side === 'BUY', target || null, stop_loss || null, kiteLtp, clientPriceNum, ['LIMIT', 'SL', 'GTT'].includes(order_type));
    if (targetErr) throw new Error(targetErr);

    const limitsErr = OrderService.validateSegmentPriceLimits(order_type, clientPriceNum, kiteLtp, Number(segSetting.top_limit ?? 0), Number(segSetting.min_limit ?? 0));
    if (limitsErr) throw new Error(limitsErr);

    const strikeErr = OrderService.validateStrikeRange(symbol, isOption, Number(segSetting.strike_range || 0), quotesMap[underlyingId]);
    if (strikeErr) throw new Error(strikeErr);

    const holdErr = OrderService.validateHoldDuration(is_exit, order_type, activePosition, kiteLtp, Number(segSetting.profit_hold_sec ?? 120), Number(segSetting.loss_hold_sec ?? 0));
    if (holdErr) throw new Error(holdErr);

    const isGTT = order_type === 'GTT';
    const marginPrice = (order_type === 'LIMIT' || isGTT) ? (clientPriceNum > 0 ? clientPriceNum : kiteLtp) : (trigger_price || kiteLtp);
    const exposure = qty * marginPrice;
    
    const brokerageConfig = await ConfigurationService.getBrokerageConfig(user.id, dbSegment);
    let marginPortion = 0;
    
    let brokerage = 0;

    const isCustomCalc = side === 'BUY' ? buySetting?.use_custom_calc : sellSetting?.use_custom_calc;

    if (!is_exit) {
      marginPortion = calculateMarginPortion({
        segment: dbSegment,
        side,
        leverageType: isCarry ? (segSetting.holding_type ?? 'Multiplier') : (segSetting.intraday_type ?? 'Multiplier'),
        leverage: isCarry ? (segSetting.holding_leverage ?? 10) : (segSetting.intraday_leverage ?? 10),
        totalQty: qty,
        lotSize: symbolLotSize,
        baseExposure: exposure
      });

      // Brokerage logic:
      //   - Entry brokerage + exit brokerage are both charged at position open time (× 2)
      //   - No brokerage is charged again when the position is closed
      //   - Carry brokerage is separate and charged at INTRADAY → CARRY conversion
      const commType = segSetting.intraday_commission_type || segSetting.commission_type || 'Per Crore';
      const commVal = Number(segSetting.intraday_commission_value ?? segSetting.commission_value ?? 0);
      const singleLeg = calculateSingleLegCharge({ exposure, lots: newOrderLots, commissionType: commType, commissionValue: commVal });
      brokerage = Math.round(singleLeg * 2 * 100) / 100; // both legs up front
    } else {
      // Exit order: brokerage was already collected at position open — charge nothing
      brokerage = 0;
    }

    if (dbSegment === 'CRYPTO' && isCustomCalc) {
      brokerage = 0; // custom calc zeroes out separate brokerage
    }

    const requiredMargin = marginPortion + brokerage;

    // Validation is delegated to database RPC place_order_v2


    // 4. Execution Price Calculation (BufferCalculator)
    
    // Normalize custom calculation base price (bid/ask vs ltp)
    let executionBasePrice = kiteLtp;
    if (dbSegment === 'CRYPTO' && isCustomCalc) {
      executionBasePrice = (side === 'BUY' && !is_exit) || (side === 'SELL' && is_exit) ? kiteAsk : kiteBid;
      brokerage = 0; // Baked into price for custom calc
    } else {
      executionBasePrice = (side === 'BUY' && !is_exit) || (side === 'SELL' && is_exit) ? kiteAsk : kiteBid;
    }

    let fillPrice = calculateBufferedPrice({
       side,
       isExit: is_exit,
       basePrice: ['LIMIT', 'SL', 'GTT'].includes(order_type) ? clientPriceNum : executionBasePrice,
       buySetting,
       sellSetting,
       brokeragePerUnit: (dbSegment === 'CRYPTO' && isCustomCalc && qty > 0) ? (brokerage / qty) : 0
    });

    fillPrice = Math.max(0.01, Math.round(fillPrice * 100) / 100);

    const isImmediate = order_type === 'MARKET' || order_type === 'SLM';

    // 5. Execute Order (ExecutionService)
    const executionParams: ExecutionParams = {
      userId: user.id,
      symbol,
      kiteInst,
      dbSegment,
      side,
      orderType: order_type,
      productType: product_type || 'INTRADAY',
      qty,
      lots: newOrderLots,
      baseLtp: kiteLtp,
      fillPrice,
      bufferFee: 0,
      triggerPrice: trigger_price || null,
      stopLoss: stop_loss || null,
      target: target || null,
      isExit: is_exit,
      linkedPositionId: linked_position_id,
      isImmediate,
      requiredMargin,
      brokerage
    };

    const orderId = await ExecutionService.executeOrder(executionParams);

    // 6. Return response to API route
    return {
      order_id: orderId,
      status: isImmediate ? 'EXECUTED' : 'PENDING',
      fill_price: fillPrice,
      message: `${side} order placed at ₹${fillPrice.toFixed(2)}`,
    };
  }
}
