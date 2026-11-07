/**
 * A PENDING REQUEST BESIDE THE PAYMENT ALREADY CONFIRMED (20270608000000).
 *
 * The screenshot case, end to end: Sales sent a request for ₹13,38,565.00 that the owner had
 * already recorded as a Suspense payment, verified and linked to the credit. These tests pin what
 * is drawn (the comparison, whether Merge is offered, the sentences) and what is read. The rules
 * that matter for money are the database's: supabase/tests/payment_request_merge_pglite.mjs.
 *
 * Run: npm run test:file -- src/lib/finance/paymentDuplicates.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  compareSides, destinationText, loadDuplicates, mergeBlocker, mergeEffects, mergeRefusal, rankCandidates, readMergeResult,
  sameDestination, type DuplicateRequestInput, type DuplicateSide,
} from './paymentDuplicates'
import type { PaymentDestination } from './paymentDestination'

const dest = (over: Partial<PaymentDestination> = {}): PaymentDestination => ({
  paymentId: 'x', source: 'allocation', kind: 'old_order', orderCount: 0, submissionCount: 0, customerCount: 1,
  orderId: null, orderNumber: null, submissionId: null, reference: 'OLD-478', ...over,
})
const CREDIT = { lineId: 'L1', statementNo: 143, lineDate: '2026-11-05' }

const request = (over: Partial<DuplicateSide> = {}): DuplicateSide => ({
  id: 'R1', humanId: 'P-AA-0093', status: 'pending_approval', amount: 1338565, paymentDate: '2026-11-05', paymentMode: 'hdfc',
  clientName: 'Northbliss', reference: null, addedByName: 'Mohit Sharma', addedAt: '2026-11-07T10:30:00Z', credits: [],
  destination: dest({ source: 'intent' }), proofFiles: 1, ...over,
})
const existing = (over: Partial<DuplicateSide> = {}): DuplicateSide => ({
  id: 'E1', humanId: 'P-AA-0089', status: 'approved_unlinked', amount: 1338565, paymentDate: '2026-11-05', paymentMode: 'hdfc',
  clientName: null, reference: 'SBIN226309390349', addedByName: 'Nishant Soni', addedAt: '2026-11-06T09:00:00Z', credits: [CREDIT],
  destination: dest({ kind: 'suspense', source: 'none', reference: null }), proofFiles: 0, ...over,
})
const byKey = (rows: ReturnType<typeof compareSides>) => Object.fromEntries(rows.map(r => [r.key, r]))

describe('the comparison', () => {
  test('the screenshot case, fact by fact', () => {
    const r = byKey(compareSides(request(), existing(), CREDIT))
    assert.equal(r.amount.tone, 'same')
    assert.equal(r.date.tone, 'same')
    assert.equal(r.account.tone, 'same')
    assert.equal(r.credit.verdict, 'Same credit')
    assert.match(r.credit.request.sub ?? '', /already used/)
    assert.equal(r.credit.request.text, 'BS-00143')
    assert.equal(r.utr.verdict, 'Request left it blank')
    assert.equal(r.client.tone, 'differs')
    assert.equal(r.client.existing.text, 'Not identified')
    assert.equal(r.for.verdict, 'Merge applies it')
    assert.equal(r.for.request.text, 'Old order OLD-478')
    assert.equal(r.proof.verdict, 'Merge moves it')
    assert.equal(r.added.verdict, 'Different people')
  })

  test('a different amount says by how much', () => {
    const r = byKey(compareSides(request(), existing({ amount: 1338000 }), CREDIT))
    assert.equal(r.amount.tone, 'differs')
    assert.equal(r.amount.verdict, 'Differs by ₹565.00')
  })

  test('different dates and accounts are said, not hidden', () => {
    const r = byKey(compareSides(request(), existing({ paymentDate: '2026-11-03', paymentMode: 'hdfc_sec' }), null))
    assert.equal(r.date.verdict, '2 days apart')
    assert.equal(r.account.verdict, 'Different account')
  })

  test('the credit line when the request has no link and no credit of its own', () => {
    assert.equal(byKey(compareSides(request(), existing({ credits: [] }), null)).credit.verdict, 'Neither is linked')
    assert.equal(byKey(compareSides(request(), existing(), null)).credit.verdict, 'Request not linked')
    const own = byKey(compareSides(request({ credits: [{ lineId: 'L9', statementNo: 150, lineDate: '2026-11-04' }] }), existing(), null))
    assert.equal(own.credit.verdict, 'Different credits'); assert.equal(own.credit.tone, 'differs')
  })

  test('the same UTR is the same, and one that differs is said', () => {
    assert.equal(byKey(compareSides(request({ reference: 'sbin 226309390349' }), existing(), null)).utr.tone, 'same')
    assert.equal(byKey(compareSides(request({ reference: 'HDFC999' }), existing(), null)).utr.tone, 'differs')
  })

  test('where both ask for the same place, nothing is added', () => {
    const same = existing({ destination: dest() })
    assert.equal(byKey(compareSides(request(), same, CREDIT)).for.tone, 'same')
    assert.equal(byKey(compareSides(request(), existing({ destination: dest({ reference: 'OLD-9' }) }), CREDIT)).for.verdict, 'Different place')
  })
})

describe('destinations', () => {
  test('a PI, an Order and an old order are the same only when they are the same record', () => {
    assert.equal(sameDestination(dest({ kind: 'pi_draft', submissionId: 'S1' }), dest({ kind: 'pi_draft', submissionId: 'S1' })), true)
    assert.equal(sameDestination(dest({ kind: 'pi_draft', submissionId: 'S1' }), dest({ kind: 'pi_draft', submissionId: 'S2' })), false)
    assert.equal(sameDestination(dest({ kind: 'confirmed_order', orderId: 'O1' }), dest({ kind: 'confirmed_order', orderId: 'O1' })), true)
    assert.equal(sameDestination(dest({ reference: 'old-478' }), dest({ reference: 'OLD 478' })), true)
    assert.equal(sameDestination(dest({ kind: 'mixed' }), dest({ kind: 'mixed' })), false)
    assert.equal(sameDestination(dest(), null), false)
  })

  test('Suspense is for nothing', () => {
    assert.equal(destinationText(dest({ kind: 'suspense', reference: null })), null)
    assert.equal(destinationText(null), null)
  })
})

describe('whether Merge is offered', () => {
  test('the screenshot pair may be merged', () => {
    assert.equal(mergeBlocker(request(), existing()), null)
  })

  test('only into a verified payment', () => {
    const b = mergeBlocker(request(), existing({ status: 'pending_approval' }))
    assert.equal(b?.code, 'not_verified')
    assert.match(b?.text ?? '', /Verify one of the two/)
  })

  test('only in the same account', () => {
    assert.equal(mergeBlocker(request(), existing({ paymentMode: 'hdfc_sec' }))?.code, 'account')
  })

  test('only for the exact same amount, to the paisa', () => {
    const b = mergeBlocker(request(), existing({ amount: 1338565.01 }))
    assert.equal(b?.code, 'amount')
    assert.match(b?.text ?? '', /differ by ₹0\.01/)
  })

  test('not into a payment already allocated somewhere else', () => {
    const b = mergeBlocker(request(), existing({ destination: dest({ kind: 'confirmed_order', orderId: 'O534', reference: '0534' }) }))
    assert.equal(b?.code, 'elsewhere')
    assert.match(b?.text ?? '', /already allocated to Confirmed Order 0534\. Sales asked for Old order OLD-478/)
  })

  test('allocated to the same place, or nothing asked: merge is fine', () => {
    assert.equal(mergeBlocker(request(), existing({ destination: dest() })), null)
    assert.equal(mergeBlocker(request({ destination: null }), existing({ destination: dest({ kind: 'confirmed_order', orderId: 'O1', reference: '0534' }) })), null)
  })
})

describe('ranking', () => {
  test('a payment a merge could use comes first, then the nearest date', () => {
    const near = existing({ id: 'N', status: 'pending_approval', paymentDate: '2026-11-05' })
    const usable = existing({ id: 'U', paymentDate: '2026-10-20' })
    const usableCloser = existing({ id: 'C', paymentDate: '2026-11-01' })
    assert.deepEqual(rankCandidates(request(), [near, usable, usableCloser]).map(c => c.id), ['C', 'U', 'N'])
  })
})

describe('what a merge will do, in words', () => {
  test('every effect that applies to the screenshot pair', () => {
    const t = mergeEffects(request(), existing())
    assert.equal(t.length, 6)
    assert.match(t[0], /P-AA-0089 stays as it is: verified, ₹13,38,565\.00, linked to BS-00143\./)
    assert.match(t.join('\n'), /It is applied to Old order OLD-478, as Sales asked\./)
    assert.match(t.join('\n'), /proof file on the request moves to P-AA-0089/)
    assert.match(t.join('\n'), /P-AA-0093 is closed as merged\. It is not rejected\./)
    assert.match(t.join('\n'), /Mohit Sharma is told it was already recorded\. They do not need to do anything\./)
    assert.match(t.join('\n'), /records who sent the request, who merged it, and why/)
  })

  test('effects that do not apply are not promised', () => {
    const t = mergeEffects(request({ proofFiles: 0, destination: null }), existing({ destination: dest() })).join('\n')
    assert.doesNotMatch(t, /applied to/)
    assert.doesNotMatch(t, /proof file/)
  })
})

describe('the database\'s refusals, in words', () => {
  test('each known code has its own sentence, and an unknown one says nothing changed', () => {
    assert.match(mergeRefusal('PAYMENT_SELF_DECISION_FORBIDDEN: payment x'), /another payment verifier/)
    assert.match(mergeRefusal('BANK_FORBIDDEN: finance.reconcile is required'), /access to Bank Statements/)
    assert.match(mergeRefusal('MERGE_REQUEST_NOT_PENDING: x'), /decided this request first/)
    assert.match(mergeRefusal('MERGE_AMOUNT_DIFFERS: x'), /amounts differ/)
    assert.match(mergeRefusal('MERGE_ALLOCATED_ELSEWHERE: x'), /already allocated somewhere other/)
    assert.match(mergeRefusal('ALLOCATION_TARGET_CONVERTED: x'), /can no longer take this money/)
    assert.match(mergeRefusal('something else'), /Nothing was changed/)
    assert.match(mergeRefusal(undefined), /Nothing was changed/)
  })

  test('the answer is read into the page\'s own words', () => {
    const r = readMergeResult({
      merged_request_id: 'R1', request_number: 'PAY-REQ-1', request_human_id: 'P-AA-0093', submitted_by: 'U1', client_name: 'Northbliss',
      into_payment_id: 'E1', into_human_id: 'P-AA-0089', into_request_number: 'PAY-REQ-0', allocations_applied: 1, order_id: null,
      proof_files_moved: 1, bank_links_released: 0,
    })
    assert.equal(r.intoHumanId, 'P-AA-0089'); assert.equal(r.submittedBy, 'U1'); assert.equal(r.allocationsApplied, 1); assert.equal(r.orderId, null)
    assert.equal(readMergeResult(null).intoPaymentId, '')
  })
})

// ── Reading them ────────────────────────────────────────────────────────────

type Calls = [string, unknown[]][]
type Answer = { data?: unknown; error?: unknown }
function fakeDb(tables: Record<string, Answer | ((calls: Calls) => Answer)>) {
  const log: { table: string; calls: Calls }[] = []
  const from = (table: string) => {
    const entry = { table, calls: [] as Calls }
    log.push(entry)
    const proxy: unknown = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') {
          const a = tables[table]
          const answer = typeof a === 'function' ? a(entry.calls) : a ?? {}
          return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: answer.data ?? [], error: answer.error ?? null }).then(ok, bad)
        }
        return (...args: unknown[]) => { entry.calls.push([prop, args]); return proxy }
      },
    })
    return proxy
  }
  return { client: { from } as unknown as SupabaseClient, log }
}

const input: DuplicateRequestInput = {
  id: 'R1', humanId: 'P-AA-0093', status: 'pending_approval', amount: 1338565, paymentDate: '2026-11-05', paymentMode: 'hdfc',
  clientName: 'Northbliss', reference: null, addedByName: 'Mohit Sharma', addedAt: '2026-11-07T10:30:00Z',
}
const payRow = (over: Record<string, unknown> = {}) => ({
  id: 'E1', human_payment_id: 'P-AA-0089', client_name: null, status: 'approved_unlinked', amount: 1338565, payment_date: '2026-11-05',
  payment_mode: 'hdfc', proof_note: 'SBIN226309390349', created_at: '2026-11-06T09:00:00Z', submitted_by_user: { full_name: 'Nishant Soni' }, ...over,
})
const suspense = (id: string) => ({
  payment_request_id: id, destination_source: 'none', destination_kind: 'suspense', destination_order_count: 0,
  destination_submission_count: 0, destination_customer_count: 0, destination_order_id: null, destination_order_number: null,
  destination_submission_id: null, destination_reference: null,
})

describe('finding the earlier payment', () => {
  test('by its details, with its credit, files and destination read alongside', async () => {
    const db = fakeDb({
      finance_payment_requests: { data: [payRow()] },
      bank_line_payment_links: { data: [{ payment_id: 'E1', line_id: 'L1', bank_statement_lines: { line_date: '2026-11-05', statement_no: 143 } }] },
      payment_proof_attachments: { data: [{ payment_request_id: 'R1' }] },
      finance_payment_destinations: { data: [suspense('R1'), suspense('E1')] },
      finance_payment_allocations: { data: [] },
      finance_payment_allocation_intents: { data: [{ payment_request_id: 'R1', legacy_order_no: 'OLD-478' }] },
    })
    const found = await loadDuplicates(db.client, input, [])
    assert.equal(found.candidates.length, 1)
    const c = found.candidates[0]
    assert.equal(c.humanId, 'P-AA-0089'); assert.equal(c.addedByName, 'Nishant Soni'); assert.equal(c.reference, 'SBIN226309390349')
    assert.deepEqual(c.credits, [{ lineId: 'L1', statementNo: 143, lineDate: '2026-11-05' }])
    assert.equal(found.request.proofFiles, 1)
    assert.equal(found.request.destination?.kind, 'old_order'); assert.equal(found.request.destination?.reference, 'OLD-478')
    assert.equal(mergeBlocker(found.request, c), null)

    const first = db.log.find(l => l.table === 'finance_payment_requests')!.calls
    const has = (name: string, ...args: unknown[]) => first.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args))
    assert.ok(has('eq', 'payment_mode', 'hdfc'), 'same account')
    assert.ok(has('eq', 'amount', 1338565), 'the exact amount')
    assert.ok(has('in', 'status', ['approved_unlinked', 'approved_linked']), 'only verified payments')
    assert.ok(has('gte', 'payment_date', '2026-10-15') && has('lte', 'payment_date', '2026-11-26'), '21 days either side')
    assert.ok(has('neq', 'id', 'R1'), 'never itself')
    assert.ok(has('is', 'deleted_at', null), 'never a deleted one')
  })

  test('a payment holding the credit is shown even when it is not the same amount', async () => {
    const db = fakeDb({
      finance_payment_requests: calls => (calls.some(([n, a]) => n === 'in' && a[0] === 'id') ? { data: [payRow({ id: 'H1', amount: 1338000, human_payment_id: 'P-AA-0050' })] } : { data: [] }),
      finance_payment_destinations: { data: [suspense('R1'), suspense('H1')] },
    })
    const found = await loadDuplicates(db.client, input, ['H1', 'H1', 'R1'])
    assert.deepEqual(found.candidates.map(c => c.humanId), ['P-AA-0050'])
    assert.equal(mergeBlocker(found.request, found.candidates[0])?.code, 'amount')
  })

  test('nothing like it: nothing else is read', async () => {
    const db = fakeDb({ finance_payment_requests: { data: [] } })
    const found = await loadDuplicates(db.client, input, [])
    assert.deepEqual(found.candidates, [])
    assert.deepEqual(db.log.map(l => l.table), ['finance_payment_requests'])
  })

  test('a failed read throws, so the window shows no half-comparison', async () => {
    const db = fakeDb({ finance_payment_requests: { error: { message: 'boom' } } })
    await assert.rejects(() => loadDuplicates(db.client, input, []), /could not be read/)
  })
})
