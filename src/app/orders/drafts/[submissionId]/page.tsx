'use client'

// One saved PI draft, as the SERVER stored it.
//
// EVERYTHING ON THIS SCREEN COMES OUT OF THE DATABASE.
//
// That is the whole point of the page, and it is worth stating plainly because
// the sibling screen works the opposite way round. /orders/import parses a
// workbook in the tab and shows its own reading; this one shows the reading the
// SERVER made when it re-parsed the same file and persisted the result. Those
// two can in principle disagree, and when they do, what was saved is what
// counts — a reviewer, an approver and a factory all act on the stored record.
//
// So nothing here is carried over from the upload session. No parsed workbook is
// passed through navigation state, no figure is taken from a query string, no
// preview is read out of storage of any kind, and there is no code path that
// renders a product, a price or a picture from anything other than a row this
// page fetched. The one thing the URL supplies is the submission id, and an id
// is only useful to somebody the database already lets read that submission.
//
// AUTHORIZATION IS THE DATABASE'S. There is no ownership check below. RLS
// answers it: order_submissions_select for the record, can_view_order_submission
// for its items, its pictures and its stored objects, and the restrictive module
// gate on top of all of them. A submission this caller may not read comes back
// as no rows, and no rows renders as "not found" — the same answer a genuinely
// missing id gets, so the page cannot be used to discover that a draft exists.
//
// THE PI ITSELF IS STILL NEVER EDITED HERE. Not a price, not a product, not a
// picture. Replacing the document is the upload screen's job — it is the screen
// with a workbook in hand, a parser, a lease and a rollback — so "Change PI"
// below is a LINK to it carrying this submission's id, and not a second
// persistence path grown on a page that has no file.
//
// WHAT THE PAGE NOW WRITES, AND ONLY THROUGH THE DATABASE'S OWN DOORS:
//
//   submit_order_submission_with_advance  the owner hands it to management under
//                                     a declared advance requirement, carrying
//                                     their optional reply when they are
//                                     answering a returned record
//   request_order_submission_changes  a reviewer sends it back, with a note
//   reject_order_submission           a reviewer ends it, with a reason
//   approve_pi_advance_exception      an authorised approver accepts a proposed
//                                     advance below the standard 40%
//   reject_pi_advance_exception       …or refuses it, with a mandatory reason,
//                                     which returns the PI for correction
//
// Each of those is a status move and a declaration, and nothing else. None of
// them writes a figure, a line or an image mapping — those come only from the
// server's own re-parse — and each re-derives the actor, the permission and the
// record's state inside the database before it writes. What this file decides is
// which controls to draw, which is a question about screens and never about
// authority.
//
// AND NOTHING HERE IS A PAYMENT. The advance requirement is a commercial
// condition: what BOE will ask for before the order is worked. No payment is
// created, requested, recorded, confirmed or reconciled by any of it, and the
// screen says so wherever a rupee figure appears beside the word "advance".

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle, CheckCircle2, Info, ArrowLeft,
  FileText, FileSpreadsheet, Clock, Package, User,
  History, Send, Upload, Undo2, Ban, Lock, Percent, ThumbsUp,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { MultilineText } from '@/components/ui/MultilineText'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import {
  PiCard,
  PiCardHeader,
  PiFieldRow,
  PiProductThumbnail,
  PiCustomizationCell,
  PiProductTableHead,
  PiDiagnosticList,
  PiCommercialSummary,
  PiImageViewer,
  PI_THUMBNAIL_SIZE,
  type PiThumbnailProps,
} from '@/components/orders/piPreview'
import { PiSubmitConfirmModal, PiNoteModal, type PiNoteIntent } from '@/components/orders/piReviewModals'
import { colors } from '@/lib/tokens'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import { fetchAllRows } from '@/lib/supabasePaging'
import {
  APPROVE_BUTTON_LABEL,
  APPROVE_DISABLED_REASON,
  CHANGE_PI_BUTTON_LABEL,
  REJECT_BUTTON_LABEL,
  REQUEST_CHANGES_BUTTON_LABEL,
  SUBMIT_BUTTON_LABEL,
  changePiHref,
  submissionOffersReply,
  describeSubmissionActions,
  describeSubmissionBanner,
  describeSubmissionFailure,
  type SubmissionAction,
  type SubmissionBannerTone,
} from '@/lib/orders/submissionWorkflow'
import {
  PI_ACTIVITY_COLUMNS,
  activityActorIds,
  describeActivityEntries,
  type ActivityEntry,
  type PersistedActivity,
} from '@/lib/orders/submissionActivity'
import {
  ADVANCE_NOT_A_PAYMENT,
  ADVANCE_REJECTED_INSTRUCTION,
  ADVANCE_SECTION_TITLE,
  ADVANCE_ZERO_EXPLANATION,
  APPROVE_EXCEPTION_BUTTON_LABEL,
  REJECT_EXCEPTION_BUTTON_LABEL,
  describeAdvance,
  describeAdvanceActions,
  initialAdvanceSelection,
  type AdvanceSelection,
} from '@/lib/orders/advanceRequirement'
import {
  buildCommercialRows,
  buildHeaderRows,
  buildImageViewerItems,
  formatInr,
  orDash,
  viewerNav,
  BLOCKING_PANEL_TITLE,
  WARNING_PANEL_TITLE,
  type PiDiagnosticEntry,
  type PiViewerItem,
  type PiViewerNav,
} from '@/lib/pi/previewView'
import {
  ORDER_FILES_BUCKET,
  PI_DRAFT_DETAIL_COLUMNS,
  PI_DRAFT_IMAGE_URL_TTL_SECONDS,
  PI_DRAFT_ITEM_COLUMNS,
  PI_DRAFT_ITEM_IMAGE_COLUMNS,
  draftStatusLabel,
  draftStatusTone,
  formatSavedAt,
  persistedCommercial,
  persistedDiagnostics,
  persistedHeader,
  persistedImageUrlMaps,
  persistedProducts,
  toNumber,
  type PersistedItem,
  type PersistedItemImage,
  type PersistedProduct,
  type PersistedSubmission,
  type PiDraftStatusTone,
} from '@/lib/orders/draftsView'

const MOBILE_BREAKPOINT = 768

const TONE_STYLE: Record<PiDraftStatusTone, { bg: string; color: string; border: string }> = {
  neutral: { bg: colors.raised,    color: colors.secondary, border: colors.border },
  blue:    { bg: colors.blueTint,  color: '#2F5BB7',        border: 'rgba(85,133,232,0.3)' },
  amber:   { bg: colors.amberTint, color: '#9A6212',        border: 'rgba(232,160,48,0.3)' },
  red:     { bg: colors.redTint,   color: colors.red,       border: 'rgba(217,79,79,0.3)' },
  green:   { bg: colors.greenTint, color: '#2F7A52',        border: 'rgba(69,168,112,0.25)' },
}

