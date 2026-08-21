import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { getAdminClient } from '../lib/adminClient';

async function main() {
  const admin = getAdminClient();
  const today = new Date().toISOString().split('T')[0];

  console.log('Querying MCX futures for GOLD:');
  const { data: futs, error } = await admin
    .from('instruments')
    .select('id, instrument_token, tradingsymbol, name, exchange, segment, expiry')
    .eq('name', 'GOLD')
    .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
    .gte('expiry', today)
    .order('expiry', { ascending: true });

  if (error) console.error('Error:', error);
  else console.log('GOLD futures count:', futs?.length, futs);

  console.log('\nQuerying MCX futures for all commodities:');
  const { data: allFuts } = await admin
    .from('instruments')
    .select('id, instrument_token, tradingsymbol, name, exchange, segment, expiry')
    .in('name', ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS'])
    .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
    .gte('expiry', today)
    .order('name')
    .order('expiry', { ascending: true });

  console.log('Active commodity futures:', allFuts);

  process.exit(0);
}

main();
