// Where the Delete Payment action appears, and where it must never appear.
//
// The action is one implementation reached from more than one list, so these
// assertions are about WIRING rather than logic: that each surface calls the
// shared module instead of growing its own copy, that the surface which holds
// only confirmed money offers nothing, and that the PI blocker no longer tells a
// reader to do something the product may not let them do.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PAYMENT_DELETE_UNAVAILABLE_MESSAGE } from '@/lib/finance/paymentDeletion'
import {
  PAYMENT_BLOCKER_HREF,
  describeDeletionBlockers,
  describeDeletionFailure,
} from '@/lib/orders/submissionDeletion'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (src: string) => src.split('\n')
  .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('{/*'))
  .join('\n')

const RECEIVED = 'src/app/finance/received/ReceivedPaymentsView.tsx'
const REQUESTS = 'src/app/finance/page.tsx'
const MODAL    = 'src/components/finance/DeletePaymentModal.tsx'
const SHARED   = 'src/lib/finance/paymentDeletion.ts'

// ── One implementation ───────────────────────────────────────────────────────

describe('there is one deletion implementation, and every surface calls it', () => {
  /**
   * THE SEQUENCE APPEARS ONCE. Two copies of a destructive sequence drift, and
   * the copy that drifts is the one nobody is looking at. So the DELETE against
   * finance_payment_requests is allowed in exactly one file.
   */
  test('only the shared module owns the delete-a-payment sequence, and it now issues no call at all', () => {
    // THE SEQUENCE, NOT THE STATEMENT. One other DELETE against this table is
    // legitimate and stays: the Payment Requests submit path rolls back a row it
    // created moments earlier when the proof upload fails. It deletes by id
    // only, reads no attachments and touches no storage, so it is a compensation
    // for its own half-finished write rather than a second way to delete
    // somebody's payment.
    for (const file of [RECEIVED, MODAL]) {
      const src = code(read(file))
      assert.ok(!/from\('finance_payment_requests'\)[\s\S]{0,120}\.delete\(/.test(src),
        `${file} must not own a delete-a-payment sequence of its own`)
      assert.ok(!/from\('payment_proof_attachments'\)[\s\S]{0,120}\.select\(/.test(src),
        `${file} must not read the attachment table itself`)
    }

    // THE SHARED MODULE ITSELF NOW MAKES NO CALL EITHER. The count-then-delete
    // sequence it used to own is exactly the race this branch was corrected to
    // close, and closing it safely needs the durable claim protocol — not
    // available here without a migration this branch must not add. So neither
    // half of the old sequence survives in it.
    const shared = code(read(SHARED))
    assert.ok(!/from\('finance_payment_requests'\)[\s\S]{0,120}\.delete\(/.test(shared),
      'the shared module must issue no DELETE, now that deletion is refused unconditionally')
    assert.ok(!shared.includes("from('payment_proof_attachments')"),
      'and no read of the attachment table, since nothing distinguishes a proof-backed payment any more')

    // The compensation path is unrelated to this feature and is still exactly
    // that — by id, nothing else.
    const requests = code(read(REQUESTS))
    const at = requests.indexOf("from('finance_payment_requests')\n        .delete({ count: 'exact' })")
    assert.ok(at > 0, 'the compensation delete is still present')
    assert.ok(requests.slice(at, at + 200).includes(".eq('id', created.id)"),
      'it deletes only the row this same submit just created')
  })

  test('the Payment Requests page calls the shared function rather than its old body', () => {
    const src = code(read(REQUESTS))
    assert.ok(src.includes('deletePaymentEntry(supabase, r, friendlyDbErrorMessage)'),
      'the page that used to own the sequence must now call it')
    assert.ok(!src.includes("from('payment_proof_attachments')\n      .select('storage_path')"),
      'its copy of the proof read must be gone')
  })

  test('Received Payments calls the shared modal, not a local one', () => {
    const src = code(read(RECEIVED))
    assert.ok(src.includes('<DeletePaymentModal'), 'the shared modal is mounted')
    assert.ok(src.includes("from '@/components/finance/DeletePaymentModal'"))
    assert.ok(!/function DeletePaymentModal/.test(src), 'and not redefined here')
  })

  test('the modal itself owns no sequence — it calls the module', () => {
    const src = code(read(MODAL))
    assert.ok(src.includes('deletePaymentEntry('), 'the modal delegates')
    assert.ok(!src.includes('payment_proof_attachments'), 'and knows nothing about the tables')
  })
})

// ── Where the control is offered ─────────────────────────────────────────────

describe('the control appears where a deletable payment is, and nowhere else', () => {
  test('Received Payments gates the control on canDeletePayment, not on finance.manage', () => {
    const src = code(read(RECEIVED))
    assert.ok(src.includes('canDeletePayment(r, { isAdmin:'),
      'the shared predicate decides, so the control and the database agree')
    assert.ok(!/canManage &&[\s\S]{0,200}onDelete\(r\)/.test(src),
      'delete authority is not the finance.manage correction authority')
  })

  /**
   * BOTH SURFACES, IN WHATEVER FORM EACH USES. The table draws its actions as a
   * row of buttons on one branch and as an overflow menu on the other, and the
   * cards draw a button either way — so this asserts the PROPERTY (every wiring
   * of onDelete is guarded by canDeleteRow, and there are two of them: the table
   * and the cards) rather than the markup of the day. A test written against one
   * branch's syntax would fail on the other for no reason a reader could act on.
   */
  test('both the table and the cards offer it, and neither offers it unguarded', () => {
    const src = code(read(RECEIVED))
    const wirings = [...src.matchAll(/onDelete\(r\)/g)].map(m => m.index ?? -1)
    assert.equal(wirings.length, 2, 'one wiring for the table row and one for the card')
    for (const at of wirings) {
      const preceding = src.slice(Math.max(0, at - 260), at)
      assert.match(preceding, /canDeleteRow\(r\)/,
        'every Delete wiring must be guarded by the shared predicate')
    }
  })

  test('the stale comment claiming this page never deletes is gone', () => {
    assert.ok(!read(RECEIVED).includes('No Delete. A row on this page is a Received Payment'),
      'that comment was the defect, written down: the page also loads unapproved payments')
  })

  /**
   * THE PAGE IS NOT ONLY CONFIRMED MONEY. This is the root cause in one
   * assertion: Received Payments loads two unapproved statuses, so a payment
   * that can be deleted really does appear on it.
   */
  test('Received Payments really does load statuses that are deletable', () => {
    const src = read('src/lib/finance/paymentClassification.ts')
    const block = src.slice(src.indexOf('CLASSIFIED_PAYMENT_STATUSES = ['))
    const statuses = [...block.slice(0, block.indexOf(']')).matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.ok(statuses.includes('pending_approval'))
    assert.ok(statuses.includes('needs_clarification'))
  })
})

// ── The blocker copy ─────────────────────────────────────────────────────────

describe('the PI blocker names who can clear it, and promises nothing else', () => {
  const one = describeDeletionBlockers([{ kind: 'payment_allocation', count: 1 }])
  const two = describeDeletionBlockers([{ kind: 'payment_allocation', count: 2 }])

  test('it no longer instructs the reader to go and delete the payment', () => {
    for (const sentence of [one, two]) {
      assert.ok(!/^.*Delete (that|those) payment entr(y|ies) in Finance first/.test(sentence),
        'the old wording addressed a reader who may have no way to carry it out')
    }
  })

  test('it names who can, and when', () => {
    for (const sentence of [one, two]) {
      assert.match(sentence, /administrator/)
      assert.match(sentence, /unapproved/)
      assert.match(sentence, /person who raised/)
    }
  })

  test('the count still reads naturally in both forms', () => {
    assert.match(one, /^A payment is allocated to this PI\./)
    assert.match(two, /^2 payments are allocated to this PI\./)
  })

  test('it still discloses no amount, reference or client', () => {
    assert.ok(!/₹|\bPR-|client/i.test(two))
  })

  test('a payment blocker carries its kind, so a surface can offer the Finance route', () => {
    const failure = describeDeletionFailure('BLOCKED', [{ kind: 'payment_allocation', count: 2 }])
    assert.deepEqual(failure.blockerKinds, ['payment_allocation'])
    assert.equal(failure.blocked, true)
  })

  test('a Confirmed Order blocker carries no payment route', () => {
    const failure = describeDeletionFailure('BLOCKED', [{ kind: 'confirmed_order', count: 1 }])
    assert.deepEqual(failure.blockerKinds, ['confirmed_order'])
  })

  test('the route is the list, never a named payment', () => {
    assert.equal(PAYMENT_BLOCKER_HREF, '/finance/received')
    assert.ok(!PAYMENT_BLOCKER_HREF.includes('?payment='),
      'naming a payment would tell a browser about a row its RLS may forbid')
  })

  test('the dialog offers that route only for a payment blocker', () => {
    const src = code(read('src/components/orders/piReviewModals.tsx'))
    assert.ok(src.includes("failure?.blockerKinds?.includes('payment_allocation')"))
    assert.ok(src.includes('PAYMENT_BLOCKER_HREF'))
  })
})

// ── Confirmed Payments, on the branch that has it ────────────────────────────

describe('a surface that holds only confirmed money offers no ordinary Delete', () => {
  const TO_VERIFY = 'src/app/finance/payments-to-verify/page.tsx'

  test('Payments to Verify, where it exists, reuses the shared action', () => {
    if (!existsSync(join(ROOT, TO_VERIFY))) return // PR #50: the page arrives with the Order/Finance branch
    const src = code(read(TO_VERIFY))
    assert.ok(src.includes('DeletePaymentModal') || src.includes('ReceivedPaymentsView'),
      'it must reach the action through the shared component, not a copy')
    assert.ok(!/from\('finance_payment_requests'\)[\s\S]{0,120}\.delete\(/.test(src),
      'and must never issue its own delete')
  })

  test('no surface decides deletability for itself', () => {
    // canDeletePayment is the only gate any surface uses, and it refuses both
    // verified statuses outright — asserted in paymentDeletion.test.ts. What is
    // checked here is that no surface has invented a SECOND gate that could
    // disagree with it. Naming a verified status elsewhere is fine and expected
    // — Received Payments draws status badges and linkage controls from them —
    // so the assertion is scoped to the delete wiring itself.
    const src = code(read(RECEIVED))
    const deleteWiring = src.slice(src.indexOf('const canDeleteRow ='), src.indexOf('const canDeleteRow =') + 400)
    assert.ok(deleteWiring.includes('canDeletePayment('),
      'the shared predicate is what the page asks')
    assert.ok(!/approved_unlinked|approved_linked|status ===/.test(deleteWiring),
      'and it must not second-guess it with a status test of its own')

    const modal = code(read(MODAL))
    assert.ok(!/approved_unlinked|approved_linked/.test(modal),
      'the modal must name no status at all; it renders a question and reports an answer')
  })
})

// ── The outcome that was not an outcome ──────────────────────────────────────

describe('an orphaned proof is not something any surface can report as settled', () => {
  test('no surface names the retired partial-success outcome', () => {
    for (const file of [RECEIVED, REQUESTS, MODAL, SHARED]) {
      assert.ok(!read(file).includes("'proof-orphaned'"),
        `${file} still knows about an outcome that reported a storage leak as a result`)
    }
  })

  test('the modal draws the refusal as a notice, not a failure', () => {
    const src = code(read(MODAL))
    assert.ok(src.includes("result?.outcome === 'unavailable'"),
      'nothing was touched, so it is not an error the operator made')
  })

  test('the Payment Requests page settles on the refusal without ever claiming a deletion', () => {
    const src = code(read(REQUESTS))
    const fn = src.slice(src.indexOf('const handleDelete = async'), src.indexOf('return (', src.indexOf('const handleDelete = async')))
    assert.ok(fn.includes('deletePaymentEntry('), 'it calls the shared, now-unconditional refusal')
    assert.ok(!fn.includes('onDeleted()'),
      'a refusal must never call the deleted callback — nothing this build does is ever a deletion')
  })

  test('the refusal wording says plainly that nothing was removed', () => {
    assert.match(PAYMENT_DELETE_UNAVAILABLE_MESSAGE, /No data was removed\./)
    assert.match(PAYMENT_DELETE_UNAVAILABLE_MESSAGE, /next version/)
  })
})
