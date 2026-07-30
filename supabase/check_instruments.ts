import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config({ path: './.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url!, key!);

async function run() {
  const { data: inst } = await supabase
    .from('instruments')
    .select('*')
    .ilike('tradingsymbol', '%SENSEX%')
    .limit(10);
  console.log('--- SENSEX INSTRUMENTS ---');
  console.log(inst?.map(i => ({
    tradingsymbol: i.tradingsymbol,
    lot_size: i.lot_size,
    name: i.name
  })));
}
run();
