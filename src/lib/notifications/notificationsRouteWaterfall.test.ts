/**
 * /api/notifications no longer queues the ordinary read behind the View As
 * subject check — without weakening the check.
 *
 * MEASURED (production, September 2026). Responses carry
 * `x-vercel-id: bom1::iad1`; each server-side database round trip from the
 * function costs ~0.45 s. The list made five in sequence (median 2.5–3.0 s) and
 * the unread count three (median 1.6 s). The subject check was one of them on
 * every request, although for an ordinary read its answer can only be the
 * caller.
 *
 * WHAT MUST STILL HOLD, pinned here at the source level:
 *   · the decision is awaited before enrichment and before any response;
 *   · a preview (another employee named) waits for the decision before reading;
 *   · the rows read speculatively are scoped to the caller alone.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/notificationsRouteWaterfall.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'src/app/api/notifications/route.ts'), 'utf8').replace(/\r\n/g, '\n')
const GET = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function DELETE'))

test('the subject check starts once and runs beside the count and the list', () => {
  assert.equal(GET.match(/resolveViewAsSubject\(/g)?.length, 1)
  assert.match(GET, /await Promise\.all\(\[refusal\(\), countQuery\]\)/)
  assert.match(GET, /await Promise\.all\(\[refusal\(\), listQuery/)
})

test('without a named employee the read is scoped to the caller', () => {
  assert.match(GET, /let subjectId = user\.id\n/)
  assert.match(GET, /\.eq\('user_id', subjectId\)/)
})

test('a preview waits for the decision before anything is read', () => {
  const preview = GET.indexOf('if (requestedSubjectId && requestedSubjectId !== user.id) {')
  assert.ok(preview > 0)
  assert.ok(GET.indexOf('const decision = await subjectCheck', preview) > preview)
  assert.ok(preview < GET.indexOf('let countQuery'))
})

test('a refusal wins before enrichment and before either response', () => {
  const countRefusal = GET.indexOf('if (refused) return refused')
  assert.ok(countRefusal > 0 && countRefusal < GET.indexOf('unreadCount: count ?? 0'))
  const listRefusal = GET.indexOf('if (refused) return refused', GET.indexOf('let listQuery'))
  assert.ok(listRefusal > 0 && listRefusal < GET.indexOf('enrichNotificationPage(supabase'))
  // The decision must name the subject the query was scoped to.
  assert.match(GET, /if \(decision\.subjectId !== subjectId\) \{/)
})
