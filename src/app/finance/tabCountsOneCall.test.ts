// THE FOUR PAYMENT REQUESTS BADGES IN ONE CALL (2026-11-15, page speed part 11).
// finance_payment_request_tab_counts (20270719000000) must count exactly what the page's four queries count, under
// the caller's own row-level security, and the page must fall back to the four queries when it cannot use it.
// Run with: npx tsx --test src/app/finance/tabCountsOneCall.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COUNTED_TABS, REQUEST_STAGE_STATUSES, tabMatches } from './paymentRequestsQuery'

const ROOT = join(__dirname, '..', '..', '..')
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20270719000000_finance_payment_request_tab_counts.sql'), 'utf8')
  .replace(/\r/g, '')
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '')
const PAGE = readFileSync(join(ROOT, 'src/app/finance/page.tsx'), 'utf8').replace(/\r/g, '')

/** The function's rule, written out exactly as the SQL says it, for a row in hand. */
function sqlCounts(rows: { status: string; rejected_at: string | null; updated_at: string | null }[], cutoffMs: number) {
  const scoped = rows.filter(r => ['pending_approval', 'needs_clarification', 'rejected'].includes(r.status))
  const ts = (r: { rejected_at: string | null; updated_at: string | null }) => r.rejected_at ?? r.updated_at
  const archived = (r: typeof rows[number]) => ts(r) !== null && new Date(ts(r) as string).getTime() <= cutoffMs
  return {
    pending: scoped.filter(r => r.status === 'pending_approval').length,
    clarification: scoped.filter(r => r.status === 'needs_clarification').length,
    rejected: scoped.filter(r => r.status === 'rejected' && (ts(r) === null || !archived(r))).length,
    archive: scoped.filter(r => r.status === 'rejected' && archived(r)).length,
  }
}

describe('the function counts what the four queries count', () => {
  test('the scope is the request-stage statuses, and the four outputs are the counted tabs', () => {
    assert.deepEqual([...REQUEST_STAGE_STATUSES], ['pending_approval', 'needs_clarification', 'rejected'])
    assert.match(SQL, /where r\.status in \('pending_approval', 'needs_clarification', 'rejected'\)/)
    assert.match(SQL, /returns table \(pending bigint, clarification bigint, rejected bigint, archive bigint\)/)
    assert.deepEqual(COUNTED_TABS, ['pending', 'clarification', 'rejected', 'archive'])
  })

  test('its rule gives the same four numbers as the page\'s own tab rule, row by row', () => {
    const cutoffMs = Date.parse('2026-10-16T00:00:00Z')
    const rows = [
      { status: 'pending_approval', rejected_at: null, updated_at: '2026-11-01T00:00:00Z' },
      { status: 'needs_clarification', rejected_at: null, updated_at: '2026-09-01T00:00:00Z' },
      { status: 'rejected', rejected_at: '2026-11-10T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' },
      { status: 'rejected', rejected_at: '2026-10-01T00:00:00Z', updated_at: '2026-11-10T00:00:00Z' },
      { status: 'rejected', rejected_at: null, updated_at: '2026-09-30T00:00:00Z' },
      { status: 'rejected', rejected_at: null, updated_at: '2026-11-02T00:00:00Z' },
      { status: 'rejected', rejected_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z' },
      { status: 'rejected', rejected_at: null, updated_at: null },
      { status: 'approved_linked', rejected_at: null, updated_at: '2026-11-01T00:00:00Z' },
    ]
    const fromPage = Object.fromEntries(COUNTED_TABS.map(tab => [tab, rows.filter(r => tabMatches(r, tab, cutoffMs)).length]))
    assert.deepEqual(sqlCounts(rows, cutoffMs), fromPage)
  })

  test('the archive line is coalesce(rejected_at, updated_at) <= cutoff, and rejected is its exact complement', () => {
    assert.match(SQL, /r\.status = 'rejected'\s*and coalesce\(r\.rejected_at, r\.updated_at\) <= p_cutoff/)
    assert.match(SQL, /coalesce\(r\.rejected_at, r\.updated_at\) is null\s*or coalesce\(r\.rejected_at, r\.updated_at\) > p_cutoff/)
  })

  test('it reads as the caller (row-level security decides), changes nothing, and anon cannot run it', () => {
    assert.match(SQL, /security invoker/)
    assert.equal(/security definer/i.test(SQL), false)
    assert.match(SQL, /\bstable\b/)
    assert.equal(/\b(insert|update|delete|alter table|drop table)\b/i.test(SQL.replace(/raise exception[^;]*;/g, '')), false)
    assert.match(SQL, /revoke all on function public\.finance_payment_request_tab_counts\(timestamptz\) from public, anon/)
    assert.match(SQL, /grant execute on function public\.finance_payment_request_tab_counts\(timestamptz\) to authenticated/)
  })
})

describe('the page', () => {
  test('uses the one call only when no search is typed, and falls back to the four queries otherwise', () => {
    assert.match(PAGE, /\(!filters\.search \? await countTabsAtOnce\(cutoffIso\) : null\) \?\? await Promise\.all\(COUNTED_TABS\.map/)
    assert.match(PAGE, /supabase\.rpc\('finance_payment_request_tab_counts', \{ p_cutoff: cutoffIso \}\)/)
  })

  test('any failure, or an answer that is not four non-negative numbers, is not trusted', () => {
    const fn = PAGE.slice(PAGE.indexOf('const countTabsAtOnce'), PAGE.indexOf('const loadCounts'))
    assert.match(fn, /if \(error \|\| !row\) return null/)
    assert.match(fn, /Number\.isFinite\(n\) && n >= 0\) \? counted : null/)
  })
})
