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
//
// HOW THE SCREEN IS ARRANGED, AND WHY IT WAS REARRANGED
// ----------------------------------------------------
// This is one of the most-used pages in the application, and it used to be read
// in the wrong order. The top of it was nearly empty on a desktop, the total and
// the advance condition were buried in a card at the bottom, and every ACTION —
// the employee's submit, the reviewer's send-back, the advance decision — sat
// BELOW the product table. A person opening a PI had to scroll past twelve
// products to discover whether anything was being asked of them, and a reviewer
// had to scroll past them again to find the figure they were deciding on.
//
// The scan order is now the order the questions are actually asked in:
//
//   1  identity      which client, which PI, what state, how big, which file
//   2  overview      who and where · when · WHAT IT IS WORTH and on what
//                    advance condition — all three above the fold
//   3  workflow      what is being asked of THIS viewer, and the controls for it,
//                    with the advance decision as its own band inside the panel
//   4  blocking      why the primary action is disabled, if it is
//   5  products      UNCHANGED — same columns, same head, same thumbnails,
//                    same customization accent, same viewer, same mobile cards
//   6  lower grid    commercial breakdown beside the activity trail
//   7  warnings      quieter than blocking, and out of the way of the actions
//   8  footnote      one muted line
//
// WHAT MOVED OUT OF THIS FILE, AND WHAT DID NOT. The page kept everything with
// authority behind it — the reads, the capability derivation, the RPCs, the
// image signing, the viewer state — and handed the drawing to two page-owned
// modules beside it: ./piDetailView decides what the screen SAYS (pure, tested)
// and ./piDetailSections draws it (presentational, tested by rendering). The
// three-breakpoint arrangement is the `pi-detail-` block at the foot of
// globals.css — the same page-scoped convention the payroll guide uses — so the
// page still has exactly ONE width probe in JavaScript and it is the table's.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
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
  PiCommercialSummary,
  PiImageViewer,
  PI_THUMBNAIL_SIZE,
  type PiThumbnailProps,
} from '@/components/orders/piPreview'
import {
  PiBillingPercentageModal,
  PiClientDetailsEditModal,
  PiProductEditModal,
  PiProductReorderModal,
  PI_CHANGE_PI_ONLY,
  PiClientDetailsModal,
  PiRequestCorrectionModal,
  PiScheduleTermsEditModal,
  PiSubmitConfirmModal,
  PiNoteModal,
  PiFinanceVerifyModal,
  PiApproveOrderModal,
  type PiNoteIntent,
} from '@/components/orders/piReviewModals'
import { colors } from '@/lib/tokens'
import type {
  PiClientFieldValues,
  PiCorrectionSection,
  PiEditSection,
  PiProductFieldValues,
  PiScheduleFieldValues,
} from '@/components/orders/piReviewModals'
import { piReadiness, piReadinessIsEditable } from '@/lib/orders/piReadiness'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import { deriveFinanceCapabilities } from '@/lib/permissions/finance'
import { AddPiPaymentModal, PiPaymentDetailsModal } from '@/components/orders/PiPaymentCard'
import {
  PI_PAYMENT_PROOF_FAILED,
  PI_PAYMENT_RECORDED_BODY,
  canAddPiPayment,
  formatMoney,
  formatPercent,
  isAwaitingVerification,
  loadPiPaymentSummary,
  recordPiPayment,
  type PiPaymentFormState,
  type PiPaymentSummary,
} from '@/lib/finance/piPaymentView'
import { attachPaymentProof, paymentProofSignedUrl } from '@/lib/finance/paymentProof'
import { fetchAllRows } from '@/lib/supabasePaging'
import {
  changePiHref,
  submissionOffersReply,
  describeSubmissionActions,
  describeSubmissionFailure,
  type SubmissionAction,
} from '@/lib/orders/submissionWorkflow'
import {
  PI_ACTIVITY_COLUMNS,
  activityActorIds,
  describeActivityEntries,
  latestSubmissionReply,
  type ActivityEntry,
  type PersistedActivity,
} from '@/lib/orders/submissionActivity'
import {
  ADVANCE_REJECTED_INSTRUCTION,
  describeAdvance,
  describeAdvanceActions,
} from '@/lib/orders/advanceRequirement'
import { asPaymentPosition } from '@/lib/orders/paymentGate'
import { notifyPiSubmission } from '@/lib/notify'
import {
  describeApprovalReadiness,
  describeFinanceStatus,
  financeVerificationIsCurrent,
  orderHref,
  readApprovalOutcome,
} from '@/lib/orders/finalApproval'
import {
  buildCommercialRows,
  buildHeaderRows,
  buildImageViewerItems,
  formatInr,
  formatPiDate,
  orDash,
  viewerNav,
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
} from '@/lib/orders/draftsView'
// ── The page's own view layer ──
//
// What the screen SAYS lives in piDetailView (pure, tested); what it DRAWS lives
// in piDetailSections (presentational, tested by rendering); how it is arranged
// at three breakpoints lives in the CSS module. This file keeps the reads, the
// permissions and the RPCs, which is the part that has authority behind it.
import {
  describeAdvanceForReview,
  buildApprovalSummary,
  buildBillingSummary,
  buildClientDetails,
  buildDateSummary,
  buildOwnership,
  buildPaymentSummaryView,
  commercialBreakdownRows,
  summaryCommercialFigures,
  describeApprovedOrder,
  describeWorkflowPanel,
  omitDash,
} from './piDetailView'
import {
  PiActivityTimeline,
  PiAdvanceBand,
  PiBlockingPanel,
  PiLowerGrid,
  PiSummaryCard,
  PiSavedStrip,
  PiStoredCopyNote,
  PiWarningPanel,
  PiWorkflowPanel,
  statusTone,
} from './piDetailSections'

