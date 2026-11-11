// PIs FLAGGED BY OPERATIONS THAT WAIT ON YOU (owner, 2026-11-11): the validation of the database's answer
// (public.my_flagged_pis, 20270611000000), the words, and the rule that a failed read is never "nothing waits".
//
// Run with: npm run test:file -- src/lib/orders/flaggedPis.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REASON_CLIP,
  flaggedBrief,
  flaggedHref,
  flaggedLabel,
  flaggedTitle,
  loadFlaggedPis,
  readFlaggedPis,
  reasonLine,
} from './flaggedPis'

const row = (over: Record<string, unknown> = {}) => ({
  handoff_id: 'h-1', order_id: 'o-546', order_number: '0546', client_name: 'Qavaali', version_number: 1,
  reason: '  As per mohit...\nclient wanted a visit  ', by_name: ' Nitish Bansal ', since: '2026-11-08T09:00:00+00:00',
  waiting_seconds: 259200.5, ...over,
})

describe('reading the database answer', () => {
  test('one row becomes the screen\'s row: number as people say it, trimmed names and reason, seconds kept', () => {
    const [r] = readFlaggedPis([row()])
    assert.deepEqual(r, {
      handoffId: 'h-1', orderId: 'o-546', orderNumber: '546', clientName: 'Qavaali', versionNumber: 1,
      reason: 'As per mohit...\nclient wanted a visit', byName: 'Nitish Bansal', since: '2026-11-08T09:00:00+00:00',
      waitingSeconds: 259200.5,
    })
  })

  test('an empty list is an empty list', () => {
    assert.deepEqual(readFlaggedPis([]), [])
  })

  test('missing optional parts degrade, never invent: no flagger, no time, no number, no reason', () => {
    const [r] = readFlaggedPis([row({ by_name: null, since: null, order_number: null, reason: null, client_name: null, waiting_seconds: 'x' })])
    assert.equal(r.byName, null)
    assert.equal(r.since, null)
    assert.equal(r.orderNumber, '—')
    assert.equal(r.reason, '')
    assert.equal(r.clientName, '')
    assert.equal(r.waitingSeconds, 0)
  })

  test('a negative wait is zero; a numeric string is read', () => {
    assert.equal(readFlaggedPis([row({ waiting_seconds: -5 })])[0].waitingSeconds, 0)
    assert.equal(readFlaggedPis([row({ waiting_seconds: '86400' })])[0].waitingSeconds, 86400)
  })

  test('an answer that is not a list, or holds a row it cannot read, is unreadable as a whole', () => {
    assert.throws(() => readFlaggedPis(null))
    assert.throws(() => readFlaggedPis({}))
    assert.throws(() => readFlaggedPis([row(), null]))
    assert.throws(() => readFlaggedPis([row({ handoff_id: '' })]))
    assert.throws(() => readFlaggedPis([row({ order_id: undefined })]))
    assert.throws(() => readFlaggedPis([row({ version_number: 0 })]))
    assert.throws(() => readFlaggedPis([row({ version_number: 'one' })]))
  })
})

describe('the read itself: a failure is never "nothing waits"', () => {
  const answer = (data: unknown, error: { code?: string; message?: string } | null = null) =>
    ({ rpc: (fn: string) => { assert.equal(fn, 'my_flagged_pis'); return Promise.resolve({ data, error }) } })

  test('rows come back as rows', async () => {
    const rows = await loadFlaggedPis(answer([row()]))
    assert.equal(rows?.length, 1)
    assert.equal(rows?.[0].orderNumber, '546')
  })

  test('none waiting is an empty list', async () => {
    assert.deepEqual(await loadFlaggedPis(answer([])), [])
  })

  test('a database without the function has none (the migration is not applied yet)', async () => {
    assert.deepEqual(await loadFlaggedPis(answer(null, { code: 'PGRST202', message: 'Could not find the function public.my_flagged_pis' })), [])
    assert.deepEqual(await loadFlaggedPis(answer(null, { code: '42883', message: 'function does not exist' })), [])
  })

  test('any other failure, an unreadable answer or a thrown call is null: the screen says so', async () => {
    assert.equal(await loadFlaggedPis(answer(null, { code: '500', message: 'boom' })), null)
    assert.equal(await loadFlaggedPis(answer('not a list')), null)
    assert.equal(await loadFlaggedPis({ rpc: () => { throw new Error('network') } }), null)
    assert.equal(await loadFlaggedPis({ rpc: () => Promise.reject(new Error('network')) }), null)
  })
})

describe('the words', () => {
  test('the strip title counts', () => {
    assert.equal(flaggedTitle(1), 'Operations flagged 1 PI')
    assert.equal(flaggedTitle(3), 'Operations flagged 3 PIs')
  })

  test('the label, the brief and the place the answer is made', () => {
    assert.equal(flaggedLabel({ versionNumber: 2 }), 'Operations cannot accept PI V2')
    assert.equal(flaggedBrief({ orderNumber: '546', clientName: 'Qavaali' }), 'Order 546 · Qavaali')
    assert.equal(flaggedBrief({ orderNumber: '546', clientName: '' }), 'Order 546 · Client not recorded')
    assert.equal(flaggedHref('abc'), '/orders/abc')
  })

  test('the reason is one short line: whitespace flattened, long ones cut with an ellipsis, none said plainly', () => {
    assert.equal(reasonLine('a\n\n  b   c'), 'a b c')
    assert.equal(reasonLine('   '), 'No reason recorded')
    const long = reasonLine('word '.repeat(100))
    assert.ok(long.length <= REASON_CLIP && long.endsWith('…'))
    assert.equal(reasonLine('short'), 'short')
  })
})
