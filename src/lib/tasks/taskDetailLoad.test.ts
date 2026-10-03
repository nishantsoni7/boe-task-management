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
  buildActivityLog, classifyWriteFailure, createLatestGate, mergeActivityRead,
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
    for (const m of ['select', 'eq', 'order']) q[m] = () => q
    q.single = run
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

  const saved = (status: string) => ({ tasks: { data: { status } } })

  test('saved status is the expected one → applied', async () => {
    const r = await reconcileSavedStatus(fakeClient(saved('pending_approval')), 't1', 'pending_approval', 'working')
    assert.equal(r.outcome, 'applied')
  })

  test('saved status is still the old one → not applied, safe to try again', async () => {
    const r = await reconcileSavedStatus(fakeClient(saved('working')), 't1', 'pending_approval', 'working')
    assert.equal(r.outcome, 'not_applied')
  })

  test('saved status is a third one → changed by somebody else', async () => {
    const r = await reconcileSavedStatus(fakeClient(saved('cancelled')), 't1', 'pending_approval', 'working')
    assert.equal(r.outcome, 'changed')
  })

  test('the saved row cannot be read → unknown, and it only ever READS', async () => {
    const calls: string[] = []
    for (const answers of [{ tasks: { error: { message: 'down' } } }, { tasks: { throws: new Error('down') } }]) {
      const r = await reconcileSavedStatus(fakeClient(answers, calls), 't1', 'pending_approval', 'working')
      assert.equal(r.outcome, 'unknown')
    }
    assert.deepEqual(calls, ['tasks', 'tasks'], 'one read each, no write, no retry')
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
    assert.ok(/catch \(e\)/.test(status), 'a rejected status write is caught')
    assert.ok(/finally \{[\s\S]*statusUpdatingRef\.current = false/.test(status))
  })

  test('an unconfirmed review write locks the controls and is never re-sent automatically', () => {
    const run = between('const runReviewAction = async', 'const checkSavedReviewStatus')
    assert.ok(run.includes("classifyWriteFailure(error) === 'rejected'"))
    assert.ok(run.includes('reconcileSavedStatus('))
    assert.equal((run.match(/supabase\.rpc\(/g) ?? []).length, 1, 'the RPC is sent exactly once per call')
    assert.ok(PAGE.includes('reviewBusy !== null || reviewUncertain !== null'))
    assert.ok(run.includes('if (reviewBusyRef.current || reviewUncertain) return false'))
  })

  test('the cancel redirect timer is cleared when the page unmounts', () => {
    assert.ok(PAGE.includes('if (cancelNavTimer.current) clearTimeout(cancelNavTimer.current)'))
  })
})
