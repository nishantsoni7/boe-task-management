'use client'

// Price learning: what salespeople and the pricing desk have said about suggested prices. Feedback is read here and marked
// seen, done or declined with a note, so nothing sent is lost. (Changing the logic itself from here is piece 3.)

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLink as Link } from '@/components/ui/AppLink'
import type { createClient } from '@/lib/supabase/client'
import { formatINR } from '@/lib/currency'
import { fetchFeedback, learningErrorText, learningKeys, setFeedbackStatus, type FeedbackRow } from '@/lib/pricing/learning/api'
import { dateIN, KIND_LABEL } from './common'
import s from '@/components/quotations/quotations.module.css'
import l from './learning.module.css'

type Supabase = ReturnType<typeof createClient>

export function FeedbackInbox({ supabase }: { supabase: Supabase }) {
  const qc = useQueryClient()
  const [showAll, setShowAll] = useState(false)
  const q = useQuery({ queryKey: learningKeys.feedback(!showAll), queryFn: () => fetchFeedback(supabase, !showAll), retry: false })
  const set = useMutation({
    mutationFn: (v: { id: string; status: FeedbackRow['status']; note: string | null }) => setFeedbackStatus(supabase, v.id, v.status, v.note),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['pricing', 'learning'] }) },
  })
  const rows = q.data ?? []
  return (
    <section className={s.card} aria-labelledby="feedback-h">
      <div className={s.cardHead}>
        <h2 id="feedback-h">Feedback on suggested prices</h2>
        {q.data && <span className={s.chip}>{showAll ? `${rows.length} shown` : `${rows.length} open`}</span>}
        <span className={s.spacer} />
        <button type="button" className={s.fchip} aria-pressed={showAll} onClick={() => setShowAll(v => !v)}>{showAll ? 'Showing all' : 'Show handled too'}</button>
      </div>
      {q.isError && <div className={`${s.notice} ${s.noticeBad}`} style={{ margin: 12 }}>{learningErrorText(q.error)}</div>}
      {q.isLoading && <div className={s.empty}>Loading…</div>}
      {q.data && rows.length === 0 && <div className={s.empty}><h3>Nothing waiting</h3>Feedback sent from a suggested price on any quotation, or from a blind test, appears here.</div>}
      <div className={l.inbox}>
        {rows.map(r => <Row key={r.id} r={r} busy={set.isPending} onSet={(status, note) => set.mutate({ id: r.id, status, note })} />)}
      </div>
      {set.isError && <div className={`${s.notice} ${s.noticeBad}`} style={{ margin: 12 }}>{learningErrorText(set.error)}</div>}
    </section>
  )
}

function Row({ r, busy, onSet }: { r: FeedbackRow; busy: boolean; onSet: (status: FeedbackRow['status'], note: string | null) => void }) {
  const [note, setNote] = useState<'done' | 'declined' | null>(null)
  const [text, setText] = useState('')
  const sg = r.suggestion
  const detail = [r.line_size, r.line_material, r.line_qty ? `${r.line_qty} pcs` : null].filter(Boolean).join(' · ')
  return (
    <div className={l.ib}>
      <div style={{ minWidth: 0 }}>
        <div><span className={`${s.pill} ${r.kind === 'correction' ? s.st_negotiating : s.st_sent}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>{' '}
          <b>{r.line_name || 'A product'}</b>{r.status !== 'new' && <> {' '}<span className={s.chip}>{r.status}</span></>}</div>
        {detail && <small>{detail}</small>}
        <div className={s.small}>
          {sg && <>The model said <b>{formatINR(sg.price)}</b> ({formatINR(sg.low)}–{formatINR(sg.high)}, {sg.confidence})</>}
          {r.expected_price && <>{sg ? ' · ' : ''}they would quote <b>{formatINR(r.expected_price)}</b></>}
        </div>
        {sg?.reasons && sg.reasons.length > 0 && <small>It showed: {sg.reasons.join(' · ')}</small>}
        <small style={{ display: 'block' }}>{r.from_name ?? 'Someone'} · {dateIN(r.created_at)}{r.source === 'learning' ? ' · from a blind test' : ''}
          {r.quotation_id && r.quote_no && <> · <Link href={`/quotations/${r.quotation_id}`} className={s.linkBtn}>{r.quote_no}</Link></>}</small>
      </div>
      <div className={l.ibAct}>
        {r.status === 'new' && <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => onSet('seen', null)}>Seen</button>}
        {r.status !== 'done' && r.status !== 'declined' && <>
          <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => setNote('done')}>Done</button>
          <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => setNote('declined')}>Decline</button>
        </>}
      </div>
      {r.comment && <div className={l.ibQuote}>{r.comment}</div>}
      {r.handled_note && <div className={`${s.small} ${s.muted}`} style={{ gridColumn: '1 / -1' }}>Answer: {r.handled_note}</div>}
      {note && (
        <div style={{ gridColumn: '1 / -1' }} className={l.fbRow}>
          <input className={s.input} style={{ maxWidth: 420 }} aria-label={note === 'done' ? 'What was done' : 'Why it is declined'} placeholder={note === 'done' ? 'What was done (optional)' : 'Why not (optional)'} value={text} onChange={e => setText(e.target.value)} maxLength={500} />
          <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} disabled={busy} onClick={() => { onSet(note, text.trim() || null); setNote(null); setText('') }}>Mark {note}</button>
          <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setNote(null)}>Cancel</button>
        </div>
      )}
    </div>
  )
}
