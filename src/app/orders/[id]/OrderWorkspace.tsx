'use client'

// THE CONFIRMED ORDER WORKSPACE — the presentational pieces of /orders/[id].
//
// PAGE-OWNED, like OrderPiSections.tsx beside it: nothing else renders these.
// EVERY COMPONENT BELOW IS A FUNCTION OF ITS PROPS. Nothing here fetches,
// writes, authorizes or decides. What needs attention, how the health card
// reads, which action is primary and how much of the trail is shown are
// decided by ../../../lib/orders/orderWorkspace; the page decides which
// controls exist from the capabilities the database resolved. These draw the
// answers.
//
// THE VISUAL LANGUAGE IS THE EXISTING ONE. Cards are the shared PiCard the PI
// sections already use, buttons are the record-header actions the Assets and
// Order Request screens introduced, and every colour is a token.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, MoreHorizontal } from 'lucide-react'
import { PiCard, PiCardHeader } from '@/components/orders/piPreview'
import { colors } from '@/lib/tokens'
import { formatMoney, formatPercent } from '@/lib/finance/piPaymentView'
import { progressWidth, type OrderFinancePosition } from '@/lib/finance/orderFinancePosition'
import {
  activityToggleLabel,
  activityWindow,
  attentionHeading,
  type OrderAttentionItem,
  type OrderImportantDates,
  type OrderSummaryFact,
  type WorkspaceTone,
} from '@/lib/orders/orderWorkspace'

// ── Shared chrome ─────────────────────────────────────────────────────────────

/** The compact header every section on this page uses: one line, no slack. */
export const SECTION_HEADER_STYLE: React.CSSProperties = { padding: '9px 16px' }

// ── Tones ─────────────────────────────────────────────────────────────────────

const TONE: Record<WorkspaceTone, { dot: string; text: string }> = {
  neutral: { dot: colors.muted, text: colors.primary },
  blue:    { dot: colors.blue,  text: colors.primary },
  green:   { dot: colors.green, text: '#2F7A52' },
  amber:   { dot: colors.amber, text: '#9A6A12' },
  red:     { dot: colors.red,   text: '#B42318' },
}

// ── The attention bar ─────────────────────────────────────────────────────────

/**
 * What needs somebody's attention, in one restrained strip: the count, then
 * the conditions separated so each reads on its own. Rendered only when there
 * is something to say; the page hides it otherwise. Amber ground, red text
 * only for the genuinely overdue item — and the words carry the meaning, so
 * nothing here depends on colour alone.
 */
export function OrderAttentionBar({ items }: { items: readonly OrderAttentionItem[] }) {
  if (items.length === 0) return null
  return (
    <section className="order-attention" aria-label={attentionHeading(items.length)}>
      <AlertTriangle size={15} strokeWidth={2.2} aria-hidden="true" className="order-attention-icon" />
      <span className="order-attention-heading">{attentionHeading(items.length)}</span>
      <ul className="order-attention-list">
        {items.map(item => (
          <li key={item.key} className={item.tone === 'red' ? 'order-attention-item order-attention-item--red' : 'order-attention-item'}>
            {item.label}
          </li>
        ))}
      </ul>
    </section>
  )
}

// ── The Order Summary ─────────────────────────────────────────────────────────

export const ORDER_SUMMARY_COMMERCIAL_TITLE = 'Commercial'

/**
 * WHO THIS ORDER IS FOR, AND WHO IS CARRYING IT.
 *
 * The customer, the salesperson, the lead source and the production state —
 * the identity a reader needs the moment they know WHICH Order they are on.
 *
 * NEITHER THE STATUS NOR THE DATES ARE HERE. The status is in the command
 * header, beside the Order number, because it is the second thing anybody
 * looks for and it was previously three lines below the fold of the eye. The
 * dates are in Important Dates, which states every one of them, once.
 *
 * NO MONEY HERE. The commercial figures live in their own column on the right
 * of the lower workspace, BELOW the product list they describe, which is where
 * a reader looks once they know what the Order is. Payment has its own section
 * for the same reason. `commercial` remains as an optional slot so a caller
 * that genuinely wants the two side by side can still do it, but the Order
 * screen deliberately passes nothing.
 */
