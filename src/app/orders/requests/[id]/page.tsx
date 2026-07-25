'use client'

// ── Order Request detail page ─────────────────────────────────────────────────
// The primary detail experience for one Order Request. Opening a request from
// /orders/requests navigates here; there is no longer a full detail modal.
//
// The page is the RECORD — identity, exceptions needing attention, the
// commercial figures, the request content, its attachments, its payments, and
// its complete recorded history. The focused DECISIONS taken on it (Convert,
// Clarify, Reject, Delete, Edit / Resubmit / Reapply, Link / Unlink a payment)
// stay modal, because each is one deliberate act on the record in view.
//
// Every authorization rule is the shared one (components/shared.ts), which
// mirrors — and never widens — the server-side gate it names. Nothing here
// decides access; it only decides whether to render a control the database
// would allow.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { ArrowLeft, CalendarCheck2, CalendarClock, CheckCircle2, MoreHorizontal } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import { prepareAttachment } from '@/lib/orderRequestAttachments'
import {
  RequestAttachmentsCard,
  RequestPaymentLinkPanel,
  RequestPaymentsCard,
  SectionHeader,
  StatusBadge,
  LinkedPaymentDetailsModal,
  UnlinkPaymentModal,
} from '../components/RequestPanels'
import {
  ClarifyModal,
  ConvertModal,
  DeleteRequestModal,
  RejectModal,
} from '../components/RequestActionModals'
import { RequestActivityTimeline } from '../components/RequestActivityTimeline'
import {
  buildAttachmentEditForm,
  describeAttachmentEdits,
  editInputStyle,
  editModeNotice,
  formFromRequest,
  hasAttachmentEdits,
  persistRequestForm,
  validateAttachmentEdits,
  validateRequestForm,
  EMPTY_ATTACHMENT_EDITS,
  REQUEST_EDIT_META,
  type AttachmentEdits,
  type RequestEditMode,
  type StagedAttachment,
} from '../components/RequestInlineEdit'
import {
  advanceFromPayments,
  canEditAttachments,
  canEditRequest,
  canManagePayments,
  fmtAmount,
  fmtDate,
  headerActionClass,
  isPermittedRequester,
  EMPTY_FORM,
  LEAD_SOURCE_OPTIONS,
  type AssigneeOption,
  type ConvertResult,
  type LinkedPayment,
  type OrderRequest,
  type RequestAttachmentRow,
  type RequestForm,
} from '../components/shared'

// The desktop reading width for an operational record. Wide enough for the
// payments table to breathe, narrow enough that the label/value rows do not
// stretch into unreadable lines on an ultrawide monitor.
const CONTENT_MAX_WIDTH = '1440px'

// ── Attention banner ──────────────────────────────────────────────────────────
// One row per live exception, rendered only when there is genuinely something
// to act on. Each carries the actual reason or missing item — never a generic
// "needs attention".

type BannerTone = 'info' | 'warning' | 'danger' | 'success'

const BANNER_TONE: Record<BannerTone, { bg: string; border: string; color: string }> = {
  info:    { bg: '#EFF6FF', border: '#BFDBFE', color: '#1E3A8A' },
  warning: { bg: '#FFF7ED', border: '#FED7AA', color: '#9A3412' },
  danger:  { bg: '#FEF2F2', border: '#FECACA', color: '#7F1D1D' },
  success: { bg: '#F0FDF4', border: '#BBF7D0', color: '#166534' },
}

