'use client'

import { useMemo, useRef, useState } from 'react'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { AmountInput } from '@/app/finance/components/AmountInput'
import { amountInputProblem, formatINR } from '@/lib/currency'
import { formatFullDate } from '@/lib/ui'
import { paymentModeLabel } from '@/lib/finance/paymentEntry'
import { isoToLocalInput, localInputToIso } from '@/lib/finance/custodyTrail'
import { useHandoverActions, useHandoverFormData, useMyCashBalance } from '@/hooks/queries/useHandovers'
import { handoverDraftError, sumRupees } from '@/lib/finance/handover'

/** A typed amount as rupees, or 0 while it is empty or not yet a valid figure. */
function typedRupees(raw: string): number {
  const v = raw.trim()
  if (!v || amountInputProblem(v)) return 0
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * "Hand over cash": who, what, when. One screen, a live total, and a final
 * sentence that says what the other person must do.
 *
 * WHAT can be any mix of:
 *   * PNB/Paytm payments the caller is CURRENTLY HOLDING
 *     (finance_my_handoverable_payments);
 *   * cash from the caller's CASH IN HAND, up to what they have available;
 *   * NEW cash not recorded anywhere yet, with where it came from.
 * create_cash_handover re-checks every one of these (20270412000000).
 */
export function HandoverModal({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const { data, isPending, isError, error: loadError } = useHandoverFormData(true)
  const cash = useMyCashBalance(true)
  const { create } = useHandoverActions()

  // Minted once per open dialog: a double click or a retry creates one handover.
  const keyRef = useRef<string>(crypto.randomUUID())

  const [recipientId, setRecipientId] = useState('')
  const [personFilter, setPersonFilter] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [cashFromHand, setCashFromHand] = useState('')
  const [cashNew, setCashNew] = useState('')
  const [cashNewSource, setCashNewSource] = useState('')
  const [handedAt, setHandedAt] = useState(() => isoToLocalInput(new Date().toISOString()))
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const candidates = useMemo(() => data?.candidates ?? [], [data])
  const recipients = useMemo(() => {
    const q = personFilter.trim().toLowerCase()
    const all = data?.recipients ?? []
    return q ? all.filter(r => r.fullName.toLowerCase().includes(q)) : all
  }, [data, personFilter])

  const available = cash.data ? Math.max(cash.data.available, 0) : null
  const recipient = (data?.recipients ?? []).find(r => r.id === recipientId) ?? null
  const chosen = candidates.filter(c => picked.has(c.paymentId))
  const fromHand = typedRupees(cashFromHand)
  const newCash = typedRupees(cashNew)
  const typedCash = sumRupees([fromHand, newCash])
  const total = sumRupees([...chosen.map(c => c.amount), fromHand, newCash])
  const allPicked = candidates.length > 0 && picked.size === candidates.length

  const contents = [
    chosen.length > 0 ? `${chosen.length} ${chosen.length === 1 ? 'payment' : 'payments'}` : '',
    typedCash > 0 ? `${formatINR(typedCash)} cash` : '',
  ].filter(Boolean).join(' + ')

  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const submit = async () => {
    const problem = handoverDraftError({
      recipientId, paymentIds: [...picked], handedAt,
      cashFromHand, cashNew, cashNewSource, available,
    })
    if (problem) { setError(problem); return }
    setError(null)
    try {
      await create.mutateAsync({
        recipientId,
        paymentIds: [...picked],
        handedAtIso: localInputToIso(handedAt),
        note,
        cashFromHand: fromHand,
        cashNew: newCash,
        cashNewSource,
        idempotencyKey: keyRef.current,
      })
      onCreated?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
    }
  }

  const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#686D6C', margin: '0 0 6px' }
  const subTitle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: '#303536', margin: '0 0 6px' }
  const fieldLabel: React.CSSProperties = { flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600 }
  const textInput: React.CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid #686D6C', font: 'inherit', fontWeight: 400 }

  return (
    <FinanceModal title="Hand over cash" onClose={onClose} width="580px" closeOnBackdropClick={false}>
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

          {/* 2. What */}
          <div>
            <h4 style={sectionTitle}>2 · What are you handing over</h4>

            <h5 style={subTitle}>Payments you are holding</h5>
            {candidates.length === 0 ? (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: '#F1EEE9', fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
                No PNB or Paytm payments with you right now. You can still hand over cash below.
              </div>
            ) : (
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, marginBottom: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={allPicked}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(candidates.map(c => c.paymentId)))}
                  />
                  Select all ({candidates.length})
                </label>
                <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid #E4DED7', borderRadius: 8 }}>
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
              </div>
            )}

            <h5 style={subTitle}>Cash not tied to a payment</h5>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={fieldLabel}>
                <span>
                  From your cash in hand{' '}
                  <span style={{ fontWeight: 400, color: '#686D6C' }}>
                    {available === null ? '' : `(available ${formatINR(available)})`}
                  </span>
                </span>
                <AmountInput value={cashFromHand} onChange={setCashFromHand} prefix="₹" />
              </label>
              <label style={fieldLabel}>
                <span>
                  New cash{' '}
                  <span style={{ fontWeight: 400, color: '#686D6C' }}>(not recorded anywhere yet)</span>
                </span>
                <AmountInput value={cashNew} onChange={setCashNew} prefix="₹" />
              </label>
            </div>
            {newCash > 0 && (
              <label style={{ ...fieldLabel, marginTop: 10 }}>
                Where is the new cash from?
                <input type="text" value={cashNewSource} maxLength={200} onChange={e => setCashNewSource(e.target.value)}
                  placeholder="e.g. Acme paid cash at the office" style={textInput} />
              </label>
            )}
          </div>

          {/* 3. When and note */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={fieldLabel}>
              3 · Date and time
              <input type="datetime-local" value={handedAt} onChange={e => setHandedAt(e.target.value)} style={textInput} />
            </label>
            <label style={{ ...fieldLabel, flex: '2 1 240px' }}>
              Note (optional)
              <input type="text" value={note} maxLength={1000} onChange={e => setNote(e.target.value)} placeholder="e.g. handed at the factory gate" style={textInput} />
            </label>
          </div>

          {/* Live total + the sentence that says what happens next */}
          <div style={{ padding: '12px 14px', borderRadius: 10, background: '#FFF8E8', border: '1.5px solid rgba(196,138,26,0.6)' }}>
            <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: '#5E4106' }}>{formatINR(total)}</div>
            <div style={{ fontSize: 13, color: '#5E4106', marginTop: 2 }} aria-live="polite">
              {total > 0 && recipient
                ? `You are handing ${formatINR(total)} (${contents}) to ${recipient.fullName}. They must accept it; until then it stays highlighted for both of you.`
                : 'Choose a person, then a payment or a cash amount.'}
            </div>
          </div>

          {error && <div className="boe-handover-error" role="alert">{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose} disabled={create.isPending}>Cancel</button>
            <button
              type="button"
              className="boe-btn boe-btn-primary"
              onClick={() => void submit()}
              disabled={create.isPending || total <= 0}
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
