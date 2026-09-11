/**
 * View Task Page, opened from the Dashboard's task drawer.
 *
 * THE DEFECT. The first click often seemed to do nothing, so people clicked
 * three or four times and waited five or six seconds. Measured on production,
 * one click ran:
 *
 *   0ms     drawer closed — Dashboard on screen, no sign the click landed
 *   ~360ms  server round trip for the RSC payload (a cold function or a slow
 *           network stretches this to seconds): /tasks/[id] is a DYNAMIC route
 *           with no loading.js, and Next prefetches a dynamic route only down to
 *           its nearest loading.js — so nothing useful had been prefetched
 *   ~390ms  URL changes, Task Detail spinner
 *   ~620ms  `auth.getUser()` round trip, serial, before any query could start
 *   ~1.2s   the page's own query batch resolves
 *
 * THE FIX, in three parts pinned below: a loading boundary so the route can be
 * prefetched and commit immediately; a real link in the drawer that stays open,
 * says "Opening task…" and refuses repeat activation; and identity read from the
 * cache ModuleGuard already filled instead of a fresh auth round trip.
 *
 * Source-level checks only — they catch a regression in the wiring, not in the
 * experience, which was verified in the browser.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/taskDetailOpenFromDrawer.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** Comments explain what the files no longer do — absence checks read code only. */
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const LOADING_PATH = 'src/app/tasks/[id]/loading.tsx'
const PANEL_CODE   = codeOf(read('src/components/ui/TaskDetailPanel.tsx'))
const DASH_CODE    = codeOf(read('src/app/dashboard/page.tsx'))
const DETAIL_CODE  = codeOf(read('src/app/tasks/[id]/page.tsx'))

describe('the task route can be prefetched', () => {
  test('/tasks/[id] has a loading boundary', () => {
    assert.ok(existsSync(join(ROOT, LOADING_PATH)),
      'without loading.tsx a dynamic route prefetches nothing and every open waits on the server')
  })

  test('the fallback is the same spinner the page shows while loading', () => {
    assert.ok(codeOf(read(LOADING_PATH)).includes('return <LoadingScreen />'))
  })
})

describe('the drawer opens the task page on the first click', () => {
  test('View Task Page is a Next link to the task', () => {
    assert.ok(PANEL_CODE.includes("import Link from 'next/link'"))
    assert.ok(PANEL_CODE.includes('href={fullPageHref}'))
  })

  test('a repeat activation is refused synchronously, not after a re-render', () => {
    const guard = PANEL_CODE.indexOf('if (openingRef.current) { e.preventDefault(); return }')
    const claim = PANEL_CODE.indexOf('openingRef.current = true')
    assert.ok(guard > -1, 'the second click must be prevented')
    assert.ok(claim > guard, 'the guard is claimed after it is checked')
    assert.ok(PANEL_CODE.indexOf('setOpening(true)') > claim)
  })

  test('the click is acknowledged on screen', () => {
    assert.ok(PANEL_CODE.includes("{opening ? 'Opening task…' : 'View Task Page ↗'}"))
  })

  test('a modified click is left to the browser and does not lock the link', () => {
    const modified = PANEL_CODE.indexOf('e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return')
    assert.ok(modified > -1)
    assert.ok(modified < PANEL_CODE.indexOf('openingRef.current = true'))
  })

  test('callers that still pass onOpenFullPage keep their button', () => {
    assert.ok(PANEL_CODE.includes('onClick={onOpenFullPage}'))
  })

  test('the Dashboard passes the link and no longer closes the drawer first', () => {
    assert.ok(DASH_CODE.includes('fullPageHref={`/tasks/${selectedTask.id}`}'))
    assert.equal(DASH_CODE.includes('setSelectedTask(null); router.push(`/tasks/${selectedTask.id}`)'), false,
      'closing the drawer before the page arrived is what hid the click')
  })

  test('the Dashboard drawer still closes', () => {
    assert.ok(DASH_CODE.includes('onClose={() => setSelectedTask(null)}'))
  })
})

describe('Task Detail starts its queries at mount', () => {
  test('it makes no auth-server call of its own', () => {
    assert.equal(DETAIL_CODE.includes('auth.getUser('), false,
      'getUser() is a round trip ModuleGuard has already answered')
  })

  test('identity and profile come from the shared caches', () => {
    assert.ok(DETAIL_CODE.includes('const { data: signedInUserId, isPending: idPending } = useSignedInUserId()'))
    assert.ok(DETAIL_CODE.includes('useProfile(signedInUserId)'))
    assert.ok(read('src/app/tasks/layout.tsx').includes('<ModuleGuard moduleKey="task_management">'),
      'the cache is only guaranteed warm because the guard resolves it first')
  })

  test('a caller with no session is still sent to /login before anything is read', () => {
    const redirect = DETAIL_CODE.indexOf("if (!signedInUserId) { router.push('/login'); return }")
    assert.ok(redirect > -1)
    assert.ok(redirect < DETAIL_CODE.indexOf("supabase.from('tasks').select('*, creator:created_by(full_name)')"))
  })

  test('the profile row is not read a second time', () => {
    assert.equal(DETAIL_CODE.includes(".eq('id', user.id)"), false)
  })

  test('the page still waits for the profile before drawing gated actions', () => {
    assert.ok(DETAIL_CODE.includes('if (loading || (!!signedInUserId && profilePending)) return <LoadingScreen />'))
  })

  test('the task, members, activity log and attachments are still loaded together', () => {
    const batch = DETAIL_CODE.slice(DETAIL_CODE.indexOf('await Promise.all(['))
    for (const read of [
      "supabase.from('tasks').select('*, creator:created_by(full_name)')",
      "supabase.from('users').select('id, full_name').eq('is_active', true)",
      "supabase.from('task_activity_log')",
      "supabase.from('task_attachments')",
    ]) assert.ok(batch.includes(read), read)
  })
})
