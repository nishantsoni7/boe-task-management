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
import { AlertTriangle, ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react'
import { PiCard, PiCardHeader } from '@/components/orders/piPreview'
import { colors } from '@/lib/tokens'
import { formatMoney, formatPercent } from '@/lib/finance/piPaymentView'
import { progressWidth, type OrderFinancePosition } from '@/lib/finance/orderFinancePosition'
import {
  activityToggleLabel,
  activityWindow,
  attentionHeading,
  type OrderAttentionItem,
  type OrderHealthRow,
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

/** A small status chip: tinted ground, words always. */
export function ToneBadge({ tone, children, title }: {
  tone: WorkspaceTone
  children: React.ReactNode
  title?: string
}) {
  const bg = tone === 'green' ? colors.greenTint
    : tone === 'amber' ? colors.amberTint
    : tone === 'red' ? colors.redTint
    : tone === 'blue' ? colors.blueTint
    : colors.raised
  const border = tone === 'green' ? 'rgba(69,168,112,0.3)'
    : tone === 'amber' ? 'rgba(190,140,40,0.28)'
    : tone === 'red' ? 'rgba(217,79,79,0.3)'
    : tone === 'blue' ? 'rgba(85,133,232,0.3)'
    : colors.border
  const text = tone === 'blue' ? '#2F5BB7' : tone === 'neutral' ? colors.secondary : TONE[tone].text
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '3px 9px', borderRadius: '6px',
        fontSize: '11.5px', fontWeight: 700, whiteSpace: 'nowrap', lineHeight: 1.3,
        background: bg, color: text, border: `1px solid ${border}`,
      }}
    >
      {children}
    </span>
  )
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

// ── The health card ───────────────────────────────────────────────────────────

export const ORDER_HEALTH_TITLE = 'Order health'

/**
 * The page's operational summary: six facts, label quiet on the left, value
 * carrying the weight on the right. A warning row (amber, red) is marked by a
 * class as well as by its words, so it stands out without every value being
 * coloured.
 */
export function OrderHealthCard({ rows }: { rows: readonly OrderHealthRow[] }) {
  return (
    <PiCard>
      <PiCardHeader title={ORDER_HEALTH_TITLE} style={SECTION_HEADER_STYLE} />
      <dl className="order-health">
        {rows.map(row => {
          const tone = TONE[row.tone]
          const warning = row.tone === 'amber' || row.tone === 'red'
          return (
            <div key={row.key} className={warning ? `order-health-row order-health-row--${row.tone}` : 'order-health-row'}>
              <dt className="order-health-label">{row.label}</dt>
              <dd className="order-health-value">
                <span className="order-health-dot" style={{ background: tone.dot }} aria-hidden="true" />
                <span className="order-health-text" style={{ color: tone.text, fontWeight: warning ? 700 : 600 }}>
                  {row.value}
                </span>
                {row.detail && <span className="order-health-detail">{row.detail}</span>}
              </dd>
            </div>
          )
        })}
      </dl>
    </PiCard>
  )
}

// ── The payment position ──────────────────────────────────────────────────────

export const PAYMENT_POSITION_TITLE = 'Payment position'
export const VIEW_PAYMENT_DETAILS_LABEL = 'View payment details'

/**
 * The Order's finance position, compressed to the sidebar: the verified money
 * first, the percentage beside its bar, what it is measured against, then the
 * three lines that complete the picture. Every figure is the shared builder's;
 * nothing here adds money. The full per-payment table stays in the main
 * column behind "View payment details".
 */
