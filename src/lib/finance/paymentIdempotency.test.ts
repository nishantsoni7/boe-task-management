/**
 * Payment idempotency, from the browser's side (20261219000000, PR #172).
 *
 * The SERVER is the protection — run_payment_idempotency_suite.sh proves it
 * against a real database, with two real sessions. These tests prove the other
 * half: that each press carries the key it should, so the server's guarantee
 * actually reaches the person pressing the button. They run the helper against a
 * fake server that behaves as the migration does: a result is stored per
 * (actor, key), a matching retry returns it, a changed payload is refused.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PENDING_SUBMISSION_TTL_MS,
  SubmissionAttempt,
  isAmbiguousFailure,
  isKeyReused,
  payloadFingerprint,
  type KeyStorage,
} from './submissionAttempt'
import { recordPiPayment, piPaymentErrorMessage, type PiPaymentFormState } from './piPaymentView'
import { paymentEntryErrorMessage } from './paymentEntry'
import { splitPaymentErrorMessage } from './splitPaymentEntry'

class MemoryStorage implements KeyStorage {
  map = new Map<string, string>()
  getItem(k: string) { return this.map.get(k) ?? null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
}

/** The server, as 20261219000000 behaves. */
class FakeServer {
  payments: { id: string; payload: string }[] = []
  keys = new Map<string, { fp: string; result: { payment_request_id: string } }>()
  /** When set, the next call COMMITS and then its answer is lost. */
  loseNextAnswer = false
  call(payload: Record<string, unknown>) {
    const { p_idempotency_key: key, ...rest } = payload
    const fp = JSON.stringify(rest)
    if (typeof key === 'string') {
      const seen = this.keys.get(key)
      if (seen) {
        if (seen.fp !== fp) {
          return { data: null, error: { code: 'P0001', message: 'PAYMENT_IDEMPOTENCY_KEY_REUSED: this submission was already recorded with different details.' } }
        }
        return { data: seen.result, error: null }
      }
    }
    const id = `pay-${this.payments.length + 1}`
    this.payments.push({ id, payload: fp })
    const result = { payment_request_id: id }
    if (typeof key === 'string') this.keys.set(key, { fp, result })
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false
      return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }
    }
    return { data: result, error: null }
  }
}

let n = 0
const newKey = () => `key-${++n}`

/** One press of a payment form, as the three forms now do it. */
function press(server: FakeServer, attempt: SubmissionAttempt, payload: Record<string, unknown>) {
  const res = server.call({ ...payload, p_idempotency_key: attempt.begin(payload) })
  if (res.error) attempt.settleUnlessAmbiguous(res.error)
  else attempt.settle()
  return res
}

const PAY = { p_amount: 1000000, p_payment_date: '2026-09-19', p_payment_mode: 'hdfc', p_reference: 'UTR-1' }