// ── The overview section ──────────────────────────────────────────────────────
//
// WHAT WAS WRONG WITH THE VERSION THIS REPLACES. Ten fields were poured into one
// auto-filling grid, so on a wide monitor they scattered across six columns of
// roughly equal weight: the client, a date, a filename and a dispatch promise
// all looked like the same kind of fact, related fields sat nowhere near each
// other, and half the cells were an em dash — which reads as "unfinished", not
// as "the PI did not say". The card was large and told you very little quickly.
//
// The replacement has three bands and one scan order:
//
//   status  →  what this record is, on the header line
//   saved   →  a strip of four small facts about the file itself
//   order   →  the client and destination, then the dates, three to a row
//
// EMPTY IS NOT A DASH. A missing value says "Not provided" in muted text, and a
// missing FILENAME is not shown at all — a labelled block with nothing in it is
// worse than the absence it is reporting.

/** A label with its value, or an honest muted note when the PI did not say. */
function InfoField({ label, value, strong = false }: {
  label: string
  /** The shared header builder returns an em dash for anything absent. */
  value: string
  /** Client and destination read heavier than the dates below them. */
  strong?: boolean
}) {
  const missing = value.trim() === '' || value.trim() === '—'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <div style={{
        fontSize: '10px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </div>
      {missing ? (
        <div style={{ fontSize: '13px', color: colors.muted, fontStyle: 'italic' }}>
          Not provided
        </div>
      ) : (
        <MultilineText style={{
          fontSize: strong ? '14px' : '13px',
          fontWeight: strong ? 600 : 400,
          color: strong ? colors.primary : colors.secondary,
          margin: 0,
        }}>
          {value}
        </MultilineText>
      )}
    </div>
  )
}

/** One fact in the metadata strip: an icon, a label, and a short value. */
// ── The advance requirement section ───────────────────────────────────────────
//
// ONE COMPONENT, THREE AUDIENCES: the employee reading their own record, a PI
// reviewer, and an authorised exception approver. What differs between them is
// only whether the two decision CONTROLS are drawn — the STATE is shown to
// everybody who can read the PI, because a record waiting on somebody else's
// decision must not look inert to the person waiting.
//
// IT IS COMPACT ON PURPOSE: six short rows at most, and the exception rows are
// present only when there is an exception. The commercial summary further down
// still carries its own "Required advance (40%)" line; this section is about the
// CONDITION and the DECISION, not about restating the arithmetic.
//
// NO PAYMENT LANGUAGE. Not "received", not "paid", not "collected". The figures
// are what would be required, and the footnote says so.

function AdvanceRow({ label, value, tone = 'plain' }: {
  label: string
  value: React.ReactNode
  tone?: 'plain' | 'strong'
}) {
  return (
    <div style={{
      display: 'flex', gap: '14px', justifyContent: 'space-between',
      alignItems: 'baseline', flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: '11.5px', color: colors.muted }}>{label}</span>
      <span style={{
        fontSize: tone === 'strong' ? '13px' : '12.5px',
        fontWeight: tone === 'strong' ? 700 : 600,
        color: colors.primary, textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </span>
    </div>
  )
}

const EXCEPTION_STATUS_TONE: Record<string, { bg: string; color: string; border: string }> = {
  pending:  { bg: colors.amberTint, color: '#9A6212', border: 'rgba(232,160,48,0.35)' },
  approved: { bg: colors.greenTint, color: '#2F7A52', border: 'rgba(69,168,112,0.35)' },
  rejected: { bg: colors.redTint,   color: colors.red, border: 'rgba(217,79,79,0.35)' },
}

function AdvanceRequirementSection({
  advance,
  canDecide,
  acting,
  showRejectedInstruction,
  requesterName,
  deciderName,
  requestedAt,
  decidedAt,
  onApprove,
  onReject,
}: {
  advance: ReturnType<typeof describeAdvance>
  /** Whether THIS viewer may settle a pending proposal. */
  canDecide: boolean
  acting: boolean
  /** True for the employee looking at a PI returned because of the refusal. */
  showRejectedInstruction: boolean
  requesterName: string | null
  deciderName: string | null
  requestedAt: string | null
  decidedAt: string | null
  onApprove: () => void
  onReject: () => void
}) {
  const statusTone = advance.status ? EXCEPTION_STATUS_TONE[advance.status] : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        <Percent size={13} strokeWidth={2} color={colors.tertiary} />
        <span style={{ fontSize: '12px', fontWeight: 700, color: colors.primary }}>
          {ADVANCE_SECTION_TITLE}
        </span>
        {advance.statusLabel && statusTone && (
          <span style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center',
            padding: '2px 8px', borderRadius: '5px',
            fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
            background: statusTone.bg, color: statusTone.color,
            border: `1px solid ${statusTone.border}`,
          }}>
            {advance.statusLabel}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {/* The standard is ALWAYS shown, even under an exception, because the
            decision being asked for is a comparison and half a comparison is
            not one. */}
        <AdvanceRow
          label={`Standard requirement (${advance.standardPercentLabel})`}
          value={advance.standardAmount}
        />

        <AdvanceRow
          label="Selected condition"
          value={advance.undeclared ? 'Not declared' : advance.conditionLabel}
        />

        {advance.exceptionPercentLabel && (
          <AdvanceRow
            label="Proposed advance"
            value={`${advance.exceptionPercentLabel}${advance.exceptionAmount ? ` · ${advance.exceptionAmount}` : ''}`}
            tone="strong"
          />
        )}
      </div>

      {advance.isZeroPercent && (
        <div style={{ fontSize: '11.5px', color: '#9A6212', lineHeight: 1.45 }}>
          {ADVANCE_ZERO_EXPLANATION}
        </div>
      )}

      {/* The employee's own words, verbatim. This is what the decision is
          actually about, so it is not squeezed into a row. */}
      {advance.requestReason && (
        <div style={{
          padding: '8px 11px', borderRadius: '6px',
          background: colors.raised, border: `1px solid ${colors.border}`,
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, marginBottom: '2px' }}>
            Employee&rsquo;s reason
          </div>
          <MultilineText style={{ fontSize: '12px', color: colors.primary, margin: 0 }}>
            {advance.requestReason}
          </MultilineText>
        </div>
      )}

      {advance.rejectionReason && (
        <div style={{
          padding: '8px 11px', borderRadius: '6px',
          background: colors.redTint, border: '1px solid rgba(217,79,79,0.25)',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#991B1B', marginBottom: '2px' }}>
            Why it was refused
          </div>
          <MultilineText style={{ fontSize: '12px', color: colors.primary, margin: 0 }}>
            {advance.rejectionReason}
          </MultilineText>
        </div>
      )}

      {/* Who asked and who decided, when either is known. Small, muted, and
          absent rather than dashed when a name cannot be resolved. */}
      {(requestedAt || decidedAt) && (
        <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
          {requestedAt && (
            <div>Requested by {requesterName ?? 'a colleague'} on {requestedAt}</div>
          )}
          {decidedAt && (
            <div>Decided by {deciderName ?? 'a colleague'} on {decidedAt}</div>
          )}
        </div>
      )}

      {showRejectedInstruction && (
        <div style={{
          fontSize: '11.5px', color: colors.primary, lineHeight: 1.5,
          background: colors.amberTint, border: '1px solid rgba(232,160,48,0.3)',
          borderRadius: '6px', padding: '8px 11px',
        }}>
          {ADVANCE_REJECTED_INSTRUCTION}
        </div>
      )}

      {/* The two decision controls, for somebody who holds the authority.
          Approve is a CONTAINED POSITIVE action and deliberately looks nothing
          like the disabled "Approve" beside it: that one approves the PI and
          cannot be pressed, this one settles one commercial term. */}
      {canDecide && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', paddingTop: '2px' }}>
          <button
            className="boe-btn boe-btn-primary"
            onClick={onApprove}
            disabled={acting}
            style={{ background: '#2F7A52', borderColor: '#2F7A52' }}
          >
            <ThumbsUp size={13} strokeWidth={2} />
            {APPROVE_EXCEPTION_BUTTON_LABEL}
          </button>
          <button
            className="boe-btn boe-btn-ghost"
            onClick={onReject}
            disabled={acting}
          >
            <Ban size={13} strokeWidth={2} />
            {REJECT_EXCEPTION_BUTTON_LABEL}
          </button>
        </div>
      )}

      <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.45 }}>
        {ADVANCE_NOT_A_PAYMENT}
      </div>
    </div>
  )
}

function MetaItem({ icon, label, value }: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 }}>
      <span style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, flexShrink: 0, marginTop: '1px',
        borderRadius: '7px', background: colors.raised,
        border: `1px solid ${colors.border}`, color: colors.tertiary,
      }}>
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: '10px', fontWeight: 600, color: colors.muted,
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          {label}
        </div>
        <div style={{
          fontSize: '12.5px', color: colors.primary, marginTop: '1px',
          overflowWrap: 'anywhere',
        }}>
          {value}
        </div>
      </div>
    </div>
  )
}