export function OrderSummary({ facts, commercial }: {
  facts: readonly OrderSummaryFact[]
  /** Optional, and unused by /orders/[id]: the money is its own column. */
  commercial?: React.ReactNode
}) {
  return (
    <section className="order-summary" aria-label="Order summary">
      <dl className="order-summary-facts">
        {facts.map(fact => {
          const tone = TONE[fact.tone]
          const warning = fact.tone === 'amber' || fact.tone === 'red'
          return (
            <div
              key={fact.key}
              className={warning ? `order-fact order-fact--${fact.tone}` : 'order-fact'}
            >
              <dt className="order-fact-label">{fact.label}</dt>
              <dd className="order-fact-value">
                <span className="order-fact-dot" style={{ background: tone.dot }} aria-hidden="true" />
                <span style={{ color: tone.text, fontWeight: warning ? 700 : 600 }}>{fact.value}</span>
                {fact.detail && <span className="order-fact-detail">{fact.detail}</span>}
              </dd>
            </div>
          )
        })}
      </dl>
      {commercial && <div className="order-summary-commercial">{commercial}</div>}
    </section>
  )
}

// ── The status pill ───────────────────────────────────────────────────────────

/**
 * THE STATUS, BESIDE THE ORDER NUMBER — "ORDER BOE-147  IN PRODUCTION".
 *
 * It used to be the first of six equal facts in the band below, which made the
 * one thing every reader opens this page to check indistinguishable from the
 * lead source. It is now a filled pill on the same line as the number, in the
 * status's own colour, at a size that carries across the room.
 *
 * COLOUR IS NOT THE MESSAGE. The word is the message; the tint only agrees
 * with it. Nothing on this page depends on a reader telling amber from red.
 */
export const STATUS_PILL_TONE: Record<WorkspaceTone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: colors.raised,    fg: colors.secondary, border: colors.border },
  blue:    { bg: colors.blueTint,  fg: colors.blue,      border: 'rgba(58,122,190,0.30)' },
  green:   { bg: colors.greenTint, fg: '#2F7A52',        border: 'rgba(69,168,112,0.32)' },
  amber:   { bg: colors.amberTint, fg: '#9A6A12',        border: 'rgba(190,140,40,0.30)' },
  red:     { bg: colors.redTint,   fg: '#B42318',        border: 'rgba(217,79,79,0.32)' },
}

export function OrderStatusPill({ label, tone }: { label: string; tone: WorkspaceTone }) {
  const t = STATUS_PILL_TONE[tone]
  return (
    <span
      className="order-status-pill"
      style={{ background: t.bg, color: t.fg, borderColor: t.border }}
    >
      {label}
    </span>
  )
}

// ── Important dates ───────────────────────────────────────────────────────────

export const IMPORTANT_DATES_TITLE = 'Important Dates'

/**
 * FAST SCANNING, IN ONE BAND.
 *
 * The two dates operations plans against sit large and first; the two audit
 * timestamps follow, muted, on the same row. Both pairs come from
 * orderImportantDates, which is the only thing that decides which is which —
 * this draws the answer and computes no date of its own.
 */
