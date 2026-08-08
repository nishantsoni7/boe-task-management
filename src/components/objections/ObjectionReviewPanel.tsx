'use client'

// What the employee said about this record, where the admin is already reading
// it — and the two things an admin can do about the report itself.
//
// Resolving or rejecting changes the OBJECTION and nothing else. If the
// employee is right, the correction is still made through the existing
// correction or adjustment workflow on this same screen. That separation is
// enforced in the database: review_employee_record_objection() touches four
// columns of one row and cannot reach attendance or payroll.

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { employeeStatusLabel, statusTone, type ObjectionRow } from '@/lib/objections'

export function ObjectionReviewPanel({
  objection, token, onReviewed, subjectLabel,
}: {
  objection: ObjectionRow
  /** Bearer token of the signed-in admin. */
  token: string
  onReviewed: () => void | Promise<void>
  /** "07 Aug 2026" or "July 2026" — what the issue is against. */
  subjectLabel: string
}) {
  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note,  setNote]  = useState('')

  const pending = objection.status === 'pending'
  const tone    = statusTone(objection.status)

  const review = async (status: 'approved' | 'rejected') => {
    // A rejection with no word back is a dead end for the employee, so it is
    // the one outcome that insists on a note.
    if (status === 'rejected' && !note.trim()) {
      setError('Add a short note so the employee knows why.')
      return
    }
    setBusy(true)
    setError(null)
    const res = await fetch('/api/objections/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ objection_id: objection.id, status, review_note: note }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) setError(json.error ?? 'Could not update that issue.')
    else await onReviewed()
    setBusy(false)
  }

  return (
    <div style={{
      marginBottom: 16, borderRadius: 10, overflow: 'hidden',
      border: `1px solid ${pending ? 'rgba(232,160,48,0.45)' : colors.border}`,
      background: pending ? '#FFFBEB' : '#FAFBFC',
    }}>
      <div style={{
        padding: '11px 16px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
        borderBottom: `1px solid ${pending ? 'rgba(232,160,48,0.3)' : colors.border}`,
      }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111318' }}>
          Employee reported an issue · {subjectLabel}
        </div>
        <span style={{
          padding: '2px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 600,
          background: tone.bg, color: tone.fg, whiteSpace: 'nowrap',
        }}>
          {employeeStatusLabel(objection.status)}
        </span>
      </div>

      <div style={{ padding: '12px 16px' }}>
        <div style={{ fontSize: 13, color: '#3D4455', lineHeight: 1.6 }}>
          &ldquo;{objection.reason}&rdquo;
        </div>
        <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 6 }}>
          Submitted {new Date(objection.created_at).toLocaleString('en-IN')}
          {' · '}As recorded: {objection.subject_snapshot}
        </div>

        {objection.review_note && (
          <div style={{ fontSize: 12.5, color: '#3B63B8', marginTop: 8 }}>
            Reply to employee: {objection.review_note}
          </div>
        )}

        {error && (
          <div role="alert" style={{ fontSize: 12.5, color: '#C13030', marginTop: 8 }}>{error}</div>
        )}

        {pending && (
          <div style={{ marginTop: 11, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Note for the employee (required to reject)"
              className="boe-input"
              style={{ flex: 1, minWidth: 220, fontSize: 12.5, padding: '6px 10px' }}
            />
            <button
              onClick={() => void review('approved')}
              disabled={busy}
              className="boe-btn boe-btn-primary"
              style={{ padding: '6px 14px', fontSize: 12.5, whiteSpace: 'nowrap' }}
            >
              Resolve
            </button>
            <button
              onClick={() => void review('rejected')}
              disabled={busy}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '6px 14px', fontSize: 12.5, whiteSpace: 'nowrap' }}
            >
              Reject
            </button>
          </div>
        )}

        {pending && (
          <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 8, lineHeight: 1.5 }}>
            Resolving records the outcome. It does not change attendance or salary —
            make any actual correction with the tools on this page.
          </div>
        )}
      </div>
    </div>
  )
}
