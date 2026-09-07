/**
 * Repository checks pinning the Stage 2 security boundaries that matter most
 * during rollout: the diagnostics and retry surfaces are admin-only, and
 * nothing in the Minop write path can reach Payroll. Source-string checks in
 * the same style as src/lib/minop/webhook.test.ts's route assertions — no
 * live Supabase project or HTTP server involved.
 *
 * Run:
 *   npx tsx --test src/lib/minop/stage2Security.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(path, 'utf8')

test('the diagnostics list route is admin-gated and never writes', () => {
  const source = read('src/app/api/attendance/minop-deliveries/route.ts')
  assert.match(source, /requireAdmin/)
  assert.match(source, /isResponse/)
  assert.doesNotMatch(source, /\.insert\(/)
  assert.doesNotMatch(source, /\.update\(/)
  assert.doesNotMatch(source, /\.upsert\(/)
  assert.doesNotMatch(source, /\.delete\(/)
})

test('the reprocess route is admin-gated and refuses a quarantined delivery', () => {
  const source = read('src/app/api/attendance/minop-deliveries/[id]/reprocess/route.ts')
  assert.match(source, /requireAdmin/)
  assert.match(source, /isResponse/)
  assert.match(source, /processing_status\s*!==\s*'received'/)
})

test('nothing in the Minop write path ever names a Payroll write table', () => {
  for (const path of [
    'src/app/api/integrations/minop/webhook/route.ts',
    'src/lib/minop/runProcessing.ts',
    'src/lib/minop/processDelivery.ts',
  ]) {
    const source = read(path)
    // payroll_periods is read-only here (the lock check); every OTHER
    // payroll_ table — results, generation, settlements, adjustments — must
    // never appear, in either direction.
    assert.doesNotMatch(source, /payroll_results|payroll_generation|payroll_settlements|payroll_adjustments/, path)
  }
})

test('the webhook route no longer writes attendance_records directly — only through the shared processor', () => {
  const source = read('src/app/api/integrations/minop/webhook/route.ts')
  assert.doesNotMatch(source, /\.from\('attendance_records'\)/)
  assert.match(source, /runMinopAttendanceProcessing/)
})

test('attendance processing runs only behind the rollout flag, and never withholds the Minop acknowledgement', () => {
  const source = read('src/app/api/integrations/minop/webhook/route.ts')
  assert.match(source, /MINOP_ATTENDANCE_PROCESSING_ENABLED/)
  // The success response must be reachable unconditionally after storage,
  // not nested inside the processing branch — a processing failure must
  // never turn into a webhook failure Minop would retry forever.
  const afterProcessingBlock = source.slice(source.indexOf('MINOP_ATTENDANCE_PROCESSING_ENABLED'))
  assert.match(afterProcessingBlock, /NextResponse\.json\(\{ status: '1' \}\)/)
})

test('the write path never grants itself a role/permission it was not given', () => {
  // The processor runs on the service-role client the webhook route already
  // holds — it must not create its own client or read a different secret.
  const source = read('src/lib/minop/runProcessing.ts')
  assert.doesNotMatch(source, /createClient\(/)
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/)
})
