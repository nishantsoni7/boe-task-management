/**
 * NO ADMIN OF THE PI → ORDER → FINANCE FLOW WAITS FOR THE OTHER, AND EVERY
 * AUTHORITY IS A CONTROL CENTER PERMISSION (20270120000000).
 *
 * What this pins, reading the migrations as text (no database, nothing written):
 *
 *   RESTATED, NOT REWRITTEN  every function the migration re-emits has exactly
 *                            the body of its latest earlier definition, with
 *                            only the named users.role tests swapped for a
 *                            permission — so no data check, the 40% rule,
 *                            exception reasons or the Operations handoff can
 *                            have moved with them.
 *   NO HARD-CODED PEOPLE     nobody is granted anything, and no user id appears.
 *   ONE NEW PERMISSION       finance.verify_own_payment, deny-by-default and
 *                            protected, in the catalog Control Center reads.
 *   ONE VERIFICATION DOOR    complete_payment_entry verifies only the caller's
 *                            own pending payment, through
 *                            approve_finance_payment_request; the three entry
 *                            RPCs are untouched, so a proof can still be
 *                            attached while the payment is pending.
 *   THE SCREENS              call complete_payment_entry last, after the proof,
 *                            and draw the Admin decisions from permissions.
 *
 * The behaviour itself — both Admins, Sales, a verifier who is not an Admin,
 * the reference, notifications and the 40% gate — was exercised on disposable
 * data on a local stack; see the PR.
 *
 *   npx tsx --test src/lib/orders/permissionGatedAdminDecisions.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { deriveFinanceCapabilities } from '../permissions/finance'
import { isProtectedAction, ACTION_DEPENDENCIES } from '../permissions/levels'
import { isOwnPaymentDecision } from '../../app/finance/paymentRouting'
import { completePaymentEntry } from '../finance/paymentEntryCompletion'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const FILE = '20270120000000_order_submission_admin_decisions_ask_permissions.sql'
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const SQL = lf(readFileSync(join(MIGRATIONS, FILE), 'utf8'))
const readSrc = (p: string) => lf(readFileSync(join(ROOT, p), 'utf8'))

/** The dollar-quoted body of `public.<name>(` in a SQL text, or null. */
function bodyOf(sql: string, name: string): string | null {
  const head = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'ig')
  let last: string | null = null
  let m: RegExpExecArray | null
  while ((m = head.exec(sql)) !== null) {
    const after = sql.slice(m.index)
    const open = /\bas\s+(\$[a-z_]*\$)/i.exec(after)
    if (!open) continue
    const tag = open[1]
    const start = open.index + open[0].length
    const end = after.indexOf(tag, start)
    if (end < 0) continue
    last = after.slice(start, end)
  }
  return last
}

/** The latest definition of a function in any migration BEFORE this one. */
function previousBody(name: string): string {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql') && f < FILE).sort()
  for (let i = files.length - 1; i >= 0; i--) {
    const b = bodyOf(lf(readFileSync(join(MIGRATIONS, files[i]), 'utf8')), name)
    if (b !== null) return b
  }
  throw new Error(`no earlier definition of ${name}`)
}

const AO = "public.user_holds_permission(u.id, 'orders', 'approve_order')"
const AE = "public.user_has_module_permission(u.id, 'orders', 'approve_advance_exception')"
const AP = "public.user_has_module_permission(u.id, 'orders', 'align_production')"
const VO = "public.user_has_module_permission(v_actor, 'finance', 'verify_own_payment')"
const SELF_ADMIN = "not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin')"

/** [function, [from, to, expected count][]] — the whole of what changed. */
const RESTATED: [string, [string, string, number][]][] = [
  ['finance_payment_requests_guard_decision_status',
    [['    if coalesce(v_self, false)\n', `    if coalesce(v_self, false)\n       and not ${VO}\n`, 1]]],
  ['reject_finance_payment_request', [[SELF_ADMIN, `not ${VO}`, 1]]],
  ['request_finance_payment_clarification', [[SELF_ADMIN, `not ${VO}`, 1]]],
  ['approve_order_advance_exception', [["u.role = 'admin'", AE, 1]]],
  ['approve_order_pi_revision', [["coalesce(u.role = 'admin', false)", `coalesce(${AO}, false)`, 1]]],
  ['reject_order_pi_revision', [["coalesce(u.role = 'admin', false)", `coalesce(${AO}, false)`, 1]]],
  ['reapprove_order_pi_revision', [["u.role = 'admin'", AO, 2]]],
  ['decide_order_pi_revision_operations', [["u.role = 'admin'", AO, 1]]],
  ['decide_order_document_submission_admin', [["u.role = 'admin'", AO, 2]]],
  ['create_order_document_submission', [["u.role = 'admin'", AO, 1]]],
  ['order_pi_versions_record_operations_handoff', [["u.role = 'admin'", AO, 1]]],
  ['order_advance_hold_recheck', [["u.role = 'admin'", AE, 1]]],
  ['recover_order_production_alignment', [["u.role = 'admin'", AP, 1]]],
  ['order_advance_readiness', [["u.role = 'admin'", AP, 1]]],
]

