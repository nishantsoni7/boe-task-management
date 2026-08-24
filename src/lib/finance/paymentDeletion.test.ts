// Deleting one payment entry — the rule, the authority, and the sequence.
//
// WHAT THIS SUITE IS FOR. A PI Draft could not be deleted, the dialog told the
// operator to delete the payments holding it, and Finance had no control that
// would do it. The capability is in the database, but reaching it safely from
// two round trips is not — a count and a delete leave a gap a concurrent proof
// upload can fall into and be cascaded away with no durable record. These tests
// pin the parts this branch controls: which statuses the database really
// allows, who it really allows, and that the delete action itself now touches
// neither the database nor storage on any path.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DELETABLE_PAYMENT_STATUSES,
  PAYMENT_DELETE_UNAVAILABLE_MESSAGE,
  canDeletePayment,
  deletePaymentEntry,
  describePaymentAllocations,
  isPaymentDeletableStatus,
} from './paymentDeletion'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (src: string) => src.split('\n')
  .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
  .join('\n')

const ADMIN   = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER   = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STRANGER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PAYMENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const VERIFIED = ['approved_unlinked', 'approved_linked'] as const

// ── The status rule is the database's, not this module's ─────────────────────

describe('which statuses a payment may be deleted from', () => {
  const CHECK = read('supabase/migrations/20260628000200_create_finance_payment_requests.sql')
  const VERIFIER = read('supabase/migrations/20260918000000_finance_payment_allocations.sql')

  /**
   * THE LIST IS DERIVED, NOT REMEMBERED. Every status the CHECK constraint
   * admits, minus every status finance_payment_status_is_verified() calls
   * verified, must be exactly what this module offers. A sixth status added to
   * the constraint tomorrow fails this test rather than quietly becoming
   * deletable, and a verified one moved out of that function fails it rather
   * than quietly losing its protection.
   */
  test('deletable is exactly the CHECK constraint minus the canonical verified pair', () => {
    const block = CHECK.slice(CHECK.indexOf('check (status in ('))
    const declared = [...block.slice(0, block.indexOf('))')).matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.equal(declared.length, 5, `the constraint should admit five statuses; saw ${declared.join(', ')}`)

    const verifierBody = VERIFIER.slice(VERIFIER.indexOf('function public.finance_payment_status_is_verified'))
    const verified = [...verifierBody.slice(0, verifierBody.indexOf('$$;')).matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.deepEqual(verified.sort(), [...VERIFIED].sort(),
      'the canonical definition of verified must still name exactly these two')

    assert.deepEqual(
      declared.filter(status => !verified.includes(status)).sort(),
      [...DELETABLE_PAYMENT_STATUSES].sort(),
      'deletable statuses must be the complement of verified, with nothing invented and nothing missed')
  })

  test('a pending payment is deletable', () => {
    assert.equal(isPaymentDeletableStatus('pending_approval'), true)
  })

  test('a payment awaiting clarification is deletable', () => {
    assert.equal(isPaymentDeletableStatus('needs_clarification'), true)
  })

  test('a rejected payment is deletable', () => {
    assert.equal(isPaymentDeletableStatus('rejected'), true)
  })

  test('neither verified status is', () => {
    for (const status of VERIFIED) {
      assert.equal(isPaymentDeletableStatus(status), false, `${status} must never be deletable`)
    }
  })

  test('an unknown, absent or empty status is not', () => {
    for (const status of ['', 'draft', null, undefined]) {
      assert.equal(isPaymentDeletableStatus(status), false)
    }
  })

  /**
   * THE DATABASE IS WHAT ACTUALLY REFUSES, and it refuses everybody. The guard
   * carries no admin branch and no auth.uid() IS NULL branch — only the test
   * data cleanup context, which is a different, gated feature entirely.
   */
  test('the delete guard exempts nobody, so no UI mistake can reach verified money', () => {
    const guard = read('supabase/migrations/20260705000000_protect_finalized_orders_and_payments.sql')
    const body = guard.slice(
      guard.indexOf('create or replace function public.finance_payment_requests_guard_approved_delete'),
      guard.indexOf('create trigger finance_payment_requests_guard_approved_delete'))
    assert.ok(body.includes('PAYMENT_APPROVED_PERMANENT'), 'it must refuse by name')
    assert.ok(body.includes("old.status in ('approved_unlinked', 'approved_linked')"))
    assert.ok(!/u\.role = 'admin'/.test(body), 'an admin exemption would make the protection advisory')
    assert.ok(!/v_actor is null/.test(body), 'a service-role exemption would do the same')
  })

  /**
   * ORDERING IS LOAD-BEARING and the migration says so: the guard sorts before
   * the release (g < r), so a verified payment is refused BEFORE its allocations
   * are touched.
   */
  test('the release trigger sorts after the guard, so nothing is released before the refusal', () => {
    assert.ok('finance_payment_requests_guard_approved_delete'
      < 'finance_payment_requests_release_allocations')
  })
})

// ── Who may delete ───────────────────────────────────────────────────────────

describe('who the database lets delete a payment, and therefore who is offered it', () => {
  const pending = { status: 'pending_approval', submitted_by: OWNER }

  test('an administrator may delete any unapproved payment', () => {
    assert.equal(canDeletePayment(pending, { isAdmin: true, userId: STRANGER }), true)
  })

  test('the person who raised it may delete their own', () => {
    assert.equal(canDeletePayment(pending, { isAdmin: false, userId: OWNER }), true)
  })

  test('somebody else may not, however senior', () => {
    assert.equal(canDeletePayment(pending, { isAdmin: false, userId: STRANGER }), false)
  })

  /**
   * NOT AN OVERSIGHT — A FINDING. No policy grants DELETE on
   * finance_payment_requests by Finance permission, so a Finance manager who did
   * not raise the payment gets a delete that matches zero rows and a message
   * saying the payment is verified, which is the least true thing available.
   * This is asserted so that widening it stays a deliberate database decision.
   */
  test('no DELETE policy on the payments table is granted by Finance permission', () => {
    const owner = read('supabase/migrations/20260700000000_finance_payment_request_owner_delete.sql')
    const admin = read('supabase/migrations/20260654_finance_admin_delete_policy.sql')
    assert.ok(owner.includes("submitted_by = auth.uid()"), 'the creator policy exists')
    assert.ok(admin.includes("users.role = 'admin'"), 'the admin policy exists')
    for (const src of [owner, admin]) {
      assert.ok(!/actor_has_module_permission\s*\(\s*'finance'/.test(code(src)),
        'a Finance-permission DELETE grant would be a business decision, not a UI convenience')
    }
  })

  test('a signed-out or still-loading reader is offered nothing', () => {
    assert.equal(canDeletePayment(pending, { isAdmin: false, userId: null }), false)
    assert.equal(canDeletePayment(pending, { isAdmin: false, userId: undefined }), false)
  })

  test('neither owner nor admin may delete a verified payment', () => {
    for (const status of VERIFIED) {
      assert.equal(canDeletePayment({ status, submitted_by: OWNER }, { isAdmin: true, userId: ADMIN }), false)
      assert.equal(canDeletePayment({ status, submitted_by: OWNER }, { isAdmin: false, userId: OWNER }), false)
    }
  })
})

// ── The sequence ─────────────────────────────────────────────────────────────
//
// THE RACE THIS REPLACES. A count over the network, then a DELETE over a second
// round trip, is two statements with no lock held between them — a proof
// inserted in the gap is cascaded away by the DELETE along with the only row
// that named its storage object. That is true whether the count read zero or
// not: an "apparently zero-proof" payment is only a payment whose proof count
// had not yet become nonzero at the moment it was asked. So this build makes no
// distinction between the two, and no call at all.

type Call = { kind: string; detail?: unknown }

function trackedSupabase() {
  const calls: Call[] = []
  const supabase = {
    from(table: string) {
      calls.push({ kind: 'from', detail: { table } })
      return {
        select() { throw new Error(`must not query ${table}`) },
        delete() { throw new Error(`must not delete from ${table}`) },
      }
    },
    storage: {
      from(bucket: string) {
        calls.push({ kind: 'storage.from', detail: { bucket } })
        return { remove() { throw new Error(`must not remove from ${bucket}`) } }
      },
    },
  } as unknown as SupabaseClient
  return { supabase, calls }
}

const describeError = (e: { code?: string; message: string }) => e.message
const payment = { id: PAYMENT, request_number: 'PR-1', status: 'pending_approval' }

describe('the delete action, which refuses rather than racing', () => {
  test('deletion performs no database call — no count, no DELETE', async () => {
    const { supabase, calls } = trackedSupabase()
    await deletePaymentEntry(supabase, payment, describeError)
    assert.deepEqual(calls, [], 'nothing may be read or written for any payment, of any status')
  })

  test('deletion performs no storage call', async () => {
    const { supabase, calls } = trackedSupabase()
    await deletePaymentEntry(supabase, payment, describeError)
    assert.ok(!calls.some(c => c.kind === 'storage.from'), 'no object in the bucket is ever touched')
  })

  test('a proof-backed payment refuses safely, and nothing is touched', async () => {
    const { supabase, calls } = trackedSupabase()
    const result = await deletePaymentEntry(supabase, payment, describeError)
    assert.deepEqual(result, { outcome: 'unavailable', message: PAYMENT_DELETE_UNAVAILABLE_MESSAGE })
    assert.deepEqual(calls, [])
  })

  test('an apparently zero-proof payment refuses exactly the same way', async () => {
    // "Apparently zero-proof" is a belief the screen holds, never verified here
    // against the database — that is the point. The result is byte-for-byte the
    // same as the proof-backed case, because nothing distinguishes the two
    // without a query this module deliberately does not make.
    const { supabase } = trackedSupabase()
    const proofBacked = await deletePaymentEntry(supabase, payment, describeError)
    const apparentlyZero = await deletePaymentEntry(
      supabase, { ...payment, status: 'needs_clarification' }, describeError)
    assert.deepEqual(apparentlyZero, proofBacked)
    assert.equal(apparentlyZero.outcome, 'unavailable')
  })

  test('a rejected payment refuses the same way too', async () => {
    const { supabase } = trackedSupabase()
    const result = await deletePaymentEntry(supabase, { ...payment, status: 'rejected' }, describeError)
    assert.equal(result.outcome, 'unavailable')
  })

  test('the message clearly says no data was removed', () => {
    assert.match(PAYMENT_DELETE_UNAVAILABLE_MESSAGE, /No data was removed\./)
    assert.match(PAYMENT_DELETE_UNAVAILABLE_MESSAGE, /next version/)
  })

  test('no “proof-orphaned” result exists, and no other outcome does either', () => {
    const src = read('src/lib/finance/paymentDeletion.ts')
    const outcomes = [...src.matchAll(/outcome: '([a-z-]+)'/g)].map(m => m[1])
    assert.ok(!outcomes.includes('proof-orphaned'),
      'an orphaned proof must never be reportable as a settled outcome')
    assert.ok(!outcomes.includes('deleted'),
      'this build never reports a payment as deleted, because it never deletes one')
    assert.deepEqual([...new Set(outcomes)].sort(), ['unavailable'])
  })

  test('the module makes no storage call anywhere in its source', () => {
    const src = code(read('src/lib/finance/paymentDeletion.ts'))
    assert.ok(!src.includes('.storage'), 'nothing here may touch the bucket')
    assert.ok(!src.includes('PROOF_BUCKET'), 'and it has no business naming one')
  })

  test('the module issues no DELETE and no SELECT against Supabase anywhere in its source', () => {
    const src = code(read('src/lib/finance/paymentDeletion.ts'))
    assert.ok(!/\.from\(/.test(src), 'no table may be reached at all — not to read, not to write')
  })

  test('a repeated attempt reports the same settled answer every time', async () => {
    const { supabase } = trackedSupabase()
    const first  = await deletePaymentEntry(supabase, payment, describeError)
    const second = await deletePaymentEntry(supabase, payment, describeError)
    assert.deepEqual(first, second, 'asking twice must not produce two different truths')
  })

  test('this module never writes to the allocations table', () => {
    const src = code(read('src/lib/finance/paymentDeletion.ts'))
    assert.ok(!src.includes('finance_payment_allocations'))
  })

  test('DELETABLE_PAYMENT_STATUSES is unchanged: visibility of the button is untouched by the refusal', () => {
    assert.deepEqual([...DELETABLE_PAYMENT_STATUSES].sort(),
      ['needs_clarification', 'pending_approval', 'rejected'])
  })
})

// ── The allocation sentence ──────────────────────────────────────────────────

describe('what the dialog says a payment is paying for', () => {
  test('an Order and a PI Draft are both named, by kind and count only', () => {
    assert.equal(
      describePaymentAllocations([{ kind: 'order' }, { kind: 'submission' }]),
      'This payment is currently allocated to 1 Order and 1 PI Draft.')
  })

  test('several of one kind read naturally', () => {
    assert.equal(
      describePaymentAllocations([{ kind: 'order' }, { kind: 'order' }]),
      'This payment is currently allocated to 2 Orders.')
    assert.equal(
      describePaymentAllocations([{ kind: 'submission' }, { kind: 'submission' }, { kind: 'submission' }]),
      'This payment is currently allocated to 3 PI Drafts.')
  })

  test('a payment allocated to nothing says nothing', () => {
    assert.equal(describePaymentAllocations([]), null)
  })

  test('no amount, client or record name is disclosed', () => {
    const sentence = describePaymentAllocations([{ kind: 'order' }, { kind: 'submission' }]) ?? ''
    assert.ok(!/₹|\d{4,}|client/i.test(sentence),
      'counts and kinds only — the reader may not be permitted to see the records themselves')
  })
})
