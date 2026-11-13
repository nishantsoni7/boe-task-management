'use client'

// On a quotation made from a quotation request: where it came from, and "Send to sales" for the person the request is
// assigned to (it completes the request the same way the request page's Send does).

import { useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { Send } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import type { Quotation } from '@/lib/quotations/api'
import { sendToSales } from '@/lib/quotations/sendToSales'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

export function RequestCard({ supabase, base, userId, dirty, onDone }: { supabase: Supabase; base: Quotation; userId: string; dirty: boolean; onDone: (msg: string) => void }) {
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const r = base.request
  if (!r) return null
  const done = r.status === 'completed'
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
  return (
    <section className={s.card}>
      <div className={s.cardHead}><h2>Quotation request</h2></div>
      <div className={s.cardBody} style={{ display: 'grid', gap: 8 }}>
        <div className={s.small}><Link href={`/tasks/${r.id}`} className={s.name}>{r.title}</Link><br />Asked by {r.asked_by ?? '—'} · {done ? 'sent to sales' : r.status.replace(/_/g, ' ')}</div>
        {r.may_send && !done && (dirty ? <div className={`${s.small} ${s.dirty}`}>Save first, then send it to sales.</div>
          : note === null
            ? <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => setNote('')}><Send size={15} aria-hidden /> Send to sales</button>
            : (
              <div style={{ display: 'grid', gap: 6 }}>
                <label className={s.field}><span>Note for {r.asked_by ?? 'sales'} (optional)</span><input id="req-note" className={s.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Teak as asked; wardrobes priced for 39 rooms" autoFocus /></label>
                <div className={s.row}><button className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send and complete the request'}</button><button className={`${s.btn} ${s.btnSm}`} onClick={() => setNote(null)}>Cancel</button></div>
              </div>
            ))}
        {err && <div className={`${s.notice} ${s.noticeBad}`}>{err}</div>}
      </div>
    </section>
  )
}
