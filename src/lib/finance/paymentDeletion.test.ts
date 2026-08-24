// Deleting one payment entry — the rule, the authority, and the sequence.
//
// WHAT THIS SUITE IS FOR. A PI Draft could not be deleted, the dialog told the
// operator to delete the payments holding it, and Finance had no control that
// would do it. The capability was in the database the whole time; what was
// missing was a way to reach it and a single place that defines who may. These
// tests pin all three: which statuses the database really allows, who it really
// allows, and that the sequence cannot destroy a proof for a payment that
// survives.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DELETABLE_PAYMENT_STATUSES,
  PAYMENT_DELETE_PROOF_BACKED_MESSAGE,
  PAYMENT_DELETE_RACE_MESSAGE,
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

type Call = { kind: string; detail?: unknown }

function fakeSupabase(options: {
  proofs?: { storage_path: string }[]
  proofError?: boolean
  deleteCount?: number
  deleteError?: { code?: string; message: string }
  removed?: number | null
  removeError?: boolean
} = {}) {
  const calls: Call[] = []
  const filters: Record<string, unknown> = {}
  const supabase = {
    from(table: string) {
      return {
        select(columns: string, opts?: { count?: string; head?: boolean }) {
          return {
            eq(column: string, value: unknown) {
              calls.push({ kind: 'select', detail: {
                table, columns, column, value, head: opts?.head === true, count: opts?.count,
              } })
              return Promise.resolve(options.proofError
                ? { count: null, data: null, error: { message: 'nope' } }
                : { count: (options.proofs ?? []).length, data: null, error: null })
            },
          }
        },
        delete(opts?: { count?: string }) {
          const chain = {
            eq(column: string, value: unknown) { filters[column] = value; return chain },
            in(column: string, values: readonly string[]) {
              calls.push({ kind: 'delete', detail: { table, count: opts?.count, filters, statuses: [...values] } })
              return Promise.resolve(options.deleteError
                ? { error: options.deleteError, count: null }
                : { error: null, count: options.deleteCount ?? 1 })
            },
          }
          return chain
        },
      }
    },
    storage: {
      from(bucket: string) {
        return {
          remove(paths: string[]) {
            calls.push({ kind: 'remove', detail: { bucket, paths } })
            if (options.removeError) return Promise.resolve({ data: null, error: { message: 'gone' } })
            const n = options.removed === undefined ? paths.length : options.removed
            return Promise.resolve({ data: n === null ? null : paths.slice(0, n).map(p => ({ name: p })), error: null })
          },
        }
      },
    },
  } as unknown as SupabaseClient
  return { supabase, calls }
}

const describeError = (e: { code?: string; message: string }) => e.message
const payment = { id: PAYMENT, request_number: 'PR-1', status: 'pending_approval' }

