'use client'

// The owner's monthly settings for the Scoreboard (owner, 2026-11-12: "I am happy to set targets on the 1st"):
// per person, the track (general or sales) and the month's targets. Sales: confirmed sales in rupees before
// GST. General: one role target, a number and what counts (tasks finished, or vendor visits). A target left
// empty is simply not counted. Administrators only: /api/scoreboard/targets refuses everybody else.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { dayCloseFetch } from '@/components/dayClose/api'
import styles from '@/components/dayClose/dayClose.module.css'

type Target = {
  track: 'general' | 'sales'
  sales_target: number | null
  role_target: number | null
  role_kind: 'tasks_done' | 'vendor_visits' | null
  role_label: string | null
}
type Row = { id: string; name: string; target: Target | null }

function monthName(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function TargetsEditor() {
  const [open, setOpen] = useState(false)
  const query = useQuery<{ month: string; people: Row[] }>({
    queryKey: ['scoreboard', 'targets'],
    enabled: open,
    queryFn: async () => {
      const r = await dayCloseFetch<{ month: string; people: Row[] }>('/api/scoreboard/targets')
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    retry: false,
  })

  return (
    <section className={styles.card} aria-labelledby="targets-heading">
      <button type="button" className={styles.toggle} onClick={() => setOpen(o => !o)} aria-expanded={open} id="targets-heading">
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        {' '}Scoreboard targets{query.data ? ` for ${monthName(query.data.month)}` : ''}
      </button>
      {open && query.error instanceof Error && <p className={styles.error} role="alert">{query.error.message}</p>}
      {open && !query.data && !query.error && <p className={styles.muted}>Loading…</p>}
      {open && query.data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <p className={styles.muted}>Set each person’s track and this month’s target. Targets are paced: halfway through the month, half the target is full marks. Leave a target empty and it is not counted.</p>
          {query.data.people.map(p => <TargetRow key={p.id} month={query.data.month} row={p} />)}
        </div>
      )}
    </section>
  )
}

function TargetRow({ month, row }: { month: string; row: Row }) {
  const queryClient = useQueryClient()
  const t = row.target
  const [track, setTrack] = useState<'general' | 'sales'>(t?.track ?? 'general')
  const [sales, setSales] = useState(t?.sales_target ? String(Math.round(t.sales_target)) : '')
  const [roleTarget, setRoleTarget] = useState(t?.role_target ? String(t.role_target) : '')
  const [roleKind, setRoleKind] = useState<'tasks_done' | 'vendor_visits'>(t?.role_kind ?? 'tasks_done')
  const [roleLabel, setRoleLabel] = useState(t?.role_label ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const save = async () => {
    setBusy(true)
    const r = await dayCloseFetch('/api/scoreboard/targets', {
      body: {
        month, employee_id: row.id, track,
        sales_target: track === 'sales' ? sales : null,
        role_target: track === 'general' && roleTarget ? roleTarget : null,
        role_kind: track === 'general' && roleTarget ? roleKind : null,
        role_label: track === 'general' && roleTarget ? roleLabel : null,
      },
    })
    setBusy(false)
    setMsg(r.ok ? { ok: true, text: 'Saved' } : { ok: false, text: r.error })
    if (r.ok) await queryClient.invalidateQueries({ queryKey: ['scoreboard'] })
  }

  return (
    <div className={styles.item}>
      <p className={styles.itemTitle}>{row.name}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <label className={styles.label}>
          Track
          <select className={styles.input} value={track} onChange={e => setTrack(e.target.value as 'general' | 'sales')} aria-label={`Track for ${row.name}`}>
            <option value="general">General</option>
            <option value="sales">Sales</option>
          </select>
        </label>
        {track === 'sales' ? (
          <label className={styles.label}>
            Sales target, ₹ before GST
            <input className={styles.input} inputMode="numeric" value={sales} onChange={e => setSales(e.target.value.replace(/[^0-9]/g, ''))} placeholder="e.g. 1500000" />
          </label>
        ) : (
          <>
            <label className={styles.label}>
              Role target
              <input className={styles.input} inputMode="numeric" value={roleTarget} onChange={e => setRoleTarget(e.target.value.replace(/[^0-9]/g, ''))} placeholder="e.g. 20" style={{ maxWidth: 110 }} />
            </label>
            <label className={styles.label}>
              What counts
              <select className={styles.input} value={roleKind} onChange={e => setRoleKind(e.target.value as 'tasks_done' | 'vendor_visits')}>
                <option value="tasks_done">Tasks finished</option>
                <option value="vendor_visits">Vendor visits</option>
              </select>
            </label>
            <label className={styles.label}>
              Called (shown to them)
              <input className={styles.input} value={roleLabel} maxLength={80} onChange={e => setRoleLabel(e.target.value)} placeholder="e.g. reels posted" />
            </label>
          </>
        )}
        <button type="button" className="boe-btn boe-btn-ghost" onClick={save} disabled={busy} aria-busy={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      {msg && <p className={msg.ok ? styles.muted : styles.error} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </div>
  )
}
