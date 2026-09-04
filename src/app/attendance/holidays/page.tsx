'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { useRefresh } from '@/contexts/RefreshContext'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

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

  const [newDate, setNewDate] = useState('')
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<HolidayType>('full_day')
  const [newSession, setNewSession] = useState<HalfSession | ''>('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  const fetchHolidays = async (token: string) => {
    const res = await fetch('/api/attendance/holidays', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json()
    if (res.ok) setHolidays(json.holidays ?? [])
    else setError(json.error ?? 'Failed to load holidays')
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

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newDate || !newName.trim()) return
    if (newType === 'half_day' && !newSession) return
    setSaving(true)
    setError(null)
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
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const res = await fetch(`/api/attendance/holidays?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (res.ok) {
      setHolidays(prev => prev.filter(h => h.id !== id))
    } else {
      const json = await res.json()
      setError(json.error ?? 'Failed to delete holiday')
    }
  }

  if (loading) return <LoadingScreen />

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Holiday Management"
      subtitle="Public holidays excluded from working days"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 680, padding: '24px 0' }}>

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

        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 20,
            fontSize: 13, color: '#EF4444',
          }}>
            {error}
          </div>
        )}

        {/* ── Add Holiday Form ── */}
        <div style={{
          background: colors.raised, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '18px 20px', marginBottom: 24,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.primary, marginBottom: 14 }}>
            Add Holiday
          </div>
          <form onSubmit={handleAdd} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Date
              </label>
              <input
                type="date"
                value={newDate}
                onChange={e => setNewDate(e.target.value)}
                required
                style={{
                  padding: '7px 10px', borderRadius: 7, fontSize: 13,
                  border: `1px solid ${colors.border}`, background: colors.base,
                  color: colors.primary, outline: 'none', minWidth: 150,
                }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 180 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Holiday Name
              </label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Republic Day"
                required
                style={{
                  padding: '7px 10px', borderRadius: 7, fontSize: 13,
                  border: `1px solid ${colors.border}`, background: colors.base,
                  color: colors.primary, outline: 'none', width: '100%', boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Holiday Type
              </label>
              <select
                value={newType}
                onChange={e => {
                  const holiday_type = e.target.value as HolidayType
                  setNewType(holiday_type)
                  if (holiday_type === 'full_day') setNewSession('')
                }}
                style={{
                  padding: '7px 10px', borderRadius: 7, fontSize: 13,
                  border: `1px solid ${colors.border}`, background: colors.base,
                  color: colors.primary, outline: 'none', minWidth: 130,
                }}
              >
                <option value="full_day">Full Day</option>
                <option value="half_day">Half Day</option>
              </select>
            </div>
            {newType === 'half_day' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Session
                </label>
                <select
                  value={newSession}
                  onChange={e => setNewSession(e.target.value as HalfSession)}
                  required
                  style={{
                    padding: '7px 10px', borderRadius: 7, fontSize: 13,
                    border: `1px solid ${colors.border}`, background: colors.base,
                    color: colors.primary, outline: 'none', minWidth: 130,
                  }}
                >
                  <option value="">Select…</option>
                  <option value="first_half">First Half Holiday</option>
                  <option value="second_half">Second Half Holiday</option>
                </select>
              </div>
            )}
            <button
              type="submit"
              disabled={saving || !newDate || !newName.trim() || (newType === 'half_day' && !newSession)}
              style={{
                padding: '7px 18px', borderRadius: 7, fontSize: 13, fontWeight: 600,
                background: saving ? 'rgba(232,160,48,0.4)' : '#E8A030',
                color: '#fff', border: 'none', cursor: saving ? 'default' : 'pointer',
                whiteSpace: 'nowrap', height: 34,
              }}
            >
              {saving ? 'Adding…' : 'Add Holiday'}
            </button>
          </form>
        </div>

        {/* ── Holiday List ── */}
        <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
          {holidays.length} Holiday{holidays.length !== 1 ? 's' : ''}
        </div>

        {holidays.length === 0 ? (
          <div style={{
            background: colors.raised, border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '32px 20px', textAlign: 'center',
            fontSize: 13, color: colors.tertiary,
          }}>
            No holidays added yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {holidays.map(h => {
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

              return (
                <div
                  key={h.id}
                  style={{
                    background: colors.base, border: `1px solid ${colors.border}`,
                    borderRadius: 9, padding: '12px 16px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: colors.primary, marginBottom: 3 }}>
                      {h.holiday_name}
                      {h.holiday_type === 'half_day' && (
                        <span style={{
                          marginLeft: 10, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                          background: 'rgba(232,160,48,0.12)', color: '#E8A030',
                        }}>
                          {typeLabel}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: colors.tertiary }}>
                      {dateLabel}
                      {createdLabel && <span style={{ marginLeft: 12, opacity: 0.65 }}>Added {createdLabel}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(h.id, h.holiday_name)}
                    title="Delete holiday"
                    style={{
                      padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                      background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                      color: '#EF4444', cursor: 'pointer', flexShrink: 0,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.15)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.08)' }}
                  >
                    Delete
                  </button>
                </div>
              )
            })}
          </div>
        )}

      </div>
    </AttendancePayrollLayout>
  )
}
