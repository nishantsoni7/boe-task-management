/**
 * Which Finance notifications get written, and how many queries deciding that
 * costs.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The dedup check was issued once per recipient, then changed to ask those
 * together with Promise.all. That made the route WAIT once instead of N times
 * and was reported as a call reduction, which was wrong: Promise.all still
 * sends N queries. The batching is real now — one read for every recipient —
 * and the decision it feeds is a pure function, tested here directly rather
 * than through a mocked HTTP route.
 *
 * The route-shape assertions at the bottom are what keep the two in step: a
 * future edit that reintroduces a per-row query fails them.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/finance/notificationDedup.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  recipientIds,
  selectFreshNotifications,
  type ExistingNotification,
} from './notificationDedup'

const ROUTE = 'src/app/api/finance/notify/route.ts'
const route = readFileSync(join(process.cwd(), ROUTE), 'utf8')

/** A candidate row, in the shape the route builds. */
const row = (user_id: string, entity_id: string | null, title = 'Payment request PAY-1 requires review.') =>
  ({ user_id, entity_id, title })

const existing = (user_id: string, entity_id: string | null, title = 'Payment request PAY-1 requires review.'): ExistingNotification =>
  ({ user_id, entity_id, title })

const READABLE = { readable: true }

// ══ 1. The recipient set the single read is filtered by ══════════════════════

describe('the batched read asks about exactly the people being written to', () => {
  test('zero recipients', () => {
    assert.deepEqual(recipientIds([]), [])
    assert.deepEqual(selectFreshNotifications([], [], READABLE), [])
  })

  test('one recipient', () => {
    assert.deepEqual(recipientIds([row('u1', 'e1')]), ['u1'])
  })

  test('multiple recipients', () => {
    assert.deepEqual(recipientIds([row('u1', 'e1'), row('u2', 'e1'), row('u3', 'e1')]),
      ['u1', 'u2', 'u3'])
  })

  test('a repeated recipient is asked about once', () => {
    // The filter is an `in (...)`; naming somebody twice would widen nothing and
    // is what a Set is for.
    assert.deepEqual(recipientIds([row('u1', 'e1'), row('u1', 'e1'), row('u2', 'e1')]),
      ['u1', 'u2'])
  })
})

// ══ 2. Nothing already notified is notified again ════════════════════════════

describe('an existing notification in the window suppresses its row', () => {
  test('nothing exists — every row is written', () => {
    const rows = [row('u1', 'e1'), row('u2', 'e1')]
    assert.deepEqual(selectFreshNotifications(rows, [], READABLE), rows)
  })

  test('SOME recipients already notified — only the missing ones are written', () => {
    const rows = [row('u1', 'e1'), row('u2', 'e1'), row('u3', 'e1')]
    const fresh = selectFreshNotifications(rows, [existing('u2', 'e1')], READABLE)
    assert.deepEqual(fresh.map(r => r.user_id), ['u1', 'u3'],
      'the one already notified is dropped, the other two survive')
  })

  test('ALL recipients already notified — nothing is written', () => {
    const rows = [row('u1', 'e1'), row('u2', 'e1')]
    const fresh = selectFreshNotifications(rows, [existing('u1', 'e1'), existing('u2', 'e1')], READABLE)
    assert.deepEqual(fresh, [])
  })

  test('the surviving rows keep their original order and their full shape', () => {
    // The route inserts exactly what this returns, so the objects must come
    // back untouched — not rebuilt from the fields dedup happens to read.
    const rows = [
      { user_id: 'u1', entity_id: 'e1', title: 'A', task_id: null, type: 'finance_submitted', body: 'x', is_push_sent: true },
      { user_id: 'u2', entity_id: 'e1', title: 'A', task_id: null, type: 'finance_submitted', body: 'x', is_push_sent: true },
    ]
    const fresh = selectFreshNotifications(rows, [existing('u1', 'e1', 'A')], READABLE)
    assert.equal(fresh.length, 1)
    assert.deepEqual(fresh[0], rows[1], 'the row is passed through, not reconstructed')
  })
})

// ══ 3. Dedup is per recipient — no cross-user leakage ════════════════════════

