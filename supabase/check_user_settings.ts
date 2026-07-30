import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config({ path: './.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url!, key!);

async function run() {
  const userId = 'dfa9b057-9187-4054-9ae6-9179c620666e';
  const { data: segmentSettings } = await supabase
    .from('segment_settings')
    .select('*')
    .eq('user_id', userId);
  console.log('--- USER SEGMENT SETTINGS ---');
  console.table(segmentSettings?.map(s => ({
    segment: s.segment,
    side: s.side,
    comm_type: s.commission_type,
    comm_val: s.commission_value,
    carry_comm_type: s.carry_commission_type,
    carry_comm_val: s.carry_commission_value
  })));

  const { data: scalperSettings } = await supabase
    .from('scalper_segment_settings')
    .select('*')
    .eq('user_id', userId);
  console.log('--- USER SCALPER SETTINGS ---');
  console.table(scalperSettings?.map(s => ({
    segment: s.segment,
    side: s.side,
    comm_type: s.commission_type,
    comm_val: s.commission_value,
    carry_comm_type: s.carry_commission_type,
    carry_comm_val: s.carry_commission_value
  })));
}
run();
