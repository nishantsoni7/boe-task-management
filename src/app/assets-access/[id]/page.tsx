'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ChevronLeft, MoreHorizontal } from 'lucide-react'
import { AssetsLayout } from '@/components/layout/AssetsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { formatINR } from '@/lib/currency'
import { useAssetsAccess } from '@/hooks/useAssetsAccess'
import {
  ASSET_COLUMNS,
  ASSET_ACTIVITY_COLUMNS,
  ASSET_DOCUMENT_COLUMNS,
  ASSET_SERVICE_COLUMNS,
  ASSET_TRANSFER_COLUMNS,
  EMPLOYEE_ASSET_COLUMNS,
  isOpenAssignment,
} from '@/lib/assets/detail'
import {
  assetActivityActorName,
  assetActivityDetailLines,
  assetActivityEmployeeName,
  assetActivityTitle,
  assetActivityTone,
  sortAssetActivity,
  type AssetActivityEntry,
} from '@/lib/assets/activity'
import {
  ASSET_CONDITION_LABEL,
  ASSET_DOCUMENT_TYPE_LABEL,
  ASSET_SERVICE_TYPE_LABEL,
  assetConditionLabel,
  assetStatusLabel,
  humanizeToken,
  type Asset,
  type AssetDocument,
  type AssetEmployee,
  type AssetServiceRecord,
  type AssetTransfer,
  type EmployeeAsset,
} from '@/lib/assets/types'
import { describeCustody, describeTransferSide } from '@/lib/assets/transfers'
import { summarizeService, parseCost } from '@/lib/assets/service'
import {
  warrantyStatus, warrantyDetailLine, WARRANTY_STATUS_LABEL,
} from '@/lib/assets/warranty'
import {
  activeDocuments, formatFileSize,
  ASSET_DOCUMENT_BUCKET, ASSET_DOCUMENT_SIGNED_URL_SECONDS,
} from '@/lib/assets/documents'
import {
  ASSET_ACTION_LABEL,
  assetActionLayout,
  assetDetailTabCounts,
  assetSummaryDate,
  hasOverflowActions,
  hasWarrantyDetails,
  optionalText,
  type AssetActionAvailability,
  type AssetActionKey,
  type AssetActionLayout,
} from '@/lib/assets/detailView'
import { assetErrorMessage, logAssetFailure } from '@/lib/assets/errors'
import {
  AddServiceRecordModal, AssignAssetModal, CompleteServiceModal, DeleteAssetModal, MarkLostModal,
  RecoverAssetModal, RemoveDocumentModal, RestoreAssetModal, RetireAssetModal,
  ReturnAssetModal, SendForRepairModal, TransferAssetModal, UploadDocumentModal,
  WarrantyDetailsModal,
} from './AssetActionModals'
import {
  EditAssetModal, RequestEditModal, RequestRemovalModal,
} from '@/components/assets/AssetChangeModals'
import { assetDeleteBlockReason } from '@/lib/assets/lifecycle'
import type { AssetDocumentType } from '@/lib/assets/types'

// The single source of truth for one asset: what it is, who holds it, and
// everything that has ever happened to it.
//
// The page is a RECORD, read top-down in one pass: identity and state in the
// summary card, then the five histories behind tabs. Every number on it is
// derived from records the database actually holds (movement rows, service
// rows, documents, audit rows); nothing is inferred by diffing the current row
// against anything, and nothing is stored twice.
//
// ACTION HIERARCHY. An asset has eighteen possible operations across its life
// and a flat row of eighteen buttons gives none of them meaning. So the surface
// carries only the CUSTODY MOVES that are legal right now — the ones that
// answer "what happens to this asset next" — and everything else lives in More
// Actions, with the irreversible operations below a divider at the bottom. The
// split itself is a pure function (lib/assets/detailView.ts) whose test proves
// no action can silently fall out of every group.
//
// Nothing here decides authorization. `can` below is permission AND state, both
// required, exactly as before; the layout helper is handed the result and only
// arranges it.
//
// Activity history is READ-ONLY on this page because it is read-only in the
// database: asset_activity_log has no INSERT, UPDATE or DELETE policy for
// anyone, including an admin (20260727000000 §2–3). There is no edit control to
// hide.

type TabKey = 'overview' | 'assignments' | 'service' | 'warranty' | 'activity'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview',    label: 'Overview' },
  { key: 'assignments', label: 'Assignment History' },
  { key: 'service',     label: 'Repair & Service' },
  { key: 'warranty',    label: 'Warranty & Documents' },
  { key: 'activity',    label: 'Activity History' },
]

const STATUS_BADGE: Record<string, string> = {
  available:    'boe-badge-completed',
  assigned:     'boe-badge-pending',
  under_repair: 'boe-badge-pending',
  returned:     'boe-badge-pending',
  lost:         'boe-badge-urgent',
  retired:      'boe-badge-pending',
  disposed:     'boe-badge-urgent',
}

const ACCEPTANCE_META: Record<string, { label: string; cls: string }> = {
  pending_acceptance: { label: 'Pending Acceptance', cls: 'boe-badge-pending'   },
  accepted:           { label: 'Accepted',           cls: 'boe-badge-completed' },
  returned:           { label: 'Returned',           cls: 'boe-badge-pending'   },
  lost:               { label: 'Lost',               cls: 'boe-badge-urgent'    },
}

const WARRANTY_BADGE: Record<string, string> = {
  active:        'boe-badge-completed',
  expiring_soon: 'boe-badge-pending',
  expired:       'boe-badge-urgent',
  not_available: 'boe-badge-pending',
}

const TRANSFER_EVENT_LABEL: Record<string, string> = {
  assigned:             'Assigned',
  transferred:          'Transferred',
  returned:             'Returned',
  marked_lost:          'Marked lost',
  recovered:            'Recovered',
  sent_for_repair:      'Sent for service',
  returned_from_repair: 'Back from service',
  retired:              'Retired',
  disposed:             'Disposed',
  correction:           'Correction',
}

const TONE_COLOR: Record<string, string> = {
  neutral:  colors.muted,
  positive: '#15803D',
  warning:  '#B45309',
  critical: '#C13030',
}

/** BOE red, the module's one accent. Used for primary, active and destructive. */
const BOE_RED = '#DC1F2E'
const DANGER_TEXT = '#B42318'

/**
 * Above the sidebar (z-100, globals.css) so the menu panel is never clipped by
 * it, and below the modal shell (z-200/201, AssetModal.tsx) so an open dialog
 * still covers everything including this.
 */
const MENU_Z = 150

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return '—' }
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return '—' }
}

function fmtMoney(value: number | string | null | undefined): string {
  const n = parseCost(value ?? null)
  return n === null ? '—' : formatINR(n)
}

function Panel({ message }: { message: string }) {
  return (
    <div className="boe-card" style={{ padding: '32px', textAlign: 'center' }}>
      <div style={{ fontSize: '12px', color: colors.muted }}>{message}</div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '11.5px', fontWeight: 700, color: colors.muted,
      textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      {children}
    </div>
  )
}

/**
 * One white card with a titled header strip. The header carries an optional
 * control on the right, which is how a section states its own empty-state
 * action without a second row of buttons at the top of the page.
 */
function Card({
  title, action, children, bodyStyle,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
  bodyStyle?: React.CSSProperties
}) {
  return (
    <section className="boe-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '10px', padding: '11px 16px', borderBottom: `1px solid ${colors.border}`,
        background: colors.raised,
      }}>
        <SectionTitle>{title}</SectionTitle>
        {action}
      </div>
      <div style={{ padding: '14px 16px', ...bodyStyle }}>{children}</div>
    </section>
  )
}

/**
 * Label above value.
 *
 * A null/blank value renders as a muted dash rather than the words "Not
 * recorded": on a record where half the optional columns are legitimately empty,
 * the sentence repeated fifteen times is the loudest thing on the page.
 */
