// The durable payment-deletion protocol: what the route does, and what §11 says.
//
// The defect these exist for: the payment was deleted and its proof objects
// removed afterwards, but payment_proof_attachments cascades with the payment —
// so a storage failure arrived with the trusted manifest already destroyed and
// nothing left to retry from. Nothing below may reintroduce that ordering.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PAYMENT_DELETE_RETRY_MESSAGE,
  classifyPaymentDeletionError,
  describePaymentDeletionFailure,
} from './paymentDeletionProtocol'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (src: string) => src.split('\n')
  .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
  .join('\n')

const MIGRATION = 'supabase/migrations/20261010000000_order_submission_and_finance_test_data_reset.sql'
const ROUTE     = 'src/app/api/finance/payments/delete/route.ts'

// ── The manifest exists before either system is touched ──────────────────────

describe('the manifest is written down before anything is destroyed', () => {
  const sql = read(MIGRATION)
  const section = sql.slice(
    sql.indexOf('-- ═══ 11. Deleting ONE payment that owns files'),
    sql.indexOf('-- ═══ 12. Apply-time assertions'))

  test('the claim table holds the frozen object keys', () => {
    assert.ok(section.includes('create table if not exists public.finance_payment_deletion_claims'))
    assert.ok(/storage_paths\s+text\[\]/.test(section), 'the manifest itself')
    assert.ok(/storage_removed\s+text\[\]/.test(section), 'and what storage has confirmed')
  })

  /**
   * THE WHOLE POINT, IN ONE ASSERTION. A foreign key to the payment would make
   * the claim die with it — NO ACTION would refuse the delete outright, CASCADE
   * would destroy the manifest at the exact moment it becomes the only record of
   * what the payment owned.
   */
  test('the claim carries no foreign key to the payment it describes', () => {
    const table = section.slice(
      section.indexOf('create table if not exists public.finance_payment_deletion_claims'),
      section.indexOf('create unique index if not exists finance_payment_deletion_claims_open_uidx'))
    assert.ok(!/payment_id[\s\S]{0,80}references/.test(table),
      'the claim must outlive the payment')
  })

  test('begin reads the paths from the attachment rows, never from an argument', () => {
    const begin = section.slice(
      section.indexOf('create or replace function public.begin_finance_payment_deletion'),
      section.indexOf('revoke execute on function public.begin_finance_payment_deletion'))
    assert.ok(begin.includes('from public.payment_proof_attachments a'))
    assert.ok(/begin_finance_payment_deletion\(p_payment_id uuid\)/.test(begin),
      'a payment id is the only input; a path argument would be a caller naming an object')
  })

  test('begin locks the payment before it decides anything', () => {
    const begin = section.slice(section.indexOf('create or replace function public.begin_finance_payment_deletion'))
    const lockAt   = begin.indexOf('for update')
    const statusAt = begin.indexOf('finance_payment_status_is_verified')
    const insertAt = begin.indexOf('insert into public.finance_payment_deletion_claims')
    assert.ok(lockAt > 0 && lockAt < statusAt && statusAt < insertAt,
      'lock, then judge, then freeze — so the status and the manifest are one decision')
  })

  test('the verified rule is the canonical function, not a restated list', () => {
    const begin = section.slice(
      section.indexOf('create or replace function public.begin_finance_payment_deletion'),
      section.indexOf('revoke execute on function public.begin_finance_payment_deletion'))
    assert.ok(begin.includes('public.finance_payment_status_is_verified(v_pay.status)'))
    assert.ok(!/approved_unlinked/.test(begin),
      'a second copy of the status list is how two definitions come to disagree')
  })
})

// ── The freeze ───────────────────────────────────────────────────────────────

describe('what a standing claim freezes', () => {
  const sql = read(MIGRATION)

  for (const [what, trigger, table] of [
    ['verification',       'finance_payment_requests_guard_deletion_claim',   'finance_payment_requests'],
    ['proof mutation',     'payment_proof_attachments_guard_deletion_claim',  'payment_proof_attachments'],
    ['allocation changes', 'finance_payment_allocations_guard_deletion_claim', 'finance_payment_allocations'],
  ] as const) {
    test(`${what} is refused while the claim stands`, () => {
      assert.ok(sql.includes(`create trigger ${trigger}`), `${trigger} must exist`)
      assert.ok(sql.includes(`on public.${table};`), `on ${table}`)
      const fn = sql.slice(
        sql.indexOf(`create or replace function public.${trigger}()`),
        sql.indexOf(`revoke execute on function public.${trigger}()`))
      assert.ok(fn.includes('PAYMENT_DELETION_CLAIMED'), 'and refuse by name')
      assert.ok(fn.includes("errcode = '55P03'"), 'as a lock failure, which is what it is')
    })
  }

  test('proof mutation is refused in both directions, so the manifest cannot go stale', () => {
    assert.ok(read(MIGRATION).includes(
      'before insert or update or delete on public.payment_proof_attachments'),
      'an added proof would be outside the manifest; a removed one would leave it wrong')
  })

  test('every guard binds the service role too', () => {
    const sql = read(MIGRATION)
    for (const fn of [
      'finance_payment_requests_guard_deletion_claim',
      'payment_proof_attachments_guard_deletion_claim',
      'finance_payment_allocations_guard_deletion_claim',
    ]) {
      assert.ok(sql.includes(`revoke execute on function public.${fn}()\n  from public, anon, authenticated, service_role;`),
        `${fn} must not be callable by a client role`)
    }
  })
})

