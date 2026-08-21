import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { getAdminClient } from '../lib/adminClient';

async function main() {
  const admin = getAdminClient();
  
  console.log('--- 1. Query DB for FOREX / CDS / Currency instruments ---');
  const { data: forexInsts, error: fErr } = await admin
    .from('instruments')
    .select('id, tradingsymbol, name, exchange, segment, instrument_type')
    .or('exchange.eq.CDS,exchange.eq.FOREX,segment.eq.FOREX,segment.eq.CDS')
    .limit(30);

  if (fErr) console.error('Error fetching forex insts:', fErr);
  else console.log('Found CDS/FOREX instruments count:', forexInsts?.length, forexInsts);

  console.log('\n--- 2. Query DB for GOLD instruments ---');
  const { data: goldInsts } = await admin
    .from('instruments')
    .select('id, tradingsymbol, name, exchange, segment, instrument_type')
    .eq('name', 'GOLD')
    .limit(10);
  console.log('GOLD instruments sample:', goldInsts);

  console.log('\n--- 3. Query DB for Currency Pairs (EURUSD, USDINR, GBPUSD, USDJPY, USDCHF, USDCAD, AUDUSD, NZDUSD, EURINR, GBPINR, JPYINR) ---');
  const currencySymbols = ['USDINR', 'EURINR', 'GBPINR', 'JPYINR', 'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'];
  const { data: currencyInsts } = await admin
    .from('instruments')
    .select('id, tradingsymbol, name, exchange, segment, instrument_type')
    .in('name', currencySymbols);
  console.log('Currency pairs found by name:', currencyInsts);

  const { data: currencyTradingsymbols } = await admin
    .from('instruments')
    .select('id, tradingsymbol, name, exchange, segment, instrument_type')
    .or(currencySymbols.map(s => `tradingsymbol.ilike.%${s}%`).join(','));
  console.log('Currency pairs found by tradingsymbol ilike:', currencyTradingsymbols);

  process.exit(0);
}

main();
