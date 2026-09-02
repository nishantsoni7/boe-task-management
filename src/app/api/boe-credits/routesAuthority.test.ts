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
    assert.match(c, /getCreditBalance\(caller\.svc, employeeId\)/)
    assert.match(c, /getCreditTransactions\(caller\.svc, employeeId/)
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
    assert.match(c, /caller\.isAdmin\s*\?\s*await fetchCreditSettingsHistory/)
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
