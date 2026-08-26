// THE ASSIGNEE LOOKUP — batched, bounded, and never the latest actor.
//
// Run:
//   npx tsx --test src/lib/notifications/taskAssignees.test.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  collectTaskIds,
  assigneeLabel,
  taskTitleFor,
  fetchTaskHeaderInfo,
  ASSIGNEE_UNAVAILABLE,
} from './taskAssignees'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const T1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const T2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const U1 = 'cccccccc-3333-4333-8333-cccccccccccc'

/** Records every query so the test can count round trips. */
function stubClient(rows: { tasks?: unknown[]; users?: unknown[] }, errors: { tasks?: string; users?: string } = {}) {
  const calls: { table: string; ids: readonly string[] }[] = []
  const client = {
    from(table: 'tasks' | 'users') {
      return {
        select() {
          return {
            in(_col: string, ids: readonly string[]) {
              calls.push({ table, ids })
              const err = errors[table]
              return Promise.resolve({
                data: err ? null : (rows[table] ?? []),
                error: err ? { message: err } : null,
              })
            },
          }
        },
      }
    },
  }
  return { client, calls }
}

// ── 11. No per-group request ─────────────────────────────────────────────────

describe('11. the lookup is batched, never one request per group', () => {
  test('twenty tasks cost exactly two queries', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `${T1.slice(0, -2)}${String(i).padStart(2, '0')}`)
    const { client, calls } = stubClient({
      tasks: ids.map(id => ({ id, title: 't', assigned_to: U1 })),
      users: [{ id: U1, full_name: 'Nishant' }],
    })
    await fetchTaskHeaderInfo(client, ids)
    assert.equal(calls.length, 2, 'one tasks query, one users query — regardless of count')
    assert.deepEqual(calls.map(c => c.table), ['tasks', 'users'])
    assert.equal(calls[0].ids.length, 20, 'all ids in ONE in() filter')
  })

  test('no tasks means no query at all', async () => {
    const { client, calls } = stubClient({})
    assert.deepEqual(await fetchTaskHeaderInfo(client, []), {})
    assert.equal(calls.length, 0)
  })

  test('one users query even when many tasks share assignees', async () => {
    const { client, calls } = stubClient({
      tasks: [{ id: T1, title: 'a', assigned_to: U1 }, { id: T2, title: 'b', assigned_to: U1 }],
      users: [{ id: U1, full_name: 'Nishant' }],
    })
    await fetchTaskHeaderInfo(client, [T1, T2])
    assert.equal(calls[1].ids.length, 1, 'distinct assignee ids only')
  })

  test('the id set is bounded by the page, and de-duplicated', () => {
    const page = [
      { task_id: T1 }, { task_id: T1 }, { task_id: T2 },
      { task_id: null }, { task_id: '' },
    ]
    assert.deepEqual(collectTaskIds(page).sort(), [T1, T2].sort())
  })

  test('and the route asks for it once per page, not per card', () => {
    const route = read('src/app/api/notifications/route.ts')
    assert.equal((route.match(/fetchTaskHeaderInfo\(/g) ?? []).length, 1)
    assert.ok(route.includes('collectTaskIds(notifications)'))
    // Only on the Task feed — the other categories have no task to describe.
    assert.ok(route.includes("categoryResult.category === 'task'"))
  })
})

// ── 2. The assignee, not the actor ───────────────────────────────────────────

describe('2. the header assignee comes from the task, never from an event', () => {
  test('the name is read from tasks.assigned_to → users.full_name', async () => {
    const { client, calls } = stubClient({
      tasks: [{ id: T1, title: 'test task', assigned_to: U1 }],
      users: [{ id: U1, full_name: 'Nishant' }],
    })
    const map = await fetchTaskHeaderInfo(client, [T1])
    assert.deepEqual(map[T1], { title: 'test task', assigneeName: 'Nishant' })
    assert.deepEqual(calls[1].ids, [U1], 'the id came from the task row')
  })

  test('the module reads no notification field that could carry an actor', () => {
    const src = read('src/lib/notifications/taskAssignees.ts')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const field of ['n.title', 'notification.title', 'getNotificationMeta', 'headingIsActor']) {
      assert.equal(src.includes(field), false, `must not consult ${field}`)
    }
  })

  test('the select names exactly the columns needed, and nothing personal', () => {
    const src = read('src/lib/notifications/taskAssignees.ts')
    assert.ok(src.includes("select('id, title, assigned_to')"))
    assert.ok(src.includes("select('id, full_name')"))
    const selects = [...src.matchAll(/select\('([^']*)'\)/g)].map(m => m[1])
    assert.deepEqual(selects, ['id, title, assigned_to', 'id, full_name'],
      'exactly two selects, exactly these columns')
    for (const column of ['email', 'phone', 'salary', 'role', 'employee_code', '*']) {
      assert.equal(selects.some(sel => sel.includes(column)), false,
        `the lookup must not select ${column}`)
    }
  })
})

// ── 12. Missing data renders safely ──────────────────────────────────────────

describe('12. every missing case has one honest answer', () => {
  test('no entry at all', () => {
    assert.equal(assigneeLabel(undefined), ASSIGNEE_UNAVAILABLE)
  })

  test('an unassigned task', async () => {
    const { client } = stubClient({ tasks: [{ id: T1, title: 'x', assigned_to: null }] })
    const map = await fetchTaskHeaderInfo(client, [T1])
    assert.equal(map[T1].assigneeName, null)
    assert.equal(assigneeLabel(map[T1]), ASSIGNEE_UNAVAILABLE)
  })

  test('a deleted or unreadable employee record', async () => {
    const { client } = stubClient({
      tasks: [{ id: T1, title: 'x', assigned_to: U1 }],
      users: [], // the row is gone
    })
    const map = await fetchTaskHeaderInfo(client, [T1])
    assert.equal(map[T1].assigneeName, null)
    assert.equal(assigneeLabel(map[T1]), ASSIGNEE_UNAVAILABLE)
  })

  test('a blank name is treated as missing, not rendered as empty space', () => {
    assert.equal(assigneeLabel({ title: 'x', assigneeName: '   ' }), ASSIGNEE_UNAVAILABLE)
  })

  test('a failed users query still yields titles, and never throws', async () => {
    const { client } = stubClient(
      { tasks: [{ id: T1, title: 'test task', assigned_to: U1 }] },
      { users: 'connection reset' })
    const map = await fetchTaskHeaderInfo(client, [T1])
    assert.equal(map[T1].title, 'test task')
    assert.equal(assigneeLabel(map[T1]), ASSIGNEE_UNAVAILABLE)
  })

  test('a failed tasks query yields an empty map, and never throws', async () => {
    const { client } = stubClient({}, { tasks: 'connection reset' })
    assert.deepEqual(await fetchTaskHeaderInfo(client, [T1]), {})
  })

  test('the title falls back to whatever the group already derived', () => {
    assert.equal(taskTitleFor(undefined, 'from the notification'), 'from the notification')
    assert.equal(taskTitleFor({ title: '  ', assigneeName: null }, 'fallback'), 'fallback')
    assert.equal(taskTitleFor({ title: 'authoritative', assigneeName: null }, 'fallback'), 'authoritative')
  })
})
