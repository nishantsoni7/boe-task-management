import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** The answer that refuses this request, or null when it carries SEO_INGEST_SECRET. Unset secret: the door stays shut. */
export function refuseWithoutSeoSecret(req: Request): NextResponse | null {
  const expected = process.env.SEO_INGEST_SECRET
  if (!expected) {
    console.error('[seo] SEO_INGEST_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'The SEO door is not configured.' }, { status: 503 })
  }
  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
