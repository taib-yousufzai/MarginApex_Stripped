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
    SELECT user_id, segment, strike_range, side
    FROM public.segment_settings
    WHERE segment = 'MCX-OPT';
  `);
  console.log('segment_settings for MCX-OPT:', res.rows);
  await client.end();
}

main().catch(console.error);
