/**
 * What the Payment Requests list asks the database.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * The headline claim, and the one that would be easy to get quietly wrong: the
 * five tabs mean EXACTLY the same thing as database filters as they did as an
 * in-memory predicate. `tabMatches()` is what the page applies to rows it holds;
 * `tabClauses()` is what it asks PostgREST for. If those two ever disagree, a
 * tab's badge and its contents disagree, and a record sits in a tab that will
 * not load it.
 *
 * So the clauses are not merely compared against expected strings — they are
 * EVALUATED, by a small interpreter for the PostgREST filter subset this module
 * emits, against the same rows `tabMatches` is given. Every row, every tab.
 *
 * Also pinned: the list is bounded, the tabs partition the data the way the
 * badges claim, and search covers the column the table leads with.
 *
 * Run:
 *   npx tsx --test src/app/finance/paymentRequestsQuery.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ARCHIVE_WINDOW_MS,
  COUNTED_TABS,
  FILTER_TAB_KEYS,
  PAYMENT_REQUESTS_PAGE_SIZE,
  PAYMENT_REQUESTS_SEARCH_COLUMNS,
  REQUEST_STAGE_STATUSES,
  archiveCutoffIso,
  clampPage,
  isArchivedRejected,
  pageCount,
  pageRange,
  parseFilterTab,
  paymentRequestsSearchFilter,
  tabClauses,
  tabCounts,
  tabMatches,
  type FilterTab,
  type QueryClause,
} from './paymentRequestsQuery'

// ── A PostgREST filter interpreter, for the subset this module emits ─────────
//
// Supports exactly what tabClauses produces: `eq`, and `or` groups whose members
// are `col.op.value` or a nested `and(...)`. Anything else throws rather than
// being silently treated as true — a test helper that quietly passes an
// unrecognised filter would prove nothing.

type Row = { status: string; rejected_at?: string | null; updated_at?: string | null }

/** Split an or/and body on top-level commas, respecting nested brackets. */
function splitTop(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  if (current !== '') parts.push(current)
  return parts
}

function evalTerm(row: Row, term: string): boolean {
  const nested = /^(and|or)\((.*)\)$/.exec(term.trim())
  if (nested) {
    const members = splitTop(nested[2]).map(m => evalTerm(row, m))
    return nested[1] === 'and' ? members.every(Boolean) : members.some(Boolean)
  }

  // col.op.value — the value may itself contain dots (an ISO timestamp does).
  const match = /^([a-z_]+)\.([a-z]+)\.(.*)$/.exec(term.trim())
  if (!match) throw new Error(`unparseable filter term: ${term}`)
  const [, column, op, rawValue] = match

  const cell = (row as Record<string, string | null | undefined>)[column] ?? null

  switch (op) {
    case 'is':  {
      if (rawValue !== 'null') throw new Error(`unsupported is.${rawValue}`)
      return cell === null
    }
    case 'eq':  return cell === rawValue
    case 'neq': return cell !== rawValue
    // A NULL never satisfies a comparison — the same as SQL, and the reason the
    // archived branch does not have to name the null case a second time.
    case 'lte': return cell !== null && cell <= rawValue
    case 'gt':  return cell !== null && cell > rawValue
    default: throw new Error(`unsupported operator: ${op}`)
  }
}

/** Apply a whole clause list as the page does: every clause ANDed. */
function evalClauses(row: Row, clauses: readonly QueryClause[]): boolean {
  return clauses.every(clause => {
    switch (clause.kind) {
      case 'eq':      return (row as Record<string, unknown>)[clause.column] === clause.value
      case 'isNull':  return ((row as Record<string, unknown>)[clause.column] ?? null) === null
      case 'notNull': return ((row as Record<string, unknown>)[clause.column] ?? null) !== null
      case 'in':      return clause.values.includes(String((row as Record<string, unknown>)[clause.column]))
      case 'or':      return splitTop(clause.filters).some(term => evalTerm(row, term))
    }
  })
}

