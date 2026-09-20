import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../_auth';
import { getRedisClient } from '@/lib/redis';
import { invalidateUserSegmentSettings } from '@/lib/redisSettingsCache';

/**
 * POST /api/admin/users/copy-settings
 * Clones segment settings from source user to target user.
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const { source, target, segments } = body;
    if (!source || !target) {
      return NextResponse.json({ error: 'Source and target user IDs are required' }, { status: 400 });
    }

    if (source === target) {
      return NextResponse.json({ error: 'Source and target user cannot be the same' }, { status: 400 });
    }

    // Verify source user exists
    const { data: sourceProfile, error: srcErr } = await adminClient
      .from('profiles')
      .select('id, full_name, role')
      .eq('id', source)
      .maybeSingle();

    if (srcErr || !sourceProfile) {
      return NextResponse.json({ error: `Source user (${source}) not found` }, { status: 404 });
    }

    // Verify target user exists
    const { data: targetProfile, error: tgtErr } = await adminClient
      .from('profiles')
      .select('id, full_name, role, parent_id')
      .eq('id', target)
      .maybeSingle();

    if (tgtErr || !targetProfile) {
      return NextResponse.json({ error: `Target user (${target}) not found` }, { status: 404 });
    }

    // Read source user segment settings
    let query = adminClient
      .from('segment_settings')
      .select('*')
      .eq('user_id', source);

    if (Array.isArray(segments) && segments.length > 0) {
      query = query.in('segment', segments);
    }

    const { data: sourceSettings, error: readErr } = await query;
    if (readErr) {
      return NextResponse.json({ error: 'Failed to read source segment settings' }, { status: 500 });
    }

    if (!sourceSettings || sourceSettings.length === 0) {
      return NextResponse.json({ error: 'No segment settings found for source user' }, { status: 404 });
    }

    // Prepare rows for target user (strip id and created_at, update user_id)
    const clonedRows = sourceSettings.map(s => {
      const { id, created_at, ...rest } = s;
      return {
        ...rest,
        user_id: target,
        updated_at: new Date().toISOString(),
      };
    });

    const { error: upsertErr } = await adminClient
      .from('segment_settings')
      .upsert(clonedRows, { onConflict: 'user_id,segment,side' });

    if (upsertErr) {
      console.error('[copy-settings] Upsert error:', upsertErr);
      return NextResponse.json({ error: 'Failed to apply copied settings to target user' }, { status: 500 });
    }

    // Invalidate Redis caches for target user
    try {
      await invalidateUserSegmentSettingsCache(target);
    } catch {}

    // Log action to act_logs
    try {
      await adminClient.from('act_logs').insert({
        user_id: target,
        action: 'SETTINGS_COPIED',
        details: {
          copied_from: source,
          segments_count: clonedRows.length,
          performed_by: callerUser.id,
        },
        created_at: new Date().toISOString(),
      });
    } catch {}

    return NextResponse.json({
      success: true,
      message: `Successfully copied ${clonedRows.length} segment rules from ${sourceProfile.full_name || source} to ${targetProfile.full_name || target}.`,
      copied_count: clonedRows.length,
    });
  } catch (err: any) {
    console.error('[POST /api/admin/users/copy-settings]', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
