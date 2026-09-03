/**
 * /api/boe-credits — who may call what, pinned to the source.
 *
 * These routes run on the SERVICE ROLE, which bypasses RLS, so the route IS
 * the boundary. This file asserts the shape of that boundary the way
 * salaryReportAuth.test.ts does for payroll: the exact helper each verb calls,
 * that the employee id a query is pinned to comes from the helper and never
 * from the request, that the actor on an adjustment comes from the token, and
 * that nothing anywhere in src/ writes to the ledger except through the one
 * posting RPC in the service.
 *
 * Comments are stripped before any "must not appear" assertion, because the
 * routes' comments necessarily name the very things they explain excluding.
 *
 * Run:
 *   npx tsx --test src/app/api/boe-credits/routesAuthority.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const code = (src: string) =>
  src.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')

const LEDGER      = read('src/app/api/boe-credits/ledger/route.ts')
const BALANCES    = read('src/app/api/boe-credits/balances/route.ts')
const ADJUSTMENTS = read('src/app/api/boe-credits/adjustments/route.ts')
const SETTINGS    = read('src/app/api/boe-credits/settings/route.ts')
const SERVICE     = read('src/lib/boeCredits/service.ts')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) yield full
  }
}

describe('the ledger read is self-or-admin', () => {
  test('it resolves the caller through requireSelfOrAdmin and returns its refusal untouched', () => {
    assert.match(LEDGER, /const auth = await requireSelfOrAdmin\(req, requested\)/)
    assert.match(LEDGER, /if \(isResponse\(auth\)\) return auth/)
  })

  test('both reads are pinned to the id the helper returned, never the query string', () => {
    const c = code(LEDGER)
    assert.match(c, /const svc = caller\.svc/)
    assert.match(c, /getCreditBalance\(svc, employeeId\)/)
    assert.match(c, /getCreditTransactions\(svc, employeeId/)
    assert.match(c, /getCreditReviewMonths\(svc, employeeId/)
    // `requested` is handed to the helper and to nothing else.
    const uses = c.match(/\brequested\b/g) ?? []
    assert.equal(uses.length, 2, 'declared once, passed to requireSelfOrAdmin once')
  })

  test('it only exports GET', () => {
    assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(LEDGER), false)
  })
})

describe('the company-wide read is admin only', () => {
  test('requireAdmin, and the refusal is returned as-is', () => {
    assert.match(BALANCES, /const auth = await requireAdmin\(req\)/)
    assert.match(BALANCES, /if \(isResponse\(auth\)\) return auth/)
    assert.equal(/requireSelfOrAdmin|resolveModuleAccess|app_modules/.test(code(BALANCES)), false,
      'no module-visibility widening — Payroll management is admins only')
  })
})

describe('the adjustment is admin only, and the actor is the token', () => {
  test('requireAdmin first', () => {
    assert.match(ADJUSTMENTS, /const auth = await requireAdmin\(req\)/)
    assert.match(ADJUSTMENTS, /if \(isResponse\(auth\)\) return auth/)
    const gate  = ADJUSTMENTS.indexOf('if (isResponse(auth)) return auth')
    const parse = ADJUSTMENTS.indexOf('await req.json()')
    assert.ok(gate < parse, 'the body is not even parsed for an unauthorised caller')
  })

  test('the actor is auth.id; nothing in the body can name one', () => {
    const c = code(ADJUSTMENTS)
    assert.match(c, /actorId: auth\.id/)
    assert.equal(/payload\.(actor|actor_id|created_by)/.test(c), false)
  })

  test('amount and reason are validated with the shared rules before any write', () => {
    const c = code(ADJUSTMENTS)
    assert.match(c, /creditAmountIssue\(credits\)/)
    assert.match(c, /creditReasonIssue\(payload\.reason\)/)
    const validate = c.indexOf('creditReasonIssue(')
    const write    = c.indexOf('postAdminAdjustment(')
    assert.ok(validate < write)
  })

  test('it writes through postAdminAdjustment and nothing else — no direct insert, no other verb', () => {
    const c = code(ADJUSTMENTS)
    assert.equal(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/.test(c), false)
    assert.equal(/export async function (GET|PUT|PATCH|DELETE)/.test(ADJUSTMENTS), false)
  })
})

describe('settings: any employee may read, only an admin may write', () => {
  test('GET resolves the caller and refuses the anonymous', () => {
    const c = code(SETTINGS)
    assert.match(c, /const caller = await resolveCaller\(req\)/)
    assert.match(c, /if \(!caller\) return UNAUTHORIZED\(\)/)
  })

  test('history is for admins; the two numbers are for everyone', () => {
    const c = code(SETTINGS)
    assert.match(c, /caller\.isAdmin\s*\n\s*\?\s*fetchCreditSettingsHistory/)
  })

  test('PUT is requireAdmin, validated with parseBoeCreditSettings, and saved with the token id', () => {
    const c = code(SETTINGS)
    const put = c.slice(c.indexOf('export async function PUT'))
    assert.match(put, /const auth = await requireAdmin\(req\)/)
    assert.match(put, /parseBoeCreditSettings\(payload\.settings\)/)
    assert.match(put, /saveCreditSettings\(svc, parsed\.settings, auth\.id, note\)/)
    assert.equal(/\.update\(|\.delete\(/.test(put), false, 'append-only: an INSERT, never an UPDATE')
  })
})

describe('the ledger has one write path in the whole of src/', () => {
  test('post_boe_credit_transaction and reverse_boe_credit_transaction are called from the service only', () => {
    const offenders: string[] = []
    for (const file of walk(join(ROOT, 'src'))) {
      if (file.endsWith('.test.ts')) continue
      const c = code(read(file.slice(ROOT.length + 1).replace(/\\/g, '/')))
      if (/rpc\('(post|reverse)_boe_credit_transaction'/.test(c) && !file.endsWith(join('boeCredits', 'service.ts'))) {
        offenders.push(file)
      }
    }
    assert.deepEqual(offenders, [])
    assert.match(code(SERVICE), /rpc\('post_boe_credit_transaction'/)
    assert.match(code(SERVICE), /rpc\('reverse_boe_credit_transaction'/)
  })

  test('nothing in src/ inserts into, updates or deletes from boe_credit_transactions', () => {
    const offenders: string[] = []
    for (const file of walk(join(ROOT, 'src'))) {
      if (file.endsWith('.test.ts')) continue
      const c = code(read(file.slice(ROOT.length + 1).replace(/\\/g, '/')))
      const idx = c.indexOf("from('boe_credit_transactions')")
      if (idx === -1) continue
      const after = c.slice(idx, idx + 400)
      if (/\.(insert|update|delete|upsert)\(/.test(after)) offenders.push(file)
    }
    assert.deepEqual(offenders, [])
  })

  test('the service is server-only: no client component imports it', () => {
    const offenders: string[] = []
    for (const file of walk(join(ROOT, 'src'))) {
      const src = read(file.slice(ROOT.length + 1).replace(/\\/g, '/'))
      if (!/^'use client'/m.test(src)) continue
      if (/boeCredits\/service'/.test(src)) offenders.push(file)
    }
    assert.deepEqual(offenders, [])
  })
})

describe('the employee surface', () => {
  test('the credits card fetches the ledger with no employee id — the route pins it to the token', () => {
    const card = code(read('src/components/boeCredits/CreditsSummaryCard.tsx'))
    assert.match(card, /fetch\('\/api\/boe-credits\/ledger\?limit=\d+'/)
    assert.equal(/employee_id=/.test(card), false, 'no employee id is ever put on the request')
    assert.equal(/props\.employeeId|employeeId:/.test(card), false, 'and the card takes none as a prop')
  })

  test('the employee sees credits, never rupees', () => {
    for (const p of ['src/components/boeCredits/CreditsSummaryCard.tsx', 'src/components/boeCredits/CreditHistoryModal.tsx']) {
      const c = code(read(p))
      assert.equal(/formatRupees|₹|credit_value/.test(c), false, p)
    }
  })

  test('/my-payroll mounts the card, and the management page lives under the admin-only /payroll tree', () => {
    assert.match(read('src/app/my-payroll/page.tsx'), /<CreditsSummaryCard token=\{token\} \/>/)
    assert.match(read('src/components/layout/attendancePayrollNav.tsx'), /path: '\/payroll\/credits'/)
    const nav = read('src/components/layout/attendancePayrollNav.tsx')
    const adminStart = nav.indexOf('ATTENDANCE_PAYROLL_ADMIN_NAV')
    const employeeStart = nav.indexOf('ATTENDANCE_PAYROLL_EMPLOYEE_NAV')
    const entry = nav.indexOf("path: '/payroll/credits'")
    assert.ok(adminStart < entry && entry < employeeStart, 'the entry is in the ADMIN nav, not the employee one')
  })
})

// ─── Attendance redemption (Phase 1C) ────────────────────────────────────────

describe('the redemption is the caller\'s own, decided by the engine, written through the service', () => {
  const REDEMPTIONS = read('src/app/api/boe-credits/redemptions/route.ts')
  const c = code(REDEMPTIONS)

  test('the caller is resolved from the token first; the body is not parsed for the anonymous', () => {
    assert.match(c, /const caller = await resolveCaller\(req\)/)
    assert.match(c, /if \(!caller\) return UNAUTHORIZED\(\)/)
    assert.ok(c.indexOf('return UNAUTHORIZED()') < c.indexOf('await req.json()'))
  })

  test('the employee is caller.id; nothing in the body can name one, a cost, a kind or a balance', () => {
    assert.match(c, /const employeeId = caller\.id/)
    assert.equal(/payload\.(employee_id|employeeId|credits|deduction_type|amount|available)/.test(c), false)
    assert.match(c, /employeeId,\s*\n\s*payrollPeriodId: periodId,\s*\n\s*attendanceDate:\s+date,\s*\n\s*deductionType:\s+eligibility\.deduction_type,\s*\n\s*actorId:\s+caller\.id/)
  })

  test('eligibility comes from the engine, before the write, with the period\'s pinned settings', () => {
    assert.match(c, /generatePayrollForEmployee\(/)
    assert.match(c, /settingsForPeriod\(/)
    assert.match(c, /fetchActiveAttendanceRedemptions\(svc, employeeId/)
    const eligibility = c.indexOf('attendanceRedemptionEligibility(')
    const write       = c.indexOf('redeemAttendanceDay(')
    assert.ok(eligibility > 0 && eligibility < write)
    assert.match(c, /if \(!eligibility\.eligible\) \{/)
  })

  test('it writes through redeemAttendanceDay and nothing else — no direct insert, no rpc, one verb', () => {
    assert.equal(/\.insert\(|\.rpc\(|\.delete\(/.test(c), false)
    assert.equal(/export async function (GET|PUT|PATCH|DELETE)/.test(REDEMPTIONS), false)
    // The one update-shaped write is the ordinary regeneration path, through the store.
    assert.match(c, /createGenerationRow\(svc, periodId, caller\.id\)/)
    assert.match(c, /writeEngineResult\(svc, generationId, after\)/)
    assert.match(c, /markAdjustmentsApplied\(svc, after\.applied_adjustment_ids, resultId, periodId\)/)
  })

  test('a locked month is refused before any input is read', () => {
    const lock = c.indexOf("period.status === 'locked'")
    const inputs = c.indexOf('fetchAttendanceForPeriod(')
    assert.ok(lock > 0 && lock < inputs)
  })

  test('the two redemption RPCs are called from the service only, and nothing in src/ writes the redemption table', () => {
    const offenders: string[] = []
    for (const file of walk(join(ROOT, 'src'))) {
      if (file.endsWith('.test.ts')) continue
      const src = code(read(file.slice(ROOT.length + 1).replace(/\\/g, '/')))
      if (/rpc\('(redeem_boe_credits_for_attendance|reverse_boe_credit_attendance_redemption)'/.test(src)
          && !file.endsWith(join('boeCredits', 'service.ts'))) offenders.push(file)
      const idx = src.indexOf("from('boe_credit_attendance_redemptions')")
      if (idx !== -1 && /\.(insert|update|delete|upsert)\(/.test(src.slice(idx, idx + 400))) offenders.push(file)
    }
    assert.deepEqual(offenders, [])
    assert.match(code(SERVICE), /rpc\('redeem_boe_credits_for_attendance'/)
    assert.match(code(SERVICE), /rpc\('reverse_boe_credit_attendance_redemption'/)
    assert.match(code(SERVICE), /p_actor_id:\s+input\.actorId/, 'the actor is whoever the caller resolved from the token')
  })

  test('the lifecycle: every write-intent engine run reconciles the coverage first, through the shared module', () => {
    const correction = code(read('src/app/api/payroll/attendance-correction/route.ts'))
    const generate   = code(read('src/app/api/payroll/generate/route.ts'))
    for (const [name, src] of [['attendance-correction', correction], ['generate', generate]] as const) {
      assert.match(src, /reconcileAttendanceCoverage\(svc, \{/, `${name} reconciles`)
      assert.match(src, /actorId:\s+caller\.id/, `${name}: the admin from the token is the actor on every reversal`)
      assert.ok(src.indexOf('reconcileAttendanceCoverage(') < src.indexOf('writeEngineResult('), `${name}: reconciled BEFORE the result is written`)
    }
    // The read-only previews and the day view never reconcile: nothing there
    // may write, and the engine already ignores coverage it cannot apply.
    for (const p of [
      'src/app/api/payroll/monthly-review/route.ts',
      'src/app/api/payroll/monthly-review/detail/route.ts',
      'src/lib/payroll/resultDetailPayload.ts',
    ]) {
      assert.equal(/reconcileAttendanceCoverage|reverseAttendanceRedemption/.test(code(read(p))), false, p)
    }
    const coverage = code(read('src/lib/payroll/creditCoverage.ts'))
    assert.match(coverage, /await reverseAttendanceRedemption\(svc, \{ redemptionId: a\.redemption\.id, actorId, reason: a\.reason \}\)/)
    assert.match(coverage, /if \(a\.action === 'reprice'\) \{\s*\n\s*await redeemAttendanceDay\(/, 'a re-price is reverse THEN redeem')
    assert.equal(/postAdminAdjustment|admin_adjustment/.test(coverage), false, 'no hidden balance adjustment — only reversals and redemptions')
  })

  test('the employee page posts the period and the date only, and takes the offer from the payload', () => {
    const page = code(read('src/app/my-payroll/[periodId]/page.tsx'))
    assert.match(page, /fetch\('\/api\/boe-credits\/redemptions'/)
    assert.match(page, /JSON\.stringify\(\{ payroll_period_id: periodId, attendance_date: redeemOffer\.date \}\)/)
    assert.equal(/employee_id|credits:|deduction_type:/.test(page.slice(page.indexOf("fetch('/api/boe-credits/redemptions'"), page.indexOf("fetch('/api/boe-credits/redemptions'") + 400)), false)
    assert.match(page, /onRedeem=\{setRedeemingDate\}/)
    assert.match(page, /data\?\.can_redeem/)
  })

  test('the admin reader gets no redeem action and no redeemable list', () => {
    const detail = code(read('src/app/api/payroll/results/detail/route.ts'))
    assert.equal(/canRedeem:\s*true/.test(detail), false)
    const myResult = code(read('src/app/api/payroll/my-result/route.ts'))
    assert.match(myResult, /canRedeem:\s+true/)
    assert.match(myResult, /employeeId:\s+caller\.id/)
    const admin = code(read('src/app/payroll/results/[periodId]/[employeeId]/page.tsx'))
    assert.equal(/onRedeem=/.test(admin), false)
  })
})
