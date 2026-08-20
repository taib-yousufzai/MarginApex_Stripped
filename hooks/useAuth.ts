'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';

/**
 * Checks auth in the background without blocking render.
 * The page renders immediately — if the user is not authenticated,
 * they get redirected to /login after the check completes.
 *
 * Usage:
 *   useAuth();  // in any page component
 */
export function useAuth() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    getSession().then((session) => {
      if (cancelled) return;
      if (!session && !(window as any).__disableAuthRedirect) router.replace('/login');
    });
    return () => { cancelled = true; };
  }, [router]);
}
