'use client'

import { useState } from 'react'
import { seoWriteMessage, type SeoDecision } from '@/lib/seo/api'
import { dayLabel, type SeoLogRow } from '@/lib/seo/report'
import { Tag } from './SeoSixMonth'
import s from './sixMonth.module.css'

export type OnDecide = (id: string, decision: SeoDecision, note: string) => Promise<void>

const ANSWER: Record<SeoDecision, string> = { change: 'Plan changed', keep: 'Plan kept' }

/** One proposed strategy change. Someone who cannot answer it still reads it. */
export function ProposalCard({ proposal, onDecide }: { proposal: SeoLogRow; onDecide?: OnDecide }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const answer = async (decision: SeoDecision) => {
    if (!onDecide) return
    setBusy(true)
    setError('')
    try {
      await onDecide(proposal.id, decision, note)
    } catch (e) {
      setError(seoWriteMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className={s.proposal}>
      <div className={s.strong}>{proposal.title}</div>
      {proposal.body && <div className={s.small}>{proposal.body}</div>}
      {proposal.after_value && <div className={s.recommendation}><b>Recommendation:</b> {proposal.after_value}</div>}
      {proposal.decision ? (
        <div className={s.small}>
          <Tag tag={{ text: ANSWER[proposal.decision], tone: proposal.decision === 'change' ? 'good' : 'pending' }} />
          {proposal.decided_at ? ` ${dayLabel(proposal.decided_at.slice(0, 10))}` : ''}{proposal.decision_note ? ` · ${proposal.decision_note}` : ''}
        </div>
      ) : onDecide ? (
        <>
          <div className={s.answer}>
            <button className="boe-btn boe-btn-primary" disabled={busy} onClick={() => answer('change')}>Change the plan</button>
            <button className="boe-btn boe-btn-secondary" disabled={busy} onClick={() => answer('keep')}>Keep the plan</button>
            <input className={`boe-input ${s.answerNote}`} aria-label="Note (optional)" placeholder="Note (optional)" value={note} maxLength={1000} onChange={e => setNote(e.target.value)} disabled={busy} />
          </div>
          {error && <p className="boe-field-error" role="alert">{error}</p>}
        </>
      ) : (
        <Tag tag={{ text: 'Waiting for an answer', tone: 'wait' }} className={s.selfStart} />
      )}
    </div>
  )
}