/** The status scope the caller always applies alongside the tab clauses. */
function inRequestStage(row: Row): boolean {
  return (REQUEST_STAGE_STATUSES as readonly string[]).includes(row.status)
}

// ── The corpus ────────────────────────────────────────────────────────────────
// Every combination that can decide the archive rule, plus the statuses that
// must never appear at all.

const NOW = Date.parse('2026-08-22T12:00:00.000Z')
const CUTOFF_ISO = archiveCutoffIso(NOW)
const CUTOFF_MS = NOW - ARCHIVE_WINDOW_MS

const OLD = new Date(CUTOFF_MS - 60_000).toISOString()   // before the cutoff
const EXACT = new Date(CUTOFF_MS).toISOString()          // exactly on it
const NEW = new Date(CUTOFF_MS + 60_000).toISOString()   // after it

const CORPUS: { label: string; row: Row }[] = [
  { label: 'pending',                       row: { status: 'pending_approval', rejected_at: null, updated_at: NEW } },
  { label: 'pending, old',                  row: { status: 'pending_approval', rejected_at: null, updated_at: OLD } },
  { label: 'pending, no dates',             row: { status: 'pending_approval', rejected_at: null, updated_at: null } },
  { label: 'clarification',                 row: { status: 'needs_clarification', rejected_at: null, updated_at: NEW } },
  { label: 'clarification, old',            row: { status: 'needs_clarification', rejected_at: null, updated_at: OLD } },
  { label: 'rejected recently',             row: { status: 'rejected', rejected_at: NEW, updated_at: NEW } },
  { label: 'rejected long ago',             row: { status: 'rejected', rejected_at: OLD, updated_at: NEW } },
  { label: 'rejected exactly on cutoff',    row: { status: 'rejected', rejected_at: EXACT, updated_at: NEW } },
  { label: 'rejected, no rejected_at, new', row: { status: 'rejected', rejected_at: null, updated_at: NEW } },
  { label: 'rejected, no rejected_at, old', row: { status: 'rejected', rejected_at: null, updated_at: OLD } },
  { label: 'rejected, no dates at all',     row: { status: 'rejected', rejected_at: null, updated_at: null } },
  // Must never appear in any tab: a confirmed payment is not a request.
  { label: 'approved_unlinked',             row: { status: 'approved_unlinked', rejected_at: null, updated_at: NEW } },
  { label: 'approved_linked',               row: { status: 'approved_linked', rejected_at: null, updated_at: NEW } },
]

// ── THE HEADLINE TEST ─────────────────────────────────────────────────────────

describe('the database filters and the in-memory predicate are ONE rule', () => {
  for (const tab of FILTER_TAB_KEYS) {
    test(`the "${tab}" tab agrees on every row`, () => {
      const clauses = tabClauses(tab, CUTOFF_ISO)
      for (const { label, row } of CORPUS) {
        // What the page would keep, over rows already in memory.
        const inMemory = tabMatches(row, tab, CUTOFF_MS)
        // What the query would return: the status scope, then the tab clauses.
        const fromQuery = inRequestStage(row) && evalClauses(row, clauses)
        assert.equal(fromQuery, inMemory,
          `${tab} disagreed about "${label}": query=${fromQuery} memory=${inMemory}`)
      }
    })
  }

  test('a confirmed payment reaches no tab, by either route', () => {
    // The query is scoped to the three request-stage statuses and this is the
    // second, independent gate. Neither may let one through.
    for (const status of ['approved_unlinked', 'approved_linked']) {
      const row: Row = { status, rejected_at: null, updated_at: NEW }
      for (const tab of FILTER_TAB_KEYS) {
        assert.equal(tabMatches(row, tab, CUTOFF_MS), false, `${status} in ${tab}`)
        assert.equal(inRequestStage(row), false)
      }
    }
  })
})

// ── The tabs partition the data the way the badges claim ─────────────────────

