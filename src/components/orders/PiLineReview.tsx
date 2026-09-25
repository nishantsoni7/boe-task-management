'use client'

// ── MATCHING A REVISED WORKBOOK'S LINES (20270104000000) ─────────────────────
//
// A revised workbook's lines are matched to the products in force by item
// number (column J). When a line has no number, or its number appears more
// than once, the database will not guess: the approval is refused with those
// lines, and the admin says here which product each one continues — so it
// keeps that product's BOE code — or that it is a new product. The database
// re-checks every choice (a product can be continued once; a removed product's
// number is never reused).

import { useState } from 'react'
import { colors } from '@/lib/tokens'

export type PiLineReviewLine = { id: string; seq: string | null; name: string | null; qty: string | number | null; why: string }
export type PiLineReviewCandidate = { id: string; seq: string | null; name: string | null; code: string | null }
export type PiLineReviewData = { lines: PiLineReviewLine[]; candidates: PiLineReviewCandidate[] }

export const PI_LINE_REVIEW_TITLE = 'Match the revised lines to the products in force'
export const PI_LINE_REVIEW_NEW = 'New product (new code)'

/** The body of an approve response that asks for matching, or null. */
export function lineReviewFrom(body: unknown): PiLineReviewData | null {
  const b = body as { error?: unknown; review?: unknown } | null
  if (!b || b.error !== 'ORDER_PI_REVISION_LINES_NEED_REVIEW') return null
  const r = b.review as PiLineReviewData | null
  return r && Array.isArray(r.lines) && Array.isArray(r.candidates) ? r : null
}

/** POST the approval, with the admin's matching when there is one. */
export async function requestPiRevisionApproval(versionId: string, lineMap?: Record<string, string>) {
  const res = await fetch('/api/orders/pi-revisions/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lineMap ? { versionId, lineMap } : { versionId }),
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  return { ok: res.ok, body, review: res.ok ? null : lineReviewFrom(body) }
}

const label = (c: PiLineReviewCandidate) =>
  [c.code, c.seq, c.name].filter(Boolean).join(' · ') || 'Unnamed product'

export function PiLineReview({ versionNumber, review, busy, failure = null, onConfirm, onCancel }: {
  versionNumber: number
  review: PiLineReviewData
  busy: boolean
  /** Why the last approval with these matches was refused; shown here, not behind the dialog. */
  failure?: string | null
  onConfirm: (lineMap: Record<string, string>) => void
  onCancel: () => void
}) {
  const [choice, setChoice] = useState<Record<string, string>>({})
  const chosen = Object.values(choice).filter(v => v && v !== 'new')
  const duplicate = chosen.length !== new Set(chosen).size
  const complete = review.lines.every(l => !!choice[l.id])

  return (
    <div role="group" aria-label={PI_LINE_REVIEW_TITLE}
      style={{ border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <strong style={{ fontSize: '13px' }}>{PI_LINE_REVIEW_TITLE}</strong>
      <p style={{ margin: 0, fontSize: '12px', color: colors.secondary }}>
        PI V{versionNumber} has {review.lines.length} line{review.lines.length === 1 ? '' : 's'} that cannot be matched by item number.
        Choose the product each one continues — it keeps that product&apos;s code — or mark it as a new product.
      </p>
      {review.lines.map(line => (
        <label key={line.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12.5px' }}>
          <span>
            <strong>{line.name || 'Unnamed line'}</strong>
            {line.seq ? ` · ${line.seq}` : ''}{line.qty != null ? ` · qty ${line.qty}` : ''}
            <span style={{ color: colors.muted }}> — {line.why}</span>
          </span>
          <select className="boe-input" value={choice[line.id] ?? ''} disabled={busy}
            onChange={e => setChoice(c => ({ ...c, [line.id]: e.target.value }))}>
            <option value="" disabled>Choose…</option>
            {review.candidates.map(c => <option key={c.id} value={c.id}>Continues {label(c)}</option>)}
            <option value="new">{PI_LINE_REVIEW_NEW}</option>
          </select>
        </label>
      ))}
      {failure && <p role="alert" data-line-review-failure style={{ margin: 0, fontSize: '12px', color: colors.red }}>{failure}</p>}
      {duplicate && <p role="alert" style={{ margin: 0, fontSize: '12px', color: colors.red }}>A product can be continued by one line only.</p>}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="boe-btn boe-btn-primary" disabled={busy || !complete || duplicate}
          onClick={() => onConfirm(choice)}>
          {busy ? 'Approving…' : 'Approve with this matching'}
        </button>
      </div>
    </div>
  )
}
