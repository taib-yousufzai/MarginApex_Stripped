# Old vs New Order Execution - Key Differences

## High-Level Architecture

### OLD ROUTE (Before Centralization - Still in git commit 85d3993)
- Monolithic single file: `app/api/orders/route.ts`
- All logic inline: validation, margin calc, fill price, DB call
- Directly calls `place_order()` RPC
- ~900 lines all in one file

### NEW ROUTE (After Centralization - Current - TradeEngine)
- Modular architecture:
  - `app/api/orders/route.ts` - REST handler, delegates to TradeEngine
  - `lib/trading/TradeEngine.ts` - Core order logic
  - `lib/trading/ExecutionService.ts` - Executes via RPC
  - `lib/trading/BufferCalculator.ts` - Fill price calculation
  - `lib/trading/OrderService.ts` - Validation rules
- Calls `place_order_v2()` RPC (newer version)
- ~200 lines in route, ~600 in TradeEngine

---

## Fill Price Calculation (Most Critical Difference)

### OLD ROUTE
```typescript
// For MARKET/SLM orders, inline calculation:

if (side === 'BUY') {
  if (is_exit) {
    // Exiting SELL/Short → Ask + exitBuffer
    fillPrice = (baseLtp * 1.001) * (1 + sellExitBuffer);
  } else {
    // Long Entry → Ask + entryBuffer
    fillPrice = (baseLtp * 1.001) * (1 + buyEntryBuffer);
  }
} else { // SELL
  if (is_exit) {
    // Exiting BUY/Long → Bid - exitBuffer
    fillPrice = (baseLtp * 0.999) * (1 - buyExitBuffer);
  } else {
    // Short Entry → Bid - entryBuffer
    fillPrice = (baseLtp * 0.999) * (1 - sellEntryBuffer);
  }
}

// buffers come from DB directly: 0.0017, 0.003
// NO division by 100 ✓ CORRECT
```

### NEW ROUTE (TradeEngine)
```typescript
// Delegated to BufferCalculator.calculateBufferedPrice():

export function calculateBufferedPrice({
  side, isExit, basePrice, buySetting, sellSetting, brokeragePerUnit
}) {
  const buyEntryBuffer  = buySetting?.entry_buffer  ?? 0.003;
  const buyExitBuffer   = buySetting?.exit_buffer   ?? 0.0017;
  const sellEntryBuffer = sellSetting?.entry_buffer ?? 0.003;
  const sellExitBuffer  = sellSetting?.exit_buffer  ?? 0.0017;

  if (side === 'BUY') {
    if (isExit) {
      bufferedPrice = (basePrice * 1.001) * (1 + sellExitBuffer);
    } else {
      bufferedPrice = (basePrice * 1.001) * (1 + buyEntryBuffer);
    }
  } else {
    if (isExit) {
      bufferedPrice = (basePrice * 0.999) * (1 - buyExitBuffer);
    } else {
      bufferedPrice = (basePrice * 0.999) * (1 - sellEntryBuffer);
    }
  }
  
  return bufferedPrice;
}

// buffers come from DB directly: 0.0017, 0.003
// NO division by 100 ✓ CORRECT
```

**Both are IDENTICAL in logic! ✓**

---

## Segment Settings Fetch

### OLD ROUTE
```typescript
// Sequential separate queries:
const profileResult = await admin.from('profiles').select(...);
const segSettingsResult = await admin.from('segment_settings').select(...);
const positionsResult = await admin.from('positions').select(...);
const quotesMap = await fetchKiteQuotes(...);

// Then merge settings manually with fallback defaults
let buySetting = settingsList.find((s) => s.side === 'BUY');
let sellSetting = settingsList.find((s) => s.side === 'SELL');

if (!buySetting) {
  buySetting = { side: 'BUY', entry_buffer: 0.003, exit_buffer: 0.0017, ... };
}
if (!sellSetting) {
  sellSetting = { side: 'SELL', entry_buffer: 0.003, exit_buffer: 0.0017, ... };
}
```

