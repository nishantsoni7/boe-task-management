/**
 * Task Management: returning to a list costs nothing, and Back always goes
 * somewhere.
 *
 * WHAT THIS PINS, AND WHY EACH ONE WAS A DEFECT.
 *
 *  1. ASSIGNED BY ME re-read itself from scratch on every arrival — an auth
 *     hop, then a task read and an UNFILTERED `users` read — with the whole
 *     page, module shell included, behind `if (loading) return <LoadingScreen/>`.
 *     A Back press from a task did not return to this list, it rebuilt it. The
 *     same shape /tasks/quotation-requests was in before #181.
 *
 *  2. TASK DETAIL'S BACK BUTTON was a bare `router.back()`. A task opened from
 *     a notification in a new tab has no history of its own, so the press did
 *     nothing and the page looked frozen.
 *
 *  3. MARK COMPLETE pushed one of two fixed addresses — so a creator who
 *     completed a task opened from Assigned By Me landed on /tasks/my — and
 *     waited 800ms first for a toast this path never shows.
 *
 *  4. THE LISTS PREFETCHED THE WRONG URL: `/tasks/<id>` while every row opens
 *     `/tasks/<id>?returnTo=…`. The router cache is keyed by the full href, so
 *     fifteen requests per arrival could never be used.
 *
 *  5. THE CREATE FORMS opened their own session and re-read the profile and the
 *     user directory the module shell had already cached, behind a full-screen
 *     loader.
 *
 *  6. /tasks/my INVALIDATED ITS OWN CACHE ON MOUNT, because an effect keyed on
 *     the root-level `refreshKey` runs on mount too — so every arrival issued a
 *     request the 30-second stale window existed to avoid.
 *
 * Behaviour lives in client components of one to three thousand lines, so this
 * file pins the wiring; the pure pieces are tested directly in
 * appHistory.test.ts, taskReturnPath.test.ts and myTaskTabs.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/taskNavigationPerformance.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** Comments explain what a file no longer does — absence checks read code only. */
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const ABM    = codeOf(read('src/app/tasks/assigned-by-me/page.tsx'))
const MY     = codeOf(read('src/app/tasks/my/page.tsx'))
const DETAIL = codeOf(read('src/app/tasks/[id]/page.tsx'))
const CREATE = codeOf(read('src/app/tasks/create/page.tsx'))
const SELF   = codeOf(read('src/app/tasks/create-self/page.tsx'))
const HOOK   = read('src/hooks/queries/useAssignedByMe.ts')

/**
 * The page component's own body, down to the point where the user ACTS.
 *
 * A session read is legitimate at write time — the submit handlers and the
 * Delegate modal re-check that the session is still valid before they write,
 * and #181's predecessors kept that deliberately. What must be gone is the one
 * on the LOAD path, which every arrival paid for before it could draw anything.
 */
const ABM_LOAD    = ABM.slice(ABM.indexOf('function AssignedByMeContent()'), ABM.indexOf('const handleLogout ='))
const CREATE_LOAD = CREATE.slice(CREATE.indexOf('export default function CreateTaskPage()'), CREATE.indexOf('const handleLogout ='))
const SELF_LOAD   = SELF.slice(SELF.indexOf('export default function CreateSelfTaskPage()'), SELF.indexOf('const handleLogout ='))

// ─────────────────────────────────────────────────────────────────────────────

