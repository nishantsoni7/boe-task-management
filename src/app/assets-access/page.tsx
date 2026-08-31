'use client'

import { useEffect, useState, useMemo, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
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
import { assetErrorMessage, logAssetFailure } from '@/lib/assets/errors'
// Column lists are shared with the asset detail page so the two cannot drift
// apart on what an asset row contains (src/lib/assets/detail.ts).
import { ASSET_COLUMNS, EMPLOYEE_ASSET_COLUMNS } from '@/lib/assets/detail'
import {
  canApproveChangeRequest,
  describeProposedChanges,
  REQUEST_STATUS_BADGE,
  REQUEST_STATUS_LABEL,
  REQUEST_TYPE_LABEL,
  type AssetChangeRequest,
} from '@/lib/assets/changeRequests'
// Record shapes and display vocabularies, shared with the detail page.
import {
  ASSET_CONDITION_LABEL,
  ASSET_CONDITION_OPTIONS,
  ASSET_STATUS_OPTIONS,
  assetConditionLabel,
  assetStatusLabel,
  humanizeToken,
  type Asset,
  type EmployeeAsset,
} from '@/lib/assets/types'
// Search and filtering are pure functions, tested without React.
import {
  activeFilterCount,
  buildAssetRows,
  distinctValues,
  filterAssetRows,
  hasActiveFilters,
  sortAssetRows,
  EMPTY_ASSET_FILTERS,
  type AssetFilters,
} from '@/lib/assets/assetFilters'
import { WARRANTY_STATUS_LABEL, WARRANTY_STATUS_OPTIONS } from '@/lib/assets/warranty'
import { notifyAssetEvent, sweepWarrantyExpiries } from '@/lib/assets/notifyClient'
// Create / edit / request modals are shared components: the inventory and the
// asset detail page both offer them, and one copy is what stops the two forms
// from drifting apart about which fields an asset has.
import { CreateAssetModal, RequestEditModal } from '@/components/assets/AssetChangeModals'
import { AssignAssetModal } from './[id]/AssetActionModals'
import { AssetModal, AssetField, AssetModalActions } from '@/components/assets/AssetModal'
// The handover acknowledgement and its printed sheet. Both are shared with the
// asset detail page, so the employee and the person who issued the asset are
// always looking at the same document.
import { AcceptHandoverModal, HandoverSheetOverlay } from '@/components/assets/AssetHandover'
// The module's top-level Assets ⇄ Access Records switch.
import { AssetsAreaTabs } from '@/components/assets/AssetsAreaTabs'
import {
  areaForView, defaultViewForArea, resolveInitialView, type AssetsArea,
} from '@/lib/assets/viewRouting'

// ─── DB Types ─────────────────────────────────────────────────────────────────

type Employee = { id: string; full_name: string; role: string; team: string }

// One access record, AS THE BROWSER SEES IT.
//
// `secret_value` is deliberately absent, and so is every query below —
// ACCESS_RECORD_COLUMNS names the columns and that column is not one of them.
//
// The register has never DISPLAYED a stored secret; it used to SELECT one and
// throw it away, which was harmless while only administrators could read the
// table and is not something to carry forward now that 20261028000000 lets an
// administrator delegate that read. A plaintext password that never leaves the
// database cannot leak from a browser, a screenshot or a devtools panel.
// Writing one is unaffected: the Add and Update forms still send a new secret,
// and Update still leaves it alone when the field is blank.
type AccessRecord = {
  id: string
  employee_id: string
  access_type: string
  username: string
  status: string // active | disabled
  assigned_at: string
  updated_at: string
  updated_by: string | null
}

const ACCESS_RECORD_COLUMNS =
  'id, employee_id, access_type, username, status, assigned_at, updated_at, updated_by'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return '—'
  }
}

/** Date AND time — an acceptance is a moment, and the sheet has to say which. */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
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

const ACCESS_STATUS_BADGE: Record<string, string> = {
  active: 'boe-badge-completed',
  disabled: 'boe-badge-urgent',
}

