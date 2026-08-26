// THE WRITE-AUTHORITY HALF OF THE HOTFIX.
//
// PROVEN IN PRODUCTION, NOT INFERRED. A task was created and assigned. The
// production query returned the task row — id 87d87668…, assigned_to
// 6507df9f… — and a NULL notification. The row was never written. The first
// pass at this fix assumed "written, then hidden by the title whitelist"; the
// database disproved it.
//
// WHY THE WRITE FAILED. The four task-creation screens ran the insert in the
// BROWSER, under the creator's session, with `user_id` set to the ASSIGNEE. No
// client role may do that. The repository states the rule itself, as the first
// reason transition_task_review() is SECURITY DEFINER (20260833000000):
//
//   "the notification is addressed to the OTHER party, and no client role may
//    insert a notifications row for somebody else"
//
// These tests pin the fix: the write moved behind a server boundary that
// authenticates the caller, authorizes them against the STORED task, and
// derives every field from that row.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAssignmentNotification,
  requestAssignmentNotification,
  ASSIGNMENT_OUTCOME_STATUS,
  TASK_ASSIGNMENT_NOTIFICATION_TYPE,
  type AssignmentNotificationStore,
  type AssignmentTaskRow,
} from '@/lib/tasks/assignmentNotification'
import type { NotificationInsert } from '@/lib/notificationWrites'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const ASSIGNEE  = '11111111-1111-4111-8111-111111111111'
const CREATOR   = '22222222-2222-4222-8222-222222222222'
const OUTSIDER  = '44444444-4444-4444-8444-444444444444'
const ADMIN     = '55555555-5555-4555-8555-555555555555'
const TASK      = '33333333-3333-4333-8333-333333333333'

type Stub = AssignmentNotificationStore & { written: NotificationInsert[][]; fetched: string[] }

function stubStore(opts: {
  task?: AssignmentTaskRow | null
  fetchError?: { message: string } | null
  admins?: string[]
  existing?: boolean
  dupReadable?: boolean
  insertError?: { message: string } | null
} = {}): Stub {
  const written: NotificationInsert[][] = []
  const fetched: string[] = []
  const task = opts.task === undefined
    ? { id: TASK, title: 'test task', assigned_to: ASSIGNEE, created_by: CREATOR }
    : opts.task
  return {
    written, fetched,
    async fetchTask(taskId) {
      fetched.push(taskId)
      return { task: opts.fetchError ? null : task, error: opts.fetchError ?? null }
    },
    async isAdmin(userId) { return (opts.admins ?? []).includes(userId) },
    async hasAssignmentNotification() {
      return { exists: opts.existing ?? false, readable: opts.dupReadable ?? true }
    },
    async insert(rows) { written.push(rows); return { error: opts.insertError ?? null } },
  }
}

const ROUTE  = 'src/app/api/tasks/[id]/notify-assignment/route.ts'
const routeSrc = read(ROUTE)

// ── 1–3. The client cannot choose anything ───────────────────────────────────