function DetailField({
  label, value, mono,
}: { label: string; value: string | null | undefined; mono?: boolean }) {
  const shown = optionalText(value)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <div style={{
        fontSize: '10.5px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: '13px', color: shown ? colors.primary : colors.muted,
        fontFamily: mono && shown ? 'monospace' : undefined,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {shown ?? '—'}
      </div>
    </div>
  )
}

/** Label left, value right — the shape the narrow side column reads best in. */
function SideFact({
  label, value, mono, strong,
}: { label: string; value: string | null | undefined; mono?: boolean; strong?: boolean }) {
  const shown = optionalText(value)
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      gap: '12px', fontSize: '12px',
    }}>
      <span style={{ color: colors.muted, flexShrink: 0 }}>{label}</span>
      <span style={{
        color: shown ? colors.primary : colors.muted,
        fontWeight: strong ? 700 : 500,
        fontFamily: mono && shown ? 'monospace' : undefined,
        textAlign: 'right', wordBreak: 'break-word', minWidth: 0,
      }}>
        {shown ?? '—'}
      </span>
    </div>
  )
}

/**
 * What a section says when it holds nothing.
 *
 * The ACTION is offered only when the caller passes one — i.e. only when the
 * viewer holds the permission to add the thing. Telling someone to upload an
 * invoice they may not upload is worse than saying nothing.
 */