describe('the delete sequence, which now refuses rather than leaking', () => {
  test('a pending payment with no proof is deleted, and storage is never called', async () => {
    const { supabase, calls } = fakeSupabase({ proofs: [] })
    assert.deepEqual(await deletePaymentEntry(supabase, payment, describeError), { outcome: 'deleted' })
    assert.deepEqual(calls.map(c => c.kind), ['select', 'delete'],
      'the attachments are counted, the payment goes, and nothing else happens')
    assert.equal(calls.filter(c => c.kind === 'remove').length, 0)
  })

  test('a clarification-stage payment deletes the same way', async () => {
    const { supabase } = fakeSupabase({ proofs: [] })
    const result = await deletePaymentEntry(
      supabase, { ...payment, status: 'needs_clarification' }, describeError)
    assert.equal(result.outcome, 'deleted')
  })

  test('a rejected payment deletes the same way', async () => {
    const { supabase } = fakeSupabase({ proofs: [] })
    assert.equal(
      (await deletePaymentEntry(supabase, { ...payment, status: 'rejected' }, describeError)).outcome,
      'deleted')
  })

  /**
   * THE CORRECTION, IN ONE TEST. The previous sequence deleted the payment and
   * then removed its proof objects, reporting a storage failure as a partial
   * success. payment_proof_attachments cascades with the payment, so at that
   * moment the trusted list of object keys had already been destroyed and no
   * retry was possible. A payment with proofs is now refused before anything is
   * touched.
   */
  test('a proof-backed payment is refused, and NOTHING is deleted', async () => {
    const { supabase, calls } = fakeSupabase({ proofs: [{ storage_path: `${PAYMENT}/proof.pdf` }] })
    const result = await deletePaymentEntry(supabase, payment, describeError)
    assert.equal(result.outcome, 'proof-backed')
    assert.equal((result as { message: string }).message, PAYMENT_DELETE_PROOF_BACKED_MESSAGE)
    assert.deepEqual(calls.map(c => c.kind), ['select'],
      'the refusal happens on the attachment count; no delete and no storage call follow')
  })

  test('no allocation can be released by a refusal, because no delete is issued', async () => {
    const { supabase, calls } = fakeSupabase({ proofs: [{ storage_path: 'a' }, { storage_path: 'b' }] })
    await deletePaymentEntry(supabase, payment, describeError)
    assert.equal(calls.filter(c => c.kind === 'delete').length, 0,
      'finance_payment_requests_release_allocations fires on DELETE; no DELETE, no release')
  })

  test('“partial success” is gone from the result type altogether', () => {
    const src = read('src/lib/finance/paymentDeletion.ts')
    const outcomes = [...src.matchAll(/outcome: '([a-z-]+)'/g)].map(m => m[1])
    assert.ok(!outcomes.includes('proof-orphaned'),
      'an orphaned proof must never be reportable as a settled outcome')
    assert.deepEqual([...new Set(outcomes)].sort(),
      ['already-verified', 'deleted', 'failed', 'proof-backed'])
  })

  test('the module makes no storage call on any path', () => {
    const src = code(read('src/lib/finance/paymentDeletion.ts'))
    assert.ok(!src.includes('.storage'), 'nothing here may touch the bucket')
    assert.ok(!src.includes('PROOF_BUCKET'), 'and it has no business naming one')
  })

  test('the DELETE is filtered on status server-side, so the database re-decides', async () => {
    const { supabase, calls } = fakeSupabase({ proofs: [] })
    await deletePaymentEntry(supabase, payment, describeError)
    const del = calls.find(c => c.kind === 'delete')!.detail as {
      table: string; count?: string; filters: Record<string, unknown>; statuses: string[]
    }
    assert.equal(del.table, 'finance_payment_requests')
    assert.equal(del.count, 'exact', 'the row count is what tells a race from a success')
    assert.equal(del.filters.id, PAYMENT, 'this payment and no other')
    assert.deepEqual(del.statuses.sort(), [...DELETABLE_PAYMENT_STATUSES].sort())
  })

  test('a payment verified while the dialog was open is refused', async () => {
    const { supabase } = fakeSupabase({ proofs: [], deleteCount: 0 })
    assert.deepEqual(await deletePaymentEntry(supabase, payment, describeError),
      { outcome: 'already-verified', message: PAYMENT_DELETE_RACE_MESSAGE })
  })

  test('a database refusal is reported and deletes nothing', async () => {
    const { supabase } = fakeSupabase({
      proofs: [],
      deleteError: { code: '42501', message: 'PAYMENT_APPROVED_PERMANENT: permanent history' },
    })
    const result = await deletePaymentEntry(supabase, payment, describeError)
    assert.equal(result.outcome, 'failed')
    assert.match((result as { message: string }).message, /PAYMENT_APPROVED_PERMANENT/)
  })

  /**
   * A COUNT THAT COULD NOT BE TAKEN IS NOT A COUNT OF ZERO. The one thing this
   * must never do is read "I could not ask whether there are proofs" as "there
   * are none" and delete the payment anyway.
   */
  test('an unreadable attachment count stops before anything is deleted', async () => {
    const { supabase, calls } = fakeSupabase({ proofError: true })
    const result = await deletePaymentEntry(supabase, payment, describeError)
    assert.equal(result.outcome, 'failed')
    assert.deepEqual(calls.map(c => c.kind), ['select'], 'nothing after the failed read may run')
  })

  test('the attachment count is a HEAD request keyed by this payment alone', async () => {
    const { supabase, calls } = fakeSupabase({ proofs: [] })
    await deletePaymentEntry(supabase, payment, describeError)
    const sel = calls.find(c => c.kind === 'select')!.detail as {
      table: string; column: string; value: unknown; head: boolean; count?: string
    }
    assert.equal(sel.table, 'payment_proof_attachments')
    assert.equal(sel.column, 'payment_request_id')
    assert.equal(sel.value, PAYMENT, 'only this payment’s own attachments are counted')
    assert.equal(sel.head, true, 'no row content is needed to answer “are there any”')
    assert.equal(sel.count, 'exact')
  })

  /**
   * CONCURRENCY, HONESTLY. The count is the LAST thing before the delete, so a
   * proof that exists when the operator presses the button is always seen. A
   * proof uploaded inside the one round trip between the two is not — this build
   * cannot freeze proof mutation, which is precisely what the pending claim
   * protocol adds. What is asserted here is the part this build controls: the
   * read is fresh, taken inside the call rather than handed in, so a payment
   * that gained a proof since the list was drawn is still refused.
   */
  test('a proof that appeared since the list was drawn is still caught', async () => {
    const proofs: { storage_path: string }[] = []
    const { supabase } = fakeSupabase({ proofs })
    proofs.push({ storage_path: `${PAYMENT}/late.pdf` })   // uploaded after the row was rendered
    const result = await deletePaymentEntry(supabase, payment, describeError)
    assert.equal(result.outcome, 'proof-backed',
      'the count is taken at delete time, not from what the screen was holding')
  })

  test('the ordering is asserted: count first, delete second, never the reverse', () => {
    const src = code(read('src/lib/finance/paymentDeletion.ts'))
    const countAt  = src.indexOf("from('payment_proof_attachments')")
    const deleteAt = src.indexOf("from('finance_payment_requests')")
    assert.ok(countAt > 0 && deleteAt > 0)
    assert.ok(countAt < deleteAt,
      'deleting before knowing destroys the manifest that a retry would need')
  })

  test('a repeated request after the row is gone reports the same settled answer', async () => {
    const { supabase } = fakeSupabase({ proofs: [], deleteCount: 0 })
    const first  = await deletePaymentEntry(supabase, payment, describeError)
    const second = await deletePaymentEntry(supabase, payment, describeError)
    assert.deepEqual(first, second, 'asking twice must not produce two different truths')
  })

  test('this module never writes to the allocations table itself', () => {
    const src = code(read('src/lib/finance/paymentDeletion.ts'))
    assert.ok(!src.includes('finance_payment_allocations'),
      'the release is the trigger’s, atomic with the delete; a second write could be left half-done')
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