describe('each press carries the key it should', () => {
  test('a lost response, then the retry: ONE payment, and the retry gets it', () => {
    const server = new FakeServer()
    const attempt = new SubmissionAttempt('t1', new MemoryStorage(), newKey)
    server.loseNextAnswer = true
    const first = press(server, attempt, PAY)
    assert.ok(first.error && isAmbiguousFailure(first.error), 'the first answer was lost')
    const retry = press(server, attempt, PAY)
    assert.equal(retry.data?.payment_request_id, 'pay-1')
    assert.equal(server.payments.length, 1)
  })

  test('a refresh after a lost response: the same details in the same tab reuse the key', () => {
    const server = new FakeServer()
    const storage = new MemoryStorage()
    server.loseNextAnswer = true
    press(server, new SubmissionAttempt('t2', storage, newKey), PAY)
    // The page reloads: a NEW form instance, the same tab's sessionStorage.
    const retry = press(server, new SubmissionAttempt('t2', storage, newKey), PAY)
    assert.equal(retry.data?.payment_request_id, 'pay-1')
    assert.equal(server.payments.length, 1)
  })

  test('changing the details after an unanswered press is REFUSED, not recorded twice', () => {
    const server = new FakeServer()
    const attempt = new SubmissionAttempt('t3', new MemoryStorage(), newKey)
    server.loseNextAnswer = true
    press(server, attempt, PAY)
    const changed = press(server, attempt, { ...PAY, p_amount: 900000 })
    assert.ok(changed.error && isKeyReused(changed.error.message))
    assert.equal(server.payments.length, 1)
    // The refusal is an answer: the NEXT press is a new submission.
    const next = press(server, attempt, { ...PAY, p_amount: 900000 })
    assert.equal(next.data?.payment_request_id, 'pay-2')
  })

  test('two genuine payments with the same details: two keys, two payments', () => {
    const server = new FakeServer()
    const attempt = new SubmissionAttempt('t4', new MemoryStorage(), newKey)
    assert.equal(press(server, attempt, PAY).data?.payment_request_id, 'pay-1')
    assert.equal(press(server, attempt, PAY).data?.payment_request_id, 'pay-2')
    assert.equal(server.payments.length, 2)
  })

  test('a refusal the database gave settles the attempt: a corrected press is new', () => {
    const attempt = new SubmissionAttempt('t5', new MemoryStorage(), newKey)
    const k1 = attempt.begin(PAY)
    attempt.settleUnlessAmbiguous({ code: 'P0001', message: 'PAYMENT_AMOUNT_INVALID' })
    assert.notEqual(attempt.begin(PAY), k1)
  })

  test('a pending key is offered back after a refresh only for the same details, and only for a while', () => {
    const storage = new MemoryStorage()
    let clock = 1_000
    const a = new SubmissionAttempt('t6', storage, newKey, () => clock)
    const k = a.begin(PAY)
    assert.equal(new SubmissionAttempt('t6', storage, newKey, () => clock).begin(PAY), k)
    assert.notEqual(new SubmissionAttempt('t6', storage, newKey, () => clock).begin({ ...PAY, p_reference: 'UTR-2' }), k)
    clock += PENDING_SUBMISSION_TTL_MS
    // (the previous line wrote a NEW pending entry; restore the original to test expiry)
    storage.setItem('boe.pendingPaymentSubmission.t6', JSON.stringify({ key: k, fingerprint: payloadFingerprint(PAY), at: 1_000 }))
    assert.notEqual(new SubmissionAttempt('t6', storage, newKey, () => clock).begin(PAY), k, 'expired')
  })

  test('the pending entry holds a key, a hash and a time — no amount, name or note', () => {
    const storage = new MemoryStorage()
    new SubmissionAttempt('t7', storage, newKey).begin({ ...PAY, p_remarks: 'Kalyan Interiors, cash at site' })
    const stored = [...storage.map.values()].join('')
    assert.ok(!stored.includes('1000000') && !stored.includes('Kalyan') && !stored.includes('UTR-1'))
    assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ['at', 'fingerprint', 'key'])
  })

  test('storage that throws (private mode) still gives a working in-memory attempt', () => {
    const broken: KeyStorage = {
      getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') },
    }
    const attempt = new SubmissionAttempt('t8', broken, newKey)
    const k = attempt.begin(PAY)
    assert.equal(attempt.begin(PAY), k)
    attempt.settle()
    assert.notEqual(attempt.begin(PAY), k)
  })

  test('the fingerprint ignores key order and undefined fields', () => {
    assert.equal(payloadFingerprint({ a: 1, b: [1, { c: 2, d: 3 }] }), payloadFingerprint({ b: [1, { d: 3, c: 2 }], a: 1, e: undefined }))
    assert.notEqual(payloadFingerprint({ a: 1 }), payloadFingerprint({ a: 2 }))
  })

  test('only an answer with no database code is ambiguous', () => {
    assert.equal(isAmbiguousFailure({ message: 'TypeError: Failed to fetch', code: '' } as never), true)
    assert.equal(isAmbiguousFailure({ message: '<html>504</html>' } as never), true)
    assert.equal(isAmbiguousFailure(null), true)
    assert.equal(isAmbiguousFailure({ code: 'P0001' }), false)
    assert.equal(isAmbiguousFailure({ code: '42501' }), false)
    assert.equal(isAmbiguousFailure({ code: 'PGRST202' }), false)
  })
})

