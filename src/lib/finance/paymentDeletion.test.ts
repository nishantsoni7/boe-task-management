// Deleting one payment entry — the rule, the authority, and the client-facing
// policy over /api/finance/payments/delete.
//
// REVISED RULE (20261011000000): deletion is ADMIN-ONLY, for a payment of ANY
// status — Payment Requests and Confirmed Payments alike. Self-delete by the
// submitter of an unapproved payment, which the previous rule allowed, is
// withdrawn. deletePaymentEntry is a thin client over the durable claim
// protocol route; every actual decision (authority, the reason gate, the typed
// Payment ID) is the server's and the database's, re-derived on every call —
// this suite pins the client-side policy (who sees the button) and the shape
// of what the client sends and reports back, never a second copy of server
// authority.

import assert from 'node:assert/strict'
import { describe, test, afterEach } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DELETABLE_PAYMENT_STATUSES,
  canDeletePayment,
  deletePaymentEntry,
  describePaymentAllocations,
  isConfirmedPaymentStatus,
  isPaymentDeletableStatus,
  paymentDeleteConfirmIdLabel,
} from './paymentDeletion'
import { REQUEST_STAGE_STATUSES } from '@/app/finance/paymentRouting'
import { CONFIRMED_PAYMENT_STATUSES } from './paymentSurfaces'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (src: string) => src.split('\n')
  .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
  .join('\n')

const PAYMENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const HUMAN_ID = 'P-AA-0047'

// ── The status rule is the database's, not this module's ─────────────────────

