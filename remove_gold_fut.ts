import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing keys");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log("Removing GOLD_FUT from positions...");
  const { data, error } = await supabase.from('positions').delete().eq('symbol', 'GOLD_FUT');
  console.log("Positions error:", error);
  
  console.log("Removing GOLD_FUT from orders...");
  const { data: d2, error: e2 } = await supabase.from('orders').delete().eq('symbol', 'GOLD_FUT');
  console.log("Orders error:", e2);
}
main();
