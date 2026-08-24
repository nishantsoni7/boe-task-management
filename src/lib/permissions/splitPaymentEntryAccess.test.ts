/**
 * WHO MAY DIVIDE A PAYMENT AS THEY RECORD IT.
 *
 * THE BUSINESS RULE. Sales may record payments. Sales may DIVIDE one only when
 * separately authorized, and that authorization is granted per person through
 * Access Control — not by job title, and never to every Sales user at once.
 * Senior Sales is not a different rule; it is the same two questions.
 *
 * THE TWO GATES, AND WHY THEY ARE THE RIGHT TWO.
 *
 *   finance module entry   is what "may record a payment" already means. The
 *     /finance page offers Send Payment Request to anybody who can open the
 *     module — there is no second action gate on it — and the RESTRICTIVE
 *     policy on finance_payment_requests requires the same of every write.
 *
 *   finance.allocate       is the separate allocation permission, registered by
 *     20260918000000 and PROTECTED, which means no preset level confers it and
 *     an administrator must grant it to a named person. It is what
 *     allocate_payment_to_target() already requires of the same act performed a
 *     minute later, so entering the allocations at the same moment cannot need
 *     less.
 *
 * NOTHING HERE IS THE AUTHORITY. record_payment_with_allocations() asks both
 * questions itself, server-side, and the SQL suite proves it does
 * (supabase/tests/order_number_reservation_assertions.sql, cases P1–P8). This
 * file pins the DRAWING rule and the shape of the permission, so a control is
 * never offered to somebody the RPC will refuse — and never withheld from
 * somebody it would accept.
 *
 * Offline and pure.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/splitPaymentEntryAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'

import { deriveFinanceCapabilities } from './finance'
import { isProtectedAction } from './levels'
import { getRegisteredModule } from './registry'
import type { EffectivePermission } from './types'
import './modules'

/** Every Finance action, so a grant is the ABSENCE of the others as well. */
const FINANCE_ACTIONS = [
  'view', 'create', 'edit', 'delete', 'approve', 'export', 'manage',
  'view_all', 'allocate', 'allocate_correct',
]

/** An effective-permission set, as the resolver hands it to the derivers. */
const perms = (allowed: string[]): EffectivePermission[] =>
  FINANCE_ACTIONS.map(actionKey => ({
    actionKey,
    allowed: allowed.includes(actionKey),
    source: 'employee_override' as const,
  }))

/** What the Record Split Payment control asks before it draws itself. */
const mayDivideAtEntry = (role: string, actions: string[]) =>
  deriveFinanceCapabilities(role, perms(actions)).canAllocatePayment

/** What the ordinary single-target entry form asks. */
const mayRecord = (role: string, actions: string[]) =>
  deriveFinanceCapabilities(role, perms(actions)).canAccessFinanceModule

describe('the allocation permission is configurable, and never implied', () => {
  test('finance.allocate is a registered action an administrator can grant', () => {
    const finance = getRegisteredModule('finance')
    assert.ok(finance, 'the Finance module must be registered')
    const allocate = finance.actions.find(a => a.actionKey === 'allocate')
    assert.ok(allocate, 'finance.allocate must appear in Access Control')
    assert.equal(allocate.displayName, 'Allocate Payments')
  })

  test('and it is PROTECTED, so no preset level hands it out', () => {
    // This is what "separately authorized" means mechanically: picking
    // "Manager" from a dropdown cannot confer it. Somebody has to name the
    // person.
    assert.equal(isProtectedAction('allocate'), true)
  })

  test('it is not implied by any wider Finance authority', () => {
    for (const wider of ['view_all', 'manage', 'approve', 'create', 'edit', 'export']) {
      assert.equal(mayDivideAtEntry('member', ['view', wider]), false,
        `finance.${wider} must not confer allocation`)
    }
  })
})

describe('the same two questions, whoever is asking', () => {
  // A role string is passed because deriveFinanceCapabilities takes one; only
  // 'admin' is special to it, and that is the project's established bypass.
  // Every other value below is an ordinary member — Sales and Senior Sales are
  // not roles the permission engine knows, and that is the point.
  const SALES = 'member'

  test('a selected Sales user, granted both, may divide at entry', () => {
    assert.equal(mayDivideAtEntry(SALES, ['view', 'allocate']), true)
  })

  test('a selected Senior Sales user, granted both, may divide at entry', () => {
    // Identical, and identical BECAUSE seniority is not a permission. The two
    // cases are here as two cases only because the business states them as two.
    assert.equal(mayDivideAtEntry(SALES, ['view', 'allocate']), true)
  })

  test('a Sales user WITHOUT the grant may record, but not divide', () => {
    assert.equal(mayRecord(SALES, ['view']), true)
    assert.equal(mayDivideAtEntry(SALES, ['view']), false)
  })

  test('the allocation grant alone confers nothing — it has nowhere to act', () => {
    // withEntry() gates every capability on module entry as well as its own
    // action, so a row left behind by a half-finished grant cannot produce a
    // button on a module the person cannot open.
    assert.equal(mayRecord(SALES, ['allocate']), false)
    assert.equal(mayDivideAtEntry(SALES, ['allocate']), false)
  })

  test('Finance and Admin keep exactly what they had', () => {
    assert.equal(mayDivideAtEntry(SALES, ['view', 'allocate', 'approve', 'manage']), true)
    // An admin short-circuits the whole derivation, which is the project's
    // established rule and is not narrowed here.
    assert.equal(mayDivideAtEntry('admin', []), true)
    assert.equal(mayRecord('admin', []), true)
  })

  test('nobody is decided by a role, a team or a title', () => {
    // The SAME grants produce the SAME answer whatever the role string says.
    // A future shortcut on `team = 'sales'` would break this.
    for (const role of ['member', 'manager', 'employee', 'sales', 'senior_sales']) {
      assert.equal(mayDivideAtEntry(role, ['view', 'allocate']), true, role)
      assert.equal(mayDivideAtEntry(role, ['view']), false, role)
    }
  })
})

describe('the control and the RPC ask the same question', () => {
  test('the button is drawn from canAllocatePayment, and from nothing else', () => {
    const source = readFileSync('src/app/finance/received/ReceivedPaymentsView.tsx', 'utf8')
    const at = source.indexOf('RECORD_PAYMENT_ACTION_LABEL}\n          </button>')
    assert.ok(at > 0, 'the Record Payment control must be on this page')
    const block = source.slice(Math.max(0, at - 900), at)
    assert.match(block, /caps\.canAllocatePayment &&/)
    // No role, team or title anywhere near the decision.
    assert.doesNotMatch(block, /role\s*===|team\s*===|'sales'|'senior/i)
  })

  test('and the migration enforces BOTH gates server-side', () => {
    const sql = readFileSync(
      'supabase/migrations/20261009000000_split_payment_entry_and_order_submission_number_reservation.sql',
      'utf8')
    const fn = sql.slice(sql.indexOf('create or replace function public.record_payment_with_allocations'))
    assert.match(fn, /public\.module_entry_open\('finance'\)/)
    assert.match(fn, /actor_has_module_permission\('finance', 'allocate'\)/)
    // Both refusals precede the first write, so a refused caller costs no row.
    const entry  = fn.indexOf("module_entry_open('finance')")
    const alloc  = fn.indexOf("actor_has_module_permission('finance', 'allocate')")
    const insert = fn.indexOf('insert into public.finance_payment_requests')
    assert.ok(entry > 0 && entry < alloc && alloc < insert)
  })
})
