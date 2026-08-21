import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { getAdminClient } from '../lib/adminClient';

async function main() {
  const admin = getAdminClient();
  const { data: cds } = await admin
    .from('instruments')
    .select('name, tradingsymbol, exchange, segment')
    .or('exchange.eq.CDS,exchange.eq.FOREX,segment.eq.FOREX')
    .limit(50);

  console.log('Sample CDS/FOREX instruments in DB:', cds);
  process.exit(0);
}

main();
