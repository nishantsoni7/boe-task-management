'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AssetsLayout, type AssetsView } from '@/components/layout/AssetsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'

// ─── Types ────────────────────────────────────────────────────────────────────

type Employee = { id: string; full_name: string; role: string; team: string }

// ─── Frontend-only demo data for Nishant ─────────────────────────────────────

const TODAY = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

const NISHANT_DEMO = {
  assets: [
    {
      category: 'Laptop / Desktop',
      name: 'Dell Latitude 5520',
      status: 'In Use',
      serial: 'DL-2024-001',
      specs: '16 GB RAM · 512 GB SSD',
      assignedOn: '01 Jan 2025',
    },
    {
      category: 'Mobile Phone',
      name: 'Samsung Galaxy A54',
      status: 'In Use',
      serial: 'SG-2024-001',
      specs: '6 GB RAM · 128 GB Storage',
      assignedOn: '15 Mar 2025',
    },
  ],
  logins: [
    { platform: 'Gmail',   loginId: 'nishant@bestofexports.com' },
    { platform: 'ClickUp', loginId: 'nishant.boe' },
  ],
  maintenance: [
    {
      device: 'Dell Latitude 5520',
      lastService:   '15 Mar 2026',
      lastOSUpdate:  '01 Jun 2026',
      lastFormatted: '10 Jan 2026',
      notes: 'Battery replaced during last service.',
    },
  ],
  activity: [
    { action: 'Device details updated', section: 'Laptop / Desktop', date: TODAY },
    { action: 'Gmail login added',       section: 'Login Details',    date: TODAY },
  ],
}

// Inventory-view category assets (Nishant demo rows only)
const CATEGORY_ASSETS: Record<string, { name: string; assignedTo: string; status: string; lastUpdated: string }[]> = {
  'Laptop / Desktop': [
    { name: 'Dell Latitude 5520', assignedTo: 'Nishant Soni', status: 'In Use', lastUpdated: TODAY },
  ],
  'Mobile Phone': [
    { name: 'Samsung Galaxy A54', assignedTo: 'Nishant Soni', status: 'In Use', lastUpdated: TODAY },
  ],
}

