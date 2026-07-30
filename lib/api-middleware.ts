import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import { getRole } from './auth';
import { Permission, hasPermission } from './permissions';

export interface AuthContext {
  adminClient: SupabaseClient;
  callerUser: User;
  callerRole: string;
}

function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceKey) throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Validates the Bearer token, fetches the user, and ensures they have all required permissions.
 *
 * Returns AuthContext on success.
 * Returns a Response (401 or 403) on failure.
 */
export async function requireAuth(
  request: Request,
  requiredPermissions: Permission[] = []
): Promise<AuthContext | Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let adminClient: SupabaseClient;
  try {
    adminClient = createAdminClient();
  } catch (e) {
    console.error('[requireAuth] createAdminClient failed:', e);
    return Response.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const { getUserFromRequest } = await import('./adminClient');
  const user = await getUserFromRequest(request);
  if (!user) {
    console.error('[requireAuth] getUser failed or token expired');
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const role = getRole(user);

  for (const perm of requiredPermissions) {
    if (!hasPermission(role, perm)) {
      return Response.json({ error: `Forbidden: Missing ${perm}` }, { status: 403 });
    }
  }

  return { adminClient, callerUser: user, callerRole: role };
}
