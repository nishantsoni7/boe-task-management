'use client'

import { useEffect, useState, useMemo } from 'react'
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

// Derives the acceptance status shown to admins from the asset's catalog
// status plus its active employee_assets row (if any) — no new table/state.
function acceptanceStatusKey(asset: Asset, assignment: EmployeeAsset | undefined): string {
  if (asset.status === 'returned') return 'returned'
  if (asset.status === 'lost') return 'lost'
  if (assignment) return assignment.status // pending_acceptance | accepted
  return 'available'
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

  const handleAccept = async (row: EmployeeAsset) => {
    setAcceptingId(row.id)
    const { error: dbError } = await supabase
      .from('employee_assets')
      .update({ accepted_at: new Date().toISOString(), status: 'accepted' })
      .eq('id', row.id)
    setAcceptingId(null)
    if (dbError) { setError(dbError.message); return }
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

function AssetInventory({ employees, supabase, isMobile, caps }: {
  employees: Employee[]
  supabase: SupabaseClient
  isMobile?: boolean
  caps: AssetsAccessCapabilities
}) {
  const [assets, setAssets] = useState<Asset[]>([])
  const [activeAssignments, setActiveAssignments] = useState<Record<string, EmployeeAsset>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [assigningAsset, setAssigningAsset] = useState<Asset | null>(null)
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null)
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
    setLoading(false)
  }

  useEffect(() => {
    const onMount = () => { load() }
    onMount()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const employeeName = (id: string) => employees.find(e => e.id === id)?.full_name ?? '—'

  const handleMarkReturned = async (asset: Asset) => {
    const assignment = activeAssignments[asset.id]
    if (!assignment) return
    setBusyId(asset.id)
    setError(null)
    const now = new Date().toISOString()
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from('employee_assets').update({ returned_at: now, status: 'returned' }).eq('id', assignment.id),
      supabase.from('assets').update({ status: 'returned' }).eq('id', asset.id),
    ])
    setBusyId(null)
    if (e1 || e2) { setError((e1 ?? e2)!.message); return }
    load()
  }

  const handleMarkLost = async (asset: Asset) => {
    const assignment = activeAssignments[asset.id]
    setBusyId(asset.id)
    setError(null)
    const now = new Date().toISOString()
    const ops = [supabase.from('assets').update({ status: 'lost' }).eq('id', asset.id)]
    if (assignment) ops.push(supabase.from('employee_assets').update({ lost_at: now, status: 'lost' }).eq('id', assignment.id))
    const results = await Promise.all(ops)
    setBusyId(null)
    const failed = results.find(r => r.error)
    if (failed?.error) { setError(failed.error.message); return }
    load()
  }

  const handleDelete = async (asset: Asset) => {
    if (activeAssignments[asset.id]) {
      setError('This asset is assigned. Mark it returned or lost before deleting.')
      return
    }
    if (!window.confirm(`Delete "${asset.asset_name}"? This cannot be undone.`)) return
    setBusyId(asset.id)
    setError(null)
    const { error: dbError } = await supabase.from('assets').delete().eq('id', asset.id)
    setBusyId(null)
    if (dbError) { setError(dbError.message); return }
    load()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {error && <ErrorBanner message={error} />}
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
            const statusKey = acceptanceStatusKey(asset, assignment)
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
                    {caps.canManageAssignments && asset.status === 'available' && <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => setAssigningAsset(asset)}>Assign</button>}
                    {caps.canManageAssignments && asset.status === 'assigned' && <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} disabled={busyId === asset.id} onClick={() => handleMarkReturned(asset)}>Returned</button>}
                    {caps.canManageAssignments && asset.status !== 'lost' && <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} disabled={busyId === asset.id} onClick={() => handleMarkLost(asset)}>Lost</button>}
                    {caps.canEditAsset && <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} disabled={busyId === asset.id} onClick={() => setEditingAsset(asset)}>Edit</button>}
                    {caps.canDeleteAsset && <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px', color: '#C13030' }} disabled={busyId === asset.id} onClick={() => handleDelete(asset)}>Delete</button>}
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
                  const statusKey = acceptanceStatusKey(asset, assignment)
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
                          {caps.canManageAssignments && asset.status === 'available' && <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => setAssigningAsset(asset)}>Assign</button>}
                          {caps.canManageAssignments && asset.status === 'assigned' && <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} disabled={busyId === asset.id} onClick={() => handleMarkReturned(asset)}>Mark Returned</button>}
                          {caps.canManageAssignments && asset.status !== 'lost' && <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} disabled={busyId === asset.id} onClick={() => handleMarkLost(asset)}>Mark Lost</button>}
                          {caps.canEditAsset && <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} disabled={busyId === asset.id} onClick={() => setEditingAsset(asset)}>Edit</button>}
                          {caps.canDeleteAsset && <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px', color: '#C13030' }} disabled={busyId === asset.id} onClick={() => handleDelete(asset)}>Delete</button>}
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
    </div>
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
    if (dbError) { setError(dbError.message); return }
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
    if (dbError) { setError(dbError.message); return }
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
    const { data: { user } } = await supabase.auth.getUser()
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from('employee_assets').insert({
        asset_id: asset.id,
        employee_id: employeeId,
        assigned_by: user?.id,
        status: 'pending_acceptance',
      }),
      supabase.from('assets').update({ status: 'assigned' }).eq('id', asset.id),
    ])
    setSaving(false)
    if (e1 || e2) { setError((e1 ?? e2)!.message); return }
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

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 59 }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: '440px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
        background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
        zIndex: 60, padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>{title}</div>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '13px' }}>✕</button>
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
      <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
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

      // Management authority comes from Control Center → Access Control via
      // the permission engine, not from a role literal. Resolved for the
      // signed-in user (never the impersonated one) — View As shows another
      // person's records, it does not lend them your authority.
      const effective = await getEffectivePermissions(supabase, prof.id, 'assets_access').catch(() => [])
      const resolved = deriveAssetsAccessCapabilities(prof.role, effective)
      setCaps(resolved)

      setView(resolved.canViewInventory && !inViewMode ? 'asset-inventory' : 'my-assets')
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        return <AssetInventory employees={employees} supabase={supabase} isMobile={isMobile} caps={caps} />
      case 'access-register':
        return <AccessRegister employees={employees} supabase={supabase} isMobile={isMobile} />
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
      canViewInventory={caps.canViewInventory}
      canManageAccess={caps.canManageAccess}
    >
      {renderView()}
    </AssetsLayout>
  )
}
