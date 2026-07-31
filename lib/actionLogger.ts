import { createClient } from '@supabase/supabase-js';

// Use a server-side only Supabase client configured with the service role key
// so it bypasses RLS when inserting logs from the backend.
// Construct Supabase client lazily
let supabase: ReturnType<typeof createClient> | null = null;
function getLoggerClient() {
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && supabaseServiceKey) {
      supabase = createClient(supabaseUrl, supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
  }
  return supabase;
}

export interface ActionLogParams {
  userId?: string;
  username?: string;
  role?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  device?: string;
  browser?: string;
  platform?: string;
  actionType: string;
  module: string;
  apiEndpoint?: string;
  httpMethod?: string;
  requestPayload?: any;
  responseStatus?: number;
  isSuccess?: boolean;
  errorMessage?: string;
  stackTrace?: string;
  tradeId?: string;
  orderId?: string;
  positionId?: string;
  walletBefore?: number;
  walletAfter?: number;
  marginBefore?: number;
  marginAfter?: number;
  metadata?: Record<string, any>;
}

/**
 * Strips sensitive fields (like passwords or tokens) from payload objects.
 */
function sanitizePayload(payload: any): any {
  if (payload == null || typeof payload !== 'object') return payload;

  if (Array.isArray(payload)) {
    return payload.map(sanitizePayload);
  }

  const sanitized: Record<string, any> = {};
  const sensitiveKeys = ['password', 'token', 'secret', 'auth', 'pin', 'authorization', 'cookie'];

  for (const [key, value] of Object.entries(payload)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitizePayload(value);
    }
  }

  return sanitized;
}

/**
 * Extracts the true client IP from standard reverse proxy headers.
 */
export function extractClientIp(headers: Headers): string {
  return headers.get('cf-connecting-ip') || 
         headers.get('x-forwarded-for')?.split(',')[0].trim() || 
         headers.get('x-real-ip') || 
         'unknown';
}

/**
 * Asynchronously logs an action to the database.
 * Does NOT throw errors, ensuring logging never breaks core app functionality.
 */
export async function logAction(params: ActionLogParams): Promise<void> {
  try {
    const loggerClient = getLoggerClient();
    if (!loggerClient) {
      console.warn('[ActionLogger] Service key missing. Log skipped:', params.actionType);
      return;
    }

    const payload = params.requestPayload ? sanitizePayload(params.requestPayload) : null;
    
    const { error } = await loggerClient.from('action_logs').insert({
      user_id: params.userId,
      username: params.username,
      role: params.role,
      session_id: params.sessionId,
      ip_address: params.ipAddress,
      user_agent: params.userAgent,
      device: params.device,
      browser: params.browser,
      platform: params.platform,
      action_type: params.actionType,
      module: params.module,
      api_endpoint: params.apiEndpoint,
      http_method: params.httpMethod,
      request_payload: payload,
      response_status: params.responseStatus,
      is_success: params.isSuccess ?? true,
      error_message: params.errorMessage,
      stack_trace: params.stackTrace,
      trade_id: params.tradeId,
      order_id: params.orderId,
      position_id: params.positionId,
      wallet_before: params.walletBefore,
      wallet_after: params.walletAfter,
      margin_before: params.marginBefore,
      margin_after: params.marginAfter,
      metadata: params.metadata,
    });

    if (error) {
      console.error('[Action Logger] Supabase insert error:', error);
    }
  } catch (error) {
    console.error('[Action Logger] Failed to insert log:', error);
  }
}
