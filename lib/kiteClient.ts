/**
 * Shared helper for Kite API calls from the client.
 * Authentication is injected automatically by the `api` transport layer.
 */

import { api } from '@/lib/api';

export async function kiteRestore(): Promise<void> {
  await api.post<void>('/api/kite/restore', {}).catch(() => {});
}

export async function kiteStatus(): Promise<{ connected: boolean; userName?: string }> {
  return api.get<{ connected: boolean; userName?: string }>('/api/kite/status');
}

export async function kiteLogin(): Promise<void> {
  // In this project, the login URL is typically /api/kite/login or a direct Zerodha redirect
  window.location.href = '/api/kite/login';
}
