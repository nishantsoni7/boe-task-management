'use client'

// One fetch of the objection list, shared by the places an admin meets it.
//
// The row indicator on the period results, the panel on a payslip and the queue
// on the correction log are three views of the same list. Fetching it once and
// indexing it here is what keeps them from disagreeing about whether something
// is still pending — an admin who sees "Issue Pending" on a row and then no
// issue on the payslip has been told two different things.

import { useCallback, useEffect, useState } from 'react'
import { groupIssueChains, type ObjectionRow } from '@/lib/objections'

export type ObjectionIndex = {
  all: ObjectionRow[]
  /** Newest objection per payroll_result_id. */
  byResult: Map<string, ObjectionRow>
  /** Newest objection per attendance date. */
  byDate: Map<string, ObjectionRow>
  /**
   * Every attempt against one record, oldest first, keyed by issueChainKey().
   *
   * An employee may raise the same matter again once a decision has been made,
   * so "the objection on this payslip" and "everything said about this payslip"
   * are two different lists. The badges above read the first; History reads
   * this.
   */
  chains: Map<string, ObjectionRow[]>
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useObjections(token: string): ObjectionIndex {
  const [all,     setAll]     = useState<ObjectionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!token) return
    setLoading(true)
    const res  = await fetch('/api/objections', { headers: { authorization: `Bearer ${token}` } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) setError(json.error ?? 'Could not load reported issues')
    else { setAll(json.objections ?? []); setError(null) }
    setLoading(false)
  }, [token])

  // Deferred to a microtask: reload() sets state (loading) as its first
  // statement, before its first await, which would otherwise run
  // synchronously inside this effect's own call stack.
  useEffect(() => { queueMicrotask(() => { void reload() }) }, [reload])

  // The API returns newest first, so the first hit for a key is the current one.
  const byResult = new Map<string, ObjectionRow>()
  const byDate   = new Map<string, ObjectionRow>()
  for (const o of all) {
    if (o.payroll_result_id && !byResult.has(o.payroll_result_id)) byResult.set(o.payroll_result_id, o)
    if (o.attendance_date   && !byDate.has(o.attendance_date))     byDate.set(o.attendance_date, o)
  }

  return { all, byResult, byDate, chains: groupIssueChains(all), loading, error, reload }
}
