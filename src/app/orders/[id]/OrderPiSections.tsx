'use client'

// THE APPROVED PI, AS THE CONFIRMED ORDER SHOWS IT.
//
// PAGE-OWNED, for the same reason ../drafts/[submissionId]/piDetailSections.tsx
// is: nothing else renders these. What IS shared with the PI screens — the card,
// the card header, the product table head, the thumbnails, the customization
// cell, the commercial summary, the image viewer, the client dialog — is
// imported from where it already lives and is untouched.
//
// EVERY COMPONENT BELOW IS A FUNCTION OF ITS PROPS. Nothing here fetches,
// writes, authorizes or decides. What may be SEEN is decided by
// can_view_order_submission_via_order (migration 20260924000000); what a figure
// MEANS is decided by the shared PI helpers; which figures are printed at all is
// decided by ../../../lib/orders/orderPiHandoff. These draw the answers.
//
// THE VISUAL LANGUAGE IS THE APPROVED ONE. Every class name here is a
// `.pi-detail-*` or `.pi-*` class already in globals.css, rendered by the
// approved PI screen. This adds no new design; it puts the agreed treatment on
// a second screen so the two cannot look like two different products.

import { ChevronRight, Download, FileSpreadsheet } from 'lucide-react'
import { MultilineText } from '@/components/ui/MultilineText'
import {
  PiCard,
  PiCardHeader,
  PiCustomizationCell,
  PiFieldRow,
  PiProductTableHead,
  PiProductThumbnail,
  PI_THUMBNAIL_SIZE,
  type PiThumbnailProps,
} from '@/components/orders/piPreview'
import { colors } from '@/lib/tokens'
import { formatInr, orDash } from '@/lib/pi/previewView'
import type { PersistedProduct } from '@/lib/orders/draftsView'
import {
  BILLING_LABEL,
  BILLING_VALUE_LABEL,
  type BillingSummary,
  type ClientDetails,
  type DateSummary,
  type SummaryFigure,
} from '../drafts/[submissionId]/piDetailView'
import {
  ORDER_PI_UNAVAILABLE_BODY,
  ORDER_PI_UNAVAILABLE_TITLE,
  ORDER_PI_WORKBOOK_LABEL,
} from '@/lib/orders/orderPiHandoff'

/** The one heading the handoff sits under, said once so the card and its tests
 *  cannot word it differently. */
export const ORDER_PI_SECTION_TITLE = 'Approved PI'

/** The heading of the product table on this screen. Deliberately the PI
 *  screen's own word, because it is the PI's own table. */
export const ORDER_PI_PRODUCTS_TITLE = 'Products'

// ── The unavailable state ─────────────────────────────────────────────────────

/**
 * THE RESTRAINED ABSENCE.
 *
 * An Order says it came from a PI and the PI could not be read. In practice that
 * is a permission answer, and the honest thing is to say the detail is not
 * available WITHOUT elaborating on why, without a retry that will not help, and
 * — the part that actually matters — without a single figure.
 *
 * NO ZERO, ANYWHERE. A card that fell back to ₹0 for a total it could not read
 * would be a number somebody might act on. There are no numbers here at all.
 *
 * NOT AN ERROR, EITHER. The Order above it is perfectly readable and every
 * Order-owned section still works; this is one card reporting one absence.
 */
export function OrderPiUnavailable() {
  return (
    <PiCard>
      <PiCardHeader title={ORDER_PI_UNAVAILABLE_TITLE} />
      <div style={{ padding: '16px 18px', fontSize: '12.5px', color: colors.secondary, lineHeight: 1.55 }}>
        {ORDER_PI_UNAVAILABLE_BODY}
      </div>
    </PiCard>
  )
}

// ── The summary card ──────────────────────────────────────────────────────────

