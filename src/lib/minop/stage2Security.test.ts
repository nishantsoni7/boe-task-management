/**
 * Repository checks pinning the boundaries of machine attendance: the diagnostics
 * surfaces are admin-only, exactly one file can write attendance from the machine,
 * and nothing in that path reaches a payroll result. Source-string checks in the
 * same style as src/lib/minop/webhook.test.ts's route assertions — no live Supabase
 * project or HTTP server involved.
 *
 * Run:
 *   npm run test:file -- src/lib/minop/stage2Security.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(path, 'utf8')

const WRITER = 'src/lib/minop/machineAttendance.ts'

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full)
    return /\.(tsx?|mjs|js)$/.test(entry.name) ? [full] : []
  })
}

test('the diagnostics list route is admin-gated and never writes', () => {
  const source = read('src/app/api/attendance/minop-deliveries/route.ts')
  assert.match(source, /requireAdmin/)
  assert.match(source, /isResponse/)
  assert.doesNotMatch(source, /\.insert\(/)
  assert.doesNotMatch(source, /\.update\(/)
  assert.doesNotMatch(source, /\.upsert\(/)
  assert.doesNotMatch(source, /\.delete\(/)
})

test('there is no retry/reprocess route', () => {
  assert.equal(existsSync('src/app/api/attendance/minop-deliveries/[id]/reprocess/route.ts'), false)
})

test('nothing in the machine write path ever names a Payroll write table', () => {
  for (const path of [
    'src/app/api/integrations/minop/webhook/route.ts',
    'src/app/api/integrations/minop/webhook/[token]/route.ts',
    'src/app/api/attendance/minop-sync/route.ts',
    WRITER,
  ]) {
    const source = read(path)
    // payroll_periods is read-only here (the lock check); every OTHER
    // payroll_ table — results, generation, settlements, adjustments — must
    // never appear, in either direction.
    assert.doesNotMatch(source, /payroll_results|payroll_generation|payroll_settlements|payroll_adjustments/, path)
  }
})

test('exactly one file can write attendance from the machine', () => {
  const writers = walk('src/lib/minop').concat(walk('src/app/api/integrations'), walk('src/app/api/attendance'))
    .filter(file => !/\.test\.tsx?$/.test(file) && file !== 'src/app/api/attendance/import/route.ts')
    .filter(file => /\.from\('attendance_records'\)\s*\.(upsert|insert|update|delete)\(/.test(read(file)))
  assert.deepEqual(writers, [WRITER])
})

test('the header-authenticated route stores the delivery and writes no attendance', () => {
  const source = read('src/app/api/integrations/minop/webhook/route.ts')
  assert.doesNotMatch(source, /\.from\('attendance_records'\)|machineAttendance|rebuildMachineDays/)
  assert.doesNotMatch(source, /MINOP_ATTENDANCE_PROCESSING_ENABLED/)
  // The acknowledgement is still returned after storage.
  assert.match(source, /NextResponse\.json\(\{ status: '1' \}\)/)
})

test('the path-token handler has no direct way to attendance: it only calls what it is handed', () => {
  assert.doesNotMatch(read('src/lib/minop/pathTokenWebhook.ts').replace(/\/\/.*$/gm, ''), /attendance_records|machineAttendance/)
})

test('the old processor and its switch are gone, so there is one path, not two', () => {
  for (const file of ['collectionMode', 'runProcessing', 'processDelivery', 'punchEvent', 'employeeMapping', 'attendanceMerge']) {
    assert.equal(existsSync(`src/lib/minop/${file}.ts`), false, file)
  }
})

test('the nightly sync is scheduled and answers only to the cron secret', () => {
  assert.match(read('vercel.json'), /"path": "\/api\/attendance\/minop-sync"/)
  const source = read('src/app/api/attendance/minop-sync/route.ts')
  assert.match(source, /process\.env\.CRON_SECRET/)
  assert.match(source, /timingSafeEqual/)
  const gate = source.indexOf('secretMatches(provided, expected)')
  assert.ok(gate > 0 && gate < source.indexOf('syncMachineAttendance(svc'), 'the secret is checked before any work')
  assert.match(source, /status: 503/)
})

test('the Today tab reads as an admin and writes nothing', () => {
  for (const path of ['src/app/api/attendance/machine-day/route.ts', 'src/app/api/attendance/machine-status/route.ts']) {
    const source = read(path)
    const gate = source.indexOf('requireAdmin(req)')
    assert.ok(gate > 0 && gate < source.indexOf('await readMachine'), `${path} checks the caller first`)
    assert.match(source, /isResponse\(auth\)/, path)
  }
  for (const path of ['src/app/api/attendance/machine-day/route.ts', 'src/app/api/attendance/machine-status/route.ts', 'src/lib/minop/machineDayView.ts']) {
    assert.doesNotMatch(read(path), /\.(insert|update|upsert|delete)\(/, path)
  }
})

test('the stopped-machine check is scheduled, answers only to the cron secret and writes only notifications', () => {
  assert.match(read('vercel.json'), /"path": "\/api\/attendance\/machine-alert"/)
  const source = read('src/app/api/attendance/machine-alert/route.ts')
  assert.match(source, /process\.env\.CRON_SECRET/)
  assert.match(source, /timingSafeEqual/)
  const gate = source.indexOf('secretMatches(provided, expected)')
  assert.ok(gate > 0 && gate < source.indexOf('readMachineHealth(svc'), 'the secret is checked before any work')
  assert.match(source, /status: 503/)

  const writes = [...read('src/lib/minop/machineHealth.ts').matchAll(/\.from\('(\w+)'\)\s*\.(?:insert|update|upsert|delete)\(/g)]
  assert.deepEqual(writes.map(m => m[1]), ['notifications'])
})

test('the notification type is added by its own migration, before the feed filters on it', () => {
  assert.match(
    read('supabase/migrations/20270511000000_attendance_machine_stopped_notification_type.sql'),
    /^ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'attendance_machine_stopped';\r?$/m,
  )
  assert.match(read('src/lib/notifications.ts'), /'attendance_machine_stopped',/)
})

test('an Excel upload cannot overwrite a month the machine supplies', () => {
  for (const path of ['src/app/api/attendance/import/route.ts', 'src/app/api/attendance/preview/route.ts']) {
    const source = read(path)
    const refusal = source.indexOf('isMachineMonth(blocks[0].year, blocks[0].month)')
    assert.ok(refusal > 0, path)
    assert.ok(refusal < source.indexOf('resolveEmployeeMapping({'), `${path} refuses before anything else happens`)
  }
})

test('the two month views cap a machine month at yesterday', () => {
  for (const path of ['src/app/api/attendance/employee-monthly-detail/route.ts', 'src/app/api/attendance/monthly-summary/route.ts']) {
    const source = read(path)
    assert.match(source, /machineLatestDate\(/, path)
    assert.doesNotMatch(source, /\.is\('source', null\)/, path)
  }
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
  assert.match(source, /Punches from 1 November 2026 become attendance for linked employees\./)
})
