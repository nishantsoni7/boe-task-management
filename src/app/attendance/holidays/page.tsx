'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { useRefresh } from '@/contexts/RefreshContext'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { Badge, Notice, StateBlock, ui } from '@/components/attendancePayroll/ui'
import styles from './holidays.module.css'

type HolidayType = 'full_day' | 'half_day'
type HalfSession = 'first_half' | 'second_half'

type Holiday = {
  id: string
  holiday_date: string
  holiday_name: string
  holiday_type: HolidayType
  half_session: HalfSession | null
  created_at: string | null
}

export default function HolidaysPage() {
  const [profile, setProfile]   = useState<UserProfile | null>(null)
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [okMsg, setOkMsg]       = useState<string | null>(null)

  const [newDate, setNewDate] = useState('')
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<HolidayType>('full_day')
  const [newSession, setNewSession] = useState<HalfSession | ''>('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  const fetchHolidays = async (token: string) => {
    try {
      const res = await fetch('/api/attendance/holidays', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      if (res.ok) { setHolidays(json.holidays ?? []); setLoadFailed(false) }
      else { setError(json.error ?? 'Failed to load holidays'); setLoadFailed(true) }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      setLoadFailed(true)
    }
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: me } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      setProfile(me as UserProfile)
      await fetchHolidays(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const retryLoad = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }
    setError(null)
    await fetchHolidays(session.access_token)
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newDate || !newName.trim()) return
    if (newType === 'half_day' && !newSession) return
    setSaving(true)
    setError(null)
    setOkMsg(null)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const res = await fetch('/api/attendance/holidays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        holiday_date: newDate,
        holiday_name: newName.trim(),
        holiday_type: newType,
        half_session: newType === 'half_day' ? newSession : undefined,
      }),
    })
    const json = await res.json()
    if (res.ok) {
      setHolidays(prev => [json.holiday, ...prev].sort((a, b) => b.holiday_date.localeCompare(a.holiday_date)))
      setOkMsg(`Added “${newName.trim()}”.`)
      setNewDate('')
      setNewName('')
      setNewType('full_day')
      setNewSession('')
    } else {
      setError(json.error ?? 'Failed to add holiday')
    }
    setSaving(false)
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete holiday "${name}"? This cannot be undone.`)) return
    setError(null)
    setOkMsg(null)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const res = await fetch(`/api/attendance/holidays?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (res.ok) {
      setHolidays(prev => prev.filter(h => h.id !== id))
      setOkMsg(`Deleted “${name}”.`)
    } else {
      const json = await res.json()
      setError(json.error ?? 'Failed to delete holiday')
    }
  }

  if (loading) return <LoadingScreen />

  const rows = holidays.map(h => {
    const [y, m, d] = h.holiday_date.split('-').map(Number)
    const dateLabel = new Date(y, m - 1, d).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', weekday: 'short',
    })
    const createdLabel = h.created_at
      ? new Date(h.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : null
    const typeLabel = h.holiday_type === 'half_day'
      ? `Half Day — ${h.half_session === 'first_half' ? 'First Half' : 'Second Half'}`
      : 'Full Day'
    return { h, dateLabel, createdLabel, typeLabel }
  })

  const deleteButton = (id: string, name: string) => (
    <button
      type="button"
      onClick={() => handleDelete(id, name)}
      title="Delete holiday"
      aria-label={`Delete ${name}`}
      className={`boe-btn boe-btn-ghost ${ui.btnSm} ${styles.danger}`}
    >
      Delete
    </button>
  )

  const addDisabled = saving || !newDate || !newName.trim() || (newType === 'half_day' && !newSession)

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Holidays"
      subtitle="Public holidays are left out of working days when attendance and pay are worked out."
      onSignOut={handleSignOut}
    >
      <div className={ui.stack}>
        {error && (
          <Notice
            kind="error"
            action={loadFailed
              ? <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => void retryLoad()}>Try again</button>
              : undefined}
          >
            {error}
          </Notice>
        )}
        {okMsg && <Notice kind="success">{okMsg}</Notice>}

        {/* ── Add Holiday Form ── */}
        <section className={`${ui.surface} ${ui.readable}`} aria-labelledby="add-holiday">
          <div className={ui.surfaceHead}>
            <h2 className={ui.surfaceTitle} id="add-holiday">Add a holiday</h2>
          </div>
          <form onSubmit={handleAdd} className={ui.surfaceBody}>
            <div className={ui.fieldGrid}>
              <div className={ui.field}>
                <label className={ui.label} htmlFor="hol-date">Date</label>
                <input
                  id="hol-date"
                  className={ui.input}
                  type="date"
                  value={newDate}
                  onChange={e => setNewDate(e.target.value)}
                  required
                />
              </div>
              <div className={ui.field}>
                <label className={ui.label} htmlFor="hol-name">Holiday name</label>
                <input
                  id="hol-name"
                  className={ui.input}
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. Republic Day"
                  required
                />
              </div>
              <div className={ui.field}>
                <label className={ui.label} htmlFor="hol-type">Holiday type</label>
                <select
                  id="hol-type"
                  className={ui.input}
                  value={newType}
                  onChange={e => {
                    const holiday_type = e.target.value as HolidayType
                    setNewType(holiday_type)
                    if (holiday_type === 'full_day') setNewSession('')
                  }}
                >
                  <option value="full_day">Full Day</option>
                  <option value="half_day">Half Day</option>
                </select>
              </div>
              {newType === 'half_day' && (
                <div className={ui.field}>
                  <label className={ui.label} htmlFor="hol-session">Session</label>
                  <select
                    id="hol-session"
                    className={ui.input}
                    value={newSession}
                    onChange={e => setNewSession(e.target.value as HalfSession)}
                    required
                  >
                    <option value="">Select…</option>
                    <option value="first_half">First Half Holiday</option>
                    <option value="second_half">Second Half Holiday</option>
                  </select>
                </div>
              )}
            </div>
            <div className={styles.formActions}>
              <button
                type="submit"
                disabled={addDisabled}
                className={`boe-btn boe-btn-primary ${ui.btn}`}
              >
                {saving ? 'Adding…' : 'Add Holiday'}
              </button>
            </div>
          </form>
        </section>

        {/* ── Holiday List ── */}
        {loadFailed ? (
          <StateBlock kind="error" title="Could not load the holidays">
            The list could not be read, so nothing is shown here. Use “Try again” above.
          </StateBlock>
        ) : holidays.length === 0 ? (
          <StateBlock kind="empty" title="No holidays added yet">
            Add a public holiday above and it will be excluded from working days.
          </StateBlock>
        ) : (
          <section className={ui.surface} aria-labelledby="hol-list">
            <div className={ui.surfaceHead}>
              <h2 className={ui.surfaceTitle} id="hol-list">
                {holidays.length} holiday{holidays.length !== 1 ? 's' : ''}
              </h2>
            </div>

            <div className={`${ui.tableWrap} ${ui.desktopOnly}`}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Holiday</th>
                    <th scope="col">Type</th>
                    <th scope="col">Added</th>
                    <th scope="col"><span className={ui.srOnly}>Delete</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ h, dateLabel, createdLabel, typeLabel }) => (
                    <tr key={h.id}>
                      <td className={ui.nowrap}>{dateLabel}</td>
                      <td className={ui.strong}>{h.holiday_name}</td>
                      <td>{h.holiday_type === 'half_day' ? <Badge tone="warn">{typeLabel}</Badge> : <span className={ui.muted}>{typeLabel}</span>}</td>
                      <td className={`${ui.muted} ${ui.nowrap}`}>{createdLabel ?? '—'}</td>
                      <td className={ui.num}>{deleteButton(h.id, h.holiday_name)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className={`${ui.cards} ${styles.cardList}`}>
              {rows.map(({ h, dateLabel, createdLabel, typeLabel }) => (
                <li key={h.id} className={`${ui.surface} ${ui.card}`}>
                  <div className={ui.cardHead}>
                    <div className={ui.strong}>{h.holiday_name}</div>
                    {h.holiday_type === 'half_day' && <Badge tone="warn">{typeLabel}</Badge>}
                  </div>
                  <div className={ui.sub}>
                    {dateLabel}
                    {h.holiday_type === 'full_day' && ' · Full Day'}
                    {createdLabel && ` · Added ${createdLabel}`}
                  </div>
                  <div>{deleteButton(h.id, h.holiday_name)}</div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </AttendancePayrollLayout>
  )
}
