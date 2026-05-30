'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, PasswordResetLogEntry } from '@/lib/types'
import { initials, formatFullDate } from '@/lib/ui'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { AlertBanner, LoadingScreen } from '@/components/ui/atoms'

const TEAMS = ['sales', 'operations', 'design', 'purchase', 'bdm', 'management']
const ROLES = ['member', 'manager', 'admin'] as const

const AVATAR_COLORS = [
  '#4A6EB5', '#8A6020', '#3A7068', '#5A4EA8',
  '#3E8060', '#3E6E40', '#7A4040', '#2A5F7A',
]
function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

const MEMBER_COLUMNS = 'id, full_name, email, phone, role, team, is_active, created_at'

export default function MembersPage() {
  const [profile,        setProfile]        = useState<UserProfile | null>(null)
  const [members,        setMembers]        = useState<UserProfile[]>([])
  const [loading,        setLoading]        = useState(true)
  const [showForm,       setShowForm]       = useState(false)
  const [selectedMember, setSelectedMember] = useState<UserProfile | null>(null)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [showResetForm, setShowResetForm]   = useState(false)
  const [resetPassword, setResetPassword]   = useState('')
  const [resetConfirm,  setResetConfirm]    = useState('')
  const [resetSaving,   setResetSaving]     = useState(false)
  const [resetError,    setResetError]      = useState('')
  const [resetSuccess,  setResetSuccess]    = useState(false)
  const [resetHistory,  setResetHistory]    = useState<PasswordResetLogEntry[]>([])
  const [full_name, setFullName]  = useState('')
  const [email,     setEmail]     = useState('')
  const [phone,     setPhone]     = useState('')
  const [role,      setRole]      = useState<'member' | 'manager' | 'admin'>('member')
  const [team,      setTeam]      = useState('sales')
  const [password,  setPassword]  = useState('')
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const init = async () => {
      const pageStart = performance.now()
      console.log('[members] init started')

      // ── CHANGE: getUser() → getSession() ─────────────────────────────────
      // getUser() verified against Supabase auth server on every page load.
      // getSession() reads cached session from localStorage — zero network cost.
      // Safe: this is a UI gate only. Admin enforcement is handled by RLS and
      // the role check immediately below.
      // ─────────────────────────────────────────────────────────────────────
      const authStart = performance.now()
      const { data: { session } } = await supabase.auth.getSession()
      console.log('[members] getSession', Math.round(performance.now() - authStart), 'ms')

      if (!session) { router.push('/login'); return }

      const dataStart    = performance.now()
      const roleStart    = performance.now()
      const membersStart = performance.now()

      const [{ data: p }, { data: memberData }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', session.user.id)
          .single()
          .then((r: { data: UserProfile | null; error: unknown }) => {
            console.log('[members] role fetch', Math.round(performance.now() - roleStart), 'ms')
            return r
          }),
        supabase
          .from('users')
          .select(MEMBER_COLUMNS)
          .order('full_name')
          .then((r: { data: UserProfile[] | null; error: unknown }) => {
            console.log('[members] members fetch', Math.round(performance.now() - membersStart), 'ms')
            return r
          }),
      ])

      console.log('[members] parallel data TOTAL', Math.round(performance.now() - dataStart), 'ms')

      if (p?.role !== 'admin') { router.push('/dashboard'); return }
      if (p) setProfile(p as UserProfile)
      if (memberData) setMembers(memberData as UserProfile[])

      console.log('[members] TOTAL', Math.round(performance.now() - pageStart), 'ms')
      setLoading(false)
    }
    init()
  }, [])

  const loadMembers = async () => {
    const { data } = await supabase
      .from('users')
      .select(MEMBER_COLUMNS)
      .order('full_name')
    if (data) setMembers(data as UserProfile[])
  }

  const handleCreate = async () => {
    if (!full_name.trim() || !email.trim() || !password.trim()) {
      setError('Name, email and password are required')
      return
    }
    setSaving(true)
    setError('')

    const res = await fetch('/api/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:     email.trim(),
        password:  password.trim(),
        full_name: full_name.trim(),
        phone:     phone.trim() || null,
        role,
        team,
      }),
    })
    const data = await res.json()

    if (!res.ok) {
      setError(data.error || 'Failed to create member')
      setSaving(false)
      return
    }

    setFullName(''); setEmail(''); setPhone('')
    setPassword(''); setRole('member'); setTeam('sales')
    setShowForm(false)
    await loadMembers()
    setSaving(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const openResetForm = () => {
    setResetPassword('')
    setResetConfirm('')
    setResetError('')
    setResetSuccess(false)
    setShowResetForm(true)
  }

  const closeResetForm = () => {
    setShowResetForm(false)
    setResetPassword('')
    setResetConfirm('')
    setResetError('')
    setResetSuccess(false)
  }

  const handleResetPassword = async () => {
    if (!selectedMember) return
    if (!resetPassword.trim()) { setResetError('New password is required'); return }
    if (resetPassword.length < 6) { setResetError('Password must be at least 6 characters'); return }
    if (resetPassword !== resetConfirm) { setResetError('Passwords do not match'); return }

    setResetSaving(true)
    setResetError('')

    const res = await fetch('/api/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: selectedMember.id, newPassword: resetPassword, actorId: profile?.id }),
    })
    const data = await res.json()

    setResetSaving(false)

    if (!res.ok) {
      setResetError(data.error || 'Failed to reset password')
      return
    }

    setResetPassword('')
    setResetConfirm('')
    setResetSuccess(true)
    await loadResetHistory(selectedMember.id)
  }

  const toggleActive = async (member: UserProfile) => {
    if (togglingId) return
    setTogglingId(member.id)
    const newValue = !member.is_active
    const { error: updateError } = await supabase
      .from('users')
      .update({ is_active: newValue })
      .eq('id', member.id)
    if (updateError) {
      setError(`Failed to update member: ${updateError.message}`)
      setTogglingId(null)
      return
    }
    setMembers(prev => prev.map(m => m.id === member.id ? { ...m, is_active: newValue } : m))
    if (selectedMember?.id === member.id) {
      setSelectedMember(prev => prev ? { ...prev, is_active: newValue } : prev)
    }
    setTogglingId(null)
  }

  const loadResetHistory = async (memberId: string) => {
    const { data } = await supabase
      .from('password_reset_log')
      .select(`id, target_id, actor_id, reset_at, ip_address, users:actor_id ( full_name )`)
      .eq('target_id', memberId)
      .order('reset_at', { ascending: false })
      .limit(5)
    if (data) {
      setResetHistory((data as any[]).map(e => ({
        ...e,
        actor_name: e.users?.full_name ?? null,
      })))
    }
  }

  useEffect(() => {
    closeResetForm()
    setResetHistory([])
    if (selectedMember) loadResetHistory(selectedMember.id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMember?.id])

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="Members"
      subtitle={`${members.length} members · ${members.filter(m => m.is_active).length} active`}
      actions={
        <button
          onClick={() => setShowForm(!showForm)}
          className="boe-btn boe-btn-primary"
        >
          {showForm ? 'Cancel' : '+ Add Member'}
        </button>
      }
      onSignOut={handleLogout}
    >

      {showForm && (
        <div className="boe-card" style={{
          padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '10px',
          maxWidth: '560px', marginBottom: '16px',
        }}>
          <p style={{ color: colors.primary, fontSize: '13px', fontWeight: 600 }}>
            New Team Member
          </p>

          {error && (
            <AlertBanner variant="red">
              <p style={{ color: colors.red, fontSize: '12px' }}>{error}</p>
            </AlertBanner>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            {[
              { value: full_name, set: setFullName, placeholder: 'Full name',           type: 'text'     },
              { value: email,     set: setEmail,     placeholder: 'Email address',       type: 'email'    },
              { value: phone,     set: setPhone,     placeholder: 'Phone (optional)',    type: 'tel'      },
              { value: password,  set: setPassword,  placeholder: 'Temporary password', type: 'password' },
            ].map(({ value, set, placeholder, type }) => (
              <input
                key={placeholder}
                value={value}
                onChange={e => set(e.target.value)}
                placeholder={placeholder}
                type={type}
                className="boe-input"
              />
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label className="boe-input-label">Role</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {ROLES.map(r => (
                  <button
                    key={r}
                    onClick={() => setRole(r)}
                    className={`boe-chip${role === r ? ' boe-chip-selected' : ''}`}
                    style={{ flex: 1, textAlign: 'center', textTransform: 'capitalize' }}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="boe-input-label">Team</label>
              <select
                value={team}
                onChange={e => setTeam(e.target.value)}
                className="boe-input"
              >
                {TEAMS.map(t => (
                  <option key={t} value={t} style={{ textTransform: 'capitalize' }}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          <button
            onClick={handleCreate}
            disabled={saving}
            className="boe-btn boe-btn-primary"
            style={{ justifyContent: 'center', padding: '11px' }}
          >
            {saving ? 'Creating...' : 'Create Member'}
          </button>
        </div>
      )}

      {error && !showForm && (
        <AlertBanner variant="red">
          <p style={{ color: colors.red, fontSize: '12px' }}>{error}</p>
        </AlertBanner>
      )}

      <div className="boe-members-grid">
        {members.map(member => (
          <div key={member.id} className="boe-member-card">

            <div className="boe-member-card-top">
              <div
                className="boe-member-avatar"
                style={{ background: avatarColor(member.full_name) }}
              >
                {initials(member.full_name)}
              </div>
              <div>
                <div className="boe-member-name">{member.full_name}</div>
                <div className="boe-member-role" style={{ textTransform: 'capitalize' }}>
                  {member.team} · {member.role}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
              <span
                className={`boe-badge ${member.is_active ? 'boe-badge-completed' : 'boe-badge-pending'}`}
                style={{ fontSize: '9px' }}
              >
                {member.is_active ? 'Active' : 'Inactive'}
              </span>
              {member.phone && (
                <span className="boe-badge boe-badge-pending" style={{ fontSize: '9px' }}>
                  {member.phone}
                </span>
              )}
            </div>

            <div style={{
              fontSize: '11px', color: colors.muted,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {member.email}
            </div>

            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={() => setSelectedMember(member)}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '5px 10px', fontSize: '11px', flex: 1, justifyContent: 'center' }}
              >
                View
              </button>
              <button
                onClick={() => toggleActive(member)}
                disabled={togglingId === member.id}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '5px 10px', fontSize: '11px', flex: 1, justifyContent: 'center' }}
              >
                {togglingId === member.id ? '...' : member.is_active ? 'Deactivate' : 'Activate'}
              </button>
            </div>

          </div>
        ))}
      </div>

      {/* ── Member profile side panel ──────────────────────────────────── */}
      {selectedMember && (
        <>
          {/* Panel */}
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: '340px',
            background: colors.base,
            borderLeft: `1px solid ${colors.border}`,
            zIndex: 50,
            display: 'flex', flexDirection: 'column',
            overflowY: 'auto',
          }}>

            {/* Panel header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: `1px solid ${colors.border}`,
            }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                Member Profile
              </span>
              <button
                onClick={() => setSelectedMember(null)}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '4px 8px', fontSize: '13px', lineHeight: 1 }}
              >
                ✕
              </button>
            </div>

            {/* Avatar + name */}
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              padding: '28px 20px 20px',
              borderBottom: `1px solid ${colors.border}`,
              gap: '10px',
            }}>
              <div
                className="boe-member-avatar"
                style={{
                  background: avatarColor(selectedMember.full_name),
                  width: '56px', height: '56px',
                  fontSize: '18px',
                }}
              >
                {initials(selectedMember.full_name)}
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '15px', fontWeight: 600, color: colors.primary }}>
                  {selectedMember.full_name}
                </div>
                <div style={{ fontSize: '12px', color: colors.secondary, textTransform: 'capitalize', marginTop: '2px' }}>
                  {selectedMember.team} · {selectedMember.role}
                </div>
              </div>
              <span
                className={`boe-badge ${selectedMember.is_active ? 'boe-badge-completed' : 'boe-badge-pending'}`}
                style={{ fontSize: '10px' }}
              >
                {selectedMember.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>

            {/* Detail rows */}
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {[
                { label: 'Email',        value: selectedMember.email },
                { label: 'Phone',        value: selectedMember.phone ?? '—' },
                { label: 'Role',         value: selectedMember.role,  capitalize: true },
                { label: 'Team',         value: selectedMember.team,  capitalize: true },
                { label: 'Member since', value: formatFullDate(selectedMember.created_at) },
              ].map(({ label, value, capitalize }) => (
                <div key={label}>
                  <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '2px' }}>
                    {label}
                  </div>
                  <div style={{
                    fontSize: '13px', color: colors.secondary,
                    textTransform: capitalize ? 'capitalize' : undefined,
                  }}>
                    {value}
                  </div>
                </div>
              ))}

              {/* Member ID — muted, small */}
              <div style={{ marginTop: '4px', paddingTop: '12px', borderTop: `1px solid ${colors.border}` }}>
                <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '2px' }}>
                  Member ID
                </div>
                <div style={{ fontSize: '10px', color: colors.muted, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {selectedMember.id}
                </div>
              </div>
            </div>

            {/* ── Reset History ───────────────────────────────────────────── */}
            {resetHistory.length > 0 && (
              <div style={{ padding: '0 20px 4px' }}>
                <div style={{ paddingTop: '12px', borderTop: `1px solid ${colors.border}` }}>
                  <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                    Reset History
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {resetHistory.map(entry => (
                      <div key={entry.id} style={{ fontSize: '11px', color: colors.secondary }}>
                        <span style={{ color: colors.primary, fontWeight: 500 }}>
                          {entry.actor_name ?? 'Unknown'}
                        </span>
                        <span style={{ color: colors.muted }}> · </span>
                        {new Date(entry.reset_at).toLocaleString('en-GB', {
                          day: '2-digit', month: 'short', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── Reset Password ──────────────────────────────────────────── */}
            <div style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ paddingTop: '12px', borderTop: `1px solid ${colors.border}` }}>
                <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                  Password
                </div>

                {!showResetForm && (
                  <button
                    onClick={openResetForm}
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '6px 12px', fontSize: '12px', width: '100%', justifyContent: 'center' }}
                  >
                    Reset Password
                  </button>
                )}

                {showResetForm && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {resetSuccess ? (
                      <div style={{
                        padding: '10px 12px',
                        background: '#f0faf4',
                        border: '1px solid #b7e4c7',
                        borderRadius: '6px',
                        fontSize: '12px',
                        color: '#2d6a4f',
                      }}>
                        Password reset successfully.
                      </div>
                    ) : (
                      <>
                        <input
                          type="password"
                          value={resetPassword}
                          onChange={e => setResetPassword(e.target.value)}
                          placeholder="New temporary password"
                          className="boe-input"
                          style={{ fontSize: '12px' }}
                        />
                        <input
                          type="password"
                          value={resetConfirm}
                          onChange={e => setResetConfirm(e.target.value)}
                          placeholder="Confirm password"
                          className="boe-input"
                          style={{ fontSize: '12px' }}
                        />
                        {resetError && (
                          <p style={{ fontSize: '11px', color: colors.red, margin: 0 }}>{resetError}</p>
                        )}
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            onClick={handleResetPassword}
                            disabled={resetSaving}
                            className="boe-btn boe-btn-primary"
                            style={{ flex: 1, justifyContent: 'center', padding: '7px', fontSize: '12px' }}
                          >
                            {resetSaving ? 'Resetting…' : 'Confirm Reset'}
                          </button>
                          <button
                            onClick={closeResetForm}
                            disabled={resetSaving}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '7px 12px', fontSize: '12px' }}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    )}

                    {resetSuccess && (
                      <button
                        onClick={closeResetForm}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '6px 12px', fontSize: '12px', width: '100%', justifyContent: 'center' }}
                      >
                        Done
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

          </div>
        </>
      )}

    </DashboardLayout>
  )
}

