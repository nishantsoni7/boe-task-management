/**
 * Task Detail stalls: what each rule in taskDetailLoad.ts guarantees, and the
 * wiring that makes the page use it.
 *
 * THE FAILURES THESE PIN (each reproduced against 1664c1f7, see the PR):
 *
 *  1. A SUBMISSION WAITED ON THE HISTORY. After the RPC was acknowledged,
 *     runReviewAction awaited a re-read of the whole activity log plus every
 *     attachment, and submitForApproval then waited another 800 ms. A slow read
 *     held a finished submission on the page for as long as the read took.
 *  2. THE FIRST OPEN WAITED ON THE WHOLE HISTORY and drew a full-screen loader
 *     until the slowest of three reads came back.
 *  3. A FAILED READ WAS DRAWN AS "TASK NOT FOUND" — query errors were ignored,
 *     a rejection left the loader up forever, and there was no way back short
 *     of refreshing the browser.
 *  4. LATE ANSWERS AND TIMERS ACTED AFTER THE PERSON HAD LEFT: a submit that
 *     resolved after a Back press still navigated, a cancel's 600 ms timer was
 *     never cleared, and a response for task A could paint over task B.
 *  5. A DROPPED CONNECTION LOOKED LIKE A REFUSED WRITE, inviting a second press
 *     of a button whose first press may have landed.
 *
 * Run:
 *   node node_modules/tsx/dist/cli.mjs --test src/lib/tasks/taskDetailLoad.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LogEntry } from '@/lib/types'
import {
  buildActivityLog, classifyWriteFailure, createLatestGate, isStateConflict, mergeActivityRead,
  readTaskEssential, readTaskSecondary, reconcileSavedStatus, REVIEW_RESULT_STATUS,
} from './taskDetailLoad'

// ── A fake client: one canned answer (or throw, or delay) per table ──────────

type Answer = { data?: unknown; error?: { message: string; code?: string } | null; throws?: Error; delayMs?: number }

function fakeClient(answers: Record<string, Answer>, calls: string[] = []): SupabaseClient {
  const chain = (table: string) => {
    const run = async () => {
      calls.push(table)
      const a = answers[table] ?? { data: [], error: null }
      if (a.delayMs) await new Promise(r => setTimeout(r, a.delayMs))
      if (a.throws) throw a.throws
      return { data: a.data ?? null, error: a.error ?? null }
    }
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gt', 'order', 'limit', 'abortSignal']) q[m] = () => q
    q.single = () => q
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej)
    return q
  }
  return { from: chain } as unknown as SupabaseClient
}

const TASK = { id: 't1', status: 'working', created_by: 'u1', assigned_to: 'u2', creator: { full_name: 'Creator' } }
const row = (id: string, created_at: string, extra: Record<string, unknown> = {}) =>
  ({ id, action: 'note_added', note: null, created_at, actor_id: 'u1', users: { full_name: 'A' }, ...extra })

describe('readTaskEssential', () => {
  test('returns the task with the embedded creator split out', async () => {
    const r = await readTaskEssential(fakeClient({ tasks: { data: TASK } }), 't1')
    assert.equal(r.status, 'ok')
    if (r.status !== 'ok') return
    assert.equal(r.creatorName, 'Creator')
    assert.equal('creator' in r.task, false)
    assert.equal(r.task.id, 't1')
  })

  test('zero rows is "not found", not an error', async () => {
    const r = await readTaskEssential(fakeClient({ tasks: { error: { message: 'no rows', code: 'PGRST116' } } }), 't1')
    assert.equal(r.status, 'not_found')
  })

  test('a failed read is an error the page can retry — NOT "not found"', async () => {
    const r = await readTaskEssential(fakeClient({ tasks: { error: { message: 'Failed to fetch' } } }), 't1')
    assert.deepEqual(r, { status: 'error', message: 'Failed to fetch' })
  })

  test('a rejected read is folded into the same result instead of escaping', async () => {
    const r = await readTaskEssential(fakeClient({ tasks: { throws: new Error('socket hang up') } }), 't1')
    assert.deepEqual(r, { status: 'error', message: 'socket hang up' })
  })
})

describe('readTaskSecondary', () => {
  test('joins per-activity attachments and splits out task-level ones', async () => {
    const r = await readTaskSecondary(fakeClient({
      task_activity_log: { data: [row('a', '2026-01-02'), row('b', '2026-01-01')] },
      task_attachments:  { data: [{ id: 'x', activity_log_id: 'a' }, { id: 'y', activity_log_id: null }] },
    }), 't1')
    assert.equal(r.status, 'ok')
    if (r.status !== 'ok') return
    assert.deepEqual(r.log.map(e => [e.id, e.attachments?.length, e.actor_name]), [['a', 1, 'A'], ['b', 0, 'A']])
    assert.deepEqual(r.taskLevelAttachments.map(a => a.id), ['y'])
  })

  test('never half: a failed attachment read fails the pair, so nothing on screen is replaced', async () => {
    const r = await readTaskSecondary(fakeClient({
      task_activity_log: { data: [row('a', '2026-01-02')] },
      task_attachments:  { error: { message: 'boom' } },
    }), 't1')
    assert.deepEqual(r, { status: 'error', message: 'boom' })
  })

  test('a rejection is folded into an error result', async () => {
    const r = await readTaskSecondary(fakeClient({ task_activity_log: { throws: new Error('offline') } }), 't1')
    assert.deepEqual(r, { status: 'error', message: 'offline' })
  })

  test('the essential read resolves while a slow history read is still pending', async () => {
    const client = fakeClient({ tasks: { data: TASK }, task_activity_log: { data: [], delayMs: 150 }, task_attachments: { data: [] } })
    const t0 = Date.now()
    const essential = readTaskEssential(client, 't1')
    const secondary = readTaskSecondary(client, 't1')
    await essential
    const essentialAt = Date.now() - t0
    await secondary
    const secondaryAt = Date.now() - t0
    assert.ok(essentialAt < 100, `task usable after ${essentialAt} ms`)
    assert.ok(secondaryAt >= 140, `history took ${secondaryAt} ms`)
  })

  test('buildActivityLog tolerates a row with no author and no attachments', () => {
    const { log } = buildActivityLog([{ id: 'a', created_at: '2026-01-01' }], [])
    assert.equal(log[0].actor_name, null)
    assert.deepEqual(log[0].attachments, [])
  })
})

describe('mergeActivityRead — a read overtaken by a local write must not erase it', () => {
  const e = (id: string, created_at: string) => ({ id, created_at } as LogEntry)

  test('nothing on screen: the read wins', () => {
    const read = [e('a', '2026-01-01')]
    assert.equal(mergeActivityRead(read, []), read)
  })

  test('a row written locally after the read started is kept at the top', () => {
    const merged = mergeActivityRead([e('a', '2026-01-01')], [e('new', '2026-01-02'), e('a', '2026-01-01')])
    assert.deepEqual(merged.map(x => x.id), ['new', 'a'])
  })

  test('a row the read does not contain but that is older is gone server-side and is dropped', () => {
    const merged = mergeActivityRead([e('b', '2026-01-02')], [e('b', '2026-01-02'), e('gone', '2026-01-01')])
    assert.deepEqual(merged.map(x => x.id), ['b'])
  })

  test('a row the read already contains is not duplicated', () => {
    const merged = mergeActivityRead([e('a', '2026-01-02')], [e('a', '2026-01-02')])
    assert.deepEqual(merged.map(x => x.id), ['a'])
  })
})

describe('createLatestGate', () => {
  test('only the newest ticket is current', () => {
    const g = createLatestGate()
    const first = g.begin(), second = g.begin()
    assert.equal(g.isCurrent(first), false)
    assert.equal(g.isCurrent(second), true)
  })

  test('closing retires every ticket — the person has left', () => {
    const g = createLatestGate()
    const t = g.begin()
    g.close()
    assert.equal(g.isCurrent(t), false)
  })

  test('re-opening (StrictMode runs cleanup then setup) gives fresh tickets a chance', () => {
    const g = createLatestGate()
    g.close(); g.open()
    assert.equal(g.isCurrent(g.begin()), true)
  })
})

describe('uncertain writes are reconciled, never repeated', () => {
  test('a database answer carries a code and was decided; a bare transport failure was not', () => {
    assert.equal(classifyWriteFailure({ message: 'TASK_REVIEW_FORBIDDEN: nope', code: 'P0001' }), 'rejected')
    assert.equal(classifyWriteFailure({ message: 'TypeError: Failed to fetch', code: '' }), 'uncertain')
    assert.equal(classifyWriteFailure({ message: 'Network error', code: null }), 'uncertain')
    assert.equal(classifyWriteFailure(null), 'uncertain')
  })

  test('each review action names the status it leaves behind', () => {
    assert.deepEqual(REVIEW_RESULT_STATUS, { submit: 'pending_approval', approve: 'completed', return: 'working' })
  })

  const NO_RECHECK = { recheckMs: 0 }
  const spec = { actorId: 'me', expectedStatus: 'pending_approval', previousStatus: 'working', since: '2026-01-01T00:00:00Z' }
  const world = (status: string, ours: boolean) => ({
    tasks: { data: { status } },
    task_activity_log: { data: ours ? [{ id: 'row' }] : [] },
  })

  test('expected status AND exactly one activity row of ours → own_action_found (an action of ours is saved — NOT this request confirmed)', async () => {
    const r = await reconcileSavedStatus(fakeClient(world('pending_approval', true)), 't1', spec, NO_RECHECK)
    assert.equal(r.outcome, 'own_action_found')
  })

  test('expected status but NO row of ours → unattributed: another user may have made that move, so it is never claimed', async () => {
    const r = await reconcileSavedStatus(fakeClient(world('pending_approval', false)), 't1', spec, NO_RECHECK)
    assert.equal(r.outcome, 'unattributed')
  })

  test('still the old status and no row of ours → not applied, safe to try again', async () => {
    const r = await reconcileSavedStatus(fakeClient(world('working', false)), 't1', spec, NO_RECHECK)
    assert.equal(r.outcome, 'not_applied')
  })

  test('a third status → changed', async () => {
    const r = await reconcileSavedStatus(fakeClient(world('cancelled', false)), 't1', spec, NO_RECHECK)
    assert.equal(r.outcome, 'changed')
  })

  test('old status but a row of ours exists (it moved and moved back) → changed, not "safe to retry"', async () => {
    const r = await reconcileSavedStatus(fakeClient(world('working', true)), 't1', spec, NO_RECHECK)
    assert.equal(r.outcome, 'changed')
  })

  test('no single expected status (reopen): any move away from the previous status counts, attributed by our row', async () => {
    const reopen = { ...spec, expectedStatus: null, previousStatus: 'completed' }
    assert.equal((await reconcileSavedStatus(fakeClient(world('working', true)), 't1', reopen, NO_RECHECK)).outcome, 'own_action_found')
    assert.equal((await reconcileSavedStatus(fakeClient(world('working', false)), 't1', reopen, NO_RECHECK)).outcome, 'unattributed')
    assert.equal((await reconcileSavedStatus(fakeClient(world('completed', false)), 't1', reopen, NO_RECHECK)).outcome, 'not_applied')
  })

  test('the query that attributes a row is scoped to us, this task, status_changed, leaving the old status, newer than what we saw', async () => {
    const seen: string[] = []
    const client = {
      from: (table: string) => {
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'order', 'limit', 'abortSignal']) q[m] = () => q
        for (const m of ['eq', 'gt']) q[m] = (col: string, v: unknown) => { seen.push(`${table}.${m}(${col},${v})`); return q }
        let one = false
        q.single = () => { one = true; return q }
        q.then = (res: (v: unknown) => unknown) => Promise.resolve(one ? { data: { status: 'pending_approval' }, error: null } : { data: [{ id: 'row' }], error: null }).then(res)
        return q
      },
    } as unknown as SupabaseClient
    await reconcileSavedStatus(client, 't1', spec, NO_RECHECK)
    for (const expected of [
      'task_activity_log.eq(task_id,t1)', 'task_activity_log.eq(actor_id,me)', 'task_activity_log.eq(action,status_changed)',
      'task_activity_log.eq(from_status,working)', 'task_activity_log.eq(to_status,pending_approval)',
      'task_activity_log.gt(created_at,2026-01-01T00:00:00Z)',
    ]) assert.ok(seen.includes(expected), expected)
  })

  test('either read fails or rejects → unknown, and it only ever READS', async () => {
    const calls: string[] = []
    for (const answers of <Record<string, Answer>[]>[
      { tasks: { error: { message: 'down' } } },
      { tasks: { throws: new Error('down') } },
      { tasks: { data: { status: 'working' } }, task_activity_log: { error: { message: 'down' } } },
    ]) {
      const r = await reconcileSavedStatus(fakeClient(answers, calls), 't1', spec, NO_RECHECK)
      assert.equal(r.outcome, 'unknown')
    }
    assert.deepEqual(calls.filter(c => c === 'tasks'), ['tasks', 'tasks', 'tasks'], 'one task read per attempt, no write, no retry')
  })
})

// ── Wiring: the page uses the rules above ───────────────────────────────────

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const PAGE = codeOf(read('src/app/tasks/[id]/page.tsx'))
const between = (from: string, to: string) => PAGE.slice(PAGE.indexOf(from), PAGE.indexOf(to))

describe('Task Detail wiring', () => {
  test('the loader is released by the essential read alone; the history settles afterwards', () => {
    const effect = between('readTaskEssential(supabase, taskId)', 'const loadLog = async')
    assert.ok(effect.indexOf('setLoading(false)') < effect.indexOf('await secondaryRead'))
    assert.equal(/Promise\.all\(/.test(effect), false, 'no three-way batch gates the page again')
  })

  test('a response for a task the person left cannot touch the screen', () => {
    const effect = between('readTaskEssential(supabase, taskId)', 'const loadLog = async')
    assert.ok(effect.includes('let active = true') || PAGE.includes('let active = true'))
    assert.ok(effect.includes('return () => { active = false }'))
    assert.ok(effect.includes('if (!active'), 'checked after every await')
    assert.ok(effect.includes('activityGate.isCurrent(ticket)'))
  })

  test('a failed essential read is a retryable error, not "Task not found"', () => {
    assert.ok(PAGE.includes('const retryTaskLoad'))
    assert.ok(PAGE.includes('if (loadError && !task)'))
    assert.ok(PAGE.indexOf('if (loadError && !task)') < PAGE.indexOf('message="Task not found"'))
  })

  test('the history panel has its own loading and retry state', () => {
    assert.ok(PAGE.includes("activityState !== 'ready'"))
    assert.ok(PAGE.includes('onClick={retryActivityLoad}'))
  })

  test('no write path awaits the history re-read', () => {
    for (const [from, to] of [
      ['const runReviewAction = async', 'const checkSavedReviewStatus'],
      ['const handleReopen = async', 'const handleCancelTask = async'],
      ['const handleCancelTask = async', '// Shared entry point'],
    ]) {
      const body = from === 'const handleCancelTask = async'
        ? PAGE.slice(PAGE.indexOf(from), PAGE.indexOf('const addCommentFiles'))
        : between(from, to)
      assert.equal(/await loadLog\(/.test(body), false, from)
    }
  })

  test('every busy flag is released in a finally block', () => {
    const run = between('const runReviewAction = async', 'const checkSavedReviewStatus')
    assert.ok(/finally \{[\s\S]*reviewBusyRef\.current = false/.test(run))
    const reopen = between('const handleReopen = async', 'const cancelNavTimer')
    assert.ok(/finally \{[\s\S]*setReopening\(false\)/.test(reopen))
    const cancel = PAGE.slice(PAGE.indexOf('const handleCancelTask = async'), PAGE.indexOf('const addCommentFiles'))
    assert.ok(/finally \{[\s\S]*setCancelling\(false\)/.test(cancel))
    const status = between('const applyStatusChange = async', 'const applySavedState')
    assert.ok(/finally \{[\s\S]*statusUpdatingRef\.current = false/.test(status))
  })

  test('an unconfirmed review write locks the controls and is never re-sent automatically', () => {
    const run = between('const runReviewAction = async', 'const checkSavedReviewStatus')
    assert.ok(run.includes("classifyWriteFailure(error) === 'rejected'"))
    assert.ok(run.includes('reconcileSavedStatus('))
    assert.equal((run.match(/supabase\.rpc\(/g) ?? []).length, 1, 'the RPC is sent exactly once per call')
    assert.ok(run.includes('.abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS))'), 'a request that never answers is bounded')
    assert.ok(PAGE.includes('reviewBusy !== null || reviewUncertain !== null'))
    assert.ok(run.includes('if (reviewBusyRef.current || reviewUncertain) return false'))
  })

  test('the cancel redirect timer is cleared when the page unmounts', () => {
    assert.ok(PAGE.includes('if (cancelNavTimer.current) clearTimeout(cancelNavTimer.current)'))
  })
})

describe('attribution limits — what recovery may and may not claim', () => {
  const spec = { actorId: 'me', expectedStatus: 'pending_approval', previousStatus: 'working', since: '2026-01-01T00:00:00Z' }

  /** A client whose reads answer from a per-table QUEUE, so a second look can see something the first did not. */
  function seqClient(script: Record<string, Answer[]>, calls: string[] = []): SupabaseClient {
    const next = (table: string): Answer => { const q = script[table]; return (q.length > 1 ? q.shift() : q[0]) as Answer }
    const from = (table: string) => {
      const run = async () => { calls.push(table); const a = next(table); if (a.throws) throw a.throws; return { data: a.data ?? null, error: a.error ?? null } }
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'gt', 'order', 'limit', 'abortSignal']) q[m] = () => q
      q.single = () => q
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej)
      return q
    }
    return { from } as unknown as SupabaseClient
  }
  const moved = { data: { status: 'pending_approval' } }, unmoved = { data: { status: 'working' } }
  const none = { data: [] }, one = { data: [{ id: 'r1' }] }, two = { data: [{ id: 'r1' }, { id: 'r2' }] }

  test('a COMPETING action by the same person (two matching rows) is not claimed as this request', async () => {
    // Another tab of the same user, or an earlier attempt that landed late, leaves a second identical row.
    const r = await reconcileSavedStatus(seqClient({ tasks: [moved], task_activity_log: [two] }), 't1', spec, { recheckMs: 0 })
    assert.equal(r.outcome, 'unattributed')
  })

  test('DELAYED activity visibility: the row is not visible on the first look, is on the second → own_action_found', async () => {
    const calls: string[] = []
    const r = await reconcileSavedStatus(seqClient({ tasks: [moved], task_activity_log: [none, one] }, calls), 't1', spec, { recheckMs: 5 })
    assert.equal(r.outcome, 'own_action_found')
    assert.equal(calls.filter(c => c === 'tasks').length, 2, 'looked twice, nothing was written')
  })

  test('DELAYED visibility of the status itself: unmoved first, moved with our row second → own_action_found', async () => {
    const r = await reconcileSavedStatus(seqClient({ tasks: [unmoved, moved], task_activity_log: [none, one] }), 't1', spec, { recheckMs: 5 })
    assert.equal(r.outcome, 'own_action_found')
  })

  test('still nothing on the second look → unattributed / not applied, never upgraded', async () => {
    assert.equal((await reconcileSavedStatus(seqClient({ tasks: [moved], task_activity_log: [none] }), 't1', spec, { recheckMs: 5 })).outcome, 'unattributed')
    assert.equal((await reconcileSavedStatus(seqClient({ tasks: [unmoved], task_activity_log: [none] }), 't1', spec, { recheckMs: 5 })).outcome, 'not_applied')
  })

  test('a second look that cannot be read keeps the first answer instead of inventing one', async () => {
    const r = await reconcileSavedStatus(seqClient({ tasks: [moved, { error: { message: 'down' } }], task_activity_log: [none] }), 't1', spec, { recheckMs: 5 })
    assert.equal(r.outcome, 'unattributed')
  })

  test('a confident first answer is not looked at twice', async () => {
    const calls: string[] = []
    await reconcileSavedStatus(seqClient({ tasks: [moved], task_activity_log: [one] }, calls), 't1', spec, { recheckMs: 5 })
    assert.equal(calls.filter(c => c === 'tasks').length, 1)
  })

  test('the page never reports a recovered write as a confirmed success of THIS request, and never leaves for the list on it', () => {
    const run = PAGE.slice(PAGE.indexOf('const runReviewAction = async'), PAGE.indexOf('const checkSavedReviewStatus'))
    const recovered = run.slice(run.indexOf('reconcileSavedStatus('), run.indexOf("perf.mark('rpc')"))
    assert.equal(/return true/.test(recovered), false, 'no recovery branch returns success')
    const LOAD = read('src/lib/tasks/taskDetailLoad.ts')
    assert.ok(LOAD.includes('we cannot match it to this exact request'))
    assert.equal(/not treated as confirmed/.test(LOAD), true)
  })
})