### NEW ROUTE (TradeEngine)
```typescript
// Parallel queries bundled in get_trade_context_v1 RPC:
const [
  tradeContextResult,  // Returns: profile, open_positions, segment_settings
  marketHoursResult,
  segmentSettingsResult,
  quotesMap
] = await Promise.all([
  admin.rpc('get_trade_context_v1', { p_user_id, p_symbols }),
  ConfigurationService.getMarketHours(segmentId),
  ConfigurationService.getSegmentSettings(dbSegment),
  fetchSpeedQuotes(instrumentsToFetch)
]);

const ctx = tradeContextResult.data;  // All context in one RPC response

// Then fetch user-specific settings as secondary query:
const { data: userSegRows } = await admin
  .from(settingsTable)
  .select('...')
  .eq('user_id', settingsLookupId)
  .eq('segment', dbSegment);

// Merge with proper defaults
let buySetting = { 
  ...defaults, 
  ...segmentSettingsResult, 
  ...(userBuySetting ?? {}) 
};
let sellSetting = { 
  ...defaults, 
  ...segmentSettingsResult, 
  ...(userSellSetting ?? {}) 
};
```

**Key Difference:** NEW route is more efficient (uses RPC for batch context fetch), but requires `get_trade_context_v1` RPC to exist.

---

## Margin & Brokerage Calculation

### OLD ROUTE
```typescript
// Inline calculation:
const balance = Number(profile.balance ?? 0);
const leverage = targetProductType === 'CARRY'
  ? (segSetting.holding_leverage ?? 1)
  : (segSetting.intraday_leverage ?? 1);
const exposure = qty * client_price;
const requiredMargin = exposure / leverage;

// Brokerage: charge both entry + exit legs up front (× 2)
const commType = segSetting.commission_type || 'Per Crore';
const commVal = Number(segSetting.commission_value ?? 0);
const singleLeg = calculateSingleLegCharge({ exposure, lots, commType, commVal });
const brokerage = Math.round(singleLeg * 2 * 100) / 100;

// Balance check
if (balance < requiredMargin + brokerage) {
  return error(...);
}
```

### NEW ROUTE (TradeEngine)
```typescript
// Same calculation, just organized differently:
const leverage = isCarry
  ? Number(segSetting.holding_leverage ?? 1)
  : Number(segSetting.intraday_leverage ?? 1);
const exposure = qty * marginPrice;
const marginPortion = exposure / leverage;
const requiredMargin = marginPortion + brokerage;

// Brokerage: charge both entry + exit legs up front (× 2)
const commType = segSetting.commission_type || 'Per Crore';
const commVal = Number(segSetting.commission_value ?? 0);
const singleLeg = calculateSingleLegCharge({ ... });
const brokerage = Math.round(singleLeg * 2 * 100) / 100;

// Cache balance in Redis for fast-reject
try {
  const redis = getRedisClient();
  redis.set(`balance:${user.id}`, profile.balance.toString(), 'EX', 300);
} catch {}

// Balance check + Redis cache check
if (balance < requiredMargin) {
  return error(...);
}
```

**Key Difference:** NEW route adds Redis fast-reject cache for balance (non-blocking).

---

## Database Call

### OLD ROUTE
```typescript
// Direct call to place_order RPC:
const { data: oId, error: rpcErr } = await admin.rpc('place_order', {
  p_user_id: user.id,
  p_symbol: symbol,
  p_kite_inst: kiteInst,
  p_segment: dbSegment,
  p_side: side,
  p_order_type: rpcOrderType,
  p_product_type: product_type ?? 'INTRADAY',
  p_qty: qty,
  p_lots: lots ?? 0,
  p_ltp: baseLtp,
  p_fill_price: fillPrice,
  p_info: null,
  p_trigger_price: resolvedTriggerPrice,
  p_stop_loss: resolvedStopLoss,
  p_target: target ? parseFloat(target.toString()) : null,
  p_is_exit: is_exit ?? false
});
```

