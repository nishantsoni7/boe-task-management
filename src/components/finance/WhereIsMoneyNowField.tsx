'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { handoverErrorMessage, readHandoverRecipients, type HandoverRecipient } from '@/lib/finance/handover'
import { isTrackedPaymentMode, type MoneyNow } from '@/lib/finance/cashJourney'

// ── "Where is this money now?" (20270413000000) ──────────────────────────────
//
// Replaces the old optional "Who carried the money" activity list on every form
// that records a PNB, Paytm or Canara payment. One required answer:
//
//   ◉ With me              the recorder holds it (nothing else is written);
//   ○ Handed to [person]   after the payment is saved, a handover is offered to
//                          that person, who must ACCEPT it.
//
// A recorder who receives cash for the company (a custodian) is not asked: the
// money is already with the company the moment they record it.
//
// The server decides everything again: create_cash_handover re-checks that the
// recorder holds the payment, and a "handed over" can only be written by an
// acceptance. This field only asks the question.

type People = { recipients: HandoverRecipient[]; custodianIds: Set<string> }

function usePeople(enabled: boolean) {
  const [people, setPeople] = useState<People | null>(null)
  useEffect(() => {
    if (!enabled || people) return
    let live = true
    // A list that cannot be read is an empty list, never a crash: "With me" is
    // always a correct answer, and the server re-checks any handover.
    const empty: People = { recipients: [], custodianIds: new Set() }
    void (async () => {
      try {
        const supabase = createClient()
        const [r, c] = await Promise.all([
          supabase.rpc('finance_handover_recipients'),
          supabase.from('finance_cash_custodians').select('user_id'),
        ])
        if (!live) return
        setPeople({
          recipients: r.error ? [] : readHandoverRecipients(r.data),
          custodianIds: new Set(c.error ? [] : (c.data ?? []).map((x: { user_id: string }) => x.user_id)),
        })
      } catch {
        if (live) setPeople(empty)
      }
    })()
    return () => { live = false }
  }, [enabled, people])
  return people
}

