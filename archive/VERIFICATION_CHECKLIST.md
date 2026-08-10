# P&L Fix Verification Checklist

## Pre-Test Setup

- [ ] Stop the running dev server (Ctrl+C)
- [ ] Delete `.next` cache: `rm -r .next`
- [ ] Restart dev server: `npm run dev`
- [ ] Wait for server to fully compile

---

## Test 1: Fresh BUY Order (Crypto)

### Setup
- [ ] Go to Trading page
- [ ] Select **ETH** or **BTC** (CRYPTO segment)
- [ ] Go BUY side
- [ ] Enter qty: **1 unit**

### Execution
- [ ] Click BUY
- [ ] Wait for order to execute
- [ ] **Note the live P&L shown** (e.g., -₹60, -₹99, etc.)
- [ ] ✓ Expected: **Negative P&L** (e.g., -₹50 to -₹70 range) due to buffers + brokerage

### Close Position
- [ ] Click the position or find in positions list
- [ ] Click **Close** or sell the full qty
- [ ] Wait for order execution
- [ ] Go to **Closed Positions** or **History**
- [ ] Find the position you just closed
- [ ] **Check the P&L displayed**

### Verification ✓
- [ ] **Live P&L** (shown during holding) = **Stored P&L** (shown in history)
- [ ] Both should be similar loss amounts (not exactly same due to execution timing, but within ₹5)
- [ ] **NOT a ₹40+ difference like -₹60 vs -₹99**

---

## Test 2: Fresh SELL Order (Commodity)

### Setup
- [ ] Select **GOLD** or **CRUDE OIL** (MCX segment)
- [ ] Go SELL side
- [ ] Enter qty: **100 units** (or 1 lot)

### Execution
- [ ] Click SELL
- [ ] Wait for order execution
- [ ] **Note the live P&L shown**
- [ ] ✓ Expected: **Negative P&L** (you're short at entry) OR small positive if price moved

### Close Position
- [ ] Find the open position
- [ ] Click **Close** (or BUY to cover)
- [ ] Go to **Closed Positions**
- [ ] Find the position

### Verification ✓
- [ ] **Live P&L** ≈ **Stored P&L**
- [ ] No huge discrepancies

---

## Test 3: Limit Order

### Setup
- [ ] Select any symbol (NSE equity, index, or crypto)
- [ ] LIMIT order type
- [ ] Set limit price at LTP - ₹1 (for BUY) or LTP + ₹1 (for SELL)
- [ ] Wait for order to execute

### Verification ✓
- [ ] Fill price matches limit price (no buffer applied to LIMIT orders)
- [ ] P&L calculation correct

---

## Test 4: Hold Duration Check (Anti-Scalping)

### Setup
- [ ] BUY any crypto at market
- [ ] Immediately close (within 2 seconds)

### Expected Behavior
- [ ] Should get error: **"Anti-Scalping: Minimum hold time of 120s required..."**
- [ ] NOT an order execution error

### Verification ✓
- [ ] Anti-scalping validation is working
- [ ] Using correct buffers in the hold duration check

---

## Test 5: Multiple Positions (Same Symbol)

### Setup
- [ ] BUY ETH (qty 1)
- [ ] Wait 5 seconds
- [ ] BUY ETH again (qty 1)
- [ ] Note live P&L for each position

### Close
- [ ] Close first position
- [ ] Check stored P&L in history
- [ ] Close second position
- [ ] Check stored P&L in history

### Verification ✓
- [ ] Each position's P&L is calculated correctly
- [ ] Live P&L during holding ≈ Stored P&L in history
- [ ] No cross-contamination between positions

---

## Test 6: Check Position History Page

### Setup
- [ ] Go to **Closed Positions** or **History** tab
- [ ] Look at recently closed positions

### Verification ✓
- [ ] **All NEW positions** (after this fix) show correct P&L
- [ ] **OLD positions** (before this fix) still show incorrect P&L (this is expected - they were calculated with buggy code)
- [ ] No errors loading history

---

## Regression Tests

### Test: Can still place orders?
- [ ] BUY order works
- [ ] SELL order works
- [ ] LIMIT order works
- [ ] SL/SLM order works
- [ ] GTT order works

### Test: Market hours check still works?
- [ ] After market hours, get error: "market is closed"
- [ ] During market hours, orders execute

### Test: Balance validation still works?
- [ ] Try to place order with insufficient balance
- [ ] Get error: "Insufficient margin"
- [ ] Same error for both BUY and SELL

### Test: Segment validation still works?
- [ ] Try trading a symbol not in your allowed segments
- [ ] Get error: "Trading not allowed in segment..."

---

## Final Checks

- [ ] No console errors (check browser DevTools and server logs)
- [ ] All orders execute (no hanging/timeout)
- [ ] All validations still work
- [ ] New positions show accurate P&L
- [ ] Old positions unchanged (already stored with buggy values)

---

## Common Issues & Solutions

### Issue: Orders not executing
**Solution:** 
- Check server logs for RPC errors
- Verify `place_order_v2` RPC exists and works
- Check that segment settings exist in DB

### Issue: P&L still mismatched
**Solution:**
- Confirm all 7 files were fixed (check git diff)
- Confirm `.next` cache was deleted and server restarted
- Try fresh order after server restart

### Issue: Anti-scalping error when it shouldn't appear
**Solution:**
- Check that `profit_hold_sec` is correct in segment settings
- Verify the hold duration calculation is using correct timestamp format

### Issue: OLD positions show different P&L than before
**Solution:**
- This is expected! They were stored with buggy code
- Only NEW positions (after fix) use correct calculation
- To fix old positions, you'd need a data migration script

---

## Sign-Off

- [ ] All tests pass
- [ ] Live P&L matches stored P&L ✓
- [ ] No regressions
- [ ] Ready for production

**Date:** _________
**Tester:** _________
**Notes:** 