export function OrderImportantDatesSection({ dates }: { dates: OrderImportantDates }) {
  return (
    <section className="order-dates" aria-label={IMPORTANT_DATES_TITLE}>
      <div className="order-dates-head">{IMPORTANT_DATES_TITLE}</div>
      <div className="order-dates-body">
        <dl className="order-dates-primary">
          {dates.primary.map(d => {
            const tone = TONE[d.tone]
            const warning = d.tone === 'amber' || d.tone === 'red'
            return (
              <div key={d.key} className="order-date order-date--primary">
                <dt className="order-date-label">{d.label}</dt>
                <dd className="order-date-value" style={{ color: tone.text, fontWeight: warning ? 700 : 700 }}>
                  {d.value}
                  {d.detail && <span className="order-date-detail" style={{ color: tone.text }}>{d.detail}</span>}
                </dd>
              </div>
            )
          })}
        </dl>
        <dl className="order-dates-secondary">
          {dates.secondary.map(d => (
            <div key={d.key} className="order-date order-date--secondary">
              <dt className="order-date-label">{d.label}</dt>
              <dd className="order-date-value">{d.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

/** The two stored totals, above the breakdown. Both are the Order's own
 *  columns, formatted by the shared money helper and computed nowhere. */
export function OrderCommercialTotals({ productValue, orderValue }: {
  productValue: string
  orderValue: string
}) {
  return (
    <div className="order-commercial-totals">
      <div className="order-commercial-total">
        <dt>Product value</dt>
        <dd>{productValue}</dd>
      </div>
      <div className="order-commercial-total order-commercial-total--lead">
        <dt>Order value</dt>
        <dd>{orderValue}</dd>
      </div>
    </div>
  )
}

// ── The payment section ───────────────────────────────────────────────────────

export const PAYMENT_SECTION_TITLE = 'Payment'

/**
 * THE ONLY PAYMENT FIGURES ON THE PAGE.
 *
 * Six of them, and the records table sits directly underneath in the same
 * section — so a reader who wants the detail scrolls rather than hunting for a
 * second card. Every figure is buildOrderFinancePosition's; nothing here adds,
 * subtracts or percentages money.
 */
export function PaymentSummaryFigures({ finance, loaded }: {
  finance: OrderFinancePosition
  /** False while the payment reads are still in flight. */
  loaded: boolean
}) {
  if (!loaded) {
    return (
      <div className="order-pay-figures" role="status" aria-label="Loading payment summary">
        {[0, 1, 2, 3, 4, 5].map(i => (
          <div key={i} className="order-pay-figure">
            <SkeletonBlock w={78} h={10} />
            <div style={{ marginTop: 7 }}><SkeletonBlock w={104} h={16} /></div>
          </div>
        ))}
      </div>
    )
  }

  const figures: { key: string; label: string; value: string; tone?: WorkspaceTone; hint?: string }[] = [
    { key: 'order_value', label: 'Order value', value: formatMoney(finance.orderValue) },
    { key: 'verified', label: 'Verified', value: formatMoney(finance.verified), tone: 'green', hint: 'confirmed by Finance' },
    {
      key: 'awaiting', label: 'Awaiting verification', value: formatMoney(finance.awaitingVerification),
      tone: finance.counts.awaiting > 0 ? 'amber' : undefined,
      hint: finance.counts.awaiting > 0
        ? `${finance.counts.awaiting} payment${finance.counts.awaiting === 1 ? '' : 's'} with Finance`
        : 'nothing with Finance',
    },
    { key: 'received', label: 'Received', value: formatMoney(finance.received), hint: 'verified + awaiting' },
    {
      key: 'balance', label: 'Balance', value: formatMoney(finance.pendingBalance),
      tone: finance.pendingBalance && finance.pendingBalance !== '0.00' && !finance.fullyPaid ? 'amber' : undefined,
      hint: 'against verified',
    },
    {
      key: 'percent', label: 'Verified %', value: formatPercent(finance.verifiedPercent),
      tone: finance.fullyPaid ? 'green' : undefined,
    },
  ]

  return (
    <>
      <div className="order-pay-figures">
        {figures.map(figure => (
          <div key={figure.key} className="order-pay-figure">
            <div className="order-pay-figure-label">{figure.label}</div>
            <div
              className="order-pay-figure-value"
              style={{ color: figure.tone ? TONE[figure.tone].text : colors.primary }}
            >
              {figure.value}
            </div>
            {figure.hint && <div className="order-pay-figure-hint">{figure.hint}</div>}
          </div>
        ))}
      </div>

      {/* A PIXEL QUANTITY only — clamped to 0–100, never shown as a figure and
          never used in a decision. The percentage above is the truth and is
          deliberately not capped, so an overpaid Order reads over 100%. */}
      {finance.verifiedPercent !== null && (
        <div role="presentation" className="order-pay-bar">
          <div className="order-pay-bar-fill" style={{
            width: `${progressWidth(finance.verifiedPercent)}%`,
            background: finance.fullyPaid ? colors.green : colors.blue,
          }} />
        </div>
      )}

      {/* MONEY THAT IS ONLY PARTLY THIS ORDER'S. A payment may legitimately be
          split across targets, and every figure above counts only this Order's
          share. Said out loud, because a reader comparing the Balance against a
          bank statement needs to know the difference is a split and not a
          missing payment. */}
      {finance.splitPayments.length > 0 && (
        <div className="order-pay-split">
          {finance.splitPayments.length === 1 ? 'One payment below is' : `${finance.splitPayments.length} payments below are`}
          {' '}allocated across more than one record. Once a payment is allocated, the
          allocations decide what each Order receives — so only this Order&apos;s allocated
          share is counted above. The complete allocation history is in each one&apos;s
          Finance record.
        </div>
      )}
    </>
  )
}

// ── The activity trail ────────────────────────────────────────────────────────

/** One event, already worded by the page: the label maps, the amendment lines
 *  and the date formatting all stay where they were. */
export type OrderActivityItem = {
  key: string
  label: string
  detail: string | null
  /** An amendment's before/after pairs; empty for every other event. */
  lines: readonly string[]
  actor: string | null
  when: string
  /** The page's own marker for this event, already coloured by its kind. */
  dot: React.ReactNode
  /** Written by the source PI's trail rather than the Order's own. */
  fromPi: boolean
  /**
   * This entry happened after the reader's last visit — see NEW_SINCE_LABEL.
   * False for every entry when the reader had nothing unread, which is the
   * ordinary case.
   */
  isNew?: boolean
}

export const ACTIVITY_TITLE = 'Activity'
export const ACTIVITY_EMPTY = 'No activity recorded yet.'

/**
 * WHAT CHANGED WHILE THEY WERE AWAY, marked in place.
 *
 * NOT A MODAL. Opening an Order is Product Orders → click → Order Detail, with
 * nothing in between: an "OK" somebody has to dismiss before they can read the
 * page is a toll on the most common action in the module. The trail already
 * holds the change history, so the unseen entries are simply marked where they
 * already are, and a reader who does not care scrolls past them.
 */
export const NEW_SINCE_LABEL = 'New since your last visit'

/**
 * The complete trail, newest first, showing the latest five until asked for
 * the rest. Every entry, timestamp and actor is exactly what the page handed
 * over; this only decides how many are on screen at once.
 */
export function OrderActivityList({ items }: { items: readonly OrderActivityItem[] }) {
  const [expanded, setExpanded] = useState(false)
  const { shown, hidden } = activityWindow(items.length, expanded)
  const visible = items.slice(0, shown)
  const collapsible = items.length > shown || expanded
  // Counted over the WHOLE trail, not the visible window: a reader with six
  // unseen entries and five on screen must not be told there are five.
  const newCount = items.filter(i => i.isNew).length

  return (
    <PiCard>
      <PiCardHeader
        title={ACTIVITY_TITLE}
        style={SECTION_HEADER_STYLE}
        right={items.length > 0 ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', whiteSpace: 'nowrap' }}>
            {newCount > 0 && (
              <span className="order-activity-new">
                {newCount} {NEW_SINCE_LABEL.toLowerCase()}
              </span>
            )}
            <span style={{ fontSize: '12px', color: colors.muted }}>
              {hidden > 0 ? `Latest ${shown} of ${items.length}` : `${items.length} event${items.length === 1 ? '' : 's'}`}
            </span>
          </span>
        ) : undefined}
      />
      <div style={{ padding: '12px 16px 12px' }}>
        {items.length === 0 ? (
          <div style={{ color: colors.muted, fontSize: '13px' }}>{ACTIVITY_EMPTY}</div>
        ) : (
          <ol id="order-activity-list" className="order-activity">
            {visible.map((entry, idx) => (
              <li
                key={entry.key}
                className={entry.isNew ? 'order-activity-item order-activity-item--new' : 'order-activity-item'}
              >
                <div className="order-activity-rail">
                  {entry.dot}
                  {idx < visible.length - 1 && <span className="order-activity-line" aria-hidden="true" />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>
                    {entry.label}
                    {entry.fromPi && (
                      <span style={{ fontSize: '10px', fontWeight: 700, color: colors.muted, marginLeft: '6px' }}>PI</span>
                    )}
                    {/* The WORDS say it, not the tint: a reader who cannot see
                        the background still reads "New". */}
                    {entry.isNew && (
                      <span className="order-activity-new" title={NEW_SINCE_LABEL}>New</span>
                    )}
                  </div>
                  {entry.detail && (
                    <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '1px' }}>{entry.detail}</div>
                  )}
                  {entry.lines.length > 0 && (
                    <ul style={{ margin: '3px 0 0', paddingLeft: '16px', fontSize: '12px', color: colors.secondary, lineHeight: 1.6 }}>
                      {entry.lines.map(line => <li key={line}>{line}</li>)}
                    </ul>
                  )}
                  <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
                    {entry.actor ? `${entry.actor} · ` : ''}{entry.when}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
            aria-controls="order-activity-list"
            className="order-inline-link"
            style={{ marginTop: '8px' }}
          >
            {activityToggleLabel(items.length, expanded)}
            <ChevronDown
              size={13}
              strokeWidth={2.2}
              aria-hidden="true"
              style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}
            />
          </button>
        )}
      </div>
    </PiCard>
  )
}

// ── More actions ──────────────────────────────────────────────────────────────

export type MoreActionItem<K extends string> = {
  key: K
  label: string
  disabled?: boolean
  title?: string
  danger?: boolean
}

/**
 * The overflow menu for the rare paths. Keyboard behaviour is the WAI-ARIA
 * menu-button pattern: click or ArrowDown opens, focus lands on the first
 * enabled item, Up/Down/Home/End move, Escape closes and returns focus to the
 * trigger, Tab or an outside click closes. Renders nothing when there is no
 * item — an empty trigger would be a control that does nothing.
 */
export function MoreActionsMenu<K extends string>({ items, onSelect }: {
  items: readonly MoreActionItem<K>[]
  onSelect: (key: K) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef    = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs   = useRef<(HTMLButtonElement | null)[]>([])

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true) }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('touchstart', onPointer)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('touchstart', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const first = itemRefs.current.findIndex(el => el && !el.disabled)
    if (first >= 0) itemRefs.current[first]?.focus()
  }, [open])

  if (items.length === 0) return null

  const focusItem = (index: number) => {
    const bounded = (index + items.length) % items.length
    itemRefs.current[bounded]?.focus()
  }

  const onMenuKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowDown')      { e.preventDefault(); focusItem(index + 1) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); focusItem(index - 1) }
    else if (e.key === 'Home')      { e.preventDefault(); focusItem(0) }
    else if (e.key === 'End')       { e.preventDefault(); focusItem(items.length - 1) }
    else if (e.key === 'Tab')       { setOpen(false) }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true) }
        }}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="boe-record-action boe-record-action--icon"
        style={{ background: open ? colors.float : undefined }}
      >
        <MoreHorizontal size={15} strokeWidth={2} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="More actions"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100,
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: '9px', boxShadow: '0 8px 24px rgba(16,24,40,0.14)',
            minWidth: '224px', padding: '4px 0', overflow: 'hidden',
          }}
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              ref={el => { itemRefs.current[index] = el }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              onClick={() => { triggerRef.current?.focus(); setOpen(false); onSelect(item.key) }}
              onKeyDown={e => onMenuKeyDown(e, index)}
              className="order-menu-item"
              style={{ color: item.danger ? '#B42318' : colors.secondary }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Loading states ────────────────────────────────────────────────────────────

const BLOCK = '#E8EBF0'

export function SkeletonBlock({ w, h, radius = 4 }: { w: string | number; h: number; radius?: number }) {
  return <div style={{ width: w, height: h, borderRadius: radius, background: BLOCK, flexShrink: 0, maxWidth: '100%' }} />
}

/** A section that is still on its way: a card in the shape of a short table. */
export function SectionSkeleton({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} style={{
      background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden',
    }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${colors.border}` }}>
        <SkeletonBlock w={140} h={12} />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '11px 16px',
          borderBottom: i < rows - 1 ? '1px solid #F0F2F5' : 'none',
        }}>
          <SkeletonBlock w={36} h={36} radius={6} />
          <SkeletonBlock w="34%" h={11} />
          <SkeletonBlock w="14%" h={11} />
          <SkeletonBlock w="18%" h={11} />
        </div>
      ))}
    </div>
  )
}

/**
 * The whole workspace before the Order row has landed: the command header, the
 * main column and the health rail, each in the shape of what is about to
 * appear, so the shell does not jump when the data arrives. Static blocks, no
 * animation — the same treatment the Control Center uses.
 */
export function OrderDetailSkeleton() {
  return (
    <div className="order-detail-page" role="status" aria-busy="true" aria-label="Loading order">
      <div style={{ marginBottom: 10 }}><SkeletonBlock w={54} h={12} /></div>
      <div className="order-command-header" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SkeletonBlock w={160} h={26} />
          <SkeletonBlock w={200} h={14} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <SkeletonBlock w={110} h={34} radius={8} />
          <SkeletonBlock w={100} h={34} radius={8} />
          <SkeletonBlock w={150} h={34} radius={8} />
        </div>
      </div>
      <section className="order-summary">
        <div className="order-summary-facts">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className="order-fact">
              <SkeletonBlock w={72} h={10} />
              <div style={{ marginTop: 6 }}><SkeletonBlock w={132} h={13} /></div>
            </div>
          ))}
        </div>
        <div className="order-summary-commercial">
          <SkeletonBlock w="60%" h={14} />
          <div style={{ marginTop: 10 }}><SkeletonBlock w="80%" h={20} /></div>
          <div style={{ marginTop: 16 }}><SkeletonBlock w="100%" h={120} /></div>
        </div>
      </section>
      <div className="order-products">
        <SectionSkeleton rows={4} label="Loading products" />
      </div>
      <SectionSkeleton rows={2} label="Loading payment" />
    </div>
  )
}
