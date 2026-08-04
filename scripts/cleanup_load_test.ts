import { Client } from 'pg';

const client = new Client({
  host: 'db.cpcvklekwwawgtgbyrmp.supabase.co',
  port: 5432, user: 'postgres',
  password: process.env.SUPABASE_DB_PASSWORD!,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});

client.connect().then(async () => {
  // Find user WBOH24
  const userRes = await client.query(`SELECT id FROM public.profiles WHERE client_id = 'WBOH24'`);
  if (userRes.rows.length === 0) { console.log('User WBOH24 not found'); await client.end(); return; }
  const userId = userRes.rows[0].id;

  // Delete load test positions, orders, transactions
  const pos = await client.query(`DELETE FROM public.positions WHERE user_id = $1 AND symbol = 'LOAD_TEST_INFY'`, [userId]);
  const ord = await client.query(`DELETE FROM public.orders WHERE user_id = $1 AND symbol = 'LOAD_TEST_INFY'`, [userId]);
  const txn = await client.query(`DELETE FROM public.transactions WHERE user_id = $1 AND ref_id LIKE 'DEP_LOAD_TEST%'`, [userId]);

  console.log(`Deleted: ${pos.rowCount} positions, ${ord.rowCount} orders, ${txn.rowCount} transactions for WBOH24/LOAD_TEST_INFY`);
  
  // Also delete the script_settings entry we seeded
  const ss = await client.query(`DELETE FROM public.script_settings WHERE symbol = 'LOAD_TEST_INFY'`);
  console.log(`Deleted: ${ss.rowCount} script_settings rows`);

  await client.end();
}).catch(e => { console.error(e.message); process.exit(1); });
