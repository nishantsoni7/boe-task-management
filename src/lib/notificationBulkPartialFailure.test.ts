/**
 * Bulk notification actions that fail PART-WAY.
 *
 * Mark all read, Delete all and their one-task forms mutate the Task feed in
 * chunks, so the server can commit some rows and then fail. It answers with
 * `partial: true`. Restoring the snapshot would then put back rows that are
 * really gone, so the client keeps its optimistic change and re-reads instead.
 * An ordinary failure still rolls back exactly as before.
 *
 * Drives the real mutation option objects through TanStack's MutationObserver
 * against a real QueryClient, like notificationMutations.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/notificationBulkPartialFailure.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient, MutationObserver } from '@tanstack/react-query'
import type { Notification } from './types'
import {
  deleteAllOptions,
  deleteTaskGroupOptions,
  markAllReadOptions,
  markTaskGroupReadOptions,
  PartialBulkMutationError,
  type FetchLike,
  type NotificationMutationDeps,
} from './notificationMutations'
import { notificationKeys } from './notificationCache'

const TASK_A = 'aaaaaaaa-0000-4000-8000-00000000000a'

const notif = (id: string, isRead = false, taskId: string | null = TASK_A): Notification => ({
  id,
  user_id: 'user-1',
  task_id: taskId,
  entity_id: null,
  type: 'task_assigned',
  title: 'Someone added a comment',
  body: 'A task title',
  is_read: isRead,
  is_push_sent: true,
  is_digest: false,
  created_at: '2026-09-15T10:00:00.000Z',
  read_at: null,
} as unknown as Notification)

const jsonResponse = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as Response)

const nonJsonResponse = (status: number): Response => ({
  ok: false,
  status,
  json: async () => { throw new SyntaxError('Unexpected token <') },
} as unknown as Response)

let qc: QueryClient
const errors: string[] = []

function deps(reply: () => Promise<Response>): NotificationMutationDeps {
  const fetchFn: FetchLike = async () => reply()
  return { qc, category: 'task', fetchFn, reportError: m => { errors.push(m) } }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(options: any, variables: unknown): Promise<Error | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const observer: any = new MutationObserver(qc, options)
  try {
    await observer.mutate(variables)
    return null
  } catch (err) {
    return err as Error
  }
}

const ids = () => (qc.getQueryData<Notification[]>(notificationKeys.list('task')) ?? []).map(n => n.id)
const unread = () => (qc.getQueryData<Notification[]>(notificationKeys.list('task')) ?? []).filter(n => !n.is_read).map(n => n.id)
const badge = () => qc.getQueryData<{ unreadCount: number }>(notificationKeys.count('task'))?.unreadCount
const invalidated = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated === true

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  errors.length = 0
  qc.setQueryData(notificationKeys.list('task'), [notif('t1'), notif('t2', true), notif('t3'), notif('other', false, null)])
  qc.setQueryData(notificationKeys.count('task'), { unreadCount: 3 })
  qc.setQueryData(notificationKeys.list('finance'), [notif('f1', false, null)])
  qc.setQueryData(notificationKeys.count('finance'), { unreadCount: 1 })
})

const PARTIAL_DELETE = { error: 'Some notifications could not be deleted. Please try again.', partial: true, deletedCount: 2, unreadAffected: 1 }
const PARTIAL_READ = { error: 'Some notifications could not be marked as read. Please try again.', partial: true, updatedCount: 1, unreadAffected: 1 }

describe('Delete all', () => {
  test('a partial failure keeps the removal, re-reads the list and badge, and says so', async () => {
    const err = await run(deleteAllOptions(deps(async () => jsonResponse(500, PARTIAL_DELETE))), undefined)
    assert.ok(err instanceof PartialBulkMutationError)
    assert.deepEqual(ids(), [], 'rows the server may have deleted are not put back')
    assert.ok(invalidated(notificationKeys.list('task')))
    assert.ok(invalidated(notificationKeys.count('task')))
    assert.deepEqual(errors, [PARTIAL_DELETE.error])
    // Another module's inbox is not touched by the re-read either.
    assert.equal(invalidated(notificationKeys.list('finance')), false)
    assert.equal(qc.getQueryData<{ unreadCount: number }>(notificationKeys.count('finance'))?.unreadCount, 1)
  })

  test('an ordinary failure still restores the list and the badge', async () => {
    const err = await run(deleteAllOptions(deps(async () => jsonResponse(500, { error: 'Could not delete notifications' }))), undefined)
    assert.ok(err && !(err instanceof PartialBulkMutationError))
    assert.deepEqual(ids(), ['t1', 't2', 't3', 'other'])
    assert.equal(badge(), 3)
    assert.deepEqual(errors, ['Could not delete notifications'])
  })

  test('a non-JSON error page is an ordinary failure with a usable message', async () => {
    const err = await run(deleteAllOptions(deps(async () => nonJsonResponse(502))), undefined)
    assert.ok(err && !(err instanceof PartialBulkMutationError))
    assert.deepEqual(ids(), ['t1', 't2', 't3', 'other'])
    assert.match(errors[0], /Could not delete all notifications \(HTTP 502\)/)
  })
})

describe('Mark all read', () => {
  test('a partial failure keeps the rows read and re-reads the server', async () => {
    const err = await run(markAllReadOptions(deps(async () => jsonResponse(500, PARTIAL_READ))), undefined)
    assert.ok(err instanceof PartialBulkMutationError)
    assert.deepEqual(unread(), [], 'rows the server may have marked are not un-read')
    assert.ok(invalidated(notificationKeys.list('task')))
    assert.ok(invalidated(notificationKeys.count('task')))
    assert.deepEqual(errors, [PARTIAL_READ.error])
  })

  test('an ordinary failure still restores the unread rows and the badge', async () => {
    await run(markAllReadOptions(deps(async () => jsonResponse(500, { error: 'Could not update the notification' }))), undefined)
    assert.deepEqual(unread(), ['t1', 't3', 'other'])
    assert.equal(badge(), 3)
  })
})

describe('One task’s notifications', () => {
  test('a partial group delete keeps the group removed and re-reads', async () => {
    const err = await run(deleteTaskGroupOptions(deps(async () => jsonResponse(500, PARTIAL_DELETE))), TASK_A)
    assert.ok(err instanceof PartialBulkMutationError)
    assert.deepEqual(ids(), ['other'], 'only the task group was optimistically removed, and it stays removed')
    assert.ok(invalidated(notificationKeys.list('task')))
    assert.ok(invalidated(notificationKeys.count('task')))
  })

  test('a partial group mark-read keeps the group read and re-reads', async () => {
    const err = await run(markTaskGroupReadOptions(deps(async () => jsonResponse(500, PARTIAL_READ))), TASK_A)
    assert.ok(err instanceof PartialBulkMutationError)
    assert.deepEqual(unread(), ['other'])
    assert.ok(invalidated(notificationKeys.list('task')))
  })

  test('an ordinary group failure still rolls back', async () => {
    await run(deleteTaskGroupOptions(deps(async () => jsonResponse(500, { error: 'Could not delete notifications' }))), TASK_A)
    assert.deepEqual(ids(), ['t1', 't2', 't3', 'other'])
    assert.equal(badge(), 3)
  })
})