describe('20270120000000 restates each decision, changing only who may take it', () => {
  for (const [name, subs] of RESTATED) {
    test(`${name}: the previous body, with only its role test replaced`, () => {
      let expected = lf(previousBody(name))
      for (const [from, to, count] of subs) {
        assert.equal(expected.split(from).length - 1, count, `${name}: "${from.trim()}" should occur ${count}×`)
        expected = expected.split(from).join(to)
      }
      const actual = bodyOf(SQL, name)
      assert.ok(actual, `${name} is restated`)
      assert.equal(actual.trim(), expected.trim())
    })
  }

  test('exactly these fourteen are restated, and no payment entry door is', () => {
    const restated = [...SQL.matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z_]+)\s*\(/gi)].map(m => m[1].toLowerCase())
    const expected = [...RESTATED.map(r => r[0]),
      'user_holds_permission', 'user_has_module_permission', 'complete_payment_entry']
    assert.deepEqual([...restated].sort(), [...expected].sort())
    for (const door of ['record_pi_submission_payment', 'record_payment_with_allocations', 'submit_payment_request']) {
      assert.ok(!restated.includes(door), `${door} must stay as it is, so a proof attaches while pending`)
    }
  })

  test('the payment guard keeps its role-admin early return; only the separation rule moved', () => {
    const body = bodyOf(SQL, 'finance_payment_requests_guard_decision_status')!
    assert.match(body, /if exists \(select 1 from public\.users u where u\.id = v_actor and u\.role = 'admin'\) then\n\s+return new;/)
    assert.ok(body.indexOf('PAYMENT_SELF_DECISION_FORBIDDEN') < body.indexOf('in_finance_payment_verification(old.id)'))
  })
})