export function WhereIsMoneyNowField({
  paymentMode,
  value,
  onChange,
  recorderId,
  problem,
}: {
  paymentMode: string
  value: MoneyNow
  onChange: (v: MoneyNow) => void
  recorderId: string | null
  /** The form's own sentence for what is still missing, shown after Send. */
  problem?: string | null
}) {
  const applies = isTrackedPaymentMode(paymentMode)
  const people = usePeople(applies)
  const [filter, setFilter] = useState('')

  const recorderIsCustodian = !!recorderId && !!people?.custodianIds.has(recorderId)
  const custodianNames = useMemo(() => {
    if (!people) return ''
    return people.recipients.filter(r => people.custodianIds.has(r.id)).map(r => r.fullName).join(' / ')
  }, [people])
  const shown = useMemo(() => {
    const all = people?.recipients ?? []
    const q = filter.trim().toLowerCase()
    // Custodians first: handing to them is what closes the journey.
    const sorted = [...all].sort((a, b) =>
      Number(people?.custodianIds.has(b.id)) - Number(people?.custodianIds.has(a.id)) || a.fullName.localeCompare(b.fullName))
    return q ? sorted.filter(r => r.fullName.toLowerCase().includes(q)) : sorted
  }, [people, filter])

  if (!applies) return null

  const box: React.CSSProperties = { border: '1px solid #E4DED7', borderRadius: 10, padding: 12, background: '#FBFAF8' }

  if (!people) {
    return <div style={box}><div style={{ fontSize: 13, color: '#686D6C' }}>Loading…</div></div>
  }

  if (recorderIsCustodian) {
    return (
      <div style={box}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#276247' }}>Received by the company ✓</div>
        <div style={{ fontSize: 13, color: '#4C5352', marginTop: 4 }}>You receive cash for the company, so this money is already with the company.</div>
      </div>
    )
  }

  const handedTo = value.choice === 'handed_to' ? value.recipientId : ''

  return (
    <div style={box} role="radiogroup" aria-label="Where is this money now?">
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Where is this money now?</div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14, cursor: 'pointer', marginBottom: 8 }}>
        <input type="radio" name="money-now" checked={value.choice === 'with_me'} onChange={() => onChange({ choice: 'with_me' })} style={{ marginTop: 3 }} />
        <span>
          <strong>With me</strong>
          <span style={{ display: 'block', fontSize: 12, color: '#686D6C' }}>You will hand it over later. It stays on your list until it reaches {custodianNames || 'the company'}.</span>
        </span>
      </label>

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14, cursor: 'pointer' }}>
        <input type="radio" name="money-now" checked={value.choice === 'handed_to'} onChange={() => onChange({ choice: 'handed_to', recipientId: handedTo })} style={{ marginTop: 3 }} />
        <span>
          <strong>I handed it to someone</strong>
          <span style={{ display: 'block', fontSize: 12, color: '#686D6C' }}>They will be asked to accept it.</span>
        </span>
      </label>

      {value.choice === 'handed_to' && (
        <div style={{ marginTop: 8, marginLeft: 24 }}>
          <input
            type="search"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Search a person"
            aria-label="Search a person"
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #686D6C', font: 'inherit', fontSize: 14, marginBottom: 6 }}
          />
          <div role="radiogroup" aria-label="Handed to" style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #E4DED7', borderRadius: 8, background: '#FFFFFF' }}>
            {shown.filter(r => r.id !== recorderId).map(r => (
              <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', fontSize: 14, background: r.id === handedTo ? '#F8EAE4' : 'transparent', fontWeight: r.id === handedTo ? 700 : 400 }}>
                <input type="radio" name="money-now-person" checked={r.id === handedTo} onChange={() => onChange({ choice: 'handed_to', recipientId: r.id })} />
                {r.fullName}
                {people.custodianIds.has(r.id) && <span style={{ fontSize: 11, fontWeight: 700, color: '#276247', marginLeft: 'auto' }}>COMPANY</span>}
              </label>
            ))}
          </div>
        </div>
      )}

      {problem && <div role="alert" style={{ fontSize: 12, color: '#B42332', marginTop: 6 }}>{problem}</div>}
    </div>
  )
}

/**
 * After a payment is saved: offer its handover to the chosen person. Returns
 * null on success, or the server's sentence on failure. The key is the payment
 * id, so a retry never offers the same payment twice.
 */
export async function handOverAfterRecording(
  supabase: ReturnType<typeof createClient>,
  paymentId: string,
  recipientId: string,
): Promise<string | null> {
  const { error } = await supabase.rpc('create_cash_handover', {
    p_recipient: recipientId,
    p_payment_ids: [paymentId],
    p_handed_at: null,
    p_note: null,
    p_idempotency_key: `entry:${paymentId}`,
  })
  return error ? handoverErrorMessage(error) : null
}

/**
 * Shown in place of the form when the payment saved but its handover did not:
 * the record is right (the money is "with you"), and one button tries again.
 */
export function HandoverAfterSaveNotice({
  paymentLabel,
  message,
  onRetry,
  onClose,
  retrying,
}: {
  paymentLabel: string
  message: string
  onRetry: () => void
  onClose: () => void
  retrying: boolean
}) {
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 10, border: '1.5px solid rgba(196,138,26,0.6)', background: '#FFF8E8' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#5E4106' }}>Payment {paymentLabel} is saved. The handover did not go through.</div>
      <div style={{ fontSize: 13, color: '#5E4106' }}>{message} For now the money is shown as with you. Try again, or hand it over later from the Finance page.</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose} disabled={retrying}>Close</button>
        <button type="button" className="boe-btn boe-btn-primary" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
          {retrying ? 'Trying…' : 'Try the handover again'}
        </button>
      </div>
    </div>
  )
}
