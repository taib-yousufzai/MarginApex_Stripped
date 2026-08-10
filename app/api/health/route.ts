export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

/**
 * GET /api/health
 * Railway healthcheck endpoint for the Next.js service.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok', uptime: process.uptime() });
}
