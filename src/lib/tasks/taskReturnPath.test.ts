/**
 * Task Detail → Submit for Approval → back to the exact page it was opened from.
 *
 * THE BEHAVIOUR BEFORE. Submit for Approval left the assignee on Task Detail.
 * Getting back to the list meant Back (or the sidebar), and a drawer opened the
 * page with close-then-router.push, so the source view was never recorded.
 *
 * NOW. Every internal entry point appends `returnTo` (its own path + query), and
 * after a successful submit Task Detail `router.replace`s to it — validated, so a
 * crafted `?returnTo=` can never send anyone off BOE — or to the task's own list.
 *
 * The helper is pure and tested directly; the wiring into pages is pinned at the
 * source level, reading code only (comments explain what no longer happens).
 *
 * Run:
 *   npx tsx --test src/lib/tasks/taskReturnPath.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_RETURN_PATH_LENGTH, defaultTaskListPath, pathWithSearch, returnPathFromSearch,
  safeReturnPath, taskDetailHref, withTaskReturnTo,
} from './taskReturnPath'

const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const BOE = 'https://boe-task-management.vercel.app'

/** What Task Detail will read back from the URL a link produced. */
const roundTrip = (source: string) => returnPathFromSearch(new URL(taskDetailHref(ID, source), BOE).search)

// ── 1. What is accepted ─────────────────────────────────────────────────────

describe('safeReturnPath accepts internal BOE paths, unchanged', () => {
  for (const path of [
    '/dashboard',
    '/tasks/my',
    '/tasks/my?type=self&tab=working&page=2',
    '/notifications',
    '/tasks/my/completed?completedOn=2026-09-10&page=3',
    '/tasks/assigned-by-me?assignee=' + ID + '&priority=high&q=quote+request',
  ]) {
    test(path, () => assert.equal(safeReturnPath(path), path))
  }

  test('percent-encoded slashes stay a path on BOE', () => {
    const value = '/%2F%2Fexample.com'
    assert.equal(safeReturnPath(value), value)
    assert.equal(new URL(value, BOE).origin, BOE)
  })

  test('the length limit is inclusive', () => {
    const atLimit = '/' + 'a'.repeat(MAX_RETURN_PATH_LENGTH - 1)
    assert.equal(safeReturnPath(atLimit), atLimit)
    assert.equal(safeReturnPath(atLimit + 'a'), null)
  })
})

// ── 2–7. What is refused ────────────────────────────────────────────────────

describe('safeReturnPath refuses anything that could leave BOE', () => {
  const refused: [string, unknown][] = [
    ['https://', 'https://example.com'],
    ['http://', 'http://example.com'],
    ['upper-case scheme', 'HTTPS://example.com'],
    ['protocol-relative //', '//example.com'],
    ['triple slash', '///example.com'],
    ['javascript:', 'javascript:alert(1)'],
    ['mixed-case javascript:', 'JavaScript:alert(1)'],
    ['data:', 'data:text/html,hi'],
    ['backslash host /\\', '/\\example.com'],
    ['backslash host /\\/', '/\\/example.com'],
    ['leading backslashes', '\\\\example.com'],
    ['backslash inside a path', '/tasks\\my'],
    ['tab smuggling', '/\t/example.com'],
    ['newline smuggling', '/\n/example.com'],
    ['carriage-return smuggling', '/\r/example.com'],
    ['NUL', '/tasks/my\u0000'],
    ['DEL', '/tasks/my\u007f'],
    ['C1 control', '/tasks/my\u0085'],
    ['raw space', '/tasks/ my'],
    ['empty', ''],
    ['relative without a slash', 'tasks/my'],
    ['host-ish', 'example.com'],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['object', { path: '/tasks/my' }],
  ]
  for (const [label, value] of refused) {
    test(label, () => assert.equal(safeReturnPath(value), null))
  }

  test('the control-character cases really contain control characters', () => {
    assert.equal('/tasks/my\u0000'.length, '/tasks/my'.length + 1)
    assert.equal('/tasks/my\u007f'.charCodeAt(9), 0x7f)
  })
})

// ── Building and reading the link ───────────────────────────────────────────

describe('taskDetailHref', () => {
  test('no source → the plain task URL (no dangling returnTo)', () => {
    assert.equal(taskDetailHref(ID), `/tasks/${ID}`)
    assert.equal(taskDetailHref(ID, ''), `/tasks/${ID}`)
  })

  test('an unsafe source is dropped, not encoded into the link', () => {
    assert.equal(taskDetailHref(ID, 'https://example.com'), `/tasks/${ID}`)
    assert.equal(taskDetailHref(ID, '//example.com'), `/tasks/${ID}`)
  })

  test('a safe source is encoded as one query value', () => {
    assert.equal(
      taskDetailHref(ID, '/tasks/my?type=self&tab=working&page=2'),
      `/tasks/${ID}?returnTo=%2Ftasks%2Fmy%3Ftype%3Dself%26tab%3Dworking%26page%3D2`,
    )
  })
})

