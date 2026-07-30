import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl!, supabaseKey!);

async function main() {
  const { data, error } = await supabase
    .from('instruments')
    .select('tradingsymbol, expiry')
    .like('tradingsymbol', 'GOLD%')
    .is('option_type', null)
    .eq('exchange', 'MCX')
    .order('expiry', { ascending: true });

  if (error) console.error(error);
  console.log(data);
}
main();