// ── Finalization ─────────────────────────────────────────────────────────────

describe('nothing is deleted until every file is gone', () => {
  const sql = read(MIGRATION)
  const fin = sql.slice(
    sql.indexOf('create or replace function public.finalize_finance_payment_deletion'),
    sql.indexOf('revoke execute on function public.finalize_finance_payment_deletion'))

  test('finalization refuses while any manifest key is unconfirmed', () => {
    assert.ok(fin.includes('storage_paths <@ v_claim.storage_removed'))
    assert.ok(fin.includes('PAYMENT_DELETION_PROOF_PENDING'))
  })

  test('the storage check comes before the delete, never after', () => {
    const checkAt  = fin.indexOf('PAYMENT_DELETION_PROOF_PENDING')
    const deleteAt = fin.indexOf('delete from public.finance_payment_requests')
    assert.ok(checkAt > 0 && deleteAt > 0 && checkAt < deleteAt,
      'deleting first is the defect; the row is what the manifest hangs from')
  })

  test('authorization is re-derived on the finalize, not inherited from the claim', () => {
    assert.ok(fin.includes('public.finance_payment_deletable_by(p_payment_id, v_actor)'),
      'a resumed deletion is still a deletion')
  })

  test('a completed deletion answers success rather than an error', () => {
    assert.ok(fin.includes("if v_claim.finalized_at is not null then"))
    assert.ok(fin.includes("'already_deleted', true"))
  })

  test('the claim is marked consumed before the delete, so the cascade is not refused', () => {
    const markAt   = fin.indexOf("set finalized_at = now()")
    const deleteAt = fin.indexOf('delete from public.finance_payment_requests')
    assert.ok(markAt > 0 && markAt < deleteAt,
      'the proof guard would otherwise refuse the cascade the delete itself causes')
  })

  test('only keys the manifest already names may be reported removed', () => {
    const rec = sql.slice(
      sql.indexOf('create or replace function public.record_finance_payment_proof_removed'),
      sql.indexOf('revoke execute on function public.record_finance_payment_proof_removed'))
    assert.ok(rec.includes('PAYMENT_DELETION_PATH_UNKNOWN'))
    assert.ok(rec.includes('v_key = any (v_claim.storage_paths)'),
      'a forged key must not become a description of an object the claim never owned')
  })

  test('a release is refused once anything has actually gone', () => {
    const rel = sql.slice(
      sql.indexOf('create or replace function public.release_finance_payment_deletion'),
      sql.indexOf('revoke execute on function public.release_finance_payment_deletion'))
    assert.ok(rel.includes('cardinality(v_claim.storage_removed) > 0'))
    assert.ok(rel.includes('PAYMENT_DELETION_IN_PROGRESS'),
      'handing back a payment whose proof is half gone produces one that looks whole and is not')
  })
})

// ── The route ────────────────────────────────────────────────────────────────

