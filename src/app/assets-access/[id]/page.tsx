'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
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
import { assetErrorMessage, logAssetFailure } from '@/lib/assets/errors'
import {
  AddServiceRecordModal, AssignAssetModal, CompleteServiceModal, MarkLostModal,
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
// Five sections, one operational page — not a dashboard. Every number on it is
// derived from records the database actually holds (movement rows, service
// rows, documents, audit rows); nothing is inferred by diffing the current row
// against anything, and nothing is stored twice.
//
// The ACTIONS live here rather than on the inventory list, deliberately. An
// asset has eleven possible operations at various points in its life; a list
// row cannot carry them without becoming a menu, and a person about to
// transfer a laptop wants to see who has it and what condition it is in first.
// The list keeps only Assign, the one operation that needs no context.
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

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <div style={{
        fontSize: '10.5px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: '13px', color: colors.primary,
        fontFamily: mono ? 'monospace' : undefined,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {value}
      </div>
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

type ModalKind =
  | { kind: 'assign' } | { kind: 'transfer' } | { kind: 'return' } | { kind: 'lost' }
  | { kind: 'recover' } | { kind: 'send-repair' } | { kind: 'add-service' }
  | { kind: 'complete-service'; record: AssetServiceRecord }
  | { kind: 'warranty' }
  | { kind: 'upload'; docType: AssetDocumentType }
  | { kind: 'remove-document'; id: string; fileName: string }
  | { kind: 'retire'; dispose: boolean } | { kind: 'restore' }
  | { kind: 'edit' } | { kind: 'request-edit' } | { kind: 'request-removal' }

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

  const custody = useMemo(
    () => (asset ? describeCustody(asset, openAssignment, employeeName) : null),
    [asset, openAssignment, employeeName],
  )

  const orderedActivity = useMemo(() => sortAssetActivity(activity), [activity])
  const serviceSummary  = useMemo(() => summarizeService(services), [services])
  const openService     = useMemo(() => services.find(s => s.status === 'in_progress') ?? null, [services])
  const liveDocuments   = useMemo(() => activeDocuments(documents), [documents])
  const warranty        = asset ? warrantyStatus(asset.warranty_expiry_date) : 'not_available'

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

  const backToInventory = () => router.push('/assets-access?view=asset-inventory')

  // ── Which actions this person may take on this asset, right now ────────────
  // Permission AND state, both required — a button must never appear for
  // something the database will refuse.
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
    remove:       caps.canDeleteAsset,
    request:      caps.canRequestAssetChanges,
  }

  // Only an asset nobody has ever held may be deleted — a mistaken inventory
  // entry. History is counted at click time with an exact count rather than
  // read from what is on screen. The database refuses the same thing regardless
  // (assets_prevent_assigned_delete, now covering movement, service and
  // document history too); this exists to say why in plain words instead of
  // surfacing a trigger error.
  const handleDelete = async () => {
    if (!asset) return
    setError(null)
    setNotice(null)

    const { count, error: countError } = await supabase
      .from('employee_assets')
      .select('id', { count: 'exact', head: true })
      .eq('asset_id', asset.id)

    if (countError) { logAssetFailure('delete', countError); setError(assetErrorMessage('delete', countError)); return }

    const blocked = assetDeleteBlockReason({
      canDeleteAsset: caps.canDeleteAsset,
      hasActiveAssignment: !!openAssignment,
      assignmentHistoryCount: count ?? 0,
    })
    if (blocked) { setError(blocked); return }

    // A destructive action that leaves no form to fill in still needs a
    // confirmation, and this one is genuinely irreversible.
    if (!window.confirm(`Delete "${asset.asset_name}"? This cannot be undone.`)) return

    const { error: dbError } = await supabase.from('assets').delete().eq('id', asset.id)
    if (dbError) { logAssetFailure('delete', dbError); setError(assetErrorMessage('delete', dbError)); return }
    router.push('/assets-access?view=asset-inventory')
  }

  const ActionButton = ({
    label, onClick, danger,
  }: { label: string; onClick: () => void; danger?: boolean }) => (
    <button
      onClick={onClick}
      className={`boe-btn ${danger ? 'boe-btn-ghost' : 'boe-btn-ghost'}`}
      style={{
        padding: '6px 14px', fontSize: '12px',
        ...(danger ? { color: '#C13030', borderColor: 'rgba(217,79,79,0.4)' } : {}),
      }}
    >
      {label}
    </button>
  )

  const body = () => {
    if (!caps.canViewAssetInventory) {
      return <Panel message="You do not have permission to view asset details." />
    }
    if (error && !asset) return <Panel message={error} />
    if (!asset || !custody) {
      return <Panel message="This asset does not exist, or you do not have access to it." />
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {error && <Banner kind="error" message={error} />}
        {notice && <Banner kind="success" message={notice} />}

        {/* ── Header ── */}
        <div className="boe-card" style={{ padding: isMobile ? '16px' : '20px 24px' }}>
          <div style={{ fontFamily: 'monospace', fontSize: '12px', color: colors.muted, marginBottom: '4px' }}>
            {asset.asset_code}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <div style={{ fontSize: isMobile ? '17px' : '19px', fontWeight: 700, color: colors.primary }}>
              {asset.asset_name}
            </div>
            <span className={`boe-badge ${STATUS_BADGE[asset.status] ?? 'boe-badge-pending'}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
              {assetStatusLabel(asset.status)}
            </span>
            <span className={`boe-badge ${WARRANTY_BADGE[warranty]}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
              Warranty: {WARRANTY_STATUS_LABEL[warranty]}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px', fontSize: '12.5px', color: colors.secondary }}>
            <span style={{ textTransform: 'capitalize' }}>{humanizeToken(asset.asset_type)}</span>
            <span>
              <span style={{ color: colors.muted }}>
                {custody.kind === 'employee' ? 'Held by ' : custody.kind === 'location' ? 'Location ' : ''}
              </span>
              {custody.label}
            </span>
            {asset.department && <span><span style={{ color: colors.muted }}>Department </span>{asset.department}</span>}
          </div>

          {/* Actions. Destructive ones are visually distinct and each opens a
              modal that states what it will do — the modal IS the confirmation,
              so ordinary saves never carry an extra dialog on top. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '14px' }}>
            {can.assign       && <ActionButton label="Assign Asset"      onClick={() => setModal({ kind: 'assign' })} />}
            {can.transfer     && <ActionButton label="Transfer Asset"    onClick={() => setModal({ kind: 'transfer' })} />}
            {can.markReturned && <ActionButton label="Mark Returned"     onClick={() => setModal({ kind: 'return' })} />}
            {can.recover      && <ActionButton label="Record Recovery"   onClick={() => setModal({ kind: 'recover' })} />}
            {can.sendRepair   && <ActionButton label="Send for Repair"   onClick={() => setModal({ kind: 'send-repair' })} />}
            {can.closeService && openService && (
              <ActionButton label="Record Return from Service" onClick={() => setModal({ kind: 'complete-service', record: openService })} />
            )}
            {can.addService   && <ActionButton label="Add Repair / Service" onClick={() => setModal({ kind: 'add-service' })} />}
            {can.warranty     && <ActionButton label="Add Warranty Details" onClick={() => setModal({ kind: 'warranty' })} />}
            {can.documents    && <ActionButton label="Upload Invoice"    onClick={() => setModal({ kind: 'upload', docType: 'invoice' })} />}
            {can.documents    && <ActionButton label="Upload Warranty Card" onClick={() => setModal({ kind: 'upload', docType: 'warranty_card' })} />}
            {can.restore      && <ActionButton label="Restore to Service" onClick={() => setModal({ kind: 'restore' })} />}
            {can.edit         && <ActionButton label="Edit Asset"        onClick={() => setModal({ kind: 'edit' })} />}
            {can.request      && <ActionButton label="Request Edit"      onClick={() => setModal({ kind: 'request-edit' })} />}
            {can.request      && <ActionButton label="Request Removal"   onClick={() => setModal({ kind: 'request-removal' })} />}
            {can.markLost     && <ActionButton label="Mark Lost" danger   onClick={() => setModal({ kind: 'lost' })} />}
            {can.retire       && <ActionButton label="Retire Asset" danger onClick={() => setModal({ kind: 'retire', dispose: false })} />}
            {can.retire       && <ActionButton label="Dispose Asset" danger onClick={() => setModal({ kind: 'retire', dispose: true })} />}
            {can.remove       && <ActionButton label="Delete Asset" danger  onClick={handleDelete} />}
          </div>
        </div>

        {/* ── Tabs ── */}
        <div style={{
          display: 'flex', gap: '6px', flexWrap: 'wrap',
          borderBottom: `1px solid ${colors.border}`, paddingBottom: '8px',
        }} role="tablist">
          {TABS.map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '6px 14px', borderRadius: '20px',
                fontSize: '12px', fontWeight: 600,
                border: `1.5px solid ${tab === t.key ? colors.blue : colors.border}`,
                background: tab === t.key ? colors.blue : 'transparent',
                color: tab === t.key ? '#fff' : colors.secondary,
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'overview'    && <OverviewTab asset={asset} custodyLabel={custody.label} openAssignment={openAssignment} names={names} isMobile={isMobile} serviceTotal={serviceSummary.totalCost} />}
        {tab === 'assignments' && <AssignmentsTab transfers={transfers} assignments={assignments} employeeName={employeeName} isMobile={isMobile} />}
        {tab === 'service'     && <ServiceTab services={services} summary={serviceSummary} names={names} isMobile={isMobile} />}
        {tab === 'warranty'    && (
          <WarrantyTab
            asset={asset}
            documents={liveDocuments}
            names={names}
            canManage={can.documents}
            onOpenDocument={openDocument}
            onRemoveDocument={(d) => setModal({ kind: 'remove-document', id: d.id, fileName: d.file_name })}
            onUploadOther={() => setModal({ kind: 'upload', docType: 'other' })}
            isMobile={isMobile}
          />
        )}
        {tab === 'activity'    && <ActivityTab rows={orderedActivity} names={names} isMobile={isMobile} />}
      </div>
    )
  }

  const currentEmployeeId   = custody?.employeeId ?? null
  const currentEmployeeName = currentEmployeeId ? employeeName(currentEmployeeId) : null

  return (
    <AssetsLayout
      profile={profile}
      activeView="asset-inventory"
      title={asset?.asset_name ?? 'Asset'}
      subtitle={asset ? `${asset.asset_code} · Asset detail and full history.` : 'Asset detail.'}
      onSignOut={signOut}
      canViewInventory={caps.canViewAssetInventory}
      canManageAccess={caps.canManageAccess}
      canSeeAssetRequests={caps.canReviewAssetRequests || caps.canRequestAssetChanges}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <button
          onClick={backToInventory}
          className="boe-btn boe-btn-ghost"
          style={{ alignSelf: 'flex-start', padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <ArrowLeft size={14} strokeWidth={1.8} />
          Back to Asset Inventory
        </button>
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
        <AddServiceRecordModal asset={asset} supabase={supabase} onClose={() => setModal(null)} onDone={afterAction} />
      )}
      {asset && modal?.kind === 'warranty' && (
        <WarrantyDetailsModal asset={asset} supabase={supabase} onClose={() => setModal(null)} onDone={afterAction} />
      )}
      {asset && modal?.kind === 'upload' && (
        <UploadDocumentModal asset={asset} supabase={supabase} docType={modal.docType} onClose={() => setModal(null)} onDone={afterAction} />
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
          asset={asset} supabase={supabase}
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
    </AssetsLayout>
  )
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({
  asset, custodyLabel, openAssignment, names, isMobile, serviceTotal,
}: {
  asset: Asset
  custodyLabel: string
  openAssignment: EmployeeAsset | null
  names: Record<string, string | undefined>
  isMobile: boolean
  serviceTotal: number
}) {
  const grid = {
    padding: isMobile ? '16px' : '20px 24px',
    display: 'grid',
    gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))',
    gap: '16px 24px',
  } as const

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <SectionTitle>Identification</SectionTitle>
        <div className="boe-card" style={grid}>
          <DetailField label="Asset Code"   value={asset.asset_code} mono />
          <DetailField label="Category"     value={humanizeToken(asset.asset_type)} />
          <DetailField label="Serial No."   value={asset.serial_no ?? 'Not recorded'} mono />
          <DetailField label="Brand"        value={asset.brand ?? 'Not recorded'} />
          <DetailField label="Model"        value={asset.model ?? 'Not recorded'} />
          <DetailField label="Condition"    value={assetConditionLabel(asset.condition)} />
          <DetailField label="Description"  value={asset.description ?? 'Not recorded'} />
          <DetailField label="Specifications" value={asset.specifications ?? 'Not recorded'} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <SectionTitle>Current Position</SectionTitle>
        <div className="boe-card" style={grid}>
          <DetailField label="Status"           value={assetStatusLabel(asset.status)} />
          <DetailField label="Current Custodian" value={custodyLabel} />
          <DetailField label="Department"       value={asset.department ?? 'Not recorded'} />
          <DetailField label="Location"         value={asset.location ?? 'Not recorded'} />
          <DetailField label="Created"          value={fmtDate(asset.created_at)} />
          <DetailField label="Last Updated"     value={fmtDate(asset.updated_at)} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <SectionTitle>Purchase &amp; Warranty</SectionTitle>
        <div className="boe-card" style={grid}>
          <DetailField label="Purchase Date"   value={fmtDate(asset.purchase_date)} />
          <DetailField label="Purchase Price"  value={fmtMoney(asset.purchase_price)} />
          <DetailField label="Vendor"          value={asset.vendor ?? 'Not recorded'} />
          <DetailField label="Invoice Number"  value={asset.invoice_number ?? 'Not recorded'} />
          <DetailField label="Warranty Status" value={WARRANTY_STATUS_LABEL[warrantyStatus(asset.warranty_expiry_date)]} />
          <DetailField
            label="Total Repair / Service Spend"
            value={formatINR(serviceTotal)}
          />
        </div>
      </div>

      {openAssignment && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <SectionTitle>Current Custody</SectionTitle>
          <div className="boe-card" style={grid}>
            <DetailField label="Assigned To"   value={names[openAssignment.employee_id] ?? 'Unknown employee'} />
            <DetailField label="Assigned By"   value={names[openAssignment.assigned_by] ?? 'Unknown employee'} />
            <DetailField label="Assigned Date" value={fmtDate(openAssignment.assigned_at)} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <div style={{
                fontSize: '10.5px', fontWeight: 600, color: colors.muted,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                Acceptance
              </div>
              <div>
                <span
                  className={`boe-badge ${ACCEPTANCE_META[openAssignment.status]?.cls ?? 'boe-badge-pending'}`}
                  style={{ fontSize: '10px', whiteSpace: 'nowrap' }}
                >
                  {ACCEPTANCE_META[openAssignment.status]?.label ?? humanizeToken(openAssignment.status)}
                </span>
              </div>
            </div>
            <DetailField label="Accepted Date" value={fmtDate(openAssignment.accepted_at)} />
          </div>
        </div>
      )}
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
  asset, documents, names, canManage, onOpenDocument, onRemoveDocument, onUploadOther, isMobile,
}: {
  asset: Asset
  documents: AssetDocument[]
  names: Record<string, string | undefined>
  canManage: boolean
  onOpenDocument: (doc: AssetDocument) => void
  onRemoveDocument: (doc: AssetDocument) => void
  onUploadOther: () => void
  isMobile: boolean
}) {
  const status = warrantyStatus(asset.warranty_expiry_date)
  const detail = warrantyDetailLine(asset.warranty_expiry_date)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <SectionTitle>Warranty</SectionTitle>
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
          <DetailField label="Warranty Start"  value={fmtDate(asset.warranty_start_date)} />
          <DetailField label="Warranty Expiry" value={fmtDate(asset.warranty_expiry_date)} />
          <DetailField label="Warranty Type"   value={asset.warranty_type ?? 'Not recorded'} />
          <DetailField label="Vendor"          value={asset.vendor ?? 'Not recorded'} />
          <DetailField label="Invoice Number"  value={asset.invoice_number ?? 'Not recorded'} />
          <DetailField label="Remarks"         value={asset.warranty_remarks ?? 'Not recorded'} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
          <SectionTitle>Documents</SectionTitle>
          {canManage && (
            <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={onUploadOther}>
              Upload Supporting Document
            </button>
          )}
        </div>

        {documents.length === 0 ? (
          <Panel message="No documents on file yet. Upload the invoice or warranty card to keep them with the asset." />
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
                  <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => onOpenDocument(d)}>
                    Open
                  </button>
                  {canManage && (
                    <button
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '5px 12px', fontSize: '12px', color: '#C13030', borderColor: 'rgba(217,79,79,0.4)' }}
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
