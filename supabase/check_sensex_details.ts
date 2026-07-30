import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config({ path: './.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url!, key!);

async function run() {
  const { data: positions } = await supabase
    .from('positions')
    .select('*')
    .ilike('symbol', '%SENSEX26JUL77900PE%');
  console.log('--- SENSEX26JUL77900PE POSITIONS ---');
  console.log(positions);

  const { data: orders } = await supabase
    .from('orders')
    .select('*')
    .ilike('symbol', '%SENSEX26JUL77900PE%');
  console.log('--- SENSEX26JUL77900PE ORDERS ---');
  console.log(orders);
}
run();
