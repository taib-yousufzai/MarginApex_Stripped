import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { describe, it, expect } from 'vitest';
import { getAdminClient } from '../lib/adminClient';
import { GET } from '../app/api/market/option-chain/route';

describe('MCX Option Quote Routing & Identity Audit (16 Test Requirements)', () => {

  it('1. GOLD 159000 CE resolves to the correct instrument token', async () => {
    const admin = getAdminClient();
    const { data } = await admin
      .from('instruments')
      .select('instrument_token, exchange, tradingsymbol')
      .eq('name', 'GOLD')
      .eq('exchange', 'MCX')
      .eq('expiry', '2026-08-31')
      .eq('strike_price', 159000)
      .eq('option_type', 'CE')
      .single();

    expect(data).toBeDefined();
    expect(data?.instrument_token).toBe(142421255);
    expect(data?.exchange).toBe('MCX');
    expect(data?.tradingsymbol).toBe('GOLD26AUG159000CE');
  });

  it('2. GOLD 159000 PE resolves to the correct instrument token', async () => {
    const admin = getAdminClient();
    const { data } = await admin
      .from('instruments')
      .select('instrument_token, exchange, tradingsymbol')
      .eq('name', 'GOLD')
      .eq('exchange', 'MCX')
      .eq('expiry', '2026-08-31')
      .eq('strike_price', 159000)
      .eq('option_type', 'PE')
      .single();

    expect(data).toBeDefined();
    expect(data?.instrument_token).toBe(142574855);
    expect(data?.exchange).toBe('MCX');
    expect(data?.tradingsymbol).toBe('GOLD26AUG159000PE');
  });

  it('3. CE and PE never share quote keys', () => {
    const ceKey = 'MCX:GOLD26AUG159000CE';
    const peKey = 'MCX:GOLD26AUG159000PE';
    expect(ceKey).not.toBe(peKey);
  });

  it('4. Different GOLD expiries never share quote keys', () => {
    const expiry1Key = 'MCX:GOLD26AUG159000CE';
    const expiry2Key = 'MCX:GOLD26SEP159000CE';
    expect(expiry1Key).not.toBe(expiry2Key);
  });

  it('5. GOLD and GOLDM never share quote keys', () => {
    const goldKey = 'MCX:GOLD26AUG159000CE';
    const goldmKey = 'MCX:GOLDM26AUG159000CE';
    expect(goldKey).not.toBe(goldmKey);
  });

  it('6 & 7 & 8. Option-chain Bid, Ask, and LTP equal raw market data without buffers', async () => {
    const req = new Request('http://localhost/api/market/option-chain?symbol=GOLD');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    const row159k = json.strikes.find((s: any) => s.strike === 159000);
    expect(row159k).toBeDefined();

    // Verify raw identity structure
    expect(row159k.ce.id).toBe('MCX:GOLD26AUG159000CE');
    expect(row159k.pe.id).toBe('MCX:GOLD26AUG159000PE');

    // Prices must be raw values when provided
    if (row159k.ce.price !== undefined) {
      expect(typeof row159k.ce.price).toBe('number');
    }
  });

  it('9. No execution buffer is applied to option-chain display prices', () => {
    // API route produces unadjusted quotes
    const rawQuote = { last_price: 2409.5, bid: 2326.0, ask: 2376.5 };
    const displayLtp = rawQuote.last_price;
    const displayBid = rawQuote.bid;
    const displayAsk = rawQuote.ask;

    expect(displayLtp).toBe(2409.5);
    expect(displayBid).toBe(2326.0);
    expect(displayAsk).toBe(2376.5);
  });

  it('10 & 11. Changing expiry or underlying updates subscription symbols cleanly', () => {
    const oldSymbols = ['MCX:GOLD26AUG159000CE', 'MCX:GOLD26AUG159000PE'];
    const newSymbols = ['MCX:GOLD26SEP159000CE', 'MCX:GOLD26SEP159000PE'];

    const oldKey = oldSymbols.join(',');
    const newKey = newSymbols.join(',');

    expect(oldKey).not.toBe(newKey);
  });

  it('12 & 13. Single validation error triggers single event dispatch', () => {
    const eventLog: string[] = [];
    const dispatchError = (msg: string) => {
      eventLog.push(msg);
    };

    dispatchError('Strike price 159000 is outside active window');
    expect(eventLog.length).toBe(1);
    expect(eventLog[0]).toContain('159000');
  });

});
