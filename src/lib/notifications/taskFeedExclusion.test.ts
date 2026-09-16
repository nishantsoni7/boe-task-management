/**
 * Quotation and approval notifications written before the rule stay in the
 * table and never surface: the Task feed's list, its unread count, Mark all
 * read and Delete all all exclude them BEFORE paging or counting.
 *
 * The visible-set reader is tested against a recording client; the routes are
 * pinned at the source level.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/taskFeedExclusion.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APPROVAL_NOTIFICATION_TITLE_PATTERN, MUTATION_ID_CHUNK_SIZE, TASK_FEED_TASK_EMBED, TASK_FEED_TASK_TYPE_COLUMN,
  VISIBLE_ID_PAGE_SIZE, chunkIds, selectVisibleTaskNotificationIds, stripTaskFeedEmbed,
} from './taskNotificationPolicy'
import { getNotificationCategoryFilter, SYSTEM_TYPE_EXCLUSION } from '@/lib/notifications'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

const USER = 'aaaaaaaa-0000-4000-8000-000000000001'

type Call = [string, ...unknown[]]

function recordingClient(pages: { id: string }[][], error: { message: string } | null = null) {
  const queries: Call[][] = []
  let page = 0
  const client = {
    from(table: string) {
      const calls: Call[] = [['from', table]]
      queries.push(calls)
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'or', 'not', 'neq', 'order', 'range']) {
        builder[m] = (...args: unknown[]) => { calls.push([m, ...args]); return builder }
      }
      builder.then = (resolve: (v: unknown) => void) =>
        resolve(error ? { data: null, error } : { data: pages[page++] ?? [], error: null })
      return builder
    },
  }
  return { client, queries }
}

const ids = (n: number, prefix = 'n') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))

describe('selectVisibleTaskNotificationIds — the set a bulk mutation may touch', () => {
  test('applies the list predicate: caller, category, system types, quotation and approval', async () => {
    const { client, queries } = recordingClient([ids(3)])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await selectVisibleTaskNotificationIds(client as any, { userId: USER })
    assert.deepEqual(res, { ids: ['n0', 'n1', 'n2'], error: null })

    const calls = queries[0]
    assert.deepEqual(calls[0], ['from', 'notifications'])
    assert.deepEqual(calls.find(c => c[0] === 'select'), ['select', `id, ${TASK_FEED_TASK_EMBED}`])
    assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'user_id' && c[2] === USER))
    assert.ok(calls.some(c => c[0] === 'or' && c[1] === getNotificationCategoryFilter('task')))
    assert.ok(calls.some(c => c[0] === 'not' && c[1] === 'type' && c[2] === 'in' && c[3] === SYSTEM_TYPE_EXCLUSION))
    assert.ok(calls.some(c => c[0] === 'neq' && c[1] === TASK_FEED_TASK_TYPE_COLUMN && c[2] === 'quotation_request'))
    assert.ok(calls.some(c => c[0] === 'not' && c[1] === 'title' && c[2] === 'like' && c[3] === APPROVAL_NOTIFICATION_TITLE_PATTERN))
    assert.equal(calls.some(c => c[0] === 'eq' && c[1] === 'is_read'), false, 'not unread-only unless asked')
  })

  test('narrows to unread and to one task when asked, on top of the predicate', async () => {
    const { client, queries } = recordingClient([ids(1)])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectVisibleTaskNotificationIds(client as any, { userId: USER, unreadOnly: true, taskId: 'task-1' })
    const calls = queries[0]
    assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'is_read' && c[2] === false))
    assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'task_id' && c[2] === 'task-1'))
    assert.ok(calls.some(c => c[0] === 'neq' && c[1] === TASK_FEED_TASK_TYPE_COLUMN))
  })

  test('pages until a short page, so a large inbox is covered entirely', async () => {
    const { client, queries } = recordingClient([ids(VISIBLE_ID_PAGE_SIZE, 'a'), ids(2, 'b')])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await selectVisibleTaskNotificationIds(client as any, { userId: USER })
    assert.equal(res.ids.length, VISIBLE_ID_PAGE_SIZE + 2)
    assert.equal(queries.length, 2)
    assert.deepEqual(queries[1].find(c => c[0] === 'range'), ['range', VISIBLE_ID_PAGE_SIZE, 2 * VISIBLE_ID_PAGE_SIZE - 1])
  })

  test('a failed read is reported, never treated as "nothing visible"', async () => {
    const { client } = recordingClient([], { message: 'boom' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await selectVisibleTaskNotificationIds(client as any, { userId: USER })
    assert.deepEqual(res, { ids: [], error: { message: 'boom' } })
  })
})

test('chunkIds keeps every id, in order, within the chunk size', () => {
  const all = Array.from({ length: 2 * MUTATION_ID_CHUNK_SIZE + 5 }, (_, i) => `id${i}`)
  const chunks = chunkIds(all)
  assert.equal(chunks.length, 3)
  assert.ok(chunks.every(c => c.length <= MUTATION_ID_CHUNK_SIZE))
  assert.deepEqual(chunks.flat(), all)
  assert.deepEqual(chunkIds([]), [])
})

test('stripTaskFeedEmbed removes the filter embed and nothing else', () => {
  assert.deepEqual(
    stripTaskFeedEmbed([{ id: '1', title: 't', tasks: { task_type: 'general' } }]),
    [{ id: '1', title: 't' }],
  )
})

describe('every Task feed read applies the exclusion before paging or counting', () => {
  const route = read('src/app/api/notifications/route.ts')

  test('the count and the list both join the task and exclude quotation and approval rows', () => {
    assert.equal(route.match(/\.neq\(TASK_FEED_TASK_TYPE_COLUMN, QUOTATION_TASK_TYPE\)/g)?.length, 2)
    assert.equal(route.match(/\.not\('title', 'like', APPROVAL_NOTIFICATION_TITLE_PATTERN\)/g)?.length, 2)
    const count = route.indexOf('let countQuery')
    const list = route.indexOf('let listQuery')
    assert.ok(count > 0 && route.indexOf('.neq(TASK_FEED_TASK_TYPE_COLUMN', count) < route.indexOf('unreadCount: count ?? 0'))
    assert.ok(list > count && route.indexOf('.neq(TASK_FEED_TASK_TYPE_COLUMN', list) < route.indexOf('.limit(limit + 1)'))
    // Only the Task feed joins a task; other modules' rows carry no task_id.
    assert.match(route, /select\(isTaskFeed \? `id, \$\{TASK_FEED_TASK_EMBED\}` : 'id', \{ count: 'exact', head: true \}\)/)
    assert.match(route, /const rows = isTaskFeed \? stripTaskFeedEmbed\(fetched\) : fetched/)
  })

  test('delete-all and mark-all-read act on the visible set only', () => {
    assert.match(route, /selectVisibleTaskNotificationIds\(supabase, \{ userId: user\.id, taskId \}\)/)
    const markRead = read('src/app/api/notifications/mark-read/route.ts')
    assert.match(markRead, /selectVisibleTaskNotificationIds\(supabase, \{\s*userId: user\.id,\s*unreadOnly: true,/)
  })
})
