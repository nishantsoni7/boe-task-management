'use client'

// Attendance Sync (the "Issues" section) — the smallest useful admin view of
// what the fingerprint system (Minop) sent and what BOE did with it. No
// analytics, no charts: just the recent deliveries, whether each turned into
// attendance, and a retry action for one that did not because a mapping was
// missing at the time. Deliberately inside the existing Attendance admin surface
// rather than a new module — see docs/Module Docs/ATTENDANCE_MINOP_INTEGRATION.md.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { Badge, Notice, StateBlock, StatusFilter, ui, type Tone } from '@/components/attendancePayroll/ui'
import { RefreshCw } from 'lucide-react'
import styles from './sync.module.css'

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

/** What each result means in plain words, and what (if anything) an admin can do. */
type StatusInfo = { label: string; tone: Tone; meaning: string; next: string; mapping?: boolean }

const STATUS_INFO: Record<string, StatusInfo> = {
  processed: {
    label: 'Processed', tone: 'good',
    meaning: 'The punch was recorded in the employee’s attendance.',
    next: 'Nothing to do.',
  },
  pending: {
    label: 'Pending', tone: 'neutral',
    meaning: 'The punch has arrived but has not been processed yet.',
    next: 'Refresh in a moment. Nothing to do unless it stays pending.',
  },
  ignored_unsupported_type: {
    label: 'Ignored (unsupported)', tone: 'neutral',
    meaning: 'The machine sent an event that is not a check-in or check-out, so BOE set it aside.',
    next: 'Nothing to do.',
  },
  unmapped: {
    label: 'Employee not mapped', tone: 'warn',
    meaning: 'This fingerprint code is not linked to any employee, so the punch could not be recorded.',
    next: 'Link the code to an employee under fingerprint mapping, then retry.',
    mapping: true,
  },
  mapping_conflict: {
    label: 'Mapping conflict', tone: 'bad',
    meaning: 'This fingerprint code is linked to more than one employee, so BOE could not tell whose punch it is.',
    next: 'Fix the duplicate under fingerprint mapping, then retry.',
    mapping: true,
  },
  inactive_employee: {
    label: 'Inactive employee', tone: 'warn',
    meaning: 'The employee this code belongs to is inactive, so the punch was not recorded.',
    next: 'If the employee should be counted, reactivate them and check the mapping.',
    mapping: true,
  },
  payroll_locked: {
    label: 'Payroll locked', tone: 'bad',
    meaning: 'Payroll for that month is locked, so attendance was left unchanged.',
    next: 'If the change is wanted, unlock the payroll period first, then retry.',
  },
  malformed_event: {
    label: 'Malformed event', tone: 'bad',
    meaning: 'The message from the machine was incomplete or could not be understood.',
    next: 'Retrying cannot fix this. If it keeps happening, share the technical details with whoever maintains the machine link.',
  },
  error: {
    label: 'Error', tone: 'bad',
    meaning: 'Something went wrong while BOE was recording this punch.',
    next: 'Retry. If it fails again, share the technical details with support.',
  },
}

const QUARANTINED: StatusInfo = {
  label: 'Set aside (invalid data)', tone: 'neutral',
  meaning: 'The message was not valid data, so it was kept aside and never became attendance.',
  next: 'No action is available here.',
}

function infoFor(status: string | null): StatusInfo {
  if (!status) return QUARANTINED
  return STATUS_INFO[status] ?? {
    label: status, tone: 'neutral', meaning: 'BOE does not have a plain-language description for this result.', next: 'See the technical details.',
  }
}

/** Statuses worth an admin retrying, once whatever blocked them is fixed. */
const RETRYABLE = new Set(['unmapped', 'mapping_conflict', 'error', 'payroll_locked'])

/** Results that mean a punch did NOT become attendance and someone may need to act. */
const NEEDS_ATTENTION = new Set([
  'unmapped', 'mapping_conflict', 'inactive_employee', 'payroll_locked', 'malformed_event', 'error',
])

