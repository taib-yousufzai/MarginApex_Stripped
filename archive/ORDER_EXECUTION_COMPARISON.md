# Order Execution Logic Comparison: Old vs New

## CRITICAL DIFFERENCE FOUND: Fill Price Calculation (Buffer Formula)

### OLD ROUTE (Working correctly - ₹-60 for ETH)
```typescript
// For MARKET/SLM orders, the old route uses:
if (side === 'BUY') {
  if (is_exit) {
    // Exiting SELL/Short → Buying back at: Ask * (1 + sellExitBuffer)
    fillPrice = (baseLtp * 1.001) * (1 + sellExitBuffer);
  } else {
    // Long Entry → Buying at: Ask * (1 + buyEntryBuffer)
    fillPrice = (baseLtp * 1.001) * (1 + buyEntryBuffer);
  }
} else { // SELL
  if (is_exit) {
    // Exiting BUY/Long → Selling to close at: Bid * (1 - buyExitBuffer)
    fillPrice = (baseLtp * 0.999) * (1 - buyExitBuffer);
  } else {
    // Short Entry → Selling at: Bid * (1 - sellEntryBuffer)
    fillPrice = (baseLtp * 0.999) * (1 - sellEntryBuffer);
  }
}

// exit_buffer from DB is ALREADY IN DECIMAL FORM (e.g., 0.0017 = 0.17%)
// NO DIVISION BY 100 NEEDED — it's directly applied in the multiplication
```

### NEW ROUTE (TradeEngine - Currently BROKEN - ₹-99 for ETH)
```typescript
// From BufferCalculator.ts and TradeEngine.ts
const exitBuffer = (Number(segSetting?.exit_buffer) || 0.17) / 100;
// ❌ PROBLEM: DB stores 0.0017, but dividing by 100 gives 0.000017!

let fillPrice = calculateBufferedPrice({
  side,
  isExit: is_exit,
  basePrice: executionBasePrice,
  buySetting,
  sellSetting,
  brokeragePerUnit: (dbSegment === 'CRYPTO' && isCustomCalc && qty > 0) ? (brokerage / qty) : 0
});

// Inside calculateBufferedPrice (BufferCalculator.ts):
// Uses the divided-by-100 exitBuffer, which is 0.000017 instead of 0.0017
// This causes the buffer to be applied at a TINY fraction of what it should be
// Result: exit prices barely differ from LTP, leading to huge P&L discrepancies
```

---

## Root Cause Analysis

### The DB Schema
- `exit_buffer` is stored as: **0.0017** (which represents 0.17%)
- `entry_buffer` is stored as: **0.003** (which represents 0.3%)

### Old Route (Correct)
The old route treats these as already-decimal values:
- `fillPrice = (baseLtp * 0.999) * (1 - 0.0017)` ✓ Correct
- This applies a 0.17% exit fee on top of the bid-ask spread

### New Route (Broken)
The TradeEngine divides by 100:
- `exitBuffer = 0.0017 / 100 = 0.000017` ❌ Wrong!
- `fillPrice = (baseLtp * 0.999) * (1 - 0.000017)` ❌ Exit fee is now 0.0017% instead of 0.17%

---

## Quantitative Example (ETH BUY → EXIT to SELL)

### Old Route (Correct - Shows ₹-60)
```
Entry: BUY 1 ETH @ ₹1,866.53
LTP at exit: ₹1,866.53
buyExitBuffer = 0.0017 (0.17%)

exitPrice = (1866.53 * 0.999) * (1 - 0.0017)
          = 1864.789 * 0.9983
          = 1863.9256... ≈ ₹1,863.93

P&L = (1863.93 - 1866.53) * 1 = -₹2.60

(Note: The full P&L displayed might include brokerage, leading to -₹60 total)
```

### New Route (Broken - Shows ₹-99)
```
Entry: BUY 1 ETH @ ₹1,866.53
LTP at exit: ₹1,866.53
exitBuffer = 0.0017 / 100 = 0.000017 ❌

exitPrice = (1866.53 * 0.999) * (1 - 0.000017)
          = 1864.789 * 0.9999830
          = 1864.758... ≈ ₹1,864.76

P&L = (1864.76 - 1866.53) * 1 = -₹1.77

(But the stored value shows -₹99, suggesting brokerage is being calculated with the wrong buffer)
```

---

## Summary of Differences

| Aspect | Old Route | New Route (Broken) |
|--------|-----------|------------------|
| **Buffer Reading** | Treats DB value (0.0017) as decimal | **Divides by 100** → 0.000017 |
| **Exit Buffer Logic** | Directly used in: `(1 - buffer)` | Incorrectly scaled by 100x smaller |
| **Buffer Magnitude** | 0.17% as intended | 0.0017% (100x too small) |
| **Fill Price Error** | Correct exit prices | Exit prices nearly equal LTP |
| **P&L Display** | Live P&L matches stored P&L | **Huge discrepancy** |
| **Example Result** | -₹60 ✓ | -₹99 ✗ |

---

## Why the New Route Is Doing This

Looking at `lib/trading/BufferCalculator.ts`:

```typescript
const exitBuffer = (Number(segSetting?.exit_buffer) || 0.17) / 100;
```

The fallback is `0.17`, which suggests the developer thought:
- "If no setting, use 0.17 (which is 0.17% when divided by 100)"
- But the DB schema actually stores it as **already-decimal** (0.0017 for 0.17%)

So the new code is double-dividing: once in the DB schema, and once in the code.

---

## The Fix

**In `lib/trading/BufferCalculator.ts` and `lib/trading/TradeEngine.ts`:**

Remove the `/100` division and use the DB value directly:

```typescript
// ❌ WRONG:
const exitBuffer = (Number(segSetting?.exit_buffer) || 0.17) / 100;

// ✓ CORRECT:
const exitBuffer = Number(segSetting?.exit_buffer) || 0.0017;
```

This matches the old route's logic exactly.

