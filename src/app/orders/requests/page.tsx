'use client'

// ── Order Requests list ───────────────────────────────────────────────────────
// The module's index: the status strip, the table, and the creation flow.
//
// Opening a request is a NAVIGATION — clicking a row or a request number goes
// to /orders/requests/[id], the dedicated detail page. This page holds no
// detail modal and no workflow actions; those live on the record itself, so
// there is exactly one detail experience.
//
// The shared model (types, permission guards, formatters) lives in
// ./components/shared so this page and the detail page state each rule once.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { X, CheckCircle2, Clock, Layers, MessageCircleQuestion, CircleX, FileText, Paperclip, User, type LucideIcon } from 'lucide-react'
import { StatusTabs, accentFromBadge, BRAND_TAB_ACCENT, type TabAccent } from '@/components/ui/StatusTabs'
import { notifyOrders } from '@/lib/notify'
import { formatINR } from '@/lib/currency'
import {
  ORDER_REQ_ATTACHMENT_BUCKET,
  ORDER_REQ_ATTACHMENT_MAX_BYTES,
  prepareAttachment,
  plannedProcessing,
  planStageApplication,
  planReferenceRemoval,
  buildAttachmentPath,
  formatBytes,
  MAIN_PI_ACCEPT,
  REFERENCE_ACCEPT,
  type AttachmentCategory,
  type PrepareStage,
} from '@/lib/orderRequestAttachments'
import { useDragAndPaste } from '@/hooks/useDragAndPaste'
import { StatusBadge } from './components/RequestPanels'
import {
  canManagePayments,
  fmtAmount,
  fmtDate,
  getAdvanceInfo,
  useEscapeToClose,
  validateAmount,
  EMPTY_FORM,
  LEAD_SOURCE_OPTIONS,
  STATUS_META,
  type AdvanceInfo,
  type AssigneeOption,
  type OrderRequest,
  type RequestForm,
  type RequestLinkAgg,
  type RpcErrorLike,
} from './components/shared'

// ── Tabs ──────────────────────────────────────────────────────────────────────

type StatusFilter = 'pending' | 'needs_clarification' | 'rejected' | 'all'

// This module lists only requests that still need someone to act on them, so
// 'converted' has no tab: conversion is the exit from Order Requests, and the
// converted row is excluded by loadRequests' own query, not merely by a tab
// filter. The row itself is never deleted — it stays in public.order_requests
// permanently, and is reached through the Confirmed Order's Source Request
// provenance (orders.source_order_request_id, 20260701).
//
// "Pending" is the submitted-and-awaiting-review tab. Its key is 'pending' —
// label and key say the same thing, and LEGACY_TAB_KEYS below normalizes the
// old 'active' spelling so no second permanent key survives.
//
// Each tab's accent comes from the STATUS_META badge its rows already wear, so a
// request reads the same colour in the strip, the table, and the detail page.
// 'all' is the only tab with no row equivalent; it takes the BOE brand accent.
const STATUS_TABS: { key: StatusFilter; label: string; match: (s: string) => boolean; Icon: LucideIcon; accent: TabAccent }[] = [
  { key: 'pending',             label: 'Pending',             match: s => s === 'submitted',           Icon: Clock,                 accent: accentFromBadge(STATUS_META.submitted) },
  { key: 'needs_clarification', label: 'Needs Clarification', match: s => s === 'needs_clarification', Icon: MessageCircleQuestion, accent: accentFromBadge(STATUS_META.needs_clarification) },
  { key: 'rejected',            label: 'Rejected',            match: s => s === 'rejected',            Icon: CircleX,               accent: accentFromBadge(STATUS_META.rejected) },
  { key: 'all',                 label: 'All',                 match: () => true,                       Icon: Layers,                accent: BRAND_TAB_ACCENT },
]

// Maps an incoming ?tab= value (e.g. from the Admin Action Queue) to a known
// StatusFilter, defaulting to 'pending' for anything missing or unrecognized —
// never throws on an invalid/stale deep link.
const STATUS_FILTER_KEYS: StatusFilter[] = ['pending', 'needs_clarification', 'rejected', 'all']

// Retired spellings, translated on the way in. 'active' was this tab's key
// before it was renamed to match its "Pending" label; bookmarks, notification
// links and pasted URLs still carry it. Normalized rather than kept alive as a
// second accepted key: the page rewrites the URL to the canonical spelling (see
// the deep-link effect), so an old link works exactly once more and then stops
// existing. Anything not listed here still falls through to the default.
const LEGACY_TAB_KEYS: Record<string, StatusFilter> = { active: 'pending' }

function parseStatusFilter(value: string | null): StatusFilter {
  const raw = value ?? ''
  if ((STATUS_FILTER_KEYS as string[]).includes(raw)) return raw as StatusFilter
  return LEGACY_TAB_KEYS[raw] ?? 'pending'
}

// ── Advance-received cell ─────────────────────────────────────────────────────

// A light inline "Link payment" / "Link another" action for the table cell.
// stopPropagation keeps the row's own open-record click from also firing.
function LinkPaymentAction({ label, onLink }: { label: string; onLink: () => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onLink() }}
      style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        font: 'inherit', fontSize: '11px', fontWeight: 600, color: colors.blue,
        textDecoration: 'underline', textUnderlineOffset: '2px',
      }}
    >
      {label}
    </button>
  )
}

