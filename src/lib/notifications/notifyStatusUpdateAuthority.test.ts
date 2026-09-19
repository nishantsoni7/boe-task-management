/**
 * WHAT /api/notify-status-update IS STILL WILLING TO BELIEVE.
 *
 * The route authenticates the caller, but it used to take the RECIPIENT, the
 * task's name, the actor's name and even the finished headline straight from
 * the request body and store them verbatim. Any authenticated user could
 * therefore POST a notification to anybody, with text of their choosing,
 * signed with somebody else's name. The actor was never spoofable — that comes
 * from `auth.uid()` — but nothing else was checked.
 *
 * These pin the shape of the fix, because the failure is silent: a route that
 * quietly starts trusting `body.title` again looks and behaves exactly like one
 * that does not, right up until somebody uses it.
 *
 * WHY SOURCE-CONTRACT AND NOT BEHAVIOURAL. The route builds two Supabase
 * clients at module scope inside the handler and returns NextResponse; the
 * repository's established way to hold a route to a rule is to read it, as
 * taskAssignmentRegression.test.ts and notificationSelfNotify.test.ts already
 * do for this same file.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/notifyStatusUpdateAuthority.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTE_PATH = 'src/app/api/notify-status-update/route.ts'
const ROUTE = readFileSync(join(process.cwd(), ROUTE_PATH), 'utf8')

/** The destructure of the request body — the complete list of what is read. */
const BODY_DESTRUCTURE = ROUTE.slice(
  ROUTE.indexOf('const {', ROUTE.indexOf('await req.json') - 900),
  ROUTE.indexOf('await req.json()'),
)

describe('the request body may name the event, never assert a fact', () => {
  for (const field of ['taskTitle', 'notifTitle', 'actorName']) {
    test(`${field} is not read from the request body`, () => {
      assert.equal(BODY_DESTRUCTURE.includes(field), false,
        `${field} must come from the database, not the caller`)
    })
  }

  test('the headline is always composed, never accepted', () => {
    // `title: notifTitle` was the whole attacker-controlled-headline hole.
    assert.equal(/notifTitle\s*\?\?/.test(ROUTE), false, 'no caller-supplied title survives')
    assert.ok(ROUTE.includes('const title = composeTitle(action, actorName'),
      'the sentence is built here from the action and the resolved actor')
  })

  test('the body is the task’s own name', () => {
    assert.ok(ROUTE.includes('body:         task.title'))
    assert.equal(/body:\s*taskTitle/.test(ROUTE), false)
  })

  test('the actor name is resolved from the authenticated id, not sent', () => {
    assert.ok(ROUTE.includes(".from('users').select('full_name').eq('id', user.id)"),
      'one column, keyed by auth.uid()')
    // Several `users` columns are column-granted, so a wildcard read is a 42501
    // rather than a leak — still, never ask. Matched as a CALL (leading dot) so
    // the prose warning about it in the route does not satisfy the check.
    assert.equal(/\.select\('\*'\)/.test(ROUTE), false)
  })
})

describe('the CALLER must be a party to the task', () => {
  test('participation is an identity comparison against the stored row', () => {
    assert.ok(ROUTE.includes('user.id === task.created_by || user.id === task.assigned_to'),
      'both sides come from the task, never from the request')
  })

  test('a non-participant is rejected BEFORE anything is inserted', () => {
    const gate = ROUTE.indexOf('if (!callerIsParticipant)')
    // The CALL, not the import at the top of the file.
    const insert = ROUTE.indexOf('await insertUserNotifications(supabase,')
    assert.ok(gate > 0, 'the gate exists')
    assert.ok(insert > 0, 'the write exists')
    assert.ok(gate < insert, 'and it returns before the write is even reached')
    // Also before the caller's own requested values are consulted at all.
    assert.ok(gate < ROUTE.indexOf('const notifyUserId ='), 'before the recipient is resolved')
    assert.ok(gate < ROUTE.indexOf('const title = composeTitle'), 'before the action is used')
  })

  test('it refuses with 403 and logs who tried it, on which task', () => {
    assert.ok(ROUTE.includes('[notify-status-update] caller is not a party to the task'))
    const logAt = ROUTE.indexOf('caller is not a party to the task')
    const after = ROUTE.slice(logAt, logAt + 200)
    assert.match(after, /caller: user\.id/, 'the authenticated id is logged')
    assert.match(after, /taskId/, 'and the task id')
    assert.match(after, /\{ status: 403 \}/)
  })

  test('the refusal reveals nothing about the task', () => {
    const logAt = ROUTE.indexOf('caller is not a party to the task')
    const body = ROUTE.slice(logAt, ROUTE.indexOf('const notifyUserId ='))
    assert.ok(body.includes("{ error: 'Forbidden' }"), 'a bare refusal')
    for (const leak of ['task.title', 'task.created_by', 'task.assigned_to']) {
      assert.equal(body.includes(`${leak},`) || body.includes(`${leak} }`), false,
        `the response must not carry ${leak}`)
    }
  })

  test('a creator and an assignee both remain allowed', () => {
    // The gate is a disjunction, so neither party is excluded. Asserted as
    // source because both sides must be OR-ed, not AND-ed — an `&&` here would
    // lock out every caller and is the obvious way to get this wrong.
    assert.ok(ROUTE.includes('user.id === task.created_by || user.id === task.assigned_to'))
    assert.equal(/user\.id === task\.created_by &&\s*user\.id === task\.assigned_to/.test(ROUTE), false,
      'must not require being BOTH parties')
  })
})