type Filter = 'all' | 'attention' | 'processed'

export default function MinopDiagnosticsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetching, setFetching] = useState(false)
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [error, setError] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  const [okMsg, setOkMsg] = useState('')
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const load = async (tok: string) => {
    setFetching(true)
    setError('')
    try {
      const res = await fetch('/api/attendance/minop-deliveries', {
        headers: { Authorization: `Bearer ${tok}` },
      })
      const json = await res.json()
      if (res.ok) { setDeliveries(json.deliveries ?? []); setLoadFailed(false) }
      else { setError(json.error ?? 'Failed to load Minop deliveries'); setLoadFailed(true) }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      setLoadFailed(true)
    }
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
    setOkMsg('')
    const res = await fetch(`/api/attendance/minop-deliveries/${id}/reprocess`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) setError(json.error ?? 'Retry failed')
    else setOkMsg('Retried. The list below shows the new result.')
    setRetryingId(null)
    await load(token)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const counts = useMemo(() => ({
    all: deliveries.length,
    attention: deliveries.filter(d => !d.attendance_status || NEEDS_ATTENTION.has(d.attendance_status)).length,
    processed: deliveries.filter(d => d.attendance_status === 'processed').length,
  }), [deliveries])

  const shown = useMemo(() => deliveries.filter(d =>
    filter === 'all' ? true
      : filter === 'processed' ? d.attendance_status === 'processed'
      : !d.attendance_status || NEEDS_ATTENTION.has(d.attendance_status),
  ), [deliveries, filter])

  if (loading) return <LoadingScreen />

  const retryButton = (d: Delivery) =>
    d.attendance_status && RETRYABLE.has(d.attendance_status) ? (
      <button
        type="button"
        onClick={() => void retry(d.id)}
        disabled={retryingId === d.id}
        className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
      >
        {retryingId === d.id ? 'Retrying…' : 'Retry'}
      </button>
    ) : null

  /** The plain-language result: badge, what it means, what to do. */
  const result = (d: Delivery) => {
    const info = infoFor(d.attendance_status)
    return (
      <div className={styles.resultCell}>
        <Badge tone={info.tone}>{info.label}</Badge>
        <p className={styles.explain}>{info.meaning}</p>
        {d.attendance_status !== 'processed' && (
          <p className={styles.next}>
            <strong>What to do:</strong> {info.next}
            {info.mapping && <> <Link href="/attendance/employees">Open fingerprint mapping</Link></>}
          </p>
        )}
        <details className={styles.tech}>
          <summary>Technical details</summary>
          <dl className={styles.techBody}>
            <dt>Delivery ID</dt><dd>{d.id}</dd>
            <dt>Received</dt><dd>{d.received_at}</dd>
            <dt>Punch time (UTC)</dt><dd>{d.punch_time_utc ?? '—'}</dd>
            <dt>Device / tag ID</dt><dd>{d.service_tag_id ?? '—'}</dd>
            <dt>Auth method</dt><dd>{d.auth_method}</dd>
            <dt>Delivery status</dt><dd>{d.processing_status}</dd>
            <dt>Attendance status</dt><dd>{d.attendance_status ?? '—'}</dd>
            <dt>Processed at</dt><dd>{d.attendance_processed_at ?? '—'}</dd>
            <dt>Delivery message</dt><dd>{d.error_text ?? '—'}</dd>
            <dt>Attendance message</dt><dd>{d.attendance_error ?? '—'}</dd>
          </dl>
        </details>
      </div>
    )
  }

  const employee = (d: Delivery) =>
    d.mapped_employee_name
      ? <>{d.mapped_employee_name}{d.mapped_employee_code && <div className={ui.sub}>{d.mapped_employee_code}</div>}</>
      : <span className={ui.muted}>Not linked to an employee</span>

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Attendance sync"
      subtitle="Punches sent by the fingerprint system (Minop) and whether each one became attendance."
      onSignOut={handleSignOut}
      actions={
        <button
          type="button"
          onClick={() => void load(token)}
          disabled={fetching}
          className={`boe-btn boe-btn-ghost ${ui.btnSm} ${styles.refreshBtn}`}
        >
          <RefreshCw size={13} className={fetching ? 'boe-spin' : undefined} /> Refresh
        </button>
      }
    >
      <div className={ui.stack}>
        {error && (
          <Notice
            kind="error"
            action={loadFailed
              ? <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => void load(token)} disabled={fetching}>Try again</button>
              : undefined}
          >
            {error}
          </Notice>
        )}
        {okMsg && !error && <Notice kind="success">{okMsg}</Notice>}

        {/* Plain-language key, closed by default so the list stays the focus. */}
        <section className={ui.surface}>
          <details className={styles.disclosure}>
            <summary>What do these results mean?</summary>
            <ul className={styles.legendList}>
              {[...Object.values(STATUS_INFO), QUARANTINED].map(info => (
                <li key={info.label}>
                  <div><Badge tone={info.tone}>{info.label}</Badge></div>
                  <div>{info.meaning} <strong>{info.next}</strong></div>
                </li>
              ))}
            </ul>
          </details>
        </section>

        {deliveries.length > 0 && (
          <div className={ui.toolbar} style={{ marginBottom: 0 }}>
            <StatusFilter<Filter>
              label="Filter deliveries"
              value={filter}
              onChange={setFilter}
              options={[
                { key: 'all', label: 'All', count: counts.all },
                { key: 'attention', label: 'Needs attention', count: counts.attention },
                { key: 'processed', label: 'Processed', count: counts.processed },
              ]}
            />
          </div>
        )}

        {deliveries.length === 0 && fetching ? (
          <StateBlock kind="loading">Loading recent punches…</StateBlock>
        ) : deliveries.length === 0 && loadFailed ? (
          <StateBlock kind="error" title="Could not load the deliveries">
            Nothing is shown because the list could not be read. Use “Try again” above.
          </StateBlock>
        ) : deliveries.length === 0 ? (
          <StateBlock kind="empty" title="No punches received yet">
            When the fingerprint machine sends a punch it will appear here, with what BOE did with it.
          </StateBlock>
        ) : shown.length === 0 ? (
          <StateBlock kind="empty" title={filter === 'attention' ? 'Nothing needs attention' : 'No matching deliveries'}>
            {filter === 'attention'
              ? 'Every recent punch was either recorded or set aside on purpose.'
              : 'Try another filter.'}
          </StateBlock>
        ) : (
          <>
            <div className={`${ui.surface} ${ui.desktopOnly}`} style={{ overflow: 'hidden' }} aria-busy={fetching}>
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th scope="col">Received</th>
                      <th scope="col">Employee</th>
                      <th scope="col">Punch</th>
                      <th scope="col">Result</th>
                      <th scope="col"><span className={ui.srOnly}>Action</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(d => (
                      <tr key={d.id}>
                        <td className={ui.nowrap}>{fmtDateTime(d.received_at)}</td>
                        <td>{employee(d)}</td>
                        <td className={ui.nowrap}>
                          {d.punch_type ?? '—'}
                          <div className={ui.sub}>{fmtDateTime(d.punch_time_utc)}</div>
                        </td>
                        <td>{result(d)}</td>
                        <td className={styles.actionCell}>{retryButton(d)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <ul className={ui.cards} aria-label="Recent punches">
              {shown.map(d => (
                <li key={d.id} className={`${ui.surface} ${ui.card}`}>
                  <div className={ui.cardHead}>
                    <div className={ui.strong}>{employee(d)}</div>
                    <div className={`${ui.sub} ${ui.nowrap}`} style={{ marginTop: 0 }}>{fmtDateTime(d.received_at)}</div>
                  </div>
                  <div className={ui.sub}>
                    {d.punch_type ?? '—'} · punch at {fmtDateTime(d.punch_time_utc)}
                  </div>
                  {result(d)}
                  <div className={styles.cardActions}>{retryButton(d)}</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </AttendancePayrollLayout>
  )
}