describe('the tabs partition the records', () => {
  test('rejected and archive are exclusive and together cover every rejected row', () => {
    for (const { label, row } of CORPUS) {
      if (row.status !== 'rejected') continue
      const active = tabMatches(row, 'rejected', CUTOFF_MS)
      const archived = tabMatches(row, 'archive', CUTOFF_MS)
      assert.notEqual(active, archived, `"${label}" must be in exactly one of the two`)
    }
  })

  test('"all" is exactly pending + clarification + rejected', () => {
    // This is why only FOUR counts are queried. If it were ever untrue the
    // derived 'all' badge would be wrong on every page load.
    const inAll = CORPUS.filter(c => tabMatches(c.row, 'all', CUTOFF_MS))
    const sum = (['pending', 'clarification', 'rejected'] as FilterTab[])
      .flatMap(tab => CORPUS.filter(c => tabMatches(c.row, tab, CUTOFF_MS)))
    assert.equal(inAll.length, sum.length)
    assert.deepEqual(new Set(inAll.map(c => c.label)), new Set(sum.map(c => c.label)))
  })

  test('and "all" excludes the archived rows', () => {
    const archived = CORPUS.filter(c => tabMatches(c.row, 'archive', CUTOFF_MS))
    assert.ok(archived.length > 0, 'the corpus must contain archived rows for this to mean anything')
    for (const { label, row } of archived) {
      assert.equal(tabMatches(row, 'all', CUTOFF_MS), false, label)
    }
  })

  test('only four tabs are counted, and the fifth is derived', () => {
    assert.deepEqual(COUNTED_TABS, ['pending', 'clarification', 'rejected', 'archive'])
    assert.ok(!COUNTED_TABS.includes('all'), 'the "all" badge is a sum, not a fifth round trip')
  })
})

// ── The archive boundary ──────────────────────────────────────────────────────

describe('the archive boundary', () => {
  test('a rejection exactly on the cutoff is archived, not active', () => {
    // `<=` in the original predicate. Stated so the boundary cannot flip
    // silently and move a record between two tabs.
    const row: Row = { status: 'rejected', rejected_at: EXACT, updated_at: NEW }
    assert.equal(isArchivedRejected(row, CUTOFF_MS), true)
    assert.equal(tabMatches(row, 'archive', CUTOFF_MS), true)
    assert.equal(tabMatches(row, 'rejected', CUTOFF_MS), false)
  })

  test('rejected_at wins over updated_at when both are present', () => {
    // A row rejected long ago but touched yesterday is still an old rejection.
    const row: Row = { status: 'rejected', rejected_at: OLD, updated_at: NEW }
    assert.equal(isArchivedRejected(row, CUTOFF_MS), true)
  })

  test('updated_at stands in only when rejected_at is null', () => {
    assert.equal(isArchivedRejected({ status: 'rejected', rejected_at: null, updated_at: OLD }, CUTOFF_MS), true)
    assert.equal(isArchivedRejected({ status: 'rejected', rejected_at: null, updated_at: NEW }, CUTOFF_MS), false)
  })

  test('a rejected row with NO dates is never archived — it cannot vanish', () => {
    // The original rule, kept deliberately: a record that lost its timestamps
    // stays visible in the active view rather than disappearing into Archive.
    const row: Row = { status: 'rejected', rejected_at: null, updated_at: null }
    assert.equal(isArchivedRejected(row, CUTOFF_MS), false)
    assert.equal(tabMatches(row, 'rejected', CUTOFF_MS), true)
    assert.equal(tabMatches(row, 'archive', CUTOFF_MS), false)
  })

  test('a non-rejected row is never archived, whatever its dates', () => {
    for (const status of ['pending_approval', 'needs_clarification']) {
      assert.equal(isArchivedRejected({ status, rejected_at: OLD, updated_at: OLD }, CUTOFF_MS), false)
    }
  })

  test('the cutoff is derived from a given instant, not from the clock', () => {
    // Five count queries each reading their own Date.now() could, at the
    // boundary, return counts that do not sum. One instant, one cutoff.
    assert.equal(archiveCutoffIso(NOW), new Date(NOW - ARCHIVE_WINDOW_MS).toISOString())
    assert.equal(archiveCutoffIso(NOW), archiveCutoffIso(NOW))
  })
})