function AttentionBanner({ tone, title, body, action }: {
  tone: BannerTone
  title: string
  body?: string
  action?: React.ReactNode
}) {
  const t = BANNER_TONE[tone]
  return (
    <div style={{
      background: t.bg, border: `1px solid ${t.border}`, borderRadius: '8px',
      padding: '10px 14px', display: 'flex', alignItems: 'flex-start',
      justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: t.color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {title}
        </div>
        {body && (
          <div style={{ fontSize: '13px', color: t.color, lineHeight: 1.55, marginTop: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {body}
          </div>
        )}
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  )
}

// ── Shared field label ────────────────────────────────────────────────────────
// One label treatment for every figure, date and metadata field on the left
// side, so the whole record reads on a single typographic grid rather than as
// several sections that each invented their own.
const FIELD_LABEL: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

// ── Commercial summary ────────────────────────────────────────────────────────
// Four aligned figures in a 2×2 block inside the Commercial Summary card,
// separated by the 1px divider grid (the border-coloured grid gap) so they read
// as a ledger rather than as four banner statistics. The arrangement is fixed by
// .boe-record-metrics (globals.css) and collapses to one column only on a very
// narrow phone.
// Unavailable states ("Not linked", "—") render at body weight in muted text so
// they can never masquerade as financial figures.

function MetricGroup({ label, value, note, valueMuted, editor }: {
  label: string
  value: string
  note?: string
  valueMuted?: boolean
  // Replaces the figure with a control while the record is being edited. Only
  // the two values that belong to the request itself ever pass one — a derived
  // figure (Advance Received, Payment Position) is never editable here.
  editor?: React.ReactNode
}) {
  return (
    <div style={{
      background: colors.base, padding: '11px 14px', minWidth: 0,
      display: 'flex', flexDirection: 'column', gap: '3px',
    }}>
      <span style={FIELD_LABEL}>{label}</span>
      {editor ?? (
        <span style={{
          fontSize: valueMuted ? '13.5px' : '19px',
          fontWeight: valueMuted ? 500 : 700,
          lineHeight: valueMuted ? '23px' : 1.2,
          color: valueMuted ? colors.muted : colors.primary,
          fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word',
        }}>
          {value}
        </span>
      )}
      {note && !editor && <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.4 }}>{note}</span>}
    </div>
  )
}

// ── Key dates ─────────────────────────────────────────────────────────────────
// Confirmation Date and Due Date drive the operation, so they are grouped in
// their own card beside the commercial summary instead of sitting as two
// ordinary metadata rows further down. They are NOT repeated in the Request
// Record. Each tile stays COMPACT: important enough to be read first, not large
// enough to be a band in its own right.
//
// The label carries the icon inline and the figure sits beneath it, so a tile
// stays readable at the ~180px it gets when both dates share the card — an
// icon-then-everything row would push the date itself into two lines there.
//
// Due Date carries more weight than Confirmation Date: it is the commitment
// someone is judged against. Its only semantic states are NORMAL and OVERDUE —
// there is deliberately no "approaching" tier, because the codebase has no
// approved threshold for one and inventing a number here would create a
// business rule by accident.

function DateTile({
  label, icon, value, hint, tone, emphasis, editor,
}: {
  label: string
  icon: React.ReactNode
  value: string
  hint?: string
  tone: 'neutral' | 'overdue'
  /** The Due Date tile renders larger and on a tinted surface. */
  emphasis?: boolean
  editor?: React.ReactNode
}) {
  const overdue = tone === 'overdue'
  return (
    <div style={{
      // Grows to fill the card's height when the row beside it is taller, so the
      // difference lands inside the tiles instead of as a blank strip below them.
      flex: '1 1 150px', minWidth: 0,
      background: overdue ? '#FEF2F2' : emphasis ? colors.raised : colors.base,
      border: `1px solid ${overdue ? '#FECACA' : emphasis ? colors.borderSoft : colors.border}`,
      borderRadius: '8px', padding: '9px 11px',
      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '3px',
    }}>
      <span style={{
        display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0,
        ...FIELD_LABEL,
        color: overdue ? '#B91C1C' : colors.muted,
      }}>
        <span style={{ display: 'flex', flexShrink: 0 }} aria-hidden="true">{icon}</span>
        {label}
      </span>
      {editor ?? (
        <span style={{
          fontSize: emphasis ? '16px' : '14.5px',
          fontWeight: emphasis ? 700 : 600,
          lineHeight: 1.25,
          color: overdue ? '#991B1B' : colors.primary,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {value}
        </span>
      )}
      {hint && !editor && (
        <span style={{ fontSize: '11px', lineHeight: 1.4, color: overdue ? '#B91C1C' : colors.muted }}>
          {hint}
        </span>
      )}
    </div>
  )
}

// ── Record metadata field ─────────────────────────────────────────────────────
// Label ABOVE value, on the same label treatment as the figures and the dates.
// The two-column metadata grid gives each field roughly 180px, where a
// right-aligned label/value row would either collide or force a long assignee
// name onto a ragged second line; stacking lets it wrap in its own cell.
// The same component renders the read value and the edit control, so switching
// modes changes the CONTROL and never the structure around it.

function RecordField({ label, value, muted, hint, htmlFor, editor }: {
  label: string
  value?: string
  muted?: boolean
  hint?: string
  /** Set together with `editor` so the label is the control's real <label>. */
  htmlFor?: string
  editor?: React.ReactNode
}) {
  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {editor && htmlFor
        ? <label htmlFor={htmlFor} style={FIELD_LABEL}>{label}</label>
        : <span style={FIELD_LABEL}>{label}</span>}
      {editor ?? (
        <span style={{
          fontSize: '13.5px', lineHeight: 1.45, wordBreak: 'break-word',
          color: muted ? colors.muted : colors.primary,
        }}>
          {value}
        </span>
      )}
      {hint && (
        <span style={{ fontSize: '10.5px', color: colors.muted, lineHeight: 1.4 }}>{hint}</span>
      )}
    </div>
  )
}

// ── Action buttons ────────────────────────────────────────────────────────────
// Exactly one solid PRIMARY per state; everything else is a QUIET action on a
// white raised surface with a real border. Prominence follows the record state
// and the viewer's permission — it is never uniform.
//
// Every action is a real <button>. Its surface, border, hover, active, focus-
// visible and disabled states all come from the single shared .boe-record-action
// rule in globals.css via headerActionClass() — the states that a class can
// express and an inline style cannot. The page body inherits the #F4F5F7 app
// background, so a secondary action rides on WHITE with a solid border rather
// than on a low-alpha hairline that grey would swallow. Inline style here is
// layout only, never colour.

// Small solid button used inside the green confirmation/converted banners, where
// the surrounding surface is already coloured and the shared class would clash.
const BANNER_BTN: React.CSSProperties = {
  padding: '5px 12px', borderRadius: '7px', fontSize: '12px', fontWeight: 600,
  background: '#166534', border: '1px solid #166534', color: '#fff',
  cursor: 'pointer', whiteSpace: 'nowrap',
}

// Overflow for irreversible actions. Keeping Delete out of the bar means it can
// never be hit while reaching for Reject, and the bar stays readable at a
// glance. Renders nothing when the viewer has no such action — the permission
// rules decide that, exactly as before.
function MoreActionsMenu({ actions }: { actions: { label: string; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false)
  if (actions.length === 0) return null

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className={headerActionClass('icon')}
        style={{ background: open ? colors.float : undefined }}
      >
        <MoreHorizontal size={15} strokeWidth={2} />
      </button>

      {open && (
        <>
          {/* Click-away catcher — no document listener, no ref read. */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setOpen(false)} />
          <div
            role="menu"
            style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100,
              background: colors.base, border: `1px solid ${colors.border}`,
              borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
              minWidth: '180px', overflow: 'hidden',
            }}
          >
            {actions.map((a, idx) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); a.onClick() }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '9px 14px', background: 'none', border: 'none',
                  borderBottom: idx === actions.length - 1 ? 'none' : `1px solid ${colors.border}`,
                  font: 'inherit', fontSize: '13px', color: '#991B1B', cursor: 'pointer',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#FEF2F2' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OrderRequestDetailPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <OrderRequestDetailPageInner />
    </Suspense>
  )
}

function OrderRequestDetailPageInner() {
  const params       = useParams()
  const router       = useRouter()
  const searchParams = useSearchParams()
  const queryClient  = useQueryClient()
  const supabase     = useMemo(() => createClient(), [])

  const requestId = params.id as string
  // The list tab this request was opened from, so Back returns to the same
  // view rather than dumping the reader on the default tab. Absent for a
  // notification or a pasted link, which simply return to the list's default.
  const fromTab   = searchParams.get('from')
  const backHref  = fromTab ? `/orders/requests?tab=${encodeURIComponent(fromTab)}` : '/orders/requests'

  const [pageLoading,   setPageLoading]   = useState(true)
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [currentUserId, setCurrentUserId] = useState('')
  const [request,       setRequest]       = useState<OrderRequest | null>(null)
  const [notFound,      setNotFound]      = useState(false)
  const [assigneeOptions, setAssigneeOptions] = useState<AssigneeOption[]>([])

  // Payments attached to this request. `null` rows means the query itself
  // failed — reported as unavailable, never as "no payments" or a false ₹0.
  const [payments,       setPayments]       = useState<LinkedPayment[] | null>([])
  const [linkedBy,       setLinkedBy]       = useState<Record<string, string>>({})
  const [paymentsLoading, setPaymentsLoading] = useState(true)
  const [paymentsError,  setPaymentsError]  = useState<string | null>(null)

  const [attachments,        setAttachments]        = useState<RequestAttachmentRow[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(true)
  const [attachmentsError,   setAttachmentsError]   = useState(false)

  // Focused-action modals. Each is opened by an explicit action on this page.
  const [convertTarget,  setConvertTarget]  = useState(false)
  const [clarifyTarget,  setClarifyTarget]  = useState(false)
  const [rejectTarget,   setRejectTarget]   = useState(false)
  const [deleteTarget,   setDeleteTarget]   = useState(false)
  const [viewPayment,    setViewPayment]    = useState<LinkedPayment | null>(null)
  const [unlinkPayment,  setUnlinkPayment]  = useState<LinkedPayment | null>(null)

  // ── Inline editing ──────────────────────────────────────────────────────────
  // Editing happens ON this page: the fields the viewer may change become
  // controls in place and Save commits them through the RPC that matches the
  // mode. No dialog, no second copy of the record.
  const [editMode,  setEditMode]  = useState<RequestEditMode | null>(null)
  const [form,      setForm]      = useState<RequestForm>(EMPTY_FORM)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  // Staged attachment changes. Purely local until Save succeeds — nothing here
  // has touched Storage or the database.
  const [attachmentEdits, setAttachmentEdits] = useState<AttachmentEdits>(EMPTY_ATTACHMENT_EDITS)

  const [linkPanelOpen, setLinkPanelOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  // Focus is a side effect on a DOM node, so it is requested by bumping this
  // counter and performed in the effect below — the search input does not exist
  // yet at the moment the panel is asked to open.
  const [focusLinkSearch, setFocusLinkSearch] = useState(0)

  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [converted,     setConverted]     = useState<ConvertResult | null>(null)
  // Set once the request has actually been deleted. The record no longer
  // exists, so the page stops rendering it and reports the outcome instead.
  const [deleted, setDeleted] = useState<{ requestNumber: string; unlinkedCount: number } | null>(null)
  // Bumped after any action that writes history, so the timeline re-reads.
  const [activityKey, setActivityKey] = useState(0)

  // Opens the payment-link panel and asks for the search box to take focus.
  // The focus itself happens in the effect below, once the input exists.
  const openLinkPanel = () => {
    setLinkPanelOpen(true)
    setFocusLinkSearch(n => n + 1)
  }

  useEffect(() => {
    if (focusLinkSearch === 0) return
    searchInputRef.current?.focus()
  }, [focusLinkSearch])

  // ── Loaders ─────────────────────────────────────────────────────────────────

  // Returns the loaded record as well as storing it, so the one-shot deep-link
  // resolution in init() can evaluate its conditions against the freshly read
  // row rather than against state that has not committed yet.
  const loadRequest = async (): Promise<OrderRequest | null> => {
    const { data, error } = await supabase
      .from('order_requests')
      .select(`
        id, request_number, client_name,
        requested_by, assigned_to, created_by,
        confirm_date, due_date, total_value, total_product_value, lead_source, notes,
        status, clarification_note, rejection_reason, created_at, updated_at,
        finalized_at, converted_order_id,
        requested_by_user:users!requested_by(full_name),
        assigned_to_user:users!assigned_to(full_name),
        created_by_user:users!created_by(full_name)
      `)
      .eq('id', requestId)
      .maybeSingle()

    // A row the viewer cannot see under RLS comes back as no row, which is the
    // same answer as a deleted or mistyped id — all three are "not found" here,
    // deliberately, so the page never confirms the existence of a record the
    // viewer has no access to.
    if (error || !data) { setNotFound(true); setRequest(null); return null }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = data as any

    // An upload-stage draft (finalized_at IS NULL) is not a real submission: it
    // has no verified Main PI and is excluded from every list and count. It is
    // not a viewable record either.
    if (raw.finalized_at == null) { setNotFound(true); setRequest(null); return null }

    const mapped = {
      ...raw,
      requested_by_name: raw.requested_by_user?.full_name ?? undefined,
      assigned_to_name:  raw.assigned_to_user?.full_name  ?? undefined,
      created_by_name:   raw.created_by_user?.full_name   ?? undefined,
      requested_by_user: undefined,
      assigned_to_user:  undefined,
      created_by_user:   undefined,
    } as OrderRequest

    setNotFound(false)
    setRequest(mapped)
    return mapped
  }

  // The payments attached to this request, read with the viewer's own RLS by
  // order_request_id. Owned by the page rather than by the payments card,
  // because the same rows also produce the Advance Received figure and the
  // "no linked advance" exception — one page must not fetch them twice.
  const loadPayments = async () => {
    setPaymentsLoading(true)
    setPaymentsError(null)
    const columns = `
      id, request_number, client_name, amount, payment_date, payment_mode,
      received_in, proof_note, sales_note, status, payment_against,
      order_id, order_number, order_request_id, order_request_number,
      submitted_by, created_at,
      submitted_by_user:users!submitted_by(full_name)
    `
    const [payRes, actRes] = await Promise.all([
      supabase
        .from('finance_payment_requests').select(columns).eq('order_request_id', requestId)
        .order('payment_date', { ascending: false }).order('id', { ascending: false }),
      // "Linked by" comes from the request's own activity trail, the only place
      // the linker is recorded. A payment attached during conversion from the
      // admin's manual selection has no such row and honestly shows "—" rather
      // than borrowing the submitter's name.
      supabase
        .from('order_request_activity')
        .select('details, created_at, actor:users!actor_id(full_name)')
        .eq('order_request_id', requestId)
        .eq('event_type', 'payment_linked')
        .order('created_at', { ascending: true }),
    ])

    if (payRes.error) {
      setPayments(null)
      setPaymentsError('Could not load the payments for this request.')
      setPaymentsLoading(false)
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPayments(((payRes.data ?? []) as any[]).map(p => ({
      ...p,
      amount: Number(p.amount),
      submitted_by_name: p.submitted_by_user?.full_name ?? undefined,
      submitted_by_user: undefined,
    })) as LinkedPayment[])

    const actors: Record<string, string> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of (actRes.data ?? []) as any[]) {
      const paymentId = row?.details?.payment_id
      const actor = Array.isArray(row?.actor) ? row.actor[0] : row?.actor
      // Ascending order means a later re-link overwrites an earlier one.
      if (typeof paymentId === 'string') actors[paymentId] = actor?.full_name ?? 'System'
    }
    setLinkedBy(actors)
    setPaymentsLoading(false)
  }

  const loadAttachments = async () => {
    setAttachmentsLoading(true)
    const { data, error } = await supabase
      .from('order_request_attachments')
      .select('id, attachment_type, file_name, storage_path, uploaded_size_bytes')
      .eq('order_request_id', requestId)
      .order('attachment_type', { ascending: true })   // main_pi before reference
      .order('created_at', { ascending: true })
    setAttachmentsError(!!error)
    setAttachments((data ?? []) as RequestAttachmentRow[])
    setAttachmentsLoading(false)
  }

  // Everything the record is made of, re-read together. Used by the layout's
  // Refresh control and after every committed action, so the page always shows
  // real state rather than an optimistic patch.
  const reloadAll = async () => {
    await Promise.all([loadRequest(), loadPayments(), loadAttachments()])
    setActivityKey(k => k + 1)
    // The Order Requests nav badge counts the same scope this record belongs
    // to, so any change that can move it out of that scope (conversion,
    // deletion, a status move) must invalidate the badge query.
    queryClient.invalidateQueries({ queryKey: ['order-requests', 'total-count'] })
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
      // active user. Needed by the Edit / Resubmit / Reapply form's assignee
      // dropdown; resolve_permission-backed, so overrides never need to be read
      // directly by a non-admin client.
      const { data: assigneesData } = await supabase.rpc('list_eligible_order_assignees')
      setAssigneeOptions((assigneesData ?? []) as AssigneeOption[])

      const [loaded] = await Promise.all([loadRequest(), loadPayments(), loadAttachments()])
      setPageLoading(false)

      // ── Deep links ──────────────────────────────────────────────────────────
      // ?action=convert  — from the Admin Action Queue, and from the retired
      //                    /orders/requests?request=…&action=convert form that
      //                    the list now forwards here.
      // ?link=1          — from the list's inline "Link payment" cell action.
      //
      // Resolved HERE, once, against the freshly loaded record and role rather
      // than in a render effect: the conditions are the SAME shared rules the
      // manual controls use, so a stale link on a request that has moved on
      // simply does nothing. Both params are then stripped from the URL, so a
      // refresh or a Back navigation can never reopen something the reader has
      // already closed.
      if (loaded) {
        const action = searchParams.get('action')
        const link   = searchParams.get('link')
        if (action || link) {
          const meIsAdmin = (me as UserProfile | null)?.role === 'admin'
          if (action === 'convert' && meIsAdmin && loaded.status === 'submitted') {
            setConvertTarget(true)
          }
          if (link === '1' && canManagePayments(loaded, session.user.id, meIsAdmin)) {
            openLinkPanel()
          }
          // Keep `from` so Back still returns to the originating list tab.
          router.replace(
            fromTab
              ? `/orders/requests/${requestId}?from=${encodeURIComponent(fromTab)}`
              : `/orders/requests/${requestId}`
          )
        }
      }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  const isAdmin = profile?.role === 'admin'

  // ── Derived permissions ─────────────────────────────────────────────────────
  // Each mirrors, and never widens, the server-side gate named in shared.ts.
  const canReview       = !!request && isAdmin && request.status === 'submitted'
  const isRequester     = !!request && isPermittedRequester(request, currentUserId)
  const canResubmit     = !!request && request.status === 'needs_clarification' && isRequester
  const canReapply      = !!request && request.status === 'rejected' && isRequester
  const canEditNow      = !!request && canEditRequest(request, currentUserId, isAdmin)
  const canAttachments  = !!request && canEditAttachments(request, currentUserId, isAdmin)
  const canPayments     = !!request && canManagePayments(request, currentUserId, isAdmin)
  // Deleting an Order Request is admin-only and only while it is UNCONVERTED —
  // the same rule order_requests_admin_delete_unconverted and the
  // order_requests_prevent_converted_delete trigger enforce server-side
  // (20260705000000). A converted request produced a Confirmed Order and is
  // permanent source history, so it never offers this.
  const canDelete       = !!request && isAdmin && request.status !== 'converted' && !request.converted_order_id

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // ── Inline edit lifecycle ───────────────────────────────────────────────────
  const startEdit = (mode: RequestEditMode) => {
    if (!request) return
    setForm(formFromRequest(request))
    setAttachmentEdits(EMPTY_ATTACHMENT_EDITS)
    setEditError(null)
    // Payment linking is a separate workflow that reloads the record when it
    // succeeds; collapsing it keeps exactly one thing in progress at a time.
    setLinkPanelOpen(false)
    setEditMode(mode)
  }

  // Cancel restores the untouched read state: the field values come back from
  // the record on the next startEdit, and every staged attachment change is
  // dropped. Nothing was uploaded or deleted, so there is nothing to undo
  // server-side.
  const cancelEdit = () => {
    setEditMode(null)
    setEditError(null)
    setAttachmentEdits(EMPTY_ATTACHMENT_EDITS)
  }

  // ── Attachment staging ──────────────────────────────────────────────────────
  // Every selected file goes through the SAME prepareAttachment pipeline the
  // creation form uses — identical type allow-list, 10 MB ceiling, image
  // compression and .xlsx image optimisation — so a replacement can never be
  // held to a weaker standard than an original. The route and the RPC then
  // re-validate independently.
  const stageFile = async (
    file: File,
    category: 'main_pi' | 'reference',
    slot: { kind: 'main' } | { kind: 'ref'; replacesId?: string; replacesName?: string },
  ) => {
    const localId = `staged-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const placeholder: StagedAttachment = {
      localId,
      displayName:  file.name,
      file:         null,
      contentType:  null,
      originalSize: file.size,
      finalSize:    null,
      compressed:   false,
      status:       'preparing',
      error:        null,
      ...(slot.kind === 'ref' && slot.replacesId
        ? { replacesId: slot.replacesId, replacesName: slot.replacesName }
        : {}),
    }

    setAttachmentEdits(e => slot.kind === 'main'
      ? { ...e, mainPi: placeholder }
      : {
          ...e,
          addRefs: [...e.addRefs, placeholder],
          removeRefIds: slot.replacesId && !e.removeRefIds.includes(slot.replacesId)
            ? [...e.removeRefIds, slot.replacesId]
            : e.removeRefIds,
        })

    const result = await prepareAttachment(file, category)
    const resolved: StagedAttachment = result.ok
      ? { ...placeholder, file: result.file, contentType: result.contentType,
          finalSize: result.finalSize, compressed: result.compressed, status: 'ready', error: null }
      : { ...placeholder, status: 'error', error: result.error }

    // Only apply to the slot this result belongs to — the user may have picked
    // a different file while a large workbook was still being optimised.
    setAttachmentEdits(e => slot.kind === 'main'
      ? (e.mainPi?.localId === localId ? { ...e, mainPi: resolved } : e)
      : { ...e, addRefs: e.addRefs.map(a => (a.localId === localId ? resolved : a)) })
  }

  const undoStagedMainPi = () => setAttachmentEdits(e => ({ ...e, mainPi: null }))

  // Discarding a staged addition also un-stages the removal it was replacing,
  // so a cancelled Replace leaves the original file exactly where it was.
  const discardStagedRef = (localId: string) => setAttachmentEdits(e => {
    const target = e.addRefs.find(a => a.localId === localId)
    return {
      ...e,
      addRefs: e.addRefs.filter(a => a.localId !== localId),
      removeRefIds: target?.replacesId
        ? e.removeRefIds.filter(id => id !== target.replacesId)
        : e.removeRefIds,
    }
  })

  const stageRemoveRef = (attachmentId: string) => setAttachmentEdits(e =>
    e.removeRefIds.includes(attachmentId)
      ? e
      : { ...e, removeRefIds: [...e.removeRefIds, attachmentId] })

  // Undo also drops any replacement staged against that row.
  const undoRemoveRef = (attachmentId: string) => setAttachmentEdits(e => ({
    ...e,
    removeRefIds: e.removeRefIds.filter(id => id !== attachmentId),
    addRefs: e.addRefs.filter(a => a.replacesId !== attachmentId),
  }))

  // Applies the staged attachment changes through the authenticated route.
  // Returns an error sentence, or null. On failure NOTHING has changed: the
  // route removes anything it uploaded and the RPC transaction rolled back.
  const applyAttachmentEdits = async (requestId: string): Promise<string | null> => {
    const fd = buildAttachmentEditForm(requestId, attachmentEdits)

    // The route owns the wording of every outcome it can identify, because only
    // it knows whether the metadata transaction committed. The two fallbacks here
    // cover the cases where NO usable answer came back, and they deliberately do
    // NOT claim "nothing was changed": from the browser's side an aborted or
    // unparseable response is indistinguishable from a save that succeeded after
    // the connection dropped, and a false "nothing changed" on a record that DID
    // change is the one error this rail exists to prevent.
    let body: { success?: boolean; error?: string; orphan_warning?: boolean } | null = null
    try {
      const res = await fetch('/api/orders/requests/attachments/edit', { method: 'POST', body: fd })
      body = await res.json().catch(() => null)
      if (!res.ok || !body?.success) {
        return body?.error
          ?? 'The server did not confirm the attachment changes. Refresh the page to see whether they were applied.'
      }
    } catch {
      return 'Could not reach the server to save the attachment changes. Refresh the page to see whether they were applied.'
    }
    return null
  }

  const setField = (k: keyof RequestForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

  // One Save applies the field changes AND any staged attachment changes.
  //
  // Attachments go FIRST, deliberately. Storage and Postgres cannot share a
  // transaction, so a partial outcome is possible in principle; ordering the
  // riskier, multi-step operation first means its failure aborts the whole save
  // with nothing changed at all — the cleanest story for the reader. If the
  // field RPC then fails, the attachments are already applied and the message
  // says so, and a retry saves only the fields (the staging is empty by then).
  const saveEdit = async () => {
    if (!request || !editMode || savingEdit) return

    const invalid = validateRequestForm(form) ?? validateAttachmentEdits(attachmentEdits)
    if (invalid) { setEditError(invalid); return }

    setSavingEdit(true)
    setEditError(null)

    let attachmentsApplied = false
    if (hasAttachmentEdits(attachmentEdits)) {
      const attachmentFailure = await applyAttachmentEdits(request.id)
      if (attachmentFailure) {
        setSavingEdit(false)
        setEditError(attachmentFailure)
        return   // nothing saved; staged changes stay for a retry
      }
      attachmentsApplied = true
      setAttachmentEdits(EMPTY_ATTACHMENT_EDITS)
    }

    const failure = await persistRequestForm({ supabase, mode: editMode, request, form })
    setSavingEdit(false)
    if (failure) {
      setEditError(attachmentsApplied
        ? `The attachment changes were saved, but the details could not be: ${failure}`
        : failure)
      if (attachmentsApplied) await reloadAll()
      return
    }

    const mode = editMode
    setEditMode(null)
    setConverted(null)
    const attachmentNote = attachmentsApplied ? ' Attachments updated.' : ''
    setActionMessage(
      mode === 'edit'
        ? `${request.request_number} updated.${attachmentNote}`
        : mode === 'resubmit'
          ? `${request.request_number} updated and resubmitted. It is back under review.${attachmentNote}`
          : `${request.request_number} updated and reapplied. It is back under review.${attachmentNote}`
    )
    await reloadAll()
  }

  // Grouped for the assignee dropdown's optgroups; sorted defensively even
  // though list_eligible_order_assignees() already orders by (source, name).
  const salesAssignees = useMemo(
    () => assigneeOptions.filter(u => u.source === 'sales').sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [assigneeOptions]
  )
  const overrideAssignees = useMemo(
    () => assigneeOptions.filter(u => u.source === 'override').sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [assigneeOptions]
  )

  if (pageLoading) return <LoadingScreen />

  // ── Deleted ─────────────────────────────────────────────────────────────────
  // The record is gone, so it is not rendered. The outcome — including what
  // happened to any payments that were parked on it — is reported instead.
  if (deleted) {
    return (
      <OrdersLayout profile={profile} title="Order Request Deleted" onSignOut={handleSignOut}>
        <div style={{ maxWidth: '620px', margin: '40px auto', textAlign: 'center' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>
            {deleted.requestNumber} has been deleted.
          </div>
          <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.6, marginTop: '8px' }}>
            {deleted.unlinkedCount > 0
              ? `${deleted.unlinkedCount} payment${deleted.unlinkedCount === 1 ? '' : 's'} returned to Suspense and can be attached elsewhere.`
              : 'No payments were affected.'}
          </div>
          <button onClick={() => router.replace(backHref)} className={headerActionClass('primary')} style={{ marginTop: '20px' }}>
            Back to Order Requests
          </button>
        </div>
      </OrdersLayout>
    )
  }

  if (notFound || !request) {
    return (
      <OrdersLayout profile={profile} title="Order Request Not Found" onSignOut={handleSignOut}>
        <div style={{ maxWidth: '620px', margin: '40px auto', textAlign: 'center' }}>
          <div style={{ fontSize: '14px', color: colors.muted, lineHeight: 1.6 }}>
            This order request does not exist, or you don&apos;t have access to it.
          </div>
          <button onClick={() => router.push(backHref)} className={headerActionClass()} style={{ marginTop: '20px' }}>
            Back to Order Requests
          </button>
        </div>
      </OrdersLayout>
    )
  }

  const r = request
  const advance = advanceFromPayments(payments)
  const mainPi  = attachments.find(a => a.attachment_type === 'main_pi') ?? null

  // ── Exceptions worth the reader's attention, in the order they matter ──
  const isOverdue = !!r.due_date
    && !['converted', 'rejected'].includes(r.status)
    && new Date(r.due_date) < new Date()

  const banners: React.ReactNode[] = []

  // Suppressed while the just-converted confirmation is on screen: that message
  // says the same thing with more detail and carries the same Open Order
  // control, so showing both would be one fact stated twice.
  if (r.converted_order_id && !converted) {
    banners.push(
      <AttentionBanner
        key="converted"
        tone="success"
        title="Converted to a Confirmed Order"
        body="This request is permanent source history and can no longer be edited or deleted."
        action={
          <button onClick={() => router.push(`/orders/${r.converted_order_id}`)} style={BANNER_BTN}>
            Open Order
          </button>
        }
      />
    )
  }
  // clarification_note is cleared on resubmit and rejection_reason on reapply,
  // so presence tracks the live state — the same rule the detail modal used.
  if (r.clarification_note) {
    banners.push(<AttentionBanner key="clarify" tone="info" title="Clarification requested" body={r.clarification_note} />)
  }
  if (r.rejection_reason) {
    banners.push(<AttentionBanner key="reject" tone="danger" title="Rejection reason" body={r.rejection_reason} />)
  }
  if (isOverdue) {
    banners.push(
      <AttentionBanner key="overdue" tone="warning" title="Due date passed"
        body={`This request was due on ${fmtDate(r.due_date)} and is still open.`} />
    )
  }
  // Only stated once the attachments have actually been read — an unread or
  // failed query must never be reported as a missing document.
  if (!attachmentsLoading && !attachmentsError && !mainPi && r.status !== 'converted') {
    banners.push(
      <AttentionBanner key="mainpi" tone="warning" title="Main PI missing"
        body="No Main PI is attached to this request. It was submitted before Main PI attachments were required." />
    )
  }
  // "No advance linked" is deliberately NOT a banner: the Advance Received
  // figure in the summary strip already states it in the one place a reader
  // looks for it, and Link Payment is one control in the action bar. Repeating
  // the same fact and the same control three times is noise, not attention.

  // ── Actions ─────────────────────────────────────────────────────────────────
  // Three tiers, so prominence tracks consequence instead of being uniform:
  //   primary  — the one action this record state is waiting for (solid),
  //   quiet    — routine work on an open request (outlined, muted),
  //   review   — the reviewer's other decision (outlined, red text for Reject),
  //   menu     — destructive, kept out of the bar entirely.
  // Every tier is populated from the same shared permission guards; grouping is
  // presentation only and changes no rule.
  const primaryAction = canReview
    ? { label: 'Convert to Order',    onClick: () => setConvertTarget(true) }
    : canResubmit
      ? { label: 'Update and Resubmit', onClick: () => startEdit('resubmit') }
      : canReapply
        ? { label: 'Update and Reapply', onClick: () => startEdit('reapply') }
        : canEditNow
          ? { label: 'Edit Request',       onClick: () => startEdit('edit') }
          : null

  const quietActions: { label: string; onClick: () => void }[] = []
  // Edit only appears here when something else already took the primary slot.
  if (canEditNow && primaryAction?.label !== 'Edit Request') {
    quietActions.push({ label: 'Edit Request', onClick: () => startEdit('edit') })
  }
  if (canPayments) {
    quietActions.push({ label: 'Link Payment', onClick: openLinkPanel })
  }

  const reviewActions: { label: string; onClick: () => void; danger?: boolean }[] = []
  if (canReview) {
    reviewActions.push({ label: 'Request Clarification', onClick: () => setClarifyTarget(true) })
    reviewActions.push({ label: 'Reject Request', onClick: () => setRejectTarget(true), danger: true })
  }

  // Deletion is irreversible and rare. It stays available to exactly the same
  // people as before, but out of the main bar so it can never be hit while
  // reaching for Reject.
  const menuActions: { label: string; onClick: () => void }[] = []
  if (canDelete) menuActions.push({ label: 'Delete Request', onClick: () => setDeleteTarget(true) })

  const leadSourceLabel = LEAD_SOURCE_OPTIONS.find(o => o.value === r.lead_source)?.label ?? '—'
  // Only worth stating when it genuinely differs from the requester — an admin
  // raising a request on a salesperson's behalf is exactly that case.
  const showCreatedBy = !!r.created_by && r.created_by !== r.requested_by
  // Compared as RENDERED dates, not raw timestamps: a request touched minutes
  // after submission has a different updated_at but the same calendar day, and
  // printing "25 Jul 2026" twice under two labels tells the reader nothing.
  const submittedOnLabel = fmtDate(r.created_at)
  const lastUpdatedLabel = r.updated_at && fmtDate(r.updated_at) !== submittedOnLabel
    ? fmtDate(r.updated_at)
    : null
  // A currently-assigned user who no longer qualifies (inactive, or neither
  // Sales nor explicitly authorised) is kept as a selectable option so an edit
  // never silently reassigns the request away from them.
  const stagedAttachmentSummary = editMode ? describeAttachmentEdits(attachmentEdits) : null
  const legacyAssigneeOutOfList = !!r.assigned_to
    && !salesAssignees.some(u => u.id === r.assigned_to)
    && !overrideAssignees.some(u => u.id === r.assigned_to)

  const cardStyle: React.CSSProperties = {
    border: `1px solid ${colors.border}`, borderRadius: '10px',
    overflow: 'hidden', background: colors.base,
  }
  const cardHeadStyle: React.CSSProperties = {
    padding: '10px 14px', borderBottom: `1px solid ${colors.border}`,
  }

  return (
    <OrdersLayout
      profile={profile}
      // The sticky app header carries the MODULE, exactly as it does on the
      // list. The record's own identity is stated once, in the page header
      // below — putting it in both is the duplication this layout removes.
      title="Order Requests"
      onSignOut={handleSignOut}
      onRefresh={reloadAll}
    >
      <div style={{ maxWidth: CONTENT_MAX_WIDTH, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* ── Record header ────────────────────────────────────────────────────
            Back, identity and the action bar in ONE compact block. The
            assignee / requester / submitted-on fields are deliberately absent:
            they are record metadata and are stated once, in Ownership & Record
            below, rather than being repeated as a header strapline. ── */}
        <div style={{ paddingBottom: '12px', borderBottom: `1px solid ${colors.border}` }}>
          <button
            onClick={() => router.push(backHref)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              background: 'none', border: 'none', padding: 0, marginBottom: '10px',
              font: 'inherit', fontSize: '12px', fontWeight: 500,
              color: colors.tertiary, cursor: 'pointer',
            }}
          >
            <ArrowLeft size={13} strokeWidth={2} /> Back to Order Requests
          </button>

          <div style={{
            display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
            gap: '16px', flexWrap: 'wrap',
          }}>
            <div style={{ minWidth: 0, flex: '1 1 320px' }}>
              {/* The CLIENT is what a reader recognises a request by, so it is
                  the heading. The request number is the filing reference — it
                  identifies the record but nobody scans a page for it, so it
                  sits above in small tabular type beside the status. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: '12px', fontWeight: 600, color: colors.tertiary,
                  letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums',
                }}>
                  {r.request_number}
                </span>
                <StatusBadge status={r.status} />
              </div>
              {editMode ? (
                <input
                  aria-label="Client name"
                  value={form.client_name}
                  onChange={setField('client_name')}
                  disabled={savingEdit}
                  style={{
                    ...editInputStyle,
                    marginTop: '4px', maxWidth: '420px',
                    fontSize: '19px', fontWeight: 700, padding: '5px 10px',
                  }}
                />
              ) : (
                <h1 style={{
                  margin: '3px 0 0', fontSize: '21px', fontWeight: 700, color: colors.primary,
                  letterSpacing: '-0.01em', lineHeight: 1.25, wordBreak: 'break-word',
                }}>
                  {r.client_name}
                </h1>
              )}
            </div>

            {/* In edit mode the bar becomes Cancel + Save: no other action may
                run against a record with uncommitted changes on screen. */}
            {editMode ? (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button onClick={cancelEdit} disabled={savingEdit} className={headerActionClass()}>
                  Cancel
                </button>
                <button onClick={saveEdit} disabled={savingEdit} className={headerActionClass('primary')}>
                  {savingEdit ? REQUEST_EDIT_META[editMode].saving : REQUEST_EDIT_META[editMode].submit}
                </button>
              </div>
            ) : (primaryAction || quietActions.length > 0 || reviewActions.length > 0 || menuActions.length > 0) ? (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                {quietActions.map(a => (
                  <button key={a.label} onClick={a.onClick} className={headerActionClass()}>{a.label}</button>
                ))}
                {reviewActions.map(a => (
                  <button key={a.label} onClick={a.onClick} className={headerActionClass(a.danger ? 'danger' : 'secondary')}>
                    {a.label}
                  </button>
                ))}
                {primaryAction && (
                  <button onClick={primaryAction.onClick} className={headerActionClass('primary')}>{primaryAction.label}</button>
                )}
                <MoreActionsMenu actions={menuActions} />
              </div>
            ) : null}
          </div>

          {/* What saving will do, and anything that stopped it. Sits inside the
              header block so it is beside the Save button that owns it. */}
          {editMode && (
            <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{
                fontSize: '12.5px', color: '#1E3A8A', lineHeight: 1.55,
                background: '#EFF6FF', border: '1px solid #BFDBFE',
                borderRadius: '8px', padding: '9px 12px',
              }}>
                {editModeNotice(editMode, r.status)}
                {stagedAttachmentSummary && (
                  <span style={{ display: 'block', marginTop: '4px', fontWeight: 600 }}>
                    Pending attachment changes: {stagedAttachmentSummary}
                  </span>
                )}
              </div>
              {editError && (
                <div style={{
                  fontSize: '12.5px', color: colors.red, lineHeight: 1.55,
                  background: '#FEF2F2', border: '1px solid #FECACA',
                  borderRadius: '8px', padding: '9px 12px',
                }}>
                  {editError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Confirmation of a just-completed action ── */}
        {converted && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '12px', flexWrap: 'wrap',
            padding: '10px 14px', borderRadius: '8px',
            background: '#F0FDF4', border: '1px solid #BBF7D0',
            fontSize: '13px', color: '#166534',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <CheckCircle2 size={15} />
              {converted.request_number} converted — official Order{' '}
              <strong>{converted.order_display_number}</strong> created
              {converted.linked_payment_count > 0
                ? `, ${converted.linked_payment_count} payment${converted.linked_payment_count !== 1 ? 's' : ''} linked.`
                : '.'}
            </span>
            <button
              onClick={() => router.push(`/orders/${converted.order_id}`)}
              style={BANNER_BTN}
            >
              Open Order
            </button>
          </div>
        )}

        {actionMessage && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', borderRadius: '8px',
            background: '#F0FDF4', border: '1px solid #BBF7D0',
            fontSize: '13px', color: '#166534',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <CheckCircle2 size={15} />
              {actionMessage}
            </span>
            <button
              onClick={() => setActionMessage(null)}
              aria-label="Dismiss message"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
            >
              ✕
            </button>
          </div>
        )}

        {/* ── Attention banners — rendered only when something needs acting on ── */}
        {banners.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>{banners}</div>
        )}

        {/* ── Main content ─────────────────────────────────────────────────────
            LEFT is the whole record, top to bottom: the commercial figures, the
            key dates, the files, the request's own fields and its payments.
            RIGHT is the activity history and nothing else — no ownership, no
            status, no controls, no payments.

            The rail STARTS LEVEL with the commercial summary rather than
            alongside the attachments: the history belongs to the entire record,
            not to one section of it, and beginning it here also stops the
            figures and dates from eating the full page width first.

            The rail holds ~340px on a desktop — the left column takes all the
            remaining width through the 999:1 grow ratio, which puts the rail at
            roughly 25–28% of the content area across normal desktop widths. It
            wraps to full width below ~918px of content, stacking left content
            then activity, with no horizontal scrolling. The activity card is
            never given a fixed height, so it has no scrollbar of its own. ── */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'flex-start' }}>

          {/* LEFT — the record workspace: two aligned columns over three rows
              (.boe-record-row / --col-main / --col-side in globals.css), so the
              figures, the dates, the files and the record's own fields read as
              one surface rather than as five stacked bands. */}
          <div style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>

            {/* ── Row 1 — what the request is worth, and when it is due ── */}
            <div className="boe-record-row boe-record-row--top">

              {/* Commercial summary — figures only in read mode; the two values
                  that belong to the request itself become inputs in place while
                  editing. Linking is an action and lives in the action bar, so
                  the card never carries a control. */}
              <div className="boe-record-col-main" style={{ ...cardStyle, display: 'flex', flexDirection: 'column' }}>
                <div style={cardHeadStyle}><SectionHeader>Commercial Summary</SectionHeader></div>
                <div className="boe-record-metrics" style={{ background: colors.border, flex: 1 }}>
                  <MetricGroup
                    label="Total Order Value"
                    value={fmtAmount(r.total_value)}
                    valueMuted={r.total_value == null}
                    editor={editMode ? (
                      <input
                        type="number" min="0" step="0.01"
                        aria-label="Total Order Value"
                        value={form.total_value}
                        onChange={setField('total_value')}
                        disabled={savingEdit}
                        style={{ ...editInputStyle, fontSize: '15px', fontWeight: 700 }}
                      />
                    ) : undefined}
                  />
                  <MetricGroup
                    label="Total Product Value"
                    value={fmtAmount(r.total_product_value)}
                    valueMuted={r.total_product_value == null}
                    editor={editMode ? (
                      <input
                        type="number" min="0" step="0.01"
                        aria-label="Total Product Value"
                        value={form.total_product_value}
                        onChange={setField('total_product_value')}
                        disabled={savingEdit}
                        style={{ ...editInputStyle, fontSize: '15px', fontWeight: 700 }}
                      />
                    ) : undefined}
                  />
                  {advance.kind === 'request_linked' ? (
                    <MetricGroup
                      label="Advance Received"
                      value={formatINR(advance.received)}
                      note={`${advance.count} payment${advance.count !== 1 ? 's' : ''} linked`}
                    />
                  ) : advance.kind === 'not_linked' ? (
                    <MetricGroup
                      label="Advance Received"
                      value="Not linked"
                      valueMuted
                      note={canPayments ? 'Use Link Payment to attach one' : 'Payments link after conversion'}
                    />
                  ) : (
                    <MetricGroup label="Advance Received" value="—" valueMuted note="Could not be loaded" />
                  )}
                  {/* Deliberately withheld before conversion: until an official
                      Order exists there is no Order value to anchor a payment
                      position against, and an invented percentage would be worse
                      than none. */}
                  <MetricGroup
                    label="Payment Position"
                    value="—"
                    valueMuted
                    note={r.converted_order_id ? 'Tracked on the Confirmed Order' : 'Available after conversion'}
                  />
                </div>
              </div>

              {/* Key dates — one grouped card, still two compact tiles. They are
                  side by side while the card can hold both and stack inside it
                  when it cannot; they are never repeated as metadata rows. */}
              <div className="boe-record-col-side" style={{ ...cardStyle, display: 'flex', flexDirection: 'column' }}>
                <div style={cardHeadStyle}><SectionHeader>Key Dates</SectionHeader></div>
                <div style={{
                  padding: '12px 14px', flex: 1,
                  display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'stretch',
                }}>
                  <DateTile
                    label="Confirmation Date"
                    icon={<CalendarCheck2 size={13} strokeWidth={2} />}
                    value={fmtDate(r.confirm_date)}
                    tone="neutral"
                    editor={editMode ? (
                      <input
                        type="date"
                        aria-label="Confirmation Date"
                        value={form.confirm_date}
                        onChange={setField('confirm_date')}
                        disabled={savingEdit}
                        style={{ ...editInputStyle, fontSize: '13px', fontWeight: 600 }}
                      />
                    ) : undefined}
                  />
                  <DateTile
                    label="Due Date"
                    icon={<CalendarClock size={13} strokeWidth={2} />}
                    value={fmtDate(r.due_date)}
                    tone={isOverdue ? 'overdue' : 'neutral'}
                    hint={isOverdue ? 'Overdue — this request is still open' : undefined}
                    emphasis
                    editor={editMode ? (
                      <input
                        type="date"
                        aria-label="Due Date"
                        value={form.due_date}
                        onChange={setField('due_date')}
                        disabled={savingEdit}
                        style={{ ...editInputStyle, fontSize: '13px', fontWeight: 700 }}
                      />
                    ) : undefined}
                  />
                </div>
              </div>
            </div>

            {/* ── Row 2 — the documents, and the request's own fields ── */}
            <div className="boe-record-row boe-record-row--fields">

              {/* The Main PI is the commercial document this request IS, so the
                  files lead the record proper — a reviewer opens the PI before
                  reading anything else. It takes the WIDER column, so a long
                  filename keeps room beside its controls. Read-only until the
                  record is put into Edit, where the same permission that governs
                  the fields also governs replacing and adding files. */}
              <div className="boe-record-col-main">
                <RequestAttachmentsCard
                  rows={attachments}
                  supabase={supabase}
                  loading={attachmentsLoading}
                  error={attachmentsError}
                  // Attachment editing follows the SAME rule as editing the request.
                  // The route and the SECURITY DEFINER RPC each enforce it again
                  // server-side — this only decides whether to offer the controls.
                  editing={!!editMode && canAttachments}
                  edits={attachmentEdits}
                  disabled={savingEdit}
                  onReplaceMainPi={f => void stageFile(f, 'main_pi', { kind: 'main' })}
                  onUndoMainPi={undoStagedMainPi}
                  onAddReferences={files => {
                    for (const f of files) void stageFile(f, 'reference', { kind: 'ref' })
                  }}
                  onReplaceReference={(attachmentId, f) => {
                    const existing = attachments.find(a => a.id === attachmentId)
                    void stageFile(f, 'reference', {
                      kind: 'ref', replacesId: attachmentId, replacesName: existing?.file_name,
                    })
                  }}
                  onRemoveReference={stageRemoveRef}
                  onUndoRemoveReference={undoRemoveRef}
                  onDiscardStagedRef={discardStagedRef}
                />
              </div>

              {/* Request Record — the request's own fields AND its ownership in
                  one card. They were two short field lists that never filled
                  their cards; as one section they read as the record they
                  describe, on a single 2-column label-above-value grid.

                  Client is the record's identity and is edited in the page
                  header. Confirmation Date and Due Date live in Key Dates. In
                  both modes, neither is repeated here. */}
              <div className="boe-record-col-side" style={cardStyle}>
                <div style={cardHeadStyle}><SectionHeader>Request Record</SectionHeader></div>
                <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '13px' }}>
                  <div className="boe-record-fields">
                    {editMode ? (
                      <RecordField label="Lead Source" htmlFor="edit-lead-source" editor={
                        <select
                          id="edit-lead-source"
                          value={form.lead_source}
                          onChange={setField('lead_source')}
                          disabled={savingEdit}
                          style={editInputStyle}
                        >
                          <option value="">— Select —</option>
                          {LEAD_SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      } />
                    ) : (
                      <RecordField label="Lead Source" value={leadSourceLabel} muted={!r.lead_source} />
                    )}

                    {/* Only an admin may set or change the assignee. A non-admin
                        sees the field LOCKED rather than removed, so the current
                        assignee stays visible and the unchanged value is re-sent —
                        mirroring validate_order_request_assignee (20260710), which
                        rejects a non-admin assignee change server-side. */}
                    {editMode ? (
                      <RecordField
                        label="Current Assignee"
                        htmlFor="edit-assignee"
                        hint={isAdmin ? undefined : 'Only an admin can change the assignee.'}
                        editor={
                          <select
                            id="edit-assignee"
                            value={form.assigned_to}
                            onChange={setField('assigned_to')}
                            disabled={savingEdit || !isAdmin}
                            style={isAdmin
                              ? editInputStyle
                              : { ...editInputStyle, background: colors.float, color: colors.secondary, cursor: 'not-allowed' }}
                          >
                            <option value="">— Select —</option>
                            {/* A legacy assignee that no longer qualifies (inactive,
                                or neither Sales nor authorised) stays visible and
                                selected — never silently dropped. */}
                            {legacyAssigneeOutOfList && (
                              <optgroup label="Current Assignee">
                                <option value={r.assigned_to ?? ''}>{r.assigned_to_name ?? 'Unknown user'}</option>
                              </optgroup>
                            )}
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
                        }
                      />
                    ) : (
                      <RecordField label="Current Assignee" value={r.assigned_to_name ?? '—'} muted={!r.assigned_to_name} />
                    )}

                    <RecordField label="Requested By" value={r.requested_by_name ?? '—'} muted={!r.requested_by_name} />
                    {showCreatedBy && (
                      <RecordField label="Created By" value={r.created_by_name ?? '—'} muted={!r.created_by_name} />
                    )}
                    <RecordField label="Submitted On" value={submittedOnLabel} />
                    {/* updated_at is maintained by the order_requests_set_updated_at
                        trigger on every committed change. Shown only when it reads
                        as a DIFFERENT day from submission — otherwise it would be
                        the same date printed twice. Current status is not repeated
                        here either; the badge beside the heading states it. */}
                    {lastUpdatedLabel && <RecordField label="Last Updated" value={lastUpdatedLabel} />}
                  </div>

                  {/* Notes are free text and can run long, so they stay a
                      full-width block under the grid rather than being squeezed
                      into a metadata cell. */}
                  {editMode ? (
                    <div>
                      <label htmlFor="edit-notes" style={FIELD_LABEL}>Notes</label>
                      <textarea
                        id="edit-notes"
                        value={form.notes}
                        onChange={setField('notes')}
                        disabled={savingEdit}
                        style={{ ...editInputStyle, marginTop: '5px', minHeight: '76px', resize: 'vertical' }}
                      />
                    </div>
                  ) : r.notes?.trim() ? (
                    <div>
                      <span style={FIELD_LABEL}>Notes</span>
                      <div style={{ fontSize: '13.5px', color: colors.secondary, lineHeight: 1.55, marginTop: '5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {r.notes}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {/* ── Row 3 — Linked Payments, FULL width of the workspace. It is a
                table with its own columns and totals, so it is the one section
                that must not sit in half a column; its internals, props and
                behaviour are untouched by the layout above. ── */}
            <RequestPaymentsCard
              request={r}
              rows={payments ?? []}
              linkedBy={linkedBy}
              loading={paymentsLoading}
              error={paymentsError}
              isAdmin={isAdmin}
              currentUserId={currentUserId}
              onView={setViewPayment}
              // Editing an approved payment is Finance's workflow, and is
              // admin-only in the database — deep-link to the row there rather
              // than keeping a second edit form in sync with it.
              onEdit={p => router.push(
                p.order_id || p.order_request_id
                  ? `/finance/received?payment=${p.id}&action=edit`
                  : `/finance?request=${p.id}`
              )}
              onUnlink={setUnlinkPayment}
            />

            {/* Order-first payment linking — expands only from an explicit Link
                Payment action, never on plain page load. */}
            {canPayments && linkPanelOpen && (
              <RequestPaymentLinkPanel
                request={r}
                supabase={supabase}
                searchInputRef={searchInputRef}
                // A non-admin's link search is restricted to their own
                // submissions; an admin keeps the full suspense-ledger search.
                ownOnlyUserId={isAdmin ? null : currentUserId}
                onLinked={payment => {
                  setActionMessage(`${fmtAmount(payment.amount)} from ${payment.client_name} linked to ${r.request_number}.`)
                  void reloadAll()
                }}
              />
            )}
          </div>

          {/* RIGHT — activity rail, and only activity. No max-width and no
              sticky positioning: when the rail wraps below the left content it
              must take the full width, and a long history has to stay reachable
              by scrolling the PAGE rather than a pinned panel. */}
          <div style={{ flex: '1 1 340px', minWidth: 0 }}>
            <RequestActivityTimeline
              supabase={supabase}
              orderRequestId={r.id}
              refreshKey={activityKey}
            />
          </div>
        </div>
      </div>

      {/* ── Focused action modals ── */}

      {convertTarget && (
        <ConvertModal
          request={r}
          onClose={() => setConvertTarget(false)}
          onConverted={result => {
            setConvertTarget(false)
            setActionMessage(null)
            setConverted(result)
            void reloadAll()
          }}
        />
      )}

      {clarifyTarget && (
        <ClarifyModal
          request={r}
          onClose={() => setClarifyTarget(false)}
          onRequested={requestNumber => {
            setClarifyTarget(false)
            setConverted(null)
            setActionMessage(`Clarification requested on ${requestNumber}. It now sits under Needs Clarification.`)
            void reloadAll()
          }}
        />
      )}

      {rejectTarget && (
        <RejectModal
          request={r}
          onClose={() => setRejectTarget(false)}
          onRejected={requestNumber => {
            setRejectTarget(false)
            setConverted(null)
            setActionMessage(`${requestNumber} has been rejected.`)
            void reloadAll()
          }}
        />
      )}

      {deleteTarget && (
        <DeleteRequestModal
          request={r}
          onClose={() => setDeleteTarget(false)}
          onDeleted={(requestNumber, unlinkedCount) => {
            setDeleteTarget(false)
            queryClient.invalidateQueries({ queryKey: ['order-requests', 'total-count'] })
            setDeleted({ requestNumber, unlinkedCount })
          }}
        />
      )}

      {viewPayment && (
        <LinkedPaymentDetailsModal
          key={viewPayment.id}
          payment={viewPayment}
          supabase={supabase}
          onClose={() => setViewPayment(null)}
        />
      )}

      {unlinkPayment && (
        <UnlinkPaymentModal
          payment={unlinkPayment}
          request={r}
          supabase={supabase}
          onClose={() => setUnlinkPayment(null)}
          onUnlinked={() => {
            setUnlinkPayment(null)
            setConverted(null)
            setActionMessage(`Payment unlinked from ${r.request_number}. It has returned to suspense.`)
            void reloadAll()
          }}
        />
      )}
    </OrdersLayout>
  )
}