const CATEGORY_STATS: Record<string, { total: number; inUse: number; spare: number; needsUpdate: number }> = {
  'Laptop / Desktop':          { total: 1, inUse: 1, spare: 0, needsUpdate: 0 },
  'Extra Screen / Monitor':    { total: 0, inUse: 0, spare: 0, needsUpdate: 0 },
  'Mouse & Keyboard':          { total: 0, inUse: 0, spare: 0, needsUpdate: 0 },
  'Pen Drive / Ext. Storage':  { total: 0, inUse: 0, spare: 0, needsUpdate: 0 },
  'Mobile Phone':              { total: 1, inUse: 1, spare: 0, needsUpdate: 0 },
  'Other Custom Asset':        { total: 0, inUse: 0, spare: 0, needsUpdate: 0 },
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

function StatusPill({ status }: { status: 'added' | 'partial' | 'none' | 'inuse' }) {
  const map = {
    added:   { label: 'Added',              cls: 'boe-badge-completed' },
    partial: { label: 'Partially Added',    cls: 'boe-badge-pending'   },
    none:    { label: 'No Inventory Added', cls: 'boe-badge-urgent'    },
    inuse:   { label: 'In Use',             cls: 'boe-badge-pending'   },
  }
  const { label, cls } = map[status]
  return <span className={`boe-badge ${cls}`} style={{ fontSize: '10px', whiteSpace: 'nowrap' }}>{label}</span>
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

// ─── Admin: Employee Overview ─────────────────────────────────────────────────

function EmployeeOverview({
  employees,
  onSelect,
}: {
  employees: Employee[]
  onSelect: (emp: Employee) => void
}) {
  return (
    <div className="boe-card" style={{ overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <TableHead cols={['Employee', 'Inventory Status', 'Device Summary', 'Login Details Status', 'Last Updated', 'Action']} />
          <tbody>
            {employees.length === 0 && <EmptyRow message="No employees found." />}
            {employees.map(emp => {
              const isDemo = emp.full_name.toLowerCase().includes('nishant')
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
                    <StatusPill status={isDemo ? 'added' : 'none'} />
                  </td>
                  <td style={{ padding: '12px 16px', color: colors.secondary, fontSize: '12px' }}>
                    {isDemo ? 'Laptop / Desktop + Phone' : '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {isDemo
                      ? <StatusPill status="partial" />
                      : <span style={{ fontSize: '12px', color: colors.muted }}>Not Added</span>
                    }
                  </td>
                  <td style={{ padding: '12px 16px', color: colors.muted, fontSize: '12px' }}>
                    {isDemo ? TODAY : '—'}
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
}: {
  emp: Employee
  onClose: () => void
}) {
  const isDemo = emp.full_name.toLowerCase().includes('nishant')
  const demo   = NISHANT_DEMO

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 49,
        }}
      />

      {/* Panel */}
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
            {!isDemo
              ? (
                <div className="boe-card" style={{ padding: '20px', textAlign: 'center' }}>
                  <div style={{ fontSize: '12px', color: colors.muted }}>No inventory added for this employee.</div>
                </div>
              )
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {demo.assets.map((a, i) => (
                    <div key={i} className="boe-card" style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                        <div>
                          <div style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>{a.name}</div>
                          <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>{a.category}</div>
                          <div style={{ fontSize: '11px', color: colors.tertiary, marginTop: '3px' }}>{a.specs}</div>
                          <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '2px' }}>Serial: {a.serial}</div>
                        </div>
                        <StatusPill status="inuse" />
                      </div>
                      <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '8px' }}>
                        Assigned: {a.assignedOn}
                      </div>
                    </div>
                  ))}
                </div>
              )
            }
          </section>

          {/* Login Details */}
          <section>
            <SectionLabel text="Login Details" />
            {!isDemo
              ? (
                <div className="boe-card" style={{ padding: '20px', textAlign: 'center' }}>
                  <div style={{ fontSize: '12px', color: colors.muted }}>No login details added.</div>
                </div>
              )
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {demo.logins.map((l, i) => (
                    <div key={i} className="boe-card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>{l.platform}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                        <span style={{ fontSize: '11px', color: colors.muted }}>Login ID</span>
                        <span style={{ fontSize: '11px', color: colors.secondary, fontFamily: 'monospace' }}>{l.loginId}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                        <span style={{ fontSize: '11px', color: colors.muted }}>Password</span>
                        <span style={{ fontSize: '12px', color: colors.muted, letterSpacing: '0.12em' }}>••••••••</span>
                      </div>
                    </div>
                  ))}
                </div>
              )
            }
          </section>

          {/* Maintenance History */}
          <section>
            <SectionLabel text="Maintenance History" />
            {!isDemo
              ? (
                <div className="boe-card" style={{ padding: '20px', textAlign: 'center' }}>
                  <div style={{ fontSize: '12px', color: colors.muted }}>No maintenance records.</div>
                </div>
              )
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {demo.maintenance.map((m, i) => (
                    <div key={i} className="boe-card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, marginBottom: '2px' }}>{m.device}</div>
                      {[
                        { label: 'Last Serviced',  value: m.lastService   },
                        { label: 'Last OS Update', value: m.lastOSUpdate  },
                        { label: 'Last Formatted', value: m.lastFormatted },
                      ].map(({ label, value }) => (
                        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                          <span style={{ fontSize: '11px', color: colors.muted }}>{label}</span>
                          <span style={{ fontSize: '11px', color: colors.secondary }}>{value}</span>
                        </div>
                      ))}
                      {m.notes && (
                        <div style={{ fontSize: '11px', color: colors.tertiary, marginTop: '4px', fontStyle: 'italic' }}>
                          Note: {m.notes}
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
            {!isDemo
              ? (
                <div className="boe-card" style={{ padding: '20px', textAlign: 'center' }}>
                  <div style={{ fontSize: '12px', color: colors.muted }}>No recent activity.</div>
                </div>
              )
              : (
                <div className="boe-card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {demo.activity.map((a, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                      gap: '12px', paddingBottom: i < demo.activity.length - 1 ? '8px' : 0,
                      borderBottom: i < demo.activity.length - 1 ? `1px solid ${colors.border}` : 'none',
                    }}>
                      <div>
                        <div style={{ fontSize: '12px', color: colors.primary, fontWeight: 500 }}>{a.action}</div>
                        <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '2px' }}>{a.section}</div>
                      </div>
                      <div style={{ fontSize: '10.5px', color: colors.muted, whiteSpace: 'nowrap' }}>{a.date}</div>
                    </div>
                  ))}
                </div>
              )
            }
          </section>

        </div>
      </div>
    </>
  )
}

// ─── Admin: Asset Inventory ───────────────────────────────────────────────────

const INVENTORY_CATEGORIES = [
  'Laptop / Desktop',
  'Extra Screen / Monitor',
  'Mouse & Keyboard',
  'Pen Drive / Ext. Storage',
  'Mobile Phone',
  'Other Custom Asset',
]