/** Everything the screen renders, assembled from the four reads. */
type Draft = {
  submission: PersistedSubmission
  products: PersistedProduct[]
  representativeByRow: ReadonlyMap<number, string>
  customizationByRow: ReadonlyMap<number, readonly string[]>
  /** Stored pictures this caller could not get a URL for. */
  unresolvedImages: number
  viewerItems: readonly PiViewerItem[]
  blocking: PiDiagnosticEntry[]
  warnings: PiDiagnosticEntry[]
  /** The append-only history, newest first, already resolved to names. */
  activity: ActivityEntry[]
  /** Who submitted it, and who rejected it. Null when the record has not
   *  reached that state, or when the name could not be resolved. */
  submitterName: string | null
  rejectedByName: string | null
  /** Who proposed the advance exception, and who settled it. Resolved in the
   *  SAME users read as every other name on this page. */
  advanceRequesterName: string | null
  advanceDeciderName: string | null
}

type Load =
  | { kind: 'loading' }
  /** Missing OR not visible to this caller. One answer for both, on purpose. */
  | { kind: 'unavailable' }
  | { kind: 'failed' }
  | { kind: 'ready'; draft: Draft }

const diagnosticEntries = (value: unknown): PiDiagnosticEntry[] =>
  persistedDiagnostics(value)
    .map(entry => ({
      code: entry.code,
      message: entry.message,
      location:
        entry.row !== null && entry.cell ? `Row ${entry.row} · ${entry.cell}`
        : entry.row !== null ? `Row ${entry.row}`
        : entry.cell ? `Cell ${entry.cell}`
        : null,
      row: entry.row,
    }))
    .sort((a, b) => {
      if (a.row !== b.row) {
        if (a.row === null) return 1
        if (b.row === null) return -1
        return a.row - b.row
      }
      return a.code.localeCompare(b.code)
    })

export default function PiDraftDetailPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <PiDraftDetailPageInner />
    </Suspense>
  )
}