### NEW ROUTE (TradeEngine)
```typescript
// Delegates to ExecutionService.executeOrder():
const executionParams = {
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

// Inside ExecutionService:
// 1. Acquires Redis per-user lock (5s TTL) to prevent concurrent order races
// 2. Fast-reject check against cached balance
// 3. Calls place_order_v2 RPC with extended params
// 4. Fires async shadow comparison if shadow mode active
// 5. Releases lock and invalidates caches
```

**Key Differences:**
- NEW route uses `place_order_v2` (supports more fields)
- NEW route adds Redis lock to prevent concurrent order races
- NEW route supports shadow mode testing
- NEW route handles async telemetry logging

---

## Validation Differences

| Validation | OLD | NEW |
|-----------|-----|-----|
| **Blocking check** | Inline in route | Delegated to OrderService |
| **Hold duration** | Inline calculation | OrderService.validateHoldDuration() |
| **Limit price** | Inline rules | OrderService.validateLimitPrice() |
| **SL/Target** | Inline rules | OrderService.validateTargetAndStopLoss() |
| **Strike range** | Inline for options | OrderService.validateStrikeRange() |
| **Segment limits** | Inline | OrderService.validateSegmentPriceLimits() |

**OLD:** ~400 lines of validation logic inline
**NEW:** ~300 lines of validation delegated to OrderService class

---

## Error Handling

### OLD ROUTE
```typescript
if (orderErr) {
  return NextResponse.json({ 
    error: orderErr.message || 'Order execution failed. Please try again.' 
  }, { status: 400 });
}
```

### NEW ROUTE (TradeEngine + ExecutionService)
```typescript
try {
  // Throw errors with descriptive messages
  if (!profile) throw new Error('User profile not found.');
  if (!profile.active) throw new Error('Account is inactive');
  if (!segSetting.trade_allowed) throw new Error('Trading Not Allowed In This Script...');
  // ... many more validations
} catch (err: any) {
  const msg = err?.message || 'Order execution failed. Please try again.';
  let status = 400;
  if (msg.includes('Unauthorized')) status = 401;
  if (msg.includes('Not Allowed')) status = 403;
  if (msg.includes('unavailable')) status = 503;
  return NextResponse.json({ error: msg }, { status });
}
```

**Key Difference:** NEW route maps error messages to proper HTTP status codes (401, 403, 503).

---

## Overall Comparison Table

| Aspect | OLD | NEW |
|--------|-----|-----|
| **Architecture** | Monolithic | Modular (TradeEngine + Services) |
| **Lines in route.ts** | ~900 | ~200 |
| **Fill Price Logic** | Inline | BufferCalculator |
| **Validation** | Inline | OrderService |
| **Execution** | Direct RPC call | ExecutionService (RPC + lock + shadow) |
| **Performance** | Sequential queries | Parallel + RPC batching |
| **Error Mapping** | Basic 400 | Smart HTTP status (401/403/503) |
| **Concurrency** | No protection | Redis lock per-user |
| **Caching** | None | Balance cache + symbol cache |
| **Testing** | None | Shadow mode support |
| **Telemetry** | Basic logging | Detailed event journal |

---

## Why NEW Is Better

1. **Maintainability**: Logic split into focused classes
2. **Testability**: Each service can be tested independently
3. **Performance**: Parallel queries + RPC batching + Redis caching
4. **Safety**: Per-user locks prevent race conditions
5. **Observability**: Shadow mode for A/B testing logic changes
6. **Extensibility**: Easy to add new validation rules without touching route

---

## Current State

**After all buffer fixes:**
- Both OLD and NEW use correct buffer values (0.0017, not 0.0017/100)
- NEW route (TradeEngine) = ✓ CORRECT
- Close routes (orderMatching, position/[id]/close, etc.) = ✓ FIXED
- Live P&L and Stored P&L = ✓ NOW MATCH

