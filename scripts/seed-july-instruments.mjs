/**
 * seed-july-instruments.mjs
 *
 * One-shot script: upserts the July/August 2026 MCX + CDS futures instrument
 * rows into the `instruments` table so the ticker daemon can resolve their
 * instrument_tokens and subscribe to Kite's WebSocket feed.
 *
 * Run once:  node scripts/seed-july-instruments.mjs
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Instruments extracted directly from https://api.kite.trade/instruments
// Format: { id, instrument_token, tradingsymbol, exchange, expiry, instrument_type, segment }
const instruments = [
  // CDS Forex futures (monthly, Jul 2026)
  { id: 'CDS:USDINR26JULFUT',    instrument_token: 323843,    tradingsymbol: 'USDINR26JULFUT',    exchange: 'CDS', expiry: '2026-07-29', instrument_type: 'FUT', segment: 'CDS-FUT' },
  { id: 'CDS:EURINR26JULFUT',    instrument_token: 298243,    tradingsymbol: 'EURINR26JULFUT',    exchange: 'CDS', expiry: '2026-07-29', instrument_type: 'FUT', segment: 'CDS-FUT' },
  { id: 'CDS:GBPINR26JULFUT',    instrument_token: 303107,    tradingsymbol: 'GBPINR26JULFUT',    exchange: 'CDS', expiry: '2026-07-29', instrument_type: 'FUT', segment: 'CDS-FUT' },
  { id: 'CDS:JPYINR26JULFUT',    instrument_token: 322563,    tradingsymbol: 'JPYINR26JULFUT',    exchange: 'CDS', expiry: '2026-07-29', instrument_type: 'FUT', segment: 'CDS-FUT' },

  // MCX Commodity futures
  { id: 'MCX:CRUDEOIL26JULFUT',  instrument_token: 133299719, tradingsymbol: 'CRUDEOIL26JULFUT',  exchange: 'MCX', expiry: '2026-07-20', instrument_type: 'FUT', segment: 'MCX-FUT', lot_size: 100 },
  { id: 'MCX:SILVER26JULFUT',    instrument_token: 118822407, tradingsymbol: 'SILVER26JULFUT',    exchange: 'MCX', expiry: '2026-07-03', instrument_type: 'FUT', segment: 'MCX-FUT', lot_size: 30  },
  { id: 'MCX:NATURALGAS26JULFUT',instrument_token: 137903367, tradingsymbol: 'NATURALGAS26JULFUT',exchange: 'MCX', expiry: '2026-07-28', instrument_type: 'FUT', segment: 'MCX-FUT', lot_size: 1250},
  { id: 'MCX:COPPER26JULFUT',    instrument_token: 143884295, tradingsymbol: 'COPPER26JULFUT',    exchange: 'MCX', expiry: '2026-07-31', instrument_type: 'FUT', segment: 'MCX-FUT', lot_size: 2500},
  // Gold MCX is bimonthly — no July contract, next active is August
  { id: 'MCX:GOLD26AUGFUT',      instrument_token: 119445255, tradingsymbol: 'GOLD26AUGFUT',      exchange: 'MCX', expiry: '2026-08-05', instrument_type: 'FUT', segment: 'MCX-FUT', lot_size: 100 },
];

async function main() {
  const rows = instruments.map(i => ({
    id: i.id,
    instrument_token: i.instrument_token,
    tradingsymbol: i.tradingsymbol,
    exchange: i.exchange,
    expiry: i.expiry,
    instrument_type: i.instrument_type,
    segment: i.segment,
    lot_size: i.lot_size ?? 0,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('instruments')
    .upsert(rows, { onConflict: 'id' });

  if (error) {
    console.error('Upsert failed:', error.message);
    process.exit(1);
  }

  console.log(`✓ Upserted ${rows.length} instrument rows:`);
  rows.forEach(r => console.log(`  ${r.id}  token=${r.instrument_token}  expiry=${r.expiry}`));
}

main();
