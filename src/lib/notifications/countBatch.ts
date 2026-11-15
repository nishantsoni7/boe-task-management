// THE LAUNCHER'S BADGE COUNTS IN ONE CALL (2026-11-14, page speed part 7).
//
// A cold Modules page asked for its unread badges one route at a time: Task, Finance and Orders from
// /api/notifications?count=1&category=..., Sample Tracking from /api/samples/notifications?count=1.
// Four server functions, each from India to Tokyo and each checking the caller, to fetch four small numbers.
// This asks the SAME two routes for them, inside ONE function call, and hands each answer back with the
// status and body its own request would have had.
//
// IT DECIDES NOTHING. Each part is the unchanged GET handler of the route it stands in for, run with the
// caller's own cookies and the same query string it would have had (count=1, the category, and the
// subjectUserId while an administrator previews somebody), so who may read which count, the view-as rule
// and the hidden-rows rule are exactly as before. A part that throws becomes a 500 for that part alone.
// The two routes stay and the browser falls back to them if this one fails.

import { resolveNotificationCategory } from '@/lib/notifications'

/** The part that stands for Sample Tracking's own route; every other part is a notification category. */
export const SAMPLE_PART = 'sample'

export type CountAnswer = { status: number; body: Record<string, unknown> }

/** The parts named in `?parts=a,b`, once each, in the order given; anything unknown is ignored. */
export function parseCountParts(raw: string | null): string[] {
  const seen = new Set<string>()
  for (const part of (raw ?? '').split(',').map(p => p.trim())) {
    if (part === SAMPLE_PART || (part !== '' && resolveNotificationCategory(part).ok)) seen.add(part)
  }
  return [...seen]
}

/** The query string a part's own request carries: exactly what the caller used to send. */
export function countRequestPath(part: string, subjectUserId: string | null): string {
  if (part === SAMPLE_PART) return '/api/samples/notifications?count=1'
  return `/api/notifications?count=1&category=${part}`
    + (subjectUserId ? `&subjectUserId=${encodeURIComponent(subjectUserId)}` : '')
}

export async function loadCounts(
  parts: readonly string[],
  subjectUserId: string | null,
  call: (part: string, path: string) => Promise<Response>,
): Promise<{ status: number; body: { parts: Record<string, CountAnswer> } }> {
  const answers = await Promise.all(parts.map(async (part): Promise<[string, CountAnswer]> => {
    try {
      const res = await call(part, countRequestPath(part, subjectUserId))
      const body = await res.json().catch(() => null)
      return [part, { status: res.status, body: body && typeof body === 'object' ? body as Record<string, unknown> : {} }]
    } catch (error) {
      console.error(`[notifications/counts/${part}]`, error instanceof Error ? error.message : 'unknown error')
      return [part, { status: 500, body: { error: 'Something went wrong. Try again.' } }]
    }
  }))
  return { status: 200, body: { parts: Object.fromEntries(answers) } }
}
