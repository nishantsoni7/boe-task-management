'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { ObjectionQueue } from '@/components/objections/ObjectionQueue'

// ─── Types ────────────────────────────────────────────────────────────────────

type CorrectionRow = {
  id:               string
  attendance_date:  string
  employee_name:    string
  employee_code:    string | null
  change_type:      'New' | 'Modified'
  old_check_in_at:  string | null
  new_check_in_at:  string | null
  old_check_out_at: string | null
  new_check_out_at: string | null
  corrected_by:     string
  corrected_at:     string
  source_file_name: string | null
  payroll_status:   string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

function PayrollBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    locked:        { bg: 'rgba(232,160,48,0.12)', color: '#92400E', label: 'Locked' },
    generated:     { bg: 'rgba(59,130,246,0.10)', color: '#1D4ED8', label: 'Generated' },
    draft:         { bg: 'rgba(124,58,237,0.10)', color: '#6D28D9', label: 'Draft' },
    not_generated: { bg: 'rgba(140,148,166,0.10)', color: '#6B7280', label: 'Not generated' },
  }
  const s = map[status] ?? map.not_generated
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      fontSize: 11, fontWeight: 600, background: s.bg, color: s.color,
      whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  )
}

function ChangeTypeBadge({ type }: { type: 'New' | 'Modified' }) {
  const isNew = type === 'New'
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      fontSize: 11, fontWeight: 600,
      background: isNew ? 'rgba(16,185,129,0.10)' : 'rgba(245,158,11,0.10)',
      color: isNew ? '#059669' : '#D97706',
    }}>
      {type}
    </span>
  )
}

// ─── Month options ────────────────────────────────────────────────────────────

function monthOptions(): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [{ value: '', label: 'All months' }]
  const now = new Date()
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    opts.push({ value, label })
  }
  return opts
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

