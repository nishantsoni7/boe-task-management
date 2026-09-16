/**
 * Self Task / Delegate Task are absent on Notifications and every Quotation
 * screen, and still present on Task Management screens.
 *
 * The header is one component on desktop and mobile (there is no separate
 * mobile creation control), so one decision covers both.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/taskCreateActions.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTaskCreateActionsHiddenRoute, shouldShowTaskCreateActions } from './taskCreateActions'

const show = (pathname: string, extra: { inViewMode?: boolean; hideTaskCreateActions?: boolean } = {}) =>
  shouldShowTaskCreateActions({ pathname, inViewMode: false, ...extra })

describe('hidden on Notifications and Quotation routes', () => {
  for (const path of [
    '/notifications',
    '/notifications/',
    '/notifications?tab=unread',
    '/tasks/quotation-requests',
    '/tasks/quotation-requests/',
    '/tasks/quotation-requests?status=open',
    '/tasks/quotation-requests/new',
  ]) {
    test(path, () => {
      assert.equal(isTaskCreateActionsHiddenRoute(path), true)
      assert.equal(show(path), false)
    })
  }
})

describe('shown on Task Management routes', () => {
  for (const path of [
    '/dashboard',
    '/tasks/my',
    '/tasks/my/completed',
    '/tasks/assigned-by-me',
    '/tasks/all',
    '/tasks/cancelled',
    '/tasks/create',
    '/tasks/create-self',
    '/tasks/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    '/manager',
  ]) {
    test(path, () => assert.equal(show(path), true))
  }
})

test('a prefix is a path segment, not a string prefix', () => {
  assert.equal(show('/notificationsx'), true)
  assert.equal(show('/tasks/quotation-requestsx'), true)
})

test('a quotation detail page hides them on the shared /tasks/[id] route', () => {
  assert.equal(show('/tasks/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', { hideTaskCreateActions: true }), false)
})

test('View As still hides them everywhere', () => {
  assert.equal(show('/tasks/my', { inViewMode: true }), false)
})

test('no pathname yet does not hide them', () => {
  assert.equal(shouldShowTaskCreateActions({ pathname: null, inViewMode: false }), true)
})

// ── Wiring, read at the source level ───────────────────────────────────────

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

test('DashboardLayout renders the buttons only through the shared decision', () => {
  const src = read('src/components/layout/DashboardLayout.tsx')
  assert.match(src, /shouldShowTaskCreateActions\(\{[^}]*pathname[^}]*inViewMode[^}]*hideTaskCreateActions/)
  assert.match(src, /\{showTaskCreateActions && \(/)
  assert.doesNotMatch(src, /\{!inViewMode && \(\s*<>\s*<button[^>]*>\s*[^]*?Self Task/)
})

test('Task Detail hides them for a quotation_request, by task_type', () => {
  const src = read('src/app/tasks/[id]/page.tsx')
  assert.match(src, /const isQuotation = task\.task_type === 'quotation_request'/)
  assert.match(src, /hideTaskCreateActions=\{isQuotation\}/)
})

test('quotation creation stays on the Quotation Requests list', () => {
  assert.match(read('src/app/tasks/quotation-requests/page.tsx'), /New Request/)
})
