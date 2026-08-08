export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getRedisClient, isRedisMock } from '@/lib/redis';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function GET() {
  const today = new Date().toISOString().split('T')[0];
  const out: any = { today };

  // 1. What MCX GOLD futures exist?
  const { data: futs } = await supabase
    .from('instruments')
    .select('tradingsymbol, name, segment, instrument_type, expiry')
    .eq('exchange', 'MCX')
    .in('instrument_type', ['FUTCOM', 'FUT', 'MAPPED_FUT'])
    .eq('name', 'GOLD')
    .gte('expiry', today)
    .order('expiry', { ascending: true });
  out.futures = futs?.map(f => `${f.tradingsymbol} (${f.expiry}, ${f.segment}, ${f.instrument_type})`);

  // 2. Redis prices for each
  const kiteIds = (futs || []).map(f => `MCX:${f.tradingsymbol}`);
  out.kiteIds = kiteIds;
  const redisPrices: Record<string, number | null> = {};
  if (!isRedisMock() && kiteIds.length > 0) {
    try {
      const redis = getRedisClient();
      const cached = await redis.hmget('market:quotes', ...kiteIds);
      kiteIds.forEach((k, i) => {
        const raw = cached[i];
        if (raw) {
          try { redisPrices[k] = JSON.parse(raw as string).last_price ?? null; }
          catch { redisPrices[k] = null; }
        } else {
          redisPrices[k] = null;
        }
      });
    } catch (e: any) { out.redisError = e.message; }
  }
  out.redisPrices = redisPrices;

  // 3. Which one would be picked?
  const live = kiteIds.find(k => (redisPrices[k] ?? 0) > 0);
  out.pickedFuture = live ?? kiteIds[0] ?? 'NONE';
  out.pickedPrice = redisPrices[out.pickedFuture] ?? 'no price';

  // 4. How many MCX GOLD options exist per expiry?
  const { data: opts } = await supabase
    .from('instruments')
    .select('expiry, strike_price')
    .eq('exchange', 'MCX')
    .eq('name', 'GOLD')
    .in('option_type', ['CE', 'PE'])
    .gte('expiry', today)
    .order('expiry', { ascending: true });
  const expiryCounts: Record<string, number> = {};
  const expiryStrikes: Record<string, number[]> = {};
  for (const o of (opts || [])) {
    expiryCounts[o.expiry] = (expiryCounts[o.expiry] || 0) + 1;
    if (!expiryStrikes[o.expiry]) expiryStrikes[o.expiry] = [];
    if (!expiryStrikes[o.expiry].includes(o.strike_price)) expiryStrikes[o.expiry].push(o.strike_price);
  }
  out.optionsByExpiry = Object.entries(expiryCounts).map(([exp, count]) => {
    const strikes = expiryStrikes[exp].sort((a,b)=>a-b);
    const steps = strikes.length > 1 ? [...new Set(strikes.slice(1).map((s,i) => s - strikes[i]))] : [];
    return { expiry: exp, rowCount: count, uniqueStrikes: strikes.length, steps, min: strikes[0], max: strikes[strikes.length-1] };
  });

  return NextResponse.json(out, { status: 200 });
}
