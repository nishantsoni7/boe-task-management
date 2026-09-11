/**
 * Task creation: what the click waits for.
 *
 * Behaviour is tested on runTaskCreation with fakes for every step, so the
 * ORDER and what is AWAITED are asserted directly rather than inferred from
 * source. A final block pins that both reachable creation screens actually run
 * through it, and what they refresh afterwards.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/taskCreateFlow.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createDuplicateCandidateCache, findSimilarTitle, runTaskCreation, SESSION_EXPIRED_MESSAGE,
  type TaskCreateSteps,
} from './taskCreateFlow'

type Task = { id: string; title: string; assigned_to: string }
const TASK: Task = { id: 'task-1', title: 'Send revised quotation to Leela Hotel', assigned_to: 'user-2' }

function deferred<V>() {
  let resolve!: (value: V) => void
  const promise = new Promise<V>(r => { resolve = r })
  return { promise, resolve }
}

function flow(overrides: Partial<TaskCreateSteps<Task, string>> = {}) {
  const log: string[] = []
  const steps: TaskCreateSteps<Task, string> = {
    guard: { current: false },
    validate: () => true,
    onStart: () => { log.push('start') },
    findSimilar: async () => { log.push('similar'); return null },
    confirmSimilar: () => { log.push('confirm'); return true },
    prepareAttachments: null,
    insertTask: async () => { log.push('insert'); return { task: TASK } },
    insertActivity: async () => { log.push('activity') },
    ...overrides,
  }
  return { steps, log }
}

// ── 1–3. The zero-file paths ────────────────────────────────────────────────

describe('a self task with no files', () => {
  test('waits for the similar check, the insert and the activity row — nothing else', async () => {
    const { steps, log } = flow()
    const outcome = await runTaskCreation(steps)
    assert.deepEqual(outcome, { status: 'created', task: TASK })
    assert.deepEqual(log, ['start', 'similar', 'insert', 'activity'])
  })

  test('asks for no notification when the screen supplies none', async () => {
    const { steps, log } = flow()
    await runTaskCreation(steps)
    assert.equal(log.some(entry => entry.startsWith('notify')), false)
  })
})

describe('a delegated task with no files', () => {
  test('requests the assignee notification exactly once, after the activity row exists', async () => {
    const activity = deferred<void>()
    const { steps, log } = flow({
      insertActivity: async () => { log.push('activity:start'); await activity.promise; log.push('activity:done') },
      notifyAssignee: task => { log.push(`notify ${task.id}`) },
    })
    const running = runTaskCreation(steps)
    await new Promise(r => setTimeout(r, 0))
    assert.equal(log.includes(`notify ${TASK.id}`), false, 'not before the activity row is written')
    activity.resolve()
    assert.equal((await running).status, 'created')
    assert.deepEqual(log, ['start', 'similar', 'insert', 'activity:start', 'activity:done', `notify ${TASK.id}`])
  })

  test('is reported created while the notification is still in flight', async () => {
    let notificationSettled = false
    const { steps } = flow({
      notifyAssignee: () => {
        void new Promise<void>(r => setTimeout(r, 200)).then(() => { notificationSettled = true })
      },
    })
    const outcome = await runTaskCreation(steps)
    assert.equal(outcome.status, 'created')
    assert.equal(notificationSettled, false, 'the creator was not held on the form by the notification')
  })
})

// ── 4. Exactly once ─────────────────────────────────────────────────────────

describe('a double click creates exactly one task', () => {
  test('the second click in the same tick is refused before anything starts', async () => {
    const gate = deferred<void>()
    let inserts = 0
    let starts = 0
    const { steps } = flow({
      onStart: () => { starts++ },
      insertTask: async () => { inserts++; await gate.promise; return { task: TASK } },
    })
    const first = runTaskCreation(steps)
    const second = await runTaskCreation(steps)
    assert.equal(second.status, 'busy')
    gate.resolve()
    assert.equal((await first).status, 'created')
    assert.equal(inserts, 1)
    assert.equal(starts, 1, 'the saving state is entered once')
    assert.equal(steps.guard.current, false, 'released once the creation settles')
  })

  test('the guard is released after a failure too, so the form can be corrected and resubmitted', async () => {
    const { steps } = flow({ insertTask: async () => ({ error: 'network' }) })
    assert.equal((await runTaskCreation(steps)).status, 'failed')
    assert.equal(steps.guard.current, false)
  })
})

// ── 5. Nothing is written for an invalid or declined form ───────────────────

describe('validation failure creates nothing', () => {
  test('an incomplete form never starts, reads or writes', async () => {
    const { steps, log } = flow({ validate: () => false })
    assert.deepEqual(await runTaskCreation(steps), { status: 'invalid' })
    assert.deepEqual(log, [])
    assert.equal(steps.guard.current, false)
  })

  test('declining the similar-task warning writes nothing', async () => {
    const { steps, log } = flow({
      findSimilar: async () => ({ id: 'old', title: 'Send revised quotation to Leela' }),
      confirmSimilar: () => { log.push('confirm'); return false },
    })
    assert.deepEqual(await runTaskCreation(steps), { status: 'cancelled' })
    assert.equal(log.includes('insert'), false)
  })

  test('an expired session is a visible failure, and nothing after the insert runs', async () => {
    const { steps, log } = flow({
      insertTask: async () => ({ error: SESSION_EXPIRED_MESSAGE }),
      notifyAssignee: () => { log.push('notify') },
    })
    assert.deepEqual(await runTaskCreation(steps), { status: 'failed', message: SESSION_EXPIRED_MESSAGE })
    assert.equal(log.includes('activity'), false)
    assert.equal(log.includes('notify'), false)
  })
})

// ── 6–7. Attachments ────────────────────────────────────────────────────────

describe('attachment machinery', () => {
  test('with zero files, preparation and upload are never invoked', async () => {
    const { steps, log } = flow({
      prepareAttachments: null,
      uploadAttachments: async () => { log.push('upload') },
    })
    await runTaskCreation(steps)
    assert.equal(log.includes('upload'), false)
    assert.equal(log.includes('prepare'), false)
  })

  test('with files, they are prepared before the insert and uploaded after the activity row', async () => {
    const { steps, log } = flow({
      prepareAttachments: async () => { log.push('prepare'); return ['a.png', 'b.pdf'] },
      notifyAssignee: () => { log.push('notify') },
      uploadAttachments: async (_task, files) => { log.push(`upload ${files.join(',')}`) },
    })
    assert.equal((await runTaskCreation(steps)).status, 'created')
    assert.deepEqual(log, ['start', 'similar', 'prepare', 'insert', 'activity', 'notify', 'upload a.png,b.pdf'])
  })

  test('files that cannot be prepared stop the creation before any write', async () => {
    const { steps, log } = flow({ prepareAttachments: async () => { log.push('prepare'); return null } })
    assert.deepEqual(await runTaskCreation(steps), { status: 'attachments_invalid' })
    assert.equal(log.includes('insert'), false)
  })
})

// ── The similar-task rule and its read-ahead ────────────────────────────────

describe('the similar-task warning is unchanged', () => {
  test('three shared words longer than three characters match, case-insensitively', () => {
    const existing = [{ id: 'a', title: 'SEND the Revised QUOTATION to Leela' }]
    assert.deepEqual(findSimilarTitle('send revised quotation today', existing), existing[0])
  })

  test('two shared words, or only short words, do not', () => {
    assert.equal(findSimilarTitle('send revised note', [{ id: 'a', title: 'send revised quotation' }]), null)
    assert.equal(findSimilarTitle('a to do it', [{ id: 'a', title: 'a to do it' }]), null)
  })
})

describe('similar-task candidates are read ahead of the click', () => {
  const rows = [{ id: 'a', title: 'Existing task' }]

  test('a primed read is reused at submit — one request, not two', async () => {
    let loads = 0
    const cache = createDuplicateCandidateCache(async () => { loads++; return rows })
    cache.prime('user-2')
    assert.deepEqual(await cache.candidates('user-2'), rows)
    assert.equal(loads, 1)
  })

  test('a read older than the max age is repeated at submit', async () => {
    let clock = 0
    let loads = 0
    const cache = createDuplicateCandidateCache(async () => { loads++; return rows }, { maxAgeMs: 60_000, now: () => clock })
    cache.prime('user-2')
    clock = 60_001
    await cache.candidates('user-2')
    assert.equal(loads, 2)
  })

  test('a failed read is not kept — it counts as no candidates once, and is retried next time', async () => {
    let loads = 0
    const cache = createDuplicateCandidateCache(async () => { loads++; return loads === 1 ? null : rows })
    assert.deepEqual(await cache.candidates('user-2'), [])
    assert.deepEqual(await cache.candidates('user-2'), rows)
    assert.equal(loads, 2)
  })

  test('each assignee has its own candidates', async () => {
    const cache = createDuplicateCandidateCache(async id => [{ id, title: `task for ${id}` }])
    assert.equal((await cache.candidates('user-2'))[0].id, 'user-2')
    assert.equal((await cache.candidates('user-3'))[0].id, 'user-3')
  })

  test('a task just created is a candidate for the next check', async () => {
    const cache = createDuplicateCandidateCache(async () => rows)
    cache.prime('user-2')
    cache.remember('user-2', { id: 'new', title: 'Send revised quotation to Leela' })
    const candidates = await cache.candidates('user-2')
    assert.ok(findSimilarTitle('send revised quotation again', candidates))
  })
})

// ── Wiring: both reachable screens use it, and refresh what they changed ─────

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const DELEGATE = 'src/app/tasks/create/page.tsx'
const SELF = 'src/app/tasks/create-self/page.tsx'

describe('wiring: /tasks/create and /tasks/create-self', () => {
  for (const path of [DELEGATE, SELF]) {
    const code = codeOf(read(path))

    test(`${path} runs its creation through the shared flow with a synchronous guard`, () => {
      assert.ok(/await runTaskCreation(<[^>]*>)?\(\{/.test(code))
      assert.ok(code.includes('guard: submittingRef,'))
      assert.ok(code.includes('const submittingRef = useRef(false)'))
    })

    test(`${path} hands the flow no attachment step when there are no files`, () => {
      assert.ok(code.includes('prepareAttachments: attachFiles.length ? async () => {'))
    })

    test(`${path} reads similar-task candidates ahead of the click`, () => {
      assert.ok(code.includes('duplicateCandidates.prime('))
      assert.ok(code.includes('await duplicateCandidates.candidates('))
      assert.equal(/\.from\('tasks'\)\.select\('id, title'\)[\s\S]{0,120}await/.test(code.slice(code.indexOf('const handleSubmit'))), false,
        'the similar-task read must not be issued inside the submit handler')
    })

    test(`${path} refreshes the affected lists, counts and report without waiting`, () => {
      assert.ok(code.includes("queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', task.assigned_to] })"))
      assert.ok(code.includes("queryClient.invalidateQueries({ queryKey: ['nav-counts'] })"))
      assert.ok(code.includes("queryClient.invalidateQueries({ queryKey: ['task-report', 'created', actorId] })"))
      assert.equal(/await queryClient\.invalidateQueries/.test(code), false)
    })

    test(`${path} makes no auth-server call during submit`, () => {
      assert.equal(code.includes('auth.getUser('), false)
    })
  }

  test('the delegate screen does not await the notification, and still reports its failure', () => {
    const code = codeOf(read(DELEGATE))
    assert.ok(code.includes('void requestAssignmentNotification(task.id).then(notified => {'))
    assert.equal(/await requestAssignmentNotification/.test(code), false)
    assert.ok(/if \(!notified\.ok\) \{[\s\S]{0,160}setNotifyFailedFor\(task\.id\)/.test(code))
  })

  test('the self screen asks for no notification', () => {
    assert.equal(codeOf(read(SELF)).includes('requestAssignmentNotification'), false)
  })

  test('the flow starts the notification only after the awaited activity insert', () => {
    const flowSrc = codeOf(read('src/lib/tasks/taskCreateFlow.ts'))
    const activity = flowSrc.indexOf('await steps.insertActivity(task)')
    const notify = flowSrc.indexOf('steps.notifyAssignee?.(task)')
    assert.ok(activity > 0 && notify > activity)
    assert.equal(/await steps\.notifyAssignee/.test(flowSrc), false)
  })
})
