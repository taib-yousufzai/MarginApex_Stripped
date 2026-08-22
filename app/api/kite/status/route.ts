/**
 * Kite Auth Status
 * GET /api/kite/status
 *
 * Checks if the user has a valid Kite session.
 * Priority: cookie → DB → not connected
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadKiteSession, getSharedKiteSession } from '@/lib/kiteSession';

async function getSupabaseUserId(request: NextRequest): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) return null;

  const cookieHeader = request.headers.get('cookie') ?? '';
  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { cookie: cookieHeader } },
  });

  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ connected: false, reason: 'not_configured' });
  }

  // ── 1. Check cookie first (fast path) ────────────────────────────────────
  let accessToken = request.cookies.get('kite_access_token')?.value;
  console.log('[Kite Status] Cookie token exists:', !!accessToken);

  // ── 2. Fall back to DB if cookie missing ─────────────────────────────────
  if (!accessToken) {
    const supabaseUserId = await getSupabaseUserId(request);
    console.log('[Kite Status] Resolved Supabase User ID:', supabaseUserId);
    if (supabaseUserId) {
      const session = await loadKiteSession(supabaseUserId);
      console.log('[Kite Status] DB Session found:', !!session);
      if (session) {
        accessToken = session.accessToken;
      }
    }
  }

  // ── 3. Fall back to Shared Session if still missing ──────────────────────
  if (!accessToken) {
    console.log('[Kite Status] Trying shared session fallback...');
    const sharedSession = await getSharedKiteSession();
    if (sharedSession) {
      console.log('[Kite Status] Shared session found.');
      accessToken = sharedSession.accessToken;
    }
  }

  let isAutoLogged = false;

  if (!accessToken) {
    console.log('[Kite Status] No access token found in cookie or DB — attempting auto-login...');
    try {
      const { performKiteLogin } = await import('@/scripts/ticker/kiteAutoLogin');
      const session = await performKiteLogin();
      accessToken = session.accessToken;
      isAutoLogged = true;
    } catch (autoErr) {
      console.error('[Kite Status] Auto-login attempt failed:', autoErr);
      return NextResponse.json({ connected: false, reason: 'no_token' });
    }
  }

  // ── 4. Verify token is still valid with Kite ─────────────────────────────
  try {
    let response = await fetch('https://api.kite.trade/user/profile', {
      headers: {
        'X-Kite-Version': '3',
        'Authorization': `token ${apiKey}:${accessToken}`,
      },
      cache: 'no-store',
    });

    if (!response.ok && !isAutoLogged) {
      const errorBody = await response.text();
      console.error('[Kite Status] Token invalid (status', response.status, ') — attempting auto-login recovery...');
      try {
        const { performKiteLogin } = await import('@/scripts/ticker/kiteAutoLogin');
        const session = await performKiteLogin();
        accessToken = session.accessToken;
        isAutoLogged = true;

        // Re-check profile with fresh token
        response = await fetch('https://api.kite.trade/user/profile', {
          headers: {
            'X-Kite-Version': '3',
            'Authorization': `token ${apiKey}:${accessToken}`,
          },
          cache: 'no-store',
        });
      } catch (autoErr) {
        console.error('[Kite Status] Auto-login recovery failed:', autoErr);
        return NextResponse.json({ connected: false, reason: 'token_invalid' });
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[Kite Status] Kite profile check failed after retry:', response.status, errorBody);
      return NextResponse.json({ connected: false, reason: 'token_invalid' });
    }

    const data = await response.json() as {
      data?: { user_name?: string; email?: string; user_id?: string };
    };

    const res = NextResponse.json({
      connected: true,
      userName: data.data?.user_name,
      email: data.data?.email,
      kiteUserId: data.data?.user_id,
    });

    if (isAutoLogged && accessToken) {
      res.cookies.set('kite_access_token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 60 * 60,
      });
    }

    return res;
  } catch {
    return NextResponse.json({ connected: false, reason: 'network_error' });
  }
}