// Compact two-line advance indicator for the table. `canLink` (admin, the
// request's own requester, or its assignee) enables the request-side link
// action; the numbers themselves come from getAdvanceInfo, never recomputed here.
function AdvanceCell({ info, canLink, onLink }: { info: AdvanceInfo; canLink: boolean; onLink: () => void }) {
  if (info.kind === 'not_linked') {
    return canLink
      ? <LinkPaymentAction label="Link payment" onLink={onLink} />
      : <span style={{ fontSize: '12px', color: colors.muted }}>Not linked</span>
  }
  if (info.kind === 'restricted') {
    return <span style={{ color: colors.muted }}>—</span>
  }
  const { received, count } = info
  return (
    <div>
      <div style={{ fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
        {formatINR(received)}
      </div>
      <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span>{count} payment{count !== 1 ? 's' : ''} linked</span>
        {canLink && (
          <>
            <span aria-hidden="true">·</span>
            <LinkPaymentAction label="Link another" onLink={onLink} />
          </>
        )}
      </div>
    </div>
  )
}

// ── Order Request creation flow ───────────────────────────────────────────────
// Attachment staging + the New Order Request modal. Creation is the one
// workflow this page still owns: everything done to an EXISTING request happens
// on its own detail page (/orders/requests/[id]).

// ── Attachment staging (create form) ──────────────────────────────────────────
// A file the user picked for the New Order Request, tracked from selection to
// upload. Preparation (validate + compress-if-over-10MB) runs the moment a file
// is chosen, so each row shows its own size/status/error BEFORE submit and one
// invalid reference never discards the others. `prepared` is the exact File that
// will be uploaded (the original when small enough, or a compressed JPEG).
// Statuses are the real lifecycle, not decoration: 'compressing' is shown only
// when the file is genuinely being re-encoded (willCompressImage decides, so the
// label cannot disagree with the work), and 'uploaded' means the object AND its
// metadata row are both committed. There is deliberately no percentage anywhere:
// supabase-js storage uploads are fetch-based and expose no progress events, so a
// percentage could only be simulated — and an invented number is worse than none.
// The processing statuses mirror the real stages reported by prepareAttachment,
// so an oversized workbook visibly moves through Reading → Optimizing →
// Rebuilding → Validating instead of sitting on one opaque label for the many
// seconds that work genuinely takes.
type StagedStatus =
  | 'preparing' | 'compressing'
  | 'reading' | 'optimizing' | 'rebuilding' | 'validating'
  | 'ready' | 'uploading' | 'uploaded' | 'removing' | 'error'

// prepareAttachment's stages map onto staged-row statuses 1:1.
const STAGE_TO_STATUS: Record<PrepareStage, StagedStatus> = {
  checking:    'preparing',
  compressing: 'compressing',
  reading:     'reading',
  optimizing:  'optimizing',
  rebuilding:  'rebuilding',
  validating:  'validating',
}

// The single source of truth for "this file is still being worked on".
const PROCESSING_STATUSES: ReadonlySet<StagedStatus> = new Set(Object.values(STAGE_TO_STATUS))

type StagedFile = {
  localId:      string
  displayName:  string   // original selected name (what the user recognises)
  category:     AttachmentCategory
  status:       StagedStatus
  prepared:     File | null
  contentType:  string | null   // resolved upload MIME (set once ready)
  originalSize: number
  finalSize:    number | null
  compressed:   boolean
  error:        string | null
  // Set once the object + metadata are committed, so a retry after a LATER
  // failure re-uses the upload instead of duplicating the object/metadata row.
  uploadedPath: string | null
  // Primary key of the committed metadata row. Required to remove THIS file
  // alone (remove_unfinalized_order_request_attachment addresses it by id).
  attachmentId: string | null
  // Which stage failed. An upload failure is retryable (we still hold the
  // prepared bytes); a preparation failure is not — that file is invalid or over
  // the ceiling, so the only way forward is Remove. A removal failure leaves the
  // file present and still attached, so it can simply be removed again.
  failedStage:  'prepare' | 'upload' | 'remove' | null
}

let stagedFileCounter = 0
function nextStagedId(): string {
  stagedFileCounter += 1
  return `staged-${Date.now()}-${stagedFileCounter}`
}

// Validate + compress one picked file into a StagedFile for the given category.
// Never throws — a rejected/oversized/uncompressible file resolves to an 'error'
// row carrying the reason, so the caller can display it inline and keep every
// other selection.
async function stageSelectedFile(
  file: File,
  category: AttachmentCategory,
  onStage?: (status: StagedStatus) => void,
): Promise<StagedFile> {
  const base: Pick<StagedFile, 'localId' | 'displayName' | 'category' | 'originalSize' | 'uploadedPath' | 'attachmentId'> = {
    localId:      nextStagedId(),
    displayName:  file.name,
    category,
    originalSize: file.size,
    uploadedPath: null,
    attachmentId: null,
  }
  const result = await prepareAttachment(file, category, (stage) => onStage?.(STAGE_TO_STATUS[stage]))
  if (!result.ok) {
    return {
      ...base, status: 'error', prepared: null, contentType: null,
      finalSize: null, compressed: false, error: result.error, failedStage: 'prepare',
    }
  }
  return {
    ...base,
    status:      'ready',
    prepared:    result.file,
    contentType: result.contentType,
    finalSize:   result.finalSize,
    compressed:  result.compressed,
    error:       null,
    failedStage: null,
  }
}

// The first label a picked file shows, chosen from what prepareAttachment has
// actually decided to do with it.
const PLANNED_STATUS: Record<'image' | 'xlsx' | 'none', StagedStatus> = {
  image: 'compressing',
  xlsx:  'reading',
  none:  'preparing',
}

// A fresh placeholder shown the instant a file is picked, before any async work.
// The status is the TRUTH about what is about to happen — plannedProcessing
// reuses prepareAttachment's own conditions — so "Compressing image…" never
// appears over a file that is actually being passed through untouched.
function placeholderFor(file: File, category: AttachmentCategory): StagedFile {
  return {
    localId:      nextStagedId(),
    displayName:  file.name,
    category,
    status:       PLANNED_STATUS[plannedProcessing(file, category) ?? 'none'],
    prepared:     null,
    contentType:  null,
    originalSize: file.size,
    finalSize:    null,
    compressed:   false,
    error:        null,
    uploadedPath: null,
    attachmentId: null,
    failedStage:  null,
  }
}

// Best-effort cleanup of the current user's own abandoned upload-stage drafts —
// rows left unfinalized because a browser/session was interrupted mid-creation
// (issue: an interrupted session must not leave a stranded incomplete request).
// Such rows are already invisible to everyone else and excluded from every list;
// this reclaims them and their storage objects. Only drafts OLDER than a safe
// window (so it can never race an upload in progress in another tab) and within
// the cleanup RPC's own recency limit are touched. Never throws.
async function sweepStaleDrafts(supabase: ReturnType<typeof createClient>, userId: string) {
  const olderThan = new Date(Date.now() - 30 * 60 * 1000).toISOString()      // > 30 min old (past any live upload)
  const newerThan = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // < 24h old (the RPC's window)
  const { data } = await supabase
    .from('order_requests')
    .select('id')
    .is('finalized_at', null)
    .eq('created_by', userId)
    .lt('created_at', olderThan)
    .gt('created_at', newerThan)
    .limit(20)
  for (const row of (data ?? []) as { id: string }[]) {
    // Same recoverable sequence as rollbackCreation: remove objects FIRST (the
    // draft row still authorises it), and delete the row ONLY when every object
    // was removed, so a partial storage failure never orphans a file or leaves
    // metadata pointing at a missing one. A still-blocked draft is simply retried
    // on the next load.
    const { data: att } = await supabase
      .from('order_request_attachments')
      .select('storage_path')
      .eq('order_request_id', row.id)
    const paths = ((att ?? []) as { storage_path: string }[]).map(a => a.storage_path).filter(Boolean)
    let allRemoved = true
    if (paths.length > 0) {
      const { data: removed, error: rmErr } = await supabase.storage
        .from(ORDER_REQ_ATTACHMENT_BUCKET).remove(paths)
      allRemoved = !rmErr && (removed?.length ?? 0) >= paths.length
    }
    if (allRemoved) {
      await supabase.rpc('cleanup_unfinalized_order_request', { p_order_request_id: row.id }).then(() => {}, () => {})
    }
  }
}

// One selected-file row in the create form's Attachments section. Shows the
// name, size (original, plus final when compression shrank it), the current
// status, any inline error, and a Remove control while idle. Purely
// presentational — all state lives in SubmitRequestModal.
// Size line: shows the processed size alongside the original ONLY when they
// actually differ, so an untouched Excel workbook reads as one honest number
// rather than implying it was processed.
function stagedSizeLine(staged: StagedFile): string {
  if (staged.compressed && staged.finalSize != null && staged.finalSize !== staged.originalSize) {
    return `${formatBytes(staged.originalSize)} → ${formatBytes(staged.finalSize)} compressed`
  }
  return formatBytes(staged.originalSize)
}

const STAGED_STATUS_LABEL: Record<Exclude<StagedStatus, 'error'>, string> = {
  preparing:   'Checking file…',
  compressing: 'Compressing image…',
  reading:     'Reading workbook…',
  optimizing:  'Optimizing embedded images…',
  rebuilding:  'Rebuilding workbook…',
  validating:  'Validating workbook…',
  ready:       'Ready to upload',
  uploading:   'Uploading…',
  uploaded:    'Uploaded',
  removing:    'Removing…',
}

function AttachmentStagedRow({
  staged, onRemove, onRetry, disabled,
}: {
  staged: StagedFile
  onRemove?: () => void
  onRetry?: () => void
  disabled: boolean
}) {
  const isError = staged.status === 'error'
  const isDone  = staged.status === 'uploaded'
  // A file mid-processing is NOT an error, so it never gets error colouring —
  // only a real failure turns the row red.
  const statusColor = isError ? colors.red : isDone ? colors.green : colors.muted
  // Retry is offered only where it can actually succeed: an upload that failed
  // with the prepared bytes still in hand.
  const canRetry = isError && staged.failedStage === 'upload' && !!staged.prepared && !!onRetry

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '8px 12px', borderRadius: '8px',
      background: isError ? colors.redTint : colors.raised,
      border: `1px solid ${isError ? 'rgba(217,79,79,0.25)' : colors.border}`,
    }}>
      <Paperclip size={12} color={colors.secondary} strokeWidth={1.8} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' }}>
        <span style={{ fontSize: '12px', color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {staged.displayName}
        </span>
        <span style={{ fontSize: '11px', color: statusColor, lineHeight: 1.4, wordBreak: 'break-word' }}>
          {staged.status === 'error'
            ? staged.error
            : `${STAGED_STATUS_LABEL[staged.status]} · ${stagedSizeLine(staged)}`}
        </span>
      </div>
      {canRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={disabled}
          aria-label={`Retry upload of ${staged.displayName}`}
          style={{
            flexShrink: 0, background: 'none', border: 'none', padding: '0 2px',
            cursor: disabled ? 'not-allowed' : 'pointer', font: 'inherit',
            color: colors.blue, fontSize: '11px', fontWeight: 600,
          }}
        >
          Retry
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${staged.displayName}`}
          style={{
            flexShrink: 0, background: 'none', border: 'none', padding: '0 2px',
            display: 'flex', alignItems: 'center',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          <X size={13} color={colors.muted} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

// ── Submit-path failure classification ────────────────────────────────────────
// ONE place that decides what a failed submission means, so the reader is told
// which KIND of thing went wrong and is never shown a raw PostgREST / Postgres /
// Storage string. The draft-insert branch previously printed insertErr.message
// verbatim for anything it did not recognise, so an RLS refusal reached a
// salesperson as `new row violates row-level security policy for table
// "order_requests"` — internals, and no action the reader could take.
//
// The "system update" sentence is RESERVED for exactly one condition: the app
// asked this database for schema it does not have (the attachment migration is
// not applied). It is deliberately NOT the fallback — a permission, validation,
// connection or unknown failure each gets its own sentence, because the reader's
// next action differs in every one of those cases.
//
// RpcErrorLike / logRpcFailure are declared further down beside the edit + delete
// classifiers; the type erases and the function declaration hoists, so both are
// usable here and there is only one definition of each.
type SubmitFailureKind =
  | 'schema'      // app ↔ database out of step (missing column / table / function)
  | 'permission'  // RLS or SECURITY DEFINER refusal
  | 'validation'  // a value the database refused
  | 'network'     // the request never reached PostgREST
  | 'conflict'    // another transaction holds the row
  | 'unknown'

const SUBMIT_SCHEMA_MESSAGE =
  'We could not prepare this Order Request for submission. Please try again after the system update.'
const SUBMIT_NETWORK_MESSAGE =
  'Could not reach the server. Check your connection and try again.'
const SUBMIT_CONFLICT_MESSAGE =
  'This request is busy right now. Please try again in a moment.'
const SUBMIT_VALIDATION_MESSAGE =
  'One of the values entered is not valid for this request. Check the fields and try again.'

function classifySubmitFailure(err: RpcErrorLike): SubmitFailureKind {
  const code = err.code ?? ''
  const m = (err.message ?? '').toLowerCase()

  // PostgREST answered from a schema cache that does not contain what the app
  // asked for: PGRST202/203 = function, PGRST204 = column, PGRST205 = table.
  // 42703 / 42P01 / 42883 are that same mismatch reported by Postgres itself
  // (an undefined column / table / function) rather than by the cache.
  if (['PGRST202', 'PGRST203', 'PGRST204', 'PGRST205'].includes(code)) return 'schema'
  if (code === '42703' || code === '42P01' || code === '42883') return 'schema'
  if (m.includes('schema cache')) return 'schema'

  // No code of any kind: fetch rejected before PostgREST replied.
  if (!code && (m === '' || m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed'))) {
    return 'network'
  }

  if (code === '42501' || m.includes('row-level security') || m.includes('permission denied')) return 'permission'
  if (code === '40001' || code === '55P03') return 'conflict'
  if (['23502', '23503', '23505', '23514', '22P02', '22007', '22003', '22001', 'P0001'].includes(code)) {
    return 'validation'
  }
  return 'unknown'
}

// Developer-facing record of a failed submission stage. The reader gets one
// sentence; the console gets the stage, the code and the server's own message —
// what is actually needed to place the failure. It carries NO form values, no
// file bytes, no filenames, no storage paths and no signed URLs; the draft's own
// id is included because that is the handle needed to find the row.
type SubmitStage = 'draft-insert' | 'attachment-upload' | 'attachment-metadata' | 'finalize'

function logSubmitFailure(stage: SubmitStage, err: RpcErrorLike, requestId?: string | null): void {
  console.error('[order-request:submit] failed', {
    stage,
    kind:      classifySubmitFailure(err),
    code:      err.code    ?? null,
    message:   err.message ?? null,
    details:   err.details ?? null,
    hint:      err.hint    ?? null,
    requestId: requestId   ?? null,
  })
}

// The draft INSERT. Its own rules (assignee eligibility 20260697, assignee
// ownership 20260710) already raise finished, user-facing sentences, so those are
// named rather than folded into the generic validation string.
function submitDraftErrorMessage(err: RpcErrorLike): string {
  const m = (err.message ?? '').toLowerCase()
  switch (classifySubmitFailure(err)) {
    case 'schema':   return SUBMIT_SCHEMA_MESSAGE
    case 'network':  return SUBMIT_NETWORK_MESSAGE
    case 'conflict': return SUBMIT_CONFLICT_MESSAGE
    case 'permission':
      if (m.includes('only assign an order request to yourself')) {
        return 'You can only assign an Order Request to yourself.'
      }
      return 'You do not have permission to create an Order Request.'
    case 'validation':
      if (m.includes('assignee must be')) {
        return 'The selected assignee must be an active Sales team member or an authorised Order Assignee.'
      }
      return SUBMIT_VALIDATION_MESSAGE
    default:
      return 'The request could not be submitted. Please try again.'
  }
}

// finalize_order_request(). Its named failures are checked FIRST, because each
// one is a rule the reader can act on and several share SQLSTATEs with the
// generic classes below (MAIN_PI_* are P0001; the authorisation refusals are
// 42501). Only what none of them matched falls through to the classification.
function finalizeRequestErrorMessage(err: RpcErrorLike): string {
  const m = (err.message ?? '').toLowerCase()
  if (m.includes('main_pi_required')) {
    return 'The Main PI could not be verified. The request was not submitted — please try again.'
  }
  if (m.includes('main_pi_not_excel')) {
    return 'The Main PI must be an Excel file (.xlsx or .xls). The request was not submitted.'
  }
  if (m.includes('order_request_not_found')) {
    return 'This submission is no longer available. Please start it again.'
  }
  if (m.includes('not in a finalizable state')) {
    return 'This submission can no longer be completed. Please start it again.'
  }
  if (m.includes('authentication required')) {
    return 'Your session has expired. Sign in again and submit the request.'
  }

  switch (classifySubmitFailure(err)) {
    case 'schema':     return SUBMIT_SCHEMA_MESSAGE
    case 'network':    return SUBMIT_NETWORK_MESSAGE
    case 'conflict':   return SUBMIT_CONFLICT_MESSAGE
    case 'permission': return 'You do not have permission to submit this Order Request.'
    case 'validation': return SUBMIT_VALIDATION_MESSAGE
    default:           return 'The request could not be submitted. Please try again.'
  }
}

function SubmitRequestModal({
  salesAssignees,
  overrideAssignees,
  currentUserId,
  currentUserName,
  isAdmin,
  onClose,
  onSubmitted,
}: {
  salesAssignees: AssigneeOption[]
  overrideAssignees: AssigneeOption[]
  currentUserId: string
  currentUserName: string
  isAdmin: boolean
  onClose: () => void
  onSubmitted: (requestNumber: string, notifyDelivered: boolean) => void
}) {
  // Assignee rule mirrors the server (validate_order_request_assignee trigger,
  // 20260710): a non-admin may only ever assign the request to themselves, so
  // their assignee is pinned to their own id and never chosen from a list. An
  // admin keeps the eligible-assignee dropdown, defaulting to themselves only
  // when they are actually eligible — never the first person in the list.
  const [form,   setForm]   = useState<RequestForm>(() => {
    if (!isAdmin) return { ...EMPTY_FORM, assigned_to: currentUserId }
    const isSelfEligible = salesAssignees.some(u => u.id === currentUserId)
      || overrideAssignees.some(u => u.id === currentUserId)
    return { ...EMPTY_FORM, assigned_to: isSelfEligible ? currentUserId : '' }
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  // ── Attachments ──
  // Main PI is mandatory and single; references are optional and multiple.
  // Each file is prepared the moment it is picked (validated, and re-encoded only
  // if it is an image over the image threshold), so its status/size/error show
  // before submit. `phase` drives the submit button's live status text.
  const [mainPi, setMainPi] = useState<StagedFile | null>(null)
  const [refs,   setRefs]   = useState<StagedFile[]>([])
  const [phase,  setPhase]  = useState<'idle' | 'creating' | 'main' | 'refs' | 'finalizing'>('idle')
  const mainPiInputRef = useRef<HTMLInputElement>(null)
  const refsInputRef   = useRef<HTMLInputElement>(null)
  // The hidden file inputs cannot hold focus, so after the picker closes focus
  // is restored explicitly to the button that opened it. Without this, whether
  // focus survives depends on React reconciliation (a file row is inserted ABOVE
  // the button when the first file is chosen), which is not something keyboard
  // users should be left to chance on.
  const mainPiButtonRef = useRef<HTMLButtonElement>(null)
  const refsButtonRef   = useRef<HTMLButtonElement>(null)

  // The upload-stage draft, held ACROSS failed attempts. Keeping the id is what
  // lets a retry re-use the same draft (and skip already-uploaded files) instead
  // of minting a second draft row and a second copy of every object.
  const draftIdRef     = useRef<string | null>(null)
  const draftNumberRef = useRef<string | null>(null)

  // localId of the reference currently being removed, or null. Doubles as the
  // guard that prevents a second removal (or a double-click) from racing it.
  const [removingId, setRemovingId] = useState<string | null>(null)

  // Flipped when the modal is torn down. File preparation can be seconds long
  // (unzip → re-encode → rebuild → validate), and a result arriving after the
  // modal closed must be dropped rather than written into unmounted state.
  //
  // The setup line is NOT redundant with useRef(false). React StrictMode runs
  // setup → cleanup → setup on the FIRST mount in development to surface effects
  // that are not idempotent. Without the reset, that rehearsal cleanup latched
  // the ref at `true` for the entire life of a modal that was in fact mounted and
  // visible, so planStageApplication answered 'discard-aborted' for every
  // prepared file and the Main PI sat on "Checking file…" forever — dev only,
  // never production, which is why the deployed build was unaffected.
  //
  // Owning BOTH edges makes the effect idempotent: whatever order React runs the
  // phases in, the last thing to run on a live instance is setup (false), and the
  // last thing to run on a dead one is cleanup (true).
  const stagingAbortedRef = useRef(false)
  useEffect(() => {
    stagingAbortedRef.current = false
    return () => { stagingAbortedRef.current = true }
  }, [])

  // Every status that means "work is still happening to this file". The submit
  // button is blocked while ANY of them is set, so a request can never be
  // created from a workbook that is still being optimised or validated. Derived
  // from STAGE_TO_STATUS rather than retyped, so a new preparation stage cannot
  // be added without the submit button automatically waiting for it.
  const isBusyStatus = (s: StagedStatus) => PROCESSING_STATUSES.has(s)
  // `preparing` gates the submit button, so a removal in flight belongs here:
  // the request must not finalize while one of its files is half-removed.
  const preparing = (mainPi != null && isBusyStatus(mainPi.status))
    || refs.some(r => isBusyStatus(r.status))
    || removingId !== null
  // Uploads are in flight from the moment the request row is created; closing
  // then would orphan uploaded objects, so close controls are locked while
  // `saving`. Compression is client-only with nothing to orphan, so it does not
  // lock the modal — it only disables the submit button.
  const busy = saving
  const inFlight = saving || preparing

  // Authoritative list of objects committed for the live draft. Kept in a ref
  // rather than derived from state so compensation always sees every path, even
  // when it runs from a stale closure.
  const uploadedPathsRef = useRef<string[]>([])

  // Return every staged row to its pre-upload state after the draft behind it has
  // been discarded, so the UI never shows "Uploaded" for an object that no longer
  // exists. A row that still holds prepared bytes goes back to 'ready'.
  const resetUploadMarks = () => {
    const revert = (s: StagedFile): StagedFile => ({
      ...s,
      uploadedPath: null,
      attachmentId: null,
      status:      s.prepared ? 'ready' : s.status,
      error:       s.failedStage === 'upload' || s.failedStage === 'remove' ? null : s.error,
      failedStage: s.failedStage === 'upload' || s.failedStage === 'remove' ? null : s.failedStage,
    })
    setMainPi(prev => (prev ? revert(prev) : prev))
    setRefs(prev => prev.map(revert))
  }

  // Compensation for the live draft — recoverable, never atomic (Storage and
  // Postgres cannot share a transaction). Order and the success-check matter:
  //   1. Remove the uploaded objects FIRST, while the draft row still authorises
  //      it. storage.remove is idempotent, so re-removing is a no-op.
  //   2. Delete the draft row (via the narrow cleanup RPC, which cascades the
  //      metadata) ONLY when every object was removed. If some object survived,
  //      the row + metadata are KEPT so nothing is orphaned — the draft stays
  //      invisible/uncounted/unnotified and the load-time sweep retries later.
  // This guarantees we never delete metadata while its files still exist, and
  // never orphan a file whose row we already deleted.
  const discardDraft = async () => {
    const requestId = draftIdRef.current
    const paths = uploadedPathsRef.current
    if (!requestId) return
    let allRemoved = true
    if (paths.length > 0) {
      const { data: removed, error: rmErr } = await supabase.storage
        .from(ORDER_REQ_ATTACHMENT_BUCKET).remove(paths)
      allRemoved = !rmErr && (removed?.length ?? 0) >= paths.length
    }
    if (allRemoved) {
      await supabase.rpc('cleanup_unfinalized_order_request', { p_order_request_id: requestId }).then(() => {}, () => {})
    }
    // Either way the client lets go of the draft: if some object could not be
    // removed the row is deliberately left for the sweep, and it is already
    // invisible to everyone but its creator.
    draftIdRef.current = null
    draftNumberRef.current = null
    uploadedPathsRef.current = []
    resetUploadMarks()
  }

  // Retry a single reference file whose UPLOAD failed, without touching the files
  // that already succeeded and without re-submitting the whole form. The draft is
  // still alive, so this simply re-runs that one upload against it.
  const retryRef = async (localId: string) => {
    const requestId = draftIdRef.current
    const target = refs.find(r => r.localId === localId)
    if (!requestId || !target?.prepared) return
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setError('Not authenticated.'); return }

    setError(null)
    setRefs(prev => prev.map(r => (r.localId === localId ? { ...r, status: 'uploading', error: null, failedStage: null } : r)))
    const res = await persistAttachment(requestId, session.user.id, 'reference', target)
    if ('error' in res) {
      setRefs(prev => prev.map(r => (r.localId === localId ? { ...r, status: 'error', error: res.error, failedStage: 'upload' } : r)))
      return
    }
    uploadedPathsRef.current = [...uploadedPathsRef.current, res.path]
    setRefs(prev => prev.map(r => (r.localId === localId ? { ...r, status: 'uploaded', uploadedPath: res.path, attachmentId: res.attachmentId, error: null, failedStage: null } : r)))
  }

  const handlePickMainPi = async (file: File | null) => {
    if (mainPiInputRef.current) mainPiInputRef.current.value = ''
    if (!file) return
    setError(null)
    // Replacing removes the previous local selection entirely (single slot). Any
    // previously uploaded Main PI object belongs to a draft that is rolled back
    // on failure, so there is nothing to reconcile here.
    //
    // The placeholder's localId IS the generation token: every pick, replacement
    // and retry mints a new one, and the result below is applied only if that
    // exact id still occupies the slot. A slow workbook optimisation for a file
    // the user has since replaced therefore lands nowhere.
    const placeholder = placeholderFor(file, 'main_pi')
    const generation = placeholder.localId
    setMainPi(placeholder)
    mainPiButtonRef.current?.focus()

    const applyIfCurrent = (update: (prev: StagedFile) => StagedFile) => {
      setMainPi(prev => {
        const decision = planStageApplication({
          slotId: prev?.localId ?? null, resultId: generation, aborted: stagingAbortedRef.current,
        })
        return decision === 'apply' && prev ? update(prev) : prev
      })
    }

    const staged = await stageSelectedFile(file, 'main_pi', (status) => {
      applyIfCurrent(prev => ({ ...prev, status }))
    })
    applyIfCurrent(() => ({ ...staged, localId: generation }))
  }

  const handlePickRefs = async (files: File[]) => {
    if (refsInputRef.current) refsInputRef.current.value = ''
    if (files.length === 0) return
    setError(null)
    // Each file gets its own placeholder immediately, then resolves independently
    // — one invalid file never discards the others already chosen. Same
    // generation rule as the Main PI, per row.
    const placeholders = files.map(f => placeholderFor(f, 'reference'))
    setRefs(prev => [...prev, ...placeholders])
    refsButtonRef.current?.focus()

    const applyIfCurrent = (generation: string, update: (prev: StagedFile) => StagedFile) => {
      setRefs(prev => prev.map(r => {
        const decision = planStageApplication({
          slotId: r.localId, resultId: generation, aborted: stagingAbortedRef.current,
        })
        return decision === 'apply' ? update(r) : r
      }))
    }

    await Promise.all(files.map(async (f, i) => {
      const generation = placeholders[i].localId
      const staged = await stageSelectedFile(f, 'reference', (status) => {
        applyIfCurrent(generation, prev => ({ ...prev, status }))
      })
      applyIfCurrent(generation, () => ({ ...staged, localId: generation }))
    }))
  }

  // Removing the Main PI. It is NEVER individually removable once committed —
  // the RPC refuses a main_pi row precisely so "exactly one Main PI on every
  // finalized request" cannot be broken — so if it was already uploaded (an
  // earlier submit got as far as the Main PI, then a reference failed), clearing
  // it discards the whole draft. Otherwise it is a purely local deselection.
  // Without this, clearing an uploaded Main PI locally and picking another would
  // try to insert a SECOND main_pi row and hit the partial unique index.
  const removeMainPi = async () => {
    setError(null)
    if (removingId !== null) return
    if (mainPi?.uploadedPath && draftIdRef.current) {
      setRemovingId('main-pi')
      await discardDraft()
      setRemovingId(null)
    }
    setMainPi(null)
  }

  // Remove ONE reference attachment.
  //
  // Nothing is uploaded until submit, so the ordinary case is purely local. The
  // interesting case is a file committed by an earlier, partially failed submit:
  // both its storage object and its metadata row must go, and the ORDER is what
  // keeps the draft consistent —
  //   1. remove the OBJECT first, while the draft still authorises it (the
  //      draft-only storage DELETE policy). If this fails, nothing has changed:
  //      the row still points at a file that exists, so we simply keep the file
  //      visible with a per-file error.
  //   2. then remove the metadata ROW via the narrow RPC. If THIS fails the
  //      object is already gone, which is the one state we must never leave —
  //      a row pointing at a missing file. We fall back to discarding the whole
  //      draft, which cascades the row away. That is the old behaviour, now only
  //      a rare fallback rather than the normal path.
  // The Main PI is never removable here; planReferenceRemoval blocks it and the
  // RPC refuses it independently.
  const removeRef = async (localId: string) => {
    const target = refs.find(r => r.localId === localId)
    if (!target) return
    setError(null)

    const plan = planReferenceRemoval(
      { category: target.category, uploadedPath: target.uploadedPath, attachmentId: target.attachmentId },
      { hasDraft: draftIdRef.current !== null, removalInFlight: removingId !== null },
    )

    if (plan.kind === 'blocked') { setError(plan.reason); return }
    if (plan.kind === 'local')   { setRefs(prev => prev.filter(r => r.localId !== localId)); return }

    // ── Committed file ──
    setRemovingId(localId)
    setRefs(prev => prev.map(r => (r.localId === localId ? { ...r, status: 'removing', error: null, failedStage: null } : r)))

    const { data: removed, error: rmErr } = await supabase.storage
      .from(ORDER_REQ_ATTACHMENT_BUCKET).remove([plan.storagePath])

    if (rmErr || (removed?.length ?? 0) < 1) {
      // Step 1 failed — nothing changed. The file stays attached and visible.
      setRefs(prev => prev.map(r => (r.localId === localId
        ? { ...r, status: 'error', error: 'Could not remove this file. Please try again.', failedStage: 'remove' }
        : r)))
      setRemovingId(null)
      return
    }

    // The object is gone, so it must not be re-removed by any later
    // compensation — drop it from the compensation list BEFORE anything else.
    uploadedPathsRef.current = uploadedPathsRef.current.filter(p => p !== plan.storagePath)

    const { error: rpcErr } = await supabase.rpc('remove_unfinalized_order_request_attachment', {
      p_attachment_id: plan.attachmentId,
    })

    if (rpcErr) {
      // Step 2 failed: the row now points at a file that no longer exists.
      // Discarding the draft cascades that row away, so no dangling metadata
      // survives. Every file returns to 'ready' and the user can submit again.
      console.error('[order-request] single attachment removal failed; discarding draft:', rpcErr)
      await discardDraft()
      setRefs(prev => prev.filter(r => r.localId !== localId))
      setError('That file was removed, but the request had to be reset. Your files are still listed — please submit again.')
      setRemovingId(null)
      return
    }

    setRefs(prev => prev.filter(r => r.localId !== localId))
    setRemovingId(null)
  }

  // Upload one prepared file to the private bucket and record its metadata row.
  // Returns the storage path on success (so the caller can compensate on a
  // later failure) or an error message. On a metadata failure it removes the
  // just-uploaded object so no orphan remains.
  const persistAttachment = async (
    requestId: string,
    uploaderId: string,
    type: 'main_pi' | 'reference',
    staged: StagedFile,
  ): Promise<{ path: string; attachmentId: string } | { error: string }> => {
    const file = staged.prepared
    if (!file) return { error: `“${staged.displayName}” is not ready to upload.` }
    const contentType = staged.contentType
    if (!contentType) return { error: `“${staged.displayName}” has an unsupported file type.` }

    const path = buildAttachmentPath(requestId, type, staged.displayName)

    // The prepared File is uploaded EXACTLY as-is. For the Excel Main PI that
    // means the original workbook bytes, its original filename and an Excel
    // content type — never re-encoded, re-zipped or converted, so it downloads
    // and opens later precisely as the salesperson submitted it.
    const { error: upErr } = await supabase.storage
      .from(ORDER_REQ_ATTACHMENT_BUCKET)
      .upload(path, file, { upsert: false, contentType })
    if (upErr) {
      logSubmitFailure('attachment-upload', upErr as RpcErrorLike, requestId)
      // The bucket enforces its own per-file limit, and the project-wide Storage
      // limit sits above it, so an oversized file is refused HERE even though the
      // client already checked. Name that cause precisely instead of a generic
      // "try again" the user cannot act on.
      const msg = (upErr.message ?? '').toLowerCase()
      const tooBig = msg.includes('exceeded the maximum allowed size')
        || msg.includes('payload too large')
        || msg.includes('entity too large')
      return {
        error: tooBig
          ? `“${staged.displayName}” is larger than the upload limit and was rejected by storage.`
          : `Could not upload “${staged.displayName}”. Please try again.`,
      }
    }

    // The row id comes back so a single reference can later be removed on its
    // own (remove_unfinalized_order_request_attachment addresses it by id).
    const { data: metaRow, error: metaErr } = await supabase
      .from('order_request_attachments')
      .insert({
        order_request_id:    requestId,
        attachment_type:     type,
        file_name:           file.name,
        storage_path:        path,
        mime_type:           contentType,
        original_size_bytes: staged.originalSize,
        uploaded_size_bytes: file.size,
        uploaded_by:         uploaderId,
      })
      .select('id')
      .single()
    if (metaErr || !metaRow) {
      logSubmitFailure('attachment-metadata', metaErr ?? { message: 'No metadata row returned.' }, requestId)
      await supabase.storage.from(ORDER_REQ_ATTACHMENT_BUCKET).remove([path]).catch(() => {})
      return { error: `Could not save “${staged.displayName}”. Please try again.` }
    }
    return { path, attachmentId: (metaRow as { id: string }).id }
  }

  const set = (k: keyof RequestForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

  // Abandoning the form must not strand the draft behind it. A draft only exists
  // here after a failed attempt (success closes the modal itself), so closing
  // discards it — objects first, then the row — exactly as a failed submit would.
  const handleClose = () => {
    if (busy) return
    if (draftIdRef.current) void discardDraft()
    onClose()
  }

  // Escape closes; the backdrop does not (form-modal dismissal rule). Locked
  // while uploads are in flight so a mid-upload Escape cannot orphan objects.
  useEscapeToClose(handleClose, !busy)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.client_name.trim()) { setError('Client name is required.'); return }
    const productValueError = validateAmount('Total Product Value', form.total_product_value)
    if (productValueError) { setError(productValueError); return }
    const orderValueError = validateAmount('Total Order Value', form.total_value)
    if (orderValueError) { setError(orderValueError); return }

    // Attachment gates — the Main PI is mandatory and must be prepared; no file
    // may still be processing; and a reference in ANY failed state must be
    // retried or removed first, so a file the user chose is never silently
    // dropped from a request that then reports success.
    if (saving) return  // belt-and-braces against a double submit
    if (preparing) { setError('Please wait for the selected files to finish processing.'); return }
    if (!mainPi)                    { setError('A Main PI file is required before you can submit.'); return }
    if (mainPi.status === 'error')  { setError(mainPi.error ?? 'The Main PI file could not be prepared. Replace it and try again.'); return }
    if (mainPi.status !== 'ready' && mainPi.status !== 'uploaded') { setError('The Main PI file is not ready yet.'); return }
    if (refs.some(r => r.status === 'error')) {
      setError('One or more reference files still need to be retried or removed before this request can be submitted.')
      return
    }
    // Everything not already committed still needs uploading. Files carried over
    // from a previous failed attempt keep their 'uploaded' state and are skipped,
    // so a retry never uploads the same object twice.
    const pendingRefs = refs.filter(r => r.status !== 'uploaded' && r.prepared)

    setSaving(true)
    setError(null)
    setPhase('creating')

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setError('Not authenticated.'); setSaving(false); setPhase('idle'); return }

    // A non-admin can only ever be their own assignee, so the assignee is taken
    // straight from the authenticated session id — never from the (locked) form
    // value, and never trusting a tampered payload. The database enforces the
    // same rule (validate_order_request_assignee, 20260710); this just keeps the
    // client honest. An admin sends whatever eligible assignee they picked.
    const resolvedAssignee = isAdmin ? (form.assigned_to || null) : session.user.id

    // No order number, no display_number: this only creates an order_requests
    // row. request_number (ORD-REQ-YYYY-NNNN) is assigned by the database.
    // requested_by is not a form field: the authenticated user submitting the
    // request is saved automatically, mirroring created_by.
    const payload = {
      client_name:          form.client_name.trim(),
      requested_by:         session.user.id,
      assigned_to:          resolvedAssignee,
      confirm_date:         form.confirm_date || null,
      due_date:             form.due_date     || null,
      total_product_value:  form.total_product_value ? parseFloat(form.total_product_value) : null,
      total_value:          form.total_value  ? parseFloat(form.total_value) : null,
      lead_source:          form.lead_source  || null,
      notes:                form.notes.trim() || null,
      created_by:           session.user.id,
      // ATTACHMENT DRAFT path: send finalized_at = null EXPLICITLY so the row is
      // born an upload-stage draft (invisible / uncounted / unnotified) until the
      // Main PI is uploaded and finalize_order_request() verifies it below.
      //
      // Never omit this key here. Omission is the LEGACY (attachment-unaware)
      // path: the column DEFAULT now() (20260711 §2) would then make the row an
      // immediately operational submission with no Main PI. An explicit null is
      // exactly what separates this new draft flow from that legacy default and
      // is the only way to open a draft. (The insert policy does not enforce
      // this — see 20260711 §2b — so it is a client contract; finalize plus the
      // one-Main-PI index are what actually guarantee a finalized request's PI.)
      finalized_at:         null,
    }

    // Re-use the draft from a previous failed attempt when there is one; only
    // create a row when there is not. This is what prevents a retry from leaving
    // a trail of duplicate drafts.
    let requestId     = draftIdRef.current
    let requestNumber = draftNumberRef.current

    if (!requestId) {
      const { data: created, error: insertErr } = await supabase
        .from('order_requests')
        .insert(payload)
        .select('id, request_number')
        .single()

      if (insertErr || !created) {
        // Classified, never echoed. A missing finalized_at column (the attachment
        // migration has not reached this database) is the ONE case that earns the
        // "system update" sentence; an RLS refusal, a rejected assignee, a dropped
        // connection and an unknown fault each get their own — see
        // submitDraftErrorMessage. Honest failure in every case, never a false
        // success, and never a raw PostgREST/Postgres string in the UI.
        const err: RpcErrorLike = insertErr ?? { message: 'The request was not created.' }
        logSubmitFailure('draft-insert', err)
        setError(submitDraftErrorMessage(err))
        setSaving(false)
        setPhase('idle')
        return
      }
      // The row is an UPLOAD-STAGE DRAFT (explicit finalized_at = null):
      // invisible to reviewers and to a non-creator assignee, uncounted, with no
      // notification and no request_submitted activity. It becomes a real
      // submission ONLY when finalize_order_request() verifies the Main PI below.
      // Precise shape of the select above, rather than letting the untyped
      // PostgREST result widen these two ids to `any`.
      const row = created as { id: string; request_number: string }
      requestId     = row.id
      requestNumber = row.request_number
      draftIdRef.current     = row.id
      draftNumberRef.current = row.request_number
      uploadedPathsRef.current = []
    }

    // ── Main PI (required) ──
    if (mainPi.status !== 'uploaded') {
      setPhase('main')
      setMainPi(prev => (prev ? { ...prev, status: 'uploading', error: null, failedStage: null } : prev))
      const mainRes = await persistAttachment(requestId, session.user.id, 'main_pi', mainPi)
      if ('error' in mainRes) {
        // The Main PI is mandatory, so without it there is nothing to keep: the
        // whole draft is discarded and the user starts the attempt cleanly.
        setMainPi(prev => (prev ? { ...prev, status: 'error', error: mainRes.error, failedStage: 'upload' } : prev))
        await discardDraft()
        setError(`${mainRes.error} The request was not submitted.`)
        setSaving(false)
        setPhase('idle')
        return
      }
      uploadedPathsRef.current = [...uploadedPathsRef.current, mainRes.path]
      setMainPi(prev => (prev ? { ...prev, status: 'uploaded', uploadedPath: mainRes.path, attachmentId: mainRes.attachmentId, error: null, failedStage: null } : prev))
    }

    // ── Reference attachments (optional) ──
    // A failure here does NOT discard the files that already succeeded. Each row
    // records its own outcome, the draft stays alive, and the user retries or
    // removes just the offending file — but the request is NOT finalized while
    // any selected file is unresolved.
    if (pendingRefs.length > 0) setPhase('refs')
    let anyRefFailed = false
    for (const rf of pendingRefs) {
      setRefs(prev => prev.map(r => (r.localId === rf.localId ? { ...r, status: 'uploading', error: null, failedStage: null } : r)))
      const res = await persistAttachment(requestId, session.user.id, 'reference', rf)
      if ('error' in res) {
        anyRefFailed = true
        setRefs(prev => prev.map(r => (r.localId === rf.localId ? { ...r, status: 'error', error: res.error, failedStage: 'upload' } : r)))
        continue
      }
      uploadedPathsRef.current = [...uploadedPathsRef.current, res.path]
      setRefs(prev => prev.map(r => (r.localId === rf.localId ? { ...r, status: 'uploaded', uploadedPath: res.path, attachmentId: res.attachmentId, error: null, failedStage: null } : r)))
    }

    if (anyRefFailed) {
      setError('Some reference files could not be uploaded. Retry or remove them, then submit again — your other files are safe and the request has not been submitted.')
      setSaving(false)
      setPhase('idle')
      return
    }

    // Finalize: the DATABASE verifies exactly one Main PI, flips the request into
    // its normal submitted workflow, and writes request_submitted +
    // attachments_uploaded transactionally. Until this succeeds the request does
    // not exist as a submission. A failure rolls the draft back.
    setPhase('finalizing')
    const { data: finalizeData, error: finalizeErr } = await supabase.rpc('finalize_order_request', {
      p_order_request_id: requestId,
    })
    if (finalizeErr) {
      // Logged BEFORE the rollback, so the diagnostic still carries the draft id
      // that discardDraft is about to clear.
      logSubmitFailure('finalize', finalizeErr, requestId)
      // The draft cannot become a submission, so it is discarded in full rather
      // than left behind — a retry then starts from a clean draft.
      await discardDraft()
      // A missing RPC (migration not applied) is the only "system update" case;
      // MAIN_PI_REQUIRED, MAIN_PI_NOT_EXCEL, an authorisation refusal and a lost
      // connection each name themselves — see finalizeRequestErrorMessage. The
      // previous `does not exist` substring test also caught ordinary runtime
      // failures and mislabelled them as an un-applied migration.
      setError(finalizeRequestErrorMessage(finalizeErr))
      setSaving(false)
      setPhase('idle')
      return
    }

    // Finalized: this draft is now a real submission, so the client lets go of it
    // — no later close/cleanup path may treat it as a discardable draft.
    draftIdRef.current = null
    uploadedPathsRef.current = []

    // finalize_order_request is idempotent: `finalized_now` is true ONLY on the
    // call that performed the first unfinalized→finalized transition. A retry
    // that lands on an already-finalized request returns finalized_now = false,
    // already_finalized = true — still an overall success (the request IS
    // submitted), but it must NOT notify or activity-log a second time. The RPC
    // itself writes no duplicate activity on that path; here we gate the
    // notification on finalized_now so a retry never double-notifies.
    const finalizedNow = (finalizeData as { finalized_now?: boolean } | null)?.finalized_now === true

    // Notify reviewers, and the assigned user when one is set. Fired at most once,
    // only for the first finalization. A delivery failure is non-fatal: the
    // request stays successfully submitted and we surface a soft note rather than
    // a false creation failure (see the success banner).
    let notifyDelivered = true
    if (finalizedNow) {
      notifyDelivered = await notifyOrders({
        event: 'order_submitted',
        requestNumber: requestNumber ?? '',
        entityId: requestId,
        clientName: form.client_name.trim(),
        creatorId: session.user.id,
        assignedTo: resolvedAssignee,
      })
    }

    onSubmitted(requestNumber ?? '', notifyDelivered)
  }

  // Visual system is the Task creation form's (src/app/tasks/create/page.tsx):
  // the shared `.boe-form-section-label` (10px, 700, uppercase, 0.1em tracking)
  // and `.boe-input` (8px radius, 1px rgba(0,0,0,0.13) border, 13px DM Sans, amber
  // focus ring) rather than a second set of hand-rolled inline field styles. The
  // required marker matches the Task form's `*` treatment exactly.
  const req = <span style={{ color: colors.red, fontWeight: 500 }}> *</span>
  const optional = <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>

  // Visually hidden, still announced. The "*" and "(optional)" markers are
  // visual shorthand; screen readers get the words.
  const srOnly: React.CSSProperties = {
    position: 'absolute', width: 1, height: 1, overflow: 'hidden',
    clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
  }

  // Drop zone mirrors the Task form's: 40px, 1.5px dashed, blue-tinted while a
  // file is over it. One instance per target so dropping on Main PI cannot
  // accidentally add reference files.
  const mainPiDrop = useDragAndPaste((files) => { void handlePickMainPi(files[0] ?? null) })
  const refsDrop   = useDragAndPaste((files) => { void handlePickRefs(files) })

  const dropZoneStyle = (active: boolean, enabled: boolean): React.CSSProperties => ({
    width: '100%', height: '40px', boxSizing: 'border-box',
    borderRadius: '8px',
    border: `1.5px dashed ${active ? colors.blue : colors.border}`,
    background: active ? colors.blueTint : colors.raised,
    cursor: enabled ? 'pointer' : 'not-allowed',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    transition: 'border-color 0.15s, background 0.15s',
    opacity: enabled ? 1 : 0.6,
  })

  // Submit is gated on the request being genuinely submittable — the Task form's
  // canSubmit pattern. The required Main PI must be present and settled, nothing
  // may still be processing or uploading, and no file may be sitting in a failed
  // state. This is what makes the disabled button honest rather than decorative.
  const mainPiSettled = mainPi != null && (mainPi.status === 'ready' || mainPi.status === 'uploaded')
  const noFileErrors  = mainPi?.status !== 'error' && !refs.some(r => r.status === 'error')
  const canSubmit = !saving && !preparing && mainPiSettled && noFileErrors && form.client_name.trim().length > 0

  // Assignee (admin) rides in the grid; for a non-admin it becomes the info strip
  // below the header, so its columns shift to keep each row a clean 12 tracks.
  const dateSpanClass = isAdmin ? 'orqm-c4' : 'orqm-c6'

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
      // Backdrop is inert by design (BOE form-modal dismissal rule): an outside
      // click never closes and never discards entered data. Dismiss via ×,
      // Cancel, Escape (useEscapeToClose below), or a successful submit.
    >
      {/* Grid CSS is colocated with the component (unique `orqm-` classes) rather
          than appended to the shared global stylesheet, so the multi-column
          layout always ships and loads with the modal — it cannot be defeated by
          a stale global stylesheet or by inline-style precedence. A 12-track grid
          gives intentional field widths; everything collapses to one column at
          ≤720px. */}
      <style>{`
        .orqm-grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 14px 16px; align-items: start; }
        .orqm-c4 { grid-column: span 4; }
        .orqm-c6 { grid-column: span 6; }
        .orqm-c8 { grid-column: span 8; }
        .orqm-docs { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
        /* min-width:0 lets a long filename ellipsize inside a grid cell instead
           of forcing the track wider and scrolling the whole dialog sideways. */
        .orqm-grid > *, .orqm-docs > * { min-width: 0; }
        @media (max-width: 720px) {
          .orqm-grid > * { grid-column: 1 / -1 !important; }
          .orqm-docs { grid-template-columns: 1fr; }
        }
      `}</style>

      {/* Desktop-first operational frame: ~940px, viewport-capped. Header, the
          non-admin assignee strip, the error banner and the footer are all
          pinned; only the section body between them scrolls, and only when the
          content genuinely grows. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Submit order request"
        style={{
          background: colors.base,
          border: `1px solid ${colors.border}`,
          // Task form's restrained card treatment: 10px radius and the same
          // soft 1px shadow, rather than a heavier modal-specific elevation.
          borderRadius: '10px',
          width: 'min(940px, calc(100vw - 40px))',
          maxHeight: 'calc(100vh - 40px)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 4px 24px rgba(0,0,0,0.12)',
        }}
      >
        {/* Compact header */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px',
          padding: '14px 20px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Submit Order Request</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              A request number will be assigned after submission.
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: busy ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex', flexShrink: 0, marginTop: '1px' }}
          >
            <X size={17} />
          </button>
        </div>

        {/* Non-admin: compact "assigned to you" strip instead of a large disabled
            field. The assignee id still comes from the session on submit — this is
            display only (mirrors the admin-less branch of the assignee rule). */}
        {!isAdmin && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '9px',
            padding: '8px 20px', background: colors.raised,
            borderBottom: `1px solid ${colors.border}`, flexShrink: 0,
          }}>
            <User size={15} color={colors.muted} style={{ flexShrink: 0 }} />
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '3px 8px', minWidth: 0 }}>
              <span style={{ fontSize: '12.5px', color: colors.primary }}>
                Assigned to: <strong style={{ fontWeight: 600 }}>{currentUserName}</strong>
              </span>
              <span style={{ fontSize: '11.5px', color: colors.muted }}>This request will be assigned to you.</span>
            </div>
          </div>
        )}

        {/* Form — flex column: scrollable section body + pinned error/footer. */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* Scrollable body */}
          <div style={{ padding: '14px 20px', overflowY: 'auto', overflowX: 'hidden', flex: 1, display: 'flex', flexDirection: 'column', gap: '13px' }}>

            {/* ── Section 1: Request information ── */}
            <section>
              <div className="orqm-grid">
                <div className="orqm-c8">
                  <label className="boe-form-section-label" htmlFor="orq-client-name">Client Name{req}</label>
                  <input id="orq-client-name" className="boe-input" value={form.client_name} onChange={set('client_name')} placeholder="Client name" required />
                </div>

                <div className="orqm-c4">
                  <label className="boe-form-section-label" htmlFor="orq-lead-source">Lead Source</label>
                  <select id="orq-lead-source" className="boe-input" value={form.lead_source} onChange={set('lead_source')}>
                    <option value="">— Select —</option>
                    {LEAD_SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>

                {isAdmin && (
                  <div className="orqm-c4">
                    <label className="boe-form-section-label" htmlFor="orq-assignee">Assignee</label>
                    <select id="orq-assignee" className="boe-input" value={form.assigned_to} onChange={set('assigned_to')}>
                      <option value="">— Select —</option>
                      {salesAssignees.length > 0 && (
                        <optgroup label="Sales Team">
                          {salesAssignees.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                        </optgroup>
                      )}
                      {overrideAssignees.length > 0 && (
                        <optgroup label="Authorised Assignees">
                          {overrideAssignees.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                        </optgroup>
                      )}
                    </select>
                  </div>
                )}

                <div className={dateSpanClass}>
                  <label className="boe-form-section-label" htmlFor="orq-confirm-date">Confirmation Date</label>
                  <input id="orq-confirm-date" type="date" className="boe-input" style={{ colorScheme: 'light' }} value={form.confirm_date} onChange={set('confirm_date')} />
                </div>
                <div className={dateSpanClass}>
                  <label className="boe-form-section-label" htmlFor="orq-due-date">Due Date</label>
                  <input id="orq-due-date" type="date" className="boe-input" style={{ colorScheme: 'light' }} value={form.due_date} onChange={set('due_date')} />
                </div>

                <div className="orqm-c6">
                  <label className="boe-form-section-label" htmlFor="orq-product-value">Product Value</label>
                  <div style={{ position: 'relative', display: 'flex' }}>
                    <span aria-hidden="true" style={{ position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)', fontSize: '13px', color: colors.muted, pointerEvents: 'none' }}>₹</span>
                    <input id="orq-product-value" type="number" min="0" step="0.01" className="boe-input" style={{ paddingLeft: '23px' }} value={form.total_product_value} onChange={set('total_product_value')} placeholder="0" />
                  </div>
                </div>
                <div className="orqm-c6">
                  <label className="boe-form-section-label" htmlFor="orq-total-value">Total Order Value</label>
                  <div style={{ position: 'relative', display: 'flex' }}>
                    <span aria-hidden="true" style={{ position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)', fontSize: '13px', color: colors.muted, pointerEvents: 'none' }}>₹</span>
                    <input id="orq-total-value" type="number" min="0" step="0.01" className="boe-input" style={{ paddingLeft: '23px' }} value={form.total_value} onChange={set('total_value')} placeholder="0" />
                  </div>
                </div>
              </div>
            </section>

            {/* ── Section 2: Documents (above Notes) — two upload targets ── */}
            <section>
              <div className="orqm-docs">
                {/* Left — Main PI (mandatory, single).
                    role="group" + aria-labelledby gives the whole control its
                    "Main PI (required)" name WITHOUT competing with the button's
                    own name, so there is exactly one accessible name per control.
                    htmlFor additionally makes the visible label click through to
                    the hidden input, which is the native behaviour users expect. */}
                <div role="group" aria-labelledby="orq-mainpi-label">
                  <label className="boe-form-section-label" id="orq-mainpi-label" htmlFor="orq-mainpi-input">
                    Main PI{req}<span style={srOnly}>(required)</span>
                  </label>
                  <input
                    id="orq-mainpi-input"
                    ref={mainPiInputRef}
                    type="file"
                    accept={MAIN_PI_ACCEPT}
                    style={{ display: 'none' }}
                    onChange={e => { void handlePickMainPi(e.target.files?.[0] ?? null) }}
                  />
                  {mainPi && (
                    <div style={{ marginBottom: '6px' }}>
                      <AttachmentStagedRow
                        staged={mainPi}
                        disabled={inFlight}
                        onRemove={inFlight ? undefined : () => { void removeMainPi() }}
                      />
                    </div>
                  )}
                  <div
                    style={{ position: 'relative' }}
                    onDragOver={mainPiDrop.onDragOver}
                    onDragEnter={mainPiDrop.onDragEnter}
                    onDragLeave={mainPiDrop.onDragLeave}
                    onDrop={inFlight ? undefined : mainPiDrop.onDrop}
                  >
                    <button
                      ref={mainPiButtonRef}
                      type="button"
                      onClick={() => mainPiInputRef.current?.click()}
                      disabled={inFlight}
                      style={dropZoneStyle(mainPiDrop.dropActive, !inFlight)}
                    >
                      <FileText size={13} color={colors.secondary} strokeWidth={1.8} />
                      <span style={{ fontSize: '12px', color: colors.secondary }}>
                        {mainPi ? 'Replace Excel PI' : 'Add Excel PI'}
                      </span>
                    </button>
                    {mainPiDrop.dropActive && (
                      <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        pointerEvents: 'none', fontSize: '12px', fontWeight: 600, color: colors.blue,
                        background: 'rgba(255,255,255,0.6)', borderRadius: '8px',
                      }}>
                        Drop the Excel PI
                      </div>
                    )}
                  </div>
                  <p style={{ fontSize: '10px', color: colors.muted, marginTop: '4px' }}>
                    Excel workbook (.xlsx or .xls), up to {formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)} — stored exactly as submitted
                  </p>
                </div>

                {/* Right — reference attachments (optional, multiple) */}
                <div role="group" aria-labelledby="orq-refs-label">
                  <label className="boe-form-section-label" id="orq-refs-label" htmlFor="orq-refs-input">
                    Reference Attachments {optional}
                  </label>
                  <input
                    id="orq-refs-input"
                    ref={refsInputRef}
                    type="file"
                    multiple
                    accept={REFERENCE_ACCEPT}
                    style={{ display: 'none' }}
                    onChange={e => { void handlePickRefs(Array.from(e.target.files ?? [])) }}
                  />
                  {refs.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px' }}>
                      {refs.map(r => (
                        <AttachmentStagedRow
                          key={r.localId}
                          staged={r}
                          disabled={inFlight}
                          onRetry={() => { void retryRef(r.localId) }}
                          onRemove={inFlight ? undefined : () => { void removeRef(r.localId) }}
                        />
                      ))}
                    </div>
                  )}
                  <div
                    style={{ position: 'relative' }}
                    onDragOver={refsDrop.onDragOver}
                    onDragEnter={refsDrop.onDragEnter}
                    onDragLeave={refsDrop.onDragLeave}
                    onDrop={inFlight ? undefined : refsDrop.onDrop}
                  >
                    <button
                      ref={refsButtonRef}
                      type="button"
                      onClick={() => refsInputRef.current?.click()}
                      disabled={inFlight}
                      style={dropZoneStyle(refsDrop.dropActive, !inFlight)}
                    >
                      <Paperclip size={13} color={colors.secondary} strokeWidth={1.8} />
                      <span style={{ fontSize: '12px', color: colors.secondary }}>
                        {refs.length > 0 ? 'Add more files' : 'Add files'}
                      </span>
                    </button>
                    {refsDrop.dropActive && (
                      <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        pointerEvents: 'none', fontSize: '12px', fontWeight: 600, color: colors.blue,
                        background: 'rgba(255,255,255,0.6)', borderRadius: '8px',
                      }}>
                        Drop files to attach
                      </div>
                    )}
                  </div>
                  <p style={{ fontSize: '10px', color: colors.muted, marginTop: '4px' }}>
                    PDF, image, Word, Excel, CSV or TXT, up to {formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)} each — larger images are compressed automatically
                  </p>
                </div>
              </div>
            </section>

            {/* ── Section 3: Notes (last, full width) ── */}
            <section>
              <label className="boe-form-section-label" htmlFor="orq-notes">Notes {optional}</label>
              <textarea
                id="orq-notes"
                className="boe-input"
                rows={4}
                style={{ resize: 'none' }}
                value={form.notes}
                onChange={set('notes')}
                placeholder="Add any special instructions or context…"
              />
            </section>
          </div>

          {/* Pinned error banner — always visible near the submit action. Only
              whole-submission failures land here; per-file problems stay on their
              own file row. aria-live so a screen reader hears the failure and the
              live upload phase without moving focus. */}
          <div aria-live="polite" style={{ flexShrink: 0 }}>
            {error && (
              <div style={{ padding: '0 20px' }}>
                <div role="alert" style={{
                  fontSize: '12px', color: colors.red,
                  background: colors.redTint, border: '1px solid rgba(217,79,79,0.25)',
                  borderRadius: '8px', padding: '9px 12px', marginBottom: '2px',
                }}>
                  {error}
                </div>
              </div>
            )}
            <span style={{
              position: 'absolute', width: 1, height: 1, overflow: 'hidden',
              clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
            }}>
              {phase === 'main' ? 'Uploading Main PI'
                : phase === 'refs' ? 'Uploading reference attachments'
                : phase === 'finalizing' ? 'Submitting request'
                : ''}
            </span>
          </div>

          {/* Compact pinned footer — required note left, actions right. It sits
              outside the scroll area, so it never overlaps a field or the error. */}
          <div style={{
            display: 'flex', gap: '12px', justifyContent: 'space-between', alignItems: 'center',
            flexWrap: 'wrap',
            padding: '12px 20px', borderTop: `1px solid ${colors.border}`, flexShrink: 0, background: colors.base,
          }}>
            <span style={{ fontSize: '11px', color: colors.muted }}>
              <span style={{ color: colors.red }}>*</span> Required fields
            </span>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginLeft: 'auto' }}>
              <button type="button" onClick={handleClose} disabled={busy} style={{
                padding: '10px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
                background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
                cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
              }}>
                Cancel
              </button>
              {/* Primary action uses the Task form's button language exactly:
                  dark `colors.primary` when actionable, and the muted
                  `colors.float`/`colors.muted` pair when not — a disabled state
                  that stays legible instead of a dimmed-out colour block. */}
              <button type="submit" disabled={!canSubmit} style={{
                padding: '10px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
                background: canSubmit ? colors.primary : colors.float,
                border: 'none',
                color: canSubmit ? '#fff' : colors.muted,
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                transition: 'background 0.15s, color 0.15s',
                letterSpacing: '0.01em',
              }}>
                {preparing
                  ? 'Processing files…'
                  : phase === 'creating'
                    ? 'Preparing request…'
                    : phase === 'main'
                      ? 'Uploading Main PI…'
                      : phase === 'refs'
                        ? 'Uploading attachments…'
                        : phase === 'finalizing'
                          ? 'Submitting…'
                          : 'Submit Request'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}


