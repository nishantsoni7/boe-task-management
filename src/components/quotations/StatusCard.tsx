'use client'

// The builder's Status card (owner-approved layout, 18 Nov 2026): a four-step tracker (where the quotation is), one main action and
// one other, the reason the main action waits as one calm line, and the rarer outcomes as quiet buttons. Moved out of BuilderScreen
// with its behaviour unchanged: the same buttons under the same conditions, "Save first" while there are unsaved edits, the "Why was
// it lost?" box, and Confirm → PI draft (it works on the SAVED quotation; nothing is sent to anyone, the PI stays a Draft).

import { AppLink as Link } from '@/components/ui/AppLink'
import { Check, FileCheck2, TriangleAlert } from 'lucide-react'
import { draftDetailHref } from '@/lib/orders/draftsView'
import { DEAD_REASONS } from '@/lib/salesLeads/board'
import { STATUS_LABEL, type Quotation, type QuotationStatus } from '@/lib/quotations/api'
import type { ConversionProblem } from '@/lib/quotations/piWorkbook'
import { PI_STAGE_LABEL, type PiStage } from '@/lib/quotations/toPiDraft'
import { StatusPill } from './ListScreen'
import s from './quotations.module.css'

export const LOCKED: QuotationStatus[] = ['confirmed', 'lost', 'archived']
const STEPS: QuotationStatus[] = ['draft', 'sent', 'negotiating', 'confirmed']

const NEEDS: Record<Exclude<ConversionProblem['code'], 'NO_LINES'>, string> = {
  NAME_MISSING: 'a name', QTY_MISSING: 'a quantity above 0', PRICE_MISSING: 'a price above ₹0', PICTURE_MISSING: 'a picture (Orders needs one for every product)',
}
const KIND: Record<Exclude<ConversionProblem['code'], 'NO_LINES'>, string> = { NAME_MISSING: 'Name', QTY_MISSING: 'Quantity', PRICE_MISSING: 'Price', PICTURE_MISSING: 'Picture' }
const SHOWN = 6

/** The one line the Status card says while the main action waits: what is missing, for how many products. */
export function waitsFor(problems: readonly ConversionProblem[]): string {
  if (problems.length !== 1) return `${problems.length} things to fix before this can become a PI.`
  const p = problems[0]
  return p.code === 'NO_LINES' ? 'Add at least one product that is not optional.' : `${p.lines.length} ${p.lines.length === 1 ? 'product needs' : 'products need'} ${NEEDS[p.code]} before this can become a PI.`
}

type Props = {
  base: Quotation; dirty: boolean; busy: boolean; isAdmin: boolean
  canConfirm: boolean; piProblems: readonly ConversionProblem[]; priceBlocked: boolean; piStage: PiStage | null
  /** The Lost box is open while `lostNote` is not null; the reason is one of the lead's eleven (20270813000000). */
  lostNote: string | null; setLostNote: (v: string | null) => void; lostReason: string; setLostReason: (v: string) => void
  onMove: (status: QuotationStatus, note?: string, reason?: string) => void; onConfirm: () => void
  /** 20270817000000: the database says this person may delete this quotation now (an unsent draft they made, or anything for an administrator); the button opens the confirm. */
  canDelete?: boolean; onDelete?: () => void
}

