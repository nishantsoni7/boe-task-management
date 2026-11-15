'use client'

// Pricing > Training: every training case, and who is waiting on whom. A case counts only after someone other
// than its maker approves it (20270720000000).

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { createClient } from '@/lib/supabase/client'
import { formatINR } from '@/lib/currency'
import { fetchAccess, fetchCases, photoUrl, trainingKeys, type CaseRow, type Status, type TrainingError } from '@/lib/pricing/training/api'
import t from './training.module.css'

export const STATUS: Record<Status, { label: string; badge: string }> = {
  draft: { label: 'Draft', badge: 'boe-badge-pending' },
  submitted: { label: 'Waiting for a check', badge: 'boe-badge-waiting' },
  sent_back: { label: 'Sent back', badge: 'boe-badge-blocked' },
  approved: { label: 'Approved', badge: 'boe-badge-completed' },
  rejected: { label: 'Rejected', badge: 'boe-badge-pending' },
}
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })

type Filter = 'all' | 'forme' | 'mine' | 'sent_back' | 'draft' | 'approved'

export function TrainingList() {
  const supabase = useMemo(() => createClient(), [])
  const [filter, setFilter] = useState<Filter>('all')
  const access = useQuery({ queryKey: trainingKeys.access, queryFn: () => fetchAccess(supabase), retry: false })
  const list = useQuery({ queryKey: trainingKeys.list, queryFn: () => fetchCases(supabase), enabled: access.isSuccess, retry: false })
  const a = access.data
  const rows = useMemo(() => list.data ?? [], [list.data])

  const is: Record<Filter, (c: CaseRow) => boolean> = {
    all: () => true,
    forme: c => !!a?.approve && c.status === 'submitted' && c.created_by !== a.uid,
    mine: c => c.status === 'submitted' && c.created_by === a?.uid,
    sent_back: c => c.status === 'sent_back',
    draft: c => c.status === 'draft',
    approved: c => c.status === 'approved',
  }
  const FILTERS: [Filter, string][] = [['all', 'All'], ['forme', 'Waiting for me'], ['mine', 'Mine, waiting for a check'], ['sent_back', 'Sent back'], ['draft', 'Drafts'], ['approved', 'Approved']]
  const shown = rows.filter(is[filter])
  const err = (access.error ?? list.error) as TrainingError | null

  return (
    <div className={t.wrap}>
      <div className={t.head}>
        <div>
          <h1 className={t.h1}>Training</h1>
          <p className={t.sub}>Teach the price of one product at a time. Each case is approved before it counts.</p>
        </div>
        {a?.create && <Link href="/pricing/training/new" className="boe-btn boe-btn-primary"><Plus size={16} aria-hidden /> New case</Link>}
      </div>

      {err && <div className={`boe-callout ${err.kind === 'not_set_up' ? 'boe-callout-warning' : 'boe-callout-error'}`} role="alert">{err.message}</div>}
      {a && !a.create && !a.approve && <div className="boe-callout boe-callout-info">You can read the cases. To teach or check them, ask an admin for Create or Approve on Pricing.</div>}

      {list.isSuccess && <>
        <div className={t.chips} role="group" aria-label="Filter cases">
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" className={t.chip} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label} {rows.filter(is[k]).length}</button>
          ))}
        </div>
        {rows.length === 0 ? (
          <div className="boe-empty">
            <div className="boe-empty-title">No cases yet</div>
            <p>Start with a photo of a product. You list what its price is made of, and it is approved before it counts.</p>
            {a?.create && <Link href="/pricing/training/new" className="boe-btn boe-btn-primary">Teach the first product</Link>}
          </div>
        ) : shown.length === 0 ? (
          <div className="boe-empty"><div className="boe-empty-title">Nothing here</div><p>No case matches this filter.</p></div>
        ) : (
          <div className={`boe-table-wrap ${t.scroll}`}>
            <table className="boe-table">
              <thead><tr><th>Product</th><th>Taught by</th><th>Updated</th><th className="num">Elements</th><th className="num">Total</th><th>Status</th></tr></thead>
              <tbody>
                {shown.map(c => (
                  <tr key={c.id}>
                    <td>
                      <div className={t.nameCell}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- a stored product photo, shown as it is */}
                        {c.image_path ? <img className={t.thumb} src={photoUrl(supabase, c.image_path)} alt="" loading="lazy" /> : <span className={t.thumb} aria-hidden />}
                        <div style={{ minWidth: 0 }}>
                          <Link href={`/pricing/training/${c.id}`} className={t.name}>{c.name}</Link>
                          <div className={t.muted}>#{c.case_no}{c.variant ? ` · ${c.variant}` : ''}</div>
                        </div>
                      </div>
                    </td>
                    <td>{c.created_by === a?.uid ? 'You' : c.created_by_name ?? '—'}</td>
                    <td className={t.muted}>{shortDate(c.updated_at)}</td>
                    <td className="num">{c.line_count}</td>
                    <td className="num"><b>{formatINR(Number(c.total))}</b></td>
                    <td><span className={`boe-badge ${STATUS[c.status].badge}`}>{is.forme(c) ? 'Waiting for you' : STATUS[c.status].label}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>}
    </div>
  )
}