// ── 8–12. Each entry point's source comes back exactly ─────────────────────

describe('the source view survives the round trip exactly', () => {
  test('My Tasks with tab, type, search, assigner and page', () => {
    const source = pathWithSearch('/tasks/my', 'tab=working&type=self&q=quote+request&assignedBy=' + ID + '&page=2')
    assert.equal(roundTrip(source), source)
  })

  test('Assigned By Me with filters', () => {
    const source = pathWithSearch('/tasks/assigned-by-me', '?tab=for_approval&assignee=' + ID + '&priority=high')
    assert.equal(roundTrip(source), source)
  })

  test('Dashboard', () => assert.equal(roundTrip('/dashboard'), '/dashboard'))

  test('Notifications', () => assert.equal(roundTrip('/notifications'), '/notifications'))

  test('Completed with completion date and page number', () => {
    const source = pathWithSearch('/tasks/my/completed', 'completedOn=2026-09-10&priority=low&page=4')
    assert.equal(roundTrip(source), source)
  })

  test('pathWithSearch leaves a query-less page bare', () => {
    assert.equal(pathWithSearch('/tasks/my', ''), '/tasks/my')
    assert.equal(pathWithSearch('/tasks/my', '?'), '/tasks/my')
  })
})

// ── 13–14. Fallback ─────────────────────────────────────────────────────────

describe('without a usable returnTo, the task’s own list', () => {
  test('a direct /tasks/<id> has no returnTo', () => {
    assert.equal(returnPathFromSearch(''), null)
    assert.equal(defaultTaskListPath('general'), '/tasks/my')
    assert.equal(defaultTaskListPath(null), '/tasks/my')
  })

  test('quotation requests keep their own list, as Mark Complete already does', () => {
    assert.equal(defaultTaskListPath('quotation_request'), '/tasks/quotation-requests')
  })

  test('an invalid returnTo is ignored', () => {
    for (const bad of ['https://example.com', '//example.com', 'javascript:alert(1)', '/\\example.com']) {
      assert.equal(returnPathFromSearch(`?returnTo=${encodeURIComponent(bad)}`), null, bad)
    }
  })
})

describe('withTaskReturnTo rewrites Task Detail links only', () => {
  test('a task link gains the source', () => {
    assert.equal(withTaskReturnTo(`/tasks/${ID}`, '/notifications'), `/tasks/${ID}?returnTo=%2Fnotifications`)
  })
  test('every other destination passes through', () => {
    assert.equal(withTaskReturnTo('/payroll?issue=obj-9', '/payroll/notifications'), '/payroll?issue=obj-9')
    assert.equal(withTaskReturnTo('/tasks/my', '/notifications'), '/tasks/my')
    assert.equal(withTaskReturnTo(null, '/notifications'), null)
  })
})