describe('which statuses a payment may be deleted from', () => {
  const CHECK = read('supabase/migrations/20260628000200_create_finance_payment_requests.sql')

  /**
   * EVERY STATUS, NOT THE UNAPPROVED THREE. Deletion stopped being status-gated
   * (20261011000000 §3a: "admin, any status") and became actor-gated instead —
   * so DELETABLE_PAYMENT_STATUSES is now exactly the CHECK constraint's full
   * enum, derived rather than remembered, so a sixth status added tomorrow
   * fails this test rather than quietly becoming unreachable.
   */
  test('deletable is exactly the CHECK constraint, no status excluded', () => {
    const block = CHECK.slice(CHECK.indexOf('check (status in ('))
    const declared = [...block.slice(0, block.indexOf('))')).matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.equal(declared.length, 5, `the constraint should admit five statuses; saw ${declared.join(', ')}`)
    assert.deepEqual(declared.sort(), [...DELETABLE_PAYMENT_STATUSES].sort())
  })

  test('DELETABLE_PAYMENT_STATUSES is the union of the request-stage and confirmed statuses', () => {
    assert.deepEqual(
      [...DELETABLE_PAYMENT_STATUSES].sort(),
      [...REQUEST_STAGE_STATUSES, ...CONFIRMED_PAYMENT_STATUSES].sort())
  })

  test('a pending payment is a deletable status', () => {
    assert.equal(isPaymentDeletableStatus('pending_approval'), true)
  })

  test('a payment awaiting clarification is a deletable status', () => {
    assert.equal(isPaymentDeletableStatus('needs_clarification'), true)
  })

  test('a rejected payment is a deletable status', () => {
    assert.equal(isPaymentDeletableStatus('rejected'), true)
  })

  /**
   * A CONFIRMED PAYMENT MAY NOW BE DELETED TOO — the reversal from the previous
   * rule, which excluded approved_unlinked/approved_linked entirely. Whether it
   * actually IS deleted still turns on canDeletePayment (admin-only) below, and
   * on the server's reason + typed-Payment-ID gates.
   */
  test('both Confirmed Payment statuses are deletable statuses now', () => {
    assert.equal(isPaymentDeletableStatus('approved_unlinked'), true)
    assert.equal(isPaymentDeletableStatus('approved_linked'), true)
  })

  test('an unknown, absent or empty status is not', () => {
    for (const status of ['', 'draft', null, undefined]) {
      assert.equal(isPaymentDeletableStatus(status), false)
    }
  })

  test('isConfirmedPaymentStatus agrees with CONFIRMED_PAYMENT_STATUSES', () => {
    assert.equal(isConfirmedPaymentStatus('approved_unlinked'), true)
    assert.equal(isConfirmedPaymentStatus('approved_linked'), true)
    assert.equal(isConfirmedPaymentStatus('pending_approval'), false)
    assert.equal(isConfirmedPaymentStatus(null), false)
  })

  /**
   * THE DATABASE IS WHAT ACTUALLY REFUSES an approved delete for every OTHER
   * caller. The base guard (20260705000000) carries no blanket admin branch and
   * no auth.uid() IS NULL branch — 20261011000000 §3c widens it with exactly
   * one narrow, scoped exemption (in_finance_payment_deletion_finalization),
   * never a blanket one. This still asserts the ORIGINAL text never granted a
   * bare admin bypass.
   */
  test('the base delete guard exempts nobody outright, so no UI mistake could once have reached verified money', () => {
    const guard = read('supabase/migrations/20260705000000_protect_finalized_orders_and_payments.sql')
    const body = guard.slice(
      guard.indexOf('create or replace function public.finance_payment_requests_guard_approved_delete'),
      guard.indexOf('create trigger finance_payment_requests_guard_approved_delete'))
    assert.ok(body.includes('PAYMENT_APPROVED_PERMANENT'), 'it must refuse by name')
    assert.ok(body.includes("old.status in ('approved_unlinked', 'approved_linked')"))
    assert.ok(!/u\.role = 'admin'/.test(body), 'a blanket admin exemption would make the protection advisory')
    assert.ok(!/v_actor is null/.test(body), 'a service-role exemption would do the same')
  })

  /**
   * THE WIDENED GUARD (20261011000000 §3c) exempts exactly one narrow,
   * transaction-scoped case — never a blanket admin or unauthenticated one.
   */
  test('the widened guard exempts only the one finalize transaction, never a blanket role', () => {
    const migration = read('supabase/migrations/20261011000000_admin_payment_deletion_and_payment_id.sql')
    const body = migration.slice(
      migration.indexOf('create or replace function public.finance_payment_requests_guard_approved_delete'),
      migration.indexOf('revoke execute on function public.finance_payment_requests_guard_approved_delete'))
    assert.ok(body.includes('in_finance_payment_deletion_finalization'),
      'the exemption must be the narrow, scoped predicate — not a role check')
    assert.ok(!/u\.role = 'admin'/.test(body), 'still no blanket admin exemption')
  })
})

// ── Who may delete — admin-only, for any status ───────────────────────────────

describe('who the database lets delete a payment, and therefore who is offered it', () => {
  test('an administrator may delete an unapproved payment', () => {
    assert.equal(canDeletePayment({ status: 'pending_approval' }, { isAdmin: true }), true)
  })

  test('an administrator may delete a Confirmed Payment too — the reversal from the previous rule', () => {
    assert.equal(canDeletePayment({ status: 'approved_unlinked' }, { isAdmin: true }), true)
    assert.equal(canDeletePayment({ status: 'approved_linked' }, { isAdmin: true }), true)
  })

  /**
   * SELF-DELETE IS WITHDRAWN. The previous rule let the submitter of their own
   * unapproved payment delete it; canDeletePayment no longer takes a submitter
   * or actor id at all, so there is no branch left that could grant it.
   */
  test('a non-admin may not delete their own unapproved payment', () => {
    assert.equal(canDeletePayment({ status: 'pending_approval' }, { isAdmin: false }), false)
  })

  test('a non-admin may not delete any payment, of any status', () => {
    for (const status of DELETABLE_PAYMENT_STATUSES) {
      assert.equal(canDeletePayment({ status }, { isAdmin: false }), false, status)
    }
  })

  test('an admin may delete a payment of every status the database admits', () => {
    for (const status of DELETABLE_PAYMENT_STATUSES) {
      assert.equal(canDeletePayment({ status }, { isAdmin: true }), true, status)
    }
  })

  test('an unrecognised status is refused even for an admin — a drawing rule only, the RPC re-derives authority', () => {
    assert.equal(canDeletePayment({ status: 'draft' }, { isAdmin: true }), false)
  })

  test('finance_payment_deletable_by (the real authority) grants no submitted_by branch', () => {
    const migration = read('supabase/migrations/20261011000000_admin_payment_deletion_and_payment_id.sql')
    const body = migration.slice(
      migration.indexOf('create or replace function public.finance_payment_deletable_by'),
      migration.indexOf('comment on function public.finance_payment_deletable_by'))
    assert.ok(!code(body).includes('submitted_by'), 'self-delete must not survive anywhere in the real authority')
    assert.ok(body.includes("u.role = 'admin'"), 'admin is the only branch')
  })
})

// ── The client-facing confirmation label ──────────────────────────────────────

describe('paymentDeleteConfirmIdLabel', () => {
  test('names the exact Payment ID to type', () => {
    assert.equal(paymentDeleteConfirmIdLabel('P-AA-0047'), 'Type P-AA-0047 to confirm')
  })
})

// ── deletePaymentEntry — a thin client over the durable claim route ──────────

describe('deletePaymentEntry', () => {
  const payment = { id: PAYMENT_ID, human_payment_id: HUMAN_ID, status: 'approved_unlinked' }
  let originalFetch: typeof fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
    originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const { status, body } = handler(url, init)
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response
    }) as typeof fetch
  }

  test('posts exactly {paymentId, reason, confirmPaymentId} to the delete route', async () => {
    let sentBody: unknown = null
    let sentUrl = ''
    stubFetch((url, init) => {
      sentUrl = url
      sentBody = JSON.parse(String(init.body))
      return { status: 200, body: { ok: true, allocationsReleased: 2, alreadyDeleted: false } }
    })

    await deletePaymentEntry(payment, 'Duplicate entry', HUMAN_ID)

    assert.equal(sentUrl, '/api/finance/payments/delete')
    assert.deepEqual(sentBody, {
      paymentId: PAYMENT_ID,
      reason: 'Duplicate entry',
      confirmPaymentId: HUMAN_ID,
    })
  })

  test('a successful response reports success with the released count', async () => {
    stubFetch(() => ({ status: 200, body: { ok: true, allocationsReleased: 3, alreadyDeleted: false } }))
    const result = await deletePaymentEntry(payment, 'reason', HUMAN_ID)
    assert.deepEqual(result, { outcome: 'success', allocationsReleased: 3, alreadyDeleted: false })
  })

  test('a resumed (already-deleted) success is reported as such', async () => {
    stubFetch(() => ({ status: 200, body: { ok: true, allocationsReleased: 0, alreadyDeleted: true } }))
    const result = await deletePaymentEntry(payment, 'reason', HUMAN_ID)
    assert.equal(result.outcome, 'success')
    assert.ok(result.outcome === 'success' && result.alreadyDeleted === true)
  })

  test('a REASON_REQUIRED refusal is reported as a failure, not thrown', async () => {
    stubFetch(() => ({ status: 400, body: { ok: false, code: 'REASON_REQUIRED' } }))
    const result = await deletePaymentEntry(payment, '', '')
    assert.equal(result.outcome, 'failure')
    assert.ok(result.outcome === 'failure' && result.code === 'REASON_REQUIRED')
  })

  test('an ID_MISMATCH refusal is reported as a failure', async () => {
    stubFetch(() => ({ status: 400, body: { ok: false, code: 'ID_MISMATCH' } }))
    const result = await deletePaymentEntry(payment, 'reason', 'not the right id')
    assert.equal(result.outcome, 'failure')
    assert.ok(result.outcome === 'failure' && result.code === 'ID_MISMATCH')
  })

  test('an APPROVED refusal is reported as non-retryable', async () => {
    stubFetch(() => ({ status: 409, body: { ok: false, code: 'APPROVED' } }))
    const result = await deletePaymentEntry(payment, 'reason', HUMAN_ID)
    assert.equal(result.outcome, 'failure')
    assert.ok(result.outcome === 'failure' && result.retryable === false)
  })

  test('a network failure is reported as a retryable failure, never thrown', async () => {
    originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('network down') }) as typeof fetch
    const result = await deletePaymentEntry(payment, 'reason', HUMAN_ID)
    assert.equal(result.outcome, 'failure')
    assert.ok(result.outcome === 'failure' && result.retryable === true)
  })

  test('an unparseable response body falls back to a generic retryable failure', async () => {
    originalFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: false, status: 500, json: async () => { throw new Error('not json') },
    })) as unknown as typeof fetch
    const result = await deletePaymentEntry(payment, 'reason', HUMAN_ID)
    assert.equal(result.outcome, 'failure')
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