function Badge({ status, map }: { status: string; map: Record<string, string> }) {
  const cls = map[status] ?? 'boe-badge-pending'
  const label = status.replace(/_/g, ' ')
  return <span className={`boe-badge ${cls}`} style={{ fontSize: '10px', whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{label}</span>
}

const ACCESS_TYPE_OPTIONS = ['gmail', 'clickup', 'system_login', 'other']

// ─── Employee: My Assets ─────────────────────────────────────────────────────

function MyAssets({ userId, acceptedByName, employees, supabase, isMobile, canRequest }: {
  userId: string
  /** Display name of whoever is accepting, for the acknowledgement notice. */
  acceptedByName?: string | null
  /**
   * Active employees, for naming the person who handed the asset over.
   *
   * The handover sheet has an "Issued By" line and a signature caption, and a
   * document that says "Issued By: —" is not evidence of a handover. The list
   * is already loaded by the screen; resolving assigned_by from it costs no
   * query. An id the list cannot resolve still prints "Not recorded" rather
   * than a raw uuid.
   */
  employees: Employee[]
  supabase: SupabaseClient
  isMobile?: boolean
  /**
   * Offer "Request Modification". False while impersonating: a request is
   * filed as the SIGNED-IN actor, and View As is for reading someone else's
   * screen, not for filing paperwork in their name.
   */
  canRequest?: boolean
}) {
  const router = useRouter()
  const [rows, setRows] = useState<EmployeeAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [requesting, setRequesting] = useState<Asset | null>(null)
  /** The assignment whose handover the employee is reading before accepting. */
  const [accepting, setAccepting] = useState<EmployeeAsset | null>(null)
  /** The assignment whose Handover Sheet is open for printing. */
  const [printing, setPrinting] = useState<EmployeeAsset | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    const { data, error: dbError } = await supabase
      .from('employee_assets')
      .select(`${EMPLOYEE_ASSET_COLUMNS}, assets(${ASSET_COLUMNS})`)
      .eq('employee_id', userId)
      .order('assigned_at', { ascending: false })
    if (dbError) setError(dbError.message)
    setRows((data ?? []) as unknown as EmployeeAsset[])
    setLoading(false)
  }

  useEffect(() => {
    const onUserIdChange = () => { load() }
    onUserIdChange()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  const assignerNames = useMemo(
    () => Object.fromEntries(employees.map(e => [e.id, e.full_name])) as Record<string, string | undefined>,
    [employees],
  )

  // Acceptance goes through accept_employee_asset (20260722000000), never a
  // direct UPDATE: the timestamp is the database's to set, not the client's,
  // and employees no longer hold UPDATE on employee_assets at all.
  //
  // Since 20261029000000 the RPC additionally refuses an acceptance that does
  // not carry the acknowledgement, so the button no longer writes — it opens
  // the handover, and AcceptHandoverModal makes the call once the employee has
  // read the terms and ticked the box. This is the SAME acceptance, with the
  // reading step in front of it; there is no second acceptance path.
  const handleAccepted = (row: EmployeeAsset) => {
    setAccepting(null)
    setNotice('Handover accepted. You can print the Handover Sheet from this list.')
    // The person who handed the asset over is the one waiting to hear this.
    const asset = singleAsset(row.assets)
    if (asset) {
      notifyAssetEvent({
        event: 'asset_transfer_acknowledged',
        assetId: asset.id,
        assetName: asset.asset_name,
        assetCode: asset.asset_code,
        assignerId: row.assigned_by,
        fromName: acceptedByName ?? null,
      })
    }
    load()
  }

  if (loading) return <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>

  // The employee's own record, opened from their own list. RLS decides what
  // comes back: assets_select's own-assignment branch is what makes this legal
  // for someone who cannot see the inventory, and it reaches nothing else.
  const openAsset = (asset: Asset) => router.push(`/assets-access/${asset.id}`)

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      {notice && <SuccessBanner message={notice} />}
      {rows.length === 0
        ? <EmptyState message="No assets assigned to you yet." />
        : isMobile ? (
          /* ── Mobile: cards ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {rows.map(row => {
              const asset = singleAsset(row.assets)
              return (
                <div key={row.id} className="boe-card" style={{ padding: '14px 16px' }}>
                  <div style={{ fontSize: '14px', marginBottom: '4px' }}>
                    {asset
                      ? <AssetNameLink asset={asset} onOpen={() => openAsset(asset)} />
                      : <span style={{ fontWeight: 600, color: colors.primary }}>—</span>}
                  </div>
                  {asset?.specifications && (
                    <div style={{ fontSize: '11px', color: colors.muted, marginBottom: '8px' }}>{asset.specifications}</div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px', fontSize: '12px', color: colors.secondary }}>
                    <span style={{ textTransform: 'capitalize' }}>{(asset?.asset_type ?? '—').replace(/_/g, ' ')}</span>
                    {asset?.serial_no && <span style={{ fontFamily: 'monospace' }}>{asset.serial_no}</span>}
                    <span>{fmtDate(row.assigned_at)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                    <Badge status={row.status} map={ASSET_STATUS_BADGE} />
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {canRequest && asset && (
                        <button className="boe-btn boe-btn-ghost" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={() => setRequesting(asset)}>
                          Request Modification
                        </button>
                      )}
                      {row.accepted_at && (
                        <button className="boe-btn boe-btn-ghost" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={() => setPrinting(row)}>
                          Print Handover Sheet
                        </button>
                      )}
                      {row.status === 'pending_acceptance' && (
                        <button className="boe-btn boe-btn-primary" style={{ padding: '6px 14px', fontSize: '12px' }} onClick={() => setAccepting(row)}>
                          Accept Handover
                        </button>
                      )}
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
                <TableHead cols={['Asset Name', 'Type', 'Serial No.', 'Assigned Date', 'Status', '']} />
                <tbody>
                  {rows.map(row => {
                    const asset = singleAsset(row.assets)
                    return (
                      <tr key={row.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <td style={{ padding: '12px 16px' }}>
                          {asset
                            ? <AssetNameLink asset={asset} onOpen={() => openAsset(asset)} />
                            : <div style={{ fontWeight: 600, color: colors.primary }}>—</div>}
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
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {row.status === 'pending_acceptance' && (
                              <button className="boe-btn boe-btn-primary" style={{ padding: '5px 12px', fontSize: '11px' }} onClick={() => setAccepting(row)}>
                                Accept Handover
                              </button>
                            )}
                            {row.accepted_at && (
                              <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '11px' }} onClick={() => setPrinting(row)}>
                                Print Handover Sheet
                              </button>
                            )}
                            {canRequest && asset && (
                              <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '11px' }} onClick={() => setRequesting(asset)}>
                                Request Modification
                              </button>
                            )}
                          </div>
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

      {/* Files a row in asset_change_requests and stops. Nothing about the
          asset moves until a reviewer approves it — and the INSERT policy
          allows this asset only because it is one this employee holds. */}
      {requesting && (
        <RequestEditModal
          asset={requesting}
          supabase={supabase}
          onClose={() => setRequesting(null)}
          onSubmitted={() => { setRequesting(null); setNotice('Your request has been submitted for review.') }}
        />
      )}

      {/* The handover, read before it is acknowledged. The tick-box gates the
          button here and p_accept_terms gates the write in the database. */}
      {accepting && (
        <AcceptHandoverModal
          assignment={accepting}
          asset={singleAsset(accepting.assets)}
          supabase={supabase}
          employeeName={acceptedByName}
          issuedByName={assignerNames[accepting.assigned_by] ?? null}
          onClose={() => setAccepting(null)}
          onAccepted={() => handleAccepted(accepting)}
        />
      )}

      {printing && (
        <HandoverSheetOverlay
          assignment={printing}
          asset={singleAsset(printing.assets)}
          employeeName={acceptedByName}
          issuedByName={assignerNames[printing.assigned_by] ?? null}
          formatDateTime={fmtDateTime}
          onClose={() => setPrinting(null)}
        />
      )}
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
        .select(ACCESS_RECORD_COLUMNS)
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

// Opens the asset's own page. Only the asset name is clickable, not the whole
// row: the row also carries Assign / Return / Edit / Delete, and a row-level
// click would fire behind every one of them.
function AssetNameLink({ asset, onOpen }: { asset: Asset; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      title={`Open ${asset.asset_code}`}
      style={{
        background: 'none', border: 'none', padding: 0, textAlign: 'left',
        font: 'inherit', fontWeight: 600, color: colors.primary, cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline' }}
      onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none' }}
    >
      {asset.asset_name}
    </button>
  )
}

// Badge classes for the list. Status and warranty are the two things a reader
// scans for, so both get one.
const ASSET_STATUS_BADGE_MAP: Record<string, string> = {
  available:    'boe-badge-completed',
  assigned:     'boe-badge-pending',
  under_repair: 'boe-badge-pending',
  returned:     'boe-badge-pending',
  lost:         'boe-badge-urgent',
  retired:      'boe-badge-pending',
  disposed:     'boe-badge-urgent',
}

const WARRANTY_BADGE_MAP: Record<string, string> = {
  active:        'boe-badge-completed',
  expiring_soon: 'boe-badge-pending',
  expired:       'boe-badge-urgent',
  not_available: 'boe-badge-pending',
}

function AssetInventory({ employees, supabase, isMobile, caps, openAssign, onAssignHandled }: {
  employees: Employee[]
  supabase: SupabaseClient
  isMobile?: boolean
  caps: AssetsAccessCapabilities
  /**
   * Whether the header's Assign Asset dialog is open. CONTROLLED from the
   * screen, like AccessRegister's openCreate and for the same reason: the
   * button sits in the header row above this component, but the list of
   * assignable assets lives here. It opens with NO asset preselected, so the
   * reader picks one inside the dialog.
   */
  openAssign?: boolean
  /** Close it. Called on cancel, on a successful assignment, and on Escape. */
  onAssignHandled?: () => void
}) {
  const router = useRouter()
  const [assets, setAssets] = useState<Asset[]>([])
  const [assignments, setAssignments] = useState<EmployeeAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [assigningAsset, setAssigningAsset] = useState<Asset | null>(null)

  // Filters live in ONE object so "Clear" is a single assignment that cannot
  // forget a field, and so the whole set can be handed to a pure function that
  // is tested without React.
  const [filters, setFilters] = useState<AssetFilters>(EMPTY_ASSET_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const setFilter = (key: keyof AssetFilters) => (value: string) =>
    setFilters(prev => ({ ...prev, [key]: value }))

  const load = async () => {
    setLoading(true)
    setError(null)
    const [{ data: a, error: aErr }, { data: ea, error: eaErr }] = await Promise.all([
      supabase.from('assets').select(ASSET_COLUMNS).order('updated_at', { ascending: false }),
      supabase.from('employee_assets').select(EMPLOYEE_ASSET_COLUMNS).in('status', ['pending_acceptance', 'accepted']),
    ])
    if (aErr) setError(assetErrorMessage('edit', aErr))
    else if (eaErr) setError(assetErrorMessage('edit', eaErr))
    setAssets((a ?? []) as unknown as Asset[])
    setAssignments((ea ?? []) as unknown as EmployeeAsset[])
    setLoading(false)
  }

  useEffect(() => {
    const onMount = () => { load() }
    onMount()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Warranty reminders have no user action behind them — a warranty crosses the
  // 30-day line at midnight, by itself. The sweep runs when someone who can act
  // on the result opens the inventory; seven-day duplicate suppression on the
  // server is what keeps that from becoming noise.
  useEffect(() => {
    if (caps.canViewAssetInventory) sweepWarrantyExpiries()
  }, [caps.canViewAssetInventory])

  const employeeLookup = useCallback(
    (id: string) => employees.find(e => e.id === id)?.full_name ?? null,
    [employees],
  )

  // Derived ONCE, so the table cell, the search haystack and the employee
  // filter all agree about who holds what.
  const rows = useMemo(
    () => sortAssetRows(buildAssetRows(assets, assignments, employeeLookup)),
    [assets, assignments, employeeLookup],
  )
  const visible = useMemo(() => filterAssetRows(rows, filters), [rows, filters])

  const departments = useMemo(() => distinctValues(assets, 'department'), [assets])
  const locations   = useMemo(() => distinctValues(assets, 'location'), [assets])
  const categories  = useMemo(() => distinctValues(assets, 'asset_type'), [assets])

  const filterCount = activeFilterCount(filters)
  const anyFilters  = hasActiveFilters(filters)

  const openAsset = (asset: Asset) => router.push(`/assets-access/${asset.id}`)

  const filterSelect = (
    label: string,
    key: keyof AssetFilters,
    options: { value: string; label: string }[],
  ) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      <span style={{
        fontSize: '10.5px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>{label}</span>
      <select
        className="boe-input"
        value={filters[key]}
        onChange={e => setFilter(key)(e.target.value)}
        style={{ width: '100%', fontSize: '12px', padding: '6px 8px' }}
      >
        <option value="">Any</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {error && <ErrorBanner message={error} />}
      {notice && <SuccessBanner message={notice} />}

      {/* ── Search + filters ── */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="boe-input"
          type="search"
          value={filters.search}
          onChange={e => setFilter('search')(e.target.value)}
          placeholder="Search name, code, serial, brand, model, holder or location"
          aria-label="Search assets"
          style={{ flex: '1 1 260px', minWidth: 0, fontSize: '13px' }}
        />
        <button
          className="boe-btn boe-btn-ghost"
          style={{ padding: '8px 14px', fontSize: '12.5px' }}
          onClick={() => setShowFilters(v => !v)}
          aria-expanded={showFilters}
        >
          {showFilters ? 'Hide Filters' : 'Filters'}{filterCount > 0 ? ` (${filterCount})` : ''}
        </button>
        {anyFilters && (
          <button
            className="boe-btn boe-btn-ghost"
            style={{ padding: '8px 14px', fontSize: '12.5px' }}
            onClick={() => setFilters(EMPTY_ASSET_FILTERS)}
          >
            Clear
          </button>
        )}
        {caps.canCreateAsset && (
          <button className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }} onClick={() => setShowCreate(true)}>
            + Create Asset
          </button>
        )}
      </div>

      {showFilters && (
        <div className="boe-card" style={{
          padding: '14px 16px',
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))',
          gap: '12px',
        }}>
          {filterSelect('Category', 'category', categories.map(c => ({ value: c, label: humanizeToken(c) })))}
          {filterSelect('Status', 'status', ASSET_STATUS_OPTIONS.map(s => ({ value: s, label: assetStatusLabel(s) })))}
          {filterSelect('Assigned Employee', 'employeeId', employees.map(e => ({ value: e.id, label: e.full_name })))}
          {filterSelect('Department', 'department', departments.map(d => ({ value: d, label: d })))}
          {filterSelect('Location', 'location', locations.map(l => ({ value: l, label: l })))}
          {filterSelect('Condition', 'condition', ASSET_CONDITION_OPTIONS.map(c => ({ value: c, label: ASSET_CONDITION_LABEL[c] })))}
          {filterSelect('Warranty', 'warranty', WARRANTY_STATUS_OPTIONS.map(w => ({ value: w, label: WARRANTY_STATUS_LABEL[w] })))}
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
            <span style={{
              fontSize: '10.5px', fontWeight: 600, color: colors.muted,
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>Purchased Between</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="date" className="boe-input" aria-label="Purchased from"
                value={filters.purchasedFrom} onChange={e => setFilter('purchasedFrom')(e.target.value)}
                style={{ width: '100%', fontSize: '12px', padding: '6px 8px' }}
              />
              <input
                type="date" className="boe-input" aria-label="Purchased to"
                value={filters.purchasedTo} onChange={e => setFilter('purchasedTo')(e.target.value)}
                style={{ width: '100%', fontSize: '12px', padding: '6px 8px' }}
              />
            </div>
          </label>
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>
      ) : assets.length === 0 ? (
        <EmptyState message="No assets in inventory yet." />
      ) : visible.length === 0 ? (
        <EmptyState message="No assets match this search. Clear the filters to see the full inventory." />
      ) : isMobile ? (
        /* ── Mobile: cards ── */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {visible.map(({ asset, holderLabel, warranty }) => {
            const canAssign = caps.canAssignAsset && asset.status === 'available'
            return (
              <div key={asset.id} className="boe-card" style={{ padding: '14px 16px' }}>
                <div style={{ fontFamily: 'monospace', fontSize: '10.5px', color: colors.muted, marginBottom: '2px' }}>{asset.asset_code}</div>
                <div style={{ fontSize: '14px', marginBottom: '2px' }}>
                  <AssetNameLink asset={asset} onOpen={() => openAsset(asset)} />
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '12px', color: colors.secondary, marginBottom: '10px' }}>
                  <span style={{ textTransform: 'capitalize' }}>{humanizeToken(asset.asset_type)}</span>
                  {asset.serial_no && <span style={{ fontFamily: 'monospace' }}>{asset.serial_no}</span>}
                  <span>→ {holderLabel}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <span className={`boe-badge ${ASSET_STATUS_BADGE_MAP[asset.status] ?? 'boe-badge-pending'}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                      {assetStatusLabel(asset.status)}
                    </span>
                    <span className={`boe-badge ${WARRANTY_BADGE_MAP[warranty]}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                      {WARRANTY_STATUS_LABEL[warranty]}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {canAssign && (
                      <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => setAssigningAsset(asset)}>Assign</button>
                    )}
                    <button className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => openAsset(asset)}>Open</button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        /* ── Desktop: table ──
           Nine narrow columns and no button strip. Every operation other than
           Assign lives on the asset's own page, which is what keeps this table
           inside a normal desktop width instead of scrolling sideways — and
           what lets someone see who holds an asset before acting on it. */
        <div className="boe-card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
              <TableHead cols={['Asset', 'Asset Code', 'Category', 'Current Holder', 'Status', 'Condition', 'Warranty', 'Last Updated', 'Actions']} />
              <tbody>
                {visible.map(({ asset, holderLabel, warranty }) => {
                  const canAssign = caps.canAssignAsset && asset.status === 'available'
                  return (
                    <tr key={asset.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '10px 12px' }}>
                        <AssetNameLink asset={asset} onOpen={() => openAsset(asset)} />
                        {asset.serial_no && (
                          <div style={{ fontSize: '11px', color: colors.muted, fontFamily: 'monospace', marginTop: '2px' }}>
                            {asset.serial_no}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '10px 12px', color: colors.secondary, fontFamily: 'monospace', fontSize: '11.5px', whiteSpace: 'nowrap' }}>{asset.asset_code}</td>
                      <td style={{ padding: '10px 12px', color: colors.secondary, textTransform: 'capitalize' }}>{humanizeToken(asset.asset_type)}</td>
                      <td style={{ padding: '10px 12px', color: colors.secondary }}>{holderLabel}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span className={`boe-badge ${ASSET_STATUS_BADGE_MAP[asset.status] ?? 'boe-badge-pending'}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                          {assetStatusLabel(asset.status)}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', color: colors.secondary, whiteSpace: 'nowrap' }}>{assetConditionLabel(asset.condition)}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span className={`boe-badge ${WARRANTY_BADGE_MAP[warranty]}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                          {WARRANTY_STATUS_LABEL[warranty]}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', color: colors.muted, whiteSpace: 'nowrap' }}>{fmtDate(asset.updated_at)}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'nowrap' }}>
                          {canAssign && (
                            <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => setAssigningAsset(asset)}>Assign</button>
                          )}
                          <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => openAsset(asset)}>Open</button>
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
        <CreateAssetModal
          supabase={supabase}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); setNotice('Asset created.'); load() }}
        />
      )}
      {assigningAsset && (
        <AssignAssetModal
          asset={assigningAsset}
          employees={employees}
          supabase={supabase}
          onClose={() => setAssigningAsset(null)}
          onDone={(message) => { setAssigningAsset(null); setNotice(message); load() }}
        />
      )}
      {/* Same dialog, entered without an asset. The candidate list is filtered
          to 'available' here rather than inside the dialog, because that is
          exactly the set assign_asset() will accept — offering an option the
          RPC would refuse is the shape of bug this module keeps closing. */}
      {openAssign && (
        <AssignAssetModal
          asset={null}
          assetOptions={assets.filter(a => a.status === 'available')}
          employees={employees}
          supabase={supabase}
          onClose={() => onAssignHandled?.()}
          onDone={(message) => { onAssignHandled?.(); setNotice(message); load() }}
        />
      )}
    </div>
  )
}

// ─── Asset Requests ───────────────────────────────────────────────────────────
// One screen for both audiences: a requester sees their own requests and what
// happened to them; a reviewer sees everyone's, with Reject on the pending ones
// and Approve on the ones they hold the authority to grant. RLS decides which
// rows arrive, not this component.

function AssetRequests({ employees, supabase, caps, isAdmin, isMobile }: {
  employees: Employee[]
  supabase: SupabaseClient
  caps: AssetsAccessCapabilities
  /** The SIGNED-IN actor's role. Approving a removal is admin-only. */
  isAdmin: boolean
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
    // An approved REMOVAL deletes the asset, so entity_id would point at a row
    // that no longer exists. Request notifications deep-link to the Asset
    // Requests screen instead (see getNotificationMeta), which is why the id is
    // still safe to send: nothing follows it to a detail page.
    notifyAssetEvent({
      event: row.request_type === 'remove' ? 'asset_request_approved' : 'asset_edit_request_approved',
      assetId: row.asset_id ?? '',
      assetName: row.asset_name_snapshot,
      requesterId: row.requested_by,
      requestType: row.request_type,
    })
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
            {canApproveChangeRequest({
              requestType: row.request_type,
              isAdmin,
              canReviewAssetRequests: caps.canReviewAssetRequests,
              canEditAsset: caps.canEditAsset,
            }) && (
              <button className="boe-btn boe-btn-primary" style={{ padding: '5px 14px', fontSize: '12px' }} disabled={busyId === row.id} onClick={() => handleApprove(row)}>
                {busyId === row.id ? 'Working…' : 'Approve'}
              </button>
            )}
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
    // The note travels with the notification: a rejection the requester cannot
    // act on is worse than no rejection notice at all.
    notifyAssetEvent({
      event: request.request_type === 'remove' ? 'asset_request_rejected' : 'asset_edit_request_rejected',
      assetId: request.asset_id ?? '',
      assetName: request.asset_name_snapshot,
      requesterId: request.requested_by,
      requestType: request.request_type,
      note: note.trim() || null,
    })
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

/**
 * The system an access record is for, as a reader would name it.
 *
 * The register stores a machine token ('system_login'), so a notification that
 * quoted it raw would read "system_login access was revoked".
 */
function accessLabel(row: { access_type: string }): string {
  return humanizeToken(row.access_type)
}

function AccessRegister({
  employees, supabase, isMobile, actorName, openCreate, onCreateHandled,
}: {
  employees: Employee[]
  supabase: SupabaseClient
  isMobile?: boolean
  /** Signed-in user's display name, for "revoked by …". */
  actorName?: string | null
  /**
   * Whether the Add Access Record dialog is open.
   *
   * "Add Access Record" lives in the top-level action slot beside the Assets ⇄
   * Access Records switch, which is ABOVE this component. So the dialog is
   * CONTROLLED from there rather than mirrored into local state here — one
   * source of truth, and no effect that would have to sync two.
   */
  openCreate?: boolean
  /** Close it. Called on cancel, on a successful save, and on Escape. */
  onCreateHandled?: () => void
}) {
  const [rows, setRows] = useState<AccessRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingRow, setEditingRow] = useState<AccessRecord | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    const { data, error: dbError } = await supabase
      .from('access_records')
      .select(ACCESS_RECORD_COLUMNS)
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
    // Losing or regaining access to a company system is the clearest case in
    // the module of something the person it happens to must be told. The actor
    // is excluded server-side by id, so an admin toggling their OWN access
    // record is told nothing.
    notifyAssetEvent({
      event: newStatus === 'active' ? 'access_restored' : 'access_revoked',
      assetId: row.id,
      assetName: accessLabel(row),
      accessHolderId: row.employee_id,
      accessLabel: accessLabel(row),
      actorName: actorName ?? null,
    })
    load()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {error && <ErrorBanner message={error} />}

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

      {openCreate && (
        <CreateAccessModal
          employees={employees}
          supabase={supabase}
          onClose={() => onCreateHandled?.()}
          onSaved={() => { onCreateHandled?.(); load() }}
        />
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
    // `select('id')` so the new row's id can be the notification's entity_id —
    // an insert that returns nothing leaves the notification unable to name the
    // record it is about.
    const { data: created, error: dbError } = await supabase.from('access_records').insert({
      employee_id: employeeId,
      access_type: accessType,
      username: username.trim(),
      secret_value: secret || null,
      updated_by: user?.id,
    }).select('id').maybeSingle()
    setSaving(false)
    if (dbError) { setError(dbError.message); return }
    // The person who now holds the credentials. The secret itself never travels
    // in a notification — only the fact that access exists and its username.
    notifyAssetEvent({
      event: 'access_granted',
      assetId: (created as { id: string } | null)?.id ?? '',
      assetName: humanizeToken(accessType),
      accessHolderId: employeeId,
      accessLabel: humanizeToken(accessType),
      toName: username.trim() || null,
    })
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
    // Their username or password just changed under them — the one case where
    // not telling someone guarantees a failed login they cannot explain.
    notifyAssetEvent({
      event: 'access_updated',
      assetId: row.id,
      assetName: accessLabel(row),
      accessHolderId: row.employee_id,
      accessLabel: accessLabel(row),
    })
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

// ─── Shared modal shell ───────────────────────────────────────────────────────
//
// One implementation for the whole module, in components/assets/AssetModal.tsx.
// It used to live here, which is how the inventory dialogs and the (later)
// detail-page dialogs could have ended up behaving differently. Aliased rather
// than renamed at every call site so the diff stays about behaviour.
//
// The rules it enforces — Escape / X / Cancel close, a backdrop click does
// nothing, a failed save keeps the form, the page behind is inert and
// unscrollable, focus is trapped and restored — are stated once there and
// decided in src/lib/ui/modalDismissal.ts.
const Modal        = AssetModal
const Field        = AssetField
const ModalActions = AssetModalActions

const VIEW_META: Record<AssetsView, { title: string; subtitle: string }> = {
  'my-assets':       { title: 'My Assets',       subtitle: 'Company devices assigned to you.' },
  'my-access':       { title: 'My Access',       subtitle: 'Login and access records assigned to you.' },
  'asset-inventory': { title: 'Asset Inventory', subtitle: 'All company assets and their assignment status.' },
  'access-register': { title: 'Access Register', subtitle: 'All employee login and access records.' },
  'asset-requests':  { title: 'Asset Requests',  subtitle: 'Change and removal requests, and what was decided.' },
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// useSearchParams needs a Suspense boundary to render: the page reads ?view=
// so the module's sub-pages and its notification deep links can land on a
// specific screen. LoadingScreen is the same fallback the page shows while it
// resolves the session, so the boundary is invisible.
export default function AssetsAccessPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AssetsAccessScreen />
    </Suspense>
  )
}

function AssetsAccessScreen() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [caps, setCaps] = useState<AssetsAccessCapabilities>(NO_ASSETS_ACCESS_CAPABILITIES)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<AssetsView | null>(null)
  const [isMobile, setIsMobile] = useState(false)
  /**
   * A press of the area's primary action, waiting for the view that owns the
   * dialog to pick it up.
   *
   * The button is in the header, the dialog belongs to the list below it, and
   * pressing it may also CHANGE the view (Add Access Record from My Access
   * moves to the Access Register first). So the press is recorded here and the
   * child consumes it on its next render.
   */
  const [primaryRequest, setPrimaryRequest] = useState<'assign' | 'add-access' | null>(null)

  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedView = searchParams.get('view')
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

      // ?view= lets the module's sub-pages and its notification deep links land
      // on a specific screen. It is validated against what this person may
      // actually see: a URL is a request, not an authorization, and an
      // unrecognised or unpermitted value falls back to the normal landing view
      // rather than rendering a screen the reader has no rights to.
      setView(resolveInitialView(requestedView, resolved, inViewMode))
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
  const area = areaForView(view)

  // Switching area lands on the strongest screen the SIGNED-IN person may open
  // there — never on a screen resolveInitialView would have refused, because
  // defaultViewForArea only ever returns their own records or something they
  // hold a grant for.
  const handleAreaChange = (next: AssetsArea) => {
    if (next === area) return
    setPrimaryRequest(null)
    setView(defaultViewForArea(next, caps, inViewMode))
  }

  // ONE action per area, and only when the reader actually holds it. A button
  // that opens a dialog the database will refuse is worse than no button.
  //
  // Neither is offered while impersonating: a write made in View As is made by
  // the SIGNED-IN user against somebody else's screen, which is precisely the
  // confusion the mode must not create.
  const primaryAction = (() => {
    if (inViewMode) return null
    if (area === 'assets') {
      if (!caps.canAssignAsset) return null
      return (
        <button
          className="boe-btn boe-btn-primary"
          style={{ padding: '8px 18px', fontSize: '13px', width: isMobile ? '100%' : undefined }}
          onClick={() => {
            // The dialog belongs to the inventory, so go there first if the
            // reader is on another Assets screen.
            if (view !== 'asset-inventory') setView('asset-inventory')
            setPrimaryRequest('assign')
          }}
        >
          Assign Asset
        </button>
      )
    }
    if (!caps.canManageAccess) return null
    return (
      <button
        className="boe-btn boe-btn-primary"
        style={{ padding: '8px 18px', fontSize: '13px', width: isMobile ? '100%' : undefined }}
        onClick={() => {
          if (view !== 'access-register') setView('access-register')
          setPrimaryRequest('add-access')
        }}
      >
        Add Access Record
      </button>
    )
  })()

  const renderView = () => {
    switch (view) {
      case 'my-assets':
        return (
          <MyAssets
            userId={effectiveUserId}
            acceptedByName={profile.full_name}
            employees={employees}
            supabase={supabase}
            isMobile={isMobile}
            canRequest={caps.canRequestAssetChanges && !inViewMode}
          />
        )
      case 'my-access':
        return <MyAccess userId={effectiveUserId} supabase={supabase} isMobile={isMobile} />
      case 'asset-inventory':
        return (
          <AssetInventory
            employees={employees}
            supabase={supabase}
            isMobile={isMobile}
            caps={caps}
            openAssign={primaryRequest === 'assign'}
            onAssignHandled={() => setPrimaryRequest(null)}
          />
        )
      case 'access-register':
        return (
          <AccessRegister
            employees={employees}
            supabase={supabase}
            isMobile={isMobile}
            actorName={profile.full_name}
            openCreate={primaryRequest === 'add-access'}
            onCreateHandled={() => setPrimaryRequest(null)}
          />
        )
      case 'asset-requests':
        return (
          <AssetRequests
            employees={employees}
            supabase={supabase}
            caps={caps}
            isAdmin={profile.role === 'admin'}
            isMobile={isMobile}
          />
        )
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
      canReviewAssetRequests={caps.canReviewAssetRequests}
    >
      {/* The module's subject switch, above everything. The sidebar still
          navigates within an area; this says WHICH area you are in, which is
          the question five sibling sidebar entries never answered. */}
      <AssetsAreaTabs
        active={area}
        onSelect={handleAreaChange}
        action={primaryAction}
        isMobile={isMobile}
      />
      {renderView()}
    </AssetsLayout>
  )
}
