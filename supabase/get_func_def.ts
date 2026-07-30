// @ts-ignore
import { Client } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: './.env.local' });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Missing DATABASE_URL env var');
  process.exit(1);
}

const client = new Client({ connectionString });

async function run() {
  await client.connect();
  const res = await client.query(`
    SELECT pg_get_functiondef(p.oid) as def
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'process_executed_position';
  `);
  console.log('--- ACTIVE process_executed_position DEFINITION ---');
  console.log(res.rows[0]?.def);
  await client.end();
}
run();
