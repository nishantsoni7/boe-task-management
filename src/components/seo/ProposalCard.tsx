'use client'

import { useState } from 'react'
import { seoWriteMessage, type SeoDecision } from '@/lib/seo/api'
import { dayLabel, type SeoLogRow } from '@/lib/seo/report'
import s from './seo.module.css'

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
    <div className={s.card}>
      <span>{proposal.title}</span>
      {proposal.body && <span className={s.cardMeta}>{proposal.body}</span>}
      {proposal.decision ? (
        <span className={s.cardMeta}>
          <span className={`boe-badge boe-badge-${proposal.decision === 'change' ? 'completed' : 'pending'}`}>{ANSWER[proposal.decision]}</span>
          {proposal.decided_at ? ` ${dayLabel(proposal.decided_at.slice(0, 10))}` : ''}{proposal.decision_note ? ` · ${proposal.decision_note}` : ''}
        </span>
      ) : onDecide ? (
        <div className={s.form}>
          <label className={s.field}>
            <span className={s.cardMeta}>Note (optional)</span>
            <input className="boe-input" value={note} maxLength={1000} onChange={e => setNote(e.target.value)} disabled={busy} />
          </label>
          <div className={s.buttons}>
            <button className="boe-btn boe-btn-primary" disabled={busy} onClick={() => answer('change')}>Change the plan</button>
            <button className="boe-btn boe-btn-secondary" disabled={busy} onClick={() => answer('keep')}>Keep the plan</button>
          </div>
          {error && <p className="boe-field-error" role="alert">{error}</p>}
        </div>
      ) : (
        <span className={`boe-badge boe-badge-waiting ${s.cardStatus}`}>Waiting for an answer</span>
      )}
    </div>
  )
}
