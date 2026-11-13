'use client'

// The doorway on every suggested price (owner, 2026-11-13: "always give an option to share feedback or correct the price
// logic"). Anyone who sees a suggestion can say it looks wrong, or describe how the logic should work; the pricing desk reads
// it in Price learning. It sits right under the suggestion on a quotation line, and beside each big miss of a blind test.

import { useId, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AppLink as Link } from '@/components/ui/AppLink'
import { formatINR } from '@/lib/currency'
import { learningErrorText, sendFeedback, type FeedbackDoc, type FeedbackKind } from '@/lib/pricing/learning/api'
import s from '@/components/quotations/quotations.module.css'
import l from './learning.module.css'

type Supabase = ReturnType<typeof createClient>

const KINDS: [Exclude<FeedbackKind, 'correction'>, string][] = [
  ['too_high', 'The price looks too high'],
  ['too_low', 'The price looks too low'],
  ['wrong_type', 'It treated this as the wrong kind of product'],
  ['misread', 'A detail was misread (size, material or quantity)'],
  ['other', 'Something else'],
]

export type FeedbackLine = FeedbackDoc['line']
/** What the model said: the price, its range and confidence, and the reasons it showed. */
export type FeedbackSuggestion = { price: number; low: number; high: number; confidence: string; basis: string; reasons?: string[] }

export function SuggestionFeedback({ source, line, clientType, suggestion, quotationId = null, isDesk = false, client, label = 'Feedback or correct the logic' }: {
  source: FeedbackDoc['source']
  line: FeedbackLine
  clientType: string | null
  suggestion: FeedbackSuggestion | null
  quotationId?: string | null
  /** The pricing desk also gets a link to the list of feedback. */
  isDesk?: boolean
  /** The database client; the page's own unless a test passes one. */
  client?: Supabase
  label?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'feedback' | 'correction'>('feedback')
  const [kind, setKind] = useState<Exclude<FeedbackKind, 'correction'>>('too_high')
  const [price, setPrice] = useState('')
  const [comment, setComment] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    const text = comment.trim()
    if (mode === 'correction' && text.length < 5) { setError('Say in a few words how the logic should work.'); return }
    const expected = price.trim() === '' ? null : Number(price)
    if (expected !== null && !(expected > 0)) { setError('The price you would quote must be more than zero.'); return }
    setError(null); setState('sending')
    try {
      // The database client is made only when something is sent: every product line carries this doorway.
      await sendFeedback(client ?? createClient(), {
        source, kind: mode === 'correction' ? 'correction' : kind, comment: text || null, expected_price: expected, line, client_type: clientType,
        suggestion: suggestion ? { price: suggestion.price, low: suggestion.low, high: suggestion.high, confidence: suggestion.confidence, reasons: suggestion.reasons ?? [], basis: suggestion.basis } : null,
        quotation_id: quotationId,
      })
      setState('sent')
    } catch (e) { setError(learningErrorText(e)); setState('idle') }
  }

  if (!open) return <button type="button" className={l.fbLink} onClick={() => setOpen(true)} aria-expanded={false}>{label}</button>
  if (state === 'sent') {
    return (
      <div className={l.fbBox} role="status">
        <div className={l.fbOk}>Thank you. The pricing desk will see this.</div>
        <div className={l.fbRow}>
          <button type="button" className={l.fbLink} onClick={() => { setState('idle'); setComment(''); setPrice('') }}>Send another</button>
          <button type="button" className={l.fbLink} onClick={() => { setOpen(false); setState('idle'); setComment(''); setPrice('') }}>Close</button>
          {isDesk && <Link href="/quotations/learning" className={l.fbLink}>Open the feedback list</Link>}
        </div>
      </div>
    )
  }
  return (
    <div className={l.fbBox} role="group" aria-label="Feedback on the suggested price">
      <h4>Help the price logic get better</h4>
      {suggestion && <div className={l.fbCtx}>{line.name || 'This product'}: suggested <b>{formatINR(suggestion.price)}</b> ({formatINR(suggestion.low)}–{formatINR(suggestion.high)}, {suggestion.confidence} confidence)</div>}
      <div className={l.fbModes} role="group" aria-label="What would you like to do">
        <button type="button" className={s.fchip} aria-pressed={mode === 'feedback'} onClick={() => setMode('feedback')}>Share feedback</button>
        <button type="button" className={s.fchip} aria-pressed={mode === 'correction'} onClick={() => setMode('correction')}>Correct the logic</button>
      </div>
      {mode === 'feedback' && (
        <div className={l.fbKinds} role="radiogroup" aria-label="What is wrong">
          {KINDS.map(([k, text]) => <label key={k}><input type="radio" name={`${id}-kind`} checked={kind === k} onChange={() => setKind(k)} /> {text}</label>)}
        </div>
      )}
      <label className={s.field}><span>{mode === 'correction' ? 'How should the logic work?' : 'Anything to add?'}</span>
        <textarea className={s.input} rows={mode === 'correction' ? 3 : 2} maxLength={1000} value={comment} onChange={e => setComment(e.target.value)}
          placeholder={mode === 'correction' ? 'For example: teak should cost 25% more than mango from October' : 'For example: the last 3 teak beds sold at ₹56,000'} />
      </label>
      <label className={s.field}><span>What would you quote? (optional, ₹ before GST)</span>
        <input className={`${s.input} ${s.money}`} type="number" min={0} inputMode="numeric" value={price} onChange={e => setPrice(e.target.value)} />
      </label>
      {error && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{error}</div>}
      <div className={l.fbRow}>
        <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} onClick={send} disabled={state === 'sending'}>{state === 'sending' ? 'Sending…' : 'Send to the pricing desk'}</button>
        <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => { setOpen(false); setError(null) }}>Cancel</button>
      </div>
    </div>
  )
}
