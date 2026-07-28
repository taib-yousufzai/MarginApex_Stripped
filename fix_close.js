const fs = require('fs');
let content = fs.readFileSync('app/api/positions/[id]/close/route.ts', 'utf8');

// Replace the sequential fetching block with a flat speculative execution!
const flatBlock = \
  let body: any = {};
  try {
    body = await request.json();
  } catch {}

  const speculativeSymbol = body.symbol || '';
  const speculativeSegment = body.settlement || '';
  const speculativeSide = body.side || '';
  const clientPrice = body.client_price ? Number(body.client_price) : undefined;

  let segmentId = 'nse';
  if (speculativeSymbol || speculativeSegment) {
    const ex = (speculativeSymbol.includes(':') ? speculativeSymbol.split(':')[0] : 'NSE').toUpperCase();
    const segUpper = speculativeSegment.toUpperCase();
    if (ex === 'MCX' || segUpper.includes('MCX')) segmentId = 'mcx';
    else if (ex === 'BSE' || segUpper.includes('BSE') || segUpper.includes('BFO')) segmentId = 'bse';
    else if (ex === 'CDS' || ex === 'FOREX' || segUpper.includes('CDS') || segUpper.includes('FOREX')) segmentId = 'forex';
    else if (ex === 'COMEX' || segUpper.includes('COMEX')) segmentId = 'comex';
  }

  // 1. MASSIVE PARALLEL FETCH (Speculative)
  const [posResult, profileResult, hrResult, segSettingResult, kiteLtp] = await Promise.all([
    admin.from('positions').select('*').eq('id', positionId).eq('user_id', user.id).eq('status', 'open').single(),
    admin.from('profiles').select('parent_id, trading_mode').eq('id', user.id).single(),
    (!speculativeSegment.toUpperCase().includes('CRYPTO')) 
        ? admin.from('trading_hours').select('name, start_time, end_time, is_active').eq('id', segmentId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    admin.from('segment_settings').select('exit_buffer, profit_hold_sec, loss_hold_sec, entry_buffer, commission_type, commission_value, carry_commission_type, carry_commission_value')
        .eq('user_id', user.id) // using user.id initially as best guess if parent_id is unknown
        .eq('segment', speculativeSegment)
        .eq('side', speculativeSide)
        .maybeSingle(),
    fetchLtp(speculativeSymbol, speculativeSegment)
  ]);

  const { data: pos, error: posErr } = posResult;
  if (posErr || !pos) {
    return NextResponse.json({ error: 'Position not found or already closed' }, { status: 404 });
  }

  // Verify speculative parameters
  if (pos.symbol !== speculativeSymbol || pos.settlement !== speculativeSegment || pos.side !== speculativeSide) {
    // If they mismatched, we could re-fetch, but our UI shouldn't send mismatched data
    return NextResponse.json({ error: 'Position sync error. Please refresh and try again.' }, { status: 400 });
  }

  // Check market hours
  try {
    const segmentHour = hrResult?.data;
    if (segmentHour) {
      if (!segmentHour.is_active) {
        return NextResponse.json({ error: 'market is closed' }, { status: 400 });
      }
      const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const dayOfWeek = nowIST.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        return NextResponse.json({ error: 'market is closed' }, { status: 400 });
      }
      const currentHHMM = \\\\\\:\\\\\\;
      if (currentHHMM < segmentHour.start_time || currentHHMM >= segmentHour.end_time) {
        return NextResponse.json({ error: 'market is closed' }, { status: 400 });
      }
    }
  } catch (err) {
    console.error('[POST /api/positions/[id]/close] Market hours check error:', err);
  }

  const { data: segSetting } = segSettingResult;
\;

const startIdx = content.indexOf('// 1. Parallel fetch position and profile');
const endIdx = content.indexOf('const profitHoldSec = segSetting?.profit_hold_sec ?? 120;');

if (startIdx !== -1 && endIdx !== -1) {
    content = content.substring(0, startIdx) + flatBlock + content.substring(endIdx);
    fs.writeFileSync('app/api/positions/[id]/close/route.ts', content);
    console.log('Successfully flattened app/api/positions/[id]/close/route.ts');
} else {
    console.log('Could not find indices!');
}
