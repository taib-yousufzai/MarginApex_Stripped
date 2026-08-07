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

  // Check actual ref_ids of BROKERAGE_DEBIT transactions
  const txns = await client.query(`
    SELECT type, ref_id, amount, user_id, created_at
    FROM public.transactions
    WHERE type = 'BROKERAGE_DEBIT'
    ORDER BY created_at DESC
    LIMIT 15;
  `);
  console.log('== Recent BROKERAGE_DEBIT transactions ==');
  txns.rows.forEach(r => console.log(JSON.stringify(r)));

  // Check if any ref_ids match the 'BRK_' format
  const brkFormat = await client.query(`
    SELECT count(*) as cnt FROM public.transactions
    WHERE type = 'BROKERAGE_DEBIT' AND ref_id LIKE 'BRK_%';
  `);
  console.log(`\nBROKERAGE_DEBIT with 'BRK_' prefix: ${brkFormat.rows[0].cnt}`);

  // Check other ref_id patterns
  const patterns = await client.query(`
    SELECT substring(ref_id, 1, 10) as prefix, count(*) as cnt
    FROM public.transactions
    WHERE type = 'BROKERAGE_DEBIT'
    GROUP BY prefix
    ORDER BY cnt DESC;
  `);
  console.log('\n== BROKERAGE_DEBIT ref_id patterns ==');
  patterns.rows.forEach(r => console.log(JSON.stringify(r)));

  await client.end();
}

run().catch(err => {
  console.error(err.message);
  process.exit(1);
});
