'use client'

// ── The bottom of the window for a pending HDFC payment ─────────────────────
//
// The comparison above answers "is this the same money?". This bar holds what is
// about the whole payment: send it back, reject it, or look at the details. It only
// draws; DetailsModal holds the state and sends through its one decision door.

import type { ReactNode } from 'react'

export type BankWindowAction = 'needs_clarification' | 'reject'

const ASK: Record<BankWindowAction, { label: string; send: string; placeholder: string }> = {
  needs_clarification: { label: 'What do you need to know? Sales will see this.', send: 'Send to Sales', placeholder: 'Your question (required)' },
  reject: { label: 'Why reject this payment? Sales will see this.', send: 'Reject payment', placeholder: 'Rejection reason (required)' },
}

export function BankWindowBar({ details, action, note, sending, error, manage, onToggleDetails, onAsk, onNote, onCancel, onSend }: {
  /** The Details view is open. */
  details: boolean
  /** The decision being written, if any. */
  action: BankWindowAction | null
  note: string
  sending: boolean
  error: string | null
  /** Edit and Delete, as this person may use them. */
  manage: ReactNode
  onToggleDetails: () => void
  onAsk: (action: BankWindowAction) => void
  onNote: (note: string) => void
  onCancel: () => void
  onSend: () => void
}) {
  if (action) {
    const ask = ASK[action]
    return (
      <div className="bank-window-ask">
        <label className="bank-field"><span>{ask.label}</span>
          <textarea className="boe-input" rows={2} autoFocus value={note} placeholder={ask.placeholder} onChange={e => onNote(e.target.value)} />
        </label>
        {error && <div role="alert" className="bank-error">{error}</div>}
        <div className="bank-window-bar">
          <span className="bank-window-gap" />
          <button className="boe-btn boe-btn-ghost" disabled={sending} onClick={onCancel}>Cancel</button>
          <button className={action === 'reject' ? 'boe-btn bank-window-reject' : 'boe-btn boe-btn-primary'} disabled={sending || note.trim() === ''} onClick={onSend}>
            {sending ? 'Saving…' : ask.send}
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="bank-window-bar">
      <button className="boe-btn boe-btn-ghost" onClick={onToggleDetails}>{details ? 'Back to the match' : 'Details'}</button>
      <span className="bank-window-gap" />
      {details ? manage : (
        <>
          <button className="boe-btn boe-btn-ghost" onClick={() => onAsk('needs_clarification')}>Needs clarification</button>
          <button className="boe-btn boe-btn-ghost bank-window-reject-soft" onClick={() => onAsk('reject')}>Reject payment</button>
        </>
      )}
    </div>
  )
}
