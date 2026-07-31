'use client'

import { useEffect, useState, useMemo, useRef, useId, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AssetsLayout, type AssetsView } from '@/components/layout/AssetsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useViewAs } from '@/hooks/useViewAs'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import {
  deriveAssetsAccessCapabilities,
  NO_ASSETS_ACCESS_CAPABILITIES,
  type AssetsAccessCapabilities,
} from '@/lib/permissions/assetsAccess'
// The return transition itself now lives in return_asset() (20260723000000);
// what stays here is the display and guard logic the table branches on.
import {
  acceptanceStatusKey,
  assetDeleteBlockReason,
} from '@/lib/assets/lifecycle'
// Permission AND asset state, decided in one place for both renderers.
import { assetRowActions } from '@/lib/assets/actionVisibility'
import { assetErrorMessage, logAssetFailure } from '@/lib/assets/errors'
import { shouldCloseFormModal, resolveTrapTarget, FOCUSABLE_SELECTOR } from '@/lib/ui/modalDismissal'
import {
  buildProposedFields,
  describeProposedChanges,
  hasPendingRequest,
  validateChangeRequest,
  REQUEST_STATUS_BADGE,
  REQUEST_STATUS_LABEL,
  REQUEST_TYPE_LABEL,
  type AssetChangeRequest,
} from '@/lib/assets/changeRequests'

// ─── DB Types ─────────────────────────────────────────────────────────────────

type Employee = { id: string; full_name: string; role: string; team: string }

type Asset = {
  id: string
  asset_type: string
  asset_name: string
  serial_no: string | null
  specifications: string | null
  status: string // available | assigned | returned | lost
  created_at: string
  updated_at: string
}

type EmployeeAsset = {
  id: string
  asset_id: string
  employee_id: string
  assigned_by: string
  assigned_at: string
  accepted_at: string | null
  returned_at: string | null
  lost_at: string | null
  status: string // pending_acceptance | accepted | returned | lost
  assets?: Asset | Asset[] | null
}

type AccessRecord = {
  id: string
  employee_id: string
  access_type: string
  username: string
  secret_value: string | null
  status: string // active | disabled
  assigned_at: string
  updated_at: string
  updated_by: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return '—'
  }
}

function singleAsset(a: EmployeeAsset['assets']): Asset | null {
  if (!a) return null
  return Array.isArray(a) ? (a[0] ?? null) : a
}

function TableHead({ cols }: { cols: string[] }) {
  return (
    <thead>
      <tr style={{ background: colors.raised, borderBottom: `1px solid ${colors.border}` }}>
        {cols.map(h => (
          <th key={h} style={{
            padding: '10px 16px', textAlign: 'left',
            fontSize: '11px', fontWeight: 600,
            color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em',
            whiteSpace: 'nowrap',
          }}>{h}</th>
        ))}
      </tr>
    </thead>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="boe-card" style={{ padding: '32px', textAlign: 'center' }}>
      <div style={{ fontSize: '12px', color: colors.muted }}>{message}</div>
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{
      padding: '10px 12px', borderRadius: '8px', marginBottom: '14px',
      background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px',
    }}>
      {message}
    </div>
  )
}

function SuccessBanner({ message }: { message: string }) {
  return (
    <div role="status" style={{
      padding: '10px 12px', borderRadius: '8px', marginBottom: '14px',
      background: 'rgba(22,163,74,0.10)', color: '#15803D', fontSize: '12px',
    }}>
      {message}
    </div>
  )
}

const ASSET_STATUS_BADGE: Record<string, string> = {
  pending_acceptance: 'boe-badge-pending',
  accepted: 'boe-badge-completed',
  returned: 'boe-badge-pending',
  lost: 'boe-badge-urgent',
}

const ACCEPTANCE_STATUS_BADGE: Record<string, string> = {
  pending_acceptance: 'boe-badge-pending',
  accepted: 'boe-badge-completed',
  available: 'boe-badge-completed',
  returned: 'boe-badge-pending',
  lost: 'boe-badge-urgent',
}

const ACCEPTANCE_STATUS_LABEL: Record<string, string> = {
  pending_acceptance: 'Pending Acceptance',
  accepted: 'Accepted',
  available: 'Available',
  returned: 'Returned',
  lost: 'Lost',
}

const ACCESS_STATUS_BADGE: Record<string, string> = {
  active: 'boe-badge-completed',
  disabled: 'boe-badge-urgent',
}