describe('1-3. the server derives every field; the client supplies only a task id', () => {
  test('1. a task creator cannot choose an arbitrary recipient', async () => {
    // There is no parameter to pass one through. The operation's whole input is
    // { taskId, callerId }, and callerId comes from the session, not the body.
    const store = stubStore()
    await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    assert.equal(store.written[0][0].user_id, ASSIGNEE)

    // And the route reads nothing from the request at all.
    assert.match(routeSrc, /export async function POST\(\s*\n?\s*_req: NextRequest/)
    assert.equal(/req\.json\(\)/.test(routeSrc), false, 'the body is never parsed')
    assert.equal(/searchParams/.test(routeSrc), false, 'no query input either')
  })

  test('2. the recipient is read from the stored task', async () => {
    const store = stubStore({
      task: { id: TASK, title: 'test task', assigned_to: OUTSIDER, created_by: CREATOR },
    })
    await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    assert.equal(store.written[0][0].user_id, OUTSIDER, 'whatever assigned_to says')
    assert.deepEqual(store.fetched, [TASK])
  })

  test('3. title, body, type and task_id are derived, not trusted', async () => {
    const store = stubStore({
      task: { id: TASK, title: 'a title only the database knows', assigned_to: ASSIGNEE, created_by: CREATOR },
    })
    await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    const row = store.written[0][0]
    assert.equal(row.type, TASK_ASSIGNMENT_NOTIFICATION_TYPE)
    assert.equal(row.title, 'New task assigned to you')
    assert.equal(row.body, 'a title only the database knows')
    assert.equal(row.task_id, TASK)
    assert.equal(row.is_push_sent, false)
  })

  test('3b. the route names the session as the only source of identity', () => {
    assert.ok(routeSrc.includes('authClient.auth.getUser()'))
    assert.ok(routeSrc.includes('callerId: user.id'))
    assert.equal(/user_id\s*[:=]/.test(routeSrc), false,
      'the route never names a recipient itself')
  })
})

// ── 4–5. Authentication and authorization ────────────────────────────────────

describe('4-5. who may cause a notification', () => {
  test('4. an unauthenticated call is refused before anything else happens', () => {
    const authIndex    = routeSrc.indexOf('if (!user) return NextResponse.json')
    const serviceIndex = routeSrc.indexOf('createServiceClient(')
    assert.ok(authIndex > 0, 'the route rejects a missing user')
    assert.ok(routeSrc.includes("{ status: 401 }"))
    assert.ok(authIndex < serviceIndex,
      'the service-role key is not built until the caller is known')
  })

  test('5. an unrelated authenticated user cannot notify for another person\'s task', async () => {
    const store = stubStore({ admins: [ADMIN] })
    const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: OUTSIDER })
    assert.equal(outcome.status, 'forbidden')
    assert.equal(store.written.length, 0, 'nothing was written')
    assert.equal(ASSIGNMENT_OUTCOME_STATUS.forbidden, 403)
  })

  test('5b. the creator may, and so may an admin', async () => {
    const asCreator = stubStore()
    assert.equal((await createAssignmentNotification(asCreator, { taskId: TASK, callerId: CREATOR })).status, 'created')

    const asAdmin = stubStore({ admins: [ADMIN] })
    assert.equal((await createAssignmentNotification(asAdmin, { taskId: TASK, callerId: ADMIN })).status, 'created')
    // An admin acting for the creator still notifies the ASSIGNEE.
    assert.equal(asAdmin.written[0][0].user_id, ASSIGNEE)
  })

  test('5c. a task that does not exist is a 404, not a silent success', async () => {
    const store = stubStore({ task: null })
    const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    assert.equal(outcome.status, 'not_found')
    assert.equal(store.written.length, 0)
    assert.equal(ASSIGNMENT_OUTCOME_STATUS.not_found, 404)
  })

  test('5d. a malformed task id is rejected before Postgres sees it', () => {
    assert.ok(routeSrc.includes('isValidUUID(taskId)'))
    assert.ok(routeSrc.includes("{ status: 400 }"))
  })
})

// ── 6–8. One row, retry-safe, and the self-task rule ─────────────────────────