// ── Wiring ──────────────────────────────────────────────────────────────────

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('Task Detail: Submit for Approval returns to the source (15–16)', () => {
  const detail = codeOf(read('src/app/tasks/[id]/page.tsx'))
  const submit = detail.slice(detail.indexOf('const submitForApproval = async'), detail.indexOf('const approveTask = async'))

  test('a failed submit returns before any navigation', () => {
    const failed = submit.indexOf('if (!ok) return')
    assert.ok(failed > 0)
    assert.ok(failed < submit.indexOf('router.replace(target)'))
  })

  test('success uses the validated returnTo, else the task’s own list', () => {
    assert.ok(submit.includes('const target = returnPathFromSearch(window.location.search) ?? defaultTaskListPath(task?.task_type)'))
    assert.ok(submit.includes('router.replace(target)'), 'replace, so the submitted task is not one Back press away')
    assert.equal(/router\.(back|push)\(/.test(submit), false)
  })

  test('the toast is shown first, and the list is told this is a return', () => {
    assert.ok(submit.indexOf('showToast(') < submit.indexOf('router.replace(target)'))
    assert.ok(submit.indexOf('noteListReturn()') < submit.indexOf('router.replace(target)'))
  })

  test('the pending return is cancelled if the page unmounts first', () => {
    assert.ok(detail.includes('if (submitReturnTimer.current) clearTimeout(submitReturnTimer.current)'))
  })

  test('Approve, Return and Mark Complete navigation are unchanged', () => {
    const approve = detail.slice(detail.indexOf('const approveTask = async'), detail.indexOf('const returnTask = async'))
    const ret = detail.slice(detail.indexOf('const returnTask = async'), detail.indexOf('const handleReopen = async'))
    for (const body of [approve, ret]) assert.equal(/router\.(replace|push|back)\(/.test(body), false)
    assert.ok(detail.includes("const dest = task.task_type === 'quotation_request' ? '/tasks/quotation-requests' : '/tasks/my'"))
    assert.ok(detail.includes('setTimeout(() => router.push(dest), 800)'))
  })
})

describe('every entry point passes its own view (8–12)', () => {
  const LIST_DRAWERS = [
    'src/app/tasks/my/page.tsx',
    'src/app/tasks/my/completed/page.tsx',
    'src/app/tasks/cancelled/page.tsx',
    'src/app/tasks/assigned-by-me/page.tsx',
    'src/app/tasks/assigned-by-me/completed/page.tsx',
    'src/app/tasks/assigned-by-me/cancelled/page.tsx',
  ]

  for (const file of LIST_DRAWERS) {
    test(`${file}: drawer link carries this exact view`, () => {
      const code = codeOf(read(file))
      assert.ok(code.includes('const returnTo = useCurrentReturnPath()'))
      assert.ok(code.includes('fullPageHref={taskDetailHref(selectedTask.id, returnTo)}'))
      assert.equal(code.includes('onOpenFullPage='), false, 'no close-then-router.push drawer remains')
      assert.equal(code.includes('router.push(`/tasks/${'), false)
    })
  }

  test('Assigned By Me row "view" button', () => {
    assert.ok(codeOf(read('src/app/tasks/assigned-by-me/page.tsx')).includes('onView={() => router.push(taskDetailHref(task.id, returnTo))}'))
  })

  test('Quotation requests rows', () => {
    const code = codeOf(read('src/app/tasks/quotation-requests/page.tsx'))
    assert.ok(code.includes('onClick={() => router.push(taskDetailHref(task.id, returnTo))}'))
    assert.ok(code.includes('onView={() => router.push(taskDetailHref(task.id, returnTo))}'))
  })

  test('/tasks/all rows (both layouts)', () => {
    const code = codeOf(read('src/app/tasks/all/page.tsx'))
    assert.equal(code.split('onClick={() => router.push(taskDetailHref(task.id, returnTo))}').length - 1, 2)
    assert.equal(code.includes('router.push(`/tasks/${'), false)
  })

  test('Dashboard drawer link and quotation panel return to the Dashboard', () => {
    const code = codeOf(read('src/app/dashboard/page.tsx'))
    assert.ok(code.includes('const pathname    = usePathname()'))
    assert.ok(code.includes('fullPageHref={taskDetailHref(selectedTask.id, pathname)}'))
    assert.ok(code.includes('onOpen={task => router.push(taskDetailHref(task.id, pathname))}'))
  })

  test('Notifications: row open, title link and prefetch all carry the page', () => {
    const view = codeOf(read('src/components/notifications/NotificationsView.tsx'))
    assert.ok(view.includes('const href = withTaskReturnTo(getNotificationMeta(n).href, pathname)'))
    assert.ok(view.includes('router.prefetch(taskDetailHref(n.task_id, pathname))'))
    assert.ok(view.includes('returnTo={pathname}'))
    const group = codeOf(read('src/components/notifications/NotificationTaskGroup.tsx'))
    assert.ok(group.includes('const taskHref = withTaskReturnTo(href, returnTo)'))
    assert.ok(group.includes('<Link href={taskHref}'))
  })

  test('list pages read their view from the URL they are showing', () => {
    const hook = codeOf(read('src/hooks/useCurrentReturnPath.ts'))
    assert.ok(hook.includes('return pathWithSearch(usePathname(), useSearchParams().toString())'))
  })
})

describe('scroll restore treats the return like Back', () => {
  test('noteListReturn records the same one-shot history return a popstate does', () => {
    const hook = codeOf(read('src/hooks/useListScrollRestore.ts'))
    assert.ok(hook.includes('export function noteListReturn(): void {'))
    assert.ok(hook.includes('historyReturn.noteHistoryNavigation(Date.now())'))
  })
})

describe('PR #147 opening behaviour is untouched (17–18)', () => {
  const panel = codeOf(read('src/components/ui/TaskDetailPanel.tsx'))

  test('the drawer still opens Task Detail through the prefetched Link', () => {
    assert.ok(panel.includes("import Link from 'next/link'"))
    assert.ok(panel.includes('href={fullPageHref}'))
    assert.ok(panel.includes("{opening ? 'Opening task…' : 'View Task Page ↗'}"))
    assert.ok(panel.includes('if (openingRef.current) { e.preventDefault(); return }'))
    assert.ok(existsSync(join(ROOT, 'src/app/tasks/[id]/loading.tsx')))
  })

  test('Enter (a real anchor) and modified clicks (new tab) still work', () => {
    assert.ok(panel.includes('e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return'))
  })
})