// ── The badges ────────────────────────────────────────────────────────────────

describe('the tab badges', () => {
  test('"all" is the sum of the three active tabs', () => {
    const counts = tabCounts({ pending: 3, clarification: 2, rejected: 4, archive: 9 })
    assert.equal(counts.all, 9)
    assert.equal(counts.archive, 9)
  })

  test('a badge whose parts are unknown says nothing rather than a wrong number', () => {
    // A partial sum would understate the tab and send somebody looking for
    // records it claims are not there.
    const counts = tabCounts({ pending: 3, clarification: null, rejected: 4, archive: 1 })
    assert.equal(counts.all, null)
    assert.equal(counts.pending, 3)
  })

  test('an entirely failed count leaves every badge unknown', () => {
    const counts = tabCounts({})
    for (const tab of FILTER_TAB_KEYS) assert.equal(counts[tab], null, tab)
  })
})

// ── Paging ────────────────────────────────────────────────────────────────────

describe('the list is bounded, so PostgREST cannot truncate it silently', () => {
  test('the page size is under the 1000-row cap', () => {
    assert.ok(PAYMENT_REQUESTS_PAGE_SIZE > 0)
    assert.ok(PAYMENT_REQUESTS_PAGE_SIZE < 1000)
  })

  test('pages are contiguous and never overlap', () => {
    const first = pageRange(1)
    const second = pageRange(2)
    assert.equal(second.from, first.to + 1)
  })

  test('a page beyond the end is clamped back into range', () => {
    // Switching to a tab with fewer records must not leave the reader staring at
    // an empty table over a filter that matches plenty.
    assert.equal(clampPage(4, 10), 1)
    assert.equal(clampPage(2, PAYMENT_REQUESTS_PAGE_SIZE * 3), 2)
    assert.equal(clampPage(0, 500), 1)
    assert.equal(clampPage(1, 0), 1)
  })

  test('page counts round up', () => {
    assert.equal(pageCount(PAYMENT_REQUESTS_PAGE_SIZE + 1), 2)
    assert.equal(pageCount(0), 1)
  })
})

// ── Search ────────────────────────────────────────────────────────────────────

describe('search finds a request by what the row displays', () => {
  test('THE DEFECT: the request number is searchable', () => {
    // It is the FIRST column of this table too, and searching for one returned
    // nothing — the same gap Received Payments had.
    assert.ok(PAYMENT_REQUESTS_SEARCH_COLUMNS.includes('request_number'))
    assert.ok(paymentRequestsSearchFilter('REQ-2026-0024')!
      .includes('request_number.ilike.*REQ-2026-0024*'))
  })

  test('the columns the list already searched are still covered', () => {
    const filter = paymentRequestsSearchFilter('x')!
    assert.ok(filter.includes('client_name.ilike.*x*'))
    assert.ok(filter.includes('order_number.ilike.*x*'))
  })

  test('a term that structures a filter group is neutralised', () => {
    const filter = paymentRequestsSearchFilter('a,status.eq.approved_linked')!
    assert.equal(filter.split(',').length, PAYMENT_REQUESTS_SEARCH_COLUMNS.length,
      'one clause per column, whatever was typed')
  })

  test('no search is NULL, not an empty filter', () => {
    assert.equal(paymentRequestsSearchFilter(''), null)
    assert.equal(paymentRequestsSearchFilter('%%%'), null)
  })
})

// ── Deep links ────────────────────────────────────────────────────────────────

describe('?tab= deep links', () => {
  test('every known tab round-trips', () => {
    for (const tab of FILTER_TAB_KEYS) assert.equal(parseFilterTab(tab), tab)
  })

  test('a stale or missing tab falls back to pending rather than throwing', () => {
    // ?tab=order_pending is a link from before confirmed payments left this page.
    for (const bad of [null, '', 'order_pending', 'nonsense']) {
      assert.equal(parseFilterTab(bad), 'pending')
    }
  })
})

