'use client'

import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { fetchAllRows } from '@/lib/supabasePaging'
import { countReviewsByType, type CountsByType } from '@/lib/customerReviews/reviewTypes'
import type { ReviewType, TestCardStatus } from '@/lib/customerReviews/types'

// ── Per-employee progress, for the people accountable for it ─────────────────
//
// FOUR NUMBERS PER PERSON: assigned, posted, verified, remaining. That is what
// requirement 9 asks for and it is deliberately all of it — no charts, no
// trend, no ranking, no percentage. This is an operations table somebody reads
// to answer "is anybody stuck", not a performance scoreboard.
//
// ── THE ONE THING WORTH READING CAREFULLY ──────────────────────────────────
//
// THIS IS A COUNT SOURCE, NOT A LIST, and the query is shaped so that it cannot
// become one. It selects `assigned_to`, `status`, `review_type` and
// `deleted_at` — and NOT card_ref, NOT test_title, NOT test_body. There is
// nothing in what comes back that could be rendered as a review.
//
// That distinction matters because the module's standing rule is that a
// VERIFIED REVIEW IS IN NO LIST AT ALL: it is the last status in the workflow
// and a finished review leaves the frontend, not into a History tab and not
// into a filter somebody could clear. TAB_STATUSES on the list screen still
// names no tab that asks for one, and that is still what enforces the rule.
//
// A COUNT of verified reviews is a different thing from a list of them, and
// management genuinely needs it — "7 posted, 6 verified" is the sentence that
// says whether the verifier is behind. So the count is read, the text is not,
// and there is no code path here that could show a person which reviews they
// were.
//
// EVERY NUMBER IS COMPUTED BY countReviewsByType(), the same function the
// candidate's own screen uses. Two screens that computed "posted" differently
// would be two screens that disagree about whether somebody has finished.
//
// RLS DECIDES WHAT COMES BACK, as always. A candidate running this query gets
// their own rows and nothing else, which is why the component is rendered only
// for a verifier: for anybody else it would be a one-row table about themselves.

type CountRow = {
  assigned_to: string | null
  status: TestCardStatus
  review_type: ReviewType
  deleted_at: string | null
}

type Row = { id: string; name: string; counts: CountsByType }

const CELL: React.CSSProperties = {
  padding: '7px 10px', fontSize: '12px', textAlign: 'right',
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

const HEAD: React.CSSProperties = {
  ...CELL, fontSize: '11px', fontWeight: 700, color: colors.secondary,
  textTransform: 'uppercase', letterSpacing: '0.04em',
}

export function EmployeeProgress({ supabase }: { supabase: SupabaseClient }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    // fetchAllRows, not a bare select: PostgREST silently caps a read at 1000
    // rows, and a capped count is a wrong count rather than a short list.
    const result = await fetchAllRows<CountRow>(
      (from, to) => supabase
        .from('customer_review_test_cards')
        .select('assigned_to, status, review_type, deleted_at')
        .not('assigned_to', 'is', null)
        .is('deleted_at', null)
        .range(from, to),
    )

    if (!result.ok) {
      setError('The assignment summary could not be loaded. Refresh to try again.')
      setRows([])
      return
    }

    const byEmployee = new Map<string, CountRow[]>()
    for (const row of result.rows) {
      if (!row.assigned_to) continue
      const list = byEmployee.get(row.assigned_to)
      if (list) list.push(row)
      else byEmployee.set(row.assigned_to, [row])
    }

    const ids = [...byEmployee.keys()]
    const names = new Map<string, string>()
    if (ids.length > 0) {
      // Named columns, never `*` — a `select('*')` against public.users is a
      // permission error in this project (src/lib/users/safeColumns.ts).
      const { data: people } = await supabase
        .from('users')
        .select('id, full_name')
        .in('id', ids)
      for (const person of (people ?? []) as { id: string; full_name: string | null }[]) {
        names.set(person.id, person.full_name ?? 'Unnamed employee')
      }
    }

    setError('')
    setRows(
      ids
        .map(id => ({
          id,
          name: names.get(id) ?? 'Unnamed employee',
          counts: countReviewsByType(byEmployee.get(id) ?? []),
        }))
        // MOST OUTSTANDING WORK FIRST, because the reason to open this table is
        // to find whoever is furthest behind. Ties fall back to the name so the
        // order is stable between loads rather than whatever the rows arrived in.
        .sort((a, b) =>
          b.counts.all.remaining - a.counts.all.remaining || a.name.localeCompare(b.name)),
    )
  }, [supabase])

  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  if (error) {
    return <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{error}</p>
  }
  if (rows === null) {
    return <p style={{ fontSize: '12px', color: colors.muted, margin: 0 }}>Loading…</p>
  }
  if (rows.length === 0) {
    return (
      <p style={{
        margin: 0, padding: '18px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.6,
        border: `1px dashed ${colors.border}`, color: colors.muted,
      }}>
        No batch has been assigned yet. Approve a batch of twelve and assign it to an employee
        from the Pending approval tab.
      </p>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', minWidth: '520px', width: '100%' }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
            <th style={{ ...HEAD, textAlign: 'left' }}>Employee</th>
            <th style={HEAD}>Assigned</th>
            <th style={HEAD}>Posted</th>
            <th style={HEAD}>Verified</th>
            <th style={HEAD}>Remaining</th>
            <th style={{ ...HEAD, textAlign: 'left' }}>Text / Image</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
              <td style={{ ...CELL, textAlign: 'left', fontWeight: 600, color: colors.primary }}>
                {row.name}
              </td>
              <td style={CELL}>{row.counts.all.assigned}</td>
              <td style={{ ...CELL, color: '#166534', fontWeight: 600 }}>{row.counts.all.posted}</td>
              <td style={CELL}>{row.counts.all.verified}</td>
              <td style={{ ...CELL, color: row.counts.all.remaining > 0 ? '#92400E' : colors.muted, fontWeight: 600 }}>
                {row.counts.all.remaining}
              </td>
              <td style={{ ...CELL, textAlign: 'left', color: colors.secondary }}>
                {row.counts.text.posted}/{row.counts.text.assigned}
                {' · '}
                {row.counts.image.posted}/{row.counts.image.assigned}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
