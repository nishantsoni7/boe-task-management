'use client'

import { useRef, useState } from 'react'
import { AlertTriangle, BellRing, ChevronDown, ChevronUp, HandCoins } from 'lucide-react'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatINR } from '@/lib/currency'
import { formatDateTime, formatFullDate } from '@/lib/ui'
import { paymentModeLabel } from '@/lib/finance/paymentEntry'
import { useHandoverActions } from '@/hooks/queries/useHandovers'
import {
  HANDOVER_REASON_MAX,
  HANDOVER_STATUS_LABEL,
  handoverHeadline,
  handoverPaymentCount,
  handoverReasonError,
  handoverRole,
  handoverSeverity,
  isOpenHandover,
  waitingFor,
  type Handover,
  type HandoverSeverity,
} from '@/lib/finance/handover'

const SEVERITY_TAG: Record<HandoverSeverity, string> = {
  fresh:    'Action needed',
  late:     'Waiting over a day',
  overdue:  'Overdue',
  disputed: 'Disputed',
}

/**
 * One handover as a card. Used by the Finance banner (open handovers, loud), by
 * /handover/[id] (any status) and by the history page's detail window.
 *
 * It draws what the server allowed: every button is gated on the can_* flags of
 * finance_handover_list, and the RPC re-checks when it is pressed.
 */
export function HandoverCard({
  handover: h,
  viewerId,
  defaultOpen = false,
  onChanged,
}: {
  handover: Handover
  viewerId: string | null
  defaultOpen?: boolean
  /** Called after any successful action (e.g. to close a detail window). */
  onChanged?: () => void
}) {
  const role = handoverRole(h, viewerId)
  const open = isOpenHandover(h)
  const severity = handoverSeverity(h)
  const [showItems, setShowItems] = useState(defaultOpen)
  const [dialog, setDialog] = useState<'accept' | 'dispute' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { accept, dispute, cancel, remind } = useHandoverActions()
  const busy = accept.isPending || dispute.isPending || cancel.isPending || remind.isPending

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')

  const doRemind = async () => {
    setError(null)
    try { await remind.mutateAsync(h.id); onChanged?.() } catch (e) { fail(e) }
  }

  const classes = [
    'boe-handover',
    open ? `boe-handover--${severity}` : '',
    open && role === 'observer' ? 'boe-handover--observer' : '',
  ].filter(Boolean).join(' ')

  const closedStyle = open ? undefined : ({
    '--ho-accent': h.status === 'accepted' ? '#276247' : '#686D6C',
    '--ho-bg': h.status === 'accepted' ? '#E8F2EC' : '#F1EEE9',
    '--ho-border': h.status === 'accepted' ? 'rgba(39,98,71,0.5)' : '#CFC8BF',
    '--ho-glow': 'transparent',
    '--ho-ink': h.status === 'accepted' ? '#1B4A35' : '#4C5352',
    animation: 'none',
  } as React.CSSProperties)

  return (
    <section
      className={classes}
      style={closedStyle}
      role={open && role !== 'observer' ? 'alert' : 'group'}
      aria-label={`Cash handover ${h.humanId}: ${HANDOVER_STATUS_LABEL[h.status]}`}
    >
      <div className="boe-handover-top">
        <div className="boe-handover-icon" aria-hidden="true">
          {open
            ? (severity === 'fresh' ? <BellRing size={24} strokeWidth={2} /> : <AlertTriangle size={24} strokeWidth={2} />)
            : <HandCoins size={24} strokeWidth={2} />}
        </div>

        <div className="boe-handover-main">
          <div className="boe-handover-tag">
            {open ? SEVERITY_TAG[severity] : HANDOVER_STATUS_LABEL[h.status]}
            {open && <span aria-hidden="true">·</span>}
            {open && <span>{waitingFor(h.ageHours)}{h.ageHours >= 1 ? ' waiting' : ''}</span>}
          </div>
          <h3 className="boe-handover-headline">
            {open ? handoverHeadline(h, role) : `${h.giverName} → ${h.recipientName}`}
          </h3>
          <div className="boe-handover-meta">
            {h.humanId} · {handoverPaymentCount(h)} · handed {h.handedAt ? formatDateTime(h.handedAt) : '—'}
            {h.note ? ` · “${h.note}”` : ''}
          </div>
        </div>

        <div className="boe-handover-amount">
          {formatINR(h.totalAmount)}
          <small>{role === 'recipient' ? 'to accept' : open ? 'not confirmed' : HANDOVER_STATUS_LABEL[h.status]}</small>
        </div>
      </div>

      {h.status === 'disputed' && h.disputeReason && (
        <div className="boe-handover-reason">
          <strong>Dispute reason:</strong> {h.disputeReason}
        </div>
      )}
      {h.status === 'cancelled' && (
        <div className="boe-handover-reason">
          <strong>Cancelled</strong>{h.cancelledAt ? ` on ${formatFullDate(h.cancelledAt)}` : ''}
          {h.cancelReason ? `: ${h.cancelReason}` : '.'}
        </div>
      )}
      {h.status === 'accepted' && h.acceptedAt && (
        <div className="boe-handover-reason">
          <strong>Accepted</strong> by {h.recipientName} on {formatDateTime(h.acceptedAt)}. The custody trail of each payment now shows this handover.
        </div>
      )}

      {error && <div className="boe-handover-error" role="alert">{error}</div>}

      {showItems && (
        <ul className="boe-handover-items" aria-label="Payments in this handover">
          {h.items.map(i => (
            <li key={i.paymentId}>
              <span>
                <strong>{i.humanPaymentId ?? 'Payment'}</strong>
                {' · '}{i.clientName ?? 'Suspense'}
                {' · '}{paymentModeLabel(i.paymentMode)}
                {i.paymentDate ? ` · ${formatFullDate(i.paymentDate)}` : ''}
              </span>
              <span className="ho-item-amount">{formatINR(i.amount)}</span>
            </li>
          ))}
        </ul>
      )}

      {(open || h.items.length > 0) && (
        <div className="boe-handover-actions">
          {h.canAccept && (
            <button type="button" className="boe-btn boe-btn-primary" disabled={busy} onClick={() => { setError(null); setDialog('accept') }}>
              Accept {formatINR(h.totalAmount)}
            </button>
          )}
          {h.canDispute && (
            <button type="button" className="boe-btn boe-btn-danger" disabled={busy} onClick={() => { setError(null); setDialog('dispute') }}>
              Dispute
            </button>
          )}
          {h.canRemind && (
            <button type="button" className="boe-btn boe-btn-primary" disabled={busy} aria-busy={remind.isPending} onClick={doRemind}>
              {remind.isPending ? 'Sending…' : `Remind ${h.recipientName.split(' ')[0]}`}
            </button>
          )}
          {open && role === 'giver' && !h.canRemind && h.lastRemindedAt && (
            <span className="boe-handover-meta" style={{ margin: 0 }}>Reminder sent {formatDateTime(h.lastRemindedAt)}</span>
          )}
          {h.canCancel && (
            <button type="button" className="boe-btn boe-btn-secondary" disabled={busy} onClick={() => { setError(null); setDialog('cancel') }}>
              Cancel handover
            </button>
          )}
          <button
            type="button"
            className="boe-handover-toggle"
            aria-expanded={showItems}
            onClick={() => setShowItems(v => !v)}
          >
            {showItems ? 'Hide payments' : 'Show payments'}
            {showItems ? <ChevronUp size={14} style={{ verticalAlign: 'middle', marginLeft: 4 }} /> : <ChevronDown size={14} style={{ verticalAlign: 'middle', marginLeft: 4 }} />}
          </button>
        </div>
      )}

      {dialog === 'accept' && (
        <HandoverConfirmDialog
          title="Accept this cash"
          confirmLabel={`Yes, I received ${formatINR(h.totalAmount)}`}
          pending={accept.isPending}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            setError(null)
            try { await accept.mutateAsync(h.id); setDialog(null); onChanged?.() }
            catch (e) { setDialog(null); fail(e) }
          }}
        >
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
            Accept only after the cash is in your hands. You are confirming that you received{' '}
            <strong>{formatINR(h.totalAmount)}</strong> from <strong>{h.giverName}</strong> for {handoverPaymentCount(h)}.
            You will then be the holder of these payments in the custody trail.
          </p>
        </HandoverConfirmDialog>
      )}

      {dialog === 'dispute' && (
        <HandoverReasonDialog
          title="Dispute this handover"
          label="What is wrong? (for example: received less, nothing received)"
          confirmLabel="Send dispute"
          danger
          required
          pending={dispute.isPending}
          onClose={() => setDialog(null)}
          onSubmit={async reason => {
            await dispute.mutateAsync({ id: h.id, reason })
            setDialog(null); onChanged?.()
          }}
        />
      )}

      {dialog === 'cancel' && (
        <HandoverReasonDialog
          title="Cancel this handover"
          label={role === 'giver' ? 'Reason (optional)' : 'Reason (required for an administrator)'}
          confirmLabel="Cancel handover"
          danger
          required={role !== 'giver'}
          pending={cancel.isPending}
          onClose={() => setDialog(null)}
          onSubmit={async reason => {
            await cancel.mutateAsync({ id: h.id, reason })
            setDialog(null); onChanged?.()
          }}
        />
      )}
    </section>
  )
}