export function PaymentPositionCard({ finance, loaded, onViewDetails }: {
  finance: OrderFinancePosition
  /** False while the payment reads are still in flight. */
  loaded: boolean
  onViewDetails: () => void
}) {
  const hasValue = finance.orderValue !== null
  const leadColor = finance.fullyPaid ? '#2F7A52' : colors.primary
  return (
    <PiCard>
      <PiCardHeader
        title={PAYMENT_POSITION_TITLE}
        style={SECTION_HEADER_STYLE}
        right={loaded ? (
          <span style={{ fontSize: '11.5px', color: colors.muted, whiteSpace: 'nowrap' }}>
            {finance.counts.total === 0 ? 'No payments' : `${finance.counts.total} payment${finance.counts.total === 1 ? '' : 's'}`}
          </span>
        ) : undefined}
      />
      {!loaded ? (
        <div style={{ padding: '14px 16px' }} role="status" aria-label="Loading payment position">
          <SkeletonBlock w="55%" h={22} />
          <div style={{ marginTop: 8 }}><SkeletonBlock w="40%" h={11} /></div>
          <div style={{ marginTop: 12 }}><SkeletonBlock w="100%" h={5} /></div>
          <div style={{ marginTop: 12 }}><SkeletonBlock w="80%" h={11} /></div>
        </div>
      ) : (
        <div className="order-pay">
          <div className="order-pay-amount" style={{ color: leadColor }}>{formatMoney(finance.verified)}</div>
          <div className="order-pay-amount-label">Verified</div>

          {/* A PIXEL QUANTITY only — clamped to 0–100 and never used in a
              decision. The figure beside it is the truth and is not capped. */}
          {finance.verifiedPercent !== null && (
            <div className="order-pay-progress">
              <div role="presentation" className="order-pay-bar">
                <div className="order-pay-bar-fill" style={{
                  width: `${progressWidth(finance.verifiedPercent)}%`,
                  background: finance.fullyPaid ? colors.green : colors.blue,
                }} />
              </div>
              <div className="order-pay-percent" style={{ color: leadColor }}>{formatPercent(finance.verifiedPercent)}</div>
            </div>
          )}

          <div className="order-pay-of">
            {hasValue ? <>of {formatMoney(finance.orderValue)} order value</> : 'Order value not recorded'}
          </div>

          <dl className="order-money-lines">
            {hasValue && (
              <div className="order-money-line">
                <dt>Remaining</dt>
                <dd style={{ color: finance.fullyPaid ? '#2F7A52' : colors.primary }}>
                  {formatMoney(finance.pendingBalance)}
                </dd>
              </div>
            )}
            <div className="order-money-line">
              <dt>Awaiting verification</dt>
              <dd style={{ color: finance.counts.awaiting > 0 ? '#9A6A12' : colors.secondary }}>
                {formatMoney(finance.awaitingVerification)}
                {finance.counts.awaiting > 0 && (
                  <span className="order-money-note">{finance.counts.awaiting} with Finance</span>
                )}
              </dd>
            </div>
            {/* Received is verified + awaiting — a distinct figure whenever
                money is waiting on Finance, and the same as Verified when
                nothing is. Kept because it is the honest answer to "what has
                come in". */}
            <div className="order-money-line">
              <dt>Received</dt>
              <dd style={{ color: colors.secondary }}>{formatMoney(finance.received)}</dd>
            </div>
          </dl>

          {finance.splitPayments.length > 0 && (
            <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.45 }}>
              {finance.splitPayments.length === 1 ? 'One payment is' : `${finance.splitPayments.length} payments are`}
              {' '}allocated across more than one record; only this Order&apos;s share is counted.
            </div>
          )}

          <button type="button" onClick={onViewDetails} className="order-inline-link">
            {VIEW_PAYMENT_DETAILS_LABEL}
            <ChevronRight size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      )}
    </PiCard>
  )
}

// ── A collapsible section header ──────────────────────────────────────────────

export function CollapsibleHeader({ title, meta, open, onToggle, controls }: {
  title: string
  meta?: React.ReactNode
  open: boolean
  onToggle: () => void
  /** The id of the body the trigger controls. */
  controls: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="order-collapsible-trigger"
    >
      <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{title}</span>
      {meta && <span style={{ fontSize: '12px', color: colors.muted, fontWeight: 500 }}>{meta}</span>}
      <ChevronDown
        size={15}
        strokeWidth={2}
        aria-hidden="true"
        style={{ marginLeft: 'auto', color: colors.muted, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
      />
    </button>
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
}

export const ACTIVITY_TITLE = 'Activity'
export const ACTIVITY_EMPTY = 'No activity recorded yet.'

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

  return (
    <PiCard>
      <PiCardHeader
        title={ACTIVITY_TITLE}
        style={SECTION_HEADER_STYLE}
        right={items.length > 0 ? (
          <span style={{ fontSize: '12px', color: colors.muted, whiteSpace: 'nowrap' }}>
            {hidden > 0 ? `Latest ${shown} of ${items.length}` : `${items.length} event${items.length === 1 ? '' : 's'}`}
          </span>
        ) : undefined}
      />
      <div style={{ padding: '12px 16px 12px' }}>
        {items.length === 0 ? (
          <div style={{ color: colors.muted, fontSize: '13px' }}>{ACTIVITY_EMPTY}</div>
        ) : (
          <ol id="order-activity-list" className="order-activity">
            {visible.map((entry, idx) => (
              <li key={entry.key} className="order-activity-item">
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
          <div style={{ display: 'flex', gap: 8 }}>
            <SkeletonBlock w={70} h={22} radius={6} />
            <SkeletonBlock w={130} h={22} radius={6} />
          </div>
          <SkeletonBlock w={300} h={11} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <SkeletonBlock w={110} h={34} radius={8} />
          <SkeletonBlock w={100} h={34} radius={8} />
          <SkeletonBlock w={150} h={34} radius={8} />
        </div>
      </div>
      <div className="order-workspace">
        <div className="order-workspace-main">
          <SectionSkeleton rows={4} label="Loading products" />
          <SectionSkeleton rows={2} label="Loading documents" />
        </div>
        <div className="order-workspace-aside">
          <div className="order-workspace-aside-inner">
            <SectionSkeleton rows={5} label="Loading order health" />
            <SectionSkeleton rows={2} label="Loading payment position" />
          </div>
        </div>
      </div>
    </div>
  )
}
