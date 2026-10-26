'use client'

// THE CONFIRMED ORDER PAGE'S TOP BAND — the status strip and the dates timeline.
//
// PAGE-OWNED PRESENTATION, like OrderWorkspace.tsx beside it. Every component
// is a function of its props: nothing here fetches, writes or authorizes. The
// words come from the page's own builders (production alignment, status,
// sample type); the day arithmetic is lib/orders/orderDatesTimeline.

import { FlaskConical, Package } from 'lucide-react'
import { STATUS_PILL_TONE } from './OrderWorkspace'
import {
  dueCountdownLabel,
  uploadGapLabel,
  type OrderDatesTimeline,
} from '@/lib/orders/orderDatesTimeline'
import type { WorkspaceTone } from '@/lib/orders/orderWorkspace'

export const ERP_STAGE_LABEL = 'ERP'
export const PRODUCTION_STAGE_LABEL = 'Production'
export const ORDER_TYPE_STAGE_LABEL = 'Order type'
export const SAMPLE_ORDER_BADGE = 'Sample order'
export const FULL_ORDER_BADGE = 'Full order'

function StageBadge({ label, tone }: { label: string; tone: WorkspaceTone }) {
  const t = STATUS_PILL_TONE[tone]
  return (
    <span className="order-stage-badge" style={{ background: t.bg, color: t.fg, borderColor: t.border }}>
      {label}
    </span>
  )
}

/**
 * THE TWO STAGES OF AN ORDER, AND WHAT KIND OF ORDER IT IS.
 *
 * ERP: aligned or not (orders.production_alignment). Production: the order's
 * own status (running, hold, cancelled …); changed from Change Status in the
 * header, never from here. Order type: a sample order is drawn in red with a
 * pulsing dot so nobody ships it as a production order by mistake; a full order
 * is quiet. The pulse stops for readers who ask for reduced motion.
 */
export function OrderStatusStrip({ erp, production, isSample, sampleLabel, fullNote = null }: {
  erp: { label: string; tone: WorkspaceTone; line: string | null }
  production: { label: string; tone: WorkspaceTone }
  isSample: boolean
  /** The exact sample wording (sampling needed / sample order only), shown as a tooltip. */
  sampleLabel: string | null
  /** A short note beside "Full order" (for example "sampling first"). */
  fullNote?: string | null
}) {
  return (
    <section className="order-stages" aria-label="Order stages">
      <div className="order-stage">
        <span className="order-stage-label">{ERP_STAGE_LABEL}</span>
        <StageBadge label={erp.label} tone={erp.tone} />
        {erp.line && <span className="order-stage-line">{erp.line}</span>}
      </div>
      <div className="order-stage">
        <span className="order-stage-label">{PRODUCTION_STAGE_LABEL}</span>
        <StageBadge label={production.label} tone={production.tone} />
      </div>
      <div className={`order-stage${isSample ? ' order-stage--sample' : ''}`} title={sampleLabel ?? undefined}>
        <span className="order-stage-label">{ORDER_TYPE_STAGE_LABEL}</span>
        {isSample ? (
          <span className="order-stage-sample">
            <span className="order-sample-dot" aria-hidden="true" />
            <FlaskConical size={14} strokeWidth={2.2} aria-hidden="true" />
            {SAMPLE_ORDER_BADGE}
          </span>
        ) : (
          <span className="order-stage-full">
            <Package size={14} strokeWidth={2} aria-hidden="true" />
            {FULL_ORDER_BADGE}{fullNote ? ` · ${fullNote}` : ''}
          </span>
        )}
      </div>
    </section>
  )
}

type DateStop = { key: string; label: string; value: string | null; tone: 'done' | 'flag' | 'next' | 'waiting' }

/**
 * CONFIRMED -> PI UPLOADED -> APPROVED -> DUE, as a vertical timeline.
 *
 * The upload is flagged in red when it came more than a week after the confirm
 * date (the usual sign of a mistyped confirm date), and a bar under the stops
 * shows how far today is between the upload and the due date. A date that is
 * not recorded is said so quietly; an approval that has not happened says
 * "Awaiting".
 */
