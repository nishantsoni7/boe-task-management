/**
 * The task archives are bounded reads.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * PostgREST caps a response at 1000 rows on this project. It is a CAP, not an
 * error: no error field, no warning, and a plausible-looking array.
 * src/lib/supabasePaging.ts records what that cost the Performance module — 75%
 * of an activity log silently discarded, every employee scoring zero, and a page
 * that was internally consistent and comprehensively wrong.
 *
 * These lists are exactly the shape that hits it. They only ever
 * grow, and each is ordered newest-first, so past a thousand rows the OLDEST
 * records stop appearing — the ones somebody opens an archive specifically to
 * find. Nothing looks wrong; the list just quietly stops going back far enough.
 *
 * The two COMPLETED archives no longer read in full at all: they ask the
 * database for one page of twenty plus an exact count (see the last describe
 * below), which cannot be clipped. The rest are still read whole, and pinned:
 *
 * These tests pin, for every archive read in full:
 *
 *   1. the read is PAGED, through the shared helper;
 *   2. the ordering is UNIQUE, so pages cannot overlap or leave gaps;
 *   3. a failed or truncated read is reported, not rendered as an empty archive.
 *
 * They are source-shape assertions because the alternative — proving the
 * truncation itself — needs a database with more than a thousand archived tasks
 * in it, which is exactly the situation nobody notices until it is too late.
 *
 * Run:
 *   npx tsx --test src/app/tasks/archiveListBounds.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Every Task Management list that grows without limit and is read in full. */
const ARCHIVES = [
  { label: 'cancelled tasks',               file: 'src/app/tasks/cancelled/page.tsx' },
  { label: 'cancelled tasks I assigned',    file: 'src/app/tasks/assigned-by-me/cancelled/page.tsx' },
  // Quotation requests are the same shape — they accumulate, the list is ordered
  // newest-first, and the tab counts are computed from these rows — but the read
  // itself now lives in a cached hook so returning from a quotation's detail page
  // does not re-read it. The same three guarantees are pinned on that hook and on
  // the page that consumes it, in their own describe below.
]

const source = (file: string) => readFileSync(file, 'utf8')

describe('every task archive is read in pages', () => {
  for (const { label, file } of ARCHIVES) {
    test(`${label} pages its read`, () => {
      const code = source(file)
      assert.ok(code.includes('fetchAllRows<Task>('),
        `${file}: the archive must be read through the shared paging helper`)
      assert.ok(code.includes('.range(from, to)'),
        `${file}: each page must be bounded`)
    })
  }

  test('none of them still issues a bare unbounded select over tasks', () => {
    // The exact shape that was there: a tasks select whose chain ends at
    // .order(...) with no range. Its return is what would be silently clipped.
    for (const { file } of ARCHIVES) {
      const code = source(file)
      const bare = /supabase\s*\.from\('tasks'\)\s*\.select\(TASK_COLUMNS\)(?:\s*\.\w+\([^)]*\))*\s*,/
      assert.ok(!bare.test(code), `${file}: an unbounded tasks select remains`)
    }
  })
})

describe('the ordering is unique, so pages cannot overlap or leave gaps', () => {
  for (const { label, file } of ARCHIVES) {
    test(`${label} breaks ties on a unique column`, () => {
      // range() maps to LIMIT/OFFSET, and Postgres promises nothing about row
      // order between two requests unless the ordering is deterministic. Two
      // tasks sharing a completion timestamp could otherwise swap across a page
      // boundary — returning one twice and losing the other entirely.
      const code = source(file)
      assert.ok(code.includes(".order('id', { ascending: false })"),
        `${file}: a unique tiebreak is required for stable paging`)
    })
  }
})

