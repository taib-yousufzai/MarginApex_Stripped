import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { describe, it, expect } from 'vitest';
import { GET } from '../app/api/market/option-chain/route';
import { getAdminClient } from '../lib/adminClient';

describe('MCX Option Pricing Correctness & Instrument Binding', () => {
  it('strictly selects MCX exchange contracts for GOLD and excludes dead NCO contracts', async () => {
    const admin = getAdminClient();
    const { data: expiries } = await admin
      .from('instruments')
      .select('expiry')
      .eq('name', 'GOLD')
      .eq('exchange', 'MCX')
      .not('expiry', 'is', null)
      .gte('expiry', new Date().toISOString().split('T')[0])
      .in('option_type', ['CE', 'PE'])
      .order('expiry', { ascending: true });

    const expectedMcxExpiry = Array.from(new Set(expiries?.map(e => e.expiry)))[0];
    expect(expectedMcxExpiry).toBeDefined();

    const req = new Request('http://localhost/api/market/option-chain?symbol=GOLD');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.symbol).toBe('GOLD');
    expect(json.expiry).toBe(expectedMcxExpiry);

    // Verify strike 159000 row identity binding
    const row159k = json.strikes?.find((s: any) => s.strike === 159000);
    expect(row159k).toBeDefined();

    expect(row159k.ce).toEqual({
      token: 142421255,
      symbol: 'GOLD26AUG159000CE',
      id: 'MCX:GOLD26AUG159000CE',
    });

    expect(row159k.pe).toEqual({
      token: 142574855,
      symbol: 'GOLD26AUG159000PE',
      id: 'MCX:GOLD26AUG159000PE',
    });
  }, 15000);
});