// ── Main page ─────────────────────────────────────────────────────────────────

export default function OrderRequestsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <OrderRequestsPageInner />
    </Suspense>
  )
}

function OrderRequestsPageInner() {
  const [pageLoading,   setPageLoading]   = useState(true)
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string>('')
  const [requests,      setRequests]      = useState<OrderRequest[]>([])
  const [assigneeOptions, setAssigneeOptions] = useState<AssigneeOption[]>([])
  const [listLoading,   setListLoading]   = useState(false)
  const [search,        setSearch]        = useState('')
  const [showModal,     setShowModal]     = useState(false)
  const [successNumber, setSuccessNumber] = useState<string | null>(null)
  // True when a request finalized successfully but its notification could not be
  // delivered — a soft, non-blocking note, never a creation failure.
  const [successNotifyFailed, setSuccessNotifyFailed] = useState(false)
  // Pre-conversion parking: total + count of suspense payments parked on each
  // request via order_request_id (20260698). null means the aggregate could not
  // be read at all — rendered as "—", never as a false ₹0.
  const [linkedByRequest, setLinkedByRequest] = useState<Record<string, RequestLinkAgg> | null>(null)

  const router       = useRouter()
  const searchParams = useSearchParams()

  // ?tab= from the Admin Action Queue selects the initial tab; manual tab
  // clicks below still just call setStatusTab and are otherwise untouched.
  const [statusTab, setStatusTab] = useState<StatusFilter>(() => parseStatusFilter(searchParams.get('tab')))

  // Guards the one-time deep-link resolution below so it can never re-fire.
  const deepLinkHandled = useRef(false)
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()

  const loadRequests = async () => {
    setListLoading(true)
    // Converted requests are excluded HERE, not by a tab filter: this module
    // lists only requests that still need action, and conversion is the exit
    // from it. The row is never deleted — it stays in public.order_requests
    // permanently (and 20260701's orders.source_order_request_id FK makes that
    // a database guarantee), reachable through the Confirmed Order it produced.
    // Excluding by status is exact rather than approximate:
    // order_requests_converted_consistency (20260680) makes status='converted'
    // and converted_order_id IS NOT NULL equivalent, so this filter drops every
    // converted row and no other.
    const { data } = await supabase
      .from('order_requests')
      .select(`
        id, request_number, client_name,
        requested_by, assigned_to,
        confirm_date, due_date, total_value, total_product_value, lead_source, notes,
        status, created_by, clarification_note, rejection_reason, created_at, converted_order_id,
        requested_by_user:users!requested_by(full_name),
        assigned_to_user:users!assigned_to(full_name)
      `)
      .neq('status', 'converted')
      // Exclude upload-stage drafts (finalized_at IS NULL): a request that has
      // not been finalized has no verified Main PI and is not a real submission.
      // RLS already hides other people's drafts; this also hides the viewer's own.
      .not('finalized_at', 'is', null)
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: OrderRequest[] = ((data ?? []) as any[]).map(r => ({
      ...r,
      requested_by_name:            r.requested_by_user?.full_name ?? undefined,
      assigned_to_name:             r.assigned_to_user?.full_name  ?? undefined,
      requested_by_user: undefined,
      assigned_to_user:  undefined,
    }))
    setRequests(mapped)
    // Keeps OrdersLayout's "Order Requests" nav badge (a separate query, so it
    // stays live on every /orders/* page, not just this one) in sync with
    // every reload here. The badge counts the same scope as the "All" tab, so
    // any reload that can change which requests appear must invalidate it.
    queryClient.invalidateQueries({ queryKey: ['order-requests', 'total-count'] })

    // Advance-received aggregation — one batched query, no per-row N+1: the
    // suspense payments parked on the listed requests (order_request_id,
    // 20260698) for the pre-conversion total + count. The post-conversion
    // figure is not needed here, because no converted request is listed.
    //
    // Run for every viewer, not just admins. The query is keyed to the ids of
    // requests already on screen, and a non-admin only ever sees requests they
    // own or are assigned — for which
    // finance_payment_requests_order_request_owner_select (20260699) and its
    // assignee counterpart (20260707) expose every attached payment. So the
    // sums are complete for both roles, and the requester sees the same advance
    // figure the admin does. A failed query leaves the map null, which renders
    // as "—" rather than a false ₹0.
    const requestIds = mapped.map(r => r.id)

    const parkedRes = requestIds.length > 0
      ? await supabase
          .from('finance_payment_requests')
          .select('order_request_id, amount')
          .eq('status', 'approved_unlinked')
          .in('order_request_id', requestIds)
      : { data: [], error: null }

    if (parkedRes.error) {
      setLinkedByRequest(null)
    } else {
      const parked: Record<string, RequestLinkAgg> = {}
      for (const p of (parkedRes.data ?? []) as { order_request_id: string | null; amount: number | string }[]) {
        const amt = Number(p.amount)
        if (p.order_request_id && Number.isFinite(amt)) {
          const agg = parked[p.order_request_id] ?? { total: 0, count: 0 }
          agg.total += amt
          agg.count += 1
          parked[p.order_request_id] = agg
        }
      }
      setLinkedByRequest(parked)
    }

    setListLoading(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setCurrentUserId(session.user.id)

      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code')
        .eq('id', session.user.id)
        .single()
      setProfile(me as UserProfile)

      // Sales team + explicitly authorised Order Assignees only — never every
      // active user. resolve_permission-backed, so overrides never need to be
      // read directly by a non-admin client (employee_permission_overrides
      // RLS only allows a user to read their own row).
      const { data: assigneesData } = await supabase.rpc('list_eligible_order_assignees')
      setAssigneeOptions((assigneesData ?? []) as AssigneeOption[])

      // The advance aggregates are RLS-scoped, not role-scoped, so this no
      // longer needs the freshly-read role handed in.
      await loadRequests()
      setPageLoading(false)

      // Reclaim any of this user's own abandoned upload-stage drafts (an
      // interrupted session). Best-effort and non-blocking — never delays the UI.
      void sweepStaleDrafts(supabase, session.user.id)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Deep-link resolution ────────────────────────────────────────────────────
  // A record deep link (?request=<id>, optionally &action=convert) belongs to
  // the dedicated detail page now, so it is FORWARDED there rather than opening
  // anything here — there is only one detail experience. `from` carries the tab
  // so the detail page's Back returns to the right list view; `action` rides
  // along untouched and is re-checked against the same admin + status condition
  // the manual Convert button requires, on the page that owns that action.
  //
  // Runs once on mount, before the list finishes loading: the target record is
  // resolved by the detail page's own query, so there is nothing to wait for.
  useEffect(() => {
    if (deepLinkHandled.current) return
    deepLinkHandled.current = true

    const requestId = searchParams.get('request')
    const action    = searchParams.get('action')
    const rawTab    = searchParams.get('tab')

    if (requestId) {
      const qs = new URLSearchParams({ from: statusTab })
      if (action === 'convert') qs.set('action', 'convert')
      router.replace(`/orders/requests/${requestId}?${qs.toString()}`)
      return
    }

    if (rawTab != null && rawTab !== statusTab) {
      // A tab-only link carrying a retired key (?tab=active) or an unrecognized
      // one. The page already resolved it to statusTab; rewrite the address bar
      // to match so the old spelling does not survive in history, bookmarks, or
      // anything copied out of the URL bar.
      router.replace(`/orders/requests?tab=${statusTab}`)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // Grouped for the Assignee dropdowns' optgroups; sorted defensively even
  // though list_eligible_order_assignees() already orders by (source, name).
  const salesAssignees = useMemo(
    () => assigneeOptions.filter(u => u.source === 'sales').sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [assigneeOptions]
  )
  const overrideAssignees = useMemo(
    () => assigneeOptions.filter(u => u.source === 'override').sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [assigneeOptions]
  )

  const visible = useMemo(() => {
    const tab = STATUS_TABS.find(t => t.key === statusTab) ?? STATUS_TABS[0]
    const list = requests.filter(r => tab.match(r.status))
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(r =>
      r.request_number.toLowerCase().includes(q) ||
      r.client_name.toLowerCase().includes(q)
    )
  }, [requests, statusTab, search])

  // Per-tab record counts — computed from the already-loaded `requests` list
  // (no extra query), using each tab's own `match` so a count can never drift
  // from what selecting that tab actually shows. Deliberately ignores the
  // search box: these are total records in the category, not the current
  // filtered view, so switching tabs or typing a search term never changes them.
  const tabCounts = useMemo(() => {
    const counts = {} as Record<StatusFilter, number>
    for (const tab of STATUS_TABS) {
      counts[tab.key] = requests.filter(r => tab.match(r.status)).length
    }
    return counts
  }, [requests])

  const isAdmin = profile?.role === 'admin'

  // Opening a request navigates to its own page. `from` carries the current tab
  // so Back returns to the same view. `link` is set only by the table's Link
  // action, which asks the detail page to expand its payment-link panel; an
  // ordinary open never does.
  const openRequest = (r: OrderRequest, link = false) => {
    const qs = new URLSearchParams({ from: statusTab })
    if (link) qs.set('link', '1')
    router.push(`/orders/requests/${r.id}?${qs.toString()}`)
  }

  if (pageLoading) return <LoadingScreen />

  return (
    <OrdersLayout
      profile={profile}
      title="Order Requests"
      subtitle="Submit and track order requests before they become official orders."
      onSignOut={handleSignOut}
      onRefresh={loadRequests}
    >
      {successNumber && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '13px', color: '#166534',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={15} />
            Request submitted — <strong>{successNumber}</strong>. No order has been created yet.
            {successNotifyFailed && ' The request was created successfully, but the notification could not be delivered.'}
          </span>
          <button
            onClick={() => { setSuccessNumber(null); setSuccessNotifyFailed(false) }}
            aria-label="Dismiss message"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Search + submit toolbar ── form controls only; the status
          navigation lives on the table card below so the two never read as the
          same kind of control. Creating a request belongs here, on the module
          that owns Order Requests. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        marginBottom: '10px',
      }}>
        <input
          className="boe-input"
          placeholder="Search by request number or client…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: '180px', maxWidth: '320px', padding: '6px 10px', fontSize: '12px' }}
        />
        <button
          onClick={() => setShowModal(true)}
          style={{
            padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
            background: '#DC1F2E', border: 'none', color: '#fff', cursor: 'pointer',
            whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          + New Order Request
        </button>
      </div>

      {/* ── Table, with the status strip as its own header ── */}
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        <StatusTabs
          tabs={STATUS_TABS.map(t => ({ key: t.key, label: t.label, Icon: t.Icon, accent: t.accent, count: tabCounts[t.key] }))}
          active={statusTab}
          onSelect={setStatusTab}
          summary={
            listLoading
              ? 'Loading…'
              : search.trim()
                ? `${visible.length} of ${tabCounts[statusTab]} visible`
                : `${visible.length} request${visible.length !== 1 ? 's' : ''}`
          }
        />

        {listLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            No order requests found.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['Request #', 'Client', 'Assignee', 'Confirmation Date', 'Due Date', 'Value', 'Advance Received', 'Status'].map(h => (
                    <th key={h} style={{
                      padding: '8px 16px', textAlign: 'left',
                      fontSize: '10px', fontWeight: 600, color: colors.muted,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open order request ${r.request_number}`}
                    onClick={() => openRequest(r)}
                    onKeyDown={e => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRequest(r) }
                    }}
                    style={{
                      cursor: 'pointer',
                      borderBottom: `1px solid ${colors.border}`,
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                    onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
                  >
                    <td style={{ padding: '11px 16px', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={e => { e.stopPropagation(); openRequest(r) }}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          font: 'inherit', fontWeight: 600, color: colors.primary,
                          textDecoration: 'underline', textUnderlineOffset: '3px',
                          textDecorationColor: colors.borderMed,
                        }}
                      >
                        {r.request_number}
                      </button>
                      {r.status === 'needs_clarification' && r.clarification_note && (
                        <div
                          title={r.clarification_note}
                          style={{
                            fontSize: '11px', fontWeight: 500, color: '#1E40AF', marginTop: '2px',
                            maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          ? {r.clarification_note}
                        </div>
                      )}
                      {r.status === 'rejected' && r.rejection_reason && (
                        <div
                          title={r.rejection_reason}
                          style={{
                            fontSize: '11px', fontWeight: 500, color: '#991B1B', marginTop: '2px',
                            maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          ✕ {r.rejection_reason}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.primary, maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.client_name}>
                      {r.client_name}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.assigned_to_name ?? undefined}>
                      {r.assigned_to_name ?? '—'}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {fmtDate(r.confirm_date)}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {fmtDate(r.due_date)}
                    </td>
                    <td style={{ padding: '11px 16px', whiteSpace: 'nowrap' }}>
                      <div style={{ fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                        {fmtAmount(r.total_value)}
                      </div>
                      <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>
                        Products: {fmtAmount(r.total_product_value)}
                      </div>
                    </td>
                    <td style={{ padding: '11px 16px', whiteSpace: 'nowrap' }}>
                      <AdvanceCell
                        info={getAdvanceInfo(r, linkedByRequest)}
                        canLink={canManagePayments(r, currentUserId, isAdmin)}
                        onLink={() => openRequest(r, true)}
                      />
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <SubmitRequestModal
          salesAssignees={salesAssignees}
          overrideAssignees={overrideAssignees}
          currentUserId={currentUserId}
          currentUserName={profile?.full_name ?? 'You'}
          isAdmin={isAdmin}
          onClose={() => setShowModal(false)}
          onSubmitted={(requestNumber, notifyDelivered) => {
            setShowModal(false)
            setSuccessNumber(requestNumber)
            setSuccessNotifyFailed(!notifyDelivered)
            loadRequests()
          }}
        />
      )}
    </OrdersLayout>
  )
}
