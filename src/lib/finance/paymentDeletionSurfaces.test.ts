// Where the Delete Payment action appears, and where it must never appear.
//
// The action is one implementation reached from more than one list, so these
// assertions are about WIRING rather than logic: that each surface renders the
// SAME shared modal rather than growing its own copy, that the fetch to the
// durable-claim route lives in exactly one place (deletePaymentEntry,
// paymentDeletion.ts), and that the PI blocker no longer tells a reader to do
// something the product may not let them do.
//
// REVISED FOR 20261011000000. Deletion is admin-only, for a payment of ANY
// status — Payment Requests AND Confirmed Payments alike, both routed through
// the exact same <DeletePaymentModal>. Payment Requests used to keep its own
// bespoke DeleteConfirmModal calling the route directly with `{paymentId}`
// only; that shape no longer exists server-side (begin_finance_payment_
// deletion now requires a reason and the typed Payment ID), so the bespoke
// copy is gone in favour of the one shared implementation.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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
const CLIENT   = 'src/lib/finance/paymentDeletion.ts'

// ── One route, one client, two surfaces that both render the shared modal ────

const ROUTE_PATH = '/api/finance/payments/delete'

describe('there is one deletion route, reached through one client, from one shared modal', () => {
  /**
   * THE FETCH APPEARS ONCE. deletePaymentEntry (paymentDeletion.ts) is the
   * only place that calls the durable-claim route; every surface reaches
   * deletion by rendering <DeletePaymentModal>, never by fetching the route
   * itself. Two copies of a destructive fetch drift, and the copy nobody is
   * looking at is the one that drifts.
   */
  test('only paymentDeletion.ts fetches the delete route — no surface duplicates the call', () => {
    const client = code(read(CLIENT))
    assert.ok(client.includes(`fetch('${ROUTE_PATH}'`), 'the one real client calls the claim-backed route')

    for (const file of [RECEIVED, REQUESTS, MODAL]) {
      const src = code(read(file))
      assert.ok(!src.includes(`fetch('${ROUTE_PATH}'`),
        `${file} must not fetch the delete route itself — it renders DeletePaymentModal, which calls deletePaymentEntry`)
    }

    // The compensation path is unrelated to this feature: the Payment Requests
    // submit flow rolls back a row it created moments earlier when the proof
    // upload fails, by id only. It is not a second way to delete a payment.
    const requests = code(read(REQUESTS))
    const at = requests.indexOf("from('finance_payment_requests')\n        .delete({ count: 'exact' })")
    assert.ok(at > 0, 'the compensation delete is still present')
    assert.ok(requests.slice(at, at + 200).includes(".eq('id', created.id)"),
      'it deletes only the row this same submit just created')
  })

  test('deletePaymentEntry sends exactly {paymentId, reason, confirmPaymentId} — nothing that could name a storage path', () => {
    const client = code(read(CLIENT))
    assert.ok(/body: JSON\.stringify\(\{ paymentId: payment\.id, reason, confirmPaymentId \}\)/.test(client))
  })

  test('both Payment Requests and Received Payments mount the SAME shared modal, and neither redefines it', () => {
    for (const file of [RECEIVED, REQUESTS]) {
      const src = code(read(file))
      assert.ok(src.includes('<DeletePaymentModal'), `${file} must mount the shared modal`)
      assert.ok(src.includes("from '@/components/finance/DeletePaymentModal'"), `${file} must import the shared one`)
      assert.ok(!/function DeletePaymentModal/.test(src), `${file} must not redefine it`)
    }
  })

  test('the route itself accepts a reason and the typed Payment ID, and passes both straight to begin_finance_payment_deletion', () => {
    const route = code(read('src/app/api/finance/payments/delete/route.ts'))
    assert.ok(/\{ paymentId, reason, confirmPaymentId \} = await req\.json\(\)/.test(route))
    assert.ok(route.includes('p_reason: reason'))
    assert.ok(route.includes('p_confirm_payment_id: confirmPaymentId'))
  })

  test('zero-proof deletion begins a claim exactly like proof-backed deletion — same route, same call', () => {
    // The route itself decides what a payment owns by reading
    // payment_proof_attachments inside begin_finance_payment_deletion; the
    // client never branches on a count, so there is nothing here that could
    // take a different, unsafe path for an apparently zero-proof payment.
    for (const file of [MODAL, REQUESTS, CLIENT]) {
      const src = code(read(file))
      assert.ok(!/proofCount|proof_count/.test(src),
        `${file} must not read or branch on an attachment count before calling the route`)
    }
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

  test('Payment Requests gates Delete on canDeletePayment too, separately from canManage (Edit/Reapply)', () => {
    const src = code(read(REQUESTS))
    assert.ok(src.includes('canDeletePayment(r, { isAdmin'),
      'the same shared predicate, admin-only')
    // The rule this replaced: canManageRequest also granted the submitter of
    // their own unapproved request. That branch must not survive as the gate
    // for Delete anywhere in this file.
    assert.ok(!/showDelete\s*=\s*canManage\b/.test(src),
      'Delete must no longer be governed by the self-or-admin manage rule')
    assert.ok(!/const canDelete = canManage\b/.test(src))
  })

  /**
   * BOTH SURFACES, IN WHATEVER FORM EACH USES. The table draws its actions as
   * an overflow menu and the cards draw a button — so this asserts the
   * PROPERTY (every wiring of onDelete is guarded by canDeleteRow, and there
   * are two of them: the table and the cards) rather than the markup of the
   * day.
   */
  test('both the table and the cards offer it on Received Payments, and neither offers it unguarded', () => {
    const src = code(read(RECEIVED))
    // The table row's Delete is a direct <IconAction> now, not a menu entry —
    // `onSelect={() => onDelete(r)}` rather than `onSelect: () => onDelete(r)`.
    // The card keeps its labelled inline button.
    const wirings = [...src.matchAll(/onSelect=\{\(\) => onDelete\(r\)\}|onDelete\(r\) \}/g)]
      .map(m => m.index ?? -1)
    assert.ok(wirings.length >= 2, 'at least one wiring for the table row and one for the card')
    for (const at of wirings) {
      const preceding = src.slice(Math.max(0, at - 260), at)
      assert.match(preceding, /canDeleteRow\(r\)/,
        'every Delete wiring must be guarded by the shared predicate')
    }
  })

  test('Received Payments really does load statuses that are deletable, across every allocation filter', () => {
    const src = read('src/lib/finance/paymentSurfaces.ts')
    const block = src.slice(src.indexOf('CONFIRMED_PAYMENT_STATUSES = ['))
    const statuses = [...block.slice(0, block.indexOf(']')).matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.ok(statuses.includes('approved_unlinked'))
    assert.ok(statuses.includes('approved_linked'))
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

// ── Payments to Verify reuses the shared action ───────────────────────────────

describe('a surface reached only through the shared list component offers no second copy', () => {
  const TO_VERIFY = 'src/app/finance/payments-to-verify/page.tsx'

  test('Payments to Verify reuses the shared action, through ReceivedPaymentsView', () => {
    if (!existsSync(join(ROOT, TO_VERIFY))) return
    const src = code(read(TO_VERIFY))
    assert.ok(src.includes('ReceivedPaymentsView'),
      'it must reach the action through the shared list component, not a copy')
    assert.ok(!/from\('finance_payment_requests'\)[\s\S]{0,120}\.delete\(/.test(src),
      'and must never issue its own delete')
  })

  test('no surface decides deletability for itself with a second status test', () => {
    // canDeletePayment is the only gate any surface uses. What is checked here
    // is that no surface has invented a SECOND gate that could disagree with
    // it. Naming a verified status elsewhere is fine and expected — Received
    // Payments draws status badges and linkage controls from them — so the
    // assertion is scoped to the delete wiring itself.
    const src = code(read(RECEIVED))
    const deleteWiring = src.slice(src.indexOf('const canDeleteRow ='), src.indexOf('const canDeleteRow =') + 300)
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
    for (const file of [RECEIVED, REQUESTS, MODAL, CLIENT]) {
      assert.ok(!read(file).includes("'proof-orphaned'"),
        `${file} still knows about an outcome that reported a storage leak as a result`)
    }
  })

  test('the modal only reports a deletion once deletePaymentEntry confirms success, never on a retryable failure', () => {
    const src = code(read(MODAL))
    const okAt = src.indexOf("if (result.outcome === 'success')")
    assert.ok(okAt > 0, 'success is read from deletePaymentEntry\'s result, never assumed')
    const deletedAt = src.indexOf('onDeleted()', okAt)
    assert.ok(deletedAt > okAt && deletedAt - okAt < 200,
      'the deleted callback belongs inside the success branch and nowhere else')
  })

  test('deletePaymentEntry itself settles success only from the route\'s ok:true', () => {
    const client = code(read(CLIENT))
    const okAt = client.indexOf('if (body?.ok === true)')
    assert.ok(okAt > 0)
    const outcomeAt = client.indexOf("outcome: 'success'", okAt)
    assert.ok(outcomeAt > okAt && outcomeAt - okAt < 200)
  })
})
