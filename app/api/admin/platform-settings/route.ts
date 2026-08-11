import { requireAuth } from '@/lib/api-middleware';
import { getPlatformSetting, setPlatformSetting } from '@/lib/getPlatformSetting';

const ALLOWED_SETTINGS = ['EXIT_PRICE_MODE'] as const;
type AllowedSetting = typeof ALLOWED_SETTINGS[number];

const DEFAULTS: Record<AllowedSetting, string> = {
  EXIT_PRICE_MODE: 'BID_ASK',
};

const VALID_VALUES: Record<AllowedSetting, string[]> = {
  EXIT_PRICE_MODE: ['BID_ASK', 'LTP'],
};

/** GET /api/admin/platform-settings — returns all platform settings */
export async function GET(request: Request) {
  const auth = await requireAuth(request, ['VIEW_USERS']);
  if (auth instanceof Response) return auth;

  const settings: Record<string, string> = {};
  for (const key of ALLOWED_SETTINGS) {
    settings[key] = await getPlatformSetting(key, DEFAULTS[key]);
  }

  return Response.json({ settings });
}

/** PUT /api/admin/platform-settings — updates one or more platform settings */
export async function PUT(request: Request) {
  const auth = await requireAuth(request, ['VIEW_USERS']);
  if (auth instanceof Response) return auth;

  let body: Record<string, string>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const updated: string[] = [];
  const errors: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_SETTINGS.includes(key as AllowedSetting)) {
      errors.push(`Unknown setting: ${key}`);
      continue;
    }
    const valid = VALID_VALUES[key as AllowedSetting];
    if (!valid.includes(value)) {
      errors.push(`${key} must be one of: ${valid.join(', ')}`);
      continue;
    }
    await setPlatformSetting(key, value);
    updated.push(key);
  }

  if (errors.length > 0 && updated.length === 0) {
    return Response.json({ error: errors.join('; ') }, { status: 400 });
  }

  return Response.json({ updated, errors });
}

