import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config({ path: './.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url!, key!);

async function run() {
  const { data: settings } = await supabase.from('segment_settings').select('*');
  console.log('--- SEGMENT SETTINGS ---');
  console.table(settings?.map(s => ({
    segment: s.segment,
    side: s.side,
    comm_type: s.commission_type,
    comm_val: s.commission_value,
    carry_comm_type: s.carry_commission_type,
    carry_comm_val: s.carry_commission_value
  })));

  const { data: scalper } = await supabase.from('scalper_segment_settings').select('*');
  console.log('--- SCALPER SEGMENT SETTINGS ---');
  console.table(scalper?.map(s => ({
    user_id: s.user_id,
    segment: s.segment,
    side: s.side,
    comm_type: s.commission_type,
    comm_val: s.commission_value,
    carry_comm_type: s.carry_commission_type,
    carry_comm_val: s.carry_commission_value
  })));
}
run();
