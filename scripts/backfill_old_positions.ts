import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const client = new Client({
  host: 'db.cpcvklekwwawgtgbyrmp.supabase.co',
  port: 5432,
  user: 'postgres',
  password: process.env.SUPABASE_DB_PASSWORD!,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});

async function run() {
  await client.connect();
  console.log('Connected. Running backfill migration for old positions...');

  // Update duration_seconds on closed positions where it is 0
  const durationUpdate = await client.query(`
    UPDATE public.positions
    SET duration_seconds = EXTRACT(EPOCH FROM (exit_time - entry_time))::integer
    WHERE status = 'closed'
      AND (duration_seconds IS NULL OR duration_seconds = 0)
      AND exit_time IS NOT NULL
      AND entry_time IS NOT NULL;
  `);
  console.log(`Updated duration_seconds for ${durationUpdate.rowCount} old positions.`);

  // Update brokerage on closed positions where it is 0, using entry_brokerage
  const brokerageUpdate = await client.query(`
    UPDATE public.positions
    SET brokerage = entry_brokerage
    WHERE status = 'closed'
      AND (brokerage IS NULL OR brokerage = 0)
      AND entry_brokerage > 0;
  `);
  console.log(`Updated brokerage using entry_brokerage for ${brokerageUpdate.rowCount} old positions.`);

  // Update legacy MARGIN_CREDIT transaction ref_ids to match the 'MRG_RET_<position_id>' standard format
  const marginRefUpdate = await client.query(`
    UPDATE public.transactions t
    SET ref_id = 'MRG_RET_' || p.id
    FROM public.positions p
    JOIN public.orders o ON o.info = p.id::text AND o.is_exit = true
    WHERE t.type = 'MARGIN_CREDIT'
      AND t.ref_id = 'CLOSE_MRG_' || o.idempotency_key
      AND p.status = 'closed'
      AND o.idempotency_key IS NOT NULL;
  `);
  console.log(`Backfilled transaction ref_ids for ${marginRefUpdate.rowCount} old margins.`);

  await client.end();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