describe('the recipient is checked against the stored task', () => {
  test('both sides of the task are read from the row', () => {
    assert.ok(ROUTE.includes(".from('tasks').select('created_by, assigned_to, title').eq('id', taskId)"))
  })

  test('a recipient who is neither party is refused with 403, and logged', () => {
    assert.ok(ROUTE.includes('notifyUserId !== task.created_by && notifyUserId !== task.assigned_to'),
      'membership is an identity comparison against the stored row')
    assert.ok(ROUTE.includes("{ status: 403 }"), 'refused outright')
    assert.ok(ROUTE.includes('[notify-status-update] recipient not a party to the task'),
      'and the attempt is visible: no legitimate caller can reach this branch')
    // The log must name who tried it, or it cannot be followed up.
    assert.ok(/caller: user\.id/.test(ROUTE))
  })

  test('a missing task is a 404, not a notification about nothing', () => {
    assert.ok(ROUTE.includes('if (!task) {'))
    assert.ok(ROUTE.includes("{ status: 404 }"))
  })

  test('taskId is validated before it is used to read anything', () => {
    assert.ok(ROUTE.includes('if (!taskId || !isValidUUID(taskId))'))
    assert.ok(ROUTE.indexOf('isValidUUID(taskId)') < ROUTE.indexOf(".from('tasks')"),
      'checked BEFORE the lookup, not after')
  })
})

describe('the rules that already held still hold', () => {
  test('the actor is the authenticated user and nothing else', () => {
    assert.ok(ROUTE.includes('auth.getUser()'))
    assert.ok(ROUTE.includes('{ actorId: user.id }'), 'the shared guard is given the real actor')
  })

  test('self-notification is still skipped as a success', () => {
    assert.ok(ROUTE.includes('if (notifyUserId === user.id)'))
    assert.ok(ROUTE.includes('{ skipped: true }'))
  })

  test('the activity link is still verified, never trusted', () => {
    assert.ok(ROUTE.includes('verifyActivityBelongsToTask(supabase, activityLogId, taskId)'))
    assert.ok(ROUTE.includes('activity_log_id: linkedActivityId'))
    assert.equal(/activity_log_id:\s*activityLogId\b/.test(ROUTE), false)
  })

  test('the write still goes through the one shared funnel', () => {
    assert.ok(ROUTE.includes('insertUserNotifications'))
    assert.equal(/\.from\('notifications'\)\s*\.insert/.test(ROUTE), false)
  })
})

describe('no caller is broken by the tightening', () => {
  // The fix is only safe because every real call site already sends a
  // recipient that IS a party to the task. If one ever stops doing so it must
  // fail here, loudly, rather than in production with a 403.
  const CALLERS = [
    'src/app/dashboard/page.tsx',
    'src/app/tasks/my/page.tsx',
    'src/app/tasks/[id]/page.tsx',
  ]

  test('every caller derives its recipient from the task, not from a constant', () => {
    for (const path of CALLERS) {
      const src = readFileSync(join(process.cwd(), path), 'utf8')
      const derives = /created_by \? task\.assigned_to : task\.created_by/.test(src)
        || /createdBy: (task|selectedTask)\.created_by/.test(src)
      assert.ok(derives, `${path}: recipient must come from the task row`)
    }
  })

  test('the caller-participation rule only mirrors a gate the client already applies', () => {
    // THIS IS WHY NO CALL SITE CHANGES. The server now demands what
    // canPostUpdate already demands, so every action that can reach the route
    // was already restricted to the two parties. If an admin exception is ever
    // added to the client gate, this fails — and it should, because the server
    // would then start refusing a call the UI had just offered.
    const access = readFileSync(join(process.cwd(), 'src/lib/tasks/taskDetailAccess.ts'), 'utf8')
    const fn = access.slice(access.indexOf('export function canPostUpdate'),
                            access.indexOf('export function canMarkComplete'))
    assert.ok(fn.includes('task.assigned_to === userId'), 'the assignee may act')
    assert.ok(fn.includes('task.created_by  === userId'), 'and the creator')
    assert.ok(fn.includes('return (isAssignee || isCreator)'),
      'and nobody else — no admin exception the server would now refuse')
  })

  test('the other entry points are assignee-only, so they too are participants', () => {
    for (const [path, guard] of [
      ['src/app/dashboard/page.tsx', 'task.assigned_to !== currentUserId'],
      ['src/app/tasks/my/page.tsx', 'selectedTask.assigned_to !== userId'],
      ['src/app/tasks/[id]/page.tsx', 'task.assigned_to !== currentUserId'],
    ] as const) {
      const src = readFileSync(join(process.cwd(), path), 'utf8')
      assert.ok(src.includes(guard), `${path}: acknowledge is gated to the assignee`)
    }
  })

  test('no caller sends a field the route no longer reads', () => {
    for (const path of CALLERS) {
      const src = readFileSync(join(process.cwd(), path), 'utf8')
      const calls = src.split('/api/notify-status-update').slice(1)
      for (const call of calls) {
        const payload = call.slice(0, call.indexOf('}),'))
        assert.equal(/\btitle:\s/.test(payload), false,
          `${path}: the title override is gone from the route`)
      }
    }
  })
})