describe('the PI payment door carries the key and reports an unknown outcome', () => {
  const FORM: PiPaymentFormState = { amount: '250000.50', paymentDate: '2026-09-19', paymentMode: 'hdfc', reference: '', remarks: '' } as PiPaymentFormState

  test('the key is sent with the payload', async () => {
    let sent: Record<string, unknown> = {}
    const client = { rpc: async (_fn: string, args: Record<string, unknown>) => { sent = args; return { data: { payment_request_id: 'p1' }, error: null } } }
    const res = await recordPiPayment(client, 'sub-1', FORM, 'key-x')
    assert.deepEqual(res, { ok: true, paymentRequestId: 'p1' })
    assert.equal(sent.p_idempotency_key, 'key-x')
    assert.equal(sent.p_submission_id, 'sub-1')
    assert.equal(sent.p_amount, 250000.5)
  })

  test('no key → no key parameter (the deployed body is called exactly as before)', async () => {
    let sent: Record<string, unknown> = {}
    const client = { rpc: async (_fn: string, args: Record<string, unknown>) => { sent = args; return { data: {}, error: null } } }
    await recordPiPayment(client, 'sub-1', FORM)
    assert.ok(!('p_idempotency_key' in sent))
  })

  test('a lost answer is ambiguous; a database refusal is not', async () => {
    const lost = { rpc: async () => ({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }) }
    const refused = { rpc: async () => ({ data: null, error: { message: 'PAYMENT_AMOUNT_INVALID: …', code: 'P0001' } }) }
    const a = await recordPiPayment(lost, 's', FORM, 'k')
    const b = await recordPiPayment(refused, 's', FORM, 'k')
    assert.ok(!a.ok && a.ambiguous && /will not be recorded twice/.test(a.message))
    assert.ok(!b.ok && !b.ambiguous && b.message === 'Enter a positive amount in rupees and paise.')
  })
})

describe('the key-reused refusal reads as a sentence on every form', () => {
  const RAW = 'PAYMENT_IDEMPOTENCY_KEY_REUSED: this submission was already recorded with different details.'
  test('all three mappers', () => {
    for (const msg of [piPaymentErrorMessage(RAW), paymentEntryErrorMessage(RAW), splitPaymentErrorMessage(RAW)]) {
      assert.match(msg, /already recorded with different details/)
      assert.ok(!msg.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED'), 'no code reaches a person')
    }
  })
})

describe('every payment form sends a key', () => {
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
  test('Record Payment, Payment Request and the PI payment', () => {
    const split = read('src/app/finance/received/RecordSplitPaymentModal.tsx')
    assert.ok(split.includes("new SubmissionAttempt('record-payment')"))
    assert.ok(split.includes('p_idempotency_key: attempt.begin(args),'))
    const request = read('src/app/finance/page.tsx')
    assert.ok(request.includes("new SubmissionAttempt('payment-request')"))
    assert.ok(request.includes('p_idempotency_key: attempt.begin(args),'))
    const pi = read('src/app/orders/drafts/[submissionId]/page.tsx')
    assert.ok(pi.includes('new SubmissionAttempt(`pi-payment:${submissionId}`)'))
    assert.ok(pi.includes('await recordPiPayment(supabase, submissionId, form, key)'))
  })

  test('a proof failure keeps the key, so the retry replays the payment and never records it again', () => {
    const request = read('src/app/finance/page.tsx')
    const failed = request.slice(request.indexOf('const proofErr = await persistProof'), request.indexOf('attempt.settle()\n    setSaving(false)'))
    assert.ok(failed.length > 0 && !failed.includes('attempt.settle()'))
    const pi = read('src/app/orders/drafts/[submissionId]/page.tsx')
    const piFailed = pi.slice(pi.indexOf('if (proofError) {', pi.indexOf('const recordPayment = useCallback')), pi.indexOf('attempt.settle()\n      setPaymentNotice'))
    assert.ok(piFailed.includes('return PI_PAYMENT_PROOF_RETRY') && !piFailed.includes('attempt.settle()'))
  })
})

// The database suite (supabase/tests/payment_idempotency_assertions.sql §7)
// proves the behaviour; this keeps the ORDER from drifting in the file itself.
describe('every payment wrapper authorizes before its NULL-key branch', () => {
  const sql = readFileSync(
    'supabase/migrations/20261219000000_order_submission_unsaved_drafts_and_payment_idempotency.sql', 'utf8',
  ).replace(/\r\n/g, '\n')
  for (const door of ['submit_payment_request', 'record_payment_with_allocations', 'record_pi_submission_payment']) {
    test(door, () => {
      const start = sql.indexOf(`create function public.${door}(`)
      const body = sql.slice(start, sql.indexOf('\n$$;', start))
      const firstStatement = body.slice(body.indexOf('\nbegin\n') + '\nbegin\n'.length)
        .split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('--'))
      assert.ok(start >= 0 && firstStatement?.startsWith('perform public.assert_finance_payment_door('), `${door}: first statement is ${firstStatement}`)
      const door_ = body.indexOf('perform public.assert_finance_payment_door(')
      assert.ok(door_ < body.indexOf('if p_idempotency_key is null then'))
      assert.ok(door_ < body.indexOf('finance_payment_submission_key_claim('))
      assert.equal(body.split('assert_finance_payment_door(').length - 1, 1, `${door}: exactly one door check`)
    })
  }
})