describe('a refusal that may be about a RE-SEND', () => {
  test("only the database's wrong-state code (55000) is treated as possibly caused by our own earlier send", () => {
    assert.equal(isStateConflict({ message: 'TASK_REVIEW_INVALID_SOURCE: ...', code: '55000' }), true)
    for (const code of ['42501', 'P0002', '22023', '28000', '', null]) assert.equal(isStateConflict({ message: 'x', code }), false, String(code))
    assert.equal(isStateConflict(null), false)
  })

  test('the page reconciles a wrong-state refusal before showing it, and shows the database answer only if nothing can be read', () => {
    const run = PAGE.slice(PAGE.indexOf('const runReviewAction = async'), PAGE.indexOf('const checkSavedReviewStatus'))
    assert.ok(run.includes('if (decided && !isStateConflict(error))'), 'other refusals are shown as before')
    assert.ok(run.indexOf('isStateConflict(error)') < run.indexOf('reconcileSavedStatus('), 'the conflict reaches the reconcile')
    assert.ok(run.includes("if (decided && settled.outcome === 'unknown')"), 'unreadable + decided: the database answer, no lock')
    assert.equal((run.match(/supabase\.rpc\(/g) ?? []).length, 1, 'still exactly one send')
  })
})

describe('current state reconciled is NOT this request confirmed', () => {
  const spec = { actorId: 'me', expectedStatus: 'pending_approval', previousStatus: 'working', since: '2026-01-01T00:00:00Z' }
  const NO_RECHECK = { recheckMs: 0 }
  const world = (status: string, rows: { id: string }[]) => ({ tasks: { data: { status } }, task_activity_log: { data: rows } })

  test('a matching action carries the id of the ONE event it found, and is never marked as a confirmed request', async () => {
    const r = await reconcileSavedStatus(fakeClient(world('pending_approval', [{ id: 'evt-1' }])), 't1', spec, NO_RECHECK)
    assert.equal(r.outcome, 'own_action_found')
    if (r.outcome !== 'own_action_found') return
    assert.equal(r.eventId, 'evt-1', 'the event a notification must be tied to')
    assert.equal(r.requestConfirmed, false, 'a match on actor/task/action/time does not identify this request')
    assert.equal(r.saved.status, 'pending_approval', 'the current state IS reconciled')
  })

  test('SAME USER, ANOTHER TAB: that tab\'s row is indistinguishable from ours — found, saved state adopted, request NOT confirmed', async () => {
    // Tab B submitted; tab A (stale, still showing "working") lost the response to its own click. One row of ours exists —
    // written by tab B. It must not be reported as tab A's request.
    const fromOtherTab = await reconcileSavedStatus(fakeClient(world('pending_approval', [{ id: 'evt-from-tab-b' }])), 't1', spec, NO_RECHECK)
    assert.equal(fromOtherTab.outcome, 'own_action_found')
    if (fromOtherTab.outcome === 'own_action_found') assert.equal(fromOtherTab.requestConfirmed, false)
    // Both tabs' rows present: ambiguous — not even an own action is claimed.
    const both = await reconcileSavedStatus(fakeClient(world('pending_approval', [{ id: 'evt-a' }, { id: 'evt-b' }])), 't1', spec, NO_RECHECK)
    assert.equal(both.outcome, 'unattributed')
    assert.equal('eventId' in both, false, 'no event is offered when it cannot be identified uniquely')
  })

  test('no outcome ever reports a confirmed request, and the page never acts on one', () => {
    const lib = read('src/lib/tasks/taskDetailLoad.ts')
    assert.equal((lib.match(/requestConfirmed: (true|boolean)/g) ?? []).length, 0, 'the flag can only be the literal false')
    assert.equal(/requestConfirmed/.test(PAGE), false, 'the page never branches on it — a recovered write is never treated as confirmed')
    assert.equal(/outcome === 'applied'|'applied'/.test(PAGE), false, 'the old, misleading outcome name is gone')
  })
})