function PiDraftDetailPageInner() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = useMemo(() => createClient(), [])

  const submissionId = params.submissionId as string
  /**
   * The one thing the query string is trusted for: whether to congratulate.
   *
   * It carries no data and decides nothing about what is displayed. Somebody
   * who adds ?saved=1 to a link sees a banner over a record that is loaded,
   * checked and rendered exactly as it would be without it.
   */
  const justSaved = searchParams.get('saved') === '1'

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [isMobile, setIsMobile] = useState(false)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)

  /**
   * WHO IS LOOKING, AND WHAT THEY MAY DO — resolved for the SIGNED-IN account.
   *
   * Never a View As target: impersonation shows an administrator what somebody
   * else sees and must not lend or borrow the authority to submit or to review.
   * Both values decide which controls are drawn and nothing more; every RPC
   * behind those controls re-derives the same facts in the database.
   */
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [canCreate, setCanCreate] = useState(false)
  const [canReview, setCanReview] = useState(false)
  /**
   * orders.approve_advance_exception — the SEPARATE authority to settle a
   * proposed advance. Independent of canReview in both directions, exactly as
   * the database has it.
   */
  const [canDecideAdvance, setCanDecideAdvance] = useState(false)

  /** Which decision dialog is open, if any. */
  const [dialog, setDialog] = useState<'submit' | PiNoteIntent | null>(null)
  const [acting, setActing] = useState(false)
  const [actionFailure, setActionFailure] = useState<string | null>(null)

  const thumbnailRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const viewerOpenedFrom = useRef<string | null>(null)
  /** Belt and braces against a double click: state updates are async, this is
   *  not, so two clicks in the same tick cannot both start a write. */
  const actingRef = useRef(false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  /**
   * Load the stored draft: the record, its product lines, its pictures, and
   * time-limited URLs for those pictures.
   *
   * THE BUCKET STAYS PRIVATE. Nothing here builds a public URL — there is none
   * to build. Each object is signed on demand through the caller's own session,
   * so the storage policies decide again, per object, whether this person may
   * see this picture. A refusal yields no URL and the table shows its honest
   * "No image" box rather than a broken one.
   *
   * `quiet` keeps the record on screen while it is re-read. The first load has
   * nothing to show and correctly shows the loading screen; a REFRESH does, and
   * blanking a page somebody is reading — losing their scroll position and
   * closing whatever they had open — is not what pressing refresh asks for. The
   * header's own spinner is the feedback, and the new data replaces the old in
   * one commit when it arrives.
   */
  const loadDraft = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) setLoad({ kind: 'loading' })

    const { data: submission, error } = await supabase
      .from('order_submissions')
      .select(PI_DRAFT_DETAIL_COLUMNS)
      .eq('id', submissionId)
      .maybeSingle()

    if (error) { setLoad({ kind: 'failed' }); return }
    // No row means either "no such submission" or "not yours". The page must
    // not distinguish them, and neither does this branch.
    if (!submission) { setLoad({ kind: 'unavailable' }); return }

    const [itemsResult, imagesResult] = await Promise.all([
      supabase
        .from('order_submission_items')
        .select(PI_DRAFT_ITEM_COLUMNS)
        .eq('submission_id', submissionId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('order_submission_item_images')
        .select(PI_DRAFT_ITEM_IMAGE_COLUMNS)
        .eq('submission_id', submissionId)
        .order('position', { ascending: true }),
    ])

    if (itemsResult.error || imagesResult.error) { setLoad({ kind: 'failed' }); return }

    const products = persistedProducts((itemsResult.data ?? []) as unknown as PersistedItem[])
    const images = (imagesResult.data ?? []) as unknown as PersistedItemImage[]

    const signedByPath = new Map<string, string>()
    const paths = [...new Set(images.map(i => i.storage_path).filter(Boolean))]
    if (paths.length > 0) {
      const { data: signed } = await supabase
        .storage
        .from(ORDER_FILES_BUCKET)
        .createSignedUrls(paths, PI_DRAFT_IMAGE_URL_TTL_SECONDS)
      for (const row of signed ?? []) {
        if (row?.path && row.signedUrl && !row.error) signedByPath.set(row.path, row.signedUrl)
      }
    }

    const urls = persistedImageUrlMaps(products, images, signedByPath)
    const row = submission as unknown as PersistedSubmission

    // ── The history, and the names it refers to ──
    //
    // PAGED, because a submission that goes back and forth a few times
    // accumulates rows and PostgREST silently caps a response at 1000. A
    // truncated history is worse than none: it looks complete.
    //
    // Ordered by id for paging — a deterministic unique column is what makes
    // range paging return each row exactly once — and re-ordered by time for
    // display, which describeActivityEntries does.
    const activityRows = await fetchAllRows<PersistedActivity>((from, to) =>
      supabase
        .from('order_submission_activity')
        .select(PI_ACTIVITY_COLUMNS)
        .eq('submission_id', submissionId)
        .order('id', { ascending: true })
        .range(from, to))

    const history = activityRows.ok ? activityRows.rows : []

    // ONE users read for every name on the page: the actors in the history, the
    // submitter and the reviewer who rejected it. A query per row would be a
    // dozen round trips to print four names.
    const namesById = new Map<string, string>()
    const actorIds = activityActorIds(history, [
      row.submitted_by,
      row.rejected_by,
      row.advance_exception_requested_by,
      row.advance_exception_decided_by,
    ])
    if (actorIds.length > 0) {
      // Two safe columns, named explicitly: `select('*')` on public.users is a
      // permission error, and a display name is all this page needs.
      const { data: people } = await supabase
        .from('users')
        .select('id, full_name')
        .in('id', actorIds)
      for (const person of (people ?? []) as { id: string; full_name: string | null }[]) {
        if (person?.id && person.full_name) namesById.set(person.id, person.full_name)
      }
    }

    setLoad({
      kind: 'ready',
      draft: {
        submission: row,
        activity: describeActivityEntries(history, namesById, formatSavedAt),
        submitterName: row.submitted_by ? namesById.get(row.submitted_by) ?? null : null,
        rejectedByName: row.rejected_by ? namesById.get(row.rejected_by) ?? null : null,
        advanceRequesterName: row.advance_exception_requested_by
          ? namesById.get(row.advance_exception_requested_by) ?? null : null,
        advanceDeciderName: row.advance_exception_decided_by
          ? namesById.get(row.advance_exception_decided_by) ?? null : null,
        products,
        representativeByRow: urls.representativeByRow,
        customizationByRow: urls.customizationByRow,
        unresolvedImages: urls.unresolved,
        // The same helper the import preview uses, so a picture is labelled and
        // ordered identically before and after the save.
        viewerItems: buildImageViewerItems(products, urls),
        blocking: diagnosticEntries(row.parse_blocking_issues),
        warnings: diagnosticEntries(row.parse_warnings),
      },
    })
  }, [supabase, submissionId])

  useEffect(() => {
    let active = true

    const run = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const { data: me } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      // A failed permission read resolves to no capabilities, so the page falls
      // back to what it has always been — a read-only record — rather than
      // offering a control the caller may not have.
      const permissions = await getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => [])
      const caps = deriveOrdersCapabilities((me as UserProfile | null)?.role, permissions)

      if (!active) return
      setProfile((me as UserProfile) ?? null)
      setViewerId(session.user.id)
      setCanCreate(caps.canCreateOrder)
      setCanReview(caps.canApproveOrderSubmission)
      setCanDecideAdvance(caps.canApproveAdvanceException)
      await loadDraft()
    }

    run()
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  /**
   * Run one decision, then re-read the record QUIETLY.
   *
   * THE RPC IS THE AUTHORITY, not the button that called it. Each of the three
   * re-derives the actor, the permission, the ownership and the status inside
   * the database under a row lock, so a stale screen, a second tab or a
   * hand-crafted call all end in the same refusal.
   *
   * On success the record is re-read in place: the status, the banner, the
   * controls and the history all come from the persisted row rather than from an
   * optimistic guess, and the page does not blank, scroll or lose an open image
   * viewer while it happens.
   *
   * On failure the dialog stays open with the typed note intact, and what is
   * shown is a fixed sentence chosen by describeSubmissionFailure — never the
   * database's own message, which carries statement text and ids.
   */
  const runAction = useCallback(async (
    action: SubmissionAction,
    call: () => Promise<{ error: unknown }>,
  ) => {
    if (actingRef.current) return
    actingRef.current = true
    setActing(true)
    setActionFailure(null)

    try {
      const { error } = await call()
      if (error) {
        setActionFailure(describeSubmissionFailure(error, action).message)
        return
      }
      setDialog(null)
      await loadDraft({ quiet: true })
    } finally {
      actingRef.current = false
      setActing(false)
    }
  }, [loadDraft])

  /**
   * Submit, with the employee's optional reply on a resubmission.
   *
   * TWO RPCs, ONE IMPLEMENTATION. The database keeps the original
   * submit_order_submission(uuid) for a plain submission and adds
   * submit_order_submission_with_note(uuid, text) for one carrying a reply; both
   * are one line over the same internal function, so the actor, ownership,
   * state, permission and completeness checks are identical either way. The
   * screen picks the door by whether there is anything to say — never by
   * authority, which is the database's to decide.
   */
  const submitForApproval = useCallback((
    note: string | null,
    advance: AdvanceSelection,
  ) => runAction('submit', async () => {
    const { error } = await supabase.rpc('submit_order_submission_with_advance', {
      p_submission_id: submissionId,
      p_note: note,
      p_advance_condition: advance.condition,
      p_advance_percent: advance.condition === 'exception' ? advance.percent : null,
      p_advance_reason: advance.condition === 'exception' ? advance.reason : null,
    })
    return { error }
  }), [runAction, supabase, submissionId])

  /**
   * Accept the proposed advance. THE PI STAYS UNDER REVIEW.
   *
   * No note, by design: approving the condition the employee asked for adds
   * nothing that the decision itself does not already say, and a mandatory field
   * on the positive path is friction for its own sake. The refusal is the one
   * that needs words.
   */
  const approveException = useCallback(() => runAction('approve_exception', async () => {
    const { error } = await supabase.rpc('approve_pi_advance_exception', {
      p_submission_id: submissionId,
    })
    return { error }
  }), [runAction, supabase, submissionId])

  const rejectException = useCallback((reason: string) => runAction('reject_exception', async () => {
    const { error } = await supabase.rpc('reject_pi_advance_exception', {
      p_submission_id: submissionId,
      p_reason: reason,
    })
    return { error }
  }), [runAction, supabase, submissionId])

  const requestChanges = useCallback((note: string) => runAction('request_changes', async () => {
    const { error } = await supabase.rpc('request_order_submission_changes', {
      p_submission_id: submissionId,
      p_note: note,
    })
    return { error }
  }), [runAction, supabase, submissionId])

  const rejectSubmission = useCallback((reason: string) => runAction('reject', async () => {
    const { error } = await supabase.rpc('reject_order_submission', {
      p_submission_id: submissionId,
      p_reason: reason,
    })
    return { error }
  }), [runAction, supabase, submissionId])

  const closeDialog = useCallback(() => {
    if (actingRef.current) return
    setDialog(null)
    setActionFailure(null)
  }, [])

  const draft = load.kind === 'ready' ? load.draft : null

  const viewerItem = draft && viewerIndex !== null ? draft.viewerItems[viewerIndex] ?? null : null
  const nav: PiViewerNav | null = draft && viewerIndex !== null
    ? viewerNav(viewerIndex, draft.viewerItems.length)
    : null

  const closeViewer = useCallback(() => {
    setViewerIndex(null)
    const key = viewerOpenedFrom.current
    viewerOpenedFrom.current = null
    if (key !== null) thumbnailRefs.current.get(key)?.focus()
  }, [])

  const openViewer = (key: string) => {
    if (!draft) return
    const index = draft.viewerItems.findIndex(item => item.key === key)
    if (index < 0) return
    viewerOpenedFrom.current = key
    setViewerIndex(index)
  }

  const stepViewer = (index: number | null) => {
    if (index === null || !draft) return
    setViewerIndex(index)
    viewerOpenedFrom.current = draft.viewerItems[index]?.key ?? viewerOpenedFrom.current
  }

  const itemByKey = (key: string) => draft?.viewerItems.find(item => item.key === key)

  const thumbnailFor = (key: string, url: string | undefined): PiThumbnailProps => ({
    url,
    label: itemByKey(key)?.label,
    onOpen: () => openViewer(key),
    buttonRef: (el: HTMLButtonElement | null) => { thumbnailRefs.current.set(key, el) },
  })

  const representativeThumbnail = (row: number) =>
    thumbnailFor(`representative-${row}`, draft?.representativeByRow.get(row))

  const customizationThumbnails = (row: number) =>
    (draft?.customizationByRow.get(row) ?? []).map((url, index) => {
      const key = `customization-${row}-${index}`
      return { key, props: thumbnailFor(key, url) }
    })

  if (load.kind === 'loading') return <LoadingScreen />

  const backButton = (
    <button className="boe-btn boe-btn-ghost" onClick={() => router.push('/orders/drafts')}>
      <ArrowLeft size={13} strokeWidth={2} />
      PI Drafts
    </button>
  )

  if (load.kind !== 'ready' || !draft) {
    const unavailable = load.kind === 'unavailable'
    return (
      <OrdersLayout
        profile={profile}
        title="PI Draft"
        onSignOut={handleSignOut}
        showRefresh={false}
        actions={backButton}
      >
        <PiCard style={{ borderColor: 'rgba(217,79,79,0.3)' }}>
          <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>
              {unavailable ? 'This draft is not available' : 'This draft could not be loaded'}
            </div>
            <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5, maxWidth: '520px' }}>
              {unavailable
                // One sentence for both cases. Saying "you are not allowed to
                // see this one" would confirm that it exists.
                ? 'It may have been removed, or it may belong to someone else. Open PI Drafts to see the drafts you can work with.'
                : 'The draft could not be read just now. Try again in a moment.'}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              {!unavailable && (
                <button className="boe-btn boe-btn-primary" onClick={() => void loadDraft()}>
                  Try again
                </button>
              )}
              <button className="boe-btn boe-btn-ghost" onClick={() => router.push('/orders/drafts')}>
                Go to PI Drafts
              </button>
            </div>
          </div>
        </PiCard>
      </OrdersLayout>
    )
  }

  const { submission, products } = draft
  const tone = TONE_STYLE[draftStatusTone(submission.status)]
  const savedAt = formatSavedAt(submission.updated_at ?? submission.created_at)

  /** Null unless the record actually names a workbook, so the strip can omit it. */
  const workbookName = submission.source_workbook_name?.trim() || null
  /** Whoever the PI itself named. Absent on plenty of real workbooks. */
  const createdBy = submission.source_created_by?.trim() || null

  // The shared builder still decides every LABEL and every formatted VALUE —
  // the dates, the em dash for an absent cell, and the rule that the workbook's
  // own order number is never among them. This page only picks the order it
  // shows them in, so the two PI screens cannot disagree about what a field says.
  const headerRows = buildHeaderRows(persistedHeader(submission))
  const headerValue = (key: string) => headerRows.find(row => row.key === key)?.value ?? '—'

  // ── What this viewer may do with this record ──
  //
  // One answer, from one helper, shared with its tests. The controls below
  // branch on it and on nothing else, so there is no second, looser rule living
  // in a JSX condition.
  const actions = describeSubmissionActions({
    status: submission.status,
    createdBy: submission.created_by,
    submittedBy: submission.submitted_by,
    viewerId,
    canCreate,
    canApproveSubmission: canReview,
  })

  const submittedAt = submission.submitted_at ? formatSavedAt(submission.submitted_at) : null
  const rejectedAt = submission.rejected_at ? formatSavedAt(submission.rejected_at) : null

  // ── The advance requirement, and who may settle it ──
  //
  // ONE ANSWER, FROM ONE HELPER, shared with its tests, exactly as the action
  // rules above are. The rupee figures are derived from the CURRENT persisted
  // grand total, so a corrected PI moves them rather than reporting an amount
  // that was true of an older document.
  const grandTotalValue = toNumber(submission.grand_total)
  const advance = describeAdvance(submission, grandTotalValue)
  const advanceActions = describeAdvanceActions({
    status: submission.status,
    advance: submission,
    canDecideException: canDecideAdvance,
  })

  /**
   * Whether the section is on screen at all.
   *
   * A DRAFT GETS NONE. Nothing has been declared and nothing will be until the
   * employee submits, so a permanent "Not declared" block on the commonest state
   * would be a section of screen spent on a question nobody has asked yet.
   * Everything past draft shows it, including a legacy record that declared
   * nothing — that absence is exactly what a reviewer needs to see.
   */
  const showAdvance = !advance.undeclared || submission.status !== 'draft'

  /** True only when the record is back with the employee BECAUSE of the refusal. */
  const advanceRejectedNow =
    advance.status === 'rejected' && submission.status === 'needs_changes'

  const advanceSection = (
    <AdvanceRequirementSection
      advance={advance}
      canDecide={advanceActions.canDecide}
      acting={acting}
      showRejectedInstruction={advanceRejectedNow}
      requesterName={draft.advanceRequesterName}
      deciderName={draft.advanceDeciderName}
      requestedAt={advance.requestedAtIso ? formatSavedAt(advance.requestedAtIso) : null}
      decidedAt={advance.decidedAtIso ? formatSavedAt(advance.decidedAtIso) : null}
      onApprove={() => { setActionFailure(null); approveException() }}
      onReject={() => { setActionFailure(null); setDialog('reject_exception') }}
    />
  )

  /** The Management Review card, which the advance section lives INSIDE when it
   *  is drawn. See the placement note at the card itself. */
  const showReviewCard = actions.canRequestChanges || actions.canReject

  const banner = describeSubmissionBanner({
    status: submission.status,
    submittedAt,
    submitterName: draft.submitterName,
    rejectedAt,
    rejectedByName: draft.rejectedByName,
  })

  const bannerTone: Record<SubmissionBannerTone, { bg: string; border: string; icon: React.ReactNode }> = {
    blue:  { bg: colors.blueTint,  border: 'rgba(85,133,232,0.35)', icon: <Clock size={16} strokeWidth={1.9} color="#2F5BB7" /> },
    amber: { bg: colors.amberTint, border: 'rgba(232,160,48,0.35)', icon: <AlertTriangle size={16} strokeWidth={1.9} color="#9A6212" /> },
    red:   { bg: colors.redTint,   border: 'rgba(217,79,79,0.35)',  icon: <Ban size={16} strokeWidth={1.9} color={colors.red} /> },
    green: { bg: colors.greenTint, border: 'rgba(69,168,112,0.35)', icon: <CheckCircle2 size={16} strokeWidth={1.9} color={colors.green} /> },
  }

  /** The heading over the stored note: the same field means two different
   *  things depending on which decision wrote it. */
  const reviewNoteHeading = submission.status === 'rejected'
    ? 'Why this was rejected'
    : 'What the reviewer asked for'

  const clientLabel = orDash(submission.client_name ?? submission.bill_to_name)
  const grandTotalLabel = formatInr(toNumber(submission.grand_total))
  /** The standard requirement in rupees, through the ONE shared formula. */
  const standardAdvanceLabel = advance.standardAmount

  return (
    <OrdersLayout
      profile={profile}
      title={clientLabel}
      // The subtitle states what this record IS now. It used to say "Not
      // submitted for approval", which became a false statement the moment a
      // record could be submitted, and the page would have gone on saying it
      // over a rejected PI.
      subtitle={`Saved PI submission · ${draftStatusLabel(submission.status)}`}
      onSignOut={handleSignOut}
      // The header control re-reads in place: the record stays on screen, the
      // scroll position is kept, and the spinner in the header is the feedback.
      onRefresh={() => loadDraft({ quiet: true })}
      actions={backButton}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '24px' }}>

        {justSaved && (
          <PiCard style={{ borderColor: 'rgba(69,168,112,0.4)' }}>
            <div style={{ padding: '14px 20px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
              <CheckCircle2 size={17} strokeWidth={1.8} color={colors.green} style={{ flexShrink: 0, marginTop: '1px' }} />
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                  Draft saved
                </div>
                <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5, marginTop: '2px' }}>
                  This is the copy the server verified and stored. It is listed under PI Drafts and can be
                  reopened at any time. No official order number has been assigned.
                </div>
              </div>
            </div>
          </PiCard>
        )}

        {/* ── Where this record stands ──

            One compact strip, above the overview it describes, and only when
            there is something to say: a draft gets none, because the badge in
            the card below already says "Draft" and a permanent banner repeating
            the state every record starts in is a line of screen spent on
            nothing.

            The management NOTE is not in here. It lives on the overview card,
            rendered verbatim, so a long paragraph is not squeezed into a strip
            built for a sentence — and so it is shown once rather than twice. */}
        {banner && (
          <PiCard style={{ borderColor: bannerTone[banner.tone].border }}>
            <div style={{
              padding: '13px 20px', display: 'flex', gap: '10px', alignItems: 'flex-start',
              background: bannerTone[banner.tone].bg,
            }}>
              <span style={{ flexShrink: 0, marginTop: '1px', display: 'flex' }}>
                {bannerTone[banner.tone].icon}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                  {banner.title}
                </div>
                <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5, marginTop: '2px' }}>
                  {banner.body}
                </div>
              </div>
            </div>
          </PiCard>
        )}

        {/* ── Draft overview ──

            Three bands, one scan order: what state this record is in, what file
            it came from and when, then who it is for and when it is due.

            The heading is "Draft overview" and not "PI Draft": the page title,
            its subtitle and the status badge already say what this is, and a
            fourth restatement was a line of the card spent on nothing. */}
        <PiCard>
          <PiCardHeader
            title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={15} strokeWidth={1.9} color={colors.red} />
                Draft overview
              </span>
            }
            right={
              // Present, legible, and not a banner. This is a state to note in
              // passing, not the subject of the page.
              <span style={{
                display: 'inline-flex', alignItems: 'center',
                padding: '2px 9px', borderRadius: '5px',
                fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
                background: tone.bg, color: tone.color, border: `1px solid ${tone.border}`,
              }}>
                {draftStatusLabel(submission.status)}
              </span>
            }
          />

          {/* The metadata strip: small facts about the FILE, not about the
              order. Four across on a desktop, two on a phone.

              The filename block is rendered only when there is a filename. A
              draft saved before the server recorded one has no file to name,
              and an "Original PI file —" block would be a labelled hole. */}
          <div style={{ padding: '13px 20px' }}>
            <div style={{
              display: 'grid',
              // Four across at most, so a fifth fact wraps onto its own row
              // rather than shrinking every block until none of them can be
              // read. Two across on a phone, as before.
              gridTemplateColumns: isMobile ? '1fr 1fr' : `repeat(${Math.min(3 + (workbookName ? 1 : 0) + (submittedAt ? 1 : 0), 4)}, minmax(0, 1fr))`,
              gap: '14px 18px',
            }}>
              <MetaItem
                icon={<Clock size={13} strokeWidth={1.9} />}
                label="Last saved"
                value={savedAt}
              />
              <MetaItem
                icon={<Package size={13} strokeWidth={1.9} />}
                label="Products"
                value={`${products.length} line${products.length === 1 ? '' : 's'}`}
              />
              <MetaItem
                icon={<User size={13} strokeWidth={1.9} />}
                label="Created by"
                value={createdBy ?? 'Not provided'}
              />
              {workbookName && (
                <MetaItem
                  icon={<FileSpreadsheet size={13} strokeWidth={1.9} />}
                  label="Original PI file"
                  value={workbookName}
                />
              )}
              {/* WHO SENT IT AND WHEN, on the record itself rather than only in
                  the banner — a returned or rejected PI still has a submission
                  behind it, and that is the fact a reviewer asks for first. The
                  time comes from submitted_at, which only the database's status
                  transition writes. */}
              {submittedAt && (
                <MetaItem
                  icon={<Send size={13} strokeWidth={1.9} />}
                  label="Submitted"
                  value={`${submittedAt}${draft.submitterName ? ` · ${draft.submitterName}` : ''}`}
                />
              )}
            </div>
          </div>

          {/* Order information — the same VALUES and the same wording as the
              import preview, because buildHeaderRows still produces them. What
              this page chooses is the arrangement: who the order is for on one
              row, when it happens on the next, three to a row so each field has
              the width to be read rather than guessed at.

              "Created by" is deliberately absent here — it is a fact about the
              document and lives in the strip above, so it is stated once. */}
          <div style={{ padding: '14px 20px 16px', borderTop: `1px solid ${colors.border}` }}>
            <div style={{
              fontSize: '11px', fontWeight: 700, color: colors.secondary,
              marginBottom: '12px',
            }}>
              Order information
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))',
              gap: '16px 20px',
            }}>
              {/* Row 1 — who it is for and where it goes. Heavier, because this
                  is what a reader checks first and compares across. */}
              <InfoField label="Client"    value={headerValue('client')} strong />
              <InfoField label="Bill to"   value={headerValue('billTo')} strong />
              <InfoField label="Ship to"   value={headerValue('shipTo')} strong />
              {/* Row 2 — the dates, as a quieter secondary band. */}
              <InfoField label="PI created"          value={headerValue('created')} />
              <InfoField label="Order confirmed"     value={headerValue('confirmed')} />
              <InfoField label="Dispatch commitment" value={headerValue('dispatch')} />
            </div>
          </div>

          {/* Management's own words, verbatim and prominent, on the card the
              employee reads first. The same column carries both decisions, so
              the heading says which one wrote it. */}
          {submission.review_note && (
            <div style={{
              padding: '12px 20px', borderTop: `1px solid ${colors.border}`,
              background: submission.status === 'rejected' ? colors.redTint : colors.amberTint,
            }}>
              <div style={{
                fontSize: '11px', fontWeight: 700, marginBottom: '2px',
                color: submission.status === 'rejected' ? '#991B1B' : '#9A6212',
              }}>
                {reviewNoteHeading}
              </div>
              <MultilineText style={{ fontSize: '12px', color: colors.primary, margin: 0 }}>
                {submission.review_note}
              </MultilineText>
            </div>
          )}
        </PiCard>

        {/* Products */}
        <PiCard>
          <PiCardHeader
            title="Products"
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {draft.unresolvedImages > 0 && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    padding: '2px 8px', borderRadius: '5px',
                    fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
                    background: colors.redTint, color: colors.red,
                    border: '1px solid rgba(217,79,79,0.25)',
                  }}>
                    {draft.unresolvedImages} image{draft.unresolvedImages === 1 ? '' : 's'} unavailable
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
              No product lines are stored against this draft.
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
                    <PiProductThumbnail {...representativeThumbnail(p.row)} size={PI_THUMBNAIL_SIZE.representativeCompact} />
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

                  {/* The cell renders its own heading, so the accent follows the
                      same rule it does on the desktop column. */}
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
                {/* The identical head the upload preview renders. */}
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

        {/* Commercial summary — the stored figures, through the shared rows
            builder. Nothing on this page recomputes a total. */}
        <PiCommercialSummary rows={buildCommercialRows(persistedCommercial(submission))} />

        {/* Saved diagnostics. Kept on the record at save time, so what the
            server thought of this document is still readable months later. */}
        {draft.blocking.length > 0 && (
          <PiCard style={{ borderColor: 'rgba(217,79,79,0.3)' }}>
            <div style={{
              padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
              background: colors.redTint,
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <AlertTriangle size={15} strokeWidth={2} color={colors.red} />
              <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                {BLOCKING_PANEL_TITLE}
              </div>
              <span style={{ marginLeft: 'auto', fontSize: '12px', color: colors.red, fontWeight: 600 }}>
                {draft.blocking.length}
              </span>
            </div>
            <PiDiagnosticList entries={draft.blocking} tone="red" />
            <div style={{ padding: '10px 20px', borderTop: `1px solid ${colors.border}`, fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
              Correct these in the Excel PI and upload it again from New Order. Nothing on this
              screen can be edited — the order must match the document the client was sent.
            </div>
          </PiCard>
        )}

        {draft.warnings.length > 0 && (
          <PiCard>
            <div style={{
              padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <Info size={15} strokeWidth={2} color={colors.amber} />
              <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                {WARNING_PANEL_TITLE}
              </div>
              <span style={{ marginLeft: 'auto', fontSize: '12px', color: colors.muted }}>
                {draft.warnings.length} recorded when this draft was saved
              </span>
            </div>
            <PiDiagnosticList entries={draft.warnings} tone="amber" />
          </PiCard>
        )}

        {/* ── The employee's actions ──

            One compact card, at the foot of the record, for the person who owns
            it. Present only while the record is theirs to act on — a draft or
            one management has returned — and absent entirely for everybody else,
            including a reviewer looking at somebody's draft.

            Submitting is guarded here by the stored blocking issues, which is a
            courtesy: submit_order_submission re-derives them, re-checks the
            workbook and every image in storage, and refuses on its own. */}
        {(actions.canSubmit || actions.canChangePi) && (
          <PiCard>
            <div style={{
              padding: '14px 20px',
              display: 'flex', gap: '14px', flexWrap: 'wrap',
              alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ minWidth: '220px', flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                  {submission.status === 'needs_changes'
                    ? 'Correct this PI and send it back'
                    : 'Ready for management?'}
                </div>
                <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5, marginTop: '2px' }}>
                  {draft.blocking.length > 0
                    ? 'The issues above must be fixed in the Excel PI first. Use Change PI to upload the corrected file.'
                    : 'Submitting hands this PI to management for review. Nothing is numbered and no order is created.'}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  className="boe-btn boe-btn-ghost"
                  onClick={() => router.push(changePiHref(submissionId))}
                  disabled={acting}
                >
                  <Upload size={13} strokeWidth={2} />
                  {CHANGE_PI_BUTTON_LABEL}
                </button>
                <button
                  className="boe-btn boe-btn-primary"
                  onClick={() => { setActionFailure(null); setDialog('submit') }}
                  disabled={acting || draft.blocking.length > 0}
                  title={draft.blocking.length > 0 ? 'Fix the issues in the PI first' : undefined}
                >
                  <Send size={13} strokeWidth={2} />
                  {SUBMIT_BUTTON_LABEL}
                </button>
              </div>
            </div>
          </PiCard>
        )}

        {/* ── The management review bar ──

            Shown to a holder of orders.approve_order, and only while the record
            is actually submitted. Three controls, one of which does nothing yet
            and says so: approval is the phase that creates an Order, allocates a
            number and settles the advance rule, and none of that exists. A
            control that looked live and then failed would be worse than one that
            explains why it is waiting. */}
        {showReviewCard && (
          <PiCard style={{ borderColor: 'rgba(85,133,232,0.35)' }}>
            <div style={{
              padding: '14px 20px',
              display: 'flex', gap: '14px', flexWrap: 'wrap',
              alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ minWidth: '220px', flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                  Management review
                </div>
                <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5, marginTop: '2px' }}>
                  Send it back with a note, or reject it with a reason. Both are recorded against this PI.
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span
                  title={APPROVE_DISABLED_REASON}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    padding: '6px 12px', borderRadius: '7px',
                    fontSize: '12.5px', fontWeight: 600,
                    background: colors.raised, color: colors.muted,
                    border: `1px solid ${colors.border}`,
                    cursor: 'not-allowed',
                  }}
                >
                  <Lock size={12} strokeWidth={2} />
                  {APPROVE_BUTTON_LABEL}
                  <span style={{ fontSize: '11px', fontWeight: 500 }}>· {APPROVE_DISABLED_REASON}</span>
                </span>

                <button
                  className="boe-btn boe-btn-ghost"
                  onClick={() => { setActionFailure(null); setDialog('needs_changes') }}
                  disabled={acting}
                >
                  <Undo2 size={13} strokeWidth={2} />
                  {REQUEST_CHANGES_BUTTON_LABEL}
                </button>
                <button
                  className="boe-btn boe-btn-ghost"
                  onClick={() => { setActionFailure(null); setDialog('reject') }}
                  disabled={acting}
                  style={{ color: colors.red, borderColor: 'rgba(217,79,79,0.35)' }}
                >
                  <Ban size={13} strokeWidth={2} />
                  {REJECT_BUTTON_LABEL}
                </button>
              </div>
            </div>

            {/* ── The advance requirement, in the SAME card and visually its
                own band ──

                Same card, because it is part of one review and a reviewer
                should not have to look elsewhere for the commercial condition
                they are being asked about. Separated by a rule and a quieter
                ground, because the two decisions are genuinely different: the
                controls above act on the PI, and the controls below act on one
                term of it. Deciding an advance exception is NOT approving the
                PI, and the disabled "Approve" above says so by staying
                disabled either way. */}
            {showAdvance && (
              <div style={{
                padding: '13px 20px',
                borderTop: `1px solid ${colors.border}`,
                background: colors.raised,
              }}>
                {advanceSection}
              </div>
            )}
          </PiCard>
        )}

        {/* ── The advance requirement, for everybody else ──

            The same section as a card of its own, for a viewer who does not get
            the review bar above: the employee reading their own record, a
            read-only viewer, and — importantly — somebody who holds
            orders.approve_advance_exception WITHOUT orders.approve_order. That
            last person has a decision to take and no review card to take it in,
            which is exactly why the two authorities being independent has to be
            reflected here rather than assumed away. */}
        {!showReviewCard && showAdvance && (
          <PiCard style={advanceActions.canDecide ? { borderColor: 'rgba(232,160,48,0.4)' } : undefined}>
            <div style={{ padding: '13px 20px' }}>
              {advanceSection}
            </div>
          </PiCard>
        )}

        {/* ── Activity ──

            The append-only trail, read under the same RLS as everything else on
            this page, newest first. It is a history and not a control: no ids,
            no raw metadata, no status enums — just what happened, who did it,
            when, and whatever note they left. */}
        <PiCard>
          <PiCardHeader
            title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <History size={15} strokeWidth={1.9} color={colors.tertiary} />
                Activity
              </span>
            }
            right={
              <span style={{ fontSize: '12px', color: colors.muted, whiteSpace: 'nowrap' }}>
                {draft.activity.length} event{draft.activity.length === 1 ? '' : 's'}
              </span>
            }
          />
          {draft.activity.length === 0 ? (
            <div style={{ padding: '16px 20px', fontSize: '12px', color: colors.secondary }}>
              No activity has been recorded against this PI yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {draft.activity.map((entry, i) => (
                <div
                  key={entry.key}
                  style={{
                    padding: '11px 20px',
                    borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
                    display: 'flex', flexDirection: 'column', gap: '3px',
                  }}
                >
                  <div style={{
                    display: 'flex', gap: '10px', flexWrap: 'wrap',
                    alignItems: 'baseline', justifyContent: 'space-between',
                  }}>
                    <span style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>
                      {entry.label}
                    </span>
                    <span style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>
                      {entry.at}
                    </span>
                  </div>
                  <div style={{ fontSize: '11.5px', color: colors.secondary }}>
                    {entry.actor}
                    {/* The percentage and the amount it came to — the business
                        fact of an advance event, and the only two metadata keys
                        this screen ever reads. */}
                    {entry.figures && (
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}> · {entry.figures}</span>
                    )}
                  </div>
                  {entry.detail && (
                    <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.45 }}>
                      {entry.detail}
                    </div>
                  )}
                  {entry.note && (
                    <MultilineText style={{
                      fontSize: '12px', color: colors.secondary, margin: '2px 0 0',
                      paddingLeft: '10px', borderLeft: `2px solid ${colors.border}`,
                    }}>
                      {entry.note}
                    </MultilineText>
                  )}
                </div>
              ))}
            </div>
          )}
        </PiCard>

        <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.6, padding: '0 4px' }}>
          This is the stored copy of the PI, read back from the server. It carries no official order
          number: numbering happens only after management approval.
        </div>
      </div>

      {dialog === 'submit' && (
        <PiSubmitConfirmModal
          client={clientLabel}
          grandTotal={grandTotalLabel}
          grandTotalValue={grandTotalValue}
          standardAdvance={standardAdvanceLabel}
          // The dialog opens on whatever the record already says, so a PI
          // returned for an unrelated correction does not silently switch the
          // employee's advance condition while they fix something else.
          initialAdvance={initialAdvanceSelection(submission)}
          submitting={acting}
          failure={actionFailure}
          offerReply={submissionOffersReply(submission.status)}
          onCancel={closeDialog}
          onConfirm={submitForApproval}
        />
      )}

      {(dialog === 'needs_changes' || dialog === 'reject' || dialog === 'reject_exception') && (
        <PiNoteModal
          intent={dialog}
          client={clientLabel}
          saving={acting}
          failure={actionFailure}
          onCancel={closeDialog}
          onConfirm={note => {
            if (dialog === 'reject') rejectSubmission(note)
            else if (dialog === 'reject_exception') rejectException(note)
            else requestChanges(note)
          }}
        />
      )}

      {viewerItem && nav && (
        <PiImageViewer
          key={viewerItem.key}
          item={viewerItem}
          nav={nav}
          onClose={closeViewer}
          onPrev={() => stepViewer(nav.prevIndex)}
          onNext={() => stepViewer(nav.nextIndex)}
        />
      )}
    </OrdersLayout>
  )
}
