/**
 * The outbox: Save returns at once and the entry is carried to the database
 * behind the form. These tests pin what must never go wrong on the way — no
 * entry lost, no second lead from a retry, nothing shown to the wrong person.
 *
 * Run: npx tsx --test src/lib/exhibitionLeads/outbox.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_AUTO_RETRIES, afterAnswer, afterError, byEntryOrder, isUnsent, loadOutbox, newEntry, nextToSend,
  resend, retryDelayMs, storeOutbox, type OutboxEntry,
} from './outbox'
import { emptyLeadForm, toCreateArgs } from './validation'

const values = () => ({
  ...emptyLeadForm(), contactName: ' Anita Rao ', mobile: '98765 43210', clientType: 'property_owner' as const,
  requirements: ['hotel' as const], leadType: 'hot' as const,
})
const entry = (id = 'id-1', now = 1000) => newEntry({ id, exhibitionId: 'ex-1', values: values(), args: toCreateArgs(values()), now })

describe('a new entry', () => {
  test('is waiting to be sent, with the trimmed name and the exact arguments', () => {
    const e = entry()
    assert.equal(e.status, 'saving')
    assert.equal(e.name, 'Anita Rao')
    assert.equal(e.attempts, 0)
    assert.equal(e.args.p_phone, '+919876543210')
  })
})

describe('what the server answers', () => {
  test('created and replayed both mean saved (a replay is a retry that already landed)', () => {
    assert.equal(afterAnswer(entry(), { outcome: 'created' }).status, 'saved')
    assert.equal(afterAnswer(entry(), { outcome: 'replayed' }).status, 'saved')
  })
  test('a duplicate of my own lead keeps the id so it can be opened', () => {
    const e = afterAnswer(entry(), { outcome: 'duplicate', mine: true, lead_id: 'lead-9' })
    assert.equal(e.status, 'duplicate_mine')
    assert.equal(e.leadId, 'lead-9')
  })
  test('a duplicate of someone else\'s lead carries no id and no name', () => {
    const e = afterAnswer(entry(), { outcome: 'duplicate', mine: false })
    assert.equal(e.status, 'duplicate_other')
    assert.equal(e.leadId, undefined)
    assert.doesNotMatch(e.message ?? '', /Rao|98765/)
  })
})

describe('what goes wrong', () => {
  test('a lost connection is retried by itself, with the same id', () => {
    const e = afterError(entry(), { kind: 'uncertain', message: 'x' })
    assert.equal(e.status, 'retry')
    assert.equal(e.id, 'id-1', 'the idempotency key never changes between tries')
    assert.equal(resend(e).status, 'saving')
    assert.equal(resend(e).id, 'id-1')
  })
  test('after too many tries it stops and asks, without losing the entry', () => {
    let e = entry()
    for (let i = 0; i < MAX_AUTO_RETRIES; i++) e = resend(afterError(e, { kind: 'unknown', message: 'x' }))
    assert.equal(e.status, 'saving')
    e = afterError(e, { kind: 'unknown', message: 'x' })
    assert.equal(e.status, 'failed')
    assert.match(e.message ?? '', /nothing is lost/i)
    assert.equal(resend(e).status, 'saving', 'Retry works from failed')
  })
  test('an expired session waits for the person, and is still owed to the database', () => {
    const e = afterError(entry(), { kind: 'auth', message: 'expired' })
    assert.equal(e.status, 'auth')
    assert.ok(isUnsent(e))
  })
  test('a refusal is not retried: it needs a person', () => {
    for (const kind of ['invalid', 'forbidden', 'conflict'] as const) {
      assert.equal(afterError(entry(), { kind, message: 'no' }).status, 'failed', kind)
    }
  })
  test('the unique-number race is a duplicate, not a failure', () => {
    assert.equal(afterError(entry(), { kind: 'duplicate_phone', message: 'dup' }).status, 'duplicate_other')
  })
  test('the wait between tries grows, then stops growing', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelayMs), [2000, 4000, 8000, 15000, 15000, 15000])
  })
  test('resend only touches entries that are waiting for it', () => {
    const saved = afterAnswer(entry(), { outcome: 'created' })
    assert.equal(resend(saved).status, 'saved')
    const dup = afterAnswer(entry(), { outcome: 'duplicate', mine: false })
    assert.equal(resend(dup).status, 'duplicate_other')
  })
})

describe('the order of sending', () => {
  test('the oldest waiting entry goes first; nothing waiting means nothing to send', () => {
    const a = entry('a', 1)
    const b = entry('b', 2)
    const c = afterAnswer(entry('c', 0), { outcome: 'created' })
    assert.equal(nextToSend([b, c, a])?.id, 'a')
    assert.equal(nextToSend([c]), null)
    assert.deepEqual(byEntryOrder([b, c, a]).map(e => e.id), ['c', 'a', 'b'])
  })
  test('an entry waiting to retry is not sent until its timer says so', () => {
    const waiting = afterError(entry('a', 1), { kind: 'uncertain', message: 'x' })
    assert.equal(nextToSend([waiting, entry('b', 2)])?.id, 'b')
  })
})

describe('keeping what is owed across a reload', () => {
  const mem = new Map<string, string>()
  beforeEach(() => {
    mem.clear()
    ;(globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v) },
        removeItem: (k: string) => { mem.delete(k) },
      },
    }
  })

  test('what is unconfirmed comes back and is sent again from the start', () => {
    storeOutbox('u1', [afterError(entry('a'), { kind: 'uncertain', message: 'x' }), afterAnswer(entry('b'), { outcome: 'created' })])
    const back = loadOutbox('u1')
    assert.deepEqual(back.map(e => e.id), ['a'], 'saved entries are not kept')
    assert.equal(back[0].status, 'saving')
    assert.equal(back[0].attempts, 0)
    assert.equal(back[0].id, 'a')
  })
  test('entries that need a person stay as they were', () => {
    storeOutbox('u1', [afterAnswer(entry('d'), { outcome: 'duplicate', mine: true, lead_id: 'L' })])
    const back = loadOutbox('u1')
    assert.equal(back[0].status, 'duplicate_mine')
    assert.equal(back[0].leadId, 'L')
  })
  test('another person on the same device never sees them', () => {
    storeOutbox('u1', [entry('a')])
    assert.deepEqual(loadOutbox('u2'), [])
  })
  test('everything confirmed means nothing is stored at all', () => {
    storeOutbox('u1', [entry('a')])
    storeOutbox('u1', [afterAnswer(entry('a'), { outcome: 'created' })])
    assert.equal(mem.size, 0)
  })
  test('damaged storage is ignored, and unavailable storage does not throw', () => {
    mem.set('exhibition-leads:outbox:v1', '{not json')
    assert.deepEqual(loadOutbox('u1'), [])
    ;(globalThis as unknown as { window: unknown }).window = { localStorage: { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } } }
    assert.deepEqual(loadOutbox('u1'), [])
    assert.doesNotThrow(() => storeOutbox('u1', [entry('a')]))
  })
})

describe('unsent covers exactly what is still owed to the database', () => {
  test('saving, retry and auth; nothing else', () => {
    const statuses: OutboxEntry['status'][] = ['saving', 'retry', 'auth', 'saved', 'duplicate_mine', 'duplicate_other', 'failed']
    assert.deepEqual(statuses.filter(s => isUnsent({ ...entry(), status: s })), ['saving', 'retry', 'auth'])
  })
})
