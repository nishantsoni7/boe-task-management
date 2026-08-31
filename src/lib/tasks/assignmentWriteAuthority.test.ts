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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  requestAssignmentNotification,
  ASSIGNMENT_OUTCOME_STATUS,
  TASK_ASSIGNMENT_NOTIFICATION_TYPE,
} from '@/lib/tasks/assignmentNotification'
import {
  createAssignmentNotification,
  type AssignmentNotificationStore,
  type AssignmentTaskRow,
} from '@/lib/tasks/assignmentNotificationWriter.server'
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
  creationActivityId?: string | null
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
    async findCreationActivityId() { return opts.creationActivityId ?? null },
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
    const serviceIndex = routeSrc.indexOf('adminClient()')
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

  test('5e. the ASSIGNEE cannot invoke it merely by being the recipient', () => {
    // The recipient of a notification is not thereby entitled to cause it.
    // Nothing in the operation consults assigned_to for authorization — only
    // created_by and the admin check — and this proves it from the outside.
    return (async () => {
      const store = stubStore({ admins: [ADMIN] })
      const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: ASSIGNEE })
      assert.equal(outcome.status, 'forbidden')
      assert.equal(store.written.length, 0)
    })()
  })

  test('5f. the admin check is the repository\'s existing one, not a second interpretation', () => {
    // `users.role === 'admin'`, read server-side — identical to /api/cancel-task
    // and /api/restore-task. No new role, no new permission vocabulary, and in
    // particular no reading of a role the caller supplied.
    const writer = read('src/lib/tasks/assignmentNotificationWriter.server.ts')
    assert.ok(writer.includes(".from('users')"))
    assert.ok(writer.includes(".select('role')"))
    assert.ok(writer.includes(".eq('id', userId)"))
    assert.ok(writer.includes("=== 'admin'"))

    for (const peer of ['src/app/api/cancel-task/route.ts', 'src/app/api/restore-task/route.ts']) {
      assert.ok(read(peer).includes("role === 'admin'"),
        `${peer} uses the same check, so this route introduces no second rule`)
    }
    // And nothing resembling a permission-string interpretation was invented.
    assert.equal(/getEffectivePermissions|hasPermission|can[A-Z]/.test(writer), false)
  })

  test('5g. authentication completes BEFORE the privileged client is built', () => {
    const authAt    = routeSrc.indexOf('auth.getUser()')
    const rejectAt  = routeSrc.indexOf('{ status: 401 }')
    const adminAt   = routeSrc.indexOf('adminClient()')
    const operateAt = routeSrc.indexOf('createAssignmentNotification(')
    assert.ok(authAt > 0 && rejectAt > authAt, 'a missing session is rejected right after the read')
    assert.ok(adminAt > rejectAt, 'the service-role client is built only after that')
    assert.ok(operateAt > adminAt, 'and the write happens after both')
    // Authorization itself lives in the operation, downstream of all three.
    assert.equal(/created_by|assigned_to/.test(routeSrc), false,
      'the route delegates authorization rather than duplicating it')
  })

  test('5h. it uses the canonical admin helper, not an inline process.env pair', () => {
    // src/lib/supabase/admin.ts exists because inline `process.env.X!` throws at
    // construction when the value is absent, escaping as a bare 500 with no
    // readable body — which was once reported as a permission refusal.
    assert.ok(routeSrc.includes("from '@/lib/supabase/admin'"))
    // The phrase appears in the comment explaining why it is NOT used, so the
    // pattern requires a plausible variable name rather than the `X` of prose.
    assert.equal(/process\.env\.[A-Z][A-Z0-9_]{2,}/.test(routeSrc), false, 'no raw credential access')
    assert.ok(routeSrc.includes('if (!admin.ok)'), 'the missing case is handled, not asserted away')
    // The variable NAMES go to the server log; nothing about them reaches the
    // response, whose body is a fixed sentence.
    assert.ok(routeSrc.includes("console.error('[notify-assignment] not configured; missing:'"))
    const branch = routeSrc.slice(routeSrc.indexOf('if (!admin.ok)'))
    const response = branch.slice(branch.indexOf('return NextResponse.json'), branch.indexOf('}\n\n'))
    assert.equal(/missing/.test(response), false, 'the missing names are not returned to the caller')
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
    const src = read('src/lib/tasks/assignmentNotificationWriter.server.ts')
    assert.ok(src.includes(".eq('task_id', taskId)"))
    assert.ok(src.includes(".eq('user_id', recipientId)"))
    assert.ok(src.includes(".eq('type', TASK_ASSIGNMENT_NOTIFICATION_TYPE)"))
    assert.equal(/created_at/.test(src), false, 'no time window is involved')
    // And the limit of the guarantee is stated where somebody will read it.
    assert.ok(src.includes('THIS IS NOT FULLY IDEMPOTENT'))
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
      const src = read(path)
      // Either the canonical helper or the older inline pair — both are the
      // service-role credential; what matters is that none of them is a
      // session client. (The helper is the preferred form; the four older
      // routes predate it and are left alone by this hotfix.)
      assert.ok(src.includes('SUPABASE_SERVICE_ROLE_KEY') || src.includes("from '@/lib/supabase/admin'"),
        `${path} uses a trusted client`)
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

// ── Gates 5 & 6: the recorded limitation, and the documented retry ───────────

describe('the idempotency limitation is recorded accurately, not overstated', () => {
  const writerRaw = read('src/lib/tasks/assignmentNotificationWriter.server.ts')
  // The note is a wrapped comment block, so phrases straddle line breaks and a
  // naive regex misses them. Strip comment leaders and collapse whitespace.
  const writer = writerRaw.replace(/^\s*\*ical?/gm, '').replace(/^\s*[*/]+/gm, ' ').replace(/\s+/g, ' ')

  test('it says plainly that it is NOT fully idempotent', () => {
    assert.ok(writer.includes('THIS IS NOT FULLY IDEMPOTENT'))
    assert.ok(writer.includes('WHAT IT DOES NOT PREVENT'))
  })

  test('it names both what it prevents and what it does not', () => {
    assert.ok(/sequential duplicates/i.test(writer), 'names what it prevents')
    assert.ok(/concurrent duplicates/i.test(writer), 'names what it does not')
    assert.ok(/no lock, no upsert and no constraint/i.test(writer))
  })

  test('it states why the trade is accepted rather than leaving it implied', () => {
    assert.ok(/duplicate notification is a visible, harmless annoyance/i.test(writer))
    assert.ok(/missing one is the defect/i.test(writer))
  })

  test('it names the migration that would close it, and that it is not here', () => {
    assert.ok(writer.includes('create unique index'))
    assert.ok(writer.includes("where type = 'task_assigned'"))
    assert.ok(/on conflict do nothing/i.test(writer))
    assert.ok(/deliberately NOT part of this hotfix/i.test(writer))
  })

  test('no claim of full idempotency appears anywhere in the change', () => {
    for (const path of [
      'src/lib/tasks/assignmentNotificationWriter.server.ts',
      'src/lib/tasks/assignmentNotification.ts',
      'src/app/api/tasks/[id]/notify-assignment/route.ts',
      'src/components/tasks/AssignmentNotificationNotice.tsx',
    ]) {
      const text = read(path)
      assert.equal(/fully idempotent(?! )/i.test(text.replace(/NOT FULLY IDEMPOTENT/g, '')), false,
        `${path} must not claim full idempotency`)
      assert.equal(/concurrency[- ]safe/i.test(text.replace(/NOT concurrency-safe/gi, '')), false,
        `${path} must not claim concurrency safety`)
    }
  })

  test('an existing notification is success everywhere it is reported', () => {
    // The operation, the route's status map, the browser helper and the copy
    // route must all agree that a row already present is a good outcome.
    assert.ok(writerRaw.includes("return { status: 'skipped_duplicate' }"))
    assert.ok(read('src/lib/tasks/assignmentNotification.ts')
      .includes("status === 'skipped_duplicate'"))
    assert.ok(read('src/app/api/tasks/[id]/copy/route.ts')
      .includes("notified.status === 'skipped_duplicate'"))
  })
})

describe('the one-time retry for the existing task is documented, not coded', () => {
  const RUNBOOK = 'docs/runbooks/retry-one-assignment-notification.md'
  const doc = read(RUNBOOK)

  test('the production task id appears in the runbook', () => {
    assert.ok(doc.includes('87d87668-b434-43b8-a2d6-e94afc4bb855'))
  })

  test('and NOWHERE in application code', () => {
    // A production identifier compiled into the application is a fact that goes
    // stale and needs a deploy to correct. Tests are exempt — THIS file names it
    // in the assertion below, and a test is not shipped, executed against
    // production, or able to act on it.
    const isShipped = (f: string) => !/\.test\.tsx?$/.test(f)
    const offenders: string[] = []
    for (const dir of ['src']) {
      const stack = [join(process.cwd(), dir)]
      while (stack.length) {
        const d = stack.pop()!
        for (const entry of readdirSync(d)) {
          const full = join(d, entry)
          if (statSync(full).isDirectory()) { stack.push(full); continue }
          if (!/\.(ts|tsx)$/.test(full) || !isShipped(full)) continue
          if (readFileSync(full, 'utf8').includes('87d87668-b434-43b8-a2d6-e94afc4bb855')) {
            offenders.push(full)
          }
        }
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('it uses the authenticated route, not a direct SQL insert', () => {
    assert.ok(doc.includes('/notify-assignment'))
    assert.equal(/insert into[\s\S]*notifications/i.test(doc), false,
      'the runbook must not hand anybody a raw INSERT')
  })

  test('it lists the five checks the route makes before writing', () => {
    for (const phrase of [
      'caller is authenticated',
      'task still exists',
      'caller is authorized',
      'recipient is derived from the task',
      'already exists',
    ]) {
      assert.ok(doc.toLowerCase().includes(phrase.toLowerCase()), `missing: ${phrase}`)
    }
  })

  test('it refuses a bulk backfill and says why', () => {
    assert.ok(/No backfill/i.test(doc))
    assert.ok(/unread/i.test(doc), 'names the consequence of one')
  })

  test('nothing in this repository executes it', () => {
    const offenders: string[] = []
    for (const entry of readdirSync(join(process.cwd(), 'scripts'))) {
      const full = join(process.cwd(), 'scripts', entry)
      if (!statSync(full).isFile()) continue
      const text = readFileSync(full, 'utf8')
      if (/notify-assignment|task_assigned/.test(text)) offenders.push(entry)
    }
    assert.deepEqual(offenders, [], 'no script performs the retry or writes assignment rows')
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

  test('the migrations newer than 115 are 116 and 118, and neither touches it', () => {
    const files = readdirSync(join(process.cwd(), 'supabase/migrations'))
      .filter(f => f.endsWith('.sql')).sort()
    const newer = files.filter(f => f.slice(0, 14) > '20261015000000')
    // 117 (Customer Review Outreach), 118 (the Top 3 Focus unpin) and 120 (the
    // Image Editor module registration) came later and none touches task
    // assignment: 117 creates three tables of its own and alters nothing that
    // exists, 118's statements are checked below, and 120 writes only
    // permission_modules and permission_actions rows. All three are named
    // rather than allowed by a loosened rule.
    assert.deepEqual(newer, [
      '20261016000000_notifications_link_activity_log.sql',
      '20261017000000_customer_review_outreach.sql',
      '20261018000000_unpin_tasks_submitted_for_approval.sql',
      '20261020000000_register_image_editor_module.sql',
      '20261021000000_seed_customer_review_test_cards.sql',
      // 122. The Image Editor result history — a bucket, a table and its
      // policies. It creates its own surface and alters nothing that exists,
      // so it reaches neither task assignment nor anything above.
      '20261022000000_image_editor_result_history.sql',
      '20261023000000_review_workflow_ai_drafts.sql',
      // The batch-approval pair, in the order they must apply. The deletion
      // migration runs FIRST so the schema one lands on an empty card table
      // and can enforce its approval invariants without a legacy exemption.
      '20261025000000_review_workflow_remove_legacy_test_data.sql',
      '20261026000000_review_workflow_batch_approval.sql',
      // Provider-call idempotency: a request key is CLAIMED before the model
      // is called, so two simultaneous requests cannot both be billed for.
      '20261027000000_review_workflow_generation_claims.sql',
      // Assets & Access, from a separate branch: the delegated Access Register
      // permission and the asset handover acknowledgement. Neither touches
      // this work's tables, policies or functions.
      '20261028000000_assets_access_manage_access_records.sql',
      '20261029000000_asset_handover_acknowledgement.sql',
    ])
    // 118's statements reach user_top_tasks and read tasks.status. It replaces
    // cleanup_top_tasks_on_completion() and names no health-check object.
    const unpin = read('supabase/migrations/20261018000000_unpin_tasks_submitted_for_approval.sql')
    assert.equal(/run_task_health_check/i.test(unpin), false)
    assert.equal(/assigned_to|assignment/i.test(unpin), false)
    // And 116's STATEMENTS touch only `notifications`. Its commentary cites
    // run_task_health_check as the precedent for not replacing a live function
    // from the repository's copy — prose, not a statement.
    const sql = read('supabase/migrations/20261016000000_notifications_link_activity_log.sql')
    const statements = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    assert.equal(/run_task_health_check|20261015000000/i.test(statements), false)
    assert.match(statements, /ALTER TABLE\s+notifications/i)
  })
})
