/**
 * PATCH  /api/admin/payinout/[id]  — Approve or reject a pay request
 * DELETE /api/admin/payinout/[id]  — Hard-delete a pay request
 *
 * Validates: Requirements 6.1–6.11, 7.1–7.5, 18.1, 18.2, 19.1
 */

import { requireSuperAdmin } from '../../_auth';

// ---------------------------------------------------------------------------
// PATCH handler — approve or reject
// ---------------------------------------------------------------------------

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller (super_admin only)
    // Validates: Requirements 6.1, 19.1
    const authResult = await requireSuperAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Resolve dynamic route param
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Step 3: Parse request body
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const action = body.action;

    // Step 4: Validate action value
    // Validates: Requirement 6.10
    if (action !== 'approve' && action !== 'reject') {
      return Response.json({ error: 'Invalid action' }, { status: 400 });
    }

    // ---------------------------------------------------------------------------
    // Approve path
    // ---------------------------------------------------------------------------
    if (action === 'approve') {
      // Step 5a: Call the atomic RPC function
      // Validates: Requirements 6.2, 6.3, 6.4, 18.1, 18.2
      const { data: rpcData, error: rpcError } = await adminClient.rpc('approve_pay_request', {
        request_id: id,
        admin_id: callerUser.id,
      });

      if (rpcError) {
        console.error('[PATCH /api/admin/payinout/[id]] RPC error:', rpcError.message);
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }

      // Step 5b: Inspect the returned code field
      const code = (rpcData as { code?: number } | null)?.code;

      if (code === 404) {
        // Validates: Requirement 6.2
        return Response.json({ error: 'Not found' }, { status: 404 });
      }

      if (code === 409) {
        // Validates: Requirement 6.3
        return Response.json({ error: 'Request is not pending' }, { status: 409 });
      }

      if (code !== 200) {
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }

      // Step 5c: Fetch the pay request to get target_user_id for act_log
      const { data: payRow, error: fetchError } = await adminClient
        .from('pay_requests')
        .select('user_id')
        .eq('id', id)
        .single();

      if (fetchError || payRow === null) {
        // Approval succeeded but we can't write the act_log — still return success
        console.error('[PATCH /api/admin/payinout/[id]] fetch after approve error:', fetchError?.message);
        return Response.json({ status: 'APPROVED' }, { status: 200 });
      }

      // Step 5d: Insert act_log row for the approval
      // Validates: Requirement 6.5
      const { error: logError } = await adminClient.from('act_logs').insert({
        type: 'PAY_APPROVE',
        user_id: callerUser.id,
        target_user_id: (payRow as { user_id: string }).user_id,
      });

      if (logError) {
        console.error('[PATCH /api/admin/payinout/[id]] act_log insert error (approve):', logError.message);
      }

      // Validates: Requirement 6.6
      return Response.json({ status: 'APPROVED' }, { status: 200 });
    }

    // ---------------------------------------------------------------------------
    // Reject path
    // ---------------------------------------------------------------------------

    // Step 6a: Fetch the pay request
    // Validates: Requirements 6.2, 6.3 (reject variant)
    const { data: payRow, error: fetchError } = await adminClient
      .from('pay_requests')
      .select('id, user_id, status')
      .eq('id', id)
      .single();

    if (fetchError || payRow === null) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const row = payRow as { id: string; user_id: string; status: string };

    // Step 6b: Ensure the request is still PENDING
    if (row.status !== 'PENDING') {
      return Response.json({ error: 'Request is not pending' }, { status: 409 });
    }

    // Step 6c: Update status to REJECTED
    // Validates: Requirement 6.7
    const { error: updateError } = await adminClient
      .from('pay_requests')
      .update({ status: 'REJECTED', updated_at: new Date().toISOString() })
      .eq('id', id);

    if (updateError) {
      console.error('[PATCH /api/admin/payinout/[id]] update error (reject):', updateError.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Step 6d: Insert act_log row for the rejection
    // Validates: Requirement 6.8
    const { error: logError } = await adminClient.from('act_logs').insert({
      type: 'PAY_REJECT',
      user_id: callerUser.id,
      target_user_id: row.user_id,
    });

    if (logError) {
      console.error('[PATCH /api/admin/payinout/[id]] act_log insert error (reject):', logError.message);
    }

    // Validates: Requirement 6.9
    return Response.json({ status: 'REJECTED' }, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE handler — hard-delete a pay request
// ---------------------------------------------------------------------------

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller (super_admin only)
    // Validates: Requirements 7.1, 19.1
    const authResult = await requireSuperAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Resolve dynamic route param
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Step 3: Fetch the pay request to confirm it exists and get target_user_id
    // Validates: Requirement 7.2
    const { data: payRow, error: fetchError } = await adminClient
      .from('pay_requests')
      .select('id, user_id')
      .eq('id', id)
      .single();

    if (fetchError || payRow === null) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const row = payRow as { id: string; user_id: string };

    // Step 4: Delete the row
    // Validates: Requirement 7.3
    const { error: deleteError } = await adminClient
      .from('pay_requests')
      .delete()
      .eq('id', id);

    if (deleteError) {
      console.error('[DELETE /api/admin/payinout/[id]] delete error:', deleteError.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Step 5: Insert act_log row for the deletion
    // Validates: Requirement 7.4
    const { error: logError } = await adminClient.from('act_logs').insert({
      type: 'PAY_DELETE',
      user_id: callerUser.id,
      target_user_id: row.user_id,
    });

    if (logError) {
      console.error('[DELETE /api/admin/payinout/[id]] act_log insert error:', logError.message);
    }

    // Validates: Requirement 7.3
    return Response.json({ deleted: true }, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
