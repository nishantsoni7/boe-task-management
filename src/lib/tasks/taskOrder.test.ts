import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sortMyTasks,
  reorderAfterDrop,
  taskGroup,
  normalizeStoredTaskOrder,
  TASK_ORDER_MAX,
} from './taskOrder'

const t = (id: string, is_urgent = false, status = 'working') => ({ id, is_urgent, status }) as never

test('Important first, then pinned, then the rest', () => {
  const tasks = [t('a'), t('b'), t('c', true), t('d')]
  const out = sortMyTasks(tasks, new Set(['b']), null).map((x: { id: string }) => x.id)
  assert.deepEqual(out, ['c', 'b', 'a', 'd'])
})

test('a pinned task goes straight under the Important ones', () => {
  const tasks = [t('a'), t('b'), t('c', true), t('d', true), t('e')]
  const out = sortMyTasks(tasks, new Set(['e']), null).map((x: { id: string }) => x.id)
  assert.deepEqual(out, ['c', 'd', 'e', 'a', 'b'])
})

test('saved order decides inside a group; unplaced tasks follow in their old order', () => {
  const tasks = [t('a'), t('b'), t('c'), t('d')]
  const out = sortMyTasks(tasks, undefined, ['c', 'a']).map((x: { id: string }) => x.id)
  assert.deepEqual(out, ['c', 'a', 'b', 'd'])
})

test('saved order never lifts a task out of its group', () => {
  const tasks = [t('a'), t('b', true)]
  const out = sortMyTasks(tasks, undefined, ['a', 'b']).map((x: { id: string }) => x.id)
  assert.deepEqual(out, ['b', 'a'])
})

test('a completed starred task is not Important', () => {
  assert.equal(taskGroup({ is_urgent: true, status: 'completed' } as never, false), 2)
  assert.equal(taskGroup({ is_urgent: true, status: 'working' } as never, true), 0)
  assert.equal(taskGroup({ is_urgent: false, status: 'working' } as never, true), 1)
})

test('drop moves the task to the target position inside the full list', () => {
  const g = () => 2 as const
  assert.deepEqual(reorderAfterDrop(['a', 'b', 'c', 'd'], 'd', 'b', g), ['a', 'd', 'b', 'c'])
  assert.deepEqual(reorderAfterDrop(['a', 'b', 'c', 'd'], 'a', 'c', g), ['b', 'c', 'a', 'd'])
})

test('drop is refused for the same task, an unknown id, or a different group', () => {
  const g = (id: string) => (id === 'a' ? 0 : 2) as 0 | 2
  assert.equal(reorderAfterDrop(['a', 'b'], 'a', 'a', g), null)
  assert.equal(reorderAfterDrop(['a', 'b'], 'x', 'b', g), null)
  assert.equal(reorderAfterDrop(['a', 'b'], 'a', 'b', g), null)
})

test('saved order is capped at the database limit', () => {
  const ids = Array.from({ length: TASK_ORDER_MAX + 5 }, (_, i) => `id${i}`)
  const out = reorderAfterDrop(ids, 'id0', 'id1', () => 2)
  assert.equal(out?.length, TASK_ORDER_MAX)
})

test('stored order is read defensively', () => {
  assert.equal(normalizeStoredTaskOrder(null), null)
  assert.equal(normalizeStoredTaskOrder([]), null)
  assert.deepEqual(normalizeStoredTaskOrder(['a', 'a', 3, 'b']), ['a', 'b'])
})
