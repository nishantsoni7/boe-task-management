'use client'

import { useMemo, useRef, useState } from 'react'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatINR } from '@/lib/currency'
import { formatFullDate } from '@/lib/ui'
import { paymentModeLabel } from '@/lib/finance/paymentEntry'
import { isoToLocalInput, localInputToIso } from '@/lib/finance/custodyTrail'
import { useHandoverActions, useHandoverFormData } from '@/hooks/queries/useHandovers'
import { handoverDraftError, sumRupees } from '@/lib/finance/handover'

/**
 * "Hand over cash": who, which payments, when. One screen, three zones, a live
 * total, and a final sentence that says what the other person must do.
 *
 * Only payments the caller is CURRENTLY HOLDING are offered
 * (finance_my_handoverable_payments); create_cash_handover re-checks every one.
 */
export function HandoverModal({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const { data, isPending, isError, error: loadError } = useHandoverFormData(true)
  const { create } = useHandoverActions()

  // Minted once per open dialog: a double click or a retry creates one handover.
  const keyRef = useRef<string>(crypto.randomUUID())

  const [recipientId, setRecipientId] = useState('')
  const [personFilter, setPersonFilter] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [handedAt, setHandedAt] = useState(() => isoToLocalInput(new Date().toISOString()))
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const candidates = useMemo(() => data?.candidates ?? [], [data])
  const recipients = useMemo(() => {
    const q = personFilter.trim().toLowerCase()
    const all = data?.recipients ?? []
    return q ? all.filter(r => r.fullName.toLowerCase().includes(q)) : all
  }, [data, personFilter])

  const recipient = (data?.recipients ?? []).find(r => r.id === recipientId) ?? null
  const chosen = candidates.filter(c => picked.has(c.paymentId))
  const total = sumRupees(chosen.map(c => c.amount))
  const allPicked = candidates.length > 0 && picked.size === candidates.length

  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const submit = async () => {
    const problem = handoverDraftError({ recipientId, paymentIds: [...picked], handedAt })
    if (problem) { setError(problem); return }
    setError(null)
    try {
      await create.mutateAsync({
        recipientId,
        paymentIds: [...picked],
        handedAtIso: localInputToIso(handedAt),
        note,
        idempotencyKey: keyRef.current,
      })
      onCreated?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
    }
  }

  const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#686D6C', margin: '0 0 6px' }

  return (
    <FinanceModal title="Hand over cash" onClose={onClose} width="560px" closeOnBackdropClick={false}>
      {isPending && <div style={{ fontSize: 14 }}>Loading the payments you hold…</div>}
      {isError && <div className="boe-handover-error" role="alert">{loadError instanceof Error ? loadError.message : 'Could not load.'}</div>}

      {data && (
        <>
          {/* 1. To whom */}
          <div>
            <h4 style={sectionTitle}>1 · Hand over to</h4>
            <input
              type="search"
              value={personFilter}
              onChange={e => setPersonFilter(e.target.value)}
              placeholder="Search a person"
              aria-label="Search a person"
              style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #686D6C', font: 'inherit', fontSize: 14, marginBottom: 6 }}
            />
            <div role="radiogroup" aria-label="Hand over to" style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid #E4DED7', borderRadius: 8 }}>
              {recipients.length === 0 && <div style={{ padding: 10, fontSize: 13, color: '#686D6C' }}>Nobody matches.</div>}
              {recipients.map(r => (
                <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer', fontSize: 14, background: r.id === recipientId ? '#F8EAE4' : 'transparent', fontWeight: r.id === recipientId ? 700 : 400 }}>
                  <input type="radio" name="handover-recipient" checked={r.id === recipientId} onChange={() => setRecipientId(r.id)} />
                  {r.fullName}
                </label>
              ))}
            </div>
          </div>

          {/* 2. Which payments */}
          <div>
            <h4 style={sectionTitle}>2 · Which payments</h4>
            {candidates.length === 0 ? (
              <div style={{ padding: 12, borderRadius: 8, background: '#F1EEE9', fontSize: 13, lineHeight: 1.5 }}>
                You are not holding the cash of any PNB or Paytm payment right now, or every one of them is already in a handover that is waiting for acceptance.
              </div>
            ) : (
              <>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, marginBottom: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={allPicked}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(candidates.map(c => c.paymentId)))}
                  />
                  Select all ({candidates.length})
                </label>
                <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #E4DED7', borderRadius: 8 }}>
                  {candidates.map(c => (
                    <label key={c.paymentId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer', fontSize: 13, borderTop: '1px solid #F1EEE9', background: picked.has(c.paymentId) ? '#F8EAE4' : 'transparent' }}>
                      <input type="checkbox" checked={picked.has(c.paymentId)} onChange={() => toggle(c.paymentId)} />
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                        <strong>{c.humanPaymentId ?? 'Payment'}</strong> · {c.clientName ?? 'Suspense'}
                        <span style={{ display: 'block', color: '#686D6C', fontSize: 12 }}>
                          {paymentModeLabel(c.paymentMode)}{c.paymentDate ? ` · ${formatFullDate(c.paymentDate)}` : ''}
                        </span>
                      </span>
                      <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatINR(c.amount)}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* 3. When and note */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600 }}>
              3 · Date and time
              <input type="datetime-local" value={handedAt} onChange={e => setHandedAt(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #686D6C', font: 'inherit', fontWeight: 400 }} />
            </label>
            <label style={{ flex: '2 1 240px', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600 }}>
              Note (optional)
              <input type="text" value={note} maxLength={1000} onChange={e => setNote(e.target.value)} placeholder="e.g. handed at the factory gate"
                style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #686D6C', font: 'inherit', fontWeight: 400 }} />
            </label>
          </div>

          {/* Live total + the sentence that says what happens next */}
          <div style={{ padding: '12px 14px', borderRadius: 10, background: '#FFF8E8', border: '1.5px solid rgba(196,138,26,0.6)' }}>
            <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: '#5E4106' }}>{formatINR(total)}</div>
            <div style={{ fontSize: 13, color: '#5E4106', marginTop: 2 }} aria-live="polite">
              {chosen.length > 0 && recipient
                ? `You are handing ${formatINR(total)} (${chosen.length} ${chosen.length === 1 ? 'payment' : 'payments'}) to ${recipient.fullName}. They must accept it; until then it stays highlighted for both of you.`
                : 'Choose a person and at least one payment.'}
            </div>
          </div>

          {error && <div className="boe-handover-error" role="alert">{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose} disabled={create.isPending}>Cancel</button>
            <button
              type="button"
              className="boe-btn boe-btn-primary"
              onClick={() => void submit()}
              disabled={create.isPending || candidates.length === 0}
              aria-busy={create.isPending}
            >
              {create.isPending ? 'Handing over…' : `Hand over ${formatINR(total)}`}
            </button>
          </div>
        </>
      )}
    </FinanceModal>
  )
}