describe('Assigned By Me is a cached list, not a mount-time read', () => {
  test('the rows come from a keyed query with the shared list settings', () => {
    assert.ok(HOOK.includes("export const ASSIGNED_BY_ME_KEY = ['tasks', 'assigned-by'] as const"))
    assert.ok(HOOK.includes('staleTime: 30 * 1000'), 'the same 30s as useMyTasks — a return inside it asks for nothing')
    assert.ok(HOOK.includes('gcTime: 5 * 60 * 1000'))
    assert.ok(ABM.includes('const { data: allTasksRaw = [], isPending: tasksPending } = useAssignedByMe(userId || null)'))
  })

  test('the filters are the page’s old ones, unchanged', () => {
    // Which work this list holds is a business rule, not a performance
    // decision: tasks I created, assigned to somebody who is not me, neither
    // completed nor cancelled. Quotation requests are deliberately NOT excluded
    // here, because they never were.
    for (const clause of [
      ".eq('created_by', userId)",
      ".not('assigned_to', 'is', null)",
      ".neq('assigned_to', userId)",
      ".neq('status', 'completed')",
      ".neq('status', 'cancelled')",
      ".order('due_date', { ascending: true, nullsFirst: false })",
    ]) assert.ok(HOOK.includes(clause), clause)
    assert.equal(HOOK.includes('quotation_request'), false, 'this list never filtered quotations out')
  })

  test('identity is the shared one — no getSession hop before the first read', () => {
    assert.ok(ABM.includes('const { data: loggedInId, isPending: idPending } = useSignedInUserId()'))
    assert.ok(ABM.includes('const userId = viewAsUserId ?? loggedInId ?? \'\''), 'View As still overrides')
    assert.equal(ABM_LOAD.includes('supabase.auth.getSession()'), false)
  })

  test('the whole page no longer blanks — only the rows area waits', () => {
    assert.equal(/if \(loading\) return <LoadingScreen \/>/.test(ABM), false)
    assert.ok(ABM.includes('{!tasksResolved ? (\n              <TaskListSkeleton isMobile={isMobile} />'))
    assert.ok(ABM.includes('const tasksResolved = !tasksPending'),
      'isPending, not isLoading: a query still behind its enabled gate reports isLoading false')
    assert.ok(ABM.includes('<Suspense fallback={<LoadingScreen />}>'), 'the URL-state boundary is still there')
  })

  test('the users read is no longer re-issued on every arrival', () => {
    // The lookup itself is UNCHANGED — still every user, active or not, because
    // the drawer resolves creators, waiting-on people and activity actors from
    // it as well as assignees, and any of them may have been deactivated. Only
    // where it comes from changed: a ten-minute cache instead of a fresh read
    // behind the loader on every visit.
    assert.equal(ABM_LOAD.includes("supabase.from('users').select"), false)
    assert.ok(ABM.includes('const { data: userMap = {} } = useAllUserNames()'))
    const hook = read('src/hooks/queries/useMyTasks.ts')
    const fn = hook.slice(hook.indexOf('export function useAllUserNames()'))
    assert.ok(fn.includes(".select('id, full_name')"))
    assert.equal(/\.eq\('is_active'/.test(fn.slice(0, fn.indexOf('staleTime'))), false,
      'a leaver still has a name')
  })

  test('a signed-out caller is still sent to /login', () => {
    assert.ok(ABM.includes("if (authReady && !loggedInId) router.push('/login')"))
  })
})

describe('mutations mark every list that holds the row', () => {
  test('Task Detail invalidates Assigned By Me as well', () => {
    const fn = DETAIL.slice(DETAIL.indexOf('const invalidateTaskCache ='), DETAIL.indexOf('const invalidateTaskCache =') + 900)
    for (const key of [
      "queryKey: ['tasks', 'assigned-to', assignedTo]",
      "queryKey: ['top-tasks']",
      'queryKey: QUOTATION_REQUESTS_KEY',
      'queryKey: ASSIGNED_BY_ME_KEY',
    ]) assert.ok(fn.includes(key), key)
  })

  test('assigning a task marks the creator’s own list', () => {
    // Otherwise a task assigned here is missing from Assigned By Me for the
    // whole stale window — the list the creator goes to next to check it landed.
    assert.ok(CREATE.includes('queryClient.invalidateQueries({ queryKey: assignedByMeKey(actorId) })'))
  })

  test('delegate, edit and delete from the list mark it too', () => {
    const count = ABM.split('queryKey: assignedByMeKey(userId)').length - 1
    assert.equal(count, 3, 'handleTaskDelegated, handleEditSaved and handleDelete')
  })

  test('a self task still marks the assignee’s My Tasks', () => {
    assert.ok(SELF.includes("queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', task.assigned_to] })"))
  })
})

describe('/tasks/my does not re-read itself merely for mounting', () => {
  test('the refresh effect fires on a real bump, not on arrival', () => {
    assert.ok(MY.includes('const lastRefreshKey = useRef(refreshKey)'))
    assert.ok(MY.includes('if (lastRefreshKey.current === refreshKey) return'))
  })

  test('an explicit Refresh still reaches both keys', () => {
    const fn = MY.slice(MY.indexOf('const lastRefreshKey = useRef(refreshKey)'))
    const body = fn.slice(0, fn.indexOf('}, [refreshKey])'))
    assert.ok(body.includes("queryKey: ['tasks', 'assigned-to', userId]"))
    assert.ok(body.includes("queryKey: ['top-tasks', userId]"))
  })
})

describe('the lists prefetch the URL they will actually open', () => {
  for (const [name, code] of [['/tasks/my', MY], ['/tasks/assigned-by-me', ABM]] as const) {
    test(`${name} warms the href its rows navigate to`, () => {
      assert.ok(code.includes('router.prefetch(taskDetailHref(t.id, returnTo))'))
      assert.equal(code.includes('router.prefetch(`/tasks/${t.id}`)'), false,
        'the router cache is keyed by the full href — a bare path is never the one asked for')
    })
  }
})

describe('the create forms open on caches the module shell has already filled', () => {
  for (const [name, code, load] of [
    ['/tasks/create', CREATE, CREATE_LOAD],
    ['/tasks/create-self', SELF, SELF_LOAD],
  ] as const) {
    test(`${name}: no session hop and no second profile read`, () => {
      assert.ok(code.includes('const { data: signedInUserId, isPending: idPending } = useSignedInUserId()'))
      assert.ok(code.includes('useProfile(signedInUserId)'))
      assert.equal(load.includes('supabase.auth.getSession()'), false)
      assert.equal(code.includes('USER_PROFILE_COLUMNS'), false)
    })

    test(`${name}: the submit handler still re-checks the session before writing`, () => {
      // Opening the form on a cached identity must not weaken the write path:
      // a session can expire while the form is being filled in.
      assert.ok(code.includes('const { data: { session } } = await supabase.auth.getSession()'))
    })

    test(`${name}: both redirects survive`, () => {
      assert.ok(code.includes("if (!idPending && !signedInUserId) { router.push('/login'); return }"))
      assert.ok(code.includes("if (viewAsUserId) router.push('/dashboard')"))
    })
  }

  test('/tasks/create takes the assignee list from the shared directory', () => {
    assert.ok(CREATE.includes('const { data: users = [], isPending: usersPending } = useActiveUsers()'))
    assert.equal(CREATE.includes(".eq('is_active', true).order('full_name')"), false)
  })

  test('the directory carries `team`, which both assignee dropdowns print', () => {
    const hook = read('src/hooks/queries/useMyTasks.ts')
    assert.ok(hook.includes(".select('id, full_name, team')"))
    assert.ok(CREATE.includes('{u.full_name} — {u.team}'))
    assert.ok(ABM.includes('{u.full_name} — {u.team}'))
  })

  test('the forms still wait for what they are about to write with', () => {
    // `team` is copied onto the created task, so drawing the form before the
    // profile resolves would let somebody submit with the placeholder.
    assert.ok(SELF.includes('const initDone = !idPending && (!signedInUserId || !profilePending)'))
    assert.ok(CREATE.includes('const initDone = !idPending && (!signedInUserId || !profilePending) && !usersPending'))
    assert.ok(CREATE.includes("const team = profile?.team ?? 'sales'"))
  })
})

describe('double submission is still impossible', () => {
  test('every create and mutate path holds a ref taken synchronously', () => {
    // A state-only guard loses the race it exists to prevent: two clicks in one
    // frame both read the pre-render value and both pass.
    for (const [name, code] of [['create', CREATE], ['create-self', SELF]] as const) {
      assert.ok(code.includes('const submittingRef = useRef(false)'), name)
      assert.ok(code.includes('guard: submittingRef'), name)
    }
    // The ref is READ AND SET in one synchronous step, before any await — a
    // state-only guard would let two clicks in the same frame both through.
    const flow = read('src/lib/tasks/taskCreateFlow.ts')
    assert.ok(flow.includes("if (steps.guard.current) return { status: 'busy' }"))
    assert.ok(flow.includes('steps.guard.current = true'))
    for (const guard of ['statusUpdatingRef.current', 'acknowledgingRef.current', 'reviewBusyRef.current']) {
      assert.ok(DETAIL.includes(guard), guard)
    }
  })
})

describe('acknowledge, status, complete and reopen all mark the same lists', () => {
  const body = (from: string, to: string) => DETAIL.slice(DETAIL.indexOf(from), DETAIL.indexOf(to))

  for (const [name, from, to] of [
    ['acknowledge',      'const acknowledge = async',       'const applyStatusChange = async'],
    ['status / complete', 'const applyStatusChange = async', 'const submitReturnTimer'],
    ['reopen',           'const handleReopen = async',      'const handleCancelTask = async'],
  ] as const) {
    test(`${name} goes through invalidateTaskCache`, () => {
      assert.ok(body(from, to).includes('invalidateTaskCache(task.assigned_to)'), name)
    })
  }

  test('cached rows are INVALIDATED, never removed', () => {
    // Removing would empty the list the reader is about to land on and put the
    // loader back — the whole point is that the rows stay on screen while the
    // correction arrives behind them.
    assert.equal(/queryClient\.(removeQueries|resetQueries)\(/.test(DETAIL), false)
    assert.equal(/queryClient\.(removeQueries|resetQueries)\(/.test(ABM), false)
  })
})

describe('a failed write neither navigates nor claims success', () => {
  test('Mark Complete returns before the navigation when the update fails', () => {
    const apply = DETAIL.slice(DETAIL.indexOf('const applyStatusChange = async'), DETAIL.indexOf('const submitReturnTimer'))
    const failed = apply.indexOf("window.alert('Failed to update task status. Please try again.')")
    assert.ok(failed > 0)
    assert.ok(apply.slice(failed, failed + 120).includes('return'), 'the alert is followed by a return')
    assert.ok(failed < apply.indexOf('router.push(dest)'), 'the failure path is reached first')
  })

  test('Reopen returns before it rewrites the status locally', () => {
    const reopen = DETAIL.slice(DETAIL.indexOf('const handleReopen = async'), DETAIL.indexOf('const handleCancelTask = async'))
    assert.ok(reopen.indexOf("window.alert('Failed to reopen task. Please try again.')") < reopen.indexOf('setTask({ ...task, status: restored })'))
  })
})

describe('Quotation Requests navigation is untouched', () => {
  test('its list and its new-request page are not edited by this change', () => {
    const qtn = read('src/app/tasks/quotation-requests/page.tsx')
    assert.ok(qtn.includes('useQuotationRequests('), '#181’s cached read is still the one in use')
    assert.ok(qtn.includes('router.push(taskDetailHref(task.id, returnTo))'))
  })

  test('a quotation still invalidates its own key on every task mutation', () => {
    assert.ok(DETAIL.includes('queryClient.invalidateQueries({ queryKey: QUOTATION_REQUESTS_KEY })'))
  })

  test('a quotation opened directly still falls back to the quotation list', () => {
    // defaultTaskListPath, not a hard-coded /tasks/my — pinned in
    // taskReturnPath.test.ts for the value, here for the two call sites.
    assert.ok(DETAIL.includes('defaultTaskListPath(task.task_type)'), 'Mark Complete')
    assert.ok(DETAIL.includes('defaultTaskListPath(task?.task_type)'), 'Submit for Approval')
    assert.ok(DETAIL.includes('taskType:     task?.task_type,'), 'the Back control')
  })
})

// ─── Behaviour audit ─────────────────────────────────────────────────────────
// The checklist this branch was reviewed against. Every one of these is a
// property the performance work had to LEAVE ALONE, pinned here so a later
// change to the same files cannot quietly take it away.

describe('the rules this branch must not have touched', () => {
  const modal = DETAIL.slice(DETAIL.indexOf("if (modalStatus === 'waiting') {"))

  test('Waiting still refuses to save without the information it requires', () => {
    const guard = modal.indexOf("if (!filled) { setWaitingOnError(true); return }")
    assert.ok(guard > 0, 'the required-information guard is still there')
    assert.ok(modal.includes("const filled = waitingOnType === 'team_member' ? !!waitingOnUserId : !!waitingOnText.trim()"))
    assert.ok(guard < modal.indexOf("supabase.from('tasks').update(updates)"),
      'it refuses BEFORE the write, not after')
  })

  test('Waiting still records who or what is being waited on', () => {
    for (const field of [
      'waiting_on_type:    waitingOnType,',
      "waiting_on_user_id: waitingOnType === 'team_member' ? (waitingOnUserId || null) : null,",
      "waiting_on_text:    waitingOnType === 'external' ? (waitingOnText.trim() || null) : null,",
    ]) assert.ok(modal.includes(field), field)
  })

  test('Blocked still carries its reason, and leaving a status still clears it', () => {
    const apply = DETAIL.slice(DETAIL.indexOf('const applyStatusChange = async'), DETAIL.indexOf('const submitReturnTimer'))
    assert.ok(apply.includes("if (newStatus === 'blocked')   updates.blocker_reason = reason"))
    assert.ok(apply.includes("if (oldStatus === 'blocked' && newStatus !== 'blocked') updates.blocker_reason = null"))
    assert.ok(apply.includes("if (oldStatus === 'waiting' && newStatus !== 'waiting') {"))
  })

  test('every status change still writes its audit row', () => {
    // The activity log is the accountability record. A performance change that
    // dropped it, or moved it after the user was told the change succeeded,
    // would be a correctness regression wearing a speed costume.
    const apply = DETAIL.slice(DETAIL.indexOf('const applyStatusChange = async'), DETAIL.indexOf('const submitReturnTimer'))
    const logAt = apply.indexOf("supabase.from('task_activity_log').insert({")
    assert.ok(logAt > 0)
    assert.ok(logAt < apply.indexOf('setTask({ ...task, ...localPatch })'),
      'the audit row is written before the screen says it worked')
    assert.ok(logAt < apply.indexOf('router.push(dest)'), 'and before any navigation')
    assert.ok(modal.includes("action: 'status_changed', from_status: task.status, to_status: 'waiting'"),
      'the Waiting path keeps its own audit row')
  })

  test('acknowledgement still writes both rows and is still guarded', () => {
    const ack = DETAIL.slice(DETAIL.indexOf('const acknowledge = async'), DETAIL.indexOf('const applyStatusChange = async'))
    assert.ok(ack.includes('if (acknowledgingRef.current) return'))
    assert.ok(ack.includes("action: 'acknowledged'"))
    assert.ok(ack.includes("to_status: 'working'"))
  })
})

describe('completing returns to the list it was opened from', () => {
  // Both lists hand Task Detail their own view, so Mark Complete's
  // returnPathFromSearch resolves to whichever one the reader actually used.
  // The destination is therefore decided by the opener, not by the task type.
  for (const [name, code] of [
    ['/tasks/my', MY],
    ['/tasks/assigned-by-me', ABM],
  ] as const) {
    test(`${name} attaches its own view to the task link`, () => {
      assert.ok(code.includes('const returnTo = useCurrentReturnPath()'))
      assert.ok(code.includes('taskDetailHref(selectedTask.id, returnTo)'))
    })
  }

  test('Assigned by Me also attaches it to the row action', () => {
    // My Tasks opens through the drawer only; Assigned by Me has a row button
    // too, and it must carry the same view or completing from it would land
    // the creator somewhere else.
    assert.ok(ABM.includes('onView={() => router.push(taskDetailHref(task.id, returnTo))}'))
  })

  test('and Mark Complete reads exactly that value back', () => {
    assert.ok(DETAIL.includes('const dest = returnPathFromSearch(window.location.search) ?? defaultTaskListPath(task.task_type)'))
  })
})

describe('the create forms do not navigate — the list they return to is corrected instead', () => {
  // Neither form pushes a list on save; both show a success banner and stay put,
  // which is unchanged. What this branch had to get right is that the list is
  // correct WHENEVER the reader goes back to it, by whatever route.
  for (const [name, code] of [['create-self', SELF], ['create', CREATE]] as const) {
    test(`${name} still stays on the page after saving`, () => {
      const submit = code.slice(code.indexOf('setCreatedId(task.id)'), code.indexOf('setCreatedId(task.id)') + 200)
      assert.ok(submit.includes('setSuccess(true)'))
      assert.equal(/router\.push\('\/tasks\//.test(submit), false, 'no automatic navigation was added')
    })
  }

  test('a self task corrects My Tasks', () => {
    assert.ok(SELF.includes("queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', task.assigned_to] })"))
  })

  test('an assigned task corrects both the assignee’s list and the creator’s', () => {
    assert.ok(CREATE.includes("queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', task.assigned_to] })"))
    assert.ok(CREATE.includes('queryClient.invalidateQueries({ queryKey: assignedByMeKey(actorId) })'))
  })
})