export function StatusCard({ base, dirty, busy, isAdmin, canConfirm, piProblems, priceBlocked, piStage, lostNote, setLostNote, lostReason, setLostReason, onMove, onConfirm, canDelete, onDelete }: Props) {
  const status = base.status
  const locked = LOCKED.includes(status)
  const step = STEPS.indexOf(status)
  const may = base.may_edit
  const off = busy || dirty
  const saveFirst = dirty ? 'Save first' : undefined
  const markSent = may && status === 'draft'
  const negotiating = may && (status === 'sent' || status === 'draft')
  const reopen = may && locked && (status !== 'confirmed' || isAdmin)
  const noPi = may && !locked
  const lost = may && !locked
  const archive = may && status !== 'archived' && status !== 'confirmed'

  return (
    <section className={`${s.card} ${s.tile}`} aria-label="Status">
      <h2 className={s.tileLab}>Status</h2>
      {step >= 0 ? (
        <ol className={s.steps} data-s={status} aria-label="Where the quotation is">
          {STEPS.map((k, i) => (
            <li key={k} className={`${s.step} ${i < step ? s.stepDone : i === step ? s.stepCur : ''}`} aria-current={i === step ? 'step' : undefined}>
              <span className={s.dot}>{i < step ? <Check size={12} strokeWidth={3} aria-hidden /> : null}</span>{STATUS_LABEL[k]}
            </li>
          ))}
        </ol>
      ) : <div><StatusPill status={status} /></div>}

      {base.pi && <p className={s.tileText}>Confirmed into PI draft <b>{base.pi.draft_reference ?? ''}</b> ({base.pi.status.replace(/_/g, ' ')})</p>}

      <div className={s.acts2}>
        {base.pi && <Link className={`${s.btn} ${s.btnPrimary}`} href={draftDetailHref(base.pi.id)}><FileCheck2 size={15} aria-hidden /> Open the PI draft</Link>}
        {markSent && <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={off} title={saveFirst} onClick={() => onMove('sent')}>Mark sent</button>}
        {canConfirm && (
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={off || piProblems.length > 0 || priceBlocked} title={saveFirst} onClick={onConfirm}>
            <FileCheck2 size={15} aria-hidden /> {piStage ? PI_STAGE_LABEL[piStage] : 'Confirm → make PI draft'}
          </button>
        )}
        {negotiating && <button type="button" className={s.btn} disabled={off} title={saveFirst} onClick={() => onMove('negotiating')}>Negotiating</button>}
        {reopen && <button type="button" className={s.btn} disabled={busy} onClick={() => onMove('negotiating')}>Reopen</button>}
      </div>

      {lostNote !== null && (
        <div className={s.tileNote}>
          <label className={s.field}><span>Why was it lost?</span>
            <select id="q-lost-reason" className={s.input} value={lostReason} onChange={e => setLostReason(e.target.value)} autoFocus>
              <option value="">Choose a reason…</option>
              {DEAD_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select></label>
          <label className={s.field}><span>Note{lostReason === 'other' ? ' (required)' : ' (optional)'}</span><input id="q-lost" className={s.input} value={lostNote} maxLength={300} onChange={e => setLostNote(e.target.value)} placeholder="Anything worth remembering" /></label>
          <div className={s.row}><button type="button" className={`${s.btn} ${s.btnSm} ${s.btnDanger}`} disabled={busy || !lostReason || (lostReason === 'other' && lostNote.trim().length < 3)} onClick={() => { onMove('lost', lostNote.trim() || undefined, lostReason); setLostNote(null); setLostReason('') }}>Mark lost</button><button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => { setLostNote(null); setLostReason('') }}>Cancel</button></div>
        </div>
      )}

      {may && dirty && !locked && <p className={s.tileText}>Save your changes before confirming.</p>}
      {canConfirm && piProblems.length > 0 && (
        <details className={s.hint}>
          <summary><TriangleAlert size={15} aria-hidden /> <span>{waitsFor(piProblems)}</span><span className={s.hintMore}>Show which</span></summary>
          <div className={s.hintBody}>
            {piProblems.filter(p => p.lines.length > 0).map(p => (
              <div key={p.code} className={s.hintRow}>
                {piProblems.length > 1 && p.code !== 'NO_LINES' && <b>{KIND[p.code]} needed:</b>}
                {p.lines.slice(0, SHOWN).map((name, i) => <span key={i} className={s.chip}>{name}</span>)}
                {p.lines.length > SHOWN && <span className={s.chip}>+ {p.lines.length - SHOWN} more</span>}
              </div>
            ))}
          </div>
        </details>
      )}
      {canConfirm && piProblems.length === 0 && !dirty && <p className={s.tileText}>Confirm makes a PI draft in Orders from the saved quotation and opens it. Nothing is sent to anyone: the PI stays a Draft until you submit it there. The quotation then becomes Confirmed.</p>}
      {canConfirm && priceBlocked && <p className={s.tileText}>Waiting for price approval (see Price approval).</p>}

      {(noPi || lost || archive || canDelete) && (
        <div className={s.outcomes}>
          <span className={s.outcomesLab}>Other outcome</span>
          <div className={s.quietRow}>
            {noPi && <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnQuiet}`} disabled={off} onClick={() => onMove('confirmed')} title="Confirmed without making a PI from it">Confirmed, no PI</button>}
            {lost && <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnQuiet} ${s.btnQuietDanger}`} disabled={off} title={saveFirst} onClick={() => setLostNote('')}>Lost…</button>}
            {archive && <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnQuiet}`} disabled={off} title={saveFirst} onClick={() => onMove('archived')}>Archive</button>}
            {canDelete && onDelete && <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnQuiet} ${s.btnQuietDanger}`} disabled={busy} onClick={onDelete}>Delete…</button>}
          </div>
        </div>
      )}
    </section>
  )
}