function AssetInventory() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)

  if (selectedCategory !== null) {
    return (
      <CategoryDetail
        category={selectedCategory}
        onBack={() => setSelectedCategory(null)}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {INVENTORY_CATEGORIES.map(cat => {
        const stats = CATEGORY_STATS[cat] ?? { total: 0, inUse: 0, spare: 0, needsUpdate: 0 }
        return (
          <div key={cat} className="boe-card" style={{ padding: '16px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, marginBottom: '10px' }}>{cat}</div>
                <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                  {[
                    { label: 'Total',          value: stats.total       },
                    { label: 'In Use',         value: stats.inUse       },
                    { label: 'Spare',          value: stats.spare       },
                    { label: 'Needs Service',  value: stats.needsUpdate },
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
              </div>
              <button
                className="boe-btn boe-btn-ghost"
                style={{ padding: '6px 14px', fontSize: '12px', flexShrink: 0 }}
                onClick={() => setSelectedCategory(cat)}
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

function CategoryDetail({ category, onBack }: { category: string; onBack: () => void }) {
  const rows = CATEGORY_ASSETS[category] ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Back nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <button
          className="boe-btn boe-btn-ghost"
          style={{ padding: '5px 12px', fontSize: '12px' }}
          onClick={onBack}
        >
          ← Back
        </button>
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{category}</div>
      </div>

      <div className="boe-card" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <TableHead cols={['Asset Name', 'Assigned To', 'Status', 'Last Updated', 'Action']} />
            <tbody>
              {rows.length === 0
                ? <EmptyRow message="No assets added yet." />
                : rows.map((row, i) => (
                  <tr key={i}
                    style={{ borderBottom: `1px solid ${colors.border}` }}
                    onMouseEnter={e => (e.currentTarget.style.background = colors.raised)}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '12px 16px', fontWeight: 600, color: colors.primary }}>{row.name}</td>
                    <td style={{ padding: '12px 16px', color: colors.secondary }}>{row.assignedTo}</td>
                    <td style={{ padding: '12px 16px' }}><StatusPill status="inuse" /></td>
                    <td style={{ padding: '12px 16px', color: colors.muted, fontSize: '12px' }}>{row.lastUpdated}</td>
                    <td style={{ padding: '12px 16px' }}>
                      <button className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '11px' }}>
                        View
                      </button>
                    </td>
                  </tr>
                ))
              }
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
  { key: 'laptop-desktop',  label: 'Laptop / Desktop',            desc: 'Work laptop or desktop — brand, model, serial number, RAM/storage.' },
  { key: 'monitor',         label: 'Extra Screen / Monitor',      desc: 'Additional display assigned to you.' },
  { key: 'mouse-keyboard',  label: 'Mouse & Keyboard',            desc: 'Peripherals assigned to you.' },
  { key: 'pendrive',        label: 'Pen Drive / External Storage', desc: 'USB drives or external storage — capacity and serial.' },
  { key: 'phone',           label: 'Mobile Phone',                desc: 'Company-issued phone — brand, model, serial.' },
  { key: 'other',           label: 'Other Custom Asset',          desc: 'Any other hardware or accessory assigned to you.' },
]

function MyAssets() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '680px' }}>
      <div style={{
        padding: '12px 16px', borderRadius: '8px',
        background: colors.blueTint, border: `1px solid ${colors.blue}30`,
        fontSize: '12px', color: colors.blue, marginBottom: '4px',
      }}>
        Register all company devices assigned to you. Each entry tracks device type, brand, model, serial number, and servicing history.
      </div>
      {DEVICE_CATEGORIES.map(cat => (
        <div key={cat.key} className="boe-card" style={{
          padding: '16px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, marginBottom: '3px' }}>{cat.label}</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginBottom: '6px' }}>{cat.desc}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: colors.muted }} />
              <span style={{ fontSize: '11px', color: colors.muted }}>No device added</span>
            </div>
          </div>
          <button className="boe-btn boe-btn-ghost" style={{ padding: '6px 14px', fontSize: '12px', flexShrink: 0 }}>
            Add Device
          </button>
        </div>
      ))}
    </div>
  )
}

// ─── User: Login Details ─────────────────────────────────────────────────────

const LOGIN_CARDS = [
  { key: 'gmail',   label: 'Gmail',         desc: 'Official Google Workspace email account.' },
  { key: 'clickup', label: 'ClickUp',       desc: 'Project and task management platform.' },
  { key: 'other',   label: 'Other Systems', desc: 'Any other official platform login.' },
]

function LoginDetails() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '680px' }}>
      {LOGIN_CARDS.map(card => (
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
  const [loading,          setLoading]          = useState(true)
  const [view,             setView]             = useState<AssetsView | null>(null)
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null)

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
      if (empData) setEmployees(empData as Employee[])
      setView(prof.role === 'admin' ? 'employee-overview' : 'my-details')
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // Close employee panel when switching views
  const handleViewChange = (v: AssetsView) => {
    setSelectedEmployee(null)
    setView(v)
  }

  if (loading || !view) return <LoadingScreen />

  const meta = VIEW_META[view]

  const renderView = () => {
    switch (view) {
      case 'employee-overview':
        return (
          <EmployeeOverview
            employees={employees}
            onSelect={setSelectedEmployee}
          />
        )
      case 'asset-inventory':     return <AssetInventory />
      case 'access-register':     return <PlaceholderShell message="Access Register" />
      case 'activity-log':        return <PlaceholderShell message="Activity Log" />
      case 'my-details':          return <MyDetails />
      case 'my-assets':           return <MyAssets />
      case 'login-details':       return <LoginDetails />
      case 'maintenance-history': return <PlaceholderShell message="Maintenance History" />
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
        />
      )}
    </AssetsLayout>
  )
}
