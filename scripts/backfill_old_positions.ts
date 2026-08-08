/**
 * Backfill brokerage on closed positions using the commission formula from segment_settings.
 * For each closed position with brokerage = 0:
 *   1. Look up commission_type + commission_value from segment_settings
 *   2. Get lot_size from script_settings (or lots from the matching entry order)
 *   3. Calculate: (per crore: qty*price*val/1cr*2) | (per lot: lots*val*2) | (per trade: val*2)
 *   4. Update positions.brokerage
 */

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
  console.log('Connected.\n');

  // Fetch all closed positions with zero brokerage + their commission config + lot_size
  const positions = await client.query(`
    SELECT
      p.id,
      p.user_id,
      p.symbol,
      p.settlement,
      p.side,
      p.product_type,
      p.qty_total,
      p.entry_price,
      ss.commission_type,
      ss.commission_value,
      ss.carry_commission_type,
      ss.carry_commission_value,
      COALESCE(sc.lot_size, 1) AS lot_size,
      -- Get lots from the matching entry order (most accurate for Per Lot calc)
      (
        SELECT o.lots FROM public.orders o
        WHERE o.user_id = p.user_id
          AND o.symbol = p.symbol
          AND NOT o.is_exit
          AND o.status = 'EXECUTED'
          AND o.created_at >= p.entry_time - interval '60 seconds'
          AND o.created_at <= p.entry_time + interval '60 seconds'
        ORDER BY o.created_at ASC
        LIMIT 1
      ) AS entry_lots
    FROM public.positions p
    -- Join user-specific segment settings (matching settlement + side)
    LEFT JOIN public.segment_settings ss
      ON ss.user_id = p.user_id
      AND ss.segment = p.settlement
      AND ss.side = p.side
    -- Join script settings to get lot_size
    LEFT JOIN public.script_settings sc
      ON sc.symbol = p.symbol
    WHERE p.status = 'closed'
      AND (p.brokerage IS NULL OR p.brokerage = 0)
      AND ss.commission_value IS NOT NULL
      AND ss.commission_value > 0;
  `);

  console.log(`Found ${positions.rows.length} positions to backfill.\n`);

  let updated = 0;
  let skipped = 0;

  for (const pos of positions.rows) {
    const qty = Number(pos.qty_total || 0);
    const price = Number(pos.entry_price || 0);
    const commVal = Number(pos.commission_value || 0);
    const commType: string = pos.commission_type || 'Per Crore';
    const lotSize = Number(pos.lot_size || 1);
    const lots = Number(pos.entry_lots || 0) || (lotSize > 0 ? qty / lotSize : 0);

    if (qty <= 0 || price <= 0 || commVal <= 0) {
      skipped++;
      continue;
    }

    let singleLeg = 0;
    if (commType === 'Per Crore') {
      singleLeg = (qty * price * commVal) / 10_000_000;
    } else if (commType === 'Per Lot') {
      singleLeg = lots * commVal;
    } else if (commType === 'Per Trade') {
      singleLeg = commVal;
    }

    // For CARRY positions: if it was carry type, use carry rate not intraday
    let carryAddon = 0;
    if (pos.product_type === 'CARRY' && pos.carry_commission_value > 0) {
      const cType = pos.carry_commission_type || 'Per Lot';
      if (cType === 'Per Lot') carryAddon = lots * Number(pos.carry_commission_value);
      else if (cType === 'Per Crore') carryAddon = (qty * price * Number(pos.carry_commission_value)) / 10_000_000;
    }

    const brokerage = Math.round((singleLeg * 2 + carryAddon) * 100) / 100;

    if (brokerage <= 0) {
      skipped++;
      continue;
    }

    await client.query(
      `UPDATE public.positions SET brokerage = $1 WHERE id = $2`,
      [brokerage, pos.id]
    );
    updated++;
  }

  console.log(`✅ Updated: ${updated} positions`);
  console.log(`⏭  Skipped: ${skipped} positions (insufficient data or zero commission)`);

  // Summary
  const summary = await client.query(`
    SELECT
      count(*) FILTER (WHERE brokerage > 0) as with_brokerage,
      count(*) FILTER (WHERE brokerage = 0 OR brokerage IS NULL) as without_brokerage,
      ROUND(sum(brokerage)::numeric, 2) as total
    FROM public.positions WHERE status = 'closed';
  `);
  console.log('\n== Final summary ==');
  console.log(`  Positions with brokerage > 0: ${summary.rows[0].with_brokerage}`);
  console.log(`  Positions still at 0: ${summary.rows[0].without_brokerage}`);
  console.log(`  Total brokerage across all closed positions: ₹${summary.rows[0].total}`);

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
  console.error(err.message);
  process.exit(1);
});
