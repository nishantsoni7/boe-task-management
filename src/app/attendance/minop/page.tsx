'use client'

// Minop rollout diagnostics (Phase F) — the smallest useful admin view of
// what the device sent and what BOE did with it. No analytics, no charts:
// just the recent deliveries, whether each turned into attendance, and a
// retry action for one that did not because a mapping was missing at the
// time. Deliberately inside the existing Attendance admin surface rather
// than a new module — see docs/Module Docs/ATTENDANCE_MINOP_INTEGRATION.md.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { colors } from '@/lib/tokens'
import { RefreshCw } from 'lucide-react'

type Delivery = {
  id: string
  received_at: string
  service_tag_id: string | null
  auth_method: string
  processing_status: string
  error_text: string | null
  attendance_status: string | null
  attendance_error: string | null
  attendance_processed_at: string | null
  punch_type: string | null
  punch_time_utc: string | null
  mapped_employee_name: string | null
  mapped_employee_code: string | null
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

const STATUS_LABEL: Record<string, { label: string; bg: string; color: string }> = {
  processed:                 { label: 'Processed',            bg: 'rgba(16,185,129,0.10)', color: '#059669' },
  pending:                   { label: 'Pending',               bg: 'rgba(140,148,166,0.10)', color: '#6B7280' },
  ignored_unsupported_type:  { label: 'Ignored (unsupported)', bg: 'rgba(140,148,166,0.10)', color: '#6B7280' },
  unmapped:                  { label: 'Unmapped code',         bg: 'rgba(245,158,11,0.10)', color: '#D97706' },
  mapping_conflict:          { label: 'Mapping conflict',      bg: 'rgba(239,68,68,0.10)', color: '#DC2626' },
  inactive_employee:         { label: 'Inactive employee',     bg: 'rgba(245,158,11,0.10)', color: '#D97706' },
  payroll_locked:            { label: 'Payroll locked',        bg: 'rgba(239,68,68,0.10)', color: '#DC2626' },
  malformed_event:           { label: 'Malformed event',       bg: 'rgba(239,68,68,0.10)', color: '#DC2626' },
  error:                     { label: 'Error',                 bg: 'rgba(239,68,68,0.10)', color: '#DC2626' },
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span style={{ color: colors.tertiary, fontSize: 12 }}>Quarantined (invalid JSON)</span>
  const s = STATUS_LABEL[status] ?? { label: status, bg: 'rgba(140,148,166,0.10)', color: '#6B7280' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      fontSize: 11, fontWeight: 600, background: s.bg, color: s.color, whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  )
}

/** Statuses worth an admin retrying, once whatever blocked them is fixed. */
const RETRYABLE = new Set(['unmapped', 'mapping_conflict', 'error', 'payroll_locked'])

export default function MinopDiagnosticsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetching, setFetching] = useState(false)
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [error, setError] = useState('')
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [token, setToken] = useState('')

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const load = async (tok: string) => {
    setFetching(true)
    setError('')
    const res = await fetch('/api/attendance/minop-deliveries', {
      headers: { Authorization: `Bearer ${tok}` },
    })
    const json = await res.json()
    if (res.ok) setDeliveries(json.deliveries ?? [])
    else setError(json.error ?? 'Failed to load Minop deliveries')
    setFetching(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data: prof } = await supabase
        .from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!prof) { router.push('/coming-soon'); return }
      setProfile(prof as UserProfile)
      setToken(session.access_token)
      setLoading(false)
      await load(session.access_token)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const retry = async (id: string) => {
    setRetryingId(id)
    const res = await fetch(`/api/attendance/minop-deliveries/${id}/reprocess`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) setError(json.error ?? 'Retry failed')
    setRetryingId(null)
    await load(token)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Minop Diagnostics"
      subtitle="Recent biometric callbacks, employee mapping and processing outcome"
      onSignOut={handleSignOut}
      actions={
        <button
          type="button"
          onClick={() => void load(token)}
          disabled={fetching}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '8px 10px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={13} className={fetching ? 'boe-spin' : undefined} /> Refresh
        </button>
      }
    >
      {error && (
        <div role="alert" style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(239,68,68,0.08)', color: '#DC2626',
          border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {deliveries.length === 0 && !fetching ? (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: 12,
          background: colors.base, padding: '34px 24px', textAlign: 'center',
          fontSize: 13.5, color: colors.secondary,
        }}>
          No Minop callbacks received yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: `1px solid ${colors.border}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: colors.base, textAlign: 'left' }}>
                {['Received', 'Employee', 'Punch', 'Time (UTC)', 'Status', 'Detail', ''].map(h => (
                  <th key={h} style={{ padding: '9px 12px', fontWeight: 650, color: colors.secondary, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {deliveries.map(d => (
                <tr key={d.id} style={{ borderTop: `1px solid ${colors.borderSoft}` }}>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{fmtDateTime(d.received_at)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                    {d.mapped_employee_name ?? <span style={{ color: colors.tertiary }}>—</span>}
                  </td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{d.punch_type ?? '—'}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{fmtDateTime(d.punch_time_utc)}</td>
                  <td style={{ padding: '9px 12px' }}><StatusBadge status={d.attendance_status} /></td>
                  <td style={{ padding: '9px 12px', color: colors.secondary, maxWidth: 320 }}>
                    {d.error_text ?? d.attendance_error ?? '—'}
                  </td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                    {d.attendance_status && RETRYABLE.has(d.attendance_status) && (
                      <button
                        type="button"
                        onClick={() => void retry(d.id)}
                        disabled={retryingId === d.id}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '4px 9px', fontSize: 11.5 }}
                      >
                        {retryingId === d.id ? 'Retrying…' : 'Retry'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AttendancePayrollLayout>
  )
}