describe('6-8. exactly one notification, and only when there is somebody to tell', () => {
  test('6. a valid assignment creates exactly one notification', async () => {
    const store = stubStore()
    const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    assert.equal(outcome.status, 'created')
    assert.equal(store.written.length, 1)
    assert.equal(store.written[0].length, 1)
  })

  test('7. a retry does not create a duplicate', async () => {
    // Second call: the store now reports an existing row, as the real one would.
    const store = stubStore({ existing: true })
    const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    assert.equal(outcome.status, 'skipped_duplicate')
    assert.equal(store.written.length, 0)
    assert.equal(ASSIGNMENT_OUTCOME_STATUS.skipped_duplicate, 200, 'a repeat is a success')
  })

  test('7b. a duplicate check that FAILED does not block the write', async () => {
    // A read that errored tells us nothing about what exists, and a missing
    // notification is worse than a duplicated one — the same direction
    // /api/finance/notify takes when its dedup query errors.
    const store = stubStore({ existing: false, dupReadable: false })
    assert.equal((await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })).status, 'created')
    assert.equal(store.written.length, 1)
  })

  test('7c. the duplicate identity needs no time window', async () => {
    // (user_id, task_id, type) is the whole identity: a task is assigned once,
    // so an existing row is a repeat however old it is. Strictly stronger than
    // the two-minute window Finance uses.
    const src = read('src/lib/tasks/assignmentNotification.ts')
    assert.ok(src.includes(".eq('task_id', taskId)"))
    assert.ok(src.includes(".eq('user_id', recipientId)"))
    assert.ok(src.includes(".eq('type', TASK_ASSIGNMENT_NOTIFICATION_TYPE)"))
    assert.equal(/created_at/.test(src), false, 'no time window is involved')
    // And the limit of the guarantee is stated where somebody will read it.
    assert.ok(src.includes('NOT concurrency-safe'))
  })

  test('8. a self-task notifies nobody', async () => {
    const store = stubStore({
      task: { id: TASK, title: 'my own task', assigned_to: CREATOR, created_by: CREATOR },
    })
    const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    assert.equal(outcome.status, 'skipped_self')
    assert.equal(store.written.length, 0)
  })

  test('8b. but a task somebody ELSE assigned to you still notifies you', async () => {
    // The rule is about the task (assigned_to === created_by), not about who
    // happens to be calling. An admin triggering this for a task assigned to
    // themselves by another person must not swallow that person's notification.
    const store = stubStore({
      admins: [ADMIN],
      task: { id: TASK, title: 'for the admin', assigned_to: ADMIN, created_by: CREATOR },
    })
    const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: ADMIN })
    assert.equal(outcome.status, 'created')
    assert.equal(store.written[0][0].user_id, ADMIN)
  })

  test('8c. a task with no assignee writes nothing', async () => {
    const store = stubStore({
      task: { id: TASK, title: 'unassigned', assigned_to: null, created_by: CREATOR },
    })
    assert.equal((await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })).status, 'skipped_self')
    assert.equal(store.written.length, 0)
  })
})

// ── 9–10. Every path, and nothing left in the browser ────────────────────────

