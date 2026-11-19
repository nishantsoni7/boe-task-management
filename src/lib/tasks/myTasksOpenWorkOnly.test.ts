/**
 * My Tasks opens sooner: the list reads open work only, and Top 3 is one request.
 *
 * THE PREMISE, proved rather than assumed. The list used to read every task a
 * person ever finished, although no tab, count or row on My Tasks draws one
 * (the `completed` bucket is never rendered; the sidebar's "Completed" entry
 * opens /tasks/my/completed, which pages its history from the database). The
 * first test builds the page's buckets from a mixed list and from the same
 * list without its completed rows and requires every tab and count the page
 * draws to be identical.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/myTasksOpenWorkOnly.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from '@/lib/types'
import { shapeTopTasks, type TopTaskPinRow } from '@/hooks/queries/useTopTasks'
import {
  MY_TASK_TAB_KEYS, buildMyTaskBuckets, countMyTaskBuckets, countTaskTypeWorkload,
} from './myTaskTabs'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const PAGE_CODE = codeOf(read('src/app/tasks/my/page.tsx'))
const LIST_HOOK = codeOf(read('src/hooks/queries/useMyTasks.ts'))
const TOP_HOOK  = codeOf(read('src/hooks/queries/useTopTasks.ts'))

const ME = '6507df9f-cdeb-4ebd-849f-8498c165d596'
const BOSS = '11111111-1111-4111-8111-111111111111'
const CLOCK = { todayStr: '2026-11-19', nowMs: Date.parse('2026-11-19T10:00:00Z') }

function task(id: string, status: string, over: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, status, priority: 'medium', is_urgent: false,
    due_date: '2026-11-19', acknowledged_at: '2026-11-18T09:00:00Z',
    created_at: '2026-11-01T09:00:00Z', last_update_at: '2026-11-18T09:00:00Z',
    assigned_to: ME, created_by: BOSS, ...over,
  } as unknown as Task
}

const OPEN: Task[] = [
  task('a', 'pending'),
  task('b', 'started', { due_date: '2026-11-10', is_urgent: true }),
  task('c', 'working', { due_date: '2026-11-25' }),
  task('d', 'waiting'),
  task('e', 'blocked'),
  task('f', 'pending_approval'),
  task('g', 'working', { created_by: ME, acknowledged_at: null as unknown as string }),
]
const FINISHED: Task[] = [
  task('x1', 'completed', { due_date: '2026-10-01' }),
  task('x2', 'completed', { due_date: '2026-11-19', is_urgent: true }),
  task('x3', 'completed', { due_date: null as unknown as string }),
]

describe('the list reads open work only', () => {
  test('dropping completed tasks changes no tab, count or sidebar number the page draws', () => {
    const withFinished = buildMyTaskBuckets([...OPEN, ...FINISHED], CLOCK)
    const openOnly     = buildMyTaskBuckets(OPEN, CLOCK)

    for (const key of MY_TASK_TAB_KEYS) {
      if (key === 'completed') continue
      assert.deepEqual(openOnly[key].map(t => t.id), withFinished[key].map(t => t.id), `tab ${key}`)
    }
    const a = countMyTaskBuckets(withFinished)
    const b = countMyTaskBuckets(openOnly)
    for (const key of MY_TASK_TAB_KEYS) {
      if (key !== 'completed') assert.equal(b[key], a[key], `badge ${key}`)
    }
    assert.deepEqual(
      countTaskTypeWorkload(OPEN, ME),
      countTaskTypeWorkload([...OPEN, ...FINISHED], ME),
      'the Task Type sidebar counts open work only',
    )
    // The one thing that does change is the bucket nothing draws.
    assert.equal(withFinished.completed.length, 3)
    assert.equal(openOnly.completed.length, 0)
  })

  test('the hook asks for neither cancelled nor completed rows', () => {
    assert.ok(LIST_HOOK.includes(".neq('status', 'cancelled')"))
    assert.ok(LIST_HOOK.includes(".neq('status', 'completed')"))
  })

  test('the page never draws the completed bucket or its count', () => {
    assert.equal(/buckets\.completed|counts\.completed/.test(PAGE_CODE), false)
    const strip = read('src/components/tasks/MyTaskViewTabs.tsx')
    assert.equal(/key: 'completed'/.test(strip), false, 'no Completed tab in the strip')
  })

  test('nothing in the app links to My Tasks with ?tab=completed', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue
        const code = codeOf(read(rel))
        if (/\/tasks\/my\?[^'"`\s]*tab=completed|tab: 'completed'/.test(code)) offenders.push(rel)
      }
    }
    walk('src')
    assert.deepEqual(offenders, [], 'the finished history is /tasks/my/completed')
  })

  test('an old ?tab=completed bookmark goes to the paged history, behind the skeleton', () => {
    assert.ok(PAGE_CODE.includes("const sentToCompletedHistory = activeTab === 'completed'"))
    assert.ok(PAGE_CODE.includes("if (sentToCompletedHistory) router.replace('/tasks/my/completed')"))
    assert.ok(PAGE_CODE.includes('const showListSkeleton = !tasksResolved || sentToCompletedHistory'))
  })
})

describe('Top 3 is one request', () => {
  const t = (id: string) => ({ id, title: id } as unknown as Task)

  test('every pin counts as pinned; only pins whose task qualifies are tasks, in order', () => {
    const rows: TopTaskPinRow[] = [
      { task_id: 'a', display_order: 1, tasks: t('a') },
      { task_id: 'b', display_order: 2, tasks: null },
      { task_id: 'c', display_order: 3, tasks: t('c') },
    ]
    const out = shapeTopTasks(rows)
    assert.deepEqual([...out.pinnedIds], ['a', 'b', 'c'])
    assert.ok(out.pinnedIds.has('b'), 'a pin whose task is filtered out still counts as pinned')
    assert.deepEqual(out.tasks.map(x => x.id), ['a', 'c'])
  })

  test('no pins is an empty answer, not an error', () => {
    const out = shapeTopTasks([])
    assert.equal(out.pinnedIds.size, 0)
    assert.deepEqual(out.tasks, [])
  })

  test('the hook reads pins and tasks in ONE request, filtered on the embedded task', () => {
    assert.equal((TOP_HOOK.match(/\.from\(/g) ?? []).length, 1, 'one request')
    assert.ok(TOP_HOOK.includes(".from('user_top_tasks')"))
    assert.equal(TOP_HOOK.includes(".from('tasks')"), false, 'no second read of tasks')
    assert.ok(TOP_HOOK.includes('tasks!task_id('), 'tasks embedded through user_top_tasks.task_id')
    assert.ok(TOP_HOOK.includes(".not('tasks.status', 'eq', 'completed')"))
    assert.ok(TOP_HOOK.includes(".neq('tasks.status', 'cancelled')"))
    assert.ok(TOP_HOOK.includes(".neq('tasks.status', 'pending_approval')"))
    assert.equal(TOP_HOOK.includes('!inner'), false,
      'an inner join would drop the pin of a task that no longer qualifies from pinnedIds')
    assert.ok(TOP_HOOK.includes(".order('display_order', { ascending: true })"))
    assert.ok(TOP_HOOK.includes(".eq('user_id', userId)"))
  })

  test('a failed read rejects instead of being cached as "nothing is pinned"', () => {
    assert.ok(TOP_HOOK.includes('if (error) throw error'))
  })
})
