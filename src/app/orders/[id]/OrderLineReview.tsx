'use client'

// OPERATIONS FLAGS PI LINES BEFORE AN ORDER IS ALIGNED (20270616000000).
//
//   OrderLineReviewModal  the assigned reviewer marks each line OK / Comment / Cannot make
//   LineFlagBand          what was flagged, under the product row, for everyone who reads the Order
//
// Both are functions of their props: the page owns the write (flag_order_lines), and the database decides
// again under its locks whatever the page sent. The rules and the words are lib/orders/lineFlags.ts.

import { useState } from 'react'
import { OrderModal, OrderModalError } from '@/components/orders/OrderModal'
import { PI_THUMBNAIL_SIZE, PiProductThumbnail, type PiThumbnailProps } from '@/components/orders/piPreview'
import {
  FLAGGED_BY,
  LINE_FLAG_REASONS,
  LINE_MARK_LABEL,
  LINE_NOTE_LABEL,
  LINE_NOTE_MAX_LENGTH,
  LINE_NOTE_PLACEHOLDER,
  LINE_PRICE_HINT,
  LINE_PRICE_LABEL,
  LINE_REVIEW_HINT,
  LINE_REVIEW_OTHER_REASON,
  LINE_REVIEW_TITLE,
  OK_MARK,
  formatSuggestedPrice,
  lineFlagPayload,
  lineFlagStatus,
  lineMarkProblem,
  reasonLabel,
  summarizeLineReview,
  type LineFlag,
  type LineFlagPayload,
  type LineFlagReason,
  type LineMark,
  type LineMarkKind,
} from '@/lib/orders/lineFlags'
import s from './lineFlags.module.css'

export type ReviewLine = {
  itemId: string
  code: string
  name: string
  /** "8 × ₹4,500 · Acacia wood · Seat height 18"" */
  detail: string
  thumbnail?: PiThumbnailProps
}

const KINDS: readonly LineMarkKind[] = ['ok', 'comment', 'cannot_make']

