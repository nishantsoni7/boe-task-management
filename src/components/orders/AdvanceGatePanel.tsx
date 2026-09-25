'use client'

// ── THE 40% ADVANCE ON THE ORDER PAGE (20270104000000) ───────────────────────
//
// Drawn only when the verified advance is below 40% of the Order's (amended)
// value. It says the percentage, the rupee shortfall, what is awaiting Finance
// and what must happen before production can be aligned — and, when an aligned
// Order fell short and was put on hold, when and why — and gives an active
// administrator the one explicit exception. The database enforces all of it
// (orders_alignment_requires_advance); this panel only says so first.

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { ADVANCE_EXCEPTION_ACTION, advanceGateView, describeAdvanceRefusal, type AdvanceReadiness } from '@/lib/orders/advanceReadiness'

export function AdvanceGatePanel({ readiness, versionNumber, isAdmin, approverName, formatWhen, onApprove }: {
  readiness: AdvanceReadiness | null
  versionNumber: number | null
  /** An active administrator, not under View As. The database re-checks. */
  isAdmin: boolean
  approverName?: string | null
  formatWhen?: (iso: string | null) => string
  /** Calls approve_order_advance_exception; returns the refusal, if any. */
  onApprove: (reason: string) => Promise<{ error?: { message?: string } | null }>
}) {
  const view = advanceGateView(readiness, { versionNumber, approverName, formatWhen })
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (view.kind === 'none') return null

  if (view.kind === 'excepted') {
    return (
      <section aria-label="Advance" style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '10px 14px', background: colors.base }}>
        <strong style={{ fontSize: '13px' }}>{view.headline}</strong>
        <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: colors.secondary }}>{view.figures} {view.note}</p>
      </section>
    )
  }

  const approve = async () => {
    setBusy(true); setFailure(null)
    try {
      const { error } = await onApprove(reason.trim())
      if (error) { setFailure(describeAdvanceRefusal(error.message) ?? 'This could not be approved just now.'); return }
      setOpen(false); setReason('')
    } finally { setBusy(false) }
  }

  return (
    <section aria-label="Advance" role="status" id="order-advance-blocked"
      style={{ border: '1px solid rgba(217,79,79,0.45)', borderRadius: '10px', padding: '12px 14px', background: colors.redTint, display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <strong style={{ fontSize: '13.5px', color: '#991B1B' }}>{view.headline}</strong>
      {view.hold && <p data-advance-hold style={{ margin: 0, fontSize: '13px', color: colors.primary }}>{view.hold}</p>}
      <p style={{ margin: 0, fontSize: '13px', color: colors.primary }}>
        {view.figures} <strong>{view.shortfall}</strong>
      </p>
      {view.awaiting && <p style={{ margin: 0, fontSize: '12.5px', color: colors.secondary }}>{view.awaiting}</p>}
      <p style={{ margin: 0, fontSize: '12.5px', color: colors.secondary }}>{view.action}</p>
      {isAdmin && !open && (
        <div>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setOpen(true)}>{ADVANCE_EXCEPTION_ACTION}</button>
        </div>
      )}
      {isAdmin && open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '12.5px' }}>
            Why may production go ahead below 40% for this Order value and PI version?
            <textarea className="boe-input" rows={2} maxLength={1000} value={reason} disabled={busy}
              onChange={e => setReason(e.target.value)} style={{ width: '100%', marginTop: '4px' }} />
          </label>
          {failure && <p role="alert" style={{ margin: 0, fontSize: '12px', color: colors.red }}>{failure}</p>}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => { setOpen(false); setFailure(null) }} disabled={busy}>Cancel</button>
            <button type="button" className="boe-btn boe-btn-primary" onClick={() => void approve()} disabled={busy || reason.trim().length < 10}>
              {busy ? 'Approving…' : 'Approve below 40%'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
