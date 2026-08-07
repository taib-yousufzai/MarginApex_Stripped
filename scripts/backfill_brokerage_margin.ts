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

// Segment mapping helpers
function mapSymbolToDbSegment(symbol: string, settlement: string): string {
  const symUp = symbol.toUpperCase();
  const segUp = (settlement || '').toUpperCase();
  
  if (['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'].some(c => symUp === c || symUp.startsWith(c + 'USDT'))) {
    return 'CRYPTO';
  }
  
  if (symbol.includes(':')) {
    const ex = symbol.split(':')[0].toUpperCase();
    if (ex === 'MCX') {
      return symUp.endsWith('FUT') ? 'MCX-FUT' : 'MCX-OPT';
    }
    if (ex === 'BSE') {
      return (symUp.endsWith('FUT') || symUp.endsWith('INDEX')) ? 'BFO-FUT' : 'BFO-OPT';
    }
    if (ex === 'CDS') {
      return 'CDS-FUT';
    }
  }

  if (segUp === 'INDEX-OPT' || segUp === 'INDEX-OPTIONS') return 'INDEX-OPT';
  if (segUp === 'STOCK-OPT' || segUp === 'STOCK-OPTIONS') return 'STOCK-OPT';
  if (segUp === 'INDEX-FUT' || segUp === 'INDEX-FUTURES') return 'INDEX-FUT';
  if (segUp === 'STOCK-FUT' || segUp === 'STOCK-FUTURES') return 'STOCK-FUT';
  if (segUp === 'NSE-EQ' || segUp === 'EQUITY') return 'NSE-EQ';
  if (segUp === 'MCX-FUT' || segUp === 'MCX') return 'MCX-FUT';
  if (segUp === 'MCX-OPT') return 'MCX-OPT';
  
  return segUp || 'NSE-EQ';
}

function getLotSizeFallback(symbol: string): number {
  const n = symbol.toUpperCase();
  if (n.includes('BANKNIFTY') || n.includes('BANKEX')) return 30;
  if (n.includes('FINNIFTY')) return 60;
  if (n.includes('MIDCP') || n.includes('MIDCAP') || n.includes('MIDCPNIFTY')) return 120;
  if (n.includes('SENSEX')) return 20;
  if (n.includes('NIFTY')) return 65;
  return 1;
}

async function main() {
  await client.connect();
  console.log('Connected to DB');

  // 1. Fetch all positions where brokerage = 0 or margin_required = 0
  const posRes = await client.query(`
    SELECT p.id, p.user_id, p.symbol, p.side, p.status, p.qty_total, p.avg_price, p.entry_price, p.settlement, p.product_type, p.brokerage, p.margin_required,
           pr.parent_id, pr.trading_mode
    FROM public.positions p
    JOIN public.profiles pr ON p.user_id = pr.id
    WHERE p.brokerage = 0 OR p.margin_required = 0
    ORDER BY p.updated_at DESC;
  `);

  console.log(`Found ${posRes.rows.length} positions to backfill.`);

  for (const pos of posRes.rows) {
    const dbSegment = mapSymbolToDbSegment(pos.symbol, pos.settlement);
    const tradingMode = pos.trading_mode || 'normal';
    const settingsTable = tradingMode === 'scalper' ? 'scalper_segment_settings' : 'segment_settings';

    // 2. Fetch segment settings for this user/segment/side
    let { rows: settingsRows } = await client.query(`
      SELECT * FROM public.${settingsTable}
      WHERE user_id = $1 AND segment = $2 AND side = $3;
    `, [pos.user_id, dbSegment, pos.side]);

    // Fallback to parent
    if (settingsRows.length === 0 && pos.parent_id) {
      const parentRes = await client.query(`
        SELECT * FROM public.${settingsTable}
        WHERE user_id = $1 AND segment = $2 AND side = $3;
      `, [pos.parent_id, dbSegment, pos.side]);
      settingsRows = parentRes.rows;
    }

    // Fallback to global
    if (settingsRows.length === 0) {
      const globalRes = await client.query(`
        SELECT * FROM public.segment_settings
        WHERE user_id = '00000000-0000-0000-0000-000000000000' AND segment = $1 AND side = $2;
      `, [dbSegment, pos.side]);
      settingsRows = globalRes.rows;
    }

    const setting = settingsRows[0] || {
      commission_type: 'Per Crore',
      commission_value: 0,
      intraday_type: 'Multiplier',
      intraday_leverage: 10,
      holding_type: 'Multiplier',
      holding_leverage: 10,
    };

    // 3. Resolve lot size
    const cleanSym = pos.symbol.includes(':') ? pos.symbol.split(':')[1] : pos.symbol;
    const lotRes = await client.query(`
      SELECT lot_size FROM public.script_settings
      WHERE $1 LIKE '%' || symbol || '%'
      ORDER BY length(symbol) DESC LIMIT 1;
    `, [cleanSym]);
    const lotSize = Number(lotRes.rows[0]?.lot_size || getLotSizeFallback(pos.symbol));

    const price = Number(pos.avg_price || pos.entry_price || 0);
    const qty = Number(pos.qty_total || 0);
    const exposure = qty * price;
    const lots = qty / lotSize;

    // 4. Calculate Brokerage
    let computedBrokerage = 0;
    if (dbSegment !== 'CRYPTO') {
      const commType = setting.commission_type || 'Per Crore';
      const commVal = Number(setting.commission_value || 0);
      let singleLeg = 0;
      if (commVal > 0) {
        if (commType === 'Per Crore') {
          singleLeg = (exposure * commVal) / 10_000_000;
        } else if (commType === 'Per Lot') {
          singleLeg = lots * commVal;
        } else if (commType === 'Per Trade' || commType === 'Flat') {
          singleLeg = commVal;
        } else {
          singleLeg = exposure * 0.001;
        }
      }
      computedBrokerage = Math.round(singleLeg * 2 * 100) / 100;
    }

    // 5. Calculate Margin Portion
    const isCarry = pos.product_type === 'CARRY';
    const levType = isCarry ? (setting.holding_type || 'Multiplier') : (setting.intraday_type || 'Multiplier');
    const levVal = Number(isCarry ? (setting.holding_leverage || 10) : (setting.intraday_leverage || 10)) || 10;
    
    let computedMargin = 0;
    if (levType === 'Fixed') {
      computedMargin = lots * levVal;
    } else if (levType === '%') {
      computedMargin = exposure * (levVal / 100);
    } else {
      computedMargin = exposure / levVal;
    }
    computedMargin = Math.round(computedMargin * 100) / 100;

    // Update if currently 0
    const finalBrokerage = Number(pos.brokerage) === 0 ? computedBrokerage : Number(pos.brokerage);
    const finalMargin = Number(pos.margin_required) === 0 ? computedMargin : Number(pos.margin_required);

    console.log(`Updating position ${pos.id} (${pos.symbol}):`);
    console.log(`  Qty: ${qty}, Price: ${price}, Segment: ${dbSegment}`);
    console.log(`  Brokerage: ${pos.brokerage} -> ${finalBrokerage}`);
    console.log(`  Margin Required: ${pos.margin_required} -> ${finalMargin}`);

    await client.query(`
      UPDATE public.positions
      SET brokerage = $1,
          entry_brokerage = $2,
          margin_required = $3
      WHERE id = $4;
    `, [finalBrokerage, finalBrokerage, finalMargin, pos.id]);
  }

  await client.end();
  console.log('Backfill completed successfully!');
}

main().catch(console.error);
