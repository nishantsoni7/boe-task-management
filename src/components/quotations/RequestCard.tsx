'use client'

// On a quotation made from a quotation request: where it came from, and "Send to sales" for the person the request is
// assigned to (it completes the request the same way the request page's Send does). It is the first card of the top row
// (owner, 18 Nov 2026): the person it waits on sees it without scrolling past the products.

import { useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { Check, ClipboardList, Send } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import type { Quotation } from '@/lib/quotations/api'
import { sendToSales } from '@/lib/quotations/sendToSales'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

export function RequestCard({ id, supabase, base, userId, dirty, onDone }: { id?: string; supabase: Supabase; base: Quotation; userId: string; dirty: boolean; onDone: (msg: string) => void }) {
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const r = base.request
  if (!r) return null
  const done = r.status === 'completed'
  const mine = r.may_send && !done
  const send = async () => {
    setBusy(true); setErr('')
    const res = await sendToSales(supabase, {
      task: { id: r.id, status: r.status, created_by: r.created_by, assigned_to: r.assigned_to, created_at: r.created_at, last_update_at: r.last_update_at },
      actorId: userId, quoteNo: base.quote_no, versionNo: null, url: `${window.location.origin}/quotations/${base.id}`, note: note?.trim() || null,
    })
    setBusy(false)
    if (!res.ok) { setErr(res.error); return }
    setNote(null)
    onDone(`Sent to ${r.asked_by ?? 'sales'}: the request is complete and they have been told.`)
  }
  const hid = `${id ?? 'q-card-request'}-h`
  return (
    <section id={id} className={`${s.card} ${s.tile}`} aria-labelledby={hid}>
      <h2 id={hid} className={s.tileLab}><ClipboardList size={15} aria-hidden /> Quotation request</h2>
      <div>
        <Link href={`/tasks/${r.id}`} className={s.tileTitle}>{r.title}</Link>
        <div className={s.tileMeta}>Asked by {r.asked_by ?? '—'} · {done ? 'sent to sales' : r.status.replace(/_/g, ' ')}</div>
      </div>
      {mine && <p className={s.tileText}>Send it to sales when this quotation is ready. {r.asked_by ?? 'The person who asked'} is told and the request is completed.</p>}
      {mine && (dirty ? <p className={`${s.tileText} ${s.dirty}`}>Save first, then send it to sales.</p>
        : note === null
          ? <div className={s.tileAct}><button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => setNote('')}><Send size={15} aria-hidden /> Send to sales</button></div>
          : (
            <div className={s.tileNote}>
              <label className={s.field}><span>Note for {r.asked_by ?? 'sales'} (optional)</span><input id="req-note" className={s.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Teak as asked; wardrobes priced for 39 rooms" autoFocus /></label>
              <div className={s.row}><button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send and complete the request'}</button><button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setNote(null)}>Cancel</button></div>
            </div>
          ))}
      {done && <div className={s.tileAct}><span className={s.chip}><Check size={13} aria-hidden /> Sent to sales</span></div>}
      {err && <div className={`${s.notice} ${s.noticeBad}`}>{err}</div>}
    </section>
  )
}
