'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AssetsLayout, type AssetsView } from '@/components/layout/AssetsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import type { SupabaseClient } from '@supabase/supabase-js'

// ─── DB Types ─────────────────────────────────────────────────────────────────

type Employee = { id: string; full_name: string; role: string; team: string }

type EmployeeAsset = {
  id: string
  user_id: string
  asset_type: string
  asset_name: string
  brand: string | null
  model: string | null
  serial_number: string | null
  specifications: string | null
  status: string
  assigned_location: string | null
  purchase_date: string | null
  last_service_date: string | null
  last_os_update_date: string | null
  last_formatted_date: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

// password_value is intentionally excluded from all selects
type EmployeeAccessDetail = {
  id: string
  user_id: string
  access_type: string
  login_label: string
  login_id: string
  recovery_info: string | null
  two_factor_enabled: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

type MaintenanceEvent = {
  id: string
  asset_id: string
  user_id: string
  event_type: string
  event_date: string
  notes: string | null
  created_at: string
}

type ActivityEntry = {
  id: string
  user_id: string
  actor_id: string
  action: string
  entity_type: string
  entity_id: string | null
  details: string | null
  created_at: string
}

type EmployeeSummary = {
  assetCount: number
  accessCount: number
  assetTypes: string[]   // DB values e.g. 'laptop_desktop'
  assetNames: string[]   // actual asset_name values, in insertion order
  lastUpdated: string | null
}

// ─── Display Mappings ─────────────────────────────────────────────────────────

const ASSET_TYPE_LABEL: Record<string, string> = {
  laptop_desktop: 'Laptop / Desktop',
  monitor:        'Extra Screen / Monitor',
  mouse_keyboard: 'Mouse & Keyboard',
  storage:        'Pen Drive / Ext. Storage',
  phone:          'Mobile Phone',
  other:          'Other Custom Asset',
}

const LABEL_TO_ASSET_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_TYPE_LABEL).map(([k, v]) => [v, k])
)

const STATUS_LABEL: Record<string, string> = {
  in_use:      'In Use',
  spare:       'Spare',
  repair:      'Under Repair',
  not_working: 'Not Working',
  returned:    'Returned',
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
  } catch {
    return '—'
  }
}

// ─── Shared UI helpers ────────────────────────────────────────────────────────

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

type PillStatus = 'added' | 'partial' | 'none' | 'inuse' | 'spare' | 'repair' | 'notworking' | 'returned'