function HandoverConfirmDialog({
  title, confirmLabel, pending, onClose, onConfirm, children,
}: {
  title: string
  confirmLabel: string
  pending: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
  children: React.ReactNode
}) {
  return (
    <FinanceModal title={title} onClose={onClose} width="460px">
      {children}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose} disabled={pending}>Not yet</button>
        <button type="button" className="boe-btn boe-btn-primary" onClick={() => void onConfirm()} disabled={pending} aria-busy={pending}>
          {pending ? 'Saving…' : confirmLabel}
        </button>
      </div>
    </FinanceModal>
  )
}

export function HandoverReasonDialog({
  title, label, confirmLabel, required, danger, pending, onClose, onSubmit,
}: {
  title: string
  label: string
  confirmLabel: string
  required: boolean
  danger?: boolean
  pending: boolean
  onClose: () => void
  onSubmit: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = async () => {
    const problem = required || reason.trim() ? handoverReasonError(reason) : null
    if (problem) { setError(problem); ref.current?.focus(); return }
    setError(null)
    try { await onSubmit(reason) }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.') }
  }

  return (
    <FinanceModal title={title} onClose={onClose} width="460px" closeOnBackdropClick={false}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
        {label}
        <textarea
          ref={ref}
          value={reason}
          maxLength={HANDOVER_REASON_MAX}
          rows={4}
          onChange={e => setReason(e.target.value)}
          aria-invalid={!!error}
          style={{ font: 'inherit', fontWeight: 400, padding: 10, borderRadius: 8, border: '1px solid #686D6C', resize: 'vertical' }}
        />
      </label>
      {error && <div className="boe-handover-error" role="alert">{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose} disabled={pending}>Back</button>
        <button
          type="button"
          className={danger ? 'boe-btn boe-btn-danger-solid' : 'boe-btn boe-btn-primary'}
          onClick={() => void submit()}
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? 'Saving…' : confirmLabel}
        </button>
      </div>
    </FinanceModal>
  )
}
