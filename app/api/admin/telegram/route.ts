import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-middleware';
import { getPlatformSetting, setPlatformSetting } from '@/lib/getPlatformSetting';

export interface TelegramBotItem {
  id: string;
  name?: string;
  token: string;
  chatId: string;
  active: boolean;
  notifyOnTrade?: boolean;
  notifyOnLiquidation?: boolean;
}

/**
 * GET /api/admin/telegram
 * Returns configured Telegram notification bots.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, ['VIEW_USERS', 'EDIT_SETTINGS']);
  if (auth instanceof Response) return auth;

  try {
    const raw = await getPlatformSetting('TELEGRAM_BOTS', '[]');
    let bots: TelegramBotItem[] = [];
    try {
      bots = JSON.parse(raw);
    } catch {
      bots = [];
    }
    return NextResponse.json({ bots });
  } catch (err: any) {
    console.error('[GET /api/admin/telegram]', err);
    return NextResponse.json({ error: 'Failed to load Telegram bots' }, { status: 500 });
  }
}

/**
 * POST /api/admin/telegram
 * Saves, updates, or tests Telegram notification bots.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, ['EDIT_SETTINGS']);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json();

    // Action: Test bot message
    if (body.action === 'test') {
      const { token, chatId } = body;
      if (!token || !chatId) {
        return NextResponse.json({ error: 'Token and Chat ID are required for testing' }, { status: 400 });
      }

      const messageText = `🔔 *MarginApex Alert Test*\n\n✅ Telegram notification bot connected successfully.\n⏰ Timestamp: ${new Date().toLocaleString('en-IN')}`;
      const tgUrl = `https://api.telegram.org/bot${token.trim()}/sendMessage`;

      const tgRes = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId.trim(),
          text: messageText,
          parse_mode: 'Markdown',
        }),
        signal: AbortSignal.timeout(6000),
      });

      if (!tgRes.ok) {
        const errJson = await tgRes.json().catch(() => ({ description: 'Telegram API error' }));
        return NextResponse.json({
          error: errJson.description || `Telegram API responded with status ${tgRes.status}`,
        }, { status: 400 });
      }

      return NextResponse.json({ success: true, message: 'Test message sent successfully!' });
    }

    // Action: Save bots list
    if (Array.isArray(body.bots)) {
      const sanitizedBots: TelegramBotItem[] = body.bots.map((b: any, idx: number) => ({
        id: b.id || `bot_${Date.now()}_${idx}`,
        name: b.name || `Bot ${idx + 1}`,
        token: String(b.token || '').trim(),
        chatId: String(b.chatId || '').trim(),
        active: Boolean(b.active ?? true),
        notifyOnTrade: Boolean(b.notifyOnTrade ?? true),
        notifyOnLiquidation: Boolean(b.notifyOnLiquidation ?? true),
      })).filter((b: TelegramBotItem) => Boolean(b.token && b.chatId));

      await setPlatformSetting('TELEGRAM_BOTS', JSON.stringify(sanitizedBots));
      return NextResponse.json({ success: true, bots: sanitizedBots });
    }

    return NextResponse.json({ error: 'Invalid payload. Expected { bots: [...] }' }, { status: 400 });
  } catch (err: any) {
    console.error('[POST /api/admin/telegram]', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
