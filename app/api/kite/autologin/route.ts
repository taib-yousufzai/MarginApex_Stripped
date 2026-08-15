/**
 * POST / GET /api/kite/autologin
 *
 * Fully automated Zerodha login using stored credentials + TOTP.
 * Delegates to performKiteLogin() in scripts/ticker/kiteAutoLogin.ts
 * which handles the complete 5-step OAuth & cookie flow:
 *   1. POST credentials to Zerodha login endpoint → get request_id
 *   2. Generate TOTP code from secret → submit to /api/twofa
 *   3. Follow OAuth redirect → capture request_token
 *   4. Exchange request_token for access_token via Kite Connect API
 *   5. Save access_token to Supabase + set HTTP cookie
 *
 * Protected by a shared secret (AUTOLOGIN_SECRET env var).
 * Called by cron jobs or manual trigger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { performKiteLogin } from '@/scripts/ticker/kiteAutoLogin';

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleAutoLogin(request);
}

// Vercel cron jobs use GET — secret passed as query param
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleAutoLogin(request);
}

async function handleAutoLogin(request: NextRequest): Promise<NextResponse> {
  // ── Auth: verify shared secret ──────────────────────────────────────────
  const authHeader = request.headers.get('Authorization');
  const querySecret = request.nextUrl.searchParams.get('secret');
  const expectedSecret = process.env.AUTOLOGIN_SECRET;

  if (!expectedSecret) {
    return NextResponse.json({ error: 'AUTOLOGIN_SECRET not configured' }, { status: 500 });
  }
  if (authHeader !== `Bearer ${expectedSecret}` && querySecret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const session = await performKiteLogin();

    const response = NextResponse.json({
      success: true,
      expiresAt: session.expiresAt.toISOString(),
      kiteUserId: session.kiteUserId,
    });

    response.cookies.set('kite_access_token', session.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });

    console.log('[autologin] Success — session renewed until', session.expiresAt.toISOString());
    return response;
  } catch (err: any) {
    console.error('[autologin] Failed to perform auto login:', err);
    return NextResponse.json({ error: 'Auto login failed', detail: err.message || String(err) }, { status: 502 });
  }
}
