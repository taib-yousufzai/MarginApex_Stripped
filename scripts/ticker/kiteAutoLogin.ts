/**
 * KiteAutoLogin — Self-healing Kite session manager.
 *
 * Ports the kite_autologin.py HTTP flow into the ticker process so the
 * Kite session is renewed automatically without any external scheduler.
 *
 * Flow:
 *   POST /api/login       (user_id + password)
 *   POST /api/twofa       (TOTP code)
 *   GET  connect/login    (OAuth redirect — capture request_token)
 *   POST /session/token   (exchange request_token for access_token)
 *   saveKiteSession()     (upsert to Supabase)
 *
 * The KiteSessionMonitor checks every 5 minutes and triggers logi
 * 90 minutes before the token expires, providing a comfortable renewal
 * window with retry headroom before market open.
 */
import { TOTP, Secret } from 'otpauth';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import pino from 'pino';
import { saveKiteSession, kiteTokenExpiresAt, invalidateSharedKiteSessionCache, getSharedKiteSession } from '../../lib/kiteSession.ts';
import type { KiteSessionData } from '../../lib/kiteSession.ts';

const logger = pino({ name: 'kite-autologin' });

const KITE_LOGIN_URL = 'https://kite.zerodha.com/api/login';
const KITE_TWOFA_URL = 'https://kite.zerodha.com/api/twofa';
const KITE_CONNECT_URL = 'https://kite.trade/connect/login';
const KITE_TOKEN_URL = 'https://api.kite.trade/session/token';

/** Check session age on this interval */
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/** Retry failed logins after this delay */
const RETRY_DELAY_MS = 3 * 60 * 1000; // 3 minutes
/** Max consecutive login failures before escalating alert level */
const MAX_CONSECUTIVE_FAILURES = 3;

// ---------------------------------------------------------------------------
// Pure auth flow — no side effects beyond returning a session
// ---------------------------------------------------------------------------

