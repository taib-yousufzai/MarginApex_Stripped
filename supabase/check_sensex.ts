import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env vars
dotenv.config({ path: './.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing env vars url:', url, 'key:', key ? 'present' : 'missing');
  process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
  console.log('--- Segment Settings for SENSEX/BFO ---');
  const { data: segmentSettings, error: err1 } = await supabase
    .from('segment_settings')
    .select('*')
    .eq('segment', 'BFO');
  if (err1) console.error('Error fetching segment settings:', err1);
  else console.log('Segment Settings:', segmentSettings);

  const { data: scalperSettings, error: err2 } = await supabase
    .from('scalper_segment_settings')
    .select('*')
    .eq('segment', 'BFO');
  if (err2) console.error('Error fetching scalper settings:', err2);
  else console.log('Scalper Settings:', scalperSettings);

  console.log('\n--- Script Settings matching SENSEX ---');
  const { data: scriptSettings, error: err3 } = await supabase
    .from('script_settings')
    .select('*')
    .ilike('symbol', '%SENSEX%');
  if (err3) console.error('Error fetching script settings:', err3);
  else console.log('Script Settings:', scriptSettings);

  console.log('\n--- Positions matching SENSEX ---');
  const { data: positions, error: err4 } = await supabase
    .from('positions')
    .select('*')
    .ilike('symbol', '%SENSEX%')
    .order('created_at', { ascending: false });
  if (err4) console.error('Error fetching positions:', err4);
  else {
    positions.forEach(p => {
      console.log(`Position ID: ${p.id}, Symbol: ${p.symbol}, Side: ${p.side}, Status: ${p.status}, Qty: ${p.qty_total}, Brokerage: ${p.brokerage}, Exit Brokerage: ${p.exit_brokerage}, entry_brokerage: ${p.entry_brokerage}`);
    });
  }

  console.log('\n--- Orders matching SENSEX ---');
  const { data: orders, error: err5 } = await supabase
    .from('orders')
    .select('*')
    .ilike('symbol', '%SENSEX%')
    .order('created_at', { ascending: false });
  if (err5) console.error('Error fetching orders:', err5);
  else {
    orders.forEach(o => {
      console.log(`Order ID: ${o.id}, Symbol: ${o.symbol}, Side: ${o.side}, Qty: ${o.qty}, Lots: ${o.lots}, FillPrice: ${o.fill_price}, OrderType: ${o.order_type}, Brokerage: ${o.brokerage}`);
    });
  }
}

run();
