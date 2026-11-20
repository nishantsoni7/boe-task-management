'use client'

import { useState } from 'react'
import type { Task } from '@/lib/types'
import { useDialogFocus } from '@/components/salesLeads/useDialogFocus'
import styles from './quotationRequests.module.css'

// The confirm before an administrator deletes a request from the Dashboard's Quotation Requests card (owner, 20 Nov 2026).
// `onConfirm` resolves to null when the request is gone, or a sentence to show here.

export function DeleteRequestDialog({ task, person, onClose, onConfirm }: {
  task: Task
  person?: string
  onClose: () => void
  onConfirm: () => Promise<string | null>
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const dialogRef = useDialogFocus<HTMLDivElement>(() => { if (!busy) onClose() })
  const lead = task.customer_name ?? task.title

  const confirm = async () => {
    setBusy(true); setErr('')
    const problem = await onConfirm()
    if (problem) { setErr(problem); setBusy(false) }
  }

  return (
    <div className={styles.scrim} onClick={busy ? undefined : onClose}>
      <div ref={dialogRef} tabIndex={-1} className={styles.dialog} onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="delreq-title" aria-describedby="delreq-text">
        <h2 id="delreq-title">Delete this request?</h2>
        <p id="delreq-text"><b>{lead}</b>{person ? <> · raised by {person}</> : null}</p>
        <p>This removes the request and its history for everyone. It cannot be undone.</p>
        <p className={styles.dialogNote}>A quotation already made from it is not deleted.</p>
        {err && <div className={styles.dialogError} role="alert">{err}</div>}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.dialogBtn} onClick={onClose} disabled={busy} autoFocus>Keep it</button>
          <button type="button" className={`${styles.dialogBtn} ${styles.dialogDanger}`} onClick={confirm} disabled={busy}>{busy ? 'Deleting…' : 'Delete request'}</button>
        </div>
      </div>
    </div>
  )
}
