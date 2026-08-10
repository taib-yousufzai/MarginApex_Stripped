# Buffer Division By 100 Bug - Complete Analysis

## THE BUG

Multiple files are dividing exit_buffer and entry_buffer by 100, based on a WRONG comment that says "the DB stores buffers as percentages like 0.17". 

But the DB schema defaults show the truth:
```sql
entry_buffer numeric NOT NULL DEFAULT 0.003,    -- This is 0.3% in decimal form
exit_buffer  numeric NOT NULL DEFAULT 0.0017,   -- This is 0.17% in decimal form
```

**The DB stores them ALREADY in decimal form (0.0017 = 0.17%), not as 0.17.**

When the code divides by 100:
```typescript
exit_buffer = 0.0017 / 100 = 0.000017  // ❌ This is 0.0017% (100x too small!)
```

---

## FILES WITH THE BUG (Dividing by 100)

1. **`lib/orderMatching.ts` (line 61)**
   ```typescript
   exit_buffer: Number(s.exit_buffer ?? 0.17) / 100,
   ```
   - Comment claims "0.17 = 0.17%" but DB stores 0.0017
   - Wrong fallback: should be 0.0017, not 0.17

2. **`app/api/positions/close/route.ts` (line 264)**
   ```typescript
   const exitBuffer = (segSetting?.exit_buffer ?? 0.17) / 100;
   ```

3. **`app/api/positions/[id]/close/route.ts` (line 360)**
   ```typescript
   const exitBuffer = (Number(segSetting?.exit_buffer) || 0.17) / 100;
   ```

4. **`app/api/cron/auto-square-off/route.ts` (line 187)**
   ```typescript
   const exitBuffer = (segSetting.exit_buffer ?? 0) / 100;
   ```

5. **`app/api/admin/positions/[id]/sqoff/route.ts` (line 83)**
   ```typescript
   const exitBuffer = Number(segSetting?.exit_buffer ?? 0.17) / 100;
   ```

6. **`app/api/admin/positions/[id]/route.ts` (line 388)**
   ```typescript
   const sellBuf = (exitBuffers.get(bufKeySell)?.exit_buffer ?? 0.17) / 100;
   ```

7. **`app/api/admin/orders/square-off-all/route.ts` (line 98)**
   ```typescript
   const exitBuffer = (bufSettings?.exit_buffer ?? 0.17) / 100;
   ```

---

## FILES THAT ARE CORRECT (No division)

1. **`lib/trading/BufferCalculator.ts`** ✓
   ```typescript
   const buyExitBuffer = buySetting?.exit_buffer ?? 0.0017;
   ```

2. **`lib/trading/TradeEngine.ts`** ✓
   - Passes buffers directly from DB to calculateBufferedPrice
   - No division by 100

3. **`lib/trading/OrderService.ts`** ✓
   ```typescript
   const buf = exitBuffer ?? 0.0017;
   ```

4. **`app/api/orders/route.ts` (OLD VERSION from commit 85d3993)** ✓
   ```typescript
   const exitBuffer = buySetting?.exit_buffer ?? 0.0017;
   // No division - used directly in: (ltp * 0.999) * (1 - exitBuffer)
   ```

---

## Why The P&L Is Wrong For New Orders (TradeEngine)

The NEW order execution (TradeEngine) is CORRECT because it doesn't divide by 100. But the **OLD broken code in orderMatching.ts and close routes is now used AFTER the order is placed**. Here's the flow:

### When you BUY ETH:
1. **TradeEngine.placeOrder()** → Uses correct buffers (0.0017) → Shows ₹-60 ✓
2. Later, **orderMatching.ts or close routes** → Divide by 100 → Uses 0.000017 → Recalculates P&L → Shows ₹-99 ✗

### The Fix Chain

**Step 1:** Fix all files dividing by 100 - remove the `/100`

**Step 2:** Fix the fallback defaults from 0.17 to 0.0017

---

## Detailed Fix for Each File

### 1. `lib/orderMatching.ts` (Line 61-62)
**Before:**
```typescript
entry_buffer: Number(s.entry_buffer ?? 0.3) / 100,
exit_buffer:  Number(s.exit_buffer  ?? 0.17) / 100,
```

**After:**
```typescript
entry_buffer: Number(s.entry_buffer ?? 0.003),
exit_buffer:  Number(s.exit_buffer  ?? 0.0017),
```

### 2. `app/api/positions/close/route.ts` (Line 264)
**Before:**
```typescript
const exitBuffer = (segSetting?.exit_buffer ?? 0.17) / 100;
```

**After:**
```typescript
const exitBuffer = Number(segSetting?.exit_buffer ?? 0.0017);
```

### 3. `app/api/positions/[id]/close/route.ts` (Line 360)
**Before:**
```typescript
const exitBuffer = (Number(segSetting?.exit_buffer) || 0.17) / 100;
```

**After:**
```typescript
const exitBuffer = Number(segSetting?.exit_buffer ?? 0.0017);
```

### 4. `app/api/cron/auto-square-off/route.ts` (Line 187)
**Before:**
```typescript
const exitBuffer = (segSetting.exit_buffer ?? 0) / 100;
```

**After:**
```typescript
const exitBuffer = Number(segSetting?.exit_buffer ?? 0.0017);
```

### 5. `app/api/admin/positions/[id]/sqoff/route.ts` (Line 83)
**Before:**
```typescript
const exitBuffer = Number(segSetting?.exit_buffer ?? 0.17) / 100;
```

**After:**
```typescript
const exitBuffer = Number(segSetting?.exit_buffer ?? 0.0017);
```

### 6. `app/api/admin/positions/[id]/route.ts` (Line 388)
**Before:**
```typescript
const sellBuf = (exitBuffers.get(bufKeySell)?.exit_buffer ?? 0.17) / 100;
```

**After:**
```typescript
const sellBuf = Number(exitBuffers.get(bufKeySell)?.exit_buffer ?? 0.0017);
```

### 7. `app/api/admin/orders/square-off-all/route.ts` (Line 98)
**Before:**
```typescript
const exitBuffer = (bufSettings?.exit_buffer ?? 0.17) / 100;
```

**After:**
```typescript
const exitBuffer = Number(bufSettings?.exit_buffer ?? 0.0017);
```

---

## Why This Explains The ₹-60 vs ₹-99 Problem

### With correct 0.0017 buffer:
```
Exit price = (1866 × 0.999) × (1 - 0.0017) = 1863.93
P&L ≈ -₹2.60 + brokerage ≈ -₹60 ✓
```

### With buggy 0.000017 buffer (after dividing by 100):
```
Exit price = (1866 × 0.999) × (1 - 0.000017) = 1864.76  // Nearly no discount!
P&L ≈ -₹1.24 + higher brokerage (due to calculation errors) ≈ -₹99 ✗
```

---

## Summary

**Root Cause:** Misleading comment in code saying DB stores buffers as "0.17 %" when actually it stores "0.0017" (already in decimal form).

**Impact:** All exit/entry buffer calculations are 100x too small, making positions exit at wrong prices.

**Solution:** Remove all `/100` divisions and fix fallback defaults from `0.17` to `0.0017`.

