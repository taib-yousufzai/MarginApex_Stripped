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

async function main() {
  await client.connect();
  console.log('Connected to DB');
  const res = await client.query(`
    SELECT DISTINCT strike_price
    FROM public.instruments
    WHERE name = 'BANKEX' AND option_type IN ('CE', 'PE') AND expiry = '2026-08-27'
    ORDER BY strike_price::numeric ASC;
  `);
  console.log('All BANKEX strikes:', JSON.stringify(res.rows.map(r => r.strike_price)));
  await client.end();
}

main().catch(console.error);