export function OrderLineReviewModal({
  orderNumber, versionLabel, lines, initial, saving, failure, onClose, onAccept, onOtherReason, onConfirm,
}: {
  orderNumber: string
  versionLabel: string
  lines: readonly ReviewLine[]
  /** Marks to start from (the flags already saved on this review), by item id. */
  initial?: ReadonlyMap<string, LineMark>
  saving: boolean
  failure: string | null
  onClose: () => void
  /** Nothing marked: the ordinary acceptance (its own window says what it aligns). */
  onAccept: () => void
  /** The older whole-PI reason, for a problem that is not about a line. */
  onOtherReason: () => void
  onConfirm: (lines: LineFlagPayload[]) => void
}) {
  const [marks, setMarks] = useState<Record<string, LineMark>>(() =>
    Object.fromEntries(lines.map(l => [l.itemId, initial?.get(l.itemId) ?? OK_MARK])))
  const [touched, setTouched] = useState(false)
  const set = (itemId: string, patch: Partial<LineMark>) =>
    setMarks(prev => ({ ...prev, [itemId]: { ...prev[itemId], ...patch } }))

  const ordered = lines.map(l => ({ itemId: l.itemId, mark: marks[l.itemId] ?? OK_MARK }))
  const summary = summarizeLineReview(ordered.map(o => o.mark))

  const press = () => {
    setTouched(true)
    if (saving || !summary.ready) return
    if (summary.action === 'accept') { onAccept(); return }
    onConfirm(lineFlagPayload(ordered))
  }

  return (
    <OrderModal title={LINE_REVIEW_TITLE(versionLabel)} subtitle={`Order ${orderNumber} · ${lines.length} line${lines.length === 1 ? '' : 's'}`} onClose={onClose} width={760}>
      <p className={s.hint}>{LINE_REVIEW_HINT}</p>
      <div className={s.list}>
        {lines.map(line => {
          const mark = marks[line.itemId] ?? OK_MARK
          const problem = touched ? lineMarkProblem(mark) : null
          const noteId = `line-note-${line.itemId}`
          const priceId = `line-price-${line.itemId}`
          return (
            <div key={line.itemId} className={s.line} data-kind={mark.kind}>
              <div className={s.head}>
                {line.thumbnail ? <PiProductThumbnail {...line.thumbnail} size={PI_THUMBNAIL_SIZE.representativeCompact} /> : <span />}
                <div style={{ minWidth: 0 }}>
                  <div className={s.code}>{line.code}</div>
                  <div className={s.name}>{line.name}</div>
                  {line.detail && <div className={s.detail}>{line.detail}</div>}
                </div>
                <div className={s.seg} role="group" aria-label={`${line.code} ${line.name}`}>
                  {KINDS.map(kind => (
                    <button key={kind} type="button" data-kind={kind} aria-pressed={mark.kind === kind} disabled={saving}
                      onClick={() => set(line.itemId, { kind })}>
                      {LINE_MARK_LABEL[kind]}
                    </button>
                  ))}
                </div>
              </div>
              {mark.kind !== 'ok' && (
                <div className={s.body}>
                  <div>
                    <span className={s.label} id={`${noteId}-why`}>Why</span>
                    <div className={s.chips} role="group" aria-labelledby={`${noteId}-why`}>
                      {LINE_FLAG_REASONS.map(r => {
                        const on = mark.reasons.includes(r.code)
                        return (
                          <button key={r.code} type="button" className={s.chip} aria-pressed={on} disabled={saving}
                            onClick={() => set(line.itemId, {
                              reasons: on ? mark.reasons.filter(x => x !== r.code) : [...mark.reasons, r.code as LineFlagReason],
                            })}>
                            {r.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div>
                    <label className={s.label} htmlFor={noteId}>{LINE_NOTE_LABEL}</label>
                    <textarea id={noteId} className={s.textarea} rows={3} value={mark.note} maxLength={LINE_NOTE_MAX_LENGTH}
                      placeholder={LINE_NOTE_PLACEHOLDER} disabled={saving}
                      onChange={e => set(line.itemId, { note: e.target.value })} />
                  </div>
                  {mark.reasons.includes('price_low') && (
                    <div className={s.price}>
                      <label className={s.label} htmlFor={priceId} style={{ margin: 0 }}>{LINE_PRICE_LABEL}</label>
                      <span>₹</span>
                      <input id={priceId} className={s.priceInput} inputMode="decimal" value={mark.price} disabled={saving}
                        onChange={e => set(line.itemId, { price: e.target.value })} />
                      <span className={s.muted}>{LINE_PRICE_HINT}</span>
                    </div>
                  )}
                  {problem && <p className={s.problem} role="alert">{problem}</p>}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <button type="button" className={s.link} onClick={onOtherReason} disabled={saving}>{LINE_REVIEW_OTHER_REASON}</button>
      {failure && <OrderModalError message={failure} />}
      <div className={s.foot}>
        <div style={{ display: 'grid', gap: '4px' }}>
          <div className={s.counts}>
            <span><i className={s.dot} style={{ background: 'var(--boe-error)' }} />{summary.cannotMake} cannot be made</span>
            <span><i className={s.dot} style={{ background: 'var(--boe-waiting-fg)' }} />{summary.comments} comment{summary.comments === 1 ? '' : 's'}</span>
            <span><i className={s.dot} style={{ background: 'var(--boe-completed-fg)' }} />{summary.ok} OK</span>
          </div>
          <p className={s.after} data-bad={touched && !summary.ready} aria-live="polite">
            {summary.note}
          </p>
        </div>
        <div className={s.actions}>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose} disabled={saving}>Close</button>
          <button type="button" className="boe-btn boe-btn-primary" onClick={press} disabled={saving || (touched && !summary.ready)}
            aria-busy={saving}>
            {saving ? 'Saving…' : summary.actionLabel}
          </button>
        </div>
      </div>
    </OrderModal>
  )
}

/** What Operations said about one product line, shown under it. */
export function LineFlagBand({ flag }: { flag: LineFlag }) {
  const status = lineFlagStatus(flag)
  return (
    <div className={s.band} data-tone={status.tone} data-line-flag={flag.kind}>
      <div className={s.why}>
        <span className={s.tag} data-tone={status.tone}>{status.label}</span>
        {flag.reasons.map(r => <span key={r} className={s.tag}>{reasonLabel(r)}</span>)}
        <span className={s.muted}>{FLAGGED_BY(flag.byName)} · PI V{flag.versionNumber}</span>
      </div>
      <p className={s.note}>{flag.note}</p>
      {flag.suggestedPrice !== null && (
        <p className={s.should}>Operations says the price should be <b>{formatSuggestedPrice(flag.suggestedPrice)}</b> per piece.</p>
      )}
    </div>
  )
}
