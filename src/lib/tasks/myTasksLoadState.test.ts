/**
 * My Tasks: the loading sequence, and where Awaiting Approval sits in the UI.
 *
 * THE DEFECT. Opening My Tasks showed "No active tasks" for about three
 * seconds and then the tasks appeared. The gate was
 *
 *     const loading = !loggedInId && tasksLoading && allTasksRaw.length === 0
 *
 * which could never be true after mount. On the first render `loggedInId` was
 * '' so the task query was DISABLED — and a disabled TanStack query reports
 * `isLoading: false`, because nothing is fetching — so the middle term was
 * false. One render later `loggedInId` was set and the first term was false.
 * There was no loading state at all: the page rendered its empty state while
 * the auth hop and then the task fetch ran.
 *
 * Behaviour lives in a 1700-line client component, so tab membership itself is
 * tested directly in myTaskTabs.test.ts and this file pins the wiring that
 * decides WHEN the page is allowed to claim there is nothing to do.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/myTasksLoadState.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MY_TASK_TAB_LABELS, AWAITING_APPROVAL_LABEL } from './myTaskTabs'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Comments explain what the file no longer does — absence checks read code only. */
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const PAGE      = read('src/app/tasks/my/page.tsx')
const PAGE_CODE = codeOf(PAGE)
/** The page component's own body — the modals below it legitimately talk to Supabase. */
const CONTENT_CODE = PAGE_CODE.slice(PAGE_CODE.indexOf('function MyTasksContent()'))
const HOOK      = read('src/hooks/queries/useMyTasks.ts')

// ── 1. No false empty state ─────────────────────────────────────────────────

describe('the empty state waits for the query', () => {
  test('the broken gate is gone', () => {
    assert.equal(
      PAGE_CODE.includes('!loggedInId && tasksLoading && allTasksRaw.length === 0'), false,
      'that expression can never be true after mount',
    )
  })

  test('the skeleton gate reads isPending', () => {
    assert.ok(PAGE_CODE.includes('isPending: tasksPending'))
    assert.ok(PAGE_CODE.includes('const tasksResolved = !tasksPending'))
    assert.ok(PAGE_CODE.includes('const showListSkeleton = !tasksResolved'))
  })

  test('the skeleton branch is chosen before the empty state can be', () => {
    const skeletonAt = PAGE_CODE.indexOf('showListSkeleton ? (')
    const emptyAt    = PAGE_CODE.indexOf('<EmptyState label=')
    assert.ok(skeletonAt > -1, 'a skeleton branch exists')
    assert.ok(emptyAt > -1,    'the empty state still exists')
    assert.ok(skeletonAt < emptyAt, 'EmptyState must be unreachable until the query resolves')
  })

  test('a genuinely empty result still shows the empty state', () => {
    // Same expression as before, now reached only once tasksResolved is true.
    assert.ok(PAGE_CODE.includes('visibleTasks.length === 0 ? ('))
    assert.ok(PAGE_CODE.includes("<EmptyState label={activeTab ? TAB_LABELS[activeTab] : 'active'} />"))
  })

  test('the loading state is compact and layout-stable, not a blanked page', () => {
    assert.ok(PAGE_CODE.includes('function TaskListSkeleton'))
    assert.ok(PAGE.includes('aria-busy="true"'))
    assert.ok(PAGE.includes('aria-label="Loading tasks"'))
    // The full-screen loader inside the content component is gone; the one that
    // remains is the route-level Suspense fallback, which is a different thing.
    assert.equal(/if \(loading\) return <LoadingScreen \/>/.test(PAGE_CODE), false)
    assert.ok(PAGE_CODE.includes('<Suspense fallback={<LoadingScreen />}>'))
  })

  test('cached tasks render immediately — isPending is false as soon as data exists', () => {
    // The cache window that makes a return visit instant.
    assert.ok(HOOK.includes('staleTime: 30 * 1000'))
    assert.ok(HOOK.includes('gcTime: 5 * 60 * 1000'))
    assert.ok(HOOK.includes("queryKey: ['tasks', 'assigned-to', userId]"))
  })
})

// ── 2. The sequential auth/profile chain is gone ────────────────────────────

describe('identity is resolved once, and shared', () => {
  test('the page no longer runs its own session lookup before it can query', () => {
    // Scoped to the page component: the Create Self Task modal still checks the
    // session inside its submit handler, which is not on any load path.
    assert.equal(CONTENT_CODE.includes('supabase.auth.getSession()'), false,
      'awaiting a session before enabling the task query is the first of the three serial steps')
    assert.equal(PAGE_CODE.includes('setLoggedInId'), false,
      'no page-local identity state gating the task query')
  })

  test('the profile read is served from the cache the shell already filled', () => {
    // /tasks/my sits under src/app/tasks/layout.tsx's ModuleGuard, which
    // resolves the permission context in a PARENT and publishes the users row
    // into useProfile's cache entry — so this mount issues nothing.
    const guardLayout = read('src/app/tasks/layout.tsx')
    assert.ok(guardLayout.includes('ModuleGuard'))
    const ctx = read('src/hooks/queries/usePermissionContext.ts')
    assert.ok(ctx.includes('publishProfile(qc, userId, profile)'))
    assert.ok(read('src/hooks/queries/useProfile.ts').includes('queryKey: profileKey(userId)'))
  })

  test('it reads identity from the shared session query', () => {
    assert.ok(PAGE_CODE.includes('useSignedInUserId'))
    assert.ok(PAGE_CODE.includes('const { data: loggedInId, isPending: idPending } = useSignedInUserId()'))
    // And does NOT drag the permission resolution along with it.
    assert.equal(PAGE_CODE.includes('usePermissionContext('), false)
  })

  test('a signed-out visitor is still sent to /login, but only once resolved', () => {
    assert.ok(PAGE_CODE.includes("if (authReady && !loggedInId) router.push('/login')"))
  })

  test('View As still overrides whose tasks are shown', () => {
    assert.ok(PAGE_CODE.includes('const userId = viewAsUserId ?? loggedInId'))
    assert.ok(PAGE_CODE.includes("if (viewAsUserId && profile && profile.role !== 'admin')"))
  })
})