function EmptyState({
  message, actionLabel, onAction,
}: { message: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
      <div style={{ fontSize: '12px', color: colors.muted }}>{message}</div>
      {actionLabel && onAction && (
        <button type="button" className="boe-record-action" style={{ minHeight: '30px', padding: '6px 12px', fontSize: '12px' }} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="boe-card" style={{ padding: '14px 16px', minWidth: 0 }}>
      <div style={{
        fontSize: '10.5px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px',
      }}>
        {label}
      </div>
      <div style={{ fontSize: '16px', fontWeight: 700, color: colors.primary }}>{value}</div>
      {hint && <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>{hint}</div>}
    </div>
  )
}

function Banner({ kind, message }: { kind: 'error' | 'success'; message: string }) {
  const isError = kind === 'error'
  return (
    <div role={isError ? 'alert' : 'status'} style={{
      padding: '10px 12px', borderRadius: '8px',
      background: isError ? 'rgba(217,79,79,0.1)' : 'rgba(22,163,74,0.10)',
      color: isError ? '#C13030' : '#15803D',
      fontSize: '12px',
    }}>
      {message}
    </div>
  )
}

// ─── More Actions ─────────────────────────────────────────────────────────────

/**
 * The overflow menu for everything that is not a custody move.
 *
 * Keyboard behaviour is the WAI-ARIA menu-button pattern: the trigger opens on
 * click or Enter/Space, focus lands on the first item, Up/Down/Home/End move
 * between items, Escape closes and returns focus to the trigger, and Tab or a
 * click anywhere outside closes it. Renders nothing at all when the viewer has
 * no overflow action — an empty trigger would be a control that does nothing.
 */
function MoreActionsMenu({
  layout, onSelect,
}: {
  layout: AssetActionLayout
  onSelect: (key: AssetActionKey) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef    = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs   = useRef<(HTMLButtonElement | null)[]>([])

  const items: { key: AssetActionKey; danger: boolean }[] = [
    ...layout.more.map(key => ({ key, danger: false })),
    ...layout.danger.map(key => ({ key, danger: true })),
  ]
  const dividerAt = layout.more.length

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  // Outside click and Escape. Both are registered only while the menu is open,
  // so a closed menu costs nothing and cannot swallow an Escape meant for a
  // modal underneath it.
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
    if (open) itemRefs.current[0]?.focus()
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
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: MENU_Z,
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: '9px', boxShadow: '0 8px 24px rgba(16,24,40,0.14)',
            minWidth: '218px', padding: '4px 0', overflow: 'hidden',
          }}
        >
          {items.map((item, index) => (
            <div key={item.key}>
              {/* The divider is what separates record-keeping from the
                  operations that end an asset's life. Decorative, so it is
                  hidden from assistive technology rather than announced. */}
              {index === dividerAt && dividerAt > 0 && (
                <div aria-hidden="true" style={{ height: '1px', background: colors.border, margin: '4px 0' }} />
              )}
              <button
                ref={el => { itemRefs.current[index] = el }}
                type="button"
                role="menuitem"
                // Focus the TRIGGER before dispatching. The menu item is about
                // to unmount, and AssetModal records document.activeElement on
                // mount so it can restore focus on close — with the item gone
                // that record would be <body>, and closing the dialog would
                // drop a keyboard user at the top of the page.
                onClick={() => { triggerRef.current?.focus(); setOpen(false); onSelect(item.key) }}
                onKeyDown={e => onMenuKeyDown(e, index)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '9px 14px', background: 'none', border: 'none',
                  font: 'inherit', fontSize: '13px', cursor: 'pointer',
                  color: item.danger ? DANGER_TEXT : colors.secondary,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = item.danger ? '#FEF3F2' : colors.raised }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              >
                {ASSET_ACTION_LABEL[item.key]}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type ModalKind =
  | { kind: 'assign' } | { kind: 'transfer' } | { kind: 'return' } | { kind: 'lost' }
  | { kind: 'recover' } | { kind: 'send-repair' } | { kind: 'add-service' }
  | { kind: 'complete-service'; record: AssetServiceRecord }
  | { kind: 'warranty' }
  | { kind: 'upload'; docType: AssetDocumentType }
  | { kind: 'remove-document'; id: string; fileName: string }
  | { kind: 'retire'; dispose: boolean } | { kind: 'restore' }
  | { kind: 'edit' } | { kind: 'request-edit' } | { kind: 'request-removal' }
  | { kind: 'delete' }

export default function AssetDetailPage() {
  const params = useParams<{ id: string }>()
  const assetId = typeof params?.id === 'string' ? params.id : ''
  const router = useRouter()
  const { supabase, profile, caps, loading: authLoading, signOut } = useAssetsAccess()

  const [asset, setAsset] = useState<Asset | null>(null)
  const [assignments, setAssignments] = useState<EmployeeAsset[]>([])
  const [transfers, setTransfers] = useState<AssetTransfer[]>([])
  const [services, setServices] = useState<AssetServiceRecord[]>([])
  const [documents, setDocuments] = useState<AssetDocument[]>([])
  const [activity, setActivity] = useState<AssetActivityEntry[]>([])
  const [employees, setEmployees] = useState<AssetEmployee[]>([])
  const [names, setNames] = useState<Record<string, string | undefined>>({})

  const [tab, setTab] = useState<TabKey>('overview')
  const [modal, setModal] = useState<ModalKind | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isMobile, setIsMobile] = useState(false)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Names for every user id the page shows — custodian, assigner, movement
  // actors, timeline actors — in one query, with NO is_active filter: a
  // deactivated employee's past custody must still read by name.
  const loadNames = useCallback(async (ids: (string | null | undefined)[]) => {
    const unique = Array.from(new Set(ids.filter((v): v is string => !!v)))
    if (unique.length === 0) return
    const { data } = await supabase.from('users').select('id, full_name').in('id', unique)
    const map: Record<string, string | undefined> = {}
    ;((data ?? []) as { id: string; full_name: string }[]).forEach(u => { map[u.id] = u.full_name })
    setNames(prev => ({ ...prev, ...map }))
  }, [supabase])

  const load = useCallback(async () => {
    if (!assetId) return
    setLoading(true)
    setError(null)

    // Every read is additionally gated by RLS (assets_select,
    // employee_assets_manage_select, asset_transfers_select,
    // asset_service_records_select, asset_documents_select,
    // asset_activity_log_select), so a direct URL from someone without access
    // returns nothing regardless of what the client believes about itself.
    const [
      { data: a, error: aErr },
      { data: ea },
      { data: tr },
      { data: sv },
      { data: doc },
      { data: log, error: logErr },
      { data: emp },
    ] = await Promise.all([
      supabase.from('assets').select(ASSET_COLUMNS).eq('id', assetId).maybeSingle(),
      supabase.from('employee_assets').select(EMPLOYEE_ASSET_COLUMNS).eq('asset_id', assetId).order('assigned_at', { ascending: false }),
      supabase.from('asset_transfers').select(ASSET_TRANSFER_COLUMNS).eq('asset_id', assetId)
        .order('transfer_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('asset_service_records').select(ASSET_SERVICE_COLUMNS).eq('asset_id', assetId)
        .order('created_at', { ascending: false }),
      supabase.from('asset_documents').select(ASSET_DOCUMENT_COLUMNS).eq('asset_id', assetId)
        .order('created_at', { ascending: false }),
      supabase.from('asset_activity_log').select(ASSET_ACTIVITY_COLUMNS).eq('asset_id', assetId)
        .order('event_at', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('users').select('id, full_name, role, team').eq('is_active', true).order('full_name'),
    ])

    if (aErr) setError(assetErrorMessage('edit', aErr))
    else if (logErr) setError(assetErrorMessage('edit', logErr))

    const assetRow      = (a ?? null) as unknown as Asset | null
    const assignmentRows = (ea ?? []) as unknown as EmployeeAsset[]
    const transferRows   = (tr ?? []) as unknown as AssetTransfer[]
    const serviceRows    = (sv ?? []) as unknown as AssetServiceRecord[]
    const documentRows   = (doc ?? []) as unknown as AssetDocument[]
    const logRows        = (log ?? []) as unknown as AssetActivityEntry[]

    setAsset(assetRow)
    setAssignments(assignmentRows)
    setTransfers(transferRows)
    setServices(serviceRows)
    setDocuments(documentRows)
    setActivity(logRows)
    setEmployees((emp ?? []) as unknown as AssetEmployee[])
    setLoading(false)

    await loadNames([
      ...assignmentRows.flatMap(r => [r.employee_id, r.assigned_by]),
      ...transferRows.flatMap(r => [r.from_employee_id, r.to_employee_id, r.performed_by]),
      ...serviceRows.map(r => r.recorded_by),
      ...documentRows.flatMap(r => [r.uploaded_by, r.removed_by]),
      ...logRows.flatMap(r => [r.actor_id, r.employee_id]),
    ])
  }, [assetId, supabase, loadNames])

  // Wrapped rather than called directly, matching the idiom the rest of this
  // module uses: `load` is an async fetch that settles into state, not a
  // synchronous setState in the effect body.
  useEffect(() => {
    const fetchAsset = () => { void load() }
    fetchAsset()
  }, [load])

  const employeeName = useCallback((id: string) => names[id] ?? null, [names])

  const openAssignment = useMemo(
    () => assignments.find(r => isOpenAssignment(r.status)) ?? null,
    [assignments],
  )

  // Is this an asset the signed-in person holds or has held?
  //
  // Someone with no management grant may open the record of THEIR OWN
  // equipment and nothing else. The check reads the assignment rows that came
  // back, which for such a person RLS has already narrowed to their own
  // (employee_assets_own_select) — so an asset id typed into the URL that is
  // not theirs yields an empty list and no access. This is a rendering
  // decision on top of a database boundary, never in place of one.
  const holdsThisAsset = useMemo(
    () => !!profile && assignments.some(r => r.employee_id === profile.id),
    [assignments, profile],
  )

  const custody = useMemo(
    () => (asset ? describeCustody(asset, openAssignment, employeeName) : null),
    [asset, openAssignment, employeeName],
  )

  const orderedActivity = useMemo(() => sortAssetActivity(activity), [activity])
  const serviceSummary  = useMemo(() => summarizeService(services), [services])
  const openService     = useMemo(() => services.find(s => s.status === 'in_progress') ?? null, [services])
  const liveDocuments   = useMemo(() => activeDocuments(documents), [documents])
  const warranty        = asset ? warrantyStatus(asset.warranty_expiry_date) : 'not_available'

  // Counts come from the lists already in state — no second round trip, and no
  // badge that can disagree with the tab it sits on.
  const counts = useMemo(
    () => assetDetailTabCounts({
      transfers, assignments, services, activeDocuments: liveDocuments, activity,
    }),
    [transfers, assignments, services, liveDocuments, activity],
  )

  const afterAction = (message: string) => {
    setModal(null)
    setNotice(message)
    setError(null)
    load()
  }

  // A document is only ever reached through a short-lived signed URL. The
  // bucket is private, and a stored public URL would outlive the permission
  // that justified it.
  const openDocument = async (doc: AssetDocument) => {
    setError(null)
    const { data, error: signError } = await supabase.storage
      .from(ASSET_DOCUMENT_BUCKET)
      .createSignedUrl(doc.storage_path, ASSET_DOCUMENT_SIGNED_URL_SECONDS)
    if (signError || !data?.signedUrl) {
      logAssetFailure('upload-document', signError ?? { message: 'No signed URL returned' })
      setError('That document could not be opened. It may have been removed from storage.')
      return
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  if (authLoading || loading || !profile) return <LoadingScreen />

  // Back to the list this record was reached from. An employee has no
  // inventory to return to, so their crumb points at their own assets —
  // sending them to ?view=asset-inventory would only bounce off
  // resolveInitialView and land there anyway, one redirect later.
  const listView = caps.canViewAssetInventory ? 'asset-inventory' : 'my-assets'
  const listLabel = caps.canViewAssetInventory ? 'Asset Inventory' : 'My Assets'
  const backToInventory = () => router.push(`/assets-access?view=${listView}`)

  // ── Which actions this person may take on this asset, right now ────────────
  // Permission AND state, both required — a button must never appear for
  // something the database will refuse. UNCHANGED from before the redesign;
  // only where the resulting control is rendered has moved.
  const status = asset?.status ?? ''
  const can = {
    assign:       caps.canAssignAsset && status === 'available',
    transfer:     caps.canManageAssetCustody && (status === 'assigned' || status === 'available'),
    markReturned: caps.canManageAssetCustody && !!openAssignment && status !== 'lost',
    markLost:     caps.canManageAssetCustody && !['lost', 'retired', 'disposed'].includes(status),
    recover:      caps.canManageAssetCustody && status === 'lost',
    sendRepair:   caps.canManageAssetCustody && ['available', 'assigned'].includes(status),
    closeService: caps.canManageAssetCustody && !!openService,
    addService:   caps.canEditAsset || caps.canManageAssetCustody,
    warranty:     caps.canEditAsset || caps.canManageAssetCustody,
    documents:    caps.canEditAsset || caps.canManageAssetCustody,
    retire:       caps.canManageAssetCustody && !['retired', 'disposed'].includes(status) && !openAssignment,
    restore:      caps.canManageAssetCustody && ['retired', 'disposed'].includes(status),
    edit:         caps.canEditAsset,
    // Permanent deletion is admin-only (20260803000000), so the menu item is
    // not offered to a non-admin who happens to hold assets_access.delete.
    remove:       caps.canDeleteAsset && profile.role === 'admin',
    request:      caps.canRequestAssetChanges,
  }

  // Permanent deletion is an administrator's decision and erases the asset
  // together with its assignment, custody, service, warranty and activity
  // history — permanently_delete_asset (20260803000000) does all of it in one
  // transaction. History no longer blocks; an OPEN assignment still does,
  // because somebody is holding the asset right now.
  //
  // This guard exists to say why in plain words rather than surfacing a
  // definer-function error. The RPC re-checks the same rule server-side, which
  // is what actually holds.
  const openDelete = () => {
    if (!asset) return
    setError(null)
    setNotice(null)

    const blocked = assetDeleteBlockReason({
      canDeleteAsset: caps.canDeleteAsset,
      isAdmin: profile.role === 'admin',
      hasActiveAssignment: !!openAssignment,
    })
    if (blocked) { setError(blocked); return }

    setModal({ kind: 'delete' })
  }

  // The action key → what it opens. Every entry is the same modal, the same
  // props and the same confirmation the flat button row used to trigger.
  const runAction = (key: AssetActionKey) => {
    switch (key) {
      case 'assign':             setModal({ kind: 'assign' }); break
      case 'transfer':           setModal({ kind: 'transfer' }); break
      case 'markReturned':       setModal({ kind: 'return' }); break
      case 'closeService':       if (openService) setModal({ kind: 'complete-service', record: openService }); break
      case 'recover':            setModal({ kind: 'recover' }); break
      case 'restore':            setModal({ kind: 'restore' }); break
      case 'sendRepair':         setModal({ kind: 'send-repair' }); break
      case 'addService':         setModal({ kind: 'add-service' }); break
      case 'warranty':           setModal({ kind: 'warranty' }); break
      case 'uploadInvoice':      setModal({ kind: 'upload', docType: 'invoice' }); break
      case 'uploadWarrantyCard': setModal({ kind: 'upload', docType: 'warranty_card' }); break
      case 'edit':               setModal({ kind: 'edit' }); break
      case 'requestEdit':        setModal({ kind: 'request-edit' }); break
      case 'requestRemoval':     setModal({ kind: 'request-removal' }); break
      case 'markLost':           setModal({ kind: 'lost' }); break
      case 'retire':             setModal({ kind: 'retire', dispose: false }); break
      case 'dispose':            setModal({ kind: 'retire', dispose: true }); break
      case 'delete':             openDelete(); break
    }
  }

  const availability: AssetActionAvailability = {
    assign:             can.assign,
    transfer:           can.transfer,
    markReturned:       can.markReturned,
    closeService:       can.closeService,
    recover:            can.recover,
    restore:            can.restore,
    sendRepair:         can.sendRepair,
    addService:         can.addService,
    warranty:           can.warranty,
    uploadInvoice:      can.documents,
    uploadWarrantyCard: can.documents,
    edit:               can.edit,
    requestEdit:        can.request,
    requestRemoval:     can.request,
    markLost:           can.markLost,
    retire:             can.retire,
    dispose:            can.retire,
    delete:             can.remove,
  }
  const actions = assetActionLayout(availability)

  // Roving focus across the tab strip — Left/Right move and select, Home/End
  // jump to the ends, exactly as a tablist is expected to behave.
  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    const move = (next: number) => {
      e.preventDefault()
      const bounded = (next + TABS.length) % TABS.length
      setTab(TABS[bounded].key)
      tabRefs.current[bounded]?.focus()
    }
    if (e.key === 'ArrowRight')     move(index + 1)
    else if (e.key === 'ArrowLeft') move(index - 1)
    else if (e.key === 'Home')      move(0)
    else if (e.key === 'End')       move(TABS.length - 1)
  }

  const tabCount = (key: TabKey): number | null => {
    switch (key) {
      case 'assignments': return counts.assignments
      case 'service':     return counts.service
      case 'warranty':    return counts.documents
      case 'activity':    return counts.activity
      default:            return null
    }
  }

  const body = () => {
    // Inventory managers see any asset; everyone else sees only what they
    // hold or have held. Both branches are backed by assets_select, which
    // returns nothing outside them however this page is reached.
    if (!caps.canViewAssetInventory && !holdsThisAsset) {
      return <Panel message="This asset does not exist, or you do not have access to it." />
    }
    if (error && !asset) return <Panel message={error} />
    if (!asset || !custody) {
      return <Panel message="This asset does not exist, or you do not have access to it." />
    }

    const summaryDate = assetSummaryDate(asset, openAssignment)

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {error && <Banner kind="error" message={error} />}
        {notice && <Banner kind="success" message={notice} />}

        {/* ── Asset summary ──
            Identity, state and the state-relevant moves, in one card. This is
            the only place the asset's name and code appear at full size; the
            layout header above it deliberately carries neither. */}
        <section className="boe-card" style={{ padding: isMobile ? '16px' : '18px 22px' }}>
          <div style={{
            display: 'flex', gap: '16px', flexWrap: 'wrap',
            alignItems: 'flex-start', justifyContent: 'space-between',
          }}>
            <div style={{ minWidth: 0, flex: '1 1 300px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '5px' }}>
                <span style={{ fontFamily: 'monospace', fontSize: '12px', color: colors.muted, letterSpacing: '0.02em' }}>
                  {asset.asset_code}
                </span>
                <span className={`boe-badge ${STATUS_BADGE[asset.status] ?? 'boe-badge-pending'}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                  {assetStatusLabel(asset.status)}
                </span>
                <span className={`boe-badge ${WARRANTY_BADGE[warranty]}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                  Warranty: {WARRANTY_STATUS_LABEL[warranty]}
                </span>
              </div>
              <h1 style={{
                fontSize: isMobile ? '18px' : '21px', fontWeight: 700,
                color: colors.primary, margin: 0, lineHeight: 1.2, wordBreak: 'break-word',
              }}>
                {asset.asset_name}
              </h1>
            </div>

            {/* Primary custody moves, then everything else behind one trigger.
                The FIRST primary is the dominant action for this state; the
                rest sit beside it as quiet buttons. */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              {actions.primary.map((key, index) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => runAction(key)}
                  className={index === 0 ? 'boe-record-action boe-record-action--primary' : 'boe-record-action'}
                >
                  {ASSET_ACTION_LABEL[key]}
                </button>
              ))}
              {hasOverflowActions(actions) && <MoreActionsMenu layout={actions} onSelect={runAction} />}
            </div>
          </div>

          {/* The eight facts a reader is here for.
              A FIXED four-column grid, not auto-fit: eight divides evenly by
              four, so the strip is always two full rows. auto-fit chose five,
              six or seven columns depending on the width and left the last row
              holding a single orphaned fact beside four empty cells. */}
          <div style={{
            marginTop: '16px', paddingTop: '14px', borderTop: `1px solid ${colors.border}`,
            display: 'grid', gap: '14px 20px',
            gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
          }}>
            <DetailField label="Category"   value={humanizeToken(asset.asset_type)} />
            <DetailField label="Serial No." value={asset.serial_no} mono />
            <DetailField label="Custodian"  value={custody.label} />
            <DetailField label="Department" value={asset.department} />
            <DetailField label="Condition"  value={asset.condition ? assetConditionLabel(asset.condition) : null} />
            <DetailField label="Warranty"   value={WARRANTY_STATUS_LABEL[warranty]} />
            <DetailField label={summaryDate.label} value={fmtDate(summaryDate.iso)} />
            <DetailField label="Last Updated" value={fmtDate(asset.updated_at)} />
          </div>
        </section>

        {/* ── Tabs ──
            Counts come from loaded rows only. The strip scrolls horizontally
            rather than wrapping, so the page itself never scrolls sideways on a
            phone. */}
        <div
          role="tablist"
          aria-label="Asset record sections"
          style={{
            display: 'flex', gap: '6px', flexWrap: 'nowrap',
            overflowX: 'auto', overflowY: 'hidden',
            borderBottom: `1px solid ${colors.border}`, paddingBottom: '8px',
            scrollbarWidth: 'thin',
          }}
        >
          {TABS.map((t, index) => {
            const active = tab === t.key
            const count = tabCount(t.key)
            return (
              <button
                key={t.key}
                ref={el => { tabRefs.current[index] = el }}
                role="tab"
                id={`asset-tab-${t.key}`}
                aria-selected={active}
                aria-controls={`asset-panel-${t.key}`}
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(t.key)}
                onKeyDown={e => onTabKeyDown(e, index)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '7px',
                  padding: '6px 14px', borderRadius: '20px',
                  fontSize: '12px', fontWeight: 600,
                  border: `1.5px solid ${active ? BOE_RED : colors.border}`,
                  background: active ? BOE_RED : colors.base,
                  color: active ? '#fff' : colors.secondary,
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                {t.label}
                {count !== null && (
                  <span style={{
                    fontFamily: 'monospace', fontSize: '10.5px', lineHeight: 1,
                    padding: '3px 6px', borderRadius: '10px',
                    background: active ? 'rgba(255,255,255,0.22)' : colors.float,
                    color: active ? '#fff' : colors.tertiary,
                  }}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div
          role="tabpanel"
          id={`asset-panel-${tab}`}
          aria-labelledby={`asset-tab-${tab}`}
          /* Focusable so Tab out of the strip lands in the panel it selected.
             The focus ring is deliberately NOT suppressed. */
          tabIndex={0}
        >
          {tab === 'overview' && (
            <OverviewTab
              asset={asset}
              custody={custody}
              openAssignment={openAssignment}
              names={names}
              serviceSummary={serviceSummary}
              documents={liveDocuments}
              activity={orderedActivity}
              can={{ warranty: can.warranty, documents: can.documents, addService: can.addService }}
              onAction={runAction}
              onOpenDocument={openDocument}
              onShowTab={setTab}
            />
          )}
          {tab === 'assignments' && <AssignmentsTab transfers={transfers} assignments={assignments} employeeName={employeeName} isMobile={isMobile} />}
          {tab === 'service'     && <ServiceTab services={services} summary={serviceSummary} names={names} isMobile={isMobile} />}
          {tab === 'warranty'    && (
            <WarrantyTab
              asset={asset}
              documents={liveDocuments}
              names={names}
              canManage={can.documents}
              canEditWarranty={can.warranty}
              onOpenDocument={openDocument}
              onRemoveDocument={(d) => setModal({ kind: 'remove-document', id: d.id, fileName: d.file_name })}
              onUploadOther={() => setModal({ kind: 'upload', docType: 'other' })}
              onUploadInvoice={() => setModal({ kind: 'upload', docType: 'invoice' })}
              onAddWarranty={() => setModal({ kind: 'warranty' })}
              isMobile={isMobile}
            />
          )}
          {tab === 'activity'    && <ActivityTab rows={orderedActivity} names={names} isMobile={isMobile} />}
        </div>
      </div>
    )
  }

  const currentEmployeeId   = custody?.employeeId ?? null
  const currentEmployeeName = currentEmployeeId ? employeeName(currentEmployeeId) : null

  return (
    <AssetsLayout
      profile={profile}
      activeView={listView}
      title="Asset Record"
      onSignOut={signOut}
      canViewInventory={caps.canViewAssetInventory}
      canManageAccess={caps.canManageAccess}
      canSeeAssetRequests={caps.canReviewAssetRequests || caps.canRequestAssetChanges}
      canReviewAssetRequests={caps.canReviewAssetRequests}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* Breadcrumb, not a banner. One line back to the list, with the code
            of the record you are on — the asset's name and status live in the
            summary card below and are not repeated here. */}
        <nav aria-label="Breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <button
            onClick={backToInventory}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '3px',
              background: 'none', border: 'none', padding: '2px 4px 2px 0',
              font: 'inherit', fontSize: '12px', fontWeight: 600,
              color: colors.tertiary, cursor: 'pointer', borderRadius: '5px',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = colors.primary }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.tertiary }}
          >
            <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />
            {listLabel}
          </button>
          {asset && (
            <>
              <span aria-hidden="true" style={{ color: colors.muted, fontSize: '12px' }}>/</span>
              <span style={{
                fontFamily: 'monospace', fontSize: '12px', color: colors.muted,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {asset.asset_code}
              </span>
            </>
          )}
        </nav>
        {body()}
      </div>

      {asset && modal?.kind === 'assign' && (
        <AssignAssetModal asset={asset} supabase={supabase} employees={employees} onClose={() => setModal(null)} onDone={afterAction} />
      )}
      {asset && modal?.kind === 'transfer' && (
        <TransferAssetModal
          asset={asset} supabase={supabase} employees={employees}
          currentEmployeeId={currentEmployeeId} currentEmployeeName={currentEmployeeName}
          onClose={() => setModal(null)} onDone={afterAction}
        />
      )}
      {asset && modal?.kind === 'return' && (
        <ReturnAssetModal
          asset={asset} supabase={supabase}
          currentEmployeeId={currentEmployeeId} currentEmployeeName={currentEmployeeName}
          onClose={() => setModal(null)} onDone={afterAction}
        />
      )}
      {asset && modal?.kind === 'lost' && (
        <MarkLostModal
          asset={asset} supabase={supabase}
          currentEmployeeId={currentEmployeeId} currentEmployeeName={currentEmployeeName}
          onClose={() => setModal(null)} onDone={afterAction}
        />
      )}
      {asset && modal?.kind === 'recover' && (
        <RecoverAssetModal asset={asset} supabase={supabase} employees={employees} onClose={() => setModal(null)} onDone={afterAction} />
      )}
      {asset && modal?.kind === 'send-repair' && (
        <SendForRepairModal asset={asset} supabase={supabase} currentEmployeeId={currentEmployeeId} onClose={() => setModal(null)} onDone={afterAction} />
      )}
      {asset && modal?.kind === 'complete-service' && (
        <CompleteServiceModal
          asset={asset} supabase={supabase} record={modal.record}
          currentEmployeeId={currentEmployeeId}
          onClose={() => setModal(null)} onDone={afterAction}
        />
      )}
      {asset && modal?.kind === 'add-service' && (
        <AddServiceRecordModal
          asset={asset} supabase={supabase} currentEmployeeId={currentEmployeeId}
          onClose={() => setModal(null)} onDone={afterAction}
        />
      )}
      {asset && modal?.kind === 'warranty' && (
        <WarrantyDetailsModal
          asset={asset} supabase={supabase} currentEmployeeId={currentEmployeeId}
          onClose={() => setModal(null)} onDone={afterAction}
        />
      )}
      {asset && modal?.kind === 'upload' && (
        <UploadDocumentModal
          asset={asset} supabase={supabase} docType={modal.docType} currentEmployeeId={currentEmployeeId}
          onClose={() => setModal(null)} onDone={afterAction}
        />
      )}
      {modal?.kind === 'remove-document' && (
        <RemoveDocumentModal
          supabase={supabase} documentId={modal.id} fileName={modal.fileName}
          onClose={() => setModal(null)} onDone={afterAction}
        />
      )}
      {asset && modal?.kind === 'retire' && (
        <RetireAssetModal asset={asset} supabase={supabase} dispose={modal.dispose} onClose={() => setModal(null)} onDone={afterAction} />
      )}
      {asset && modal?.kind === 'restore' && (
        <RestoreAssetModal asset={asset} supabase={supabase} onClose={() => setModal(null)} onDone={afterAction} />
      )}
      {asset && modal?.kind === 'edit' && (
        <EditAssetModal
          asset={asset} supabase={supabase} currentEmployeeId={currentEmployeeId}
          onClose={() => setModal(null)}
          onSaved={() => afterAction('Asset details updated.')}
        />
      )}
      {asset && modal?.kind === 'request-edit' && (
        <RequestEditModal
          asset={asset} supabase={supabase}
          onClose={() => setModal(null)}
          onSubmitted={() => afterAction('Your edit request has been submitted for approval.')}
        />
      )}
      {asset && modal?.kind === 'request-removal' && (
        <RequestRemovalModal
          asset={asset} supabase={supabase}
          onClose={() => setModal(null)}
          onSubmitted={() => afterAction('Your removal request has been submitted for approval.')}
        />
      )}
      {/* Not afterAction: there is no longer a record to reload, so the only
          sensible next screen is the inventory this asset has left. */}
      {asset && modal?.kind === 'delete' && (
        <DeleteAssetModal
          asset={asset} supabase={supabase}
          onClose={() => setModal(null)}
          onDone={() => backToInventory()}
        />
      )}
    </AssetsLayout>
  )
}

// ─── Overview ─────────────────────────────────────────────────────────────────

/**
 * Two columns: the record on the left, its standing summaries on the right.
 *
 * The split is flex-wrap on a shared basis rather than a media query, because
 * the column that matters is the CONTENT width — which changes when the sidebar
 * is present and when it is not — and a viewport query cannot see that. Below
 * roughly 720px of content the two columns become one stack in source order,
 * which is also the order a reader wants on a phone: custody first.
 */
function OverviewTab({
  asset, custody, openAssignment, names, serviceSummary, documents, activity,
  can, onAction, onOpenDocument, onShowTab,
}: {
  asset: Asset
  custody: ReturnType<typeof describeCustody>
  openAssignment: EmployeeAsset | null
  names: Record<string, string | undefined>
  serviceSummary: ReturnType<typeof summarizeService>
  documents: AssetDocument[]
  activity: AssetActivityEntry[]
  can: { warranty: boolean; documents: boolean; addService: boolean }
  onAction: (key: AssetActionKey) => void
  onOpenDocument: (doc: AssetDocument) => void
  onShowTab: (tab: TabKey) => void
}) {
  const warranty = warrantyStatus(asset.warranty_expiry_date)
  const warrantyDetail = warrantyDetailLine(asset.warranty_expiry_date)
  const recentActivity = activity.slice(0, 3)
  const hasFreeText =
    optionalText(asset.description) !== null || optionalText(asset.specifications) !== null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'flex-start' }}>

      {/* ── Main column (65%) ──
          The bases are PROPORTIONAL to the grow factors (455:245 = 65:35).
          flex distributes only the FREE space by the grow factor, so bases of
          420/280 skewed the result to 61/39; with proportional bases the split
          is exactly 65/35 at every width, and the wrap point is unchanged
          (455 + 245 + 14 gap ≈ the previous 420 + 280 + 14). */}
      <div style={{ flex: '65 1 455px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* A. Current custody — the question the page is opened to answer. */}
        <Card title="Current Custody">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '16px', fontWeight: 700, color: colors.primary, wordBreak: 'break-word' }}>
                {custody.label}
              </span>
              <span className={`boe-badge ${STATUS_BADGE[asset.status] ?? 'boe-badge-pending'}`} style={{ fontSize: '10px' }}>
                {assetStatusLabel(asset.status)}
              </span>
              {openAssignment && (
                <span
                  className={`boe-badge ${ACCEPTANCE_META[openAssignment.status]?.cls ?? 'boe-badge-pending'}`}
                  style={{ fontSize: '10px' }}
                >
                  {ACCEPTANCE_META[openAssignment.status]?.label ?? humanizeToken(openAssignment.status)}
                </span>
              )}
            </div>

            {/* A contradiction between the asset's status and its custody rows
                is surfaced, never smoothed over — describeCustody() reports it
                and this is where a reader sees it. */}
            {custody.inconsistent && (
              <div role="alert" style={{
                padding: '8px 10px', borderRadius: '7px', fontSize: '11.5px',
                background: 'rgba(217,79,79,0.08)', color: DANGER_TEXT,
              }}>
                This asset&rsquo;s status and its custody records disagree. Review the assignment history.
              </div>
            )}

            <div style={{ display: 'grid', gap: '12px 20px', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
              <DetailField label="Department" value={asset.department} />
              <DetailField label="Location"   value={asset.location} />
              {openAssignment ? (
                <>
                  <DetailField label="Assigned Date" value={fmtDate(openAssignment.assigned_at)} />
                  <DetailField label="Assigned By"   value={names[openAssignment.assigned_by] ?? null} />
                  <DetailField label="Accepted Date" value={openAssignment.accepted_at ? fmtDate(openAssignment.accepted_at) : null} />
                </>
              ) : (
                <DetailField label="Condition" value={asset.condition ? assetConditionLabel(asset.condition) : null} />
              )}
            </div>
          </div>
        </Card>

        {/* B. Asset information.
            Category, Condition and Last Updated are deliberately ABSENT: the
            summary strip above states all three and never scrolls away, so
            repeating them here was the same fact twice on one screen. */}
        <Card title="Asset Information">
          <div style={{ display: 'grid', gap: '13px 20px', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <DetailField label="Brand"   value={asset.brand} />
            <DetailField label="Model"   value={asset.model} />
            <DetailField label="Created" value={fmtDate(asset.created_at)} />
          </div>
        </Card>

        {/* C. Description & specifications — free text, so it gets its own
            full-width card rather than a cell in a grid. Rendered only when
            there is text to show: a titled card containing two dashes is a
            paragraph of vertical space spent saying nothing. */}
        {hasFreeText && (
          <Card title="Description &amp; Specifications">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
              <DetailField label="Description"    value={asset.description} />
              <DetailField label="Specifications" value={asset.specifications} />
            </div>
          </Card>
        )}

        {/* D. Latest activity — a preview of rows already loaded, never a
            second query. Absent entirely when there is no history. */}
        {recentActivity.length > 0 && (
          <Card
            title="Latest Activity"
            action={
              <button
                type="button"
                onClick={() => onShowTab('activity')}
                style={{
                  background: 'none', border: 'none', padding: 0, font: 'inherit',
                  fontSize: '11.5px', fontWeight: 600, color: colors.tertiary, cursor: 'pointer',
                }}
              >
                View all ({activity.length})
              </button>
            }
          >
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '11px' }}>
              {recentActivity.map(entry => (
                <li key={entry.id} style={{ display: 'flex', gap: '10px' }}>
                  <span aria-hidden="true" style={{
                    width: '7px', height: '7px', borderRadius: '50%', marginTop: '5px', flexShrink: 0,
                    background: TONE_COLOR[assetActivityTone(entry.event_type)] ?? colors.muted,
                  }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '8px' }}>
                      <span style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>
                        {assetActivityTitle(entry.event_type)}
                      </span>
                      <span style={{ fontSize: '11px', color: colors.muted }}>{fmtDateTime(entry.event_at)}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '1px' }}>{entry.summary}</div>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        )}
      </div>

      {/* ── Side column (35%) ── */}
      <div style={{ flex: '35 1 245px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* A. Warranty. The empty state appears only when NOTHING has been
            recorded — an asset with a start date but no expiry still reads as
            'not_available' and must not have its data hidden behind a CTA. */}
        <Card title="Warranty">
          {!hasWarrantyDetails(asset) ? (
            <EmptyState
              message="No warranty recorded for this asset."
              actionLabel={can.warranty ? ASSET_ACTION_LABEL.warranty : undefined}
              onAction={can.warranty ? () => onAction('warranty') : undefined}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span className={`boe-badge ${WARRANTY_BADGE[warranty]}`} style={{ fontSize: '10px' }}>
                  {WARRANTY_STATUS_LABEL[warranty]}
                </span>
                {warrantyDetail && <span style={{ fontSize: '11.5px', color: colors.muted }}>{warrantyDetail}</span>}
              </div>
              <SideFact label="Start"  value={asset.warranty_start_date ? fmtDate(asset.warranty_start_date) : null} />
              <SideFact label="Expiry" value={asset.warranty_expiry_date ? fmtDate(asset.warranty_expiry_date) : null} />
              <SideFact label="Type"   value={asset.warranty_type} />
            </div>
          )}
        </Card>

        {/* B. Repair & service. Totals only when there is something to total. */}
        <Card title="Repair &amp; Service">
          {serviceSummary.recordCount === 0 ? (
            <EmptyState
              message="No repair or service history yet."
              actionLabel={can.addService ? ASSET_ACTION_LABEL.addService : undefined}
              onAction={can.addService ? () => onAction('addService') : undefined}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
              <SideFact label="Total services" value={String(serviceSummary.recordCount)} strong />
              <SideFact label="Total spend"    value={formatINR(serviceSummary.totalCost)} strong />
              <SideFact label="Last service"   value={serviceSummary.lastServiceDate ? fmtDate(serviceSummary.lastServiceDate) : null} />
              <SideFact label="Next service"   value={serviceSummary.upcomingServiceDate ? fmtDate(serviceSummary.upcomingServiceDate) : null} />
              {serviceSummary.openRecordCount > 0 && (
                <div style={{ fontSize: '11.5px', color: '#B45309' }}>
                  {serviceSummary.openRecordCount} record{serviceSummary.openRecordCount === 1 ? '' : 's'} still open.
                </div>
              )}
            </div>
          )}
        </Card>

        {/* C. Documents. */}
        <Card
          title="Documents"
          action={documents.length > 0 ? (
            <button
              type="button"
              onClick={() => onShowTab('warranty')}
              style={{
                background: 'none', border: 'none', padding: 0, font: 'inherit',
                fontSize: '11.5px', fontWeight: 600, color: colors.tertiary, cursor: 'pointer',
              }}
            >
              View all ({documents.length})
            </button>
          ) : undefined}
        >
          {documents.length === 0 ? (
            <EmptyState
              message="No documents on file."
              actionLabel={can.documents ? ASSET_ACTION_LABEL.uploadInvoice : undefined}
              onAction={can.documents ? () => onAction('uploadInvoice') : undefined}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {documents.slice(0, 3).map(d => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onOpenDocument(d)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer',
                  }}
                >
                  <div style={{
                    fontSize: '12px', fontWeight: 600, color: colors.primary,
                    wordBreak: 'break-word',
                  }}>
                    {d.file_name}
                  </div>
                  <div style={{ fontSize: '11px', color: colors.muted }}>
                    {ASSET_DOCUMENT_TYPE_LABEL[d.doc_type] ?? humanizeToken(d.doc_type)}
                    {' · '}{formatFileSize(d.file_size)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* D. The purchase facts a reader checks but does not read down. */}
        <Card title="Quick Facts">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
            <SideFact label="Asset code"     value={asset.asset_code} mono />
            <SideFact label="Serial no."     value={asset.serial_no} mono />
            <SideFact label="Purchase date"  value={asset.purchase_date ? fmtDate(asset.purchase_date) : null} />
            <SideFact label="Purchase price" value={parseCost(asset.purchase_price) === null ? null : fmtMoney(asset.purchase_price)} />
            <SideFact label="Vendor"         value={asset.vendor} />
            <SideFact label="Invoice no."    value={asset.invoice_number} />
          </div>
        </Card>
      </div>
    </div>
  )
}

// ─── Assignment & transfer history ────────────────────────────────────────────

function AssignmentsTab({
  transfers, assignments, employeeName, isMobile,
}: {
  transfers: AssetTransfer[]
  assignments: EmployeeAsset[]
  employeeName: (id: string) => string | null
  isMobile: boolean
}) {
  if (transfers.length === 0 && assignments.length === 0) {
    return <Panel message="No assignment or movement history yet. It will appear here the first time this asset changes hands." />
  }

  const side = (id: string | null, location: string | null, snapshot: string | null) => {
    if (id) return employeeName(id) ?? snapshot ?? 'Unknown employee'
    return describeTransferSide(null, location, employeeName)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <SectionTitle>Movement History</SectionTitle>
        {transfers.length === 0 ? (
          <Panel message="No movements recorded yet." />
        ) : isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {transfers.map(t => (
              <div key={t.id} className="boe-card" style={{ padding: '14px 16px' }}>
                <div style={{ fontWeight: 600, color: colors.primary, fontSize: '13px' }}>
                  {TRANSFER_EVENT_LABEL[t.event_type] ?? humanizeToken(t.event_type)}
                </div>
                <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '4px' }}>
                  {side(t.from_employee_id, t.from_location, t.from_employee_name)} → {side(t.to_employee_id, t.to_location, t.to_employee_name)}
                </div>
                <div style={{ fontSize: '11px', color: colors.muted, marginTop: '4px' }}>
                  {fmtDateTime(t.transfer_date)}
                  {t.effective_date ? ` · Handover ${fmtDate(t.effective_date)}` : ''}
                </div>
                <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
                  By {t.performed_by_name ?? (t.performed_by ? employeeName(t.performed_by) : null) ?? 'the system'}
                  {t.condition ? ` · ${assetConditionLabel(t.condition)}` : ''}
                </div>
                {t.remarks && (
                  <div style={{ fontSize: '11.5px', color: colors.secondary, marginTop: '6px', whiteSpace: 'pre-wrap' }}>
                    {t.remarks}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="boe-card" style={{ overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
                <thead>
                  <tr style={{ background: colors.raised, borderBottom: `1px solid ${colors.border}` }}>
                    {['Event', 'From', 'To', 'Departments', 'Recorded', 'Handover', 'Condition', 'By', 'Remarks'].map(h => (
                      <th key={h} style={{
                        padding: '10px 12px', textAlign: 'left', fontSize: '11px', fontWeight: 600,
                        color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {transfers.map(t => (
                    <tr key={t.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '10px 12px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap' }}>
                        {TRANSFER_EVENT_LABEL[t.event_type] ?? humanizeToken(t.event_type)}
                      </td>
                      <td style={{ padding: '10px 12px', color: colors.secondary }}>{side(t.from_employee_id, t.from_location, t.from_employee_name)}</td>
                      <td style={{ padding: '10px 12px', color: colors.secondary }}>{side(t.to_employee_id, t.to_location, t.to_employee_name)}</td>
                      <td style={{ padding: '10px 12px', color: colors.muted }}>
                        {t.from_department || t.to_department
                          ? `${t.from_department ?? '—'} → ${t.to_department ?? '—'}`
                          : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', color: colors.muted, whiteSpace: 'nowrap' }}>{fmtDateTime(t.transfer_date)}</td>
                      <td style={{ padding: '10px 12px', color: colors.muted, whiteSpace: 'nowrap' }}>{fmtDate(t.effective_date)}</td>
                      <td style={{ padding: '10px 12px', color: colors.secondary }}>{t.condition ? assetConditionLabel(t.condition) : '—'}</td>
                      <td style={{ padding: '10px 12px', color: colors.secondary }}>
                        {t.performed_by_name ?? (t.performed_by ? employeeName(t.performed_by) : null) ?? 'System'}
                      </td>
                      <td style={{ padding: '10px 12px', color: colors.secondary, maxWidth: '220px', whiteSpace: 'pre-wrap' }}>{t.remarks ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <SectionTitle>Custody Periods</SectionTitle>
        {assignments.length === 0 ? (
          <Panel message="This asset has never been assigned to an employee." />
        ) : (
          <div className="boe-card" style={{ overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
                <thead>
                  <tr style={{ background: colors.raised, borderBottom: `1px solid ${colors.border}` }}>
                    {['Employee', 'Assigned By', 'Assigned', 'Accepted', 'Ended', 'State'].map(h => (
                      <th key={h} style={{
                        padding: '10px 12px', textAlign: 'left', fontSize: '11px', fontWeight: 600,
                        color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {assignments.map(a => (
                    <tr key={a.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '10px 12px', fontWeight: 600, color: colors.primary }}>{employeeName(a.employee_id) ?? 'Unknown employee'}</td>
                      <td style={{ padding: '10px 12px', color: colors.secondary }}>{employeeName(a.assigned_by) ?? 'Unknown employee'}</td>
                      <td style={{ padding: '10px 12px', color: colors.muted, whiteSpace: 'nowrap' }}>{fmtDate(a.assigned_at)}</td>
                      <td style={{ padding: '10px 12px', color: colors.muted, whiteSpace: 'nowrap' }}>{fmtDate(a.accepted_at)}</td>
                      <td style={{ padding: '10px 12px', color: colors.muted, whiteSpace: 'nowrap' }}>{fmtDate(a.returned_at ?? a.lost_at)}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span className={`boe-badge ${ACCEPTANCE_META[a.status]?.cls ?? 'boe-badge-pending'}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                          {ACCEPTANCE_META[a.status]?.label ?? humanizeToken(a.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Repair & service ─────────────────────────────────────────────────────────

function ServiceTab({
  services, summary, names, isMobile,
}: {
  services: AssetServiceRecord[]
  summary: ReturnType<typeof summarizeService>
  names: Record<string, string | undefined>
  isMobile: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))',
        gap: '10px',
      }}>
        <Stat label="Total Spend" value={formatINR(summary.totalCost)} />
        <Stat label="Service Records" value={String(summary.recordCount)} hint={summary.openRecordCount > 0 ? `${summary.openRecordCount} open` : undefined} />
        <Stat label="Last Service" value={fmtDate(summary.lastServiceDate)} />
        <Stat label="Next Service" value={summary.upcomingServiceDate ? fmtDate(summary.upcomingServiceDate) : 'Not scheduled'} />
      </div>

      {services.length === 0 ? (
        <Panel message="No repair or service history yet." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {services.map(s => (
            <div key={s.id} className="boe-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 600, color: colors.primary, fontSize: '13.5px' }}>
                  {ASSET_SERVICE_TYPE_LABEL[s.service_type] ?? humanizeToken(s.service_type)}
                  {s.vendor ? ` · ${s.vendor}` : ''}
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {s.status === 'in_progress' && (
                    <span className="boe-badge boe-badge-pending" style={{ fontSize: '10px' }}>Away for service</span>
                  )}
                  <span style={{ fontWeight: 700, color: colors.primary, fontSize: '13.5px' }}>{fmtMoney(s.cost)}</span>
                </div>
              </div>

              <div style={{ fontSize: '11.5px', color: colors.muted }}>
                Sent {fmtDate(s.sent_date)} · Returned {fmtDate(s.returned_date)}
                {s.next_service_date ? ` · Next ${fmtDate(s.next_service_date)}` : ''}
              </div>

              {s.issue && (
                <div style={{ fontSize: '12px', color: colors.secondary, whiteSpace: 'pre-wrap' }}>
                  <span style={{ color: colors.muted }}>Issue: </span>{s.issue}
                </div>
              )}
              {s.description && (
                <div style={{ fontSize: '12px', color: colors.secondary, whiteSpace: 'pre-wrap' }}>
                  <span style={{ color: colors.muted }}>Work: </span>{s.description}
                </div>
              )}
              {s.remarks && (
                <div style={{ fontSize: '12px', color: colors.secondary, whiteSpace: 'pre-wrap' }}>
                  <span style={{ color: colors.muted }}>Remarks: </span>{s.remarks}
                </div>
              )}

              <div style={{ fontSize: '11px', color: colors.muted }}>
                {s.condition_after ? `Condition after: ${ASSET_CONDITION_LABEL[s.condition_after] ?? s.condition_after} · ` : ''}
                Recorded by {(s.recorded_by ? names[s.recorded_by] : null) ?? 'the system'} on {fmtDate(s.created_at)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Warranty & documents ─────────────────────────────────────────────────────

function WarrantyTab({
  asset, documents, names, canManage, canEditWarranty,
  onOpenDocument, onRemoveDocument, onUploadOther, onUploadInvoice, onAddWarranty, isMobile,
}: {
  asset: Asset
  documents: AssetDocument[]
  names: Record<string, string | undefined>
  canManage: boolean
  canEditWarranty: boolean
  onOpenDocument: (doc: AssetDocument) => void
  onRemoveDocument: (doc: AssetDocument) => void
  onUploadOther: () => void
  onUploadInvoice: () => void
  onAddWarranty: () => void
  isMobile: boolean
}) {
  const status = warrantyStatus(asset.warranty_expiry_date)
  const detail = warrantyDetailLine(asset.warranty_expiry_date)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <SectionTitle>Warranty</SectionTitle>
        {!hasWarrantyDetails(asset) ? (
          <div className="boe-card" style={{ padding: isMobile ? '16px' : '20px 24px' }}>
            <EmptyState
              message="No warranty has been recorded for this asset."
              actionLabel={canEditWarranty ? ASSET_ACTION_LABEL.warranty : undefined}
              onAction={canEditWarranty ? onAddWarranty : undefined}
            />
          </div>
        ) : (
          <div className="boe-card" style={{
            padding: isMobile ? '16px' : '20px 24px',
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))',
            gap: '16px 24px',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <div style={{
                fontSize: '10.5px', fontWeight: 600, color: colors.muted,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                Status
              </div>
              <div>
                <span className={`boe-badge ${WARRANTY_BADGE[status]}`} style={{ fontSize: '10px' }}>
                  {WARRANTY_STATUS_LABEL[status]}
                </span>
                {detail && <div style={{ fontSize: '11px', color: colors.muted, marginTop: '4px' }}>{detail}</div>}
              </div>
            </div>
            <DetailField label="Warranty Start"  value={asset.warranty_start_date ? fmtDate(asset.warranty_start_date) : null} />
            <DetailField label="Warranty Expiry" value={asset.warranty_expiry_date ? fmtDate(asset.warranty_expiry_date) : null} />
            <DetailField label="Warranty Type"   value={asset.warranty_type} />
            <DetailField label="Vendor"          value={asset.vendor} />
            <DetailField label="Invoice Number"  value={asset.invoice_number} />
            <DetailField label="Remarks"         value={asset.warranty_remarks} />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
          <SectionTitle>Documents</SectionTitle>
          {/* Header control only once there is a list to add to. While the
              section is empty the empty state carries the single call to
              action, rather than two upload buttons stacked on each other. */}
          {canManage && documents.length > 0 && (
            <button
              type="button"
              className="boe-record-action"
              style={{ minHeight: '30px', padding: '6px 12px', fontSize: '12px' }}
              onClick={onUploadOther}
            >
              Upload Supporting Document
            </button>
          )}
        </div>

        {documents.length === 0 ? (
          <div className="boe-card" style={{ padding: isMobile ? '16px' : '20px 24px' }}>
            <EmptyState
              message="No documents on file yet. The invoice and warranty card are kept with the asset once uploaded."
              actionLabel={canManage ? ASSET_ACTION_LABEL.uploadInvoice : undefined}
              // The INVOICE handler, not onUploadOther — the label says Invoice
              // and the stored doc_type must agree with it.
              onAction={canManage ? onUploadInvoice : undefined}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {documents.map(d => (
              <div key={d.id} className="boe-card" style={{
                padding: '12px 16px', display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: colors.primary, fontSize: '13px', wordBreak: 'break-word' }}>
                    {d.file_name}
                  </div>
                  <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
                    {ASSET_DOCUMENT_TYPE_LABEL[d.doc_type] ?? humanizeToken(d.doc_type)}
                    {' · '}{formatFileSize(d.file_size)}
                    {' · '}Uploaded by {names[d.uploaded_by] ?? 'an employee'} on {fmtDate(d.created_at)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="boe-record-action"
                    style={{ minHeight: '30px', padding: '6px 12px', fontSize: '12px' }}
                    onClick={() => onOpenDocument(d)}
                  >
                    Open
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      className="boe-record-action boe-record-action--danger"
                      style={{ minHeight: '30px', padding: '6px 12px', fontSize: '12px' }}
                      onClick={() => onRemoveDocument(d)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Activity ─────────────────────────────────────────────────────────────────

function ActivityTab({
  rows, names, isMobile,
}: {
  rows: AssetActivityEntry[]
  names: Record<string, string | undefined>
  isMobile: boolean
}) {
  if (rows.length === 0) {
    return <Panel message="No activity recorded for this asset yet." />
  }

  return (
    <div className="boe-card" style={{ padding: isMobile ? '14px 16px' : '20px 24px' }}>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((entry, index) => {
          const actor = assetActivityActorName(entry, names)
          const employee = assetActivityEmployeeName(entry, names)
          const lines = assetActivityDetailLines(entry)
          const last = index === rows.length - 1
          return (
            <li key={entry.id} style={{ display: 'flex', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }} aria-hidden="true">
                <span style={{
                  width: '8px', height: '8px', borderRadius: '50%', marginTop: '5px',
                  background: TONE_COLOR[assetActivityTone(entry.event_type)] ?? colors.muted,
                }} />
                {!last && <span style={{ flex: 1, width: '1px', background: colors.border, marginTop: '4px' }} />}
              </div>

              <div style={{ paddingBottom: last ? 0 : '18px', minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '8px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                    {assetActivityTitle(entry.event_type)}
                  </span>
                  <span style={{ fontSize: '11px', color: colors.muted }}>{fmtDateTime(entry.event_at)}</span>
                </div>

                <div style={{ fontSize: '12.5px', color: colors.secondary, marginTop: '2px' }}>
                  {entry.summary}
                </div>

                <div style={{ fontSize: '11px', color: colors.muted, marginTop: '3px' }}>
                  {actor ? `By ${actor}` : 'By the system'}
                  {employee && employee !== actor ? ` · Employee: ${employee}` : ''}
                </div>

                {lines.length > 0 && (
                  <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {lines.map((line, i) => (
                      <div key={i} style={{ fontSize: '11.5px', color: colors.secondary, wordBreak: 'break-word' }}>
                        <span style={{ color: colors.muted }}>{line.label}: </span>
                        {line.value}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
