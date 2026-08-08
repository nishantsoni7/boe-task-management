/**
 * Repository check: Attendance and Payroll management cannot be granted by a
 * Control Center visibility setting.
 *
 * Why a repo check and not only a behavioural one
 * ----------------------------------------------
 * The rule is enforced by ABSENCE — the management routes no longer consult
 * `app_modules` at all, so "Custom cannot widen them" is true by construction
 * rather than by a check that could be reordered or short-circuited. Absence is
 * exactly what a behavioural test is worst at proving: a test that grants Custom
 * and asserts 403 passes just as happily if the route stopped reading the token.
 *
 * It is also the failure mode with the worst blast radius. An earlier build
 * treated `custom` as a grant of management access, and a named member could
 * then read every employee's salary. That interpretation was rejected by the
 * product owner. These assertions are what stop it being reintroduced by a
 * refactor that looks locally reasonable.
 *
 * The behavioural companions live in:
 *   moduleAccess.test.ts                 — the resolver, per persona
 *   attendancePayrollApiIsolation.test.ts — the routes, with real tokens
 *
 * Run:
 *   npx tsx --test src/lib/security/attendancePayrollSelfService.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Every route that reads across employees. None may be module-gated. */
const MANAGEMENT_ROUTES = [
  'src/app/api/attendance/correction-log/route.ts',
  'src/app/api/attendance/dashboard/route.ts',
  'src/app/api/attendance/monthly-summary/route.ts',
  'src/app/api/payroll/monthly-review/route.ts',
  'src/app/api/payroll/monthly-review/detail/route.ts',
  'src/app/api/payroll/periods/route.ts',
  'src/app/api/payroll/results/route.ts',
  'src/app/api/payroll/results/detail/route.ts',
]

/** Routes an employee calls for their own record. */
const SELF_SERVICE_ROUTES = [
  'src/app/api/attendance/employee-monthly-detail/route.ts',
  'src/app/api/attendance/employee-records/route.ts',
  'src/app/api/attendance/records/route.ts',
]

/** Routes that write. These were always admin-only and must stay that way. */
const WRITE_ROUTES = [
  'src/app/api/attendance/import/route.ts',
  'src/app/api/attendance/preview/route.ts',
  'src/app/api/payroll/generate/route.ts',
  'src/app/api/payroll/lock/route.ts',
  'src/app/api/payroll/unlock/route.ts',
  'src/app/api/payroll/adjustments/route.ts',
]

describe('the module-access widening helpers are gone', () => {
  const auth = read('src/lib/security/attendancePayrollApiAuth.ts')

  test('attendancePayrollApiAuth exports no module-gated helper', () => {
    for (const gone of ['requireModuleAccess', 'callerCanAccessModule', 'requireSelfOrModuleAccess']) {
      assert.equal(
        auth.includes(`export async function ${gone}`), false,
        `${gone} is back — a Control Center setting can widen a management route again`,
      )
    }
  })

  test('it does not reach for the module resolver at all', () => {
    assert.equal(
      /from '@\/lib\/moduleAccess'/.test(auth), false,
      'the API auth layer must not consult app_modules; admin is the whole rule',
    )
  })

  test('nothing in the app still imports the removed helpers', () => {
    for (const route of [...MANAGEMENT_ROUTES, ...SELF_SERVICE_ROUTES, ...WRITE_ROUTES]) {
      const src = read(route)
      assert.equal(src.includes('requireModuleAccess'), false, `${route} is module-gated`)
      assert.equal(src.includes('requireSelfOrModuleAccess'), false, `${route} is module-widened`)
    }
  })
})

describe('company-wide reads are admin-only', () => {
  for (const route of MANAGEMENT_ROUTES) {
    test(`${route} requires an admin`, () => {
      const src = read(route)
      assert.ok(src.includes('requireAdmin('), 'must authorise through requireAdmin')
      assert.equal(
        src.includes('app_modules'), false,
        'a management route that reads app_modules can be opened by a visibility setting',
      )
    })
  }
})

describe('self-service reads are pinned to the caller', () => {
  for (const route of SELF_SERVICE_ROUTES) {
    test(`${route} authorises the requested id against the token`, () => {
      const src = read(route)
      assert.ok(src.includes('requireSelfOrAdmin('), 'must authorise through requireSelfOrAdmin')
      assert.equal(src.includes('app_modules'), false, 'self-service must not be module-gated')
    })
  }
})

