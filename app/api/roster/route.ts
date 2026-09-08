import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { getRoster } from '../../../lib/booking';

/**
 * Roster API for an admin or teacher.
 * GET /api/roster           -> every trial class
 * GET /api/roster?classId=2 -> one class
 *
 * Returns CONFIRMED students only.
 */
export function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('classId');
  const classId = raw ? Number(raw) : undefined;

  if (raw && !Number.isInteger(classId)) {
    return NextResponse.json({ error: 'classId must be an integer' }, { status: 400 });
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    classes: getRoster(getDb(), classId),
  });
}