/**
 * WHO THE CLIENT IS, WHEN IT MOVES, AND WHAT IT IS WORTH BEFORE TAX.
 *
 * The same two-column arrangement the approved PI card uses — everything ABOUT
 * the order on the left, the money on the right — and the same classes, so the
 * two screens are visibly one system.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 *   * NO PAYMENT BLOCK. The Order's own Payment Summary above already states
 *     the verified position — received, pending, completion — computed from the
 *     Order's allocations by receivedFromPayments, which counts the two verified
 *     statuses and no others. A second payment surface here would be the same
 *     question answered twice, and the second answer would be the PI's, which
 *     stopped being the authority the moment the money moved onto the Order.
 *   * NO PRODUCT VALUE when the Order's own summary strip states it. That
 *     decision is handoffFigures', not this component's; whatever it hands over
 *     is printed.
 *   * NO ORDER NUMBER, NO STATUS, NO OWNERSHIP BAND. All three belong to the
 *     Order and are already at the top of the page.
 */
export function OrderPiSummaryCard({
  client, onOpenClient, dates, figures, billing,
  workbookName, onDownloadWorkbook, downloading, downloadError,
}: {
  client: ClientDetails
  onOpenClient: () => void
  dates: readonly DateSummary[]
  /** Whatever handoffFigures kept. May be empty, and that is a valid card. */
  figures: readonly SummaryFigure[]
  billing: BillingSummary
  /** Null when the PI names no workbook, or when this viewer may not have it. */
  workbookName: string | null
  onDownloadWorkbook: () => void
  downloading: boolean
  /** One quiet line. A refused download says so; it never throws the page. */
  downloadError: string | null
}) {
  return (
    <PiCard>
      <PiCardHeader title={ORDER_PI_SECTION_TITLE} />
      <div className="pi-detail-summary">

        <div className="pi-detail-summary-left">

          {/* THE NAME IS THE CONTROL, and it still looks like the name — the
              approved treatment, unchanged. The contact number and both
              addresses are reference material and live in the dialog behind
              it, exactly as they do on the PI screen. */}
          <div className="pi-detail-summary-party">
            <button
              type="button"
              onClick={onOpenClient}
              className="pi-detail-summary-client"
              aria-haspopup="dialog"
              title="Contact number, billing and shipping details"
            >
              <MultilineText style={{
                fontSize: '16px', fontWeight: 650, color: colors.primary, margin: 0, lineHeight: 1.25,
              }}>
                {client.name}
              </MultilineText>
              <ChevronRight size={15} strokeWidth={2.2} className="pi-detail-summary-client-more" />
            </button>
          </div>

          {/* ONE SCHEDULE BAND, both dates, the PI's own. The Order's strip
              above states the Order's copies of these; what this band adds is
              the COMMITMENT under an absent due date — prose the Order has
              nowhere to carry, and the only thing the document said about when
              it is owed. */}
          <section className="pi-detail-summary-schedule">
            {dates.flatMap((date, i) => [
              i > 0
                ? <div key={`${date.key}-rule`} className="pi-detail-summary-sched-rule" role="presentation" />
                : null,
              (
                <div key={date.key} className="pi-detail-summary-sched-cell">
                  <div className="pi-detail-summary-metric-label">
                    {date.label}
                    {date.key === 'due' && (
                      <span className="pi-detail-summary-due-dot" aria-hidden="true" />
                    )}
                  </div>
                  {date.value ? (
                    <div className={date.key === 'due'
                      ? 'pi-detail-summary-metric-value pi-detail-summary-due-value'
                      : 'pi-detail-summary-metric-value'}>
                      {date.value}
                    </div>
                  ) : (
                    <div className="pi-detail-summary-metric-absent">{date.absent}</div>
                  )}
                  {date.note && <div className="pi-detail-summary-metric-note">{date.note}</div>}
                </div>
              ),
            ])}
          </section>

          {/* ── The workbook the whole thing was agreed on ──
              THE ONE CONTROL ON THIS CARD. It is at the foot of the left column
              for the same reason ownership is on the PI card: it is the last
              thing the document says about itself.

              THE BUCKET STAYS PRIVATE. This button asks the page for a
              short-lived signed URL through the reader's OWN session, so the
              storage policy decides again, per object, at the moment of the
              click. There is no public URL to build and none is built. A
              refusal produces the quiet line below and no download. */}
          {workbookName && (
            <>
              <div className="pi-detail-summary-hr pi-detail-summary-hr-foot" role="presentation" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start' }}>
                <div className="pi-detail-summary-metric-label">{ORDER_PI_WORKBOOK_LABEL}</div>
                <button
                  type="button"
                  onClick={onDownloadWorkbook}
                  disabled={downloading}
                  className="boe-btn boe-btn-ghost"
                  style={{
                    padding: '6px 12px', fontSize: '12px', fontWeight: 600,
                    display: 'inline-flex', alignItems: 'center', gap: '7px',
                    maxWidth: '100%', minWidth: 0,
                    opacity: downloading ? 0.6 : 1,
                  }}
                  title={workbookName}
                >
                  {downloading
                    ? <FileSpreadsheet size={13} strokeWidth={1.9} style={{ flexShrink: 0 }} />
                    : <Download size={13} strokeWidth={2} style={{ flexShrink: 0 }} />}
                  <span className="pi-detail-summary-file-name">
                    {downloading ? 'Preparing…' : workbookName}
                  </span>
                </button>
                {downloadError && (
                  <div style={{ fontSize: '11.5px', color: colors.red, lineHeight: 1.45 }}>
                    {downloadError}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── The commercial surface ──
            The pre-GST total and the billing declaration measured against it.
            Label over value, in the approved figure treatment. */}
        <section className="pi-detail-summary-paycard">
          <div className="pi-detail-summary-paybody">
            <div className="pi-detail-summary-values">
              {figures.map(figure => (
                <div key={figure.key} className="pi-detail-summary-value-row">
                  <div className="pi-detail-summary-metric-label">{figure.label}</div>
                  {/* MISSING IS NOT ZERO. A PI whose workbook never stated a
                      pre-tax total shows the card's own missing treatment. */}
                  <div className={figure.kind === 'missing'
                    ? 'pi-detail-summary-metric-absent'
                    : 'pi-detail-summary-money'}>
                    {figure.value}
                  </div>
                </div>
              ))}

              {/* ── The billing declaration ──
                  READ-ONLY HERE, and that is not an omission. A percentage is
                  declared on the PI while it can still be changed; by the time
                  an Order exists the PI is approved and
                  set_order_submission_billing_percentage refuses the write. An
                  Edit control would offer a door the database has closed. */}
              <div className="pi-detail-summary-value-row pi-detail-summary-billing">
                <div className="pi-detail-summary-billing-head">
                  <span className="pi-detail-summary-metric-label">{BILLING_LABEL}</span>
                </div>
                {/* UNDECLARED IS MUTED, and says so in words. Not 0%, not an em
                    dash — nobody decided. */}
                <div className={billing.declared
                  ? 'pi-detail-summary-money'
                  : 'pi-detail-summary-metric-absent'}>
                  {billing.percent}
                </div>
              </div>

              {/* Only where there is a percentage to measure. A missing pre-GST
                  total shows the missing treatment, never ₹0. */}
              {billing.declared && (
                <div className="pi-detail-summary-value-row">
                  <div className="pi-detail-summary-metric-label">{BILLING_VALUE_LABEL}</div>
                  <div className={billing.amountMissing
                    ? 'pi-detail-summary-metric-absent'
                    : 'pi-detail-summary-money'}>
                    {billing.amount}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

      </div>
    </PiCard>
  )
}

// ── The products ──────────────────────────────────────────────────────────────

/**
 * The PI's product lines and their photographs.
 *
 * THE IDENTICAL TABLE the import preview and the saved-PI screen render — the
 * same head, the same thumbnails, the same customization cell, the same
 * formatting of every figure. A product line must not look like a different
 * kind of thing depending on which screen a person opened.
 *
 * MOBILE IS A STACK OF CARDS, not a table in a horizontal scroller: the
 * approved treatment, unchanged.
 */
export function OrderPiProducts({
  products, isMobile, representativeThumbnail, customizationThumbnails, unresolvedImages,
}: {
  products: readonly PersistedProduct[]
  isMobile: boolean
  representativeThumbnail: (row: number) => PiThumbnailProps
  customizationThumbnails: (row: number) => { key: string; props: PiThumbnailProps }[]
  /** Pictures the record names that could not be signed. Reported, never faked. */
  unresolvedImages: number
}) {
  return (
    <PiCard>
      <PiCardHeader
        title={ORDER_PI_PRODUCTS_TITLE}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {unresolvedImages > 0 && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '5px',
                padding: '2px 8px', borderRadius: '5px',
                fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
                background: colors.redTint, color: colors.red,
                border: '1px solid rgba(217,79,79,0.25)',
              }}>
                {unresolvedImages} image{unresolvedImages === 1 ? '' : 's'} unavailable
              </span>
            )}
            <span style={{ fontSize: '12px', color: colors.muted, whiteSpace: 'nowrap' }}>
              {products.length} line{products.length !== 1 ? 's' : ''}
            </span>
          </div>
        }
      />

      {products.length === 0 ? (
        <div style={{ padding: '20px', fontSize: '12px', color: colors.secondary }}>
          No product lines are stored against the approved PI.
        </div>
      ) : isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {products.map((p, i) => (
            <div
              key={p.id}
              style={{
                padding: '14px 16px',
                borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
                display: 'flex', flexDirection: 'column', gap: '10px',
              }}
            >
              <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                <PiProductThumbnail
                  {...representativeThumbnail(p.row)}
                  size={PI_THUMBNAIL_SIZE.representativeCompact}
                />
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <div style={{ fontSize: '10px', color: colors.muted, fontFamily: 'var(--font-mono)' }}>
                    {orDash(p.itemSequence)}
                  </div>
                  <MultilineText style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, margin: 0 }}>
                    {orDash(p.productName)}
                  </MultilineText>
                  <div style={{ fontSize: '12px', color: colors.secondary }}>
                    {p.quantity ?? '—'} × {formatInr(p.costPerPiece)}
                  </div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <PiFieldRow label="Dimensions" value={orDash(p.dimensions)} />
                <PiFieldRow label="Material" value={orDash(p.material)} />
              </div>

              <PiCustomizationCell
                label="Customization"
                text={p.customization}
                thumbnails={customizationThumbnails(p.row)}
                compact
              />

              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                borderTop: `1px solid ${colors.border}`, paddingTop: '8px',
              }}>
                <span style={{ fontSize: '11px', color: colors.muted }}>Line total</span>
                <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                  {formatInr(p.lineTotal)}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            {/* The identical head both PI screens render. */}
            <PiProductTableHead />
            <tbody>
              {products.map(p => (
                <tr key={p.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: colors.muted, fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                    {orDash(p.itemSequence)}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <PiProductThumbnail {...representativeThumbnail(p.row)} />
                  </td>
                  <td style={{ padding: '10px 14px', minWidth: '160px', maxWidth: '240px' }}>
                    <MultilineText style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, margin: 0 }}>
                      {orDash(p.productName)}
                    </MultilineText>
                  </td>
                  <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: colors.secondary }}>
                    {p.quantity ?? '—'}
                  </td>
                  <td style={{ padding: '10px 14px', minWidth: '130px', maxWidth: '200px' }}>
                    <MultilineText style={{ fontSize: '12px', color: colors.secondary, margin: 0 }}>
                      {orDash(p.dimensions)}
                    </MultilineText>
                  </td>
                  <td style={{ padding: '10px 14px', minWidth: '120px', maxWidth: '200px' }}>
                    <MultilineText style={{ fontSize: '12px', color: colors.secondary, margin: 0 }}>
                      {orDash(p.material)}
                    </MultilineText>
                  </td>
                  <td style={{ padding: '10px 14px', minWidth: '140px', maxWidth: '240px' }}>
                    <PiCustomizationCell
                      text={p.customization}
                      thumbnails={customizationThumbnails(p.row)}
                      compact={false}
                    />
                  </td>
                  <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', textAlign: 'right', color: colors.secondary }}>
                    {formatInr(p.costPerPiece)}
                  </td>
                  <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', textAlign: 'right', fontWeight: 600, color: colors.primary }}>
                    {formatInr(p.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PiCard>
  )
}
