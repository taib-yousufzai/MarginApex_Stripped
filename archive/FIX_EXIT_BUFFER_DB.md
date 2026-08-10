# URGENT: Fix Exit Buffer in Database

## The Problem

Your ETH position is showing -₹50+ P&L when it should show +₹900 because the **exit_buffer in your database is set to 0.92 (92%) instead of 0.0017 (0.17%)**.

This is a **540x multiplier error**!

## Console Output Shows:
```
BID:1879 BUFFER:0.92 ← THIS IS WRONG! Should be 0.0017
EXIT:1887.09 AVG:1892.34 QTY:1 = -54.68 ← Wrong result due to huge buffer
```

## The Fix

### Option 1: Use Supabase Dashboard (Easiest)
1. Go to your Supabase project
2. Navigate to **segment_settings** table
3. Find the row where `segment = 'CRYPTO'` AND `side = 'BUY'`
4. Change `exit_buffer` from `0.92` to `0.0017`
5. Click Save
6. Refresh your app

### Option 2: Run SQL Query

Execute this query in your Supabase SQL editor:

```sql
UPDATE segment_settings 
SET exit_buffer = 0.0017 
WHERE segment = 'CRYPTO' AND side = 'BUY';
```

### Option 3: Check All Segments

First, check what exit_buffer values exist:

```sql
SELECT segment, side, exit_buffer 
FROM segment_settings 
ORDER BY segment, side;
```

Then fix any that are wrong:

```sql
-- Fix CRYPTO segments
UPDATE segment_settings 
SET exit_buffer = 0.0017 
WHERE segment = 'CRYPTO';

-- Check other segments too - they should have similar low values (like 0.001-0.005)
SELECT segment, side, exit_buffer 
FROM segment_settings 
ORDER BY segment, side;
```

## Expected Values

After fix, you should see:
```
segment    | side | exit_buffer
-----------|------|------------
CRYPTO     | BUY  | 0.0017
CRYPTO     | SELL | 0.0017
NSE-EQ     | BUY  | 0.0017 (or similar)
NSE-EQ     | SELL | 0.0017 (or similar)
...
```

## After Fix

ETH position should show:
```
Entry: ₹71,000
Current: ₹71,932
P&L: +₹900+ (profit, not loss!)
```

Instead of:
```
Entry: ₹71,000
Current: ₹71,932
P&L: -₹50 (wrong!)
```

---

**Priority: HIGH - Fix immediately!**
