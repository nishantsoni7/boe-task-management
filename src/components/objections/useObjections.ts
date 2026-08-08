'use client'

// One fetch of the objection list, shared by the places an admin meets it.
//
// The row indicator on the period results, the panel on a payslip and the queue
// on the correction log are three views of the same list. Fetching it once and
// indexing it here is what keeps them from disagreeing about whether something
// is still pending — an admin who sees "Issue Pending" on a row and then no
// issue on the payslip has been told two different things.

import { useCallback, useEffect, useState } from 'react'
import type { ObjectionRow } from '@/lib/objections'

export type ObjectionIndex = {
  all: ObjectionRow[]
  /** Newest objection per payroll_result_id. */
  byResult: Map<string, ObjectionRow>
  /** Newest objection per attendance date. */
  byDate: Map<string, ObjectionRow>
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

  useEffect(() => { void reload() }, [reload])

  // The API returns newest first, so the first hit for a key is the current one.
  const byResult = new Map<string, ObjectionRow>()
  const byDate   = new Map<string, ObjectionRow>()
  for (const o of all) {
    if (o.payroll_result_id && !byResult.has(o.payroll_result_id)) byResult.set(o.payroll_result_id, o)
    if (o.attendance_date   && !byDate.has(o.attendance_date))     byDate.set(o.attendance_date, o)
  }

  return { all, byResult, byDate, loading, error, reload }
}