// ── 3. One fetch, every tab ─────────────────────────────────────────────────

describe('tabs filter already-fetched data', () => {
  test('the page fetches the task collection exactly once', () => {
    assert.equal((PAGE_CODE.match(/useMyTasks\(/g) ?? []).length, 1)
  })

  test('buckets are one pass over that collection', () => {
    assert.ok(PAGE_CODE.includes('buildMyTaskBuckets(baseTasks, MY_TASK_CLOCK)'))
    assert.ok(PAGE_CODE.includes('countMyTaskBuckets(buckets)'))
  })

  test('switching tabs only changes URL state — it starts no request', () => {
    assert.ok(PAGE_CODE.includes('function handleTabChange'))
    assert.ok(PAGE_CODE.includes("setState({ tab: key, q: '', priority: '' })"))
    const fn = PAGE_CODE.slice(PAGE_CODE.indexOf('function handleTabChange'))
      .slice(0, PAGE_CODE.slice(PAGE_CODE.indexOf('function handleTabChange')).indexOf('\n  }') + 4)
    assert.equal(/fetch\(|supabase\.|refetch\(/.test(fn), false,
      'a tab change must not trigger a fetch')
  })

  test('the visible list is derived from the buckets, not re-queried', () => {
    assert.ok(PAGE_CODE.includes('let tasks = activeTab === null ? buckets.all : buckets[activeTab]'))
  })

  test('the assignee scope is still enforced by the query itself', () => {
    assert.ok(HOOK.includes(".eq('assigned_to', userId)"))
    assert.ok(HOOK.includes(".neq('status', 'cancelled')"))
    assert.ok(HOOK.includes(".neq('task_type', 'quotation_request')"))
    assert.ok(HOOK.includes('enabled: isValidUUID(userId)'),
      'no request is made for a non-UUID or absent user')
  })

  test('search, priority and assigner filters are preserved', () => {
    assert.ok(PAGE_CODE.includes('if (filterAssignedBy) tasks = tasks.filter(t => t.created_by === filterAssignedBy)'))
    assert.ok(PAGE_CODE.includes('if (filterPriority) tasks = tasks.filter(t => t.priority === filterPriority)'))
    assert.ok(PAGE_CODE.includes('tasks = tasks.filter(t => t.title.toLowerCase().includes(q))'))
  })
})

// ── 4. Awaiting Approval in the UI ──────────────────────────────────────────

describe('the Awaiting Approval tab', () => {
  test('it is offered in the view-tab strip with a count badge', () => {
    assert.ok(PAGE_CODE.includes("{ key: 'awaiting_approval',  label: AWAITING_APPROVAL_LABEL"))
    // The strip renders counts[tab.key] for every entry, so the badge is the
    // same mechanism as every other tab's.
    assert.ok(PAGE_CODE.includes('{counts[tab.key]}'))
  })

  test('its label is the shared constant, so the tab and the row badge agree', () => {
    assert.equal(MY_TASK_TAB_LABELS.awaiting_approval, AWAITING_APPROVAL_LABEL)
    assert.ok(PAGE_CODE.includes('isAwaitingApproval(task) ? AWAITING_APPROVAL_LABEL : taskStatusLabel(task.status, '))
  })

  test('rows carry no action that is not the user’s to take', () => {
    // Pinning to Today's Focus promises an action; a submitted task has none.
    assert.ok(PAGE_CODE.includes('!isAwaitingApproval(task)\n                        ? () => handlePin(task) : undefined'))
    // Edit and delete were already creator-only (`isSelf`), and a task awaiting
    // approval is by definition delegated, so neither is offered.
    assert.ok(PAGE_CODE.includes('onEdit={!viewAsUserId && task.created_by === userId'))
    assert.ok(PAGE_CODE.includes('onDelete={!viewAsUserId && task.created_by === userId'))
  })

  test('clicking still opens the task', () => {
    assert.ok(PAGE_CODE.includes('onClick={() => setSelectedTask(prev => prev?.id === task.id ? null : task)}'))
    assert.ok(PAGE_CODE.includes('router.push(`/tasks/${selectedTask.id}`)'))
  })

  test('an approval decision re-places the task immediately', () => {
    // The task detail page invalidates exactly the key this page reads, so the
    // next render re-buckets from fresh data with no extra wiring.
    const detail = read('src/app/tasks/[id]/page.tsx')
    assert.ok(detail.includes("queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', assignedTo] })"))
    assert.ok(detail.includes("supabase.rpc('transition_task_review'"))
  })

  test('the approver’s own review queue is untouched', () => {
    const byMe = read('src/app/tasks/assigned-by-me/page.tsx')
    assert.ok(byMe.includes("for_approval:   sort(allTasks.filter(t => t.status === 'pending_approval'))"),
      'the creator still reviews from their own For Approval tab')
  })
})
