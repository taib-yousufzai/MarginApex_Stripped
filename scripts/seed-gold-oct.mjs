import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const instruments = [
  {
    id: 'MCX:GOLD26OCTFUT',
    instrument_token: 123668231,
    tradingsymbol: 'GOLD26OCTFUT',
    name: 'GOLD',
    exchange: 'MCX',
    expiry: '2026-10-05',
    instrument_type: 'FUT',
    segment: 'MCX-FUT',
    lot_size: 1
  },
  {
    id: 'MCX:GOLD',
    instrument_token: 123668231,
    tradingsymbol: 'GOLD26OCTFUT',
    name: 'GOLD',
    exchange: 'MCX',
    expiry: '2026-10-05',
    instrument_type: 'MAPPED_FUT',
    segment: 'MCX-FUT',
    lot_size: 1
  }
];

async function main() {
  const rows = instruments.map(i => ({
    ...i,
    updated_at: new Date().toISOString()
  }));

  const { error } = await supabase
    .from('instruments')
    .upsert(rows, { onConflict: 'id' });

  if (error) {
    console.error('Upsert failed:', error.message);
    process.exit(1);
  }

  console.log(`✓ Upserted ${rows.length} Gold active instrument rows:`);
  rows.forEach(r => console.log(`  ${r.id}  token=${r.instrument_token}  expiry=${r.expiry}`));
}

main();