function generateTOTP(secret: string): string {
  const totp = new TOTP({
    secret: Secret.fromBase32(secret.replace(/\s/g, '')),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  return totp.generate();
}

function generateChecksum(apiKey: string, requestToken: string, apiSecret: string): string {
  return crypto.createHash('sha256')
    .update(apiKey + requestToken + apiSecret)
    .digest('hex');
}

/**
 * Performs the complete Kite Connect OAuth login flow via HTTP.
 * Returns a valid KiteSessionData on success, throws on failure.
 *
 * This is a direct port of kite_autologin.py — same endpoints, same logic.
 */
export async function performKiteLogin(): Promise<KiteSessionData> {
  const userId = process.env.ZERODHA_USER_ID;
  const password = process.env.ZERODHA_PASSWORD;
  const totpSecret = process.env.ZERODHA_TOTP_SECRET;
  const apiKey = process.env.KITE_API_KEY || process.env.NEXT_PUBLIC_KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  const supabaseUserId = process.env.ZERODHA_SUPABASE_USER_ID;

  if (!userId || !password || !totpSecret || !apiKey || !apiSecret || !supabaseUserId) {
    throw new Error('Missing required env vars: ZERODHA_USER_ID, ZERODHA_PASSWORD, ZERODHA_TOTP_SECRET, KITE_API_KEY, KITE_API_SECRET, ZERODHA_SUPABASE_USER_ID');
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Kite-Version': '3',
  };

  const cookies = new Map<string, string>();
  const updateCookies = (res: Response) => {
    // Some fetch implementations use getSetCookie() to return an array of strings
    const rawCookies = typeof res.headers.getSetCookie === 'function' 
      ? res.headers.getSetCookie() 
      : ((res.headers.get('set-cookie') || '').split(',').map(c => c.trim()).filter(Boolean));
      
    for (const c of rawCookies) {
      const pair = c.split(';')[0];
      const [key, ...vals] = pair.split('=');
      if (key) cookies.set(key, vals.join('='));
    }
  };

  let dispatcher: any = undefined;
  const proxyUrl = process.env.ZERODHA_PROXY_URL;
  if (proxyUrl) {
    try {
      const dynamicRequire = eval('require');
      const { ProxyAgent } = dynamicRequire('undici');
      dispatcher = new ProxyAgent(proxyUrl);
      logger.info('Kite autologin: Using proxy from ZERODHA_PROXY_URL');
    } catch (e: any) {
      logger.warn(`Failed to initialize ProxyAgent: ${e.message}`);
    }
  }

  // Helper to merge dispatcher into fetch options
  const fetchOpts = (opts: RequestInit): any => dispatcher ? { ...opts, dispatcher } : opts;

  // ── Step 1: Login ──────────────────────────────────────────────────────────
  logger.info('Kite autologin: Step 1 — posting credentials');
  const loginRes = await fetch(KITE_LOGIN_URL, fetchOpts({
    method: 'POST',
    headers,
    body: new URLSearchParams({ user_id: userId, password }).toString(),
  }));
  updateCookies(loginRes);
  const loginData = await loginRes.json() as any;

  if (loginData?.status !== 'success') {
    throw new Error(`Kite login failed: ${JSON.stringify(loginData)}`);
  }
  const requestId: string = loginData.data.request_id;
  logger.info({ requestId }, 'Kite autologin: Step 1 success');

  // ── Step 2: TOTP ───────────────────────────────────────────────────────────
  logger.info('Kite autologin: Step 2 — submitting TOTP');
  const totpCode = generateTOTP(totpSecret);
  const twofaRes = await fetch(KITE_TWOFA_URL, fetchOpts({
    method: 'POST',
    headers: { ...headers, 'Cookie': Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ') },
    body: new URLSearchParams({
      user_id: userId,
      request_id: requestId,
      twofa_value: totpCode,
      skip_session: '',
    }).toString(),
  }));
  updateCookies(twofaRes);
  const twofaData = await twofaRes.json() as any;

  if (twofaData?.status !== 'success') {
    throw new Error(`Kite 2FA failed: ${JSON.stringify(twofaData)}`);
  }
  logger.info('Kite autologin: Step 2 success');

  // ── Step 3: OAuth redirect — capture request_token ─────────────────────────
  logger.info('Kite autologin: Step 3 — following OAuth redirect');
  const connectUrl = `${KITE_CONNECT_URL}?v=3&api_key=${apiKey}&skip_session=true`;
  let requestToken: string | null = null;
  let currentUrl = connectUrl;
  const cookieStr = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

  for (let i = 0; i < 6 && !requestToken; i++) {
    const res = await fetch(currentUrl, fetchOpts({
      method: 'GET',
      headers: { ...headers, 'Cookie': cookieStr },
      redirect: 'manual',
    }));

    const location = res.headers.get('location') || '';
    if (location) {
      currentUrl = location;
      const match = location.match(/request_token=([^&]+)/);
      if (match) requestToken = match[1];
    } else {
      // No redirect — check if we're already at the destination URL
      const match = currentUrl.match(/request_token=([^&]+)/);
      if (match) requestToken = match[1];
      break;
    }
  }

  if (!requestToken) {
    throw new Error(`Failed to capture request_token. Final URL: ${currentUrl}`);
  }
  logger.info('Kite autologin: Step 3 success — captured request_token');

  // ── Step 4: Exchange request_token for access_token ────────────────────────
  logger.info('Kite autologin: Step 4 — exchanging token');
  const checksum = generateChecksum(apiKey, requestToken, apiSecret);
  const tokenRes = await fetch(KITE_TOKEN_URL, fetchOpts({
    method: 'POST',
    headers: { ...headers },
    body: new URLSearchParams({
      api_key: apiKey,
      request_token: requestToken,
      checksum,
    }).toString(),
  }));
  const tokenData = await tokenRes.json() as any;

  if (!tokenRes.ok || !tokenData?.data?.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
  }

  const accessToken: string = tokenData.data.access_token;
  const kiteUserId: string = tokenData.data.user_id;
  const expiresAt = kiteTokenExpiresAt();

  logger.info({ kiteUserId, expiresAt }, 'Kite autologin: Step 4 success');

  // ── Step 5: Persist to Supabase ────────────────────────────────────────────
  logger.info('Kite autologin: Step 5 — saving session to Supabase');
  await saveKiteSession(supabaseUserId, { kiteUserId, accessToken, expiresAt });
  logger.info('Kite autologin: Step 5 complete — session saved');

  return { kiteUserId, accessToken, expiresAt };
}

// ---------------------------------------------------------------------------
// Session Monitor — runs inside the ticker process
// ---------------------------------------------------------------------------

export interface SessionStatus {
  sessionValid: boolean;
  expiresAt: Date | null;
  minutesUntilExpiry: number | null;
  lastSuccessfulLogin: Date | null;
  lastLoginAttempt: Date | null;
  lastLoginFailure: Date | null;
  consecutiveFailures: number;
}

/**
 * KiteSessionMonitor — emits events and monitors session health.
 *
 * Events:
 *   'session-refreshed' (newSession: KiteSessionData) — call reconnect logic
 *   'login-failed'      (err: Error)                  — for alerting
 *   'session-warning'   (minutesLeft: number)          — < 60 min remaining
 *   'session-critical'                                 — expired / login failed 3x
 */
export class KiteSessionMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private isStopping = false;
  private isLoginInProgress = false;

  private status: SessionStatus = {
    sessionValid: false,
    expiresAt: null,
    minutesUntilExpiry: null,
    lastSuccessfulLogin: null,
    lastLoginAttempt: null,
    lastLoginFailure: null,
    consecutiveFailures: 0,
  };

  /** Call this once at startup with the initial session from DB (may be null) */
  public setInitialSession(session: KiteSessionData | null) {
    if (session) {
      this.status.sessionValid = true;
      this.status.expiresAt = session.expiresAt;
      this.status.minutesUntilExpiry = this.computeMinutesLeft(session.expiresAt);
    }
  }

  public start() {
    logger.info('KiteSessionMonitor started — checking every 5 minutes');
    // Run immediately, then on interval
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  public stop() {
    this.isStopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  /**
   * Force an immediate re-login attempt regardless of the stored expiry time.
   * Call this when Kite's WebSocket returns a 403 — the token was invalidated
   * server-side before its scheduled expiry (e.g. Zerodha rotated it, or a
   * second login elsewhere revoked it).
   */
  public forceRefresh() {
    if (this.isLoginInProgress || this.isStopping) return;
    logger.warn('forceRefresh called — marking session as expired and triggering re-login immediately');
    // Zero out the stored expiry so check() sees minutesLeft <= 0
    this.status.expiresAt = new Date(0);
    this.status.sessionValid = false;
    this.check();
  }

  public getStatus(): SessionStatus {
    // Refresh computed minutesUntilExpiry
    if (this.status.expiresAt) {
      this.status.minutesUntilExpiry = this.computeMinutesLeft(this.status.expiresAt);
      this.status.sessionValid = this.status.minutesUntilExpiry > 0;
    }
    return { ...this.status };
  }

  private computeMinutesLeft(expiresAt: Date): number {
    return Math.floor((expiresAt.getTime() - Date.now()) / 60_000);
  }

  private async check() {
    if (this.isStopping || this.isLoginInProgress) return;

    const minutesLeft = this.status.expiresAt
      ? this.computeMinutesLeft(this.status.expiresAt)
      : -1;

    this.status.minutesUntilExpiry = minutesLeft;

    if (minutesLeft <= 0) {
      logger.warn({ minutesLeft }, 'Kite session has expired — triggering daily login');
      // We don't emit session-critical here because expiration at 6AM is expected behavior.
      await this.attemptLogin('expired');
    } else if (minutesLeft <= 60) {
      logger.info({ minutesLeft }, 'Kite session expiring within 60 minutes.');
      this.emit('session-warning', minutesLeft);
    } else {
      logger.debug({ minutesLeft }, 'Kite session healthy');
    }
  }

  private async attemptLogin(reason: 'expired') {
    if (this.isLoginInProgress) return;
    this.isLoginInProgress = true;
    this.status.lastLoginAttempt = new Date();

    logger.info({ reason }, 'Attempting Kite auto-login...');

    try {
      const githubPat = process.env.GITHUB_PAT;
      const githubRepo = process.env.GITHUB_REPO; // format: owner/repo

      let session: KiteSessionData | null = null;

      if (githubPat && githubRepo) {
        try {
          logger.info('Delegating Kite login to GitHub Action (workflow_dispatch)');
          
          const ghRes = await fetch(`https://api.github.com/repos/${githubRepo}/actions/workflows/kite-autologin.yml/dispatches`, {
            method: 'POST',
            headers: {
              'Accept': 'application/vnd.github+json',
              'Authorization': `Bearer ${githubPat}`,
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'Node.js',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ref: 'main' })
          });
          
          if (!ghRes.ok) {
            throw new Error(`Failed to trigger GitHub Action: ${ghRes.status} ${await ghRes.text()}`);
          }
          
          logger.info('GitHub Action triggered successfully. Waiting 90s for session to update in DB...');
          await new Promise(resolve => setTimeout(resolve, 90_000));
          
          invalidateSharedKiteSessionCache();
          session = await getSharedKiteSession();
          
          if (!session || this.computeMinutesLeft(session.expiresAt) <= 0) {
            throw new Error('GitHub Action completed but session in DB was not renewed.');
          }

          logger.info({ expiresAt: session.expiresAt }, '✅ Kite session renewed successfully via GitHub Action');
        } catch (ghErr: any) {
          logger.warn({ err: ghErr.message }, 'GitHub Action login attempt failed — falling back to direct HTTP login');
          session = null;
        }
      }

      if (!session) {
        // Fallback or Primary: Direct HTTP login
        session = await performKiteLogin();
        logger.info({ expiresAt: session.expiresAt }, '✅ Kite session renewed successfully via direct HTTP login');
      }

      // Success state update
      this.status.sessionValid = true;
      this.status.expiresAt = session.expiresAt;
      this.status.minutesUntilExpiry = this.computeMinutesLeft(session.expiresAt);
      this.status.lastSuccessfulLogin = new Date();
      this.status.consecutiveFailures = 0;

      // Bust the in-process session cache so initKite() picks up the new token
      invalidateSharedKiteSessionCache();
      this.emit('session-refreshed', session);
    } catch (err: any) {
      this.status.consecutiveFailures++;
      this.status.lastLoginFailure = new Date();

      logger.error({ err: err.message, consecutiveFailures: this.status.consecutiveFailures }, '❌ Kite auto-login failed');
      this.emit('login-failed', err);

      if (this.status.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.fatal({ consecutiveFailures: this.status.consecutiveFailures },
          'CRITICAL: Kite auto-login failed multiple times. Manual intervention may be required.');
        this.emit('session-critical');
      } else {
        // Schedule a retry sooner than the normal 5-minute check
        logger.info({ retryInMs: RETRY_DELAY_MS }, 'Scheduling retry in 3 minutes...');
        this.retryTimer = setTimeout(() => {
          this.isLoginInProgress = false;
          this.attemptLogin(reason);
        }, RETRY_DELAY_MS);
        // Don't fall through to the finally block's reset
        return;
      }
    } finally {
      this.isLoginInProgress = false;
    }
  }
}