describe('nothing is hard-coded: authority lives in Control Center', () => {
  const code = SQL.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

  test('no user id and no grant appear in the migration', () => {
    assert.doesNotMatch(code, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    assert.doesNotMatch(code, /insert\s+into\s+public\.employee_permission_overrides/i)
    assert.doesNotMatch(code, /update\s+public\.users/i)
  })

  test('finance.verify_own_payment is registered deny-by-default on Finance', () => {
    assert.match(code, /values \('verify_own_payment', 'Verify Own Payments', false\)/)
    assert.match(code, /select pm\.id, pa\.id, false\s+from public\.permission_modules pm\s+join public\.permission_actions pa on pa\.action_key = 'verify_own_payment'\s+where pm\.module_key = 'finance'/)
  })

  test('it is protected, needs finance.approve, and is in the catalog Control Center shows', () => {
    assert.equal(isProtectedAction('verify_own_payment'), true)
    assert.equal(ACTION_DEPENDENCIES.verify_own_payment, 'approve')
    assert.match(readSrc('src/lib/permissions/modules.ts'), /\{ actionKey: 'verify_own_payment', displayName: 'Verify Own Payments' \}/)
    assert.match(readSrc('src/lib/permissions/accessControlChanges.ts'), /verify_own_payment:\s+'Record and verify own payments in one step'/)
  })

  test('canDecideOwnPayment follows the grant: admin yes, holder yes, finance.approve alone no', () => {
    const grant = (...keys: string[]) => keys.map(actionKey => ({ actionKey, allowed: true })) as never
    assert.equal(deriveFinanceCapabilities('admin', []).canDecideOwnPayment, true)
    assert.equal(deriveFinanceCapabilities('manager', grant('view', 'approve', 'verify_own_payment')).canDecideOwnPayment, true)
    assert.equal(deriveFinanceCapabilities('manager', grant('view', 'approve', 'manage', 'allocate')).canDecideOwnPayment, false)
    assert.equal(deriveFinanceCapabilities('manager', grant('approve', 'verify_own_payment')).canDecideOwnPayment, false, 'no module entry, no capability')
  })

  test('the own-payment drawing rule asks the capability, not the role', () => {
    assert.equal(isOwnPaymentDecision('u1', 'u1', true), false)
    assert.equal(isOwnPaymentDecision('u1', 'u1', false), true)
    assert.equal(isOwnPaymentDecision('u1', 'u2', false), false)
  })
})

describe('it lands after the proof fix it depends on', () => {
  test('it sorts after 20270117000000 and refuses to apply before it', () => {
    assert.ok(FILE > '20270117000000_order_finance_guards_run_as_owner.sql')
    assert.match(SQL, /if not \(select p\.prosecdef from pg_proc p\s+where p\.oid = 'public\.order_finance_reset_write_guard\(\)'::regprocedure\) then\s+raise exception 'DEPENDENCY MISSING: 20270117000000/)
  })

  test('it sorts after 20270118120000 and refuses to apply before it (reviewers open the proof)', () => {
    assert.ok(FILE > '20270118120000_finance_payment_proof_opens_for_its_reviewers.sql')
    assert.match(SQL, /if to_regprocedure\('public\.can_open_payment_proof\(uuid\)'\) is null then\s+raise exception 'DEPENDENCY MISSING: 20270118120000/)
  })
})

describe('complete_payment_entry: the last call, only for the caller\'s own pending payment', () => {
  const body = bodyOf(SQL, 'complete_payment_entry')!

  test('refuses anybody else\'s payment, and does nothing for a non-holder or a decided payment', () => {
    assert.match(body, /if not found or v_req\.submitted_by is distinct from v_actor then\s+raise exception 'Payment request % not found'/)
    assert.match(body, /if v_req\.status <> 'pending_approval'\s+or not public\.user_has_module_permission\(v_actor, 'finance', 'verify_own_payment'\) then\s+return jsonb_build_object\([\s\S]*?'verified_on_entry', false\);/)
  })

  test('verifies through the one verification door, then tells the OTHER holders for information', () => {
    assert.match(body, /v_decision := public\.approve_finance_payment_request\(v_id, null\);/)
    assert.match(body, /where a\.id <> v_actor\s+and public\.user_has_module_permission\(a\.id, 'finance', 'verify_own_payment'\);/)
    assert.match(body, /For your information: %s recorded and verified payment %s \(₹%s\)\. No action is needed\./)
    assert.ok(body.indexOf('approve_finance_payment_request') < body.indexOf('insert into public.notifications'))
  })

  test('callable by signed-in people, never anon', () => {
    assert.match(SQL, /revoke execute on function public\.complete_payment_entry\(uuid\) from public, anon;\ngrant  execute on function public\.complete_payment_entry\(uuid\) to authenticated;/)
  })

  test('the client helper reports verified only when the server says so, and never throws', async () => {
    const ok = { rpc: async () => ({ data: { verified_on_entry: true }, error: null }) }
    const pending = { rpc: async () => ({ data: { verified_on_entry: false }, error: null }) }
    const failed = { rpc: async () => ({ data: null, error: { message: 'x' } }) }
    const threw = { rpc: async () => { throw new Error('network') } }
    assert.deepEqual(await completePaymentEntry(ok, 'p'), { verified: true })
    assert.deepEqual(await completePaymentEntry(pending, 'p'), { verified: false })
    assert.deepEqual(await completePaymentEntry(failed, 'p'), { verified: false })
    assert.deepEqual(await completePaymentEntry(threw, 'p'), { verified: false })
    assert.deepEqual(await completePaymentEntry(ok, null), { verified: false })
  })
})

describe('the screens: complete after the proof, and draw Admin decisions from permissions', () => {
  test('all three entry screens complete after the proof, and only on success', () => {
    const draft = readSrc('src/app/orders/drafts/[submissionId]/page.tsx')
    assert.ok(draft.indexOf('await attachPaymentProof(supabase, {') < draft.indexOf('await completePaymentEntry(supabase, paymentId)'))
    const finance = readSrc('src/app/finance/page.tsx')
    assert.ok(finance.indexOf('const proofErr = await persistProof(created.payment_request_id)') < finance.indexOf('await completePaymentEntry(supabase, created.payment_request_id)'))
    assert.match(finance, /if \(!completion\.verified\) \{\s+void notifyFinance\(\{\s+event: 'finance_submitted',/)
    const split = readSrc('src/app/finance/received/RecordSplitPaymentModal.tsx')
    assert.ok(split.indexOf('const proofError = await attachPaymentProof(supabase, {\n        paymentRequestId: result.payment_request_id,')
      < split.indexOf('await completePaymentEntry(supabase, result.payment_request_id)'))
  })

  test('the Order page asks approve_order and approve_advance_exception, never View As', () => {
    const page = readSrc('src/app/orders/[id]/page.tsx')
    assert.match(page, /const mayDecidePiAsAdmin = ordersCaps\.canApproveOrderSubmission && !viewAsUserId/)
    assert.match(page, /const mayApproveBelowAdvance = ordersCaps\.canApproveAdvanceException && !viewAsUserId/)
    assert.match(page, /canDecidePiRevision\(\{ isAdmin: mayDecidePiAsAdmin \}\)/)
    assert.match(page, /isAdmin=\{mayApproveBelowAdvance\}/)
    assert.match(page, /viewerId: docMe,\n\s+isAdmin: mayDecidePiAsAdmin,/)
  })

  test('the approve-revision route asks the permission, not users.role', () => {
    const route = readSrc('src/app/api/orders/pi-revisions/approve/route.ts')
    assert.doesNotMatch(route, /me\.role !== 'admin'/)
    assert.match(route, /service\.rpc\('user_holds_permission', \{\s+p_user_id: me\.id, p_module_key: 'orders', p_action_key: 'approve_order',/)
  })
})
