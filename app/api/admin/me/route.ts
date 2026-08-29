import { NextResponse } from 'next/server';
import { requireAdmin } from '../_auth';

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  const { adminClient, callerUser } = auth;

  const { data: profile, error } = await adminClient
    .from('profiles')
    .select('id, client_id, email, full_name, role, phone')
    .eq('id', callerUser.id)
    .single();

  if (error || !profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
  }

  return NextResponse.json(profile);
}
