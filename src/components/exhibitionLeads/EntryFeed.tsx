'use client'

import { Check, CircleAlert, RefreshCw } from 'lucide-react'
import { LEAD_TYPE_ACCENTS, leadTypeLabel } from '@/lib/exhibitionLeads/constants'
import { NEEDS_ATTENTION, byEntryOrder, isUnsent, type OutboxEntry } from '@/lib/exhibitionLeads/outbox'
import s from './leads.module.css'
import a from './addLead.module.css'

// What is happening to the entries just made. Three small pieces, all fed by
// the outbox: a status line (saving / saved), a card for each entry that needs
// the person (with what to do about it), and the short "added this session" list.

/** "Saving 2 leads…" while any is on its way; otherwise the last confirmation, briefly. */
export function StatusLine({ entries, justSaved }: { entries: readonly OutboxEntry[]; justSaved: string | null }) {
  const waiting = entries.filter(e => e.status === 'saving' || e.status === 'retry').length
  if (waiting > 0) {
    const retrying = entries.some(e => e.status === 'retry')
    return (
      <div className={`${a.status} ${a.statusBusy}`} role="status">
        <span className={a.spin} aria-hidden="true" />
        <span>
          {retrying ? 'Connection is slow — still trying. ' : ''}
          Saving {waiting} lead{waiting === 1 ? '' : 's'}…
          <span style={{ opacity: 0.75 }}> You can keep adding.</span>
        </span>
      </div>
    )
  }
  if (justSaved) {
    return (
      <div className={`${a.status} ${a.statusOk}`} role="status">
        <Check size={18} strokeWidth={2.6} aria-hidden="true" />
        <span><strong>Saved</strong> — {justSaved}. Ready for the next visitor.</span>
      </div>
    )
  }
  return null
}

/** One card per entry that needs the person. */
export function Problems({
  entries, busy, onRetry, onEdit, onDiscard, onOpenLead, onAddNote, loginHref,
}: {
  entries: readonly OutboxEntry[]
  busy: boolean
  onRetry: (id: string) => void
  onEdit: (id: string) => void
  onDiscard: (id: string) => void
  onOpenLead: (leadId: string) => void
  onAddNote: (id: string) => void
  loginHref: string
}) {
  const list = byEntryOrder(entries).filter(e => NEEDS_ATTENTION.includes(e.status))
  if (list.length === 0) return null
  return (
    <>
      {list.map(e => {
        const warn = e.status === 'duplicate_mine' || e.status === 'duplicate_other'
        return (
          <div key={e.id} className={`${s.notice} ${warn ? s.noticeWarn : s.noticeErr}`} role="alert">
            <span className={a.problemName}>{e.name || 'This entry'}</span>
            {e.status === 'auth' ? ' is waiting for you to sign in. ' : ' — '}
            {e.message}
            <div className={s.noticeActions}>
              {e.status === 'auth' && <a className={`${s.btn} ${s.btnDark}`} href={loginHref}>Sign in again</a>}
              {e.status === 'failed' && (
                <button type="button" className={s.btn} onClick={() => onRetry(e.id)}>
                  <RefreshCw size={15} aria-hidden="true" /> Retry
                </button>
              )}
              {e.status === 'duplicate_mine' && e.leadId && (
                <button type="button" className={s.btn} onClick={() => onOpenLead(e.leadId as string)}>Open existing lead</button>
              )}
              {e.status === 'duplicate_mine' && e.values.note.trim() && (
                <button type="button" className={s.btn} disabled={busy} onClick={() => onAddNote(e.id)}>Add my note to it</button>
              )}
              {e.status !== 'duplicate_mine' && (
                <button type="button" className={s.btn} onClick={() => onEdit(e.id)}>Edit details</button>
              )}
              <button type="button" className={s.btn} onClick={() => onDiscard(e.id)}>Dismiss</button>
            </div>
          </div>
        )
      })}
    </>
  )
}

const timeOf = (t: number) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(t)).toLowerCase()

export function RecentList({ entries }: { entries: readonly OutboxEntry[] }) {
  const list = byEntryOrder(entries).reverse().slice(0, 6)
  if (list.length === 0) return null
  return (
    <section className={`${a.recent} ${a.recentCard}`} aria-label="Added this session">
      <div className={a.recentTitle}>Added this session <span>{entries.length}</span></div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {list.map(e => (
          <li key={e.id} className={a.recentRow}>
            <span
              className={a.dot} aria-hidden="true"
              style={{ background: LEAD_TYPE_ACCENTS[String(e.values.leadType)] ?? '#9AA1AE' }}
            />
            <span className={a.recentName}>{e.name}</span>
            <span className={a.recentMeta}>{leadTypeLabel(e.values.leadType)} · {timeOf(e.createdAt)}</span>
            {e.status === 'saved' && <span className={`${a.state} ${a.stateOk}`}><Check size={14} strokeWidth={2.6} aria-hidden="true" />Saved</span>}
            {isUnsent(e) && e.status !== 'auth' && <span className={`${a.state} ${a.stateBusy}`}>Saving…</span>}
            {NEEDS_ATTENTION.includes(e.status) && (
              <span className={`${a.state} ${a.stateWarn}`}><CircleAlert size={14} aria-hidden="true" />Check</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