describe('writes stay admin-only', () => {
  for (const route of WRITE_ROUTES) {
    test(`${route} is admin-only`, () => {
      const src = read(route)
      // Either an inline admin check, or one of the named policy helpers that
      // is itself admin-only (canUnlockPayroll and canCorrectAttendance both
      // refuse any role but admin, and have their own tests saying so).
      const adminGated =
        src.includes('requireAdmin(') ||
        /ALLOWED_ROLES\s*=\s*\['admin'\]/.test(src) ||
        /role\s*!==\s*'admin'/.test(src) ||
        src.includes('canCorrectAttendance') ||
        src.includes('canUnlockPayroll')
      assert.ok(adminGated, 'a write route must state an admin check')
      assert.equal(src.includes('requireModuleAccess'), false)
    })
  }
})

describe('the employee self-service surfaces exist and stay ungated', () => {
  test('/my-payroll and /my-attendance are both present', () => {
    assert.ok(existsSync(join(ROOT, 'src/app/my-payroll/page.tsx')))
    assert.ok(existsSync(join(ROOT, 'src/app/my-attendance/page.tsx')))
  })

  test('neither consults app_modules — an employee always reaches their own record', () => {
    for (const page of ['src/app/my-payroll/page.tsx', 'src/app/my-attendance/page.tsx']) {
      assert.equal(read(page).includes('app_modules'), false, `${page} must not be module-gated`)
    }
  })

  test('/my-attendance asks only for the session user id', () => {
    const src = read('src/app/my-attendance/page.tsx')
    assert.ok(
      src.includes('employee_id: session.user.id'),
      'the page must send its own id, never one from the URL',
    )
  })

  // The employee's payslip and the admin's review of it are the same document.
  // They render from one module so they cannot drift apart again — the earlier
  // split is what let the employee view fall behind the approved design.
  test('both payroll detail readers render the one shared workspace', () => {
    for (const page of [
      'src/app/payroll/results/[periodId]/[employeeId]/page.tsx',
      'src/app/my-payroll/[periodId]/page.tsx',
    ]) {
      assert.ok(
        read(page).includes('<PayrollDetailWorkspace'), `${page} must render the shared workspace`,
      )
    }
  })

  test('the employee view passes no edit callback at all', () => {
    const src = read('src/app/my-payroll/[periodId]/page.tsx')
    assert.ok(src.includes('canEdit={false}'), 'the employee view must declare canEdit false')
    assert.equal(
      /onEdit=/.test(src), false,
      'an onEdit callback would put a correction control on the employee page',
    )
    assert.equal(
      src.includes('AttendanceCorrectionModal'), false,
      'the correction modal is an admin surface',
    )
  })

  test('the employee detail is served by the own-scoped endpoint', () => {
    const src = read('src/app/my-payroll/[periodId]/page.tsx')
    assert.ok(src.includes('/api/payroll/my-result'), 'must read from the self-scoped route')
    assert.equal(
      src.includes('/api/payroll/results/detail'), false,
      'the admin detail endpoint must not be reachable from the employee page',
    )
  })

  test('my-result takes no employee id — there is nothing to tamper with', () => {
    const src = read('src/app/api/payroll/my-result/route.ts')
    assert.ok(src.includes('employeeId:  caller.id') || src.includes('employeeId: caller.id'))
    assert.equal(
      /searchParams\.get\('employee_id'\)/.test(src), false,
      'accepting an employee_id here would reopen the cross-employee read',
    )
    assert.ok(src.includes('canEdit:     false') || src.includes('canEdit: false'))
  })

  test('the shared payload builder does not authorise — its callers do', () => {
    const admin = read('src/app/api/payroll/results/detail/route.ts')
    assert.ok(admin.includes('requireAdmin('), 'the admin detail route stays admin-only')
  })

  test('the management guards use resolveManagementAccess, not the card resolver', () => {
    for (const guard of ['src/app/attendance/layout.tsx', 'src/app/payroll/layout.tsx']) {
      const src = read(guard)
      assert.ok(src.includes('resolveManagementAccess('), `${guard} must gate on management access`)
      assert.equal(
        /resolveModuleAccess\(/.test(src), false,
        `${guard} gates on card visibility, which Custom can grant`,
      )
    }
  })
})