describe('one person having been notified never suppresses another', () => {
  test('a match on a DIFFERENT user does not suppress this one', () => {
    // THE FAILURE THIS RULES OUT: a key built without the user id would let one
    // admin's notification silence every other admin's, so a submit would reach
    // exactly one person.
    const rows = [row('u1', 'e1'), row('u2', 'e1'), row('u3', 'e1')]
    const fresh = selectFreshNotifications(rows, [existing('u9', 'e1')], READABLE)
    assert.deepEqual(fresh.map(r => r.user_id), ['u1', 'u2', 'u3'],
      'a stranger’s notification suppresses nobody')
  })

  test('the same entity for two people is two separate notifications', () => {
    const rows = [row('u1', 'e1'), row('u2', 'e1')]
    const fresh = selectFreshNotifications(rows, [existing('u1', 'e1')], READABLE)
    assert.deepEqual(fresh.map(r => r.user_id), ['u2'])
  })
})

// ══ 4. Duplicate rows inside one batch ═══════════════════════════════════════

describe('a recipient named twice in one request is written once', () => {
  test('two identical rows collapse', () => {
    // THE FAILURE THIS RULES OUT: both rows find nothing in the database — the
    // notification does not exist yet — so both would be written, producing
    // exactly the double notification the window exists to prevent.
    const rows = [row('u1', 'e1'), row('u1', 'e1')]
    const fresh = selectFreshNotifications(rows, [], READABLE)
    assert.equal(fresh.length, 1, 'the second occurrence is caught by the first')
  })

  test('and still collapses when nothing can be read', () => {
    const rows = [row('u1', 'e1'), row('u1', 'e1')]
    assert.equal(selectFreshNotifications(rows, [], { readable: false }).length, 1,
      'in-batch duplicates are decided in memory, not by the read')
  })

  test('two DIFFERENT rows for one person both survive', () => {
    // Same person, different records: two distinct facts, two notifications.
    const rows = [row('u1', 'e1'), row('u1', 'e2')]
    assert.equal(selectFreshNotifications(rows, [], READABLE).length, 2)
  })
})

// ══ 5. The title fallback, for rows with no entity_id ════════════════════════

describe('a row without an entity_id is identified by its title', () => {
  test('a matching title suppresses it', () => {
    const rows = [row('u1', null, 'Payment request PAY-7 was rejected.')]
    const fresh = selectFreshNotifications(rows,
      [existing('u1', null, 'Payment request PAY-7 was rejected.')], READABLE)
    assert.deepEqual(fresh, [])
  })

  test('a different title does not', () => {
    const rows = [row('u1', null, 'Payment request PAY-7 was rejected.')]
    const fresh = selectFreshNotifications(rows,
      [existing('u1', null, 'Payment request PAY-8 was rejected.')], READABLE)
    assert.equal(fresh.length, 1)
  })

  test('a stored row WITH an entity_id still suppresses a titleless candidate', () => {
    // The stored notification is indexed under both forms, so the candidate's
    // own identity decides the comparison and a retry that lost its entity_id
    // is still recognised as the same notification.
    const rows = [row('u1', null, 'Payment request PAY-7 was rejected.')]
    const fresh = selectFreshNotifications(rows,
      [existing('u1', 'e5', 'Payment request PAY-7 was rejected.')], READABLE)
    assert.deepEqual(fresh, [], 'matched on title, which is what this candidate carries')
  })
})

// ══ 6. A failed read sends rather than silently dropping ═════════════════════

describe('when the dedup read fails', () => {
  test('every row is treated as fresh', () => {
    // A read that failed tells us nothing about what exists. A missing
    // notification is worse than a duplicate one, and this is the direction the
    // per-row code already took when its query errored and left `dup` undefined.
    const rows = [row('u1', 'e1'), row('u2', 'e1')]
    assert.deepEqual(selectFreshNotifications(rows, [], { readable: false }), rows)
  })

  test('even rows that genuinely WERE already notified are re-sent', () => {
    // Deliberate: `existing` is not trustworthy when the read failed, so it is
    // ignored entirely rather than half-applied.
    const rows = [row('u1', 'e1')]
    assert.deepEqual(
      selectFreshNotifications(rows, [existing('u1', 'e1')], { readable: false }),
      rows)
  })

  test('the route logs the failure and continues rather than returning 500', () => {
    assert.ok(route.includes('readable: !dedupError'),
      'the failure is passed to the decision, not swallowed')
    assert.ok(route.includes('dedup read failed, sending anyway'),
      'and it is recorded')
    const at = route.indexOf('dedupError')
    assert.ok(!/return NextResponse\.json\([^)]*status: 500/.test(route.slice(at, at + 400)),
      'a dedup read failure must not fail the whole notification')
  })
})