describe('the route sweeps the manifest and nothing else', () => {
  const route = code(read(ROUTE))

  test('the sequence is begin, sweep, finalize', () => {
    const beginAt = route.indexOf("'begin_finance_payment_deletion'")
    const sweepAt = route.indexOf('.remove(confined)')
    const finAt   = route.indexOf("'finalize_finance_payment_deletion'")
    assert.ok(beginAt > 0 && beginAt < sweepAt && sweepAt < finAt,
      'the manifest is taken before storage is touched and the row goes last')
  })

  test('the browser cannot name a path', () => {
    assert.ok(/\{ paymentId \} = await req\.json\(\)/.test(route))
    assert.ok(!/storagePaths|paths\s*\}\s*=\s*await req\.json/.test(route),
      'the only input is a payment id')
  })

  test('every key is re-checked against its own payment prefix before removal', () => {
    assert.ok(route.includes('path.startsWith(`${paymentId}/`)'),
      'a manifest that somehow pointed elsewhere must not reach the service role')
    const guardAt  = route.indexOf('path.startsWith(`${paymentId}/`)')
    const removeAt = route.indexOf('.remove(confined)')
    assert.ok(guardAt < removeAt, 'and checked before, not after')
  })

  test('a resumed deletion sweeps only what is left', () => {
    assert.ok(route.includes('manifest.filter(path => !already.has(path))'),
      'an object storage already confirmed gone is never asked about twice')
  })

  test('confirmed removals are recorded even when the sweep then fails', () => {
    const recordAt = route.indexOf("'record_finance_payment_proof_removed'")
    const failAt   = route.indexOf("code: 'STORAGE_INCOMPLETE'")
    assert.ok(recordAt > 0 && recordAt < failAt,
      'the next attempt should have less to do, not the same amount')
  })

  test('the service key is checked before anything is frozen', () => {
    const keyAt   = route.indexOf('SUPABASE_SERVICE_ROLE_KEY')
    const beginAt = route.indexOf("'begin_finance_payment_deletion'")
    assert.ok(keyAt > 0 && keyAt < beginAt,
      'discovering it later would freeze a payment nobody can finish deleting')
  })

  test('an incomplete sweep is a 502 with the claim left standing', () => {
    assert.ok(route.includes("code: 'STORAGE_INCOMPLETE'"))
    assert.ok(!/release_finance_payment_deletion/.test(route),
      'releasing after files have gone would unfreeze a payment whose proof is incomplete')
  })

  test('nothing is reported deleted unless finalize succeeded', () => {
    const okAt  = route.indexOf('ok: true')
    const finAt = route.indexOf("'finalize_finance_payment_deletion'")
    assert.ok(finAt > 0 && finAt < okAt, 'success is claimed only after the last stage')
  })
})

// ── What the operator is told ────────────────────────────────────────────────

describe('the words, and what they promise', () => {
  test('a retryable failure says the deletion did not finish', () => {
    assert.equal(PAYMENT_DELETE_RETRY_MESSAGE, 'Payment deletion did not finish. Retry deletion.')
    for (const code of ['STORAGE_INCOMPLETE', 'PROOF_PENDING', 'CLAIM_INVALID', 'DELETE_FAILED']) {
      const failure = describePaymentDeletionFailure(code)
      assert.equal(failure.retryable, true, `${code} must invite a retry`)
      assert.ok(!/deleted\./.test(failure.message),
        `${code} must never tell the user the payment was deleted`)
    }
  })

  test('verified money is refused and is NOT retryable', () => {
    const failure = describePaymentDeletionFailure('APPROVED')
    assert.equal(failure.retryable, false, 'retrying will not make bank history deletable')
    assert.match(failure.message, /permanent bank payment history/)
  })

  test('the approved marker is classified before anything else', () => {
    assert.equal(
      classifyPaymentDeletionError({ message: 'PAYMENT_APPROVED_PERMANENT: payment PR-1 …' }),
      'APPROVED')
  })

  test('each database marker maps to its own code', () => {
    const cases: [string, string][] = [
      ['PAYMENT_DELETION_NOT_AUTHENTICATED', 'UNAUTHORIZED'],
      ['PAYMENT_DELETION_DENIED',            'FORBIDDEN'],
      ['PAYMENT_DELETION_NOT_FOUND',         'NOT_FOUND'],
      ['PAYMENT_DELETION_PROOF_PENDING',     'PROOF_PENDING'],
      ['PAYMENT_DELETION_IN_PROGRESS',       'IN_PROGRESS'],
      ['PAYMENT_DELETION_CLAIM_INVALID',     'CLAIM_INVALID'],
    ]
    for (const [marker, expected] of cases) {
      assert.equal(classifyPaymentDeletionError({ message: `${marker}: …` }), expected)
    }
  })

  test('an unrecognised error is retryable rather than silently final', () => {
    assert.equal(classifyPaymentDeletionError({ message: 'something else' }), 'DELETE_FAILED')
    assert.equal(describePaymentDeletionFailure('nonsense').retryable, true)
  })

  test('the modal offers Retry deletion on a retryable failure', () => {
    const modal = code(read('src/components/finance/DeletePaymentModal.tsx'))
    assert.ok(modal.includes('failure?.retryable === true ? PAYMENT_DELETE_RETRY_LABEL'))
    assert.ok(modal.includes('|| (failure !== null && !failure.retryable)'),
      'a retryable failure must not settle the dialog')
  })

  test('the modal reports success only when the route said ok', () => {
    const modal = code(read('src/components/finance/DeletePaymentModal.tsx'))
    assert.ok(modal.includes("if (body?.ok === true)"))
    const okAt = modal.indexOf("if (body?.ok === true)")
    const deletedAt = modal.indexOf("onDeleted()", okAt)
    assert.ok(deletedAt > okAt && deletedAt - okAt < 200,
      'the deleted callback belongs inside the success branch and nowhere else')
  })
})
