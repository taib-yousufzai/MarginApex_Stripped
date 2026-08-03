import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing env vars');
  process.exit(1);
}

const supabase = createClient(url, key);

async function testLatency() {
  console.time('Instruments Query');
  const baseName = 'CRUDEOIL';
  const { data, error } = await supabase
    .from('instruments')
    .select('tradingsymbol')
    .eq('name', baseName)
    .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
    .gte('expiry', new Date().toISOString().split('T')[0])
    .order('expiry', { ascending: true })
    .limit(1)
    .maybeSingle();
  console.timeEnd('Instruments Query');
  console.log('Result:', data, 'Error:', error);
}

testLatency().catch(console.error);
