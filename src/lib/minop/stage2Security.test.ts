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
import { existsSync, readdirSync, readFileSync } from 'node:fs'

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

test('there is no retry/reprocess route while Minop is collection-only', () => {
  assert.equal(existsSync('src/app/api/attendance/minop-deliveries/[id]/reprocess/route.ts'), false)
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

test('the webhook route stores the delivery and never runs attendance processing', () => {
  const source = read('src/app/api/integrations/minop/webhook/route.ts')
  assert.doesNotMatch(source, /\.from\('attendance_records'\)/)
  assert.doesNotMatch(source, /runMinopAttendanceProcessing|runProcessing/)
  assert.doesNotMatch(source, /MINOP_ATTENDANCE_PROCESSING_ENABLED/)
  // The acknowledgement is still returned after storage.
  assert.match(source, /NextResponse\.json\(\{ status: '1' \}\)/)
})

test('the path-token route never processes either', () => {
  assert.doesNotMatch(read('src/lib/minop/pathTokenWebhook.ts').replace(/\/\/.*$/gm, ''), /runMinopAttendanceProcessing|attendance_records/)
  assert.doesNotMatch(read('src/app/api/integrations/minop/webhook/[token]/route.ts'), /runMinopAttendanceProcessing|attendance_records/)
})

test('the only code that can write attendance from Minop is guarded, and has no other caller', () => {
  const source = read('src/lib/minop/runProcessing.ts')
  const guard = source.indexOf('assertMinopAttendanceWritesAllowed()')
  const firstRead = source.indexOf('.from(')
  assert.ok(guard > 0 && guard < firstRead, 'the guard runs before the first database call')
  // Nothing under src/ or scripts/ imports it except its own tests.
  const importers = walk('src').concat(walk('scripts')).filter(file =>
    !/\.test\.tsx?$/.test(file) && file !== 'src/lib/minop/runProcessing.ts'
    && /from ['"][^'"]*runProcessing['"]/.test(read(file)))
  assert.deepEqual(importers, [])
})

test('the collection-only switch is a constant, not an environment variable', () => {
  const source = read('src/lib/minop/collectionMode.ts').replace(/\/\/.*$/gm, '')
  assert.match(source, /export const MINOP_COLLECTION_ONLY = true/)
  assert.doesNotMatch(source, /process\.env/)
})

test('no cron, job or script reaches Minop processing', () => {
  assert.doesNotMatch(read('vercel.json'), /minop/i)
})

test('the incoming-data routes are admin-gated and read-only', () => {
  for (const path of [
    'src/app/api/attendance/minop-incoming/route.ts',
    'src/app/api/attendance/minop-incoming/export/route.ts',
    'src/app/api/attendance/minop-incoming/[deliveryId]/route.ts',
  ]) {
    const source = read(path)
    // requireAdmin runs before anything is read.
    const gate = source.indexOf('requireAdmin(req)')
    assert.ok(gate > 0 && gate < source.search(/\.from\(|readAllMinopDeliveries\(/), path)
    assert.match(source, /isResponse\(auth\)/, path)
    assert.doesNotMatch(source, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/, path)
    assert.doesNotMatch(source, /attendance_records|payroll_/, path)
  }
  const query = read('src/lib/minop/incomingQuery.ts')
  assert.doesNotMatch(query, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/)
})

test('the register page offers no employee-linking, approve, process or retry action', () => {
  const source = read('src/app/attendance/minop/incoming/page.tsx')
  const page = source.replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(page, /method:\s*'(POST|PUT|PATCH|DELETE)'/)
  assert.doesNotMatch(page, />\s*(Retry|Approve|Process|Link employee|Map)\b/i)
  assert.match(source,
    /Data received from Minop for verification\. New incoming data is stored only and is not used for attendance\./)
})

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full)
    return /\.(tsx?|mjs|js)$/.test(entry.name) ? [full] : []
  })
}

test('the write path never grants itself a role/permission it was not given', () => {
  // The processor runs on the service-role client the webhook route already
  // holds — it must not create its own client or read a different secret.
  const source = read('src/lib/minop/runProcessing.ts')
  assert.doesNotMatch(source, /createClient\(/)
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/)
})