export function OrderDatesTimelineCard({ title, confirm, upload, approved, due, timeline, overdue }: {
  title: string
  confirm: string | null
  upload: string | null
  approved: string | null
  due: string | null
  timeline: OrderDatesTimeline
  overdue: boolean
}) {
  const stops: DateStop[] = [
    { key: 'confirm', label: 'Confirmed', value: confirm, tone: 'done' },
    { key: 'upload', label: 'PI uploaded by salesperson', value: upload, tone: timeline.gapFlagged ? 'flag' : 'done' },
    { key: 'approved', label: 'Approved by admin team', value: approved, tone: approved ? 'done' : 'waiting' },
    { key: 'due', label: 'Due date', value: due, tone: 'next' },
  ]
  return (
    <section className="order-sum-group" aria-label={title}>
      <h3 className="order-sum-group-head">{title}</h3>
      <ol className="order-timeline">
        {stops.map(s => (
          <li key={s.key} className={`order-timeline-stop order-timeline-stop--${s.tone}`}>
            <div className="order-timeline-date">
              {s.value ?? (s.key === 'approved' ? 'Awaiting' : 'Not available')}
              {s.key === 'upload' && timeline.gapFlagged && timeline.uploadGapDays !== null && (
                <span className="order-timeline-flag" role="note">{uploadGapLabel(timeline.uploadGapDays)}</span>
              )}
              {s.key === 'due' && overdue && <span className="order-timeline-flag">Overdue</span>}
            </div>
            <div className="order-timeline-label">{s.label}</div>
          </li>
        ))}
      </ol>
      {timeline.progressPercent !== null && (
        <div className="order-timeline-bar" aria-hidden="true">
          <i style={{ width: `${Math.max(timeline.progressPercent, 2)}%` }} />
        </div>
      )}
      {(timeline.daysSinceUpload !== null || timeline.daysToDue !== null) && (
        <div className="order-timeline-foot">
          <span>
            {timeline.daysSinceUpload === null ? '' : timeline.daysSinceUpload === 0 ? 'Uploaded today' : `Uploaded ${timeline.daysSinceUpload} day${timeline.daysSinceUpload === 1 ? '' : 's'} ago`}
          </span>
          <strong className={timeline.daysToDue !== null && timeline.daysToDue < 0 ? 'is-late' : undefined}>
            {timeline.daysToDue === null ? '' : dueCountdownLabel(timeline.daysToDue)}
          </strong>
        </div>
      )}
    </section>
  )
}

export const GENERAL_TERMS_TITLE = 'General terms'
export const GENERAL_TERMS_EMPTY = 'No general terms are recorded on the PI.'

/**
 * WHAT SALES FILLED ON THE PI, as a card of its own on the Order (it used to be
 * a block inside the Documents card). The rows are the shared builder's:
 * fabric responsibility, billing percentage, the middleman answer, billing and
 * payment terms. The middleman row already says "Restricted" to a reader who may
 * not see the commission; nothing is resolved differently here.
 */
export function OrderInternalDetailsCard({ title, tag, rows }: {
  title: string
  tag: string
  rows: readonly { key: string; label: string; value: string; muted: boolean }[]
}) {
  return (
    <section className="order-info-card" aria-label={title}>
      <h3 className="order-info-card-head">
        <span>{title}</span>
        <span className="order-info-card-tag">{tag}</span>
      </h3>
      <dl className="order-info-rows">
        {rows.map(r => (
          <div key={r.key} className="order-info-row">
            <dt>{r.label}</dt>
            <dd className={r.muted ? 'is-muted' : undefined}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** The PI's own terms note, one point to a line, word for word. */
export function OrderGeneralTermsCard({ points }: { points: readonly string[] }) {
  return (
    <section className="order-info-card" aria-label={GENERAL_TERMS_TITLE}>
      <h3 className="order-info-card-head"><span>{GENERAL_TERMS_TITLE}</span></h3>
      {points.length === 0 ? (
        <p className="order-info-empty">{GENERAL_TERMS_EMPTY}</p>
      ) : (
        <ul className="order-info-terms">
          {points.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
    </section>
  )
}
