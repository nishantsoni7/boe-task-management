/**
 * A status notice is derived from, and validated against, the durable event it announces.
 *
 * What this proves: for a status event the action, the recipient and the type come from the event and the stored task — a
 * request that disagrees is refused rather than overridden; nobody can announce somebody else's event, another task's event,
 * or an event another writer announces; a RECOVERY send cannot proceed without a matching event; and nothing here ever
 * labels the event as confirmation of the specific request that sent it.
 *
 * Run:
 *   node node_modules/tsx/dist/cli.mjs --test src/lib/notifications/statusEventNotice.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadActivityEvent } from '@/lib/notifications/activityLink'
import { ALLOWED_STATUS_ACTIONS, ANNOUNCED_ELSEWHERE, STATUS_NOTICE_TYPE, deriveNoticeFromEvent, type ActivityEvent } from '@/lib/notifications/statusEventNotice'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const ROUTE = read('src/app/api/notify-status-update/route.ts')

const ASSIGNEE = 'u-assignee', CREATOR = 'u-creator', OUTSIDER = 'u-outsider'
const TASK = { id: 't-1', created_by: CREATOR, assigned_to: ASSIGNEE }
const EVENT: ActivityEvent = { id: 'evt-1', task_id: 't-1', actor_id: ASSIGNEE, action: 'status_changed', from_status: 'working', to_status: 'waiting' }

describe('what an event licenses', () => {
  test('the action, recipient and type are READ from the event and the stored task', () => {
    const n = deriveNoticeFromEvent(EVENT, TASK, ASSIGNEE)
    assert.deepEqual(n, { ok: true, eventId: 'evt-1', recipientId: CREATOR, action: 'waiting', type: 'task_acknowledged' })
    assert.equal(STATUS_NOTICE_TYPE, 'task_acknowledged')
  })

  test('the creator announcing their own event notifies the assignee (the other party, from their side)', () => {
    const n = deriveNoticeFromEvent({ ...EVENT, actor_id: CREATOR, to_status: 'working' }, TASK, CREATOR)
    assert.deepEqual(n, { ok: true, eventId: 'evt-1', recipientId: ASSIGNEE, action: 'working', type: 'task_acknowledged' })
  })

  test('claims that AGREE with the event are accepted; claims that DISAGREE are refused, not overridden', () => {
    assert.equal(deriveNoticeFromEvent(EVENT, TASK, ASSIGNEE, { action: 'waiting', recipientId: CREATOR }).ok, true)
    assert.deepEqual(deriveNoticeFromEvent(EVENT, TASK, ASSIGNEE, { action: 'completed' }), { ok: false, reason: 'action_mismatch' })
    assert.deepEqual(deriveNoticeFromEvent(EVENT, TASK, ASSIGNEE, { recipientId: OUTSIDER }), { ok: false, reason: 'recipient_mismatch' })
    assert.deepEqual(deriveNoticeFromEvent(EVENT, TASK, ASSIGNEE, { recipientId: ASSIGNEE }), { ok: false, reason: 'recipient_mismatch' })
  })

  test('RECOVERY, SAME USER FROM ANOTHER TAB: the event is announced as what it is — the same notice either tab would send', () => {
    // Tab B wrote the event; tab A's reconcile found it. A and B derive the IDENTICAL notice, so the database key makes the
    // second send a no-op; neither is told, or tells the recipient, that "this request" was confirmed.
    const fromTabA = deriveNoticeFromEvent(EVENT, TASK, ASSIGNEE, { action: 'waiting', recipientId: CREATOR })
    const fromTabB = deriveNoticeFromEvent(EVENT, TASK, ASSIGNEE)
    assert.deepEqual(fromTabA, fromTabB)
    assert.equal(JSON.stringify(fromTabA).includes('confirm'), false)
  })
})

describe('what an event does NOT license', () => {
  test('nobody announces somebody else\'s action', () => {
    assert.deepEqual(deriveNoticeFromEvent({ ...EVENT, actor_id: CREATOR }, TASK, ASSIGNEE), { ok: false, reason: 'event_not_by_caller' })
    assert.deepEqual(deriveNoticeFromEvent({ ...EVENT, actor_id: null }, TASK, ASSIGNEE), { ok: false, reason: 'event_not_by_caller' })
  })

  test('an event of another task, or one that is not a status change, licenses nothing', () => {
    assert.deepEqual(deriveNoticeFromEvent({ ...EVENT, task_id: 't-other' }, TASK, ASSIGNEE), { ok: false, reason: 'event_not_this_task' })
    assert.deepEqual(deriveNoticeFromEvent({ ...EVENT, action: 'note_added', to_status: null }, TASK, ASSIGNEE), { ok: false, reason: 'event_not_a_status_change' })
    assert.deepEqual(deriveNoticeFromEvent({ ...EVENT, to_status: null }, TASK, ASSIGNEE), { ok: false, reason: 'event_not_a_status_change' })
  })

  test('an event another writer announces (review submission/return, cancellation) is never announced here — no double notice', () => {
    assert.deepEqual([...ANNOUNCED_ELSEWHERE].sort(), ['cancelled', 'pending_approval'])
    for (const to of ANNOUNCED_ELSEWHERE) {
      assert.deepEqual(deriveNoticeFromEvent({ ...EVENT, to_status: to }, TASK, ASSIGNEE), { ok: false, reason: 'announced_elsewhere' })
    }
  })

  test('only the allowed status actions can be announced; any other label is refused', () => {
    assert.deepEqual([...ALLOWED_STATUS_ACTIONS].sort(), ['blocked', 'completed', 'pending', 'started', 'waiting', 'working'])
    for (const to of ['archived', 'review', 'WAITING', '']) {
      const r = deriveNoticeFromEvent({ ...EVENT, to_status: to || null }, TASK, ASSIGNEE)
      assert.equal(r.ok, false, `"${to}" must not be announced`)
    }
    assert.deepEqual(deriveNoticeFromEvent({ ...EVENT, to_status: 'archived' }, TASK, ASSIGNEE), { ok: false, reason: 'status_not_allowed' })
  })

  test('a caller with no counter-party on the task has nobody to tell', () => {
    assert.deepEqual(deriveNoticeFromEvent(EVENT, { ...TASK, created_by: null }, ASSIGNEE), { ok: false, reason: 'no_other_party' })
    assert.deepEqual(deriveNoticeFromEvent({ ...EVENT, actor_id: OUTSIDER }, TASK, OUTSIDER), { ok: false, reason: 'no_other_party' })
  })
})

describe('loading the event', () => {
  const clientWith = (rows: unknown[] | null, error: { message: string } | null = null) => ({
    from: (_t: 'task_activity_log') => {
      const q: Record<string, unknown> = {}
      q.select = () => q; q.eq = () => q
      q.limit = () => Promise.resolve({ data: rows, error })
      return q
    },
  })

  test('returns the whole row it may derive from, and null for anything else — never a guess', async () => {
    const row = { id: 'evt-1', task_id: 't-1', actor_id: 'u', action: 'status_changed', from_status: 'a', to_status: 'b' }
    assert.deepEqual(await loadActivityEvent(clientWith([row]), 'evt-1', 't-1'), row)
    assert.equal(await loadActivityEvent(clientWith([]), 'evt-1', 't-1'), null, 'not found / another task')
    assert.equal(await loadActivityEvent(clientWith(null, { message: 'down' }), 'evt-1', 't-1'), null, 'unreadable')
    assert.equal(await loadActivityEvent(clientWith([{ id: 1 }]), 'evt-1', 't-1'), null, 'malformed')
  })
})

describe('the route applies it — source contract (the route builds Supabase clients inside its handler)', () => {
  test('a status event\'s facts come from the event: the action is derived, the claimed recipient is checked against it, 422 on disagreement', () => {
    assert.ok(ROUTE.includes('deriveNoticeFromEvent('))
    assert.ok(ROUTE.includes('{ action: claimedAction, recipientId: notifyUserId }'), 'what the request claims is checked against the event')
    assert.ok(ROUTE.includes('const action: string | undefined = derived?.ok ? derived.action : claimedAction'), 'the action used from here on is the event\'s')
    assert.ok(/composeTitle\(action,/.test(ROUTE) && /shouldNotifyTaskStatusEvent\(task, action\)/.test(ROUTE))
    assert.ok(ROUTE.includes('if (!derived.ok) {') && ROUTE.includes('status: 422'))
    assert.ok(ROUTE.indexOf('deriveNoticeFromEvent(') > ROUTE.indexOf("'Invalid recipient'"), 'after both party checks')
    assert.ok(ROUTE.indexOf('deriveNoticeFromEvent(') < ROUTE.indexOf('shouldNotifyTaskStatusEvent(task, action)'), 'before the policy and the write')
  })

  test('a STATUS notice ALWAYS requires a valid event — there is no path to an unlinked status notice, recovery or not', () => {
    const code = ROUTE.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.equal(/\brecovery\b/.test(code), false, 'the route does not branch on a recovery flag: ordinary and recovery sends are the same')
    const gate = code.indexOf('if (isStatusNotice) {')
    assert.ok(gate > 0, 'the status gate exists')
    const insert = code.indexOf('insertUserNotifications(')
    assert.ok(gate < insert, 'and comes before any write')
    const block = code.slice(gate, code.indexOf("const action: string | undefined"))
    assert.ok(block.includes("reason: 'event_required'") && block.includes("reason: 'event_not_found'"), 'missing, and nonexistent / cross-task, are distinct refusals')
    assert.ok(block.includes('if (!derived.ok)'), 'an incompatible event is refused')
    assert.equal((block.match(/return NextResponse\.json/g) ?? []).length, 3, 'every failure in the gate returns; none falls through to a write')
    assert.ok(block.includes('status: 422'))
  })

  test('only a comment and an acknowledgment are exempt, and nothing else can claim to be one', () => {
    assert.ok(ROUTE.includes("const isStatusNotice = !(typeof claimedAction === 'string' && (claimedAction === 'comment_added' || claimedAction === 'acknowledged'))"))
    // An unknown or absent action is a STATUS notice: it must name an event whose status it then takes.
    assert.ok(/composeTitle\(action,/.test(ROUTE))
  })

  test('a notice the rules say is not announced (a quotation, a delegated completion) is skipped BEFORE an event is demanded', () => {
    const skip = ROUTE.indexOf('isStatusNotice && !shouldNotifyTaskStatusEvent(task, claimedAction)')
    assert.ok(skip > 0 && skip < ROUTE.indexOf('if (isStatusNotice) {'))
  })

  test('authorisation is unchanged and still comes first: the caller must be a party before the event is even read', () => {
    assert.ok(ROUTE.indexOf('const callerIsParticipant') < ROUTE.indexOf('loadActivityEvent('))
    assert.ok(ROUTE.includes('user.id === task.created_by || user.id === task.assigned_to'))
    assert.ok(ROUTE.includes('notifyUserId !== task.created_by && notifyUserId !== task.assigned_to'), 'the recipient is still checked against the stored task')
  })

  test('the linked event is the one that was read and validated; an event of another task never links', () => {
    assert.ok(ROUTE.includes('const linkedActivityId = eventRow\n    ? eventRow.id'))
  })

  test('nothing the route returns or logs calls an event "confirmed"', () => {
    assert.equal(/confirm/i.test(ROUTE.split('\n').filter(l => /NextResponse\.json|console\.error/.test(l)).join('\n')), false)
  })

  test('a failed insert other than the named duplicate is still an error (500)', () => {
    const afterInsert = ROUTE.slice(ROUTE.indexOf('insertUserNotifications('))
    assert.ok(/if \(error\) \{[\s\S]{0,260}status: 500/.test(afterInsert), 'a real insert failure is still a 500')
    assert.ok(afterInsert.indexOf('if (error)') < afterInsert.indexOf('if (duplicate)'), 'a real error is judged before any "duplicate" success')
  })
})