function StatusPill({ status }: { status: PillStatus }) {
  const map: Record<PillStatus, { label: string; cls: string }> = {
    added:      { label: 'Added',              cls: 'boe-badge-completed' },
    partial:    { label: 'Partially Added',    cls: 'boe-badge-pending'   },
    none:       { label: 'No Inventory Added', cls: 'boe-badge-urgent'    },
    inuse:      { label: 'In Use',             cls: 'boe-badge-pending'   },
    spare:      { label: 'Spare',              cls: 'boe-badge-completed' },
    repair:     { label: 'Under Repair',       cls: 'boe-badge-urgent'    },
    notworking: { label: 'Not Working',        cls: 'boe-badge-urgent'    },
    returned:   { label: 'Returned',           cls: 'boe-badge-pending'   },
  }
  const { label, cls } = map[status] ?? map.none
  return <span className={`boe-badge ${cls}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>{label}</span>
}

function assetStatusPill(dbStatus: string): PillStatus {
  const map: Record<string, PillStatus> = {
    in_use: 'inuse', spare: 'spare', repair: 'repair',
    not_working: 'notworking', returned: 'returned',
  }
  return map[dbStatus] ?? 'inuse'
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 700, color: colors.muted,
      textTransform: 'uppercase', letterSpacing: '0.06em',
      marginBottom: '10px', marginTop: '4px',
    }}>{text}</div>
  )
}

function EmptyRow({ message = 'No data added yet.' }: { message?: string }) {
  return (
    <tr>
      <td colSpan={99} style={{ padding: '20px 16px', color: colors.muted, fontSize: '12px', textAlign: 'center' }}>
        {message}
      </td>
    </tr>
  )
}

function PlaceholderShell({ message }: { message: string }) {
  return (
    <div className="boe-card" style={{
      padding: '48px 24px', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
    }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary }}>{message}</div>
      <div style={{ fontSize: '12px', color: colors.muted }}>This section will be available soon.</div>
    </div>
  )
}

function PanelLoading() {
  return (
    <div style={{ padding: '32px 16px', textAlign: 'center', color: colors.muted, fontSize: '12px' }}>
      Loading…
    </div>
  )
}

// ─── Admin: Employee Overview ─────────────────────────────────────────────────

function EmployeeOverview({
  employees,
  summaries,
  onSelect,
}: {
  employees: Employee[]
  summaries: Record<string, EmployeeSummary>
  onSelect: (emp: Employee) => void
}) {
  return (
    <div className="boe-card" style={{ overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <TableHead cols={['Employee', 'Assets Assigned', 'Login Details Status', 'Last Updated', 'Action']} />
          <tbody>
            {employees.length === 0 && <EmptyRow message="No employees found." />}
            {employees.map(emp => {
              const s = summaries[emp.id]
              const loginStatus: PillStatus = s && s.accessCount > 0 ? 'added' : 'none'
              const lastUpdated = s?.lastUpdated ? fmtDate(s.lastUpdated) : '—'

              const assetCell = () => {
                const names = s?.assetNames ?? []
                const types = s?.assetTypes ?? []
                const count = s?.assetCount ?? 0
                if (count === 0) {
                  return <span style={{ fontSize: '12px', color: colors.muted }}>No assets added</span>
                }
                if (count === 1) {
                  return (
                    <div>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>{names[0] ?? '—'}</div>
                      <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '1px' }}>
                        {ASSET_TYPE_LABEL[types[0]] ?? types[0] ?? '—'}
                      </div>
                    </div>
                  )
                }
                return (
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>{count} Assets</div>
                    <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '1px' }}>
                      {types.map(t => ASSET_TYPE_LABEL[t] ?? t).join(', ')}
                    </div>
                  </div>
                )
              }

              return (
                <tr key={emp.id}
                  style={{ borderBottom: `1px solid ${colors.border}` }}
                  onMouseEnter={e => (e.currentTarget.style.background = colors.raised)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ fontWeight: 600, color: colors.primary }}>{emp.full_name}</div>
                    <div style={{ fontSize: '11px', color: colors.muted, textTransform: 'capitalize', marginTop: '1px' }}>
                      {emp.role} · {emp.team}
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {assetCell()}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {loginStatus === 'added'
                      ? <StatusPill status="added" />
                      : <span style={{ fontSize: '12px', color: colors.muted }}>Not Added</span>
                    }
                  </td>
                  <td style={{ padding: '12px 16px', color: colors.muted, fontSize: '12px' }}>
                    {lastUpdated}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <button
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '4px 10px', fontSize: '11px' }}
                      onClick={() => onSelect(emp)}
                    >
                      View
                    </button>
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

// ─── Admin: Employee Detail Panel ─────────────────────────────────────────────

function EmployeeDetailPanel({
  emp,
  onClose,
  supabase,
  onEditAsset,
}: {
  emp: Employee
  onClose: () => void
  supabase: SupabaseClient
  onEditAsset: (asset: EmployeeAsset) => void
}) {
  const [assets,        setAssets]        = useState<EmployeeAsset[]>([])
  const [accessDetails, setAccessDetails] = useState<EmployeeAccessDetail[]>([])
  const [maintenance,   setMaintenance]   = useState<MaintenanceEvent[]>([])
  const [activity,      setActivity]      = useState<ActivityEntry[]>([])
  const [loading,       setLoading]       = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)

      const [
        { data: a },
        { data: ac },
        { data: act },
      ] = await Promise.all([
        supabase
          .from('employee_assets')
          .select('id, user_id, asset_type, asset_name, brand, model, serial_number, specifications, status, assigned_location, purchase_date, last_service_date, last_os_update_date, last_formatted_date, notes, created_at, updated_at')
          .eq('user_id', emp.id)
          .order('created_at'),
        supabase
          .from('employee_access_details')
          .select('id, user_id, access_type, login_label, login_id, recovery_info, two_factor_enabled, notes, created_at, updated_at')
          .eq('user_id', emp.id)
          .order('access_type'),
        supabase
          .from('asset_activity_log')
          .select('id, user_id, actor_id, action, entity_type, entity_id, details, created_at')
          .eq('user_id', emp.id)
          .order('created_at', { ascending: false })
          .limit(20),
      ])

      if (cancelled) return

      const fetchedAssets = (a ?? []) as EmployeeAsset[]
      setAssets(fetchedAssets)
      setAccessDetails((ac ?? []) as EmployeeAccessDetail[])
      setActivity((act ?? []) as ActivityEntry[])

      if (fetchedAssets.length > 0) {
        const ids = fetchedAssets.map(x => x.id)
        const { data: maint } = await supabase
          .from('asset_maintenance_history')
          .select('id, asset_id, user_id, event_type, event_date, notes, created_at')
          .in('asset_id', ids)
          .order('event_date', { ascending: false })
        if (!cancelled) setMaintenance((maint ?? []) as MaintenanceEvent[])
      }

      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id])

  const assetById = useMemo(() => {
    const m: Record<string, EmployeeAsset> = {}
    assets.forEach(a => { m[a.id] = a })
    return m
  }, [assets])

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 49 }}
      />

      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: '400px',
        background: colors.base, borderLeft: `1px solid ${colors.border}`,
        zIndex: 50, display: 'flex', flexDirection: 'column', overflowY: 'auto',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
          position: 'sticky', top: 0, background: colors.base, zIndex: 1,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>{emp.full_name}</div>
            <div style={{ fontSize: '11px', color: colors.muted, textTransform: 'capitalize', marginTop: '1px' }}>
              {emp.role} · {emp.team}
            </div>
          </div>
          <button
            onClick={onClose}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '13px', lineHeight: 1 }}
          >✕</button>
        </div>

        {loading ? <PanelLoading /> : (
          <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '24px' }}>

            {/* Employee Information */}
            <section>
              <SectionLabel text="Employee Information" />
              <div className="boe-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {[
                  { label: 'Full Name', value: emp.full_name },
                  { label: 'Role',      value: emp.role,  cap: true },
                  { label: 'Team',      value: emp.team,  cap: true },
                ].map(({ label, value, cap }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                    <span style={{ fontSize: '11px', color: colors.muted, minWidth: 90 }}>{label}</span>
                    <span style={{ fontSize: '12px', color: colors.secondary, fontWeight: 500, textAlign: 'right', textTransform: cap ? 'capitalize' : 'none' }}>{value}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Assets Assigned */}
            <section>
              <SectionLabel text="Assets Assigned" />
              {assets.length === 0
                ? (
                  <div className="boe-card" style={{ padding: '20px', textAlign: 'center' }}>
                    <div style={{ fontSize: '12px', color: colors.muted }}>No inventory added for this employee.</div>
                  </div>
                )
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {assets.map(a => (
                      <div key={a.id} className="boe-card" style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>{a.asset_name}</div>
                            <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
                              {ASSET_TYPE_LABEL[a.asset_type] ?? a.asset_type}
                            </div>
                            {a.specifications && (
                              <div style={{ fontSize: '11px', color: colors.tertiary, marginTop: '3px' }}>{a.specifications}</div>
                            )}
                            {a.serial_number && (
                              <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '2px' }}>Serial: {a.serial_number}</div>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                            <StatusPill status={assetStatusPill(a.status)} />
                            <button
                              className="boe-btn boe-btn-ghost"
                              style={{ padding: '3px 8px', fontSize: '11px' }}
                              onClick={() => onEditAsset(a)}
                            >
                              Edit
                            </button>
                          </div>
                        </div>
                        {a.created_at && (
                          <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '8px' }}>
                            Added: {fmtDate(a.created_at)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )
              }
            </section>

            {/* Login Details */}
            <section>
              <SectionLabel text="Login Details" />
              {accessDetails.length === 0
                ? (
                  <div className="boe-card" style={{ padding: '20px', textAlign: 'center' }}>
                    <div style={{ fontSize: '12px', color: colors.muted }}>No login details added.</div>
                  </div>
                )
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {accessDetails.map(ac => (
                      <div key={ac.id} className="boe-card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>{ac.login_label}</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                          <span style={{ fontSize: '11px', color: colors.muted }}>Login ID</span>
                          <span style={{ fontSize: '11px', color: colors.secondary, fontFamily: 'monospace' }}>{ac.login_id}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                          <span style={{ fontSize: '11px', color: colors.muted }}>Password</span>
                          <span style={{ fontSize: '12px', color: colors.muted, letterSpacing: '0.12em' }}>••••••••</span>
                        </div>
                        {ac.two_factor_enabled && (
                          <div style={{ fontSize: '10.5px', color: colors.blue, marginTop: '2px' }}>2FA enabled</div>
                        )}
                      </div>
                    ))}
                  </div>
                )
              }
            </section>

            {/* Maintenance History */}
            <section>
              <SectionLabel text="Maintenance History" />
              {maintenance.length === 0
                ? (
                  <div className="boe-card" style={{ padding: '20px', textAlign: 'center' }}>
                    <div style={{ fontSize: '12px', color: colors.muted }}>No maintenance records.</div>
                  </div>
                )
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {maintenance.map(m => (
                      <div key={m.id} className="boe-card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>
                            {assetById[m.asset_id]?.asset_name ?? 'Unknown Asset'}
                          </div>
                          <span style={{ fontSize: '10px', color: colors.muted, textTransform: 'capitalize' }}>
                            {m.event_type.replace('_', ' ')}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                          <span style={{ fontSize: '11px', color: colors.muted }}>Date</span>
                          <span style={{ fontSize: '11px', color: colors.secondary }}>{fmtDate(m.event_date)}</span>
                        </div>
                        {m.notes && (
                          <div style={{ fontSize: '11px', color: colors.tertiary, marginTop: '4px', fontStyle: 'italic' }}>
                            {m.notes}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )
              }
            </section>

            {/* Recent Activity */}
            <section>
              <SectionLabel text="Recent Activity" />
              {activity.length === 0
                ? (
                  <div className="boe-card" style={{ padding: '20px', textAlign: 'center' }}>
                    <div style={{ fontSize: '12px', color: colors.muted }}>No recent activity.</div>
                  </div>
                )
                : (
                  <div className="boe-card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {activity.map((a, i) => (
                      <div key={a.id} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                        gap: '12px', paddingBottom: i < activity.length - 1 ? '8px' : 0,
                        borderBottom: i < activity.length - 1 ? `1px solid ${colors.border}` : 'none',
                      }}>
                        <div>
                          <div style={{ fontSize: '12px', color: colors.primary, fontWeight: 500, textTransform: 'capitalize' }}>
                            {a.action.replace(/_/g, ' ')}
                          </div>
                          <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '2px', textTransform: 'capitalize' }}>
                            {a.entity_type.replace(/_/g, ' ')}
                          </div>
                        </div>
                        <div style={{ fontSize: '10.5px', color: colors.muted, whiteSpace: 'nowrap' }}>
                          {fmtDate(a.created_at)}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              }
            </section>

          </div>
        )}
      </div>
    </>
  )
}

// ─── Admin: Asset Inventory ───────────────────────────────────────────────────

const INVENTORY_CATEGORIES = [
  { label: 'Laptop / Desktop',          dbType: 'laptop_desktop'  },
  { label: 'Extra Screen / Monitor',    dbType: 'monitor'         },
  { label: 'Mouse & Keyboard',          dbType: 'mouse_keyboard'  },
  { label: 'Pen Drive / Ext. Storage',  dbType: 'storage'         },
  { label: 'Mobile Phone',              dbType: 'phone'           },
  { label: 'Other Custom Asset',        dbType: 'other'           },
]

type CategoryStats = { total: number; inUse: number; spare: number; repair: number }

function AssetInventory({ supabase }: { supabase: SupabaseClient }) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [stats,  setStats]  = useState<Record<string, CategoryStats>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('employee_assets')
        .select('asset_type, status')

      const agg: Record<string, CategoryStats> = {}
      INVENTORY_CATEGORIES.forEach(c => {
        agg[c.dbType] = { total: 0, inUse: 0, spare: 0, repair: 0 }
      })

      ;(data ?? []).forEach((row: { asset_type: string; status: string }) => {
        const key = row.asset_type
        if (!agg[key]) agg[key] = { total: 0, inUse: 0, spare: 0, repair: 0 }
        agg[key].total++
        if (row.status === 'in_use')  agg[key].inUse++
        if (row.status === 'spare')   agg[key].spare++
        if (row.status === 'repair')  agg[key].repair++
      })

      setStats(agg)
      setLoading(false)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (selectedCategory !== null) {
    return (
      <CategoryDetail
        category={selectedCategory}
        supabase={supabase}
        onBack={() => setSelectedCategory(null)}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {INVENTORY_CATEGORIES.map(cat => {
        const s = stats[cat.dbType] ?? { total: 0, inUse: 0, spare: 0, repair: 0 }
        return (
          <div key={cat.dbType} className="boe-card" style={{ padding: '16px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, marginBottom: '10px' }}>{cat.label}</div>
                {loading
                  ? <div style={{ fontSize: '11px', color: colors.muted }}>Loading…</div>
                  : (
                    <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                      {[
                        { label: 'Total',         value: s.total  },
                        { label: 'In Use',        value: s.inUse  },
                        { label: 'Spare',         value: s.spare  },
                        { label: 'Under Repair',  value: s.repair },
                      ].map(({ label, value }) => (
                        <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span style={{ fontSize: '18px', fontWeight: 700, color: value > 0 ? colors.primary : colors.muted, lineHeight: 1 }}>
                            {value}
                          </span>
                          <span style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            {label}
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                }
              </div>
              <button
                className="boe-btn boe-btn-ghost"
                style={{ padding: '6px 14px', fontSize: '12px', flexShrink: 0 }}
                onClick={() => setSelectedCategory(cat.dbType)}
              >
                View Category
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Admin: Category Detail ───────────────────────────────────────────────────

type CategoryAssetRow = {
  id: string
  asset_name: string
  status: string
  updated_at: string
  users: { full_name: string } | null
}

function CategoryDetail({
  category,
  onBack,
  supabase,
}: {
  category: string
  onBack: () => void
  supabase: SupabaseClient
}) {
  const [rows,    setRows]    = useState<CategoryAssetRow[]>([])
  const [loading, setLoading] = useState(true)

  const displayLabel = ASSET_TYPE_LABEL[category] ?? category

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('employee_assets')
        .select('id, asset_name, status, updated_at, users!employee_assets_user_id_fkey(full_name)')
        .eq('asset_type', category)
        .order('updated_at', { ascending: false })

      setRows((data ?? []) as CategoryAssetRow[])
      setLoading(false)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <button
          className="boe-btn boe-btn-ghost"
          style={{ padding: '5px 12px', fontSize: '12px' }}
          onClick={onBack}
        >
          ← Back
        </button>
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{displayLabel}</div>
      </div>

      <div className="boe-card" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <TableHead cols={['Asset Name', 'Assigned To', 'Status', 'Last Updated']} />
            <tbody>
              {loading && (
                <tr><td colSpan={4} style={{ padding: '20px 16px', textAlign: 'center', color: colors.muted, fontSize: '12px' }}>Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && <EmptyRow message="No assets in this category yet." />}
              {!loading && rows.map(row => (
                <tr key={row.id}
                  style={{ borderBottom: `1px solid ${colors.border}` }}
                  onMouseEnter={e => (e.currentTarget.style.background = colors.raised)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: colors.primary }}>{row.asset_name}</td>
                  <td style={{ padding: '12px 16px', color: colors.secondary }}>{row.users?.full_name ?? '—'}</td>
                  <td style={{ padding: '12px 16px' }}><StatusPill status={assetStatusPill(row.status)} /></td>
                  <td style={{ padding: '12px 16px', color: colors.muted, fontSize: '12px' }}>{fmtDate(row.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── User: My Details ─────────────────────────────────────────────────────────

const MY_DETAIL_CARDS = [
  { key: 'personal',  label: 'Personal Info',     desc: 'Your name, team, role, and position on record.' },
  { key: 'contact',   label: 'Contact Details',   desc: 'Official email address and phone number.' },
  { key: 'emergency', label: 'Emergency Contact', desc: 'Contact person in case of emergency.' },
]

function MyDetails() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '680px' }}>
      {MY_DETAIL_CARDS.map(card => (
        <div key={card.key} className="boe-card" style={{
          padding: '16px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, marginBottom: '3px' }}>{card.label}</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginBottom: '6px' }}>{card.desc}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: colors.muted }} />
              <span style={{ fontSize: '11px', color: colors.muted }}>Not added yet</span>
            </div>
          </div>
          <button className="boe-btn boe-btn-ghost" style={{ padding: '6px 14px', fontSize: '12px', flexShrink: 0 }}>
            Add Details
          </button>
        </div>
      ))}
    </div>
  )
}

// ─── User: My Assets ─────────────────────────────────────────────────────────

const DEVICE_CATEGORIES = [
  { dbType: 'laptop_desktop',  label: 'Laptop / Desktop',             desc: 'Work laptop or desktop — brand, model, serial number, RAM/storage.' },
  { dbType: 'monitor',         label: 'Extra Screen / Monitor',       desc: 'Additional display assigned to you.' },
  { dbType: 'mouse_keyboard',  label: 'Mouse & Keyboard',             desc: 'Peripherals assigned to you.' },
  { dbType: 'storage',         label: 'Pen Drive / External Storage', desc: 'USB drives or external storage — capacity and serial.' },
  { dbType: 'phone',           label: 'Mobile Phone',                 desc: 'Company-issued phone — brand, model, serial.' },
  { dbType: 'other',           label: 'Other Custom Asset',           desc: 'Any other hardware or accessory assigned to you.' },
]

function MyAssets({ userId, supabase }: { userId: string; supabase: SupabaseClient }) {
  const [assets,  setAssets]  = useState<EmployeeAsset[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('employee_assets')
        .select('id, user_id, asset_type, asset_name, brand, model, serial_number, specifications, status, assigned_location, purchase_date, last_service_date, last_os_update_date, last_formatted_date, notes, created_at, updated_at')
        .eq('user_id', userId)
        .order('asset_type')
      setAssets((data ?? []) as EmployeeAsset[])
      setLoading(false)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  const assetsByType = useMemo(() => {
    const m: Record<string, EmployeeAsset[]> = {}
    assets.forEach(a => {
      if (!m[a.asset_type]) m[a.asset_type] = []
      m[a.asset_type].push(a)
    })
    return m
  }, [assets])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '680px' }}>
      <div style={{
        padding: '12px 16px', borderRadius: '8px',
        background: colors.blueTint, border: `1px solid ${colors.blue}30`,
        fontSize: '12px', color: colors.blue, marginBottom: '4px',
      }}>
        Register all company devices assigned to you. Each entry tracks device type, brand, model, serial number, and servicing history.
      </div>

      {loading && <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>}

      {!loading && DEVICE_CATEGORIES.map(cat => {
        const catAssets = assetsByType[cat.dbType] ?? []
        return (
          <div key={cat.dbType} className="boe-card" style={{ padding: '16px 20px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, marginBottom: '3px' }}>{cat.label}</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginBottom: '8px' }}>{cat.desc}</div>
            {catAssets.length === 0
              ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: colors.muted }} />
                  <span style={{ fontSize: '11px', color: colors.muted }}>No device added</span>
                </div>
              )
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {catAssets.map(a => (
                    <div key={a.id} style={{
                      background: colors.raised, borderRadius: '6px', padding: '10px 12px',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px',
                    }}>
                      <div>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>{a.asset_name}</div>
                        {a.specifications && <div style={{ fontSize: '11px', color: colors.tertiary, marginTop: '2px' }}>{a.specifications}</div>}
                        {a.serial_number  && <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '2px' }}>Serial: {a.serial_number}</div>}
                      </div>
                      <StatusPill status={assetStatusPill(a.status)} />
                    </div>
                  ))}
                </div>
              )
            }
          </div>
        )
      })}
    </div>
  )
}

// ─── User: Login Details ─────────────────────────────────────────────────────

function LoginDetails({ userId, supabase }: { userId: string; supabase: SupabaseClient }) {
  const [details,  setDetails]  = useState<EmployeeAccessDetail[]>([])
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('employee_access_details')
        .select('id, user_id, access_type, login_label, login_id, recovery_info, two_factor_enabled, notes, created_at, updated_at')
        .eq('user_id', userId)
        .order('access_type')
      setDetails((data ?? []) as EmployeeAccessDetail[])
      setLoading(false)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  const ACCESS_TYPE_GROUPS = [
    { key: 'gmail',        label: 'Gmail',         desc: 'Official Google Workspace email account.' },
    { key: 'clickup',      label: 'ClickUp',       desc: 'Project and task management platform.' },
    { key: 'system_login', label: 'System Login',  desc: 'Computer / OS login credentials.' },
    { key: 'other',        label: 'Other Systems', desc: 'Any other official platform login.' },
  ]

  const byType = useMemo(() => {
    const m: Record<string, EmployeeAccessDetail[]> = {}
    details.forEach(d => {
      if (!m[d.access_type]) m[d.access_type] = []
      m[d.access_type].push(d)
    })
    return m
  }, [details])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '680px' }}>
      {loading && <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>}
      {!loading && ACCESS_TYPE_GROUPS.map(group => {
        const groupItems = byType[group.key] ?? []
        return (
          <div key={group.key} className="boe-card" style={{ padding: '16px 20px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, marginBottom: '3px' }}>{group.label}</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginBottom: '8px' }}>{group.desc}</div>
            {groupItems.length === 0
              ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: colors.muted }} />
                  <span style={{ fontSize: '11px', color: colors.muted }}>Not added yet</span>
                </div>
              )
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {groupItems.map(d => (
                    <div key={d.id} style={{
                      background: colors.raised, borderRadius: '6px', padding: '10px 12px',
                      display: 'flex', flexDirection: 'column', gap: '5px',
                    }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>{d.login_label}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                        <span style={{ fontSize: '11px', color: colors.muted }}>Login ID</span>
                        <span style={{ fontSize: '11px', color: colors.secondary, fontFamily: 'monospace' }}>{d.login_id}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                        <span style={{ fontSize: '11px', color: colors.muted }}>Password</span>
                        <span style={{ fontSize: '12px', color: colors.muted, letterSpacing: '0.12em' }}>••••••••</span>
                      </div>
                      {d.two_factor_enabled && (
                        <div style={{ fontSize: '10.5px', color: colors.blue }}>2FA enabled</div>
                      )}
                    </div>
                  ))}
                </div>
              )
            }
          </div>
        )
      })}
    </div>
  )
}

// ─── User: Maintenance History ────────────────────────────────────────────────

function UserMaintenanceHistory({ userId, supabase }: { userId: string; supabase: SupabaseClient }) {
  const [records,  setRecords]  = useState<(MaintenanceEvent & { asset_name: string })[]>([])
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    const load = async () => {
      const { data: assets } = await supabase
        .from('employee_assets')
        .select('id, asset_name')
        .eq('user_id', userId)

      if (!assets || assets.length === 0) {
        setLoading(false)
        return
      }

      const ids = (assets as { id: string; asset_name: string }[]).map(a => a.id)
      const nameById: Record<string, string> = {}
      ;(assets as { id: string; asset_name: string }[]).forEach(a => { nameById[a.id] = a.asset_name })

      const { data: maint } = await supabase
        .from('asset_maintenance_history')
        .select('id, asset_id, user_id, event_type, event_date, notes, created_at')
        .in('asset_id', ids)
        .order('event_date', { ascending: false })

      setRecords(
        ((maint ?? []) as MaintenanceEvent[]).map(m => ({
          ...m,
          asset_name: nameById[m.asset_id] ?? 'Unknown Asset',
        }))
      )
      setLoading(false)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  if (loading) return <div style={{ fontSize: '12px', color: colors.muted, padding: '8px 0' }}>Loading…</div>

  if (records.length === 0) {
    return (
      <div className="boe-card" style={{ padding: '32px', textAlign: 'center' }}>
        <div style={{ fontSize: '12px', color: colors.muted }}>No maintenance records yet.</div>
      </div>
    )
  }

  return (
    <div className="boe-card" style={{ overflow: 'hidden', maxWidth: '680px' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <TableHead cols={['Device', 'Event', 'Date', 'Notes']} />
          <tbody>
            {records.map(r => (
              <tr key={r.id}
                style={{ borderBottom: `1px solid ${colors.border}` }}
                onMouseEnter={e => (e.currentTarget.style.background = colors.raised)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '12px 16px', fontWeight: 600, color: colors.primary }}>{r.asset_name}</td>
                <td style={{ padding: '12px 16px', color: colors.secondary, textTransform: 'capitalize' }}>
                  {r.event_type.replace(/_/g, ' ')}
                </td>
                <td style={{ padding: '12px 16px', color: colors.muted, fontSize: '12px' }}>{fmtDate(r.event_date)}</td>
                <td style={{ padding: '12px 16px', color: colors.tertiary, fontSize: '12px' }}>{r.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Add Asset Modal ──────────────────────────────────────────────────────────

const ASSET_TYPE_OPTIONS = Object.entries(ASSET_TYPE_LABEL).map(([value, label]) => ({ value, label }))
const STATUS_OPTIONS     = Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))

type AddAssetForm = {
  user_id:       string
  asset_type:    string
  asset_name:    string
  serial_number: string
  status:        string
  purchase_date: string
  notes:         string
}

const EMPTY_FORM: AddAssetForm = {
  user_id:       '',
  asset_type:    'laptop_desktop',
  asset_name:    '',
  serial_number: '',
  status:        'in_use',
  purchase_date: '',
  notes:         '',
}

// ─── Edit Asset Modal ─────────────────────────────────────────────────────────

type EditAssetForm = {
  asset_type:    string
  asset_name:    string
  brand:         string
  model:         string
  serial_number: string
  status:        string
  purchase_date: string
  notes:         string
}

function EditAssetModal({
  asset,
  supabase,
  onClose,
  onSaved,
}: {
  asset:    EmployeeAsset
  supabase: SupabaseClient
  onClose:  () => void
  onSaved:  () => void
}) {
  const [form,   setForm]   = useState<EditAssetForm>({
    asset_type:    asset.asset_type,
    asset_name:    asset.asset_name,
    brand:         asset.brand         ?? '',
    model:         asset.model         ?? '',
    serial_number: asset.serial_number ?? '',
    status:        asset.status,
    purchase_date: asset.purchase_date ?? '',
    notes:         asset.notes         ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  const set = (k: keyof EditAssetForm, v: string) =>
    setForm(prev => ({ ...prev, [k]: v }))

  const handleSave = async () => {
    if (!form.asset_name.trim()) {
      setError('Asset Name is required.')
      return
    }
    setSaving(true)
    setError(null)

    const { data: updated, error: dbError } = await supabase
      .from('employee_assets')
      .update({
        asset_type:    form.asset_type,
        asset_name:    form.asset_name.trim(),
        brand:         form.brand.trim()         || null,
        model:         form.model.trim()         || null,
        serial_number: form.serial_number.trim() || null,
        status:        form.status,
        purchase_date: form.purchase_date        || null,
        notes:         form.notes.trim()         || null,
      })
      .eq('id', asset.id)
      .select('id')

    if (dbError) {
      setError(dbError.message)
      setSaving(false)
      return
    }

    if (!updated || updated.length === 0) {
      setError('Update was blocked — admin update permission may be missing. Run the SQL migration in Supabase and retry.')
      setSaving(false)
      return
    }

    onSaved()
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    padding: '8px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.raised, color: colors.primary,
    fontSize: '13px', outline: 'none',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
    marginBottom: '4px', display: 'block',
  }
  const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column' }

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 69 }}
      />
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '480px', maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
        background: colors.base, borderRadius: '12px',
        border: `1px solid ${colors.border}`,
        zIndex: 70, padding: '24px',
        display: 'flex', flexDirection: 'column', gap: '18px',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Edit Asset</div>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '13px' }}>✕</button>
        </div>

        {/* Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* Asset Name — shown first: it's the primary identifier */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Asset Name</label>
            <input
              type="text"
              placeholder="e.g. Dell XPS 15 9500, MX Master 3, iPhone 14 Pro"
              value={form.asset_name}
              onChange={e => set('asset_name', e.target.value)}
              style={inputStyle}
            />
            <span style={{ fontSize: '11px', color: colors.muted, marginTop: '4px' }}>
              The specific device name — not the category. E.g. &quot;HP EliteBook 840&quot;, not &quot;Laptop&quot;.
            </span>
          </div>

          {/* Asset Type */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Asset Type <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(category)</span></label>
            <select value={form.asset_type} onChange={e => set('asset_type', e.target.value)} style={inputStyle}>
              {ASSET_TYPE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Brand */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Brand</label>
            <input
              type="text"
              placeholder="e.g. Dell, Apple, Logitech"
              value={form.brand}
              onChange={e => set('brand', e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Model */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Model</label>
            <input
              type="text"
              placeholder="e.g. XPS 15, MacBook Pro M3"
              value={form.model}
              onChange={e => set('model', e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Asset Tag / Serial Number */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Asset Tag / Serial Number</label>
            <input
              type="text"
              placeholder="Serial number or asset tag"
              value={form.serial_number}
              onChange={e => set('serial_number', e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Status */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Status</label>
            <select value={form.status} onChange={e => set('status', e.target.value)} style={inputStyle}>
              {STATUS_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Assigned Date */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Assigned Date</label>
            <input
              type="date"
              value={form.purchase_date}
              onChange={e => set('purchase_date', e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Notes */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Notes / Remarks</label>
            <textarea
              placeholder="Optional notes or remarks"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
        </div>

        {error && (
          <div style={{ fontSize: '12px', color: '#e05353', padding: '8px 12px', background: '#e0535314', borderRadius: '6px' }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="boe-btn boe-btn-primary"
            style={{ padding: '8px 18px', fontSize: '13px' }}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </>
  )
}

function AddAssetModal({
  employees,
  supabase,
  onClose,
  onSaved,
}: {
  employees: Employee[]
  supabase:  SupabaseClient
  onClose:   () => void
  onSaved:   () => void
}) {
  const [form,    setForm]    = useState<AddAssetForm>({ ...EMPTY_FORM, user_id: employees[0]?.id ?? '' })
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const set = (k: keyof AddAssetForm, v: string) =>
    setForm(prev => ({ ...prev, [k]: v }))

  const handleSave = async () => {
    if (!form.user_id || !form.asset_name.trim()) {
      setError('Employee and Asset Name are required.')
      return
    }
    setSaving(true)
    setError(null)

    const { error: dbError } = await supabase.from('employee_assets').insert({
      user_id:       form.user_id,
      asset_type:    form.asset_type,
      asset_name:    form.asset_name.trim(),
      serial_number: form.serial_number.trim() || null,
      status:        form.status,
      purchase_date: form.purchase_date || null,
      notes:         form.notes.trim() || null,
    })

    if (dbError) {
      setError(dbError.message)
      setSaving(false)
      return
    }

    onSaved()
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    padding: '8px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.raised, color: colors.primary,
    fontSize: '13px', outline: 'none',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
    marginBottom: '4px', display: 'block',
  }
  const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column' }

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 59 }}
      />
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '480px', maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
        background: colors.base, borderRadius: '12px',
        border: `1px solid ${colors.border}`,
        zIndex: 60, padding: '24px',
        display: 'flex', flexDirection: 'column', gap: '18px',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Add Asset</div>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '13px' }}>✕</button>
        </div>

        {/* Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* Employee */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Employee</label>
            <select value={form.user_id} onChange={e => set('user_id', e.target.value)} style={inputStyle}>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>{emp.full_name} — {emp.role}</option>
              ))}
            </select>
          </div>

          {/* Asset Type */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Asset Type</label>
            <select value={form.asset_type} onChange={e => set('asset_type', e.target.value)} style={inputStyle}>
              {ASSET_TYPE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Asset Name */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Asset Name</label>
            <input
              type="text"
              placeholder="e.g. Dell XPS 15, Logitech MX Keys"
              value={form.asset_name}
              onChange={e => set('asset_name', e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Asset Tag / ID */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Asset Tag / ID</label>
            <input
              type="text"
              placeholder="Serial number or asset tag"
              value={form.serial_number}
              onChange={e => set('serial_number', e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Status */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Status</label>
            <select value={form.status} onChange={e => set('status', e.target.value)} style={inputStyle}>
              {STATUS_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Assigned Date */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Assigned Date</label>
            <input
              type="date"
              value={form.purchase_date}
              onChange={e => set('purchase_date', e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Notes */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Notes / Remarks</label>
            <textarea
              placeholder="Optional notes or remarks"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
        </div>

        {error && (
          <div style={{ fontSize: '12px', color: '#e05353', padding: '8px 12px', background: '#e0535314', borderRadius: '6px' }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="boe-btn boe-btn-primary"
            style={{ padding: '8px 18px', fontSize: '13px' }}
          >
            {saving ? 'Saving…' : 'Save Asset'}
          </button>
        </div>
      </div>
    </>
  )
}

// ─── Add Login Modal ──────────────────────────────────────────────────────────

const ACCESS_TYPE_OPTIONS = [
  { value: 'gmail',        label: 'Gmail' },
  { value: 'clickup',      label: 'ClickUp' },
  { value: 'system_login', label: 'System Login' },
  { value: 'other',        label: 'Other' },
]

type AddLoginForm = {
  user_id:            string
  access_type:        string
  login_label:        string
  login_id:           string
  password_value:     string
  two_factor_enabled: boolean
  recovery_info:      string
  notes:              string
}

const EMPTY_LOGIN_FORM: AddLoginForm = {
  user_id:            '',
  access_type:        'gmail',
  login_label:        '',
  login_id:           '',
  password_value:     '',
  two_factor_enabled: false,
  recovery_info:      '',
  notes:              '',
}

function AddLoginModal({
  employees,
  supabase,
  onClose,
  onSaved,
}: {
  employees: Employee[]
  supabase:  SupabaseClient
  onClose:   () => void
  onSaved:   () => void
}) {
  const [form,   setForm]   = useState<AddLoginForm>({ ...EMPTY_LOGIN_FORM, user_id: employees[0]?.id ?? '' })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  const set = <K extends keyof AddLoginForm>(k: K, v: AddLoginForm[K]) =>
    setForm(prev => ({ ...prev, [k]: v }))

  const handleSave = async () => {
    if (!form.user_id || !form.login_label.trim() || !form.login_id.trim()) {
      setError('Employee, Login Label, and Login ID are required.')
      return
    }
    setSaving(true)
    setError(null)

    const { error: dbError } = await supabase.from('employee_access_details').insert({
      user_id:            form.user_id,
      access_type:        form.access_type,
      login_label:        form.login_label.trim(),
      login_id:           form.login_id.trim(),
      password_value:     form.password_value || null,
      two_factor_enabled: form.two_factor_enabled,
      recovery_info:      form.recovery_info.trim() || null,
      notes:              form.notes.trim() || null,
    })

    if (dbError) {
      setError(dbError.message)
      setSaving(false)
      return
    }

    onSaved()
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    padding: '8px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.raised, color: colors.primary,
    fontSize: '13px', outline: 'none',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
    marginBottom: '4px', display: 'block',
  }
  const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column' }

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 59 }}
      />
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '480px', maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
        background: colors.base, borderRadius: '12px',
        border: `1px solid ${colors.border}`,
        zIndex: 60, padding: '24px',
        display: 'flex', flexDirection: 'column', gap: '18px',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Add Login Detail</div>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '13px' }}>✕</button>
        </div>

        {/* Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* Employee */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Employee</label>
            <select value={form.user_id} onChange={e => set('user_id', e.target.value)} style={inputStyle}>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>{emp.full_name} — {emp.role}</option>
              ))}
            </select>
          </div>

          {/* Access Type */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Access Type</label>
            <select value={form.access_type} onChange={e => set('access_type', e.target.value)} style={inputStyle}>
              {ACCESS_TYPE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Login Label */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Login Label</label>
            <input
              type="text"
              placeholder="e.g. Work Gmail, Windows Login"
              value={form.login_label}
              onChange={e => set('login_label', e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Login ID */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Login ID</label>
            <input
              type="text"
              placeholder="Email address or username"
              value={form.login_id}
              onChange={e => set('login_id', e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Password — input type="password" so browser never renders it as plain text */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Password</label>
            <input
              type="password"
              placeholder="••••••••"
              value={form.password_value}
              onChange={e => set('password_value', e.target.value)}
              autoComplete="new-password"
              style={inputStyle}
            />
          </div>

          {/* Two Factor Enabled */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input
              type="checkbox"
              id="tfa-check"
              checked={form.two_factor_enabled}
              onChange={e => set('two_factor_enabled', e.target.checked)}
              style={{ width: '15px', height: '15px', cursor: 'pointer', accentColor: colors.blue }}
            />
            <label htmlFor="tfa-check" style={{ fontSize: '13px', color: colors.secondary, cursor: 'pointer' }}>
              Two-factor authentication enabled
            </label>
          </div>

          {/* Recovery Info */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Recovery Info</label>
            <input
              type="text"
              placeholder="Recovery email, phone, or backup code hint"
              value={form.recovery_info}
              onChange={e => set('recovery_info', e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Notes */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Notes / Remarks</label>
            <textarea
              placeholder="Optional notes"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
        </div>

        {error && (
          <div style={{ fontSize: '12px', color: '#e05353', padding: '8px 12px', background: '#e0535314', borderRadius: '6px' }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="boe-btn boe-btn-primary"
            style={{ padding: '8px 18px', fontSize: '13px' }}
          >
            {saving ? 'Saving…' : 'Save Login'}
          </button>
        </div>
      </div>
    </>
  )
}

// ─── View meta ────────────────────────────────────────────────────────────────

const VIEW_META: Record<AssetsView, { title: string; subtitle: string }> = {
  'my-details':          { title: 'My Details',          subtitle: 'Your personal info and contact details on record.' },
  'my-assets':           { title: 'My Assets',           subtitle: 'Company devices assigned to you.' },
  'login-details':       { title: 'Login Details',       subtitle: 'Your official system login credentials.' },
  'maintenance-history': { title: 'Maintenance History', subtitle: 'Servicing, OS updates, and formatting records for your devices.' },
  'employee-overview':   { title: 'Employee Overview',   subtitle: 'All employees — click View to see their full inventory and access details.' },
  'asset-inventory':     { title: 'Asset Inventory',     subtitle: 'All company assets grouped by category.' },
  'access-register':     { title: 'Access Register',     subtitle: 'All employee system logins and access records.' },
  'activity-log':        { title: 'Activity Log',        subtitle: 'All changes and updates across the Assets & Access module.' },
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AssetsAccessPage() {
  const [profile,          setProfile]          = useState<UserProfile | null>(null)
  const [employees,        setEmployees]        = useState<Employee[]>([])
  const [empSummaries,     setEmpSummaries]     = useState<Record<string, EmployeeSummary>>({})
  const [loading,          setLoading]          = useState(true)
  const [view,             setView]             = useState<AssetsView | null>(null)
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null)
  const [showAddAsset,     setShowAddAsset]     = useState(false)
  const [showAddLogin,     setShowAddLogin]     = useState(false)
  const [editingAsset,     setEditingAsset]     = useState<EmployeeAsset | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

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

      const fetchedEmployees = (empData ?? []) as Employee[]
      setEmployees(fetchedEmployees)

      // Batch-load summary data for Employee Overview (admin only)
      if (prof.role === 'admin' && fetchedEmployees.length > 0) {
        const [{ data: allAssets }, { data: allAccess }] = await Promise.all([
          supabase
            .from('employee_assets')
            .select('user_id, asset_type, asset_name, status, updated_at'),
          supabase
            .from('employee_access_details')
            .select('user_id, access_type, updated_at'),
        ])

        const summaries: Record<string, EmployeeSummary> = {}

        ;(allAssets ?? []).forEach((row: { user_id: string; asset_type: string; asset_name: string; status: string; updated_at: string }) => {
          if (!summaries[row.user_id]) summaries[row.user_id] = { assetCount: 0, accessCount: 0, assetTypes: [], assetNames: [], lastUpdated: null }
          const s = summaries[row.user_id]
          s.assetCount++
          s.assetNames.push(row.asset_name)
          if (!s.assetTypes.includes(row.asset_type)) s.assetTypes.push(row.asset_type)
          if (!s.lastUpdated || row.updated_at > s.lastUpdated) s.lastUpdated = row.updated_at
        })

        ;(allAccess ?? []).forEach((row: { user_id: string; access_type: string; updated_at: string }) => {
          if (!summaries[row.user_id]) summaries[row.user_id] = { assetCount: 0, accessCount: 0, assetTypes: [], assetNames: [], lastUpdated: null }
          const s = summaries[row.user_id]
          s.accessCount++
          if (!s.lastUpdated || row.updated_at > s.lastUpdated) s.lastUpdated = row.updated_at
        })

        setEmpSummaries(summaries)
      }

      setView(prof.role === 'admin' ? 'employee-overview' : 'my-details')
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshSummaries = async () => {
    if (!profile || employees.length === 0) return
    const [{ data: allAssets }, { data: allAccess }] = await Promise.all([
      supabase.from('employee_assets').select('user_id, asset_type, asset_name, status, updated_at'),
      supabase.from('employee_access_details').select('user_id, access_type, updated_at'),
    ])
    const summaries: Record<string, EmployeeSummary> = {}
    ;(allAssets ?? []).forEach((row: { user_id: string; asset_type: string; asset_name: string; status: string; updated_at: string }) => {
      if (!summaries[row.user_id]) summaries[row.user_id] = { assetCount: 0, accessCount: 0, assetTypes: [], assetNames: [], lastUpdated: null }
      const s = summaries[row.user_id]
      s.assetCount++
      s.assetNames.push(row.asset_name)
      if (!s.assetTypes.includes(row.asset_type)) s.assetTypes.push(row.asset_type)
      if (!s.lastUpdated || row.updated_at > s.lastUpdated) s.lastUpdated = row.updated_at
    })
    ;(allAccess ?? []).forEach((row: { user_id: string; access_type: string; updated_at: string }) => {
      if (!summaries[row.user_id]) summaries[row.user_id] = { assetCount: 0, accessCount: 0, assetTypes: [], assetNames: [], lastUpdated: null }
      const s = summaries[row.user_id]
      s.accessCount++
      if (!s.lastUpdated || row.updated_at > s.lastUpdated) s.lastUpdated = row.updated_at
    })
    setEmpSummaries(summaries)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleViewChange = (v: AssetsView) => {
    setSelectedEmployee(null)
    setView(v)
  }

  if (loading || !view || !profile) return <LoadingScreen />

  const meta = VIEW_META[view]

  const renderView = () => {
    switch (view) {
      case 'employee-overview':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                className="boe-btn boe-btn-ghost"
                style={{ padding: '8px 18px', fontSize: '13px' }}
                onClick={() => setShowAddLogin(true)}
              >
                + Add Login
              </button>
              <button
                className="boe-btn boe-btn-primary"
                style={{ padding: '8px 18px', fontSize: '13px' }}
                onClick={() => setShowAddAsset(true)}
              >
                + Add Asset
              </button>
            </div>
            <EmployeeOverview
              employees={employees}
              summaries={empSummaries}
              onSelect={setSelectedEmployee}
            />
          </div>
        )
      case 'asset-inventory':
        return <AssetInventory supabase={supabase} />
      case 'access-register':
        return <PlaceholderShell message="Access Register" />
      case 'activity-log':
        return <PlaceholderShell message="Activity Log" />
      case 'my-details':
        return <MyDetails />
      case 'my-assets':
        return <MyAssets userId={profile.id} supabase={supabase} />
      case 'login-details':
        return <LoginDetails userId={profile.id} supabase={supabase} />
      case 'maintenance-history':
        return <UserMaintenanceHistory userId={profile.id} supabase={supabase} />
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
    >
      {renderView()}

      {selectedEmployee && (
        <EmployeeDetailPanel
          emp={selectedEmployee}
          onClose={() => setSelectedEmployee(null)}
          supabase={supabase}
          onEditAsset={setEditingAsset}
        />
      )}

      {showAddAsset && (
        <AddAssetModal
          employees={employees}
          supabase={supabase}
          onClose={() => setShowAddAsset(false)}
          onSaved={() => {
            setShowAddAsset(false)
            refreshSummaries()
            if (selectedEmployee) {
              const emp = selectedEmployee
              setSelectedEmployee(null)
              setTimeout(() => setSelectedEmployee(emp), 50)
            }
          }}
        />
      )}

      {editingAsset && (
        <EditAssetModal
          asset={editingAsset}
          supabase={supabase}
          onClose={() => setEditingAsset(null)}
          onSaved={() => {
            setEditingAsset(null)
            refreshSummaries()
            if (selectedEmployee) {
              const emp = selectedEmployee
              setSelectedEmployee(null)
              setTimeout(() => setSelectedEmployee(emp), 50)
            }
          }}
        />
      )}

      {showAddLogin && (
        <AddLoginModal
          employees={employees}
          supabase={supabase}
          onClose={() => setShowAddLogin(false)}
          onSaved={() => {
            setShowAddLogin(false)
            refreshSummaries()
            if (selectedEmployee) {
              const emp = selectedEmployee
              setSelectedEmployee(null)
              setTimeout(() => setSelectedEmployee(emp), 50)
            }
          }}
        />
      )}
    </AssetsLayout>
  )
}