describe('a failed read is never rendered as an empty archive', () => {
  for (const { label, file } of ARCHIVES) {
    test(`${label} distinguishes "nothing here" from "could not load"`, () => {
      const code = source(file)

      // The result is inspected rather than defaulted. `taskResult.rows` is not
      // even reachable until `ok` has been narrowed — the helper's failure
      // branch carries no rows property at all — so a caller cannot quietly
      // compute from a partial read.
      assert.match(code, /(\w+)\.ok && !\1\.truncated \? null : \w*LOAD_ERROR/,
        `${file}: truncation and failure must both raise the notice`)
      assert.match(code, /set\w*Tasks\((\w+)\.ok \?/,
        `${file}: rows may only be read after ok is narrowed`)

      // And it reaches the screen.
      assert.ok(code.includes('{loadError && ('), `${file}: the notice must render`)
      assert.ok(code.includes('role="alert"'), `${file}: and be announced`)
    })

    test(`${label} shows the notice ALONGSIDE whatever loaded`, () => {
      // Replacing the list with an error throws away rows that arrived fine.
      // The banner sits above the list, and the list still renders.
      const code = source(file)
      const banner = code.indexOf('{loadError && (')
      const list = code.indexOf('{visibleTasks.length === 0 ? (')
      assert.ok(list > 0, `${file}: expected a visibleTasks empty-state branch`)
      assert.ok(banner > 0 && list > banner,
        `${file}: the notice must precede the list, not replace it`)
    })
  }
})

/**
 * Quotation requests: read in full, but through a CACHED hook.
 *
 * The bounds guarantees are unchanged — the read is paged, uniquely ordered, and
 * a failed or capped read is reported rather than rendered as an empty list.
 * What changed is where they live: the page used to do this in a `useEffect` on
 * every mount, so returning to it from a quotation blanked the screen behind a
 * LoadingScreen until a fresh permission resolve and a fresh paged read had both
 * finished. Those two guarantees — bounded reads, and a return that costs
 * nothing — are pinned together here so neither can be restored at the other's
 * expense.
 */
const QUOTATION_PAGE = 'src/app/tasks/quotation-requests/page.tsx'
const QUOTATION_HOOK = 'src/hooks/queries/useQuotationRequests.ts'

describe('quotation requests are read in pages, once, and cached', () => {
  test('the read is paged and bounded', () => {
    const hook = source(QUOTATION_HOOK)
    assert.ok(hook.includes('fetchAllRows<Task>('),
      `${QUOTATION_HOOK}: the list must be read through the shared paging helper`)
    assert.ok(hook.includes('.range(from, to)'), `${QUOTATION_HOOK}: each page must be bounded`)
  })

  test('the ordering breaks ties on a unique column', () => {
    assert.ok(source(QUOTATION_HOOK).includes(".order('id', { ascending: false })"),
      `${QUOTATION_HOOK}: a unique tiebreak is required for stable paging`)
  })

  test('a failed or capped read is reported, not rendered as an empty list', () => {
    const hook = source(QUOTATION_HOOK)
    // Both failure modes collapse into one honest flag. `rows` is unreachable
    // until `ok` has been narrowed, so a partial read cannot be returned as the
    // whole workload.
    assert.ok(hook.includes('if (!result.ok) return { rows: [], complete: false }'),
      `${QUOTATION_HOOK}: a failed read must not resolve as an empty list`)
    assert.ok(hook.includes('complete: !result.truncated'),
      `${QUOTATION_HOOK}: a capped read must be reported too`)

    const code = source(QUOTATION_PAGE)
    assert.ok(code.includes('(isError || (data && !data.complete)) ? QUOTATIONS_LOAD_ERROR : null'),
      `${QUOTATION_PAGE}: truncation and failure must both raise the notice`)
    assert.ok(code.includes('{loadError && ('), `${QUOTATION_PAGE}: the notice must render`)
    assert.ok(code.includes('role="alert"'), `${QUOTATION_PAGE}: and be announced`)
  })

  test('the notice sits alongside whatever loaded, not in place of it', () => {
    const code = source(QUOTATION_PAGE)
    const banner = code.indexOf('{loadError && (')
    const list = code.indexOf('{visibleTasks.length === 0 ? (')
    assert.ok(list > 0, `${QUOTATION_PAGE}: expected a visibleTasks empty-state branch`)
    assert.ok(banner > 0 && list > banner,
      `${QUOTATION_PAGE}: the notice must precede the list, not replace it`)
  })

  test('the page holds no read of its own — no tasks query, no second permission resolve', () => {
    const code = source(QUOTATION_PAGE)
    assert.equal(/\.from\('tasks'\)/.test(code), false,
      `${QUOTATION_PAGE}: the task read belongs to the hook`)
    assert.equal(/fetchAllRows\s*[<(]/.test(code), false,
      `${QUOTATION_PAGE}: the task read belongs to the hook`)
    // The shell already resolves these. Asking again put a `users.role` read and
    // a permission RPC on the critical path of every arrival, Back included.
    assert.equal(code.includes('getEffectivePermissions'), false,
      `${QUOTATION_PAGE}: permissions come from the shared cached context`)
    assert.equal(/supabase\s*\.from\('users'\)/.test(code), false,
      `${QUOTATION_PAGE}: the profile comes from the shared cached context`)
    assert.ok(code.includes('usePermissionContext()'),
      `${QUOTATION_PAGE}: the gate must read the shared cached context`)
  })

  test('the gate still precedes the read', () => {
    // Load-bearing: a direct URL must never fetch a row it may not show. The
    // permission answer is what enables the query, so the ordering survives the
    // move off `await`.
    const code = source(QUOTATION_PAGE)
    assert.ok(code.includes('useQuotationRequests(userId, ready && canViewQuotations)'),
      `${QUOTATION_PAGE}: the list query must be gated on the resolved permission`)
    const hook = source(QUOTATION_HOOK)
    assert.ok(hook.includes('enabled: allowed && isValidUUID(userId)'),
      `${QUOTATION_HOOK}: the gate must hold inside the hook too`)
  })

  test('a return does not re-read: the list is cached, and invalidated on mutation', () => {
    const hook = source(QUOTATION_HOOK)
    assert.ok(hook.includes('staleTime: 30 * 1000'), `${QUOTATION_HOOK}: the list must be cached`)
    assert.ok(hook.includes('gcTime: 5 * 60 * 1000'),
      `${QUOTATION_HOOK}: the cache must outlive a trip to a detail page`)

    // Cached rows must never be allowed to go stale silently: the detail page is
    // the only thing that mutates them, and it marks this key on every mutation.
    const detail = source('src/app/tasks/[id]/page.tsx')
    assert.ok(detail.includes('queryClient.invalidateQueries({ queryKey: QUOTATION_REQUESTS_KEY })'),
      'src/app/tasks/[id]/page.tsx: a task mutation must invalidate the quotation list')
  })

  test('a return paints the cached rows instead of the full-screen loader', () => {
    assert.ok(source(QUOTATION_PAGE).includes('const loading = !ready || !canViewQuotations || (isPending && !data)'),
      `${QUOTATION_PAGE}: cached data must render on the first frame`)
  })
})

/** Completed history: one database page at a time, never the whole archive. */
const COMPLETED_HISTORY = [
  { label: 'my completed tasks',         file: 'src/app/tasks/my/completed/page.tsx' },
  { label: 'completed tasks I assigned', file: 'src/app/tasks/assigned-by-me/completed/page.tsx' },
]
const COMPLETED_HOOK = 'src/hooks/queries/useCompletedTasks.ts'

describe('completed history is paged by the database, not read in full', () => {
  test('each request is one bounded page plus an exact total', () => {
    const hook = source(COMPLETED_HOOK)
    assert.ok(hook.includes(".select(COMPLETED_TASK_COLUMNS, { count: 'exact' })"),
      'the total must come from the database, not from rows held in the browser')
    assert.ok(hook.includes('const { from, to } = completedPageRange(page)'))
    assert.ok(hook.includes('.range(from, to)'), 'each page must be bounded')
  })

  test('the ordering is by completion and unique, so pages cannot overlap or leave gaps', () => {
    const hook = source(COMPLETED_HOOK)
    const byCompletion = hook.indexOf(".order('completed_at', { ascending: false, nullsFirst: false })")
    const tiebreak = hook.indexOf(".order('id', { ascending: false })", byCompletion)
    assert.ok(byCompletion > 0, 'newest completion first')
    assert.ok(tiebreak > byCompletion, 'a unique tiebreak is required for stable paging')
  })

  test('the one read that still spans the archive — filter options — is paged through the helper', () => {
    const hook = source(COMPLETED_HOOK)
    assert.ok(hook.includes('fetchAllRows<Record<string, string | null>>('))
    assert.ok(hook.includes('if (!result.ok) throw new Error(result.error)'))
  })

  test('a failed page rejects instead of resolving empty', () => {
    assert.ok(source(COMPLETED_HOOK).includes('if (error) throw error'))
  })

  for (const { label, file } of COMPLETED_HISTORY) {
    test(`${label} reads through the paged hook, never the whole archive`, () => {
      const code = source(file)
      assert.ok(code.includes('useCompletedTaskPage(SCOPE, userId, {'))
      // Usage, not the word: the page's comments explain that it no longer uses it.
      assert.equal(code.includes("from '@/lib/supabasePaging'"), false, `${file}: must not read the archive in full`)
      assert.equal(/fetchAllRows\s*[<(]/.test(code), false, `${file}: must not read the archive in full`)
      assert.equal(/\.from\('tasks'\)/.test(code), false, `${file}: task reads belong to the hook`)
    })

    test(`${label} says a failed read out loud, above whatever loaded`, () => {
      const code = source(file)
      assert.ok(code.includes('const loadError = pageQuery.isError ? ARCHIVE_LOAD_ERROR : null'))
      assert.ok(code.includes('role="alert"'))
      const banner = code.indexOf('{loadError && (')
      const list = code.indexOf('{visibleTasks.length === 0 ? (')
      assert.ok(banner > 0 && list > banner, `${file}: the notice must precede the list, not replace it`)
    })
  }
})

describe('the shared helper is the one that reports rather than under-reports', () => {
  test('it caps a runaway loop and says when it did', () => {
    const helper = source('src/lib/supabasePaging.ts')
    assert.ok(helper.includes('PAGED_FETCH_ROW_CAP'))
    assert.ok(helper.includes('truncated'),
      'the helper must be able to say it did not read everything')
  })

  test('and its failure branch carries no rows at all', () => {
    // This is what makes "check ok first" a compile error rather than a
    // convention — the previous shape returned { rows, error } together, and a
    // caller who forgot to check would silently compute from a partial read.
    const helper = source('src/lib/supabasePaging.ts')
    assert.ok(helper.includes('no `rows` property at all'))
  })
})