export default function CorrectionLogPage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [fetching, setFetching] = useState(false)
  const [rows,     setRows]     = useState<CorrectionRow[]>([])
  const [total,    setTotal]    = useState(0)
  const [page,     setPage]     = useState(1)
  const [month,    setMonth]    = useState('')
  const [token,    setToken]    = useState('')
  const [error,    setError]    = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const months   = useMemo(() => monthOptions(), [])

  const loadLog = async (tok: string, pg: number, mo: string) => {
    setFetching(true)
    setError('')
    const params = new URLSearchParams({ page: String(pg) })
    if (mo) params.set('month', mo)
    const res  = await fetch(`/api/attendance/correction-log?${params}`, {
      headers: { Authorization: `Bearer ${tok}` },
    })
    const json = await res.json()
    if (res.ok) {
      setRows(json.results)
      setTotal(json.total)
    } else {
      setError(json.error ?? 'Failed to load correction log')
    }
    setFetching(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: prof } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      // Module access is decided once, by the route guard in
      // src/app/{attendance,payroll}/layout.tsx, through
      // src/lib/moduleAccess.ts. A second 'is this an admin?' here is what let
      // the launcher and the route disagree; admin-only ACTIONS on this page
      // are gated where they are rendered, and again in their API routes.
      if (!prof) { router.push('/coming-soon'); return }
      setProfile(prof as UserProfile)
      setToken(session.access_token)
      setLoading(false)
      await loadLog(session.access_token, 1, '')
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleMonthChange = async (mo: string) => {
    setMonth(mo)
    setPage(1)
    await loadLog(token, 1, mo)
  }

  const handlePage = async (pg: number) => {
    setPage(pg)
    await loadLog(token, pg, month)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const totalPages = Math.ceil(total / PAGE_SIZE)

  const inputStyle: React.CSSProperties = {
    fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    padding: '7px 11px', boxSizing: 'border-box',
  }

  return (
    <AttendanceLayout
      profile={profile}
      title="Attendance Correction Log"
      subtitle="Audit trail of attendance records created or modified during import"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 1200, padding: '24px 0' }}>

        <Link
          href="/attendance"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.tertiary, textDecoration: 'none', marginBottom: 24 }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.tertiary)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Attendance
        </Link>

        {/* Employee-reported issues sit above the import audit trail: this is
            the screen an admin is already on when investigating a disputed
            day, and resolving one usually means making a correction. The
            correction itself is still a separate, deliberate action. */}
        <ObjectionQueue
          subject="attendance"
          token={token}
          title="Reported attendance issues"
          emptyLabel="No employee has reported an attendance issue."
        />

        {/* Filter bar */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '16px 20px', marginBottom: 20,
          display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap',
        }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Month
            </label>
            <select
              value={month}
              onChange={e => handleMonthChange(e.target.value)}
              style={{ ...inputStyle, width: 200 }}
            >
              {months.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 12, color: colors.tertiary, paddingBottom: 8 }}>
            {fetching ? 'Loading…' : `${total} record${total !== 1 ? 's' : ''}`}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 16,
            fontSize: 13, color: '#DC2626',
          }}>
            {error}
          </div>
        )}

        {/* Table */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: 10, overflow: 'hidden', marginBottom: 16,
        }}>
          {rows.length === 0 && !fetching ? (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: colors.tertiary, fontSize: 13 }}>
              No correction records found{month ? ' for this month' : ''}.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${colors.border}`, background: colors.raised }}>
                    {[
                      { label: 'Employee',      align: 'left'   },
                      { label: 'Date',          align: 'left'   },
                      { label: 'Change',        align: 'center' },
                      { label: 'Old In → Out',  align: 'left'   },
                      { label: 'New In → Out',  align: 'left'   },
                      { label: 'Source File',   align: 'left'   },
                      { label: 'Corrected By',  align: 'left'   },
                      { label: 'Corrected At',  align: 'left'   },
                      { label: 'Payroll',       align: 'center' },
                    ].map(col => (
                      <th key={col.label} style={{
                        padding: '10px 14px',
                        textAlign: col.align as React.CSSProperties['textAlign'],
                        fontSize: 11, fontWeight: 600, color: colors.tertiary,
                        textTransform: 'uppercase', letterSpacing: '0.05em',
                        whiteSpace: 'nowrap',
                      }}>
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.id}
                      style={{ borderBottom: i < rows.length - 1 ? `1px solid ${colors.border}` : 'none' }}
                    >
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: colors.primary }}>{r.employee_name}</div>
                        {r.employee_code && (
                          <div style={{ fontSize: 11, color: colors.tertiary, marginTop: 1 }}>{r.employee_code}</div>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: colors.secondary }}>
                        {fmtDate(r.attendance_date)}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                        <ChangeTypeBadge type={r.change_type} />
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: colors.tertiary, fontSize: 12 }}>
                        {r.change_type === 'New' ? (
                          <span style={{ fontStyle: 'italic' }}>—</span>
                        ) : (
                          <>{fmtTime(r.old_check_in_at)} → {fmtTime(r.old_check_out_at)}</>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: colors.secondary, fontSize: 12 }}>
                        {fmtTime(r.new_check_in_at)} → {fmtTime(r.new_check_out_at)}
                      </td>
                      <td style={{ padding: '10px 14px', maxWidth: 180 }}>
                        {r.source_file_name ? (
                          <span style={{ fontSize: 11.5, color: colors.tertiary, wordBreak: 'break-all' }}>
                            {r.source_file_name}
                          </span>
                        ) : (
                          <span style={{ color: colors.tertiary, fontSize: 11.5 }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: colors.secondary, fontSize: 12 }}>
                        {r.corrected_by}
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: colors.tertiary, fontSize: 12 }}>
                        {fmtDateTime(r.corrected_at)}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                        <PayrollBadge status={r.payroll_status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', fontSize: 13 }}>
            <button
              onClick={() => handlePage(page - 1)}
              disabled={page <= 1 || fetching}
              style={{
                padding: '6px 14px', borderRadius: 7, fontSize: 13,
                border: `1px solid ${colors.border}`, background: colors.base,
                color: page <= 1 ? colors.tertiary : colors.primary,
                cursor: page <= 1 ? 'not-allowed' : 'pointer',
              }}
            >
              Previous
            </button>
            <span style={{ color: colors.tertiary }}>Page {page} of {totalPages}</span>
            <button
              onClick={() => handlePage(page + 1)}
              disabled={page >= totalPages || fetching}
              style={{
                padding: '6px 14px', borderRadius: 7, fontSize: 13,
                border: `1px solid ${colors.border}`, background: colors.base,
                color: page >= totalPages ? colors.tertiary : colors.primary,
                cursor: page >= totalPages ? 'not-allowed' : 'pointer',
              }}
            >
              Next
            </button>
          </div>
        )}

        <div style={{ fontSize: 12, color: colors.tertiary, lineHeight: 1.7, marginTop: 8 }}>
          <strong style={{ color: colors.secondary }}>Note:</strong> Only records modified during import are logged here.
          Unchanged records from re-uploads do not appear.
          &ldquo;New&rdquo; means the employee had no prior record for that date; &ldquo;Modified&rdquo; means an existing record was updated.
        </div>

      </div>
    </AttendanceLayout>
  )
}
