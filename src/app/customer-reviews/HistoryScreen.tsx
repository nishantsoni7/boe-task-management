'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { ReviewBadge } from '@/components/customerReviews/ReviewPieces'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { fetchAllRows } from '@/lib/supabasePaging'
import { colors } from '@/lib/tokens'
import {
  TEST_CARD_COLUMNS,
  TEST_CARD_STATUS_META,
  formatTestTimestamp,
  reviewTypeLabel,
  type TestCard,
} from '@/lib/customerReviews/types'

// READ-ONLY HISTORY of the retired generated-review workflow.
//
// The workflow is deactivated for every role, but its records are kept and stay
// readable here for the people who could already read them: `verify` holders, by
// the same RLS on customer_review_test_cards and the same module guard. This
// screen adds no access and offers no action — no generation, allocation,
// booking, sharing, verification, deletion or purge. Rows are shown as stored,
// including deleted ones (marked), because an audit view that hides them is not
// one. Reward history lives in the BOE Credits ledger and is untouched.

const ALL = 'all'

export function HistoryScreen() {
  const { supabase, profile, caps, loading, signOut } = useCustomerReviews()
  const router = useRouter()
  const [rows, setRows] = useState<TestCard[] | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string>(ALL)
  const [q, setQ] = useState('')
  const ticket = useRef(0)

  useEffect(() => {
    if (loading) return
    if (!caps.canVerify) router.replace('/customer-reviews')
  }, [loading, caps.canVerify, router])

  const load = useCallback(async () => {
    const mine = ++ticket.current
    const result = await fetchAllRows<TestCard>((from, to) =>
      supabase.from('customer_review_test_cards').select(TEST_CARD_COLUMNS).order('card_ref', { ascending: false }).range(from, to),
    )
    if (mine !== ticket.current) return
    if (!result.ok) { setError('The history could not be loaded. Refresh to try again.'); setRows([]); return }
    setError(null)
    setRows(result.rows)
    const ids = [...new Set(result.rows.flatMap(r => [r.assigned_to, r.booked_by, r.verified_by]).filter((v): v is string => !!v))]
    if (ids.length === 0) return
    // id and full_name only — users has private columns (src/lib/users/safeColumns.ts).
    const { data } = await supabase.from('users').select('id, full_name').in('id', ids)
    const map = new Map<string, string>()
    for (const p of (data ?? []) as unknown as { id: string; full_name: string | null }[]) map.set(p.id, p.full_name ?? 'Unknown')
    if (mine === ticket.current) setNames(map)
  }, [supabase])

  useEffect(() => {
    if (loading || !caps.canVerify) return
    // Every setState inside `load` runs after its first await (see TestCardListScreen).
    const startFetch = () => { void load() }
    startFetch()
  }, [loading, caps.canVerify, load])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (rows ?? []).filter(r =>
      (status === ALL || (status === 'deleted' ? !!r.deleted_at : r.status === status)) &&
      (!needle || `${r.card_ref} ${r.test_title}`.toLowerCase().includes(needle)))
  }, [rows, status, q])

  if (loading || !caps.canVerify) return <LoadingScreen />
  const who = (id: string | null) => (id ? names.get(id) ?? '…' : '—')

  return (
    <CustomerReviewsLayout profile={profile} title="History" subtitle="Generated reviews from before custom reviews — read only" canVerify={caps.canVerify} onSignOut={signOut}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 900, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search reference or title" aria-label="Search history"
            style={{ flex: '1 1 200px', minWidth: 0, minHeight: 44, padding: '8px 10px', borderRadius: 8, border: `1px solid ${colors.borderSoft}`, fontFamily: 'inherit', fontSize: 13 }}
          />
          <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status"
            style={{ minHeight: 44, padding: '8px 10px', borderRadius: 8, border: `1px solid ${colors.borderSoft}`, fontFamily: 'inherit', fontSize: 13, background: colors.base }}>
            <option value={ALL}>All statuses</option>
            {Object.entries(TEST_CARD_STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            <option value="deleted">Deleted</option>
          </select>
        </div>
        {error && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: colors.red }}>{error}</p>}
        {rows === null ? <p role="status" style={{ margin: 0, fontSize: 12.5, color: colors.muted }}>Loading the history…</p>
          : shown.length === 0 ? <p style={{ margin: 0, padding: '14px 16px', borderRadius: 10, border: `1px dashed ${colors.border}`, color: colors.muted, fontSize: 13 }}>No generated reviews match.</p>
          : shown.map(r => (
            <details key={r.id} style={{ borderRadius: 10, border: `1px solid ${colors.borderSoft}`, background: colors.base, minWidth: 0 }}>
              <summary style={{ cursor: 'pointer', padding: '10px 14px', minHeight: 44, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13, color: colors.primary }}>{r.card_ref}</strong>
                <ReviewBadge meta={TEST_CARD_STATUS_META[r.status]} />
                {r.deleted_at && <span style={{ fontSize: 11.5, fontWeight: 700, color: colors.red }}>Deleted</span>}
                <span style={{ fontSize: 12.5, color: colors.secondary, overflowWrap: 'anywhere', flex: '1 1 160px', minWidth: 0 }}>{r.test_title}</span>
              </summary>
              <dl style={{ margin: 0, padding: '4px 14px 14px', display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '4px 12px', fontSize: 12.5, color: colors.secondary }}>
                <dt>Type</dt><dd style={{ margin: 0 }}>{reviewTypeLabel(r.review_type)}</dd>
                <dt>Assigned to</dt><dd style={{ margin: 0 }}>{who(r.assigned_to)}</dd>
                <dt>Booked by</dt><dd style={{ margin: 0 }}>{who(r.booked_by)} · {formatTestTimestamp(r.booked_at)}</dd>
                <dt>Submitted</dt><dd style={{ margin: 0 }}>{formatTestTimestamp(r.submitted_at)}</dd>
                <dt>Verified</dt><dd style={{ margin: 0 }}>{who(r.verified_by)} · {formatTestTimestamp(r.verified_at)}</dd>
                {r.deleted_at && (<><dt>Deleted</dt><dd style={{ margin: 0 }}>{formatTestTimestamp(r.deleted_at)}</dd></>)}
                <dt>Review text</dt><dd style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.test_body}</dd>
              </dl>
            </details>
          ))}
      </div>
    </CustomerReviewsLayout>
  )
}
