/**
 * "Needs clarification" and "Reject" from the Payment Requests review go through
 * the decision doors (PR #172). The database half — authority, self-decision,
 * lock, stale decisions, concurrent verifiers — is proved by
 * supabase/tests/run_payment_idempotency_suite.sh. This is the screen's half.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { REVIEW_STALE_MESSAGE, sendBackOrReject } from './reviewDecision'

type Call = { fn: string; args: Record<string, unknown> }
function client(answer: { data?: unknown; error?: { message?: string; code?: string } | null }) {
  const calls: Call[] = []
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: answer.data ?? null, error: answer.error ?? null } },
    from: () => { throw new Error('no table is written from the review') },
  }
}
const REQ = 'req-1'

describe('send back for clarification', () => {
  test('a real change: the door is called with the trimmed note, and says changed', async () => {
    const c = client({ data: { changed: true, status: 'needs_clarification' } })
    assert.deepEqual(await sendBackOrReject(c, { requestId: REQ, action: 'needs_clarification', note: '  Which account?  ' }), { kind: 'changed' })
    assert.deepEqual(c.calls, [{ fn: 'request_finance_payment_clarification', args: { p_request_id: REQ, p_note: 'Which account?' } }])
  })
  test('someone decided first: stale, and nothing is claimed', async () => {
    const c = client({ data: { changed: false, status: 'rejected' } })
    assert.deepEqual(await sendBackOrReject(c, { requestId: REQ, action: 'needs_clarification', note: 'x' }), { kind: 'stale' })
  })
  test('the verifier recorded it themselves: refused, in words', async () => {
    const c = client({ error: { code: '42501', message: 'PAYMENT_SELF_DECISION_FORBIDDEN: payment PR-1 was recorded by you' } })
    const out = await sendBackOrReject(c, { requestId: REQ, action: 'needs_clarification', note: 'x' })
    assert.equal(out.kind, 'refused')
    assert.match((out as { message: string }).message, /another payment verifier must decide it/)
  })
  test('no answer: it does not guess', async () => {
    const c = client({ error: { code: '', message: 'TypeError: Failed to fetch' } })
    const out = await sendBackOrReject(c, { requestId: REQ, action: 'needs_clarification', note: 'x' })
    assert.equal(out.kind, 'refused')
    assert.match((out as { message: string }).message, /Refresh to see whether the decision was recorded/)
  })
})

describe('reject', () => {
  test('through reject_finance_payment_request', async () => {
    const c = client({ data: { status: 'rejected' } })
    assert.deepEqual(await sendBackOrReject(c, { requestId: REQ, action: 'reject', note: 'Duplicate' }), { kind: 'changed' })
    assert.deepEqual(c.calls, [{ fn: 'reject_finance_payment_request', args: { p_request_id: REQ, p_reason: 'Duplicate' } }])
  })
  test('already decided: stale', async () => {
    const c = client({ error: { code: 'P0001', message: 'Only a pending payment request can be rejected (PR-1 is needs_clarification)' } })
    assert.deepEqual(await sendBackOrReject(c, { requestId: REQ, action: 'reject', note: 'x' }), { kind: 'stale' })
  })
  test('not a verifier: refused', async () => {
    const c = client({ error: { code: '42501', message: 'Only a payment verifier may reject a payment request' } })
    const out = await sendBackOrReject(c, { requestId: REQ, action: 'reject', note: 'x' })
    assert.deepEqual(out, { kind: 'refused', message: 'Only a payment verifier can send back or reject a payment.' })
  })
})

describe('the review modal', () => {
  const page = readFileSync('src/app/finance/page.tsx', 'utf8').replace(/\r\n/g, '\n')
  const modal = page.slice(page.indexOf('function AdminReviewModal('), page.indexOf('// The decision currently selected, resolved once'))

  test('writes no table: both decisions go through sendBackOrReject', () => {
    assert.ok(modal.includes('await sendBackOrReject(supabase, { requestId: r.id, action, note: adminNote })'))
    assert.ok(!modal.includes(".from('finance_payment_requests')"), 'no direct table access in the review')
    assert.ok(!modal.includes('.update('))
  })

  test('the creator is told only after a real change', () => {
    const refused = modal.indexOf("if (outcome.kind === 'refused') { setError(outcome.message); return }")
    const stale = modal.indexOf("if (outcome.kind === 'stale') { setError(REVIEW_STALE_MESSAGE); return }")
    const notify = modal.indexOf('void notifyFinance({', stale)
    assert.ok(refused > -1 && stale > refused && notify > stale, 'both early returns come before the notification')
    assert.equal(REVIEW_STALE_MESSAGE.startsWith('This request is no longer awaiting a decision'), true)
  })
})