function Badge({ status, map }: { status: string; map: Record<string, string> }) {
  const cls = map[status] ?? 'boe-badge-pending'
  const label = status.replace(/_/g, ' ')
  return <span className={`boe-badge ${cls}`} style={{ fontSize: '10px', whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{label}</span>
}

const ASSET_TYPE_OPTIONS = ['laptop_desktop', 'monitor', 'mouse_keyboard', 'storage', 'phone', 'other']
const ACCESS_TYPE_OPTIONS = ['gmail', 'clickup', 'system_login', 'other']

// ─── Employee: My Assets ─────────────────────────────────────────────────────

function MyAssets({ userId, supabase, isMobile }: { userId: string; supabase: SupabaseClient; isMobile?: boolean }) {
  const [rows, setRows] = useState<EmployeeAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acceptingId, setAcceptingId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    const { data, error: dbError } = await supabase
      .from('employee_assets')
      .select('id, asset_id, employee_id, assigned_by, assigned_at, accepted_at, returned_at, lost_at, status, assets(id, asset_type, asset_name, serial_no, specifications, status, created_at, updated_at)')
      .eq('employee_id', userId)
      .order('assigned_at', { ascending: false })
    if (dbError) setError(dbError.message)
    setRows((data ?? []) as EmployeeAsset[])
    setLoading(false)
  }

  useEffect(() => {
    const onUserIdChange = () => { load() }
    onUserIdChange()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // Acceptance goes through accept_employee_asset (20260722000000), never a
  // direct UPDATE: the timestamp is the database's to set, not the client's,
  // and employees no longer hold UPDATE on employee_assets at all.
  const handleAccept = async (row: EmployeeAsset) => {
    setAcceptingId(row.id)
    setError(null)
    const { error: rpcError } = await supabase.rpc('accept_employee_asset', { p_assignment_id: row.id })
    setAcceptingId(null)
    if (rpcError) { logAssetFailure('accept', rpcError); setError(assetErrorMessage('accept', rpcError)); return }
    load()
  }

  if (loading) return <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      {rows.length === 0
        ? <EmptyState message="No assets assigned to you yet." />
        : isMobile ? (
          /* ── Mobile: cards ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {rows.map(row => {
              const asset = singleAsset(row.assets)
              return (
                <div key={row.id} className="boe-card" style={{ padding: '14px 16px' }}>
                  <div style={{ fontWeight: 600, color: colors.primary, fontSize: '14px', marginBottom: '4px' }}>{asset?.asset_name ?? '—'}</div>
                  {asset?.specifications && (
                    <div style={{ fontSize: '11px', color: colors.muted, marginBottom: '8px' }}>{asset.specifications}</div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px', fontSize: '12px', color: colors.secondary }}>
                    <span style={{ textTransform: 'capitalize' }}>{(asset?.asset_type ?? '—').replace(/_/g, ' ')}</span>
                    {asset?.serial_no && <span style={{ fontFamily: 'monospace' }}>{asset.serial_no}</span>}
                    <span>{fmtDate(row.assigned_at)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Badge status={row.status} map={ASSET_STATUS_BADGE} />
                    {row.status === 'pending_acceptance' && (
                      <button className="boe-btn boe-btn-primary" style={{ padding: '6px 14px', fontSize: '12px' }} disabled={acceptingId === row.id} onClick={() => handleAccept(row)}>
                        {acceptingId === row.id ? 'Accepting…' : 'Accept Asset'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          /* ── Desktop: table ── */
          <div className="boe-card" style={{ overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <TableHead cols={['Asset Name', 'Type', 'Serial No.', 'Assigned Date', 'Status', '']} />
                <tbody>
                  {rows.map(row => {
                    const asset = singleAsset(row.assets)
                    return (
                      <tr key={row.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <td style={{ padding: '12px 16px' }}>
                          <div style={{ fontWeight: 600, color: colors.primary }}>{asset?.asset_name ?? '—'}</div>
                          {asset?.specifications && (
                            <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px', maxWidth: '280px', whiteSpace: 'pre-wrap' }}>
                              {asset.specifications}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '12px 16px', color: colors.secondary, textTransform: 'capitalize' }}>{(asset?.asset_type ?? '—').replace(/_/g, ' ')}</td>
                        <td style={{ padding: '12px 16px', color: colors.secondary, fontFamily: 'monospace', fontSize: '12px' }}>{asset?.serial_no ?? '—'}</td>
                        <td style={{ padding: '12px 16px', color: colors.muted, fontSize: '12px' }}>{fmtDate(row.assigned_at)}</td>
                        <td style={{ padding: '12px 16px' }}><Badge status={row.status} map={ASSET_STATUS_BADGE} /></td>
                        <td style={{ padding: '12px 16px' }}>
                          {row.status === 'pending_acceptance' && (
                            <button className="boe-btn boe-btn-primary" style={{ padding: '5px 12px', fontSize: '11px' }} disabled={acceptingId === row.id} onClick={() => handleAccept(row)}>
                              {acceptingId === row.id ? 'Accepting…' : 'Accept Asset'}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      }
    </div>
  )
}

// ─── Employee: My Access ──────────────────────────────────────────────────────

function MyAccess({ userId, supabase, isMobile }: { userId: string; supabase: SupabaseClient; isMobile?: boolean }) {
  const [rows, setRows] = useState<AccessRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      const { data, error: dbError } = await supabase
        .from('access_records')
        .select('id, employee_id, access_type, username, secret_value, status, assigned_at, updated_at, updated_by')
        .eq('employee_id', userId)
        .order('assigned_at', { ascending: false })
      if (dbError) setError(dbError.message)
      setRows((data ?? []) as AccessRecord[])
      setLoading(false)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  if (loading) return <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      {rows.length === 0
        ? <EmptyState message="No access records assigned to you yet." />
        : isMobile ? (
          /* ── Mobile: cards ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {rows.map(r => (
              <div key={r.id} className="boe-card" style={{ padding: '14px 16px' }}>
                <div style={{ fontWeight: 600, color: colors.primary, fontSize: '14px', textTransform: 'capitalize', marginBottom: '4px' }}>{r.access_type.replace(/_/g, ' ')}</div>
                <div style={{ fontFamily: 'monospace', fontSize: '12px', color: colors.secondary, marginBottom: '8px' }}>{r.username}</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Badge status={r.status} map={ACCESS_STATUS_BADGE} />
                  <span style={{ fontSize: '11px', color: colors.muted }}>{fmtDate(r.assigned_at)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* ── Desktop: table ── */
          <div className="boe-card" style={{ overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <TableHead cols={['Access Type', 'Username', 'Assigned Date', 'Status']} />
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '12px 16px', fontWeight: 600, color: colors.primary, textTransform: 'capitalize' }}>{r.access_type.replace(/_/g, ' ')}</td>
                      <td style={{ padding: '12px 16px', color: colors.secondary, fontFamily: 'monospace', fontSize: '12px' }}>{r.username}</td>
                      <td style={{ padding: '12px 16px', color: colors.muted, fontSize: '12px' }}>{fmtDate(r.assigned_at)}</td>
                      <td style={{ padding: '12px 16px' }}><Badge status={r.status} map={ACCESS_STATUS_BADGE} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }
    </div>
  )
}

// ─── Admin: Asset Inventory ───────────────────────────────────────────────────

function AssetInventory({ employees, supabase, isMobile, caps, currentUserId }: {
  employees: Employee[]
  supabase: SupabaseClient
  isMobile?: boolean
  caps: AssetsAccessCapabilities
  currentUserId: string
}) {
  const [assets, setAssets] = useState<Asset[]>([])
  const [activeAssignments, setActiveAssignments] = useState<Record<string, EmployeeAsset>>({})
  const [myPendingRequests, setMyPendingRequests] = useState<AssetChangeRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [assigningAsset, setAssigningAsset] = useState<Asset | null>(null)
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null)
  const [requestingEdit, setRequestingEdit] = useState<Asset | null>(null)
  const [requestingRemoval, setRequestingRemoval] = useState<Asset | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    const [{ data: a, error: aErr }, { data: ea, error: eaErr }] = await Promise.all([
      supabase.from('assets').select('id, asset_type, asset_name, serial_no, specifications, status, created_at, updated_at').order('created_at', { ascending: false }),
      supabase.from('employee_assets').select('id, asset_id, employee_id, assigned_by, assigned_at, accepted_at, returned_at, lost_at, status').in('status', ['pending_acceptance', 'accepted']),
    ])
    if (aErr) setError(aErr.message)
    else if (eaErr) setError(eaErr.message)
    setAssets((a ?? []) as Asset[])
    const map: Record<string, EmployeeAsset> = {}
    ;((ea ?? []) as EmployeeAsset[]).forEach(row => { map[row.asset_id] = row })
    setActiveAssignments(map)

    // Only the requester's own open requests, and only for someone who can
    // raise them — it is what decides whether a row offers "Request Edit" or
    // reads "Edit requested". RLS scopes the read to their own rows anyway.
    if (caps.canRequestAssetChanges) {
      const { data: reqs } = await supabase
        .from('asset_change_requests')
        .select('*')
        .eq('status', 'pending')
      setMyPendingRequests((reqs ?? []) as AssetChangeRequest[])
    }

    setLoading(false)
  }

  useEffect(() => {
    const onMount = () => { load() }
    onMount()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const employeeName = (id: string) => employees.find(e => e.id === id)?.full_name ?? '—'

  // Custody changes go through return_asset / mark_asset_lost / assign_asset
  // (20260723000000). Each writes employee_assets AND assets.status in one
  // statement, so the two can never disagree, and each is authorized by
  // 'manage' alone — no 'edit' is needed just because assets.status moves.
  const handleMarkReturned = async (asset: Asset) => {
    setBusyId(asset.id)
    setError(null)
    const { error: rpcError } = await supabase.rpc('return_asset', { p_asset_id: asset.id })
    setBusyId(null)
    if (rpcError) { logAssetFailure('return', rpcError); setError(assetErrorMessage('return', rpcError)); return }
    load()
  }

  const handleMarkLost = async (asset: Asset) => {
    setBusyId(asset.id)
    setError(null)
    const { error: rpcError } = await supabase.rpc('mark_asset_lost', { p_asset_id: asset.id })
    setBusyId(null)
    if (rpcError) { logAssetFailure('mark-lost', rpcError); setError(assetErrorMessage('mark-lost', rpcError)); return }
    load()
  }

  // Only an asset nobody has ever held may be deleted — a mistaken inventory
  // entry. History is counted at click time with an exact count rather than
  // read from the loaded list, which holds active assignments only. The
  // database refuses the same thing regardless (assets_prevent_assigned_delete);
  // this exists to say why in plain words instead of surfacing a trigger error.
  const handleDelete = async (asset: Asset) => {
    setBusyId(asset.id)
    setError(null)

    const { count, error: countError } = await supabase
      .from('employee_assets')
      .select('id', { count: 'exact', head: true })
      .eq('asset_id', asset.id)

    if (countError) { setBusyId(null); logAssetFailure('delete', countError); setError(assetErrorMessage('delete', countError)); return }

    const blocked = assetDeleteBlockReason({
      canDeleteAsset: caps.canDeleteAsset,
      hasActiveAssignment: !!activeAssignments[asset.id],
      assignmentHistoryCount: count ?? 0,
    })
    if (blocked) { setBusyId(null); setError(blocked); return }

    if (!window.confirm(`Delete "${asset.asset_name}"? This cannot be undone.`)) {
      setBusyId(null)
      return
    }

    const { error: dbError } = await supabase.from('assets').delete().eq('id', asset.id)
    setBusyId(null)
    if (dbError) { logAssetFailure('delete', dbError); setError(assetErrorMessage('delete', dbError)); return }
    load()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {error && <ErrorBanner message={error} />}
      {notice && <SuccessBanner message={notice} />}
      {caps.canCreateAsset && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }} onClick={() => setShowCreate(true)}>
            + Create Asset
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>
      ) : assets.length === 0 ? (
        <EmptyState message="No assets in inventory yet." />
      ) : isMobile ? (
        /* ── Mobile: cards ── */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {assets.map(asset => {
            const assignment = activeAssignments[asset.id]
            const statusKey = acceptanceStatusKey(asset.status, assignment?.status)
            const rowActions = assetRowActions(caps, asset.status)
            return (
              <div key={asset.id} className="boe-card" style={{ padding: '14px 16px' }}>
                <div style={{ fontWeight: 600, color: colors.primary, fontSize: '14px', marginBottom: '2px' }}>{asset.asset_name}</div>
                {asset.specifications && <div style={{ fontSize: '11px', color: colors.muted, marginBottom: '6px' }}>{asset.specifications}</div>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '12px', color: colors.secondary, marginBottom: '10px' }}>
                  <span style={{ textTransform: 'capitalize' }}>{asset.asset_type.replace(/_/g, ' ')}</span>
                  {asset.serial_no && <span style={{ fontFamily: 'monospace' }}>{asset.serial_no}</span>}
                  {assignment && <span>→ {employeeName(assignment.employee_id)}</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                  <span className={`boe-badge ${ACCEPTANCE_STATUS_BADGE[statusKey] ?? 'boe-badge-pending'}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                    {ACCEPTANCE_STATUS_LABEL[statusKey] ?? statusKey}
                  </span>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {rowActions.assign && <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => setAssigningAsset(asset)}>Assign</button>}
                    {rowActions.markReturned && <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} disabled={busyId === asset.id} onClick={() => handleMarkReturned(asset)}>Returned</button>}
                    {rowActions.markLost && <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} disabled={busyId === asset.id} onClick={() => handleMarkLost(asset)}>Lost</button>}
                    {rowActions.edit && <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} disabled={busyId === asset.id} onClick={() => setEditingAsset(asset)}>Edit</button>}
                    {rowActions.remove && <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px', color: '#C13030' }} disabled={busyId === asset.id} onClick={() => handleDelete(asset)}>Delete</button>}
                    <RequestActions
                      asset={asset}
                      caps={caps}
                      currentUserId={currentUserId}
                      pendingRequests={myPendingRequests}
                      compact
                      onRequestEdit={() => setRequestingEdit(asset)}
                      onRequestRemoval={() => setRequestingRemoval(asset)}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        /* ── Desktop: table ── */
        <div className="boe-card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <TableHead cols={['Asset', 'Type', 'Serial No.', 'Assigned To', 'Acceptance Status', 'Actions']} />
              <tbody>
                {assets.map(asset => {
                  const assignment = activeAssignments[asset.id]
                  const statusKey = acceptanceStatusKey(asset.status, assignment?.status)
            const rowActions = assetRowActions(caps, asset.status)
                  return (
                    <tr key={asset.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ fontWeight: 600, color: colors.primary }}>{asset.asset_name}</div>
                        {asset.specifications && (
                          <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px', maxWidth: '280px', whiteSpace: 'pre-wrap' }}>
                            {asset.specifications}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '12px 16px', color: colors.secondary, textTransform: 'capitalize' }}>{asset.asset_type.replace(/_/g, ' ')}</td>
                      <td style={{ padding: '12px 16px', color: colors.secondary, fontFamily: 'monospace', fontSize: '12px' }}>{asset.serial_no ?? '—'}</td>
                      <td style={{ padding: '12px 16px', color: colors.secondary }}>{assignment ? employeeName(assignment.employee_id) : '—'}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <span className={`boe-badge ${ACCEPTANCE_STATUS_BADGE[statusKey] ?? 'boe-badge-pending'}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                          {ACCEPTANCE_STATUS_LABEL[statusKey] ?? statusKey}
                        </span>
                        {statusKey === 'accepted' && assignment?.accepted_at && (
                          <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '3px' }}>
                            Accepted {fmtDate(assignment.accepted_at)}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          {rowActions.assign && <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => setAssigningAsset(asset)}>Assign</button>}
                          {rowActions.markReturned && <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} disabled={busyId === asset.id} onClick={() => handleMarkReturned(asset)}>Mark Returned</button>}
                          {rowActions.markLost && <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} disabled={busyId === asset.id} onClick={() => handleMarkLost(asset)}>Mark Lost</button>}
                          {rowActions.edit && <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} disabled={busyId === asset.id} onClick={() => setEditingAsset(asset)}>Edit</button>}
                          {rowActions.remove && <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px', color: '#C13030' }} disabled={busyId === asset.id} onClick={() => handleDelete(asset)}>Delete</button>}
                          <RequestActions
                            asset={asset}
                            caps={caps}
                            currentUserId={currentUserId}
                            pendingRequests={myPendingRequests}
                            onRequestEdit={() => setRequestingEdit(asset)}
                            onRequestRemoval={() => setRequestingRemoval(asset)}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateAssetModal supabase={supabase} onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load() }} />
      )}
      {assigningAsset && (
        <AssignAssetModal
          asset={assigningAsset}
          employees={employees}
          supabase={supabase}
          onClose={() => setAssigningAsset(null)}
          onSaved={() => { setAssigningAsset(null); load() }}
        />
      )}
      {editingAsset && (
        <EditAssetModal
          asset={editingAsset}
          supabase={supabase}
          onClose={() => setEditingAsset(null)}
          onSaved={() => { setEditingAsset(null); load() }}
        />
      )}
      {requestingEdit && (
        <RequestEditModal
          asset={requestingEdit}
          supabase={supabase}
          onClose={() => setRequestingEdit(null)}
          onSubmitted={() => {
            setRequestingEdit(null)
            setNotice('Your edit request has been submitted.')
            load()
          }}
        />
      )}
      {requestingRemoval && (
        <RequestRemovalModal
          asset={requestingRemoval}
          supabase={supabase}
          onClose={() => setRequestingRemoval(null)}
          onSubmitted={() => {
            setRequestingRemoval(null)
            setNotice('Your removal request has been submitted.')
            load()
          }}
        />
      )}
    </div>
  )
}

// ─── Request actions on an inventory row ──────────────────────────────────────
// Shown to any non-admin who can see the inventory. Once they have an open
// request of that kind the button becomes a plain label, so the same person
// cannot file the duplicate the unique index would refuse anyway.

function RequestActions({
  asset, caps, currentUserId, pendingRequests, compact, onRequestEdit, onRequestRemoval,
}: {
  asset: Asset
  caps: AssetsAccessCapabilities
  currentUserId: string
  pendingRequests: AssetChangeRequest[]
  compact?: boolean
  onRequestEdit: () => void
  onRequestRemoval: () => void
}) {
  if (!caps.canRequestAssetChanges) return null

  const size = compact
    ? { padding: '5px 12px', fontSize: '12px' }
    : { padding: '4px 10px', fontSize: '11px' }

  const editPending   = hasPendingRequest(pendingRequests, asset.id, currentUserId, 'edit')
  const removePending = hasPendingRequest(pendingRequests, asset.id, currentUserId, 'remove')

  const pendingLabel = (text: string) => (
    <span style={{ ...size, color: colors.muted, display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
      {text}
    </span>
  )

  return (
    <>
      {editPending
        ? pendingLabel('Edit requested')
        : <button className="boe-btn boe-btn-ghost" style={size} onClick={onRequestEdit}>Request Edit</button>}
      {removePending
        ? pendingLabel('Removal requested')
        : <button className="boe-btn boe-btn-ghost" style={size} onClick={onRequestRemoval}>Request Removal</button>}
    </>
  )
}

function CreateAssetModal({ supabase, onClose, onSaved }: { supabase: SupabaseClient; onClose: () => void; onSaved: () => void }) {
  const [assetType, setAssetType] = useState(ASSET_TYPE_OPTIONS[0])
  const [assetName, setAssetName] = useState('')
  const [serialNo, setSerialNo] = useState('')
  const [specifications, setSpecifications] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!assetName.trim()) { setError('Asset Name is required.'); return }
    setSaving(true)
    setError(null)
    const { error: dbError } = await supabase.from('assets').insert({
      asset_type: assetType,
      asset_name: assetName.trim(),
      serial_no: serialNo.trim() || null,
      specifications: specifications.trim() || null,
    })
    setSaving(false)
    // A failed create keeps the modal open with every entered value intact —
    // the reader gets one sentence, the console gets the driver error.
    if (dbError) { logAssetFailure('create', dbError); setError(assetErrorMessage('create', dbError)); return }
    onSaved()
  }

  return (
    <Modal title="Create Asset" onClose={onClose}>
      <Field label="Asset Type">
        <select className="boe-input" value={assetType} onChange={e => setAssetType(e.target.value)} style={{ width: '100%' }}>
          {ASSET_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
      </Field>
      <Field label="Asset Name">
        <input className="boe-input" value={assetName} onChange={e => setAssetName(e.target.value)} placeholder="e.g. Dell XPS 15" style={{ width: '100%' }} />
      </Field>
      <Field label="Serial No.">
        <input className="boe-input" value={serialNo} onChange={e => setSerialNo(e.target.value)} placeholder="Optional" style={{ width: '100%' }} />
      </Field>
      <Field label="Specifications / Details">
        <textarea
          className="boe-input"
          value={specifications}
          onChange={e => setSpecifications(e.target.value)}
          placeholder="Example: Intel i5, 8GB RAM, 512GB SSD, Windows 11"
          rows={3}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </Field>
      {error && <ErrorBanner message={error} />}
      <ModalActions onClose={onClose} onSave={handleSave} saving={saving} saveLabel="Create Asset" />
    </Modal>
  )
}

function EditAssetModal({
  asset, supabase, onClose, onSaved,
}: { asset: Asset; supabase: SupabaseClient; onClose: () => void; onSaved: () => void }) {
  const [assetType, setAssetType] = useState(asset.asset_type)
  const [assetName, setAssetName] = useState(asset.asset_name)
  const [serialNo, setSerialNo] = useState(asset.serial_no ?? '')
  const [specifications, setSpecifications] = useState(asset.specifications ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!assetName.trim()) { setError('Asset Name is required.'); return }
    setSaving(true)
    setError(null)
    const { error: dbError } = await supabase
      .from('assets')
      .update({
        asset_type: assetType,
        asset_name: assetName.trim(),
        serial_no: serialNo.trim() || null,
        specifications: specifications.trim() || null,
      })
      .eq('id', asset.id)
    setSaving(false)
    if (dbError) { logAssetFailure('edit', dbError); setError(assetErrorMessage('edit', dbError)); return }
    onSaved()
  }

  return (
    <Modal title="Edit Asset" onClose={onClose}>
      <Field label="Asset Type">
        <select className="boe-input" value={assetType} onChange={e => setAssetType(e.target.value)} style={{ width: '100%' }}>
          {ASSET_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
      </Field>
      <Field label="Asset Name">
        <input className="boe-input" value={assetName} onChange={e => setAssetName(e.target.value)} style={{ width: '100%' }} />
      </Field>
      <Field label="Serial No.">
        <input className="boe-input" value={serialNo} onChange={e => setSerialNo(e.target.value)} placeholder="Optional" style={{ width: '100%' }} />
      </Field>
      <Field label="Specifications / Details">
        <textarea
          className="boe-input"
          value={specifications}
          onChange={e => setSpecifications(e.target.value)}
          placeholder="Example: Intel i5, 8GB RAM, 512GB SSD, Windows 11"
          rows={3}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </Field>
      {error && <ErrorBanner message={error} />}
      <ModalActions onClose={onClose} onSave={handleSave} saving={saving} saveLabel="Save Changes" />
    </Modal>
  )
}

function AssignAssetModal({
  asset, employees, supabase, onClose, onSaved,
}: { asset: Asset; employees: Employee[]; supabase: SupabaseClient; onClose: () => void; onSaved: () => void }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!employeeId) { setError('Select an employee.'); return }
    setSaving(true)
    setError(null)
    // One statement: the assignment row and assets.status move together, and
    // assigned_by is taken from the session inside the function.
    const { error: rpcError } = await supabase.rpc('assign_asset', {
      p_asset_id: asset.id,
      p_employee_id: employeeId,
    })
    setSaving(false)
    if (rpcError) { logAssetFailure('assign', rpcError); setError(assetErrorMessage('assign', rpcError)); return }
    onSaved()
  }

  return (
    <Modal title={`Assign "${asset.asset_name}"`} onClose={onClose}>
      <Field label="Employee">
        <select className="boe-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)} style={{ width: '100%' }}>
          {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.full_name} — {emp.role}</option>)}
        </select>
      </Field>
      {error && <ErrorBanner message={error} />}
      <ModalActions onClose={onClose} onSave={handleSave} saving={saving} saveLabel="Assign Asset" />
    </Modal>
  )
}

// ─── Request Edit ─────────────────────────────────────────────────────────────
// Never writes to assets. It files a row in asset_change_requests and stops —
// only an admin approving it can move the asset.

function RequestEditModal({
  asset, supabase, onClose, onSubmitted,
}: { asset: Asset; supabase: SupabaseClient; onClose: () => void; onSubmitted: () => void }) {
  const [assetType, setAssetType] = useState(asset.asset_type)
  const [assetName, setAssetName] = useState(asset.asset_name)
  const [serialNo, setSerialNo] = useState(asset.serial_no ?? '')
  const [specifications, setSpecifications] = useState(asset.specifications ?? '')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const proposed = buildProposedFields(
      { asset_type: asset.asset_type, asset_name: asset.asset_name, serial_no: asset.serial_no, specifications: asset.specifications },
      { asset_type: assetType, asset_name: assetName, serial_no: serialNo, specifications },
    )
    const invalid = validateChangeRequest({ type: 'edit', reason, proposed })
    if (invalid) { setError(invalid); return }

    setSaving(true)
    setError(null)
    // requested_by is defaulted from auth.uid() by the table and pinned by
    // the insert policy — the client never sends it.
    const { error: dbError } = await supabase.from('asset_change_requests').insert({
      asset_id: asset.id,
      asset_name_snapshot: asset.asset_name,
      request_type: 'edit',
      reason: reason.trim(),
      ...proposed,
    })
    setSaving(false)
    if (dbError) { logAssetFailure('request-edit', dbError); setError(assetErrorMessage('request-edit', dbError)); return }
    onSubmitted()
  }

  return (
    <Modal title="Request Edit" onClose={onClose}>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>
        An administrator reviews this request before anything changes.
      </div>
      <Field label="Asset Type">
        <select className="boe-input" value={assetType} onChange={e => setAssetType(e.target.value)} style={{ width: '100%' }}>
          {ASSET_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
      </Field>
      <Field label="Asset Name">
        <input className="boe-input" value={assetName} onChange={e => setAssetName(e.target.value)} style={{ width: '100%' }} />
      </Field>
      <Field label="Serial No.">
        <input className="boe-input" value={serialNo} onChange={e => setSerialNo(e.target.value)} style={{ width: '100%' }} />
      </Field>
      <Field label="Specifications / Details">
        <textarea className="boe-input" value={specifications} onChange={e => setSpecifications(e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} />
      </Field>
      <Field label="Reason (required)">
        <textarea
          className="boe-input"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Why does this asset need changing?"
          rows={2}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </Field>
      {error && <ErrorBanner message={error} />}
      <ModalActions onClose={onClose} onSave={handleSubmit} saving={saving} saveLabel="Submit Request" />
    </Modal>
  )
}

// ─── Request Removal ──────────────────────────────────────────────────────────
// Does not delete anything. Whether the asset can eventually go is decided at
// approval time by the custody-history rule, not here.

function RequestRemovalModal({
  asset, supabase, onClose, onSubmitted,
}: { asset: Asset; supabase: SupabaseClient; onClose: () => void; onSubmitted: () => void }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const invalid = validateChangeRequest({ type: 'remove', reason })
    if (invalid) { setError(invalid); return }

    setSaving(true)
    setError(null)
    const { error: dbError } = await supabase.from('asset_change_requests').insert({
      asset_id: asset.id,
      asset_name_snapshot: asset.asset_name,
      request_type: 'remove',
      reason: reason.trim(),
    })
    setSaving(false)
    if (dbError) { logAssetFailure('request-remove', dbError); setError(assetErrorMessage('request-remove', dbError)); return }
    onSubmitted()
  }

  return (
    <Modal title="Request Removal" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: colors.primary }}>{asset.asset_name}</div>
        <div style={{ fontSize: '12px', color: colors.secondary, fontFamily: 'monospace' }}>{asset.serial_no ?? 'No serial number'}</div>
      </div>
      <div style={{
        padding: '10px 12px', borderRadius: '8px',
        background: 'rgba(217,79,79,0.08)', color: '#C13030', fontSize: '11.5px',
      }}>
        This request needs administrator approval. The asset is not removed now, and
        it cannot be removed at all if it has assignment history.
      </div>
      <Field label="Reason (required)">
        <textarea
          className="boe-input"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Why should this asset be removed?"
          rows={3}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </Field>
      {error && <ErrorBanner message={error} />}
      <ModalActions onClose={onClose} onSave={handleSubmit} saving={saving} saveLabel="Submit Request" />
    </Modal>
  )
}

// ─── Asset Requests ───────────────────────────────────────────────────────────
// One screen for both audiences: a requester sees their own requests and what
// happened to them; an admin sees everyone's, with Approve / Reject on the
// pending ones. RLS decides which rows arrive, not this component.

function AssetRequests({ employees, supabase, caps, isMobile }: {
  employees: Employee[]
  supabase: SupabaseClient
  caps: AssetsAccessCapabilities
  isMobile?: boolean
}) {
  const [rows, setRows] = useState<AssetChangeRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<AssetChangeRequest | null>(null)

  const load = async () => {
    setLoading(true)
    const { data, error: dbError } = await supabase
      .from('asset_change_requests')
      .select('*')
      .order('created_at', { ascending: false })
    if (dbError) { logAssetFailure('request-edit', dbError); setError(assetErrorMessage('request-edit', dbError)) }
    setRows((data ?? []) as AssetChangeRequest[])
    setLoading(false)
  }

  useEffect(() => {
    const onMount = () => { load() }
    onMount()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const employeeName = (id: string | null) => employees.find(e => e.id === id)?.full_name ?? '—'

  const handleApprove = async (row: AssetChangeRequest) => {
    setBusyId(row.id)
    setError(null)
    setNotice(null)
    const { error: rpcError } = await supabase.rpc('approve_asset_change_request', {
      p_request_id: row.id,
      p_review_note: null,
    })
    setBusyId(null)
    if (rpcError) { logAssetFailure('approve-request', rpcError); setError(assetErrorMessage('approve-request', rpcError)); load(); return }
    setNotice(row.request_type === 'remove' ? 'Removal approved. The asset has been removed.' : 'Edit approved and applied to the asset.')
    load()
  }

  const pending  = rows.filter(r => r.status === 'pending')
  const reviewed = rows.filter(r => r.status !== 'pending')

  const RequestCard = ({ row }: { row: AssetChangeRequest }) => {
    const changes = describeProposedChanges(row)
    return (
      <div className="boe-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: colors.primary, fontSize: '14px' }}>{row.asset_name_snapshot}</div>
            <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '2px' }}>
              {REQUEST_TYPE_LABEL[row.request_type]} request · {employeeName(row.requested_by)} · {fmtDate(row.created_at)}
            </div>
          </div>
          <span className={`boe-badge ${REQUEST_STATUS_BADGE[row.status]}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
            {REQUEST_STATUS_LABEL[row.status]}
          </span>
        </div>

        <div style={{ fontSize: '12px', color: colors.secondary, whiteSpace: 'pre-wrap' }}>{row.reason}</div>

        {changes.length > 0 && (
          <div style={{ fontSize: '11.5px', color: colors.secondary, background: colors.raised, borderRadius: '8px', padding: '8px 10px' }}>
            {changes.map(line => <div key={line}>{line}</div>)}
          </div>
        )}

        {row.status !== 'pending' && (
          <div style={{ fontSize: '11px', color: colors.muted }}>
            {REQUEST_STATUS_LABEL[row.status]} by {employeeName(row.reviewed_by)} on {fmtDate(row.reviewed_at)}
            {row.review_note ? ` — ${row.review_note}` : ''}
          </div>
        )}

        {caps.canReviewAssetRequests && row.status === 'pending' && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button className="boe-btn boe-btn-primary" style={{ padding: '5px 14px', fontSize: '12px' }} disabled={busyId === row.id} onClick={() => handleApprove(row)}>
              {busyId === row.id ? 'Working…' : 'Approve'}
            </button>
            <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 14px', fontSize: '12px', color: '#C13030' }} disabled={busyId === row.id} onClick={() => setRejecting(row)}>
              Reject
            </button>
          </div>
        )}
      </div>
    )
  }

  if (loading) return <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {error && <ErrorBanner message={error} />}
      {notice && <SuccessBanner message={notice} />}

      <Section title={caps.canReviewAssetRequests ? 'Pending Requests' : 'My Open Requests'} isMobile={isMobile}>
        {pending.length === 0
          ? <EmptyState message="Nothing waiting for review." />
          : pending.map(row => <RequestCard key={row.id} row={row} />)}
      </Section>

      <Section title="Reviewed" isMobile={isMobile}>
        {reviewed.length === 0
          ? <EmptyState message="No requests have been reviewed yet." />
          : reviewed.map(row => <RequestCard key={row.id} row={row} />)}
      </Section>

      {rejecting && (
        <RejectRequestModal
          request={rejecting}
          supabase={supabase}
          onClose={() => setRejecting(null)}
          onRejected={() => { setRejecting(null); setNotice('Request rejected. The asset is unchanged.'); load() }}
        />
      )}
    </div>
  )
}

function Section({ title, children, isMobile }: { title: string; children: React.ReactNode; isMobile?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{
        fontSize: isMobile ? '11px' : '11.5px', fontWeight: 700, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function RejectRequestModal({
  request, supabase, onClose, onRejected,
}: { request: AssetChangeRequest; supabase: SupabaseClient; onClose: () => void; onRejected: () => void }) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleReject = async () => {
    setSaving(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc('reject_asset_change_request', {
      p_request_id: request.id,
      p_review_note: note.trim() || null,
    })
    setSaving(false)
    if (rpcError) { logAssetFailure('reject-request', rpcError); setError(assetErrorMessage('reject-request', rpcError)); return }
    onRejected()
  }

  return (
    <Modal title={`Reject ${REQUEST_TYPE_LABEL[request.request_type]} Request`} onClose={onClose}>
      <div style={{ fontSize: '12px', color: colors.secondary }}>
        {request.asset_name_snapshot} — the asset stays exactly as it is.
      </div>
      <Field label="Note to the requester (optional)">
        <textarea className="boe-input" value={note} onChange={e => setNote(e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} />
      </Field>
      {error && <ErrorBanner message={error} />}
      <ModalActions onClose={onClose} onSave={handleReject} saving={saving} saveLabel="Reject Request" />
    </Modal>
  )
}

// ─── Admin: Access Register ───────────────────────────────────────────────────

function AccessRegister({ employees, supabase, isMobile }: { employees: Employee[]; supabase: SupabaseClient; isMobile?: boolean }) {
  const [rows, setRows] = useState<AccessRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [editingRow, setEditingRow] = useState<AccessRecord | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    const { data, error: dbError } = await supabase
      .from('access_records')
      .select('id, employee_id, access_type, username, secret_value, status, assigned_at, updated_at, updated_by')
      .order('assigned_at', { ascending: false })
    if (dbError) setError(dbError.message)
    setRows((data ?? []) as AccessRecord[])
    setLoading(false)
  }

  useEffect(() => {
    const onMount = () => { load() }
    onMount()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const employeeName = (id: string) => employees.find(e => e.id === id)?.full_name ?? '—'

  const handleToggleStatus = async (row: AccessRecord) => {
    setBusyId(row.id)
    setError(null)
    const { data: { user } } = await supabase.auth.getUser()
    const newStatus = row.status === 'active' ? 'disabled' : 'active'
    const { error: dbError } = await supabase
      .from('access_records')
      .update({ status: newStatus, updated_by: user?.id })
      .eq('id', row.id)
    setBusyId(null)
    if (dbError) { setError(dbError.message); return }
    load()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }} onClick={() => setShowCreate(true)}>
          + Add Access Record
        </button>
      </div>

      {loading ? (
        <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState message="No access records yet." />
      ) : isMobile ? (
        /* ── Mobile: cards ── */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {rows.map(r => (
            <div key={r.id} className="boe-card" style={{ padding: '14px 16px' }}>
              <div style={{ fontWeight: 600, color: colors.primary, fontSize: '14px', marginBottom: '2px' }}>{employeeName(r.employee_id)}</div>
              <div style={{ fontSize: '12px', color: colors.secondary, textTransform: 'capitalize', marginBottom: '4px' }}>{r.access_type.replace(/_/g, ' ')}</div>
              <div style={{ fontFamily: 'monospace', fontSize: '12px', color: colors.secondary, marginBottom: '8px' }}>{r.username}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <Badge status={r.status} map={ACCESS_STATUS_BADGE} />
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => setEditingRow(r)}>Update</button>
                  <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} disabled={busyId === r.id} onClick={() => handleToggleStatus(r)}>
                    {r.status === 'active' ? 'Disable' : 'Re-enable'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ── Desktop: table ── */
        <div className="boe-card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <TableHead cols={['Employee', 'Access Type', 'Username', 'Status', 'Assigned Date', 'Actions']} />
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <td style={{ padding: '12px 16px', fontWeight: 600, color: colors.primary }}>{employeeName(r.employee_id)}</td>
                    <td style={{ padding: '12px 16px', color: colors.secondary, textTransform: 'capitalize' }}>{r.access_type.replace(/_/g, ' ')}</td>
                    <td style={{ padding: '12px 16px', color: colors.secondary, fontFamily: 'monospace', fontSize: '12px' }}>{r.username}</td>
                    <td style={{ padding: '12px 16px' }}><Badge status={r.status} map={ACCESS_STATUS_BADGE} /></td>
                    <td style={{ padding: '12px 16px', color: colors.muted, fontSize: '12px' }}>{fmtDate(r.assigned_at)}</td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => setEditingRow(r)}>Update Credentials</button>
                        <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} disabled={busyId === r.id} onClick={() => handleToggleStatus(r)}>
                          {r.status === 'active' ? 'Disable Access' : 'Re-enable Access'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateAccessModal employees={employees} supabase={supabase} onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load() }} />
      )}
      {editingRow && (
        <EditAccessModal row={editingRow} supabase={supabase} onClose={() => setEditingRow(null)} onSaved={() => { setEditingRow(null); load() }} />
      )}
    </div>
  )
}

function CreateAccessModal({
  employees, supabase, onClose, onSaved,
}: { employees: Employee[]; supabase: SupabaseClient; onClose: () => void; onSaved: () => void }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '')
  const [accessType, setAccessType] = useState(ACCESS_TYPE_OPTIONS[0])
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!employeeId || !username.trim()) { setError('Employee and Username are required.'); return }
    setSaving(true)
    setError(null)
    const { data: { user } } = await supabase.auth.getUser()
    const { error: dbError } = await supabase.from('access_records').insert({
      employee_id: employeeId,
      access_type: accessType,
      username: username.trim(),
      secret_value: secret || null,
      updated_by: user?.id,
    })
    setSaving(false)
    if (dbError) { setError(dbError.message); return }
    onSaved()
  }

  return (
    <Modal title="Add Access Record" onClose={onClose}>
      <Field label="Employee">
        <select className="boe-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)} style={{ width: '100%' }}>
          {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.full_name} — {emp.role}</option>)}
        </select>
      </Field>
      <Field label="Access Type">
        <select className="boe-input" value={accessType} onChange={e => setAccessType(e.target.value)} style={{ width: '100%' }}>
          {ACCESS_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
      </Field>
      <Field label="Username / Login ID">
        <input className="boe-input" value={username} onChange={e => setUsername(e.target.value)} style={{ width: '100%' }} />
      </Field>
      <Field label="Password / Secret">
        <input type="password" className="boe-input" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="new-password" style={{ width: '100%' }} />
      </Field>
      {error && <ErrorBanner message={error} />}
      <ModalActions onClose={onClose} onSave={handleSave} saving={saving} saveLabel="Add Record" />
    </Modal>
  )
}

function EditAccessModal({
  row, supabase, onClose, onSaved,
}: { row: AccessRecord; supabase: SupabaseClient; onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState(row.username)
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!username.trim()) { setError('Username is required.'); return }
    setSaving(true)
    setError(null)
    const { data: { user } } = await supabase.auth.getUser()
    const { error: dbError } = await supabase
      .from('access_records')
      .update({
        username: username.trim(),
        ...(secret ? { secret_value: secret } : {}),
        updated_by: user?.id,
      })
      .eq('id', row.id)
    setSaving(false)
    if (dbError) { setError(dbError.message); return }
    onSaved()
  }

  return (
    <Modal title="Update Credentials" onClose={onClose}>
      <Field label="Username / Login ID">
        <input className="boe-input" value={username} onChange={e => setUsername(e.target.value)} style={{ width: '100%' }} />
      </Field>
      <Field label="New Password / Secret">
        <input type="password" className="boe-input" value={secret} onChange={e => setSecret(e.target.value)} placeholder="Leave blank to keep unchanged" autoComplete="new-password" style={{ width: '100%' }} />
      </Field>
      {error && <ErrorBanner message={error} />}
      <ModalActions onClose={onClose} onSave={handleSave} saving={saving} saveLabel="Save Changes" />
    </Modal>
  )
}

// ─── Shared modal shell ────────────────────────────────────────────────────────
//
// Every modal in this module holds a form, so all of them follow the BOE Form
// Modal Dismissal Rule: Escape, ✕, Cancel and a successful save close them —
// a backdrop click does nothing. The rule itself lives in
// src/lib/ui/modalDismissal.ts.
//
// Layering: .boe-sidebar is `position: fixed; z-index: 100` (globals.css), and
// this shell used to sit at 59/60 — so the overlay rendered UNDER the sidebar
// and left the navigation live and clickable behind an apparently-modal
// dialog. These match the Finance modal constants, the established "clears the
// sidebar" pair. None of .boe-app-shell / .boe-main-content / .boe-page-body
// creates a stacking context, so a fixed child at 200 really is above 100.
const ASSETS_MODAL_OVERLAY_Z = 200
const ASSETS_MODAL_DIALOG_Z  = 201

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // Focus enters the dialog on open and returns to whatever opened it on
  // close (the Create Asset button), so keyboard users are never dropped at
  // the top of the document. Background scroll is locked for the lifetime of
  // the modal, matching the Finance shell.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    return () => {
      document.body.style.overflow = prevOverflow
      previouslyFocused?.focus?.()
    }
  }, [])

  // Escape closes; Tab and Shift+Tab cannot leave the dialog. Capture phase so
  // the trap runs before anything inside the dialog handles the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (shouldCloseFormModal('escape')) onClose()
        return
      }
      if (e.key !== 'Tab') return

      const root = dialogRef.current
      if (!root) return

      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetParent !== null || el === document.activeElement)
      const activeIndex = focusables.indexOf(document.activeElement as HTMLElement)

      const target = resolveTrapTarget({ count: focusables.length, activeIndex, shiftKey: e.shiftKey })
      if (target === null) return

      e.preventDefault()
      if (target === 'block') { root.focus(); return }
      focusables[target === 'first' ? 0 : focusables.length - 1]?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <>
      {/* Overlay: no click handler at all. It exists to dim the page and to
          swallow pointer events aimed at the sidebar and page behind it —
          never to dismiss the form. */}
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: ASSETS_MODAL_OVERLAY_Z }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: '440px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
          background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
          zIndex: ASSETS_MODAL_DIALOG_Z, padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px',
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div id={titleId} style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>{title}</div>
          <button
            onClick={() => { if (shouldCloseFormModal('close-icon')) onClose() }}
            aria-label="Close"
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '13px' }}
          >✕</button>
        </div>
        {children}
      </div>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>
      {children}
    </div>
  )
}

function ModalActions({ onClose, onSave, saving, saveLabel }: { onClose: () => void; onSave: () => void; saving: boolean; saveLabel: string }) {
  return (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
      <button onClick={() => { if (shouldCloseFormModal('cancel')) onClose() }} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
      <button onClick={onSave} disabled={saving} className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
        {saving ? 'Saving…' : saveLabel}
      </button>
    </div>
  )
}

// ─── View meta ────────────────────────────────────────────────────────────────

const VIEW_META: Record<AssetsView, { title: string; subtitle: string }> = {
  'my-assets':       { title: 'My Assets',       subtitle: 'Company devices assigned to you.' },
  'my-access':       { title: 'My Access',       subtitle: 'Login and access records assigned to you.' },
  'asset-inventory': { title: 'Asset Inventory', subtitle: 'All company assets and their assignment status.' },
  'access-register': { title: 'Access Register', subtitle: 'All employee login and access records.' },
  'asset-requests':  { title: 'Asset Requests',  subtitle: 'Edit and removal requests awaiting an administrator.' },
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AssetsAccessPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [caps, setCaps] = useState<AssetsAccessCapabilities>(NO_ASSETS_ACCESS_CAPABILITIES)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<AssetsView | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId } = useViewAs()
  const inViewMode = !!viewAsUserId

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Authority comes from Control Center → Access Control via the permission
  // engine, not from a role literal. Always resolved for the SIGNED-IN user,
  // never the impersonated one — View As shows another person's records, it
  // does not lend them your authority.
  const refreshCapabilities = useCallback(async (prof: UserProfile) => {
    const effective = await getEffectivePermissions(supabase, prof.id, 'assets_access').catch(() => [])
    const resolved = deriveAssetsAccessCapabilities(prof.role, effective)
    setCaps(resolved)
    return resolved
  }, [supabase])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const [{ data: p }, { data: empData }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at')
          .eq('id', session.user.id)
          .single(),
        supabase
          .from('users')
          .select('id, full_name, role, team')
          .eq('is_active', true)
          .order('full_name'),
      ])

      if (!p) { router.push('/login'); return }
      const prof = p as UserProfile
      setProfile(prof)
      setEmployees((empData ?? []) as Employee[])

      const resolved = await refreshCapabilities(prof)

      setView(resolved.canViewAssetInventory && !inViewMode ? 'asset-inventory' : 'my-assets')
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Capabilities were resolved once, at mount, and then trusted for the life
  // of the tab. An administrator changing someone's permissions in Control
  // Center therefore did not reach a page that was already open: it kept
  // offering buttons the database had just stopped accepting. Re-resolve
  // whenever the inventory is opened and whenever the tab regains focus, so a
  // permission change takes effect on the next glance rather than the next
  // login.
  useEffect(() => {
    if (!profile) return
    const refresh = () => { refreshCapabilities(profile) }
    if (view === 'asset-inventory' || view === 'asset-requests') refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, view])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleViewChange = (v: AssetsView) => setView(v)

  if (loading || !view || !profile) return <LoadingScreen />

  const meta = VIEW_META[view]
  const effectiveUserId = viewAsUserId ?? profile.id

  const renderView = () => {
    switch (view) {
      case 'my-assets':
        return <MyAssets userId={effectiveUserId} supabase={supabase} isMobile={isMobile} />
      case 'my-access':
        return <MyAccess userId={effectiveUserId} supabase={supabase} isMobile={isMobile} />
      case 'asset-inventory':
        return <AssetInventory employees={employees} supabase={supabase} isMobile={isMobile} caps={caps} currentUserId={profile.id} />
      case 'access-register':
        return <AccessRegister employees={employees} supabase={supabase} isMobile={isMobile} />
      case 'asset-requests':
        return <AssetRequests employees={employees} supabase={supabase} caps={caps} isMobile={isMobile} />
    }
  }

  return (
    <AssetsLayout
      profile={profile}
      activeView={view}
      onViewChange={handleViewChange}
      title={meta.title}
      subtitle={meta.subtitle}
      onSignOut={handleSignOut}
      canViewInventory={caps.canViewAssetInventory}
      canManageAccess={caps.canManageAccess}
      canSeeAssetRequests={caps.canReviewAssetRequests || caps.canRequestAssetChanges}
    >
      {renderView()}
    </AssetsLayout>
  )
}