// ── The wiring ────────────────────────────────────────────────────────────────

describe('the page issues a bounded, server-filtered read', () => {
  const page = readFileSync('src/app/finance/page.tsx', 'utf8')

  test('the list read is bounded and counted by the database', () => {
    assert.ok(page.includes('.range(range.from, range.to)'), 'the list must be paged')
    assert.ok(page.includes("count: 'exact'"), 'the total must come from the database')
  })

  test('the tab is applied as a filter, not over rows already loaded', () => {
    assert.ok(page.includes('tabClauses('), 'the tab narrows the query')
    assert.ok(!/requests\.filter\(r => matchesTab/.test(page),
      'the old client-side tab filter over the whole list must be gone')
  })

  test('search is applied as a filter too', () => {
    assert.ok(page.includes('paymentRequestsSearchFilter('))
    assert.ok(!/list\.filter\(r =>\s*\n?\s*r\.client_name\.toLowerCase\(\)/.test(page),
      'the old client-side search must be gone')
  })

  test('the ordering is deterministic, so pages cannot overlap', () => {
    // range() maps to LIMIT/OFFSET, which promises nothing about row order
    // unless the ordering is unique. Two requests created in the same instant
    // could otherwise swap between pages, showing one twice and hiding the other.
    assert.ok(page.includes(`.order('created_at', { ascending: false })`))
    assert.ok(page.includes(`.order('id', { ascending: false })`),
      'a unique tiebreak is required for stable paging')
  })

  test('the in-memory gate is kept as a second, independent check', () => {
    assert.ok(page.includes('tabMatches('),
      'a locally stale row must not linger in a tab the query would not return it for')
  })

  // ── The badges are counted for the SEARCH, not for the open tab ─────────────

  test('the four badges do not depend on which tab is open', () => {
    // The premise the saving below rests on, asserted rather than assumed:
    // loadCounts walks COUNTED_TABS — a fixed list — and never reads activeTab,
    // so every badge is already correct whichever tab the reader is on.
    const loadCounts = page.slice(page.indexOf('const loadCounts ='))
    const body = loadCounts.slice(0, loadCounts.indexOf('\n  }\n'))
    assert.ok(body.includes('COUNTED_TABS.map('), 'the counts are per COUNTED_TABS')
    assert.ok(!body.includes('activeTab'),
      'a count that read the open tab would have to be recomputed when it changed')
  })

  test('a tab click re-reads the rows and keeps the counts already on screen', () => {
    // THE DEFECT: selecting a tab ran the full reload — one list query AND four
    // head-count queries — to arrive at the same four numbers it started with.
    // Five round trips where one was needed, on the most-clicked control on the
    // page.
    assert.ok(page.includes('if (countedSearch.current === filters.search) {'),
      'the counts are re-run only when the set they describe has moved')
    assert.ok(page.includes('const countedSearch = useRef<string | null | undefined>(undefined)'),
      'undefined until the first count, which no real filter value equals')
    assert.ok(page.includes('countedSearch.current = filters.search'),
      'and the search the badges describe is recorded by the function that counts them')
  })

  test('a search change still recounts, because the badges describe the searched set', () => {
    // Selecting a tab also clears the search, so the two genuinely do move
    // together when a search was active. Comparing the VALUE is what keeps that
    // case counting instead of showing badges for a term no longer applied.
    const effect = page.slice(page.indexOf('const delay = filters.search === null'))
    const body = effect.slice(0, effect.indexOf('}, [filters.search, activeTab])'))
    assert.ok(body.includes('reload()'), 'a changed search runs the full reload')
    assert.ok(body.includes('loadRequests(new Date(cutoffMs).toISOString())'),
      'and an unchanged one re-reads only the rows, against the cutoff the badges were counted with')
  })
})