const MOBILE_BREAKPOINT = 768

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
  /** Who verified the figures for finance, when there is a verification. */
  financeVerifierName: string | null
  /**
   * The official number of the Order this PI became, or null.
   *
   * NULL IS A REAL ANSWER, not a failure: an Order is visible to its requester,
   * to operations, to an admin and to a holder of orders.view_all, and a finance
   * verifier is none of those. Read from public.orders under the caller's own
   * RLS, never reconstructed here — the browser has no opinion about an Order
   * number and must not acquire one.
   */
  orderDisplayNumber: string | null
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

  // ── Payments against this PI ──
  // Loaded and refreshed on its OWN, so recording a payment never re-reads the
  // whole submission, its items, its images and its signed workbook URL.
  const [payments, setPayments]           = useState<PiPaymentSummary | null>(null)
  const [paymentsLoading, setPaymentsLoading] = useState(true)
  const [paymentSaving, setPaymentSaving] = useState(false)
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null)
  const [canAllocatePayment, setCanAllocatePayment] = useState(false)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  /** Which payment dialog is open, if either. The summary card opens both. */
  const [paymentDialog, setPaymentDialog] = useState<'details' | 'add' | null>(null)
  // The client dialog behind the name in the summary card. Nothing is
  // fetched for it — it reads the submission the page already holds.
  const [clientDialog, setClientDialog] = useState(false)
  // The billing-percentage editor, and its own in-flight and failure state. It
  // writes, so it cannot share the read-only client dialog's shape.
  /**
   * can_edit_order_submission's own answer for this viewer and this record.
   * Resolved with the page's other reads and refreshed by every reload, so a
   * record that leaves draft stops offering the control without a new request.
   */
  const [canEditSubmission, setCanEditSubmission] = useState(false)
  /**
   * can_admin_edit_order_submission's answer: an ACTIVE ADMIN, at any stage.
   *
   * Kept as its own value rather than folded into the one above, because the
   * two are not the same authority and the difference is visible to the reader:
   * an admin amending a submitted PI must give a reason, and an owner shaping
   * their own draft must not be asked for one.
   */
  const [canAdminAmend, setCanAdminAmend] = useState(false)
  /** null = closed; otherwise the section being edited. */
  const [editSection, setEditSection] = useState<PiEditSection | null>(null)
  /**
   * WHICH PRODUCT LINE, not just "the products section".
   *
   * update_order_submission_item_details writes ONE line, so the dialog is
   * opened against one line and the id is the state. Reordering is a separate
   * write over every line at once, so it is a separate flag rather than a
   * fourth section.
   */
  const [productEditId, setProductEditId] = useState<string | null>(null)
  const [reorderOpen, setReorderOpen] = useState(false)
  const [productSaving, setProductSaving] = useState(false)
  const [productFailure, setProductFailure] = useState<string | null>(null)
  const clientEditOpen = editSection === 'client'
  const [clientSaving, setClientSaving] = useState(false)
  const [clientFailure, setClientFailure] = useState<string | null>(null)
  /**
   * The row version the page last READ, held separately from the load state so
   * the save callback can close over it without depending on where the
   * submission binding happens to be derived.
   */
  const [rowVersion, setRowVersion] = useState<number | null>(null)
  const [correctionOpen, setCorrectionOpen] = useState(false)
  const [correctionSaving, setCorrectionSaving] = useState(false)
  const [correctionFailure, setCorrectionFailure] = useState<string | null>(null)
  const [billingDialog, setBillingDialog] = useState(false)
  const [billingSaving, setBillingSaving] = useState(false)
  const [billingFailure, setBillingFailure] = useState<string | null>(null)

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
  /**
   * can_verify_pi_finance() — the SEPARATE finance authority.
   *
   * Resolved from the FINANCE module, not from Orders: finance.approve with
   * Finance module entry, exactly as deriveFinanceCapabilities has it and
   * exactly as the database's own can_verify_pi_finance() has it. An active
   * admin holds it either way. orders.approve_order confers nothing here, which
   * is the whole point of the two-authority rule.
   */
  const [canVerifyFinance, setCanVerifyFinance] = useState(false)

  /** Which decision dialog is open, if any. */
  const [dialog, setDialog] = useState<'submit' | 'verify_finance' | 'approve' | PiNoteIntent | null>(null)
  const [acting, setActing] = useState(false)
  const [actionFailure, setActionFailure] = useState<string | null>(null)
  /**
   * What the approval RPC returned, kept ONLY so the number is on screen the
   * instant the call commits.
   *
   * It is not the source of truth and never outranks the record: loadDraft
   * re-reads public.orders under the caller's own RLS immediately afterwards,
   * and the strip prefers that value. This exists for the one case the re-read
   * cannot cover — an approver who created the Order but cannot select it — so
   * the person who just pressed the button is still told the number they
   * allocated.
   */
  const [approval, setApproval] = useState<ReturnType<typeof readApprovalOutcome>>(null)

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

    const [itemsResult, imagesResult, editableResult, adminEditResult] = await Promise.all([
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
      /**
       * MAY THIS VIEWER STILL EDIT THIS RECORD — asked of the database, which is
       * the only thing that actually decides.
       *
       * describeSubmissionActions answers this for the OWNER, and correctly, but
       * can_edit_order_submission also admits an active admin. Restating that
       * second branch in the browser would mean reading users.role here, which
       * this page deliberately does not do, and would put a copy of an authority
       * rule somewhere it could drift from the original. So the original is
       * called instead: it is `security definer`, granted to `authenticated`,
       * revoked from anon, and takes nothing but a submission id.
       *
       * IN THE EXISTING PARALLEL LOAD, not on demand: one more round trip that
       * already overlaps two others, rather than a request each time a dialog
       * opens. A failure resolves to false — the control disappears, and the RPC
       * behind it would refuse anyway.
       */
      supabase.rpc('can_edit_order_submission', { p_submission_id: submissionId }),
      // THE SECOND AUTHORITY, asked separately because it answers a different
      // question. can_edit_order_submission is the OWNER rule and is false the
      // moment a PI is submitted — for everybody, admins included, because the
      // actor test sits behind the state test. An active admin may correct a PI
      // at any stage, and only can_admin_edit_order_submission knows that.
      supabase.rpc('can_admin_edit_order_submission', { p_submission_id: submissionId }),
    ])

    if (itemsResult.error || imagesResult.error) { setLoad({ kind: 'failed' }); return }

    // FAIL CLOSED. A capability that could not be resolved is not a capability.
    setCanEditSubmission(editableResult.error ? false : editableResult.data === true)
    setCanAdminAmend(adminEditResult.error ? false : adminEditResult.data === true)

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
      row.finance_verified_by,
      row.approved_by,
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

    // ── The Order this PI became ──
    //
    // One read, only when the record actually names an Order, and under the
    // CALLER'S OWN RLS: a viewer who may not see the Order gets no row, no
    // number and no link, rather than a number they were not entitled to. A
    // failure here is not a page failure — the PI is still readable and still
    // says it was approved.
    let orderDisplayNumber: string | null = null
    if (row.order_id) {
      const { data: order } = await supabase
        .from('orders')
        .select('display_number')
        .eq('id', row.order_id)
        .maybeSingle()
      const number = (order as { display_number?: string | null } | null)?.display_number
      orderDisplayNumber = typeof number === 'string' && number.trim() !== '' ? number.trim() : null
    }

    // The version this render is based on, for optimistic concurrency.
    setRowVersion(typeof row.row_version === 'number' ? row.row_version : null)

    setLoad({
      kind: 'ready',
      draft: {
        submission: row,
        financeVerifierName: row.finance_verified_by
          ? namesById.get(row.finance_verified_by) ?? null : null,
        orderDisplayNumber,
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

      // THE PROFILE JOINS THE TWO PERMISSION READS rather than preceding them.
      // All three need only the session's user id, and the draft below needs
      // the capabilities, so this is the difference between three waits and two.
      //
      // A failed permission read still resolves to no capabilities, so the page
      // falls back to what it has always been — a read-only record — rather than
      // offering a control the caller may not have.
      //
      // TWO MODULES, TWO READS, because this screen carries two authorities that
      // must not imply one another. A failure on either resolves to no
      // capabilities for that module alone, so a Finance outage cannot cost
      // somebody their PI review controls and vice versa.
      const [{ data: me }, ordersPermissions, financePermissions] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
          .eq('id', session.user.id)
          .single(),
        getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => []),
        getEffectivePermissions(supabase, session.user.id, 'finance').catch(() => []),
      ])
      const role = (me as UserProfile | null)?.role
      const caps = deriveOrdersCapabilities(role, ordersPermissions)
      const financeCaps = deriveFinanceCapabilities(role, financePermissions)

      if (!active) return
      setProfile((me as UserProfile) ?? null)
      setViewerId(session.user.id)
      setCanCreate(caps.canCreateOrder)
      setCanReview(caps.canApproveOrderSubmission)
      setCanDecideAdvance(caps.canApproveAdvanceException)
      // canApprovePayment IS finance.approve gated on Finance module entry —
      // deriveFinanceCapabilities' withEntry('approve'). The same expression
      // can_verify_pi_finance() evaluates in the database.
      setCanVerifyFinance(financeCaps.canApprovePayment)
      // finance.allocate — the PROTECTED action, never a preset, and the only
      // Finance capability that opens payment entry. Wider Finance access
      // (view, view_all, approve, manage) deliberately does not, which is the
      // same rule record_pi_submission_payment() enforces server-side.
      setCanAllocatePayment(financeCaps.canAllocatePayment)
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

  // ── Payments: load, record, open a proof ─────────────────────────────────
  //
  // ONE round trip, and it is the DATABASE that computes every total: the RPC
  // returns the rows and the five figures already summed in numeric. Nothing
  // here re-derives money, and no unbounded Finance query is ever issued.
  const loadPayments = useCallback(async () => {
    // A caller who may not read payments simply gets no card content. This is
    // never fatal to the page: the PI itself is a separate read.
    setPayments(await loadPiPaymentSummary(supabase, submissionId))
    setPaymentsLoading(false)
  }, [supabase, submissionId])

  // The same shape every other load on this page uses: an inner async runner and
  // an `active` guard, so a navigation away mid-flight cannot set state on an
  // unmounted screen — and so no setState happens synchronously in the effect
  // body.
  useEffect(() => {
    let active = true
    const run = async () => {
      const next = await loadPiPaymentSummary(supabase, submissionId)
      if (!active) return
      setPayments(next)
      setPaymentsLoading(false)
    }
    void run()
    return () => { active = false }
  }, [supabase, submissionId])

  /**
   * Records one payment, then uploads its optional proof.
   *
   * THE ORDER MATTERS AND IS DELIBERATE. The payment and its allocation are
   * written atomically by the RPC; the proof needs the payment id that only
   * exists afterwards, and the storage policy authorizes the upload precisely
   * because the row is now there with this caller as its submitter. So a proof
   * failure is reported and the PAYMENT IS KEPT — rolling back a recorded
   * payment because a file did not upload would lose the fact that matters.
   */
  const recordPayment = useCallback(async (
    form: PiPaymentFormState,
    proof: File | null,
  ): Promise<string | null> => {
    setPaymentSaving(true)
    try {
      // The raw database error is consumed inside recordPiPayment and never
      // reaches this file — the PI screens show a fixed sentence, never the
      // database's own words.
      const result = await recordPiPayment(supabase, submissionId, form)
      if (!result.ok) return result.message

      const paymentId = result.paymentRequestId
      let notice = PI_PAYMENT_RECORDED_BODY

      if (proof && paymentId) {
        // The payment is already recorded and committed. A proof failure is
        // REPORTED, never compensated by undoing the payment — see the helper.
        const proofError = await attachPaymentProof(supabase, {
          paymentRequestId: paymentId,
          file: proof,
          userId: viewerId,
        })
        if (proofError) notice = PI_PAYMENT_PROOF_FAILED
      }

      setPaymentNotice(notice)
      // ONLY the payment section is refreshed. The submission, its items, its
      // images and its signed workbook URL are untouched.
      await loadPayments()
      return null
    } finally {
      setPaymentSaving(false)
    }
  }, [supabase, submissionId, viewerId, loadPayments])

  const openPaymentProof = useCallback(async (paymentId: string) => {
    const url = await paymentProofSignedUrl(supabase, paymentId)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }, [supabase])

  /**
   * Submit, with the employee's optional reply on a resubmission.
   *
   * FOUR RPCs, ONE IMPLEMENTATION. The database keeps the original
   * submit_order_submission(uuid), submit_order_submission_with_note(uuid, text)
   * and the percentage-carrying submit_order_submission_with_advance(...), and
   * adds submit_order_submission_with_advance_amount(...) for the declared
   * AMOUNT this screen sends. All four are one line over the same internal
   * function, so the actor, ownership, state, permission and completeness checks
   * are identical whichever door is used.
   *
   * THE AMOUNT IS SENT AND THE PERCENTAGE IS NOT. The database derives the
   * percentage from the amount and the persisted grand total, so a browser
   * cannot send two figures that disagree — and cannot send a percentage at all.
   */
  const submitForApproval = useCallback((
    note: string | null,
    terms: { reason: string | null; paymentTerms: string | null; billingTerms: string | null },
  ) => runAction('submit', async () => {
    const { data, error } = await supabase.rpc('submit_pi_for_review', {
      p_submission_id: submissionId,
      p_note: note,
      p_reason: terms.reason,
      p_payment_terms: terms.paymentTerms,
      p_billing_terms: terms.billingTerms,
    })
    if (!error) {
      // WHO IS TOLD FOLLOWS THE ROUTE THE DATABASE CHOSE, never the one the
      // browser guessed: `exception_requested` comes back from the RPC and is
      // true only when a fresh decision is actually waiting on somebody.
      const requested =
        (data as { exception_requested?: boolean } | null)?.exception_requested === true
      // The card's figures move with the submission (the exception state is part
      // of the position), so the payment section is re-read alongside the record.
      await loadPayments()
      // Fire-and-forget: the submission has already committed, and a
      // notification problem must never undo it.
      if (requested) {
        void notifyPiSubmission({ event: 'pi_exception_requested', submissionId })
      }
    }
    return { error }
  }), [runAction, supabase, submissionId, loadPayments])

  /**
   * Accept the proposed advance. THE PI STAYS UNDER REVIEW.
   *
   * No note, by design: approving the condition the employee asked for adds
   * nothing that the decision itself does not already say, and a mandatory field
   * on the positive path is friction for its own sake. The refusal is the one
   * that needs words.
   */
  /**
   * DECLARE, CHANGE OR CLEAR THE BILLING PERCENTAGE.
   *
   * Not through runAction: that one owns the workflow dialog and this editor
   * keeps its own in-flight and failure state, so a validation refusal can be
   * shown inside the dialog with the typed value still on screen.
   *
   * `null` is the clear. The RPC re-derives the authority and the bounds, so a
   * refusal here is the database's answer and not a second opinion.
   */
  const saveBillingPercentage = useCallback(async (value: number | null, reason?: string | null) => {
    if (billingSaving) return
    setBillingSaving(true)
    setBillingFailure(null)
    try {
      const { error } = await supabase.rpc('set_order_submission_billing_percentage', {
        p_submission_id: submissionId,
        p_percentage: value,
        // THE REASON TRAVELS WITH THE WRITE. The database decides whether it is
        // required — an owner shaping a draft needs none, an admin amending a
        // submitted PI does — so this passes whatever was collected and lets
        // ORDER_SUBMISSION_BILLING_REASON_REQUIRED be the authority on it.
        p_reason: reason ?? null,
      })
      if (error) {
        setBillingFailure(
          (error as { message?: string }).message
          ?? 'The billing percentage could not be saved.')
        return
      }
      setBillingDialog(false)
      await loadDraft({ quiet: true })
    } finally {
      setBillingSaving(false)
    }
  }, [billingSaving, supabase, submissionId, loadDraft])

  /**
   * SUPPLY OR CORRECT THE CLIENT AND PARTY DETAILS.
   *
   * Sends only what changed, and the row version it was read at. The RPC
   * re-derives the authority, the staleness and every field rule, so a refusal
   * here is the database's answer and this shows it rather than substituting a
   * sentence of its own — that substitution is exactly what made a missing
   * environment variable look like a refusal on the Order screen.
   */
  const saveClientDetails = useCallback(async (
    changed: PiClientFieldValues,
    reason: string | null,
  ) => {
    if (clientSaving) return
    setClientSaving(true)
    setClientFailure(null)
    try {
      const { error } = await supabase.rpc('update_order_submission_client_details', {
        p_submission_id: submissionId,
        p_fields: changed,
        // The version this dialog was opened at. A concurrent edit moves it and
        // the write is refused instead of silently winning.
        p_expected_version: rowVersion,
        p_reason: reason,
      })
      if (error) {
        setClientFailure((error as { message?: string }).message
          ?? 'The details could not be saved.')
        return
      }
      setEditSection(null)
      await loadDraft({ quiet: true })
    } finally {
      setClientSaving(false)
    }
  }, [clientSaving, supabase, submissionId, rowVersion, loadDraft])

  /**
   * SAVE THE DATES AND TERMS.
   *
   * Its own RPC and therefore its own transaction, exactly like the client
   * section. One dialog per section rather than one form over both: a single
   * button firing two round trips could leave the PI half-updated with nothing
   * on screen to say which half.
   */
  const saveScheduleTerms = useCallback(async (
    changed: PiScheduleFieldValues,
    reason: string | null,
  ) => {
    if (clientSaving) return
    setClientSaving(true)
    setClientFailure(null)
    try {
      const { error } = await supabase.rpc('update_order_submission_schedule_terms', {
        p_submission_id: submissionId,
        p_fields: changed,
        p_expected_version: rowVersion,
        p_reason: reason,
      })
      if (error) {
        setClientFailure((error as { message?: string }).message
          ?? 'The dates and terms could not be saved.')
        return
      }
      setEditSection(null)
      await loadDraft({ quiet: true })
    } finally {
      setClientSaving(false)
    }
  }, [clientSaving, supabase, submissionId, rowVersion, loadDraft])

  /**
   * CORRECT ONE PRODUCT LINE'S DESCRIPTION.
   *
   * Its own RPC, its own transaction, and its own row version — the item's, not
   * the submission's. The RPC refuses every money key BY NAME with the reason,
   * so a payload that somehow carried a quantity is rejected rather than
   * quietly ignored; this sends only descriptive fields in the first place.
   */
  const saveProductDetails = useCallback(async (
    itemId: string,
    changed: PiProductFieldValues,
    reason: string | null,
  ) => {
    if (productSaving) return
    setProductSaving(true)
    setProductFailure(null)
    try {
      const { error } = await supabase.rpc('update_order_submission_item_details', {
        p_item_id: itemId,
        p_fields: changed,
        p_expected_version: rowVersion,
        p_reason: reason,
      })
      if (error) {
        setProductFailure((error as { message?: string }).message
          ?? 'The product line could not be saved.')
        return
      }
      setProductEditId(null)
      await loadDraft({ quiet: true })
    } finally {
      setProductSaving(false)
    }
  }, [productSaving, supabase, rowVersion, loadDraft])

  /**
   * CHANGE THE ORDER THE LINES ARE PRINTED IN.
   *
   * One write over every line, so it cannot half-apply. The RPC requires the
   * full set of ids — a partial list is refused — which is what stops a stale
   * dialog from dropping a line that was added since it opened.
   */
  const saveProductOrder = useCallback(async (
    orderedIds: string[],
    reason: string | null,
  ) => {
    if (productSaving) return
    setProductSaving(true)
    setProductFailure(null)
    try {
      const { error } = await supabase.rpc('reorder_order_submission_items', {
        p_submission_id: submissionId,
        p_item_ids: orderedIds,
        p_expected_version: rowVersion,
        p_reason: reason,
      })
      if (error) {
        setProductFailure((error as { message?: string }).message
          ?? 'The order of the lines could not be saved.')
        return
      }
      setReorderOpen(false)
      await loadDraft({ quiet: true })
    } finally {
      setProductSaving(false)
    }
  }, [productSaving, supabase, submissionId, rowVersion, loadDraft])

  /**
   * THE OWNER ASKS FOR A CORRECTION.
   *
   * Writes no PI data — the RPC is proved not to, and the dialog says so. The
   * notification goes through the SAME server route the exception events use,
   * which resolves recipients from the database's own authority rather than
   * letting a browser name who hears about it.
   */
  const sendCorrectionRequest = useCallback(async (
    section: PiCorrectionSection, change: string, reason: string,
  ) => {
    if (correctionSaving) return
    setCorrectionSaving(true)
    setCorrectionFailure(null)
    try {
      const { error } = await supabase.rpc('request_order_submission_correction', {
        p_submission_id: submissionId,
        p_section: section,
        p_requested_change: change,
        p_reason: reason,
      })
      if (error) {
        setCorrectionFailure((error as { message?: string }).message
          ?? 'The request could not be sent.')
        return
      }
      setCorrectionOpen(false)
      void notifyPiSubmission({ event: 'pi_correction_requested', submissionId })
      await loadDraft({ quiet: true })
    } finally {
      setCorrectionSaving(false)
    }
  }, [correctionSaving, supabase, submissionId, loadDraft])

  const approveException = useCallback(() => runAction('approve_exception', async () => {
    const { error } = await supabase.rpc('approve_pi_advance_exception', {
      p_submission_id: submissionId,
    })
    if (!error) {
      // The position changes with the decision, so the card is re-read; the
      // owner is told, because the outcome is theirs to act on.
      await loadPayments()
      void notifyPiSubmission({ event: 'pi_exception_approved', submissionId })
    }
    return { error }
  }), [runAction, supabase, submissionId, loadPayments])

  const rejectException = useCallback((reason: string) => runAction('reject_exception', async () => {
    const { error } = await supabase.rpc('reject_pi_advance_exception', {
      p_submission_id: submissionId,
      p_reason: reason,
    })
    if (!error) {
      await loadPayments()
      void notifyPiSubmission({ event: 'pi_exception_rejected', submissionId })
    }
    return { error }
  }), [runAction, supabase, submissionId, loadPayments])

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

  /**
   * Finance signs off the commercial figures. NOTHING ELSE HAPPENS.
   *
   * No note, because verification is a yes and there is nothing to explain — if
   * something is wrong with the figures the PI goes back through Needs Changes,
   * which already asks for words. No payment, request or receipt is created
   * anywhere in this flow, and the dialog behind the button says so.
   *
   * The RPC is idempotent, so a request that survives both the ref guard and the
   * disabled button records no second verification and writes no second event.
   */
  const verifyFinance = useCallback(() => runAction('verify_finance', async () => {
    const { error } = await supabase.rpc('verify_pi_finance_check', {
      p_submission_id: submissionId,
    })
    return { error }
  }), [runAction, supabase, submissionId])

  /**
   * The last decision, and the one that creates the Order.
   *
   * ONE RPC CALL, AND IT IS THE AUTHORITY. Every eligibility rule the screen has
   * just drawn a control from — the status, the permission, the finance
   * verification, the advance requirement, the diagnostics, the stored workbook
   * and images, the absence of a deletion reservation and of an existing Order —
   * is re-derived inside approve_order_submission() under a row lock, on the
   * values the database holds. A stale screen, a second tab, a replayed request
   * and a hand-crafted call all end at the same lock and the same answer.
   *
   * THE NUMBER IS READ BACK, NEVER COMPUTED. What the RPC returns is what the
   * allocator assigned; readApprovalOutcome refuses a response missing it rather
   * than filling in a plausible one, and the page then falls back to re-reading
   * the record.
   *
   * NO SUCCESS IS SHOWN BEFORE THE COMMIT. The outcome is only recorded after
   * the call resolves without an error, and the record is re-read from the
   * database immediately afterwards, so what the screen ends up showing is the
   * persisted state rather than an optimistic guess.
   */
  const approveSubmission = useCallback(() => runAction('approve', async () => {
    const { data, error } = await supabase.rpc('approve_order_submission', {
      p_submission_id: submissionId,
    })
    if (!error) setApproval(readApprovalOutcome(data))
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
  const tone = statusTone(draftStatusTone(submission.status))
  const savedAt = formatSavedAt(submission.updated_at ?? submission.created_at)

  /** Null unless the record actually names a workbook, so the strip can omit it. */
  const workbookName = submission.source_workbook_name?.trim() || null
  /** Whoever the PI document itself named. Absent on plenty of real workbooks. */
  const documentAuthor = submission.source_created_by?.trim() || null

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

  /** True only when the record is back with the employee BECAUSE of the refusal. */
  const advanceRejectedNow =
    advance.status === 'rejected' && submission.status === 'needs_changes'

  // ── Finance verification, and whether approval may be pressed ──
  //
  // ONE ANSWER FROM ONE HELPER for each, shared with their tests, exactly as the
  // action and advance rules above are. Both mirror a database rule that will be
  // re-derived under a row lock when the button is actually pressed:
  // order_submission_finance_verified() and approve_order_submission()'s own
  // ordered eligibility checks.
  const financeVerified = financeVerificationIsCurrent(submission, submission.submitted_at)
  const finance = describeFinanceStatus({
    status: submission.status,
    submittedAtIso: submission.submitted_at,
    verification: submission,
    canVerifyFinance,
    verifiedAt: submission.finance_verified_at
      ? formatSavedAt(submission.finance_verified_at) : null,
    verifierName: draft.financeVerifierName,
  })

  // THE PAYMENT GATE'S ANSWER COMES FROM THE DATABASE, not from this page.
  // pi_submission_payment_summary() resolved the position in numeric, in the
  // same order approve_order_submission() resolves it; a null summary means it
  // could not be read at all and the control fails closed.
  /**
   * THE WHOLE REMAINING DISTANCE, asked once and answered for every surface.
   *
   * The dead end manual testing found was not one missing field — it was
   * learning about them ONE REFUSAL AT A TIME. Submitting named the client;
   * fixing that named a product line; fixing that named an image. Every round
   * trip a fresh disappointment, and no screen able to say how far there was
   * left to go.
   *
   * So the same list is computed here and read by every surface below: the
   * submit control, the finance dialog and the approval control. It is NOT the
   * enforcement — submit_pi_for_review and approve_order_submission re-derive
   * all of it under a row lock — it is the difference between being told the
   * whole thing and being told the first thing.
   *
   * `hasRepresentativeImage` is read from the URLs the page already resolved,
   * so a picture whose object has gone missing counts as missing here rather
   * than only showing as a broken thumbnail beside a line that looks complete.
   */
  const submissionReadiness = piReadiness(
    'submission',
    {
      client_name: submission.client_name ?? null,
      source_workbook_path: submission.source_workbook_path ?? null,
      parse_blocking_issues: draft.blocking,
    },
    products.map(p => ({
      item_sequence: p.itemSequence === null ? null : 1,
      product_name: p.productName,
      hasRepresentativeImage: draft.representativeByRow.has(p.row),
    })),
  )

  const readiness = describeApprovalReadiness({
    status: submission.status,
    financeVerified,
    paymentPosition: asPaymentPosition(payments?.approval_position),
    neededForStandard: payments?.needed_for_standard ?? null,
    hasBlockingIssues: draft.blocking.length > 0,
    productCount: products.length,
    deletionClaimed: submission.deletion_claim_token !== null,
    // The same list every other surface reads. Last of the blockers, because
    // everything above it is a larger obstacle than a missing field.
    incompleteSummary: submissionReadiness.ready ? null : submissionReadiness.summary,
  })

  /**
   * The Order, preferring the value read back from the database.
   *
   * The RPC's own answer is the fallback and not the other way round: the record
   * is authoritative, and the in-memory result exists only so an approver who
   * cannot SELECT the Order they just created is still shown its number.
   */
  const approvedOrder = describeApprovedOrder({
    orderId: submission.order_id ?? approval?.orderId ?? null,
    displayNumber: draft.orderDisplayNumber ?? approval?.displayNumber ?? null,
  })

  /**
   * The advance condition in one phrase, kept ONLY for records written before
   * the verified-payment gate. Both dialogs prefer the live verified figure
   * below; this is the fallback while the summary has not been read.
   */
  const advanceLabel = describeAdvanceForReview(advance)

  const clientLabel = orDash(submission.client_name ?? submission.bill_to_name)
  const grandTotalLabel = formatInr(grandTotalValue)

  // ── What the page SAYS, from the page's own view module ──
  //
  // Pure functions with their own tests. Nothing below chooses a heading, a
  // figure or a sentence inline.
  const workflow = describeWorkflowPanel({
    status: submission.status,
    actions,
    hasBlockingIssues: draft.blocking.length > 0,
    submittedAt,
    submitterName: draft.submitterName,
    rejectedAt,
    rejectedByName: draft.rejectedByName,
  })


  /**
   * The verified-payment line the review dialogs and the decision band show.
   *
   * ONE SOURCE, so the band, the finance dialog and the approval dialog cannot
   * word the same position three different ways — and so none of them can
   * present a declared advance as money received.
   */
  const verifiedPaymentLabel = payments === null
    ? null
    : `${formatMoney(payments.verified_amount)} · ${formatPercent(payments.verified_percent)}`

  const ownership = buildOwnership({
    documentAuthor,
    submitterName: draft.submitterName,
    submittedAt,
    savedAt,
  })

  /**
   * The top summary's three groups.
   *
   * The client group reads the contact and address columns the save route has
   * always written and this page has only now started selecting; the shared
   * header builder still decides the CONFIRM DATE's format, so the two PI
   * screens cannot print the same date differently.
   *
   * DUE DATE IS NOT PASSED. order_submissions has no due-date column — see
   * buildDateSummary — so the row says `Not provided` rather than deriving a
   * date from the prose in dispatch_commitment.
   */
  /**
   * Who may record a payment against this PI — the SAME shared rule, unmoved.
   *
   * It was computed inline on the payment card that used to sit below the
   * products; the card is now a dialog the summary opens, so the answer is
   * resolved here and passed to both. Not one input to it changed.
   */
  /**
   * WHAT THIS PI STILL NEEDS — the shared answer, so this screen and the
   * payment and submission gates cannot disagree about the same record.
   *
   * Computed for the PAYMENT purpose because that is the gate a reader meets
   * first, and it is where the reported dead end was: no client name, no
   * payment, and nothing on the page offering a way to supply one.
   */
  /**
   * Does the signed-in account own this PI?
   *
   * Read from the record, not from a role. The correction RPC re-derives
   * exactly this — created_by or submitted_by — so the control and the write
   * cannot disagree about who the owner is.
   */
  /**
   * MAY A FORM WRITE A PRODUCT LINE HERE.
   *
   * The same two authorities every other section uses: the owner rule for a
   * draft, the admin rule for every stage after it. Kept as one name because it
   * is asked in four places in the markup below, and four copies of the same
   * expression is four chances for one of them to drift.
   */
  const canEditProducts = canEditSubmission || canAdminAmend

  const ownsSubmission = viewerId !== null && (
    submission.created_by === viewerId || submission.submitted_by === viewerId)

  const paymentReadiness = piReadiness('payment', {
    client_name: submission.client_name ?? null,
    source_workbook_path: null,
  })

  const canAddPayment = canAddPiPayment(
    {
      userId: viewerId,
      // NOT a role literal. deriveFinanceCapabilities short-circuits an
      // active admin, so canAllocatePayment is already true for one —
      // this page never reads users.role to decide an authority.
      isAdmin: false,
      canAllocatePayment,
    },
    {
      status:          submission.status,
      submittedBy:     submission.submitted_by ?? null,
      createdBy:       submission.created_by ?? null,
      assignedTo:      submission.assigned_to ?? null,
      orderId:         submission.order_id ?? null,
      deletionClaimed: Boolean(submission.deletion_claim_token),
    },
  )

  const clientDetails = buildClientDetails({
    clientName: submission.client_name,
    billToName: submission.bill_to_name,
    shipToName: submission.ship_to_name,
    contactNumber: submission.contact_number,
    billToPhone: submission.bill_to_phone,
    shipToPhone: submission.ship_to_phone,
    billingAddress: submission.billing_address,
    shippingAddress: submission.shipping_address,
  })

  const summaryDates = buildDateSummary({
    confirmed: omitDash(headerValue('confirmed')),
    // The stored column, read with the rest of the record. Nothing derives it:
    // it was decided once, on save or in 20260922000000's backfill.
    //
    // formatPiDate re-spells the ISO string WITHOUT constructing a Date — the
    // same timezone-safe path every other date on this page uses, so a 25 March
    // due date reads as 25 March in Jaipur and in a CI runner alike.
    due: submission.due_date
      ? formatPiDate({ iso: submission.due_date, text: submission.due_date, source: 'serial' })
      : null,
    commitment: submission.dispatch_commitment,
  })

  /**
   * The commercial rows, built ONCE and shared.
   *
   * The top summary repeats two of them beside the payment; the Commercial
   * breakdown below renders the lot. Both are handed this same array, so the
   * figure in the card and the figure in the breakdown cannot drift apart —
   * they are literally the same string.
   */
  const commercialRows = commercialBreakdownRows(buildCommercialRows(persistedCommercial(submission)))
  const summaryFigures = summaryCommercialFigures(commercialRows)

  /**
   * The billing declaration, and what it comes to.
   *
   * FROM THE COLUMN, NOT THE ROW. `commercialRows` carries FORMATTED strings —
   * '₹7,42,850' — and arithmetic on those is how a figure quietly loses its
   * paise. toNumber(submission.total_before_gst) is the authoritative number,
   * the same one the breakdown formatted, and a null stays null so a PI with no
   * pre-tax total shows the missing treatment rather than ₹0.
   */
  const billingSummary = buildBillingSummary({
    raw: submission.billing_percentage,
    totalBeforeGst: toNumber(submission.total_before_gst),
  })

  /**
   * The compact payment block. Every figure is the RPC's, already summed in
   * numeric; the only thing derived here is how many rows Finance has not
   * decided yet, which is a count of rows and not a sum of money.
   */
  const paymentSummary = payments === null ? null : buildPaymentSummaryView({
    // formatInr, the page's own money format — the one the Commercial breakdown
    // and the page title already use. It prints whole rupees as whole rupees and
    // keeps paise only when there are any, so a summary reads `₹8,76,563` while
    // an odd figure still reads `₹3,50,625.20`. Nothing is rounded away.
    verifiedAmount: formatInr(toNumber(payments.verified_amount)),
    grandTotal: formatInr(toNumber(payments.grand_total)),
    verifiedPercent: formatPercent(payments.verified_percent),
    percentValue: Number(payments.verified_percent ?? 0),
    awaitingCount: (payments.payments ?? []).filter(
      row => row.allocation_status === 'active' && isAwaitingVerification(row.status)).length,
  })

  /**
   * The employee's reply, shown to a reviewer WHILE THE PI IS WITH THEM.
   *
   * Read off the submission EVENT — the record has no column for it — and only
   * on a submitted PI. On a returned one the newest reply belongs to the
   * submission management already answered, and printing it beside their
   * correction would read as an answer to it.
   */
  const employeeReply = submission.status === 'submitted'
    ? latestSubmissionReply(draft.activity)
    : null

  /**
   * The advance band, ONLY while a proposal is genuinely outstanding.
   *
   * A settled exception is reported by the snapshot at the top (what the
   * requirement now is) and by Activity (who decided it, when, and why). A band
   * restating the request, the reason, the requester, the decider and both
   * timestamps was the same decision told a fourth time.
   */
  const advanceBand = advanceActions.isPending ? (
    <PiAdvanceBand
      advance={advance}
      verifiedLine={verifiedPaymentLabel}
      canDecide={advanceActions.canDecide}
      acting={acting}
      onApprove={() => { setActionFailure(null); approveException() }}
      onReject={() => { setActionFailure(null); setDialog('reject_exception') }}
    />
  ) : null

  /**
   * A refused advance, for the employee who now has to do something about it.
   *
   * Management's reason and the choice it leaves them are both real content and
   * both belong beside the correction instruction, not in a band of their own.
   * Everybody else reads the outcome in the snapshot and the history in Activity.
   */
  const advanceRefusal = advanceRejectedNow
    ? { reason: advance.rejectionReason, instruction: ADVANCE_REJECTED_INSTRUCTION }
    : null

  return (
    <OrdersLayout
      profile={profile}
      // The client, and nothing after it. The subtitle used to read "Saved PI
      // submission · Draft", which restated the badge one line below it and the
      // page the reader had just navigated from.
      title={clientLabel}
      onSignOut={handleSignOut}
      // The header control re-reads in place: the record stays on screen, the
      // scroll position is kept, and the spinner in the header is the feedback.
      onRefresh={() => loadDraft({ quiet: true })}
      actions={backButton}
    >
      <div className="pi-detail-stack">

        {justSaved && <PiSavedStrip />}

        {/* ── 1. Page identity ──
            The layout header above already carries the client name. This is the
            state, the size of the record, when it last moved, and the file it
            came from — one line, not a card. */}
        {/* ── 2. The top summary ──
            Who the client is and how to reach them, when the order was
            confirmed and when it is due, and how much VERIFIED money has
            arrived against what the order is worth — with the way in to every
            payment record, and to recording another, beside the figure. */}
        <PiSummaryCard
          client={clientDetails}
          onOpenClient={() => setClientDialog(true)}
          billing={billingSummary}
          /* THE DATABASE'S OWN ANSWER, not a second opinion. can_edit_order_submission
             covers the owner AND an active admin, in draft and needs_changes
             only; every other state is read-only for everyone. The RPC behind
             the dialog re-derives exactly this, so the control and the write
             cannot disagree. */
          canEditBilling={canEditSubmission || canAdminAmend}
          onEditBilling={() => { setBillingFailure(null); setBillingDialog(true) }}
          /* The same two authorities the billing control uses. The owner rule
             covers a draft; the admin rule covers every stage after it. */
          canEditDetails={canEditSubmission || canAdminAmend}
          onEditDetails={() => { setClientFailure(null); setEditSection('client') }}
          onEditSchedule={() => { setClientFailure(null); setEditSection('schedule') }}
          /* The owner's channel, offered only where they have no edit door:
             they own this PI and it has left their hands. The RPC re-derives
             both halves of that. */
          onRequestCorrection={
            !canEditSubmission && !canAdminAmend && ownsSubmission
              ? () => { setCorrectionFailure(null); setCorrectionOpen(true) }
              : null
          }
          /* Only offered where something can actually be fixed by a form —
             piReadinessIsEditable is false for a list of workbook problems, and
             pointing at an editor for those would be a lie. */
          missingSummary={
            paymentReadiness.ready || !piReadinessIsEditable(paymentReadiness)
              ? null
              : paymentReadiness.summary
          }
          ownership={ownership}
          statusLabel={draftStatusLabel(submission.status)}
          tone={tone}
          workbookName={workbookName}
          dates={summaryDates}
          figures={summaryFigures}
          payment={paymentSummary}
          canAdd={canAddPayment}
          onOpenPayments={() => setPaymentDialog('details')}
          onAddPayment={() => setPaymentDialog('add')}
          notice={paymentNotice}
          onDismissNotice={() => setPaymentNotice(null)}
        />

        {/* ── 3. Workflow and actions, ABOVE the products ──
            Whatever is being asked of this viewer, in one coordinated panel, so
            nobody scrolls a product table to find out that nothing is. */}
        <PiWorkflowPanel
          panel={workflow}
          actions={actions}
          status={submission.status}
          reviewNote={submission.review_note}
          employeeReply={employeeReply}
          advanceRefusal={advanceRefusal}
          blockingCount={draft.blocking.length}
          /* The same list the approval control and the finance dialog read.
             Offered only where submitting is the question: a reviewer looking
             at a submitted PI is not the person who fills these in. */
          readiness={actions.canSubmit ? submissionReadiness : null}
          onFixReadiness={
            canEditSubmission || canAdminAmend
              ? section => {
                  setClientFailure(null)
                  setProductFailure(null)
                  if (section === 'workbook') { router.push(changePiHref(submissionId)); return }
                  setEditSection(section)
                }
              : null
          }
          acting={acting}
          onChangePi={() => router.push(changePiHref(submissionId))}
          onSubmit={() => { setActionFailure(null); setDialog('submit') }}
          onRequestChanges={() => { setActionFailure(null); setDialog('needs_changes') }}
          onReject={() => { setActionFailure(null); setDialog('reject') }}
          finance={finance}
          approvalBlocker={readiness.blocker}
          approvalReady={readiness.ready}
          approvedOrder={approvedOrder}
          onVerifyFinance={() => { setActionFailure(null); setDialog('verify_finance') }}
          onApprove={() => { setActionFailure(null); setDialog('approve') }}
          onOpenOrder={() => { if (approvedOrder) router.push(orderHref(approvedOrder.orderId)) }}
          advanceBand={advanceBand}
        />

        {/* ── 4. What stops this being submitted ──
            Above the products, because it is the reason the primary action is
            disabled. Saved at parse time, so what the server thought of this
            document is still readable months later. */}
        {draft.blocking.length > 0 && (
          <PiBlockingPanel entries={draft.blocking} />
        )}
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
                {/* Reordering is one write over every line, so it is its own
                    control and its own dialog — never a side effect of editing
                    one row. Offered only where a form may write at all. */}
                {canEditProducts && products.length > 1 && (
                  <button
                    type="button"
                    className="boe-btn boe-btn-ghost"
                    onClick={() => { setProductFailure(null); setReorderOpen(true) }}
                  >
                    Reorder
                  </button>
                )}
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

                  {canEditProducts && (
                    <button
                      type="button"
                      className="boe-btn boe-btn-ghost"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => { setProductFailure(null); setProductEditId(p.id) }}
                    >
                      Edit details
                    </button>
                  )}
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
                        {/* INSIDE THE PRODUCT CELL, not in a tenth column.
                            PiProductTableHead is shared with the upload preview,
                            which has nothing to edit; a tenth cell here would
                            leave that table one heading short of its rows, and
                            widening the shared head would put an empty column on
                            a screen that can never fill it. */}
                        {canEditProducts && (
                          <button
                            type="button"
                            className="boe-btn boe-btn-ghost"
                            style={{ marginTop: '4px' }}
                            aria-label={`Edit ${p.productName?.trim() || 'this product line'}`}
                            onClick={() => { setProductFailure(null); setProductEditId(p.id) }}
                          >
                            Edit
                          </button>
                        )}
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

          {/* ── WHAT NO FORM ON THIS PAGE CAN FIX ──
              Stated once, under the lines, wherever an editing control is
              offered. Without it a reader who has just corrected a product name
              reasonably concludes the quantity beside it is one click away —
              and then hunts for a control that was never going to exist. It is
              not a permission notice: nobody can type these figures, because
              they are the output of formulas in the workbook that this system
              transcribes rather than computes. */}
          {canEditProducts && products.length > 0 && (
            <div style={{
              padding: '11px 16px 13px',
              borderTop: `1px solid ${colors.border}`,
              display: 'flex', flexDirection: 'column', gap: '6px',
            }}>
              <div style={{ fontSize: '11.5px', fontWeight: 600, color: colors.primary }}>
                Changing these needs a corrected PI workbook
              </div>
              <div style={{ fontSize: '11.5px', color: colors.secondary, lineHeight: 1.55 }}>
                {PI_CHANGE_PI_ONLY.join(' · ')}
              </div>
              <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.55 }}>
                These come from the workbook’s own formulas. Upload a corrected
                file and everything on this PI is read again from it.
              </div>
              <button
                type="button"
                className="boe-btn boe-btn-ghost"
                style={{ alignSelf: 'flex-start', marginTop: '2px' }}
                onClick={() => router.push(changePiHref(submissionId))}
              >
                Change PI
              </button>
            </div>
          )}
        </PiCard>

        {/* ── 6. The lower information grid ──

            How the total was reached, beside what has happened to the record.
            Both are reference material a reader drops to AFTER the decisions,
            which is why they are here and not above the table. Roughly 60/40 on
            a desktop, aligned at the top and never stretched to a common height;
            stacked in this order on anything narrower. */}
        <PiLowerGrid
          commercial={
            /* The stored figures, through the shared rows builder. Nothing on
               this page recomputes a total, and `fill` only tells the shared
               component to use its column rather than cap and right-align
               itself the way it does under the import preview's table. */
            <PiCommercialSummary rows={commercialRows} title="Commercial breakdown" variant="detail" />
          }
          activity={<PiActivityTimeline entries={draft.activity} />}
        />

        {/* ── 7. Worth checking ──
            Below the grid and quieter than the blocking panel: nothing here
            stops a submission, so nothing here may compete with the actions. */}
        {draft.warnings.length > 0 && (
          <PiWarningPanel entries={draft.warnings} />
        )}

        {/* ── 8. One muted line, in place of the paragraph that used to explain
            at length that no order number exists. */}
        <PiStoredCopyNote />
      </div>

      {/* Every payment recorded against this PI, opened from the summary's
          figure. The SAME content the standalone card used to render below the
          products — the tiles, the approval position, the agreed terms and the
          rows with their status, mode, reference and rejection note — now in the
          dialog the rest of the application already uses, so the page answers
          "how much has been paid" in exactly one place. */}
      {/* The client's contact and both parties, behind the name in the card.
          No request: clientDetails came off the submission already on screen. */}
      {clientDialog && (
        <PiClientDetailsModal client={clientDetails} onClose={() => setClientDialog(false)} />
      )}

      {billingDialog && (
        <PiBillingPercentageModal
          current={billingSummary.value}
          saving={billingSaving}
          failure={billingFailure}
          /* A reason is required exactly when this is an ADMIN AMENDMENT of a
             PI the owner can no longer edit. `canEditSubmission` is the owner
             rule, so its being false while the admin authority is true is
             precisely the after-submission case the database asks about. */
          requireReason={canAdminAmend && !canEditSubmission}
          onCancel={() => { if (!billingSaving) setBillingDialog(false) }}
          onSave={(value, reason) => { void saveBillingPercentage(value, reason) }}
          onClear={reason => { void saveBillingPercentage(null, reason) }}
        />
      )}

      {clientEditOpen && (
        <PiClientDetailsEditModal
          current={{
            client_name:      submission.client_name ?? null,
            contact_number:   submission.contact_number ?? null,
            bill_to_name:     submission.bill_to_name ?? null,
            bill_to_phone:    submission.bill_to_phone ?? null,
            bill_to_gst:      submission.bill_to_gst ?? null,
            billing_address:  submission.billing_address ?? null,
            ship_to_name:     submission.ship_to_name ?? null,
            ship_to_phone:    submission.ship_to_phone ?? null,
            ship_to_gst:      submission.ship_to_gst ?? null,
            shipping_address: submission.shipping_address ?? null,
          }}
          saving={clientSaving}
          failure={clientFailure}
          /* A reason is required exactly when this is an ADMIN AMENDMENT of a
             PI the owner can no longer edit — the same condition the database
             applies, asked here so the reader learns it before typing. */
          requireReason={canAdminAmend && !canEditSubmission}
          missingKeys={paymentReadiness.missing.map(m => m.key)}
          onCancel={() => { if (!clientSaving) setEditSection(null) }}
          onSave={(changed, reason) => { void saveClientDetails(changed, reason) }}
        />
      )}

      {/* ── The product line editor ──
          Keyed on the line, not on a section: one line, one RPC, one
          transaction. A line that disappears under an open dialog — a Change PI
          landing in another tab — closes it rather than saving into nothing. */}
      {productEditId !== null && (() => {
        const line = products.find(p => p.id === productEditId)
        if (!line) return null
        return (
          <PiProductEditModal
            line={{
              sequence: line.itemSequence,
              name:     line.productName,
              quantity: line.quantity === null ? '—' : String(line.quantity),
              rate:     formatInr(line.costPerPiece),
              total:    formatInr(line.lineTotal),
            }}
            current={{
              item_sequence:       line.itemSequence,
              source_product_code: line.sourceProductCode,
              product_name:        line.productName,
              dimensions:          line.dimensions,
              material:            line.material,
              customization:       line.customization,
            }}
            saving={productSaving}
            failure={productFailure}
            requireReason={canAdminAmend && !canEditSubmission}
            onCancel={() => { if (!productSaving) setProductEditId(null) }}
            onSave={(changed, reason) => { void saveProductDetails(line.id, changed, reason) }}
            onChangePi={() => router.push(changePiHref(submissionId))}
          />
        )
      })()}

      {reorderOpen && (
        <PiProductReorderModal
          lines={products.map(p => ({
            id: p.id, sequence: p.itemSequence, name: p.productName,
          }))}
          saving={productSaving}
          failure={productFailure}
          requireReason={canAdminAmend && !canEditSubmission}
          onCancel={() => { if (!productSaving) setReorderOpen(false) }}
          onSave={(ids, reason) => { void saveProductOrder(ids, reason) }}
        />
      )}

      {correctionOpen && (
        <PiRequestCorrectionModal
          saving={correctionSaving}
          failure={correctionFailure}
          onCancel={() => { if (!correctionSaving) setCorrectionOpen(false) }}
          onSubmit={(section, change, reason) => {
            void sendCorrectionRequest(section, change, reason)
          }}
        />
      )}

      {editSection === 'schedule' && (
        <PiScheduleTermsEditModal
          current={{
            order_confirmation_date: submission.order_confirmation_date ?? null,
            due_date:                submission.due_date ?? null,
            dispatch_commitment:     submission.dispatch_commitment ?? null,
            payment_terms:           submission.payment_terms ?? null,
            billing_terms:           submission.billing_terms ?? null,
          }}
          billingLabel={billingSummary.percent}
          saving={clientSaving}
          failure={clientFailure}
          requireReason={canAdminAmend && !canEditSubmission}
          onCancel={() => { if (!clientSaving) setEditSection(null) }}
          onSave={(changed, reason) => { void saveScheduleTerms(changed, reason) }}
          /* Billing percentage keeps its own dialog and its own rules. */
          onEditBilling={
            canEditSubmission || canAdminAmend
              ? () => { setEditSection(null); setBillingFailure(null); setBillingDialog(true) }
              : null
          }
        />
      )}

      {paymentDialog === 'details' && (
        <PiPaymentDetailsModal
          summary={payments}
          loading={paymentsLoading}
          isMobile={isMobile}
          onOpenProof={openPaymentProof}
          onClose={() => setPaymentDialog(null)}
        />
      )}

      {/* The unchanged entry form, on the unchanged gate and the unchanged RPC. */}
      {paymentDialog === 'add' && canAddPayment && (
        <AddPiPaymentModal
          todayIso={new Date().toISOString().slice(0, 10)}
          saving={paymentSaving}
          onClose={() => setPaymentDialog(null)}
          onSubmit={async (form, proof) => {
            const err = await recordPayment(form, proof)
            if (!err) setPaymentDialog(null)
            return err
          }}
        />
      )}

      {dialog === 'submit' && (
        <PiSubmitConfirmModal
          client={clientLabel}
          grandTotal={grandTotalLabel}
          // The LIVE position, from the same RPC the payment card reads. The
          // dialog states it; it never computes it.
          payment={payments}
          // The dialog opens on whatever the record already agreed, so a PI
          // returned for an unrelated correction does not silently drop the
          // commercial terms while the employee fixes something else.
          initialTerms={{
            reason: payments?.exception_reason ?? '',
            paymentTerms: payments?.payment_terms ?? '',
            billingTerms: payments?.billing_terms ?? '',
          }}
          submitting={acting}
          failure={actionFailure}
          offerReply={submissionOffersReply(submission.status)}
          onCancel={closeDialog}
          onConfirm={submitForApproval}
        />
      )}

      {dialog === 'verify_finance' && (
        <PiFinanceVerifyModal
          client={clientLabel}
          grandTotal={grandTotalLabel}
          advanceLabel={verifiedPaymentLabel ?? advanceLabel}
          /* The same list the submit control and the approval control read.
             Not a refusal — finance signs off on the figures — but the thing
             that will stop the approval, said before the sign-off rather than
             after it. */
          incompleteSummary={submissionReadiness.ready ? null : submissionReadiness.summary}
          saving={acting}
          failure={actionFailure}
          onCancel={closeDialog}
          onConfirm={verifyFinance}
        />
      )}

      {dialog === 'approve' && (
        <PiApproveOrderModal
          client={clientLabel}
          rows={buildApprovalSummary({
            client: clientLabel,
            grandTotal: grandTotalLabel,
            advanceLabel: verifiedPaymentLabel ?? advanceLabel,
            financeVerified,
            productCount: products.length,
          })}
          saving={acting}
          failure={actionFailure}
          onCancel={closeDialog}
          onConfirm={approveSubmission}
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
