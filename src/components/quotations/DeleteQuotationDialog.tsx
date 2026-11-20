'use client'

// The confirm before a quotation is deleted (owner, 20 Nov 2026), shared by the list's bin and the quotation page's Delete button. It names the
// quotation and says what goes and that it cannot be undone; the database (quotation_delete, 20270817000000) decides whether the person may,
// so a refusal (somebody sent it to a senior a moment ago) is shown here in its own words and nothing is lost.

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'
import { STATUS_LABEL, deleteQuotation, errorText, type QuotationStatus } from '@/lib/quotations/api'
import { useDialogFocus } from '@/components/salesLeads/useDialogFocus'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

export type DeleteTarget = { id: string; quote_no: string; client_name: string; project_name: string | null; status: QuotationStatus }

/** What the confirm says about a quotation that has gone out (only an administrator can get here with one). */
export function goneOutNote(status: QuotationStatus): string | null {
  return status === 'draft' ? null : `It is marked ${STATUS_LABEL[status]}. If its client link was shared, the link stops working.`
}

export function DeleteQuotationDialog({ supabase, target, onClose, onDeleted }: {
  supabase: Supabase; target: DeleteTarget; onClose: () => void; onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const dialogRef = useDialogFocus<HTMLDivElement>(() => { if (!busy) onClose() })
  const note = goneOutNote(target.status)

  const confirm = async () => {
    setBusy(true); setErr('')
    try {
      await deleteQuotation(supabase, target.id)
    } catch (e) { setErr(errorText(e)); setBusy(false); return }
    onDeleted()
    // Every list, card and lead line that counted it, except this quotation's own queries (they would only answer "not found" before the page leaves).
    void qc.invalidateQueries({ queryKey: ['quotations'], predicate: q => !q.queryKey.includes(target.id) })
  }

  return (
    <div className={s.scrim} onClick={busy ? undefined : onClose}>
      <div ref={dialogRef} tabIndex={-1} className={s.modal} style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="qdel-title" aria-describedby="qdel-text">
        <div className={s.cardHead}><h2 id="qdel-title">Delete {target.quote_no}?</h2><span className={s.spacer} /><button type="button" className={s.iconBtn} onClick={onClose} disabled={busy} aria-label="Close">×</button></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          <p id="qdel-text" style={{ margin: 0 }}>
            <b>{target.project_name || target.client_name}</b>{target.project_name && target.project_name !== target.client_name ? <> · {target.client_name}</> : null}
            <br />This deletes the quotation with its rooms, products and history. It cannot be undone.
          </p>
          {note && <p className={`${s.small} ${s.muted}`} style={{ margin: 0 }}>{note}</p>}
          {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}</div>}
          <div className={s.row} style={{ justifyContent: 'flex-end' }}>
            <button type="button" className={s.btn} onClick={onClose} disabled={busy} autoFocus>Keep it</button>
            <button type="button" className={`${s.btn} ${s.btnDanger}`} onClick={confirm} disabled={busy}>{busy ? 'Deleting…' : 'Delete quotation'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