// ══ 7. The route issues ONE dedup query, and one insert ══════════════════════

describe('the route’s query shape', () => {
  test('exactly one read of notifications decides the whole batch', () => {
    const reads = (route.match(/\.from\('notifications'\)\s*\n?\s*\.select\(/g) ?? []).length
    assert.equal(reads, 1, 'one batched read, never one per recipient')
  })

  test('it is narrowed by type, by the window, and by the recipients', () => {
    assert.ok(route.includes(".eq('type', event)"), 'the type is constant across a request')
    assert.ok(route.includes(".gte('created_at', windowStart)"), 'the idempotency window')
    assert.ok(route.includes(".in('user_id', recipientIds(rows))"),
      'and only the people actually being written to')
  })

  test('no per-row query remains', () => {
    assert.ok(!/rows\.map\([\s\S]{0,300}?\.from\('notifications'\)/.test(route),
      'a notifications read may not sit inside a row loop')
    assert.ok(!route.includes('Promise.all(rows.map('),
      'concurrency is not batching — the N queries themselves are what was removed')
    assert.ok(!/for \(const row of rows\)[\s\S]{0,200}?await/.test(route),
      'and no sequential per-row await either')
  })

  test('the insert is still one batched write of only the missing rows', () => {
    assert.ok(route.includes("supabase.from('notifications').insert(fresh)"),
      'one insert, of exactly what the decision returned')
    const inserts = (route.match(/\.from\('notifications'\)\s*\.insert\(/g) ?? []).length
    assert.equal(inserts, 1)
  })

  test('an insert failure is still reported as a 500', () => {
    // Unchanged: failing to WRITE is a real failure, unlike failing to read the
    // window.
    assert.ok(route.includes('[finance/notify] insert failed:'))
    assert.ok(/insert failed[\s\S]{0,200}?status: 500/.test(route))
  })
})

// ══ 8. Authorization and recipient rules are untouched ═══════════════════════

describe('who may call this, and who gets written to', () => {
  test('an unauthenticated caller is refused before anything is read', () => {
    assert.ok(route.includes("await authClient.auth.getUser()"),
      'the caller is identified from their own session')
    assert.ok(route.includes("return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })"))
    const authAt = route.indexOf("status: 401")
    const readAt = route.indexOf(".from('notifications')")
    assert.ok(authAt < readAt, 'the refusal comes before any notification work')
  })

  test('the actor is never notified about their own action', () => {
    assert.ok(route.includes('if (!userId || userId === user.id) return'),
      'the push helper still drops the actor')
  })

  test('admin recipients are still resolved by role, excluding deleted users', () => {
    assert.ok(route.includes(".from('users').select('id').eq('role', 'admin')"))
    assert.ok(route.includes("'is_deleted.eq.false,is_deleted.is.null'"))
  })

  test('an unknown event is refused', () => {
    assert.ok(route.includes("{ error: 'Unknown event' }"))
  })

  test('the notification payload is unchanged', () => {
    // Same columns, same values. This change is about how many queries decide
    // what to write, never about what is written.
    assert.ok(route.includes('rows.push({ user_id: userId, task_id: null, entity_id: entityId ?? null, type: event, title, body, is_push_sent: true })'))
  })

  test('the service-role client is used for the write, the caller’s for identity', () => {
    // The privileged client must never be what decides WHO is asking.
    assert.ok(route.includes('const authClient = await createClient()'))
    assert.ok(route.includes('process.env.SUPABASE_SERVICE_ROLE_KEY!'))
    const identity = route.slice(0, route.indexOf('createServerClient('))
    assert.ok(identity.includes('authClient.auth.getUser()'),
      'identity is established before the service-role client exists')
  })
})
