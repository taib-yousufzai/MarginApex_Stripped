import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load local environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { getAdminClient } from '../lib/adminClient';
import { randomUUID } from 'crypto';

describe('Position Engine Load & Concurrency Tests', () => {
  const admin = getAdminClient();
  let userId: string;
  let originalBalance: number = 0;

  beforeAll(async () => {
    // Setup a test instrument setting
    await admin.from('script_settings').upsert({ symbol: 'LOAD_TEST_INFY', lot_size: 1 });

    // Fetch an existing active profile
    const { data: profile } = await admin
      .from('profiles')
      .select('id, balance')
      .eq('active', true)
      .limit(1)
      .single();

    if (!profile) {
      throw new Error('No active profile found in database to run load test.');
    }

    userId = profile.id;
    originalBalance = Number(profile.balance || 0);

    // Clear existing records for this user to avoid load test interference
    await admin.from('transactions').delete().eq('user_id', userId);
    await admin.from('positions').delete().eq('user_id', userId);
    await admin.from('orders').delete().eq('user_id', userId);

    // Give the user a large temporary balance via DEPOSIT transaction (ledger-first model)
    await admin.from('transactions').insert({
      user_id: userId,
      type: 'DEPOSIT',
      amount: 10000000,
      status: 'APPROVED',
      ref_id: `DEP_LOAD_TEST_${randomUUID()}`
    });
  }, 60000);

  afterAll(async () => {
    // Cleanup any orphaned LOAD_TEST_INFY records globally
    await admin.from('positions').delete().eq('symbol', 'LOAD_TEST_INFY');
    await admin.from('orders').delete().eq('symbol', 'LOAD_TEST_INFY');
    await admin.from('script_settings').delete().eq('symbol', 'LOAD_TEST_INFY');

    // Restore original balance
    await admin
      .from('profiles')
      .update({ balance: originalBalance, settlement_amount: originalBalance })
      .eq('id', userId);
  }, 60000);

  it('Scenario 1: Idempotency Key Duplicate Retries (Race Condition Test)', async () => {
    const idempKey = `load_test_${randomUUID()}`;
    const duplicateRuns = Array.from({ length: 5 }).map(() =>
      admin.rpc('place_order_v2', {
        p_user_id:            userId,
        p_symbol:             'LOAD_TEST_INFY',
        p_kite_inst:          'LOAD_TEST_INFY',
        p_segment:            'EQ',
        p_side:               'BUY',
        p_order_type:         'MARKET',
        p_product_type:       'CARRY',
        p_qty:                10,
        p_lots:               10,
        p_ltp:                100,
        p_fill_price:         100,
        p_is_exit:            false,
        p_buffer_fee:         0,
        p_status:             'EXECUTED',
        p_expected_margin:    1000,
        p_expected_brokerage: 20,
        p_idempotency_key:    idempKey
      })
    );

    const idempResults = await Promise.all(duplicateRuns);
    const errors = idempResults.filter(r => r.error).map(r => r.error);
    if (errors.length > 0) {
      console.error('Idempotency Scenario Errors:', errors);
    }
    const successIds = idempResults.filter(r => !r.error).map(r => r.data);
    
    // Deduplication should ensure only 1 unique order ID was created
    const uniqueIds = new Set(successIds);
    expect(uniqueIds.size).toBe(1);
  }, 30000);

  it('Scenario 2: High Concurrency FIFO Chain Execution', async () => {
    // Clear Scenario 1 data
    await admin.from('transactions').delete().eq('user_id', userId);
    await admin.from('positions').delete().eq('user_id', userId);
    await admin.from('orders').delete().eq('user_id', userId);

    // Fund the balance again
    await admin.from('transactions').insert({
      user_id: userId,
      type: 'DEPOSIT',
      amount: 10000000,
      status: 'APPROVED',
      ref_id: `DEP_LOAD_TEST_S2_${randomUUID()}`
    });

    const buyLots = Array.from({ length: 100 }).map((_, i) =>
      admin.rpc('place_order_v2', {
        p_user_id:            userId,
        p_symbol:             'LOAD_TEST_INFY',
        p_kite_inst:          'LOAD_TEST_INFY',
        p_segment:            'EQ',
        p_side:               'BUY',
        p_order_type:         'MARKET',
        p_product_type:       'CARRY',
        p_qty:                1,
        p_lots:               1,
        p_ltp:                100,
        p_fill_price:         100,
        p_is_exit:            false,
        p_buffer_fee:         0,
        p_status:             'EXECUTED',
        p_expected_margin:    10,
        p_expected_brokerage: 1,
        p_idempotency_key:    `load_fifo_buy_${i}_${randomUUID()}`
      })
    );

    const buyResults = await Promise.all(buyLots);
    const failedBuys = buyResults.filter(r => r.error);
    if (failedBuys.length > 0) {
      console.error('Scenario 2 Buy Failures:', failedBuys.map(r => r.error));
    }
    expect(failedBuys.length).toBe(0);

    // Verify 100 open position lots in DB
    const { data: posCount } = await admin
      .from('positions')
      .select('count')
      .eq('user_id', userId)
      .eq('symbol', 'LOAD_TEST_INFY')
      .eq('status', 'open');

    expect(posCount?.[0]?.count).toBe(100);

    // Exit/Net all 100 lots with a single large reversing order
    const { error: sellErr } = await admin.rpc('place_order_v2', {
      p_user_id:            userId,
      p_symbol:             'LOAD_TEST_INFY',
      p_kite_inst:          'LOAD_TEST_INFY',
      p_segment:            'EQ',
      p_side:               'SELL',
      p_order_type:         'MARKET',
      p_product_type:       'CARRY',
      p_qty:                100,
      p_lots:               100,
      p_ltp:                110,
      p_fill_price:         110,
      p_is_exit:            true,
      p_buffer_fee:         0,
      p_status:             'EXECUTED',
      p_expected_margin:    0,
      p_expected_brokerage: 50,
      p_idempotency_key:    `load_fifo_exit_${randomUUID()}`
    });

    expect(sellErr).toBeNull();

    // Verify final count is 0 open, 100 closed
    const { data: finalPos } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('symbol', 'LOAD_TEST_INFY');

    const openCount = finalPos?.filter(p => p.status === 'open').length ?? 0;
    const closedCount = finalPos?.filter(p => p.status === 'closed').length ?? 0;

    expect(openCount).toBe(0);
    expect(closedCount).toBe(100);
  }, 30000);

  it('Scenario 3: Detailed FIFO Lot Netting and Margin Verification', async () => {
    // Clear previous scenario data
    await admin.from('transactions').delete().eq('user_id', userId);
    await admin.from('positions').delete().eq('user_id', userId);
    await admin.from('orders').delete().eq('user_id', userId);

    // Fund profile balance (ledger-first model)
    await admin.from('transactions').insert({
      user_id: userId,
      type: 'DEPOSIT',
      amount: 10000000,
      status: 'APPROVED',
      ref_id: `DEP_FIFO_S3_${randomUUID()}`
    });

    // 1. BUY 10 @ 100
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'BUY', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 10, p_lots: 10,
      p_ltp: 100, p_fill_price: 100, p_is_exit: false, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 100, p_expected_brokerage: 2, p_idempotency_key: `fifo_s3_b1_${randomUUID()}`
    });

    // 2. BUY 20 @ 105
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'BUY', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 20, p_lots: 20,
      p_ltp: 105, p_fill_price: 105, p_is_exit: false, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 210, p_expected_brokerage: 4, p_idempotency_key: `fifo_s3_b2_${randomUUID()}`
    });

    // 3. BUY 15 @ 98
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'BUY', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 15, p_lots: 15,
      p_ltp: 98, p_fill_price: 98, p_is_exit: false, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 147, p_expected_brokerage: 3, p_idempotency_key: `fifo_s3_b3_${randomUUID()}`
    });

    // 4. BUY 8 @ 101
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'BUY', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 8, p_lots: 8,
      p_ltp: 101, p_fill_price: 101, p_is_exit: false, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 80.8, p_expected_brokerage: 1.6, p_idempotency_key: `fifo_s3_b4_${randomUUID()}`
    });

    // Verify 4 open lots in DB
    const { data: openLots } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('symbol', 'LOAD_TEST_INFY')
      .eq('status', 'open')
      .order('entry_time', { ascending: true });

    expect(openLots?.length).toBe(4);
    expect(openLots?.[0].qty_open).toBe(10);
    expect(openLots?.[1].qty_open).toBe(20);
    expect(openLots?.[2].qty_open).toBe(15);
    expect(openLots?.[3].qty_open).toBe(8);

    // 5. SELL 25 @ 102 (Exit oldest lots first)
    // Consumes 10 @ 100 (Full Exit) + 15 @ 105 (Partial Exit leaving 5 @ 105 open)
    const { error: sellErr } = await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'SELL', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 25, p_lots: 25,
      p_ltp: 102, p_fill_price: 102, p_is_exit: true, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 0, p_expected_brokerage: 5, p_idempotency_key: `fifo_s3_s1_${randomUUID()}`
    });

    expect(sellErr).toBeNull();

    // Verify active open positions remaining
    const { data: postOpenLots } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('symbol', 'LOAD_TEST_INFY')
      .eq('status', 'open')
      .order('entry_time', { ascending: true });

    // Open lots remaining:
    // Lot 2: 5 remaining (was 20) @ 105
    // Lot 3: 15 remaining (was 15) @ 98
    // Lot 4: 8 remaining (was 8) @ 101
    expect(postOpenLots?.length).toBe(3);
    expect(postOpenLots?.[0].qty_open).toBe(5);
    expect(postOpenLots?.[0].entry_price).toBe(105);
    expect(postOpenLots?.[1].qty_open).toBe(15);
    expect(postOpenLots?.[2].qty_open).toBe(8);

    // Verify closed position records
    const { data: postClosedLots } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('symbol', 'LOAD_TEST_INFY')
      .eq('status', 'closed');

    // Closed lots should represent:
    // 10 units exited from Lot 1 (P&L: (102 - 100) * 10 = +20)
    // 15 units exited from Lot 2 (P&L: (102 - 105) * 15 = -45)
    // Total realized P&L: -25
    expect(postClosedLots?.length).toBe(2);
    const totalPnl = postClosedLots?.reduce((sum, p) => sum + Number(p.pnl), 0) ?? 0;
    expect(totalPnl).toBe(-25);

    // Verify Cost Bases remain untouched
    expect(postOpenLots?.[0].entry_price).toBe(105);
    expect(postOpenLots?.[1].entry_price).toBe(98);
    expect(postOpenLots?.[2].entry_price).toBe(101);

    // Verify Proportional Margin Release
    // Lot 2 original margin was 210. 15/20 exited, so remaining should be 210 * 5/20 = 52.5
    expect(Number(postOpenLots?.[0].locked_margin)).toBeCloseTo(52.5, 1);

    // Verify Ledger transaction type sequence (DEPOSIT -> MARGIN_DEBITs -> MARGIN_CREDIT/PNL_DEBIT)
    const { data: ledger } = await admin
      .from('transactions')
      .select('type, amount')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    const types = ledger?.map(t => t.type) || [];
    expect(types).toContain('DEPOSIT');
    expect(types).toContain('MARGIN_DEBIT');
    expect(types).toContain('PNL_DEBIT');
    expect(types).toContain('MARGIN_CREDIT');
  }, 30000);

  it('Scenario 4: FIFO across many chained partial exits', async () => {
    // Clear previous scenario data
    await admin.from('transactions').delete().eq('user_id', userId);
    await admin.from('positions').delete().eq('user_id', userId);
    await admin.from('orders').delete().eq('user_id', userId);

    await admin.from('transactions').insert({
      user_id: userId, type: 'DEPOSIT', amount: 10000000, status: 'APPROVED', ref_id: `DEP_FIFO_S4_${randomUUID()}`
    });

    // BUY 10, BUY 20, BUY 30
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'BUY', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 10, p_lots: 10,
      p_ltp: 100, p_fill_price: 100, p_is_exit: false, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 100, p_expected_brokerage: 2, p_idempotency_key: `s4_b1_${randomUUID()}`
    });
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'BUY', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 20, p_lots: 20,
      p_ltp: 100, p_fill_price: 100, p_is_exit: false, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 200, p_expected_brokerage: 4, p_idempotency_key: `s4_b2_${randomUUID()}`
    });
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'BUY', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 30, p_lots: 30,
      p_ltp: 100, p_fill_price: 100, p_is_exit: false, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 300, p_expected_brokerage: 6, p_idempotency_key: `s4_b3_${randomUUID()}`
    });

    // SELL 15 (Consumes Lot 1 completely + 5 from Lot 2 -> Lot 2 has 15 remaining)
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'SELL', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 15, p_lots: 15,
      p_ltp: 105, p_fill_price: 105, p_is_exit: true, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 0, p_expected_brokerage: 3, p_idempotency_key: `s4_s1_${randomUUID()}`
    });

    // SELL 12 (Consumes 12 from Lot 2 -> Lot 2 has 3 remaining)
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'SELL', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 12, p_lots: 12,
      p_ltp: 105, p_fill_price: 105, p_is_exit: true, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 0, p_expected_brokerage: 2, p_idempotency_key: `s4_s2_${randomUUID()}`
    });

    // SELL 18 (Consumes 3 remaining from Lot 2 + 15 from Lot 3 -> Lot 3 has 15 remaining)
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'SELL', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 18, p_lots: 18,
      p_ltp: 105, p_fill_price: 105, p_is_exit: true, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 0, p_expected_brokerage: 4, p_idempotency_key: `s4_s3_${randomUUID()}`
    });

    // Verify open position states
    const { data: openLots } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userId)
      .eq('symbol', 'LOAD_TEST_INFY')
      .eq('status', 'open')
      .order('entry_time', { ascending: true });

    // Lot 3 should have 15 units remaining (originally 30)
    expect(openLots?.length).toBe(1);
    expect(openLots?.[0].qty_open).toBe(15);
  }, 30000);

  it('Scenario 5: Multi-Symbol and Multi-User Isolation', async () => {
    // We fetch a second active user for isolation testing
    const { data: profiles } = await admin
      .from('profiles')
      .select('id, balance')
      .eq('active', true)
      .limit(2);

    if (!profiles || profiles.length < 2) {
      return; // Skip if no second test user exists
    }

    const userB = profiles[1].id;

    // Clear records for User B
    await admin.from('transactions').delete().eq('user_id', userB);
    await admin.from('positions').delete().eq('user_id', userB);
    await admin.from('orders').delete().eq('user_id', userB);

    await admin.from('transactions').insert([
      { user_id: userId, type: 'DEPOSIT', amount: 1000000, status: 'APPROVED', ref_id: `dep_iso_a_${randomUUID()}` },
      { user_id: userB, type: 'DEPOSIT', amount: 1000000, status: 'APPROVED', ref_id: `dep_iso_b_${randomUUID()}` }
    ]);

    // User A buys INFY, User B buys INFY
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'BUY', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 10, p_lots: 10,
      p_ltp: 100, p_fill_price: 100, p_is_exit: false, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 100, p_expected_brokerage: 2, p_idempotency_key: `iso_a1_${randomUUID()}`
    });

    await admin.rpc('place_order_v2', {
      p_user_id: userB, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'BUY', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 20, p_lots: 20,
      p_ltp: 100, p_fill_price: 100, p_is_exit: false, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 200, p_expected_brokerage: 4, p_idempotency_key: `iso_b1_${randomUUID()}`
    });

    // User A sells INFY -> Assert ONLY User A's positions are closed, User B's positions are untouched
    await admin.rpc('place_order_v2', {
      p_user_id: userId, p_symbol: 'LOAD_TEST_INFY', p_kite_inst: 'LOAD_TEST_INFY', p_segment: 'EQ',
      p_side: 'SELL', p_order_type: 'MARKET', p_product_type: 'CARRY', p_qty: 10, p_lots: 10,
      p_ltp: 105, p_fill_price: 105, p_is_exit: true, p_buffer_fee: 0, p_status: 'EXECUTED',
      p_expected_margin: 0, p_expected_brokerage: 2, p_idempotency_key: `iso_a_exit_${randomUUID()}`
    });

    const { data: posB } = await admin
      .from('positions')
      .select('*')
      .eq('user_id', userB)
      .eq('status', 'open');

    // User B's position must remain untouched
    expect(posB?.length).toBe(1);
    expect(posB?.[0].qty_open).toBe(20);
  }, 30000);
});
