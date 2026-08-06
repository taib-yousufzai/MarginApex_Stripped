'use client';

import { getSharedSession } from '@/lib/sharedSession';

// ─── Public Types ────────────────────────────────────────────────────────────

export interface RequestOptions {
  /** Caller-provided abort signal. Composed with any internal timeout signal. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. No timeout applied when omitted. */
  timeout?: number;
}

export class ApiError extends Error {
  /** HTTP status code (e.g. 401, 404, 500). */
  readonly status: number;
  /** `code` field from the JSON error body, if present. */
  readonly code?: string;
  /** Full parsed error body (object) or raw text when JSON parsing fails. */
  readonly details?: unknown;

  constructor(status: number, details?: unknown, code?: string) {
    super(`ApiError ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

// ─── Dev Metrics (development only) ─────────────────────────────────────────

interface ApiMetricsEntry {
  path: string;
  method: string;
  durationMs: number;
  success: boolean;
  aborted: boolean;
}

declare global {
  interface Window {
    __apiMetrics?: ApiMetricsEntry[];
  }
}

// ─── Internal ApiClient interface ────────────────────────────────────────────

interface ApiClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

// ─── Core implementation ──────────────────────────────────────────────────────

async function apiCall<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const { token } = await getSharedSession();

  // Build headers
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (token !== null) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
    headers['Content-Type'] = 'application/json';
  }

  // Signal composition
  let signal: AbortSignal | undefined;
  let timeoutController: AbortController | undefined;
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const { signal: callerSignal, timeout } = options ?? {};

  if (timeout !== undefined) {
    timeoutController = new AbortController();
    timerId = setTimeout(() => timeoutController!.abort(), timeout);
  }

  if (callerSignal && timeoutController) {
    // Both signals: combine via AbortSignal.any if available, otherwise manual
    if (typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([callerSignal, timeoutController.signal]);
    } else {
      const combined = new AbortController();
      const abort = () => combined.abort();
      callerSignal.addEventListener('abort', abort, { once: true });
      timeoutController.signal.addEventListener('abort', abort, { once: true });
      signal = combined.signal;
    }
  } else if (callerSignal) {
    signal = callerSignal;
  } else if (timeoutController) {
    signal = timeoutController.signal;
  }

  const startTime = Date.now();
  let success = false;
  let aborted = false;

  try {
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined && method !== 'GET' && method !== 'DELETE'
        ? JSON.stringify(body)
        : undefined,
      signal,
      cache: 'no-store',
    });

    if (res.ok) {
      success = true;
      return res.json() as Promise<T>;
    }

    if (res.status === 401) {
      if (typeof window !== 'undefined') {
        const path = window.location.pathname;
        if (path !== '/login' && path !== '/register' && path !== '/forgot-password' && path !== '/reset-password') {
          window.location.href = '/login';
        }
      }
    }

    // Error path: parse body for structured error info
    let details: unknown;
    let code: string | undefined;
    try {
      const parsed = await res.json();
      details = parsed;
      if (parsed && typeof parsed === 'object' && 'code' in parsed) {
        code = String((parsed as Record<string, unknown>).code);
      }
    } catch {
      details = await res.text();
    }
    throw new ApiError(res.status, details, code);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'AbortError' || (err instanceof DOMException && err.name === 'AbortError'))
    ) {
      aborted = true;
    }
    throw err;
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }

    if (process.env.NODE_ENV === 'development') {
      const durationMs = Date.now() - startTime;
      if (!window.__apiMetrics) window.__apiMetrics = [];
      window.__apiMetrics.push({ path, method, durationMs, success, aborted });
    }
  }
}

// ─── Public API object ────────────────────────────────────────────────────────

export const api: ApiClient = {
  get:    (path, opts)       => apiCall('GET',    path, undefined, opts),
  post:   (path, body, opts) => apiCall('POST',   path, body,      opts),
  patch:  (path, body, opts) => apiCall('PATCH',  path, body,      opts),
  put:    (path, body, opts) => apiCall('PUT',    path, body,      opts),
  delete: (path, opts)       => apiCall('DELETE', path, undefined, opts),
};