describe('9-10. every creation path goes through the trusted operation', () => {
  const CLIENT_PATHS = [
    'src/app/tasks/create/page.tsx',
    'src/app/tasks/assigned-by-me/page.tsx',
    'src/app/tasks/quotation-requests/new/page.tsx',
    'src/components/meetings/MeetingTaskModal.tsx',
  ]

  for (const path of CLIENT_PATHS) {
    test(`9. ${path} calls the server route`, () => {
      const src = read(path)
      assert.ok(src.includes('requestAssignmentNotification'), 'uses the shared client helper')
    })
  }

  test('9b. copy runs the SAME operation in-process', () => {
    const copy = read('src/app/api/tasks/[id]/copy/route.ts')
    assert.ok(copy.includes('createAssignmentNotification'))
    assert.ok(copy.includes('supabaseAssignmentStore'))
    assert.ok(copy.includes('SUPABASE_SERVICE_ROLE_KEY'), 'with a service-role client')
  })

  test('10. NO client-side notifications insert remains anywhere', () => {
    // The defect in one assertion. Any browser file writing this table is
    // writing something the database will refuse the moment it addresses
    // somebody else.
    for (const path of [...CLIENT_PATHS, 'src/app/tasks/[id]/page.tsx', 'src/app/dashboard/page.tsx']) {
      const src = read(path)
      assert.equal(/\.from\(['"]notifications['"]\)/.test(src), false,
        `${path} must not touch the notifications table`)
    }
  })

  test('10b. every remaining writer is a server route or a SECURITY DEFINER function', () => {
    // Comments and status changes; cancellation; restore/reopen; the copy path.
    for (const path of [
      'src/app/api/notify-status-update/route.ts',
      'src/app/api/cancel-task/route.ts',
      'src/app/api/restore-task/route.ts',
      'src/app/api/tasks/[id]/copy/route.ts',
      ROUTE,
    ]) {
      assert.ok(read(path).includes('SUPABASE_SERVICE_ROLE_KEY'), `${path} uses a trusted client`)
    }
    // Submit / approve / return.
    const rpc = read('supabase/migrations/20260833000000_task_creator_approval.sql')
    assert.ok(rpc.includes('security definer'))
    assert.ok(rpc.includes('no client role may'), 'the rule is stated at its source')
  })
})

// ── 11–12. Failure is visible, and the task survives it ──────────────────────

describe('11-12. a failed notification is reported, and costs nobody their task', () => {
  test('11. an insert failure returns an error outcome, never a success', async () => {
    const store = stubStore({ insertError: { message: 'new row violates row-level security policy' } })
    const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    assert.equal(outcome.status, 'error')
    assert.equal(ASSIGNMENT_OUTCOME_STATUS.error, 500)
    // The route turns that into a 500 with a generic message — never the row.
    assert.ok(routeSrc.includes("outcome.status === 'error'"))
    assert.ok(routeSrc.includes('{ status: ASSIGNMENT_OUTCOME_STATUS.error }'))
    assert.equal(/outcome\.message\s*\}/.test(routeSrc), false,
      'the failure text is logged, not returned to the browser')
  })

  test('11b. a fetch failure is an error, not a 404 and not a skip', async () => {
    const store = stubStore({ fetchError: { message: 'connection reset' } })
    const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    assert.equal(outcome.status, 'error')
  })

  test('11c. the client helper retries a 5xx once, and a 4xx never', async () => {
    let calls = 0
    const flaky: typeof fetch = async () => {
      calls += 1
      if (calls === 1) return new Response('', { status: 503 }) as Response
      return new Response(JSON.stringify({ status: 'created' }), { status: 200 }) as Response
    }
    assert.deepEqual(await requestAssignmentNotification(TASK, flaky), { ok: true, status: 'created' })
    assert.equal(calls, 2, 'one retry')

    let forbidden = 0
    const denied: typeof fetch = async () => {
      forbidden += 1
      return new Response('', { status: 403 }) as Response
    }
    const res = await requestAssignmentNotification(TASK, denied)
    assert.equal(res.ok, false)
    assert.equal(forbidden, 1, 'a decision is not retried')
  })

  test('11d. a transport failure is reported as a failure, not assumed fine', async () => {
    const dead: typeof fetch = async () => { throw new Error('network down') }
    const res = await requestAssignmentNotification(TASK, dead)
    assert.equal(res.ok, false)
  })

  test('11e. every screen turns that into something a person sees', () => {
    // A console.error is what let this run in production unnoticed.
    const SURFACES: [path: string, call: string][] = [
      ['src/app/tasks/create/page.tsx',                 'setSubmitError'],
      ['src/app/tasks/assigned-by-me/page.tsx',         'onError'],
      ['src/app/tasks/quotation-requests/new/page.tsx', 'setSubmitError'],
      ['src/components/meetings/MeetingTaskModal.tsx',  'setError'],
    ]
    for (const [path, call] of SURFACES) {
      const src = read(path)
      const outcomeAt = src.indexOf('notified')
      assert.ok(outcomeAt > 0, `${path} reads the outcome`)
      assert.ok(/!notified\.ok/.test(src), `${path} branches on failure`)
      // The surfacing call must come AFTER the outcome is in hand — an earlier
      // one belongs to some other failure on the same screen.
      assert.ok(src.indexOf(call, outcomeAt) > outcomeAt,
        `${path} surfaces the failure via ${call}, not only a log`)
    }
  })

  test('12. a created task is never deleted because its notification failed', () => {
    for (const path of [
      'src/app/tasks/create/page.tsx',
      'src/app/tasks/assigned-by-me/page.tsx',
      'src/app/tasks/quotation-requests/new/page.tsx',
      'src/components/meetings/MeetingTaskModal.tsx',
      'src/app/api/tasks/[id]/copy/route.ts',
    ]) {
      const src = read(path)
      const at = src.indexOf('notified')
      assert.ok(at > 0, `${path} handles the outcome`)
      const after = src.slice(at, at + 600)
      assert.equal(/\.delete\(\)/.test(after), false, `${path} must not delete the task`)
      assert.equal(/rollback/i.test(after), false, `${path} must not roll the task back`)
    }
  })
})

// ── 18. The migration ledger is untouched ────────────────────────────────────

describe('18. migration 115 is untouched by this hotfix', () => {
  test('its text still hashes to the pinned value', async () => {
    const { createHash } = await import('node:crypto')
    const sql = read('supabase/migrations/20261015000000_task_health_check_stops_notifying.sql')
    assert.equal(
      createHash('sha256').update(sql).digest('hex'),
      'f05f7ffffb964ea2a6e0a70a214ca6001b6321a9767fc315c3001fbf22736349',
    )
  })

  test('and this hotfix adds no migration of its own', () => {
    const files = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(f => f.endsWith('.sql'))
    const newest = files.slice().sort().pop()
    assert.equal(newest, '20261015000000_task_health_check_stops_notifying.sql',
      'nothing newer than 115 was added')
  })
})
