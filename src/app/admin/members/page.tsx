'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile, PasswordResetLogEntry, Position } from '@/lib/types'
import { initials, formatFullDate } from '@/lib/ui'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { AlertBanner, LoadingScreen } from '@/components/ui/atoms'

const TEAMS = ['sales', 'after_sales', 'operations', 'design', 'purchase', 'procurement', 'bdm', 'management', 'production', 'accounts', 'dispatch']
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

const MEMBER_COLUMNS = 'id, full_name, email, phone, role, team, position, is_active, created_at, is_deleted, deleted_at, deletion_scheduled_at'

export default function MembersPage() {
  const [profile,        setProfile]        = useState<UserProfile | null>(null)
  const [members,        setMembers]        = useState<UserProfile[]>([])
  const [positions,      setPositions]      = useState<Position[]>([])
  const [loading,        setLoading]        = useState(true)
  const [showForm,       setShowForm]       = useState(false)
  const [selectedMember, setSelectedMember] = useState<UserProfile | null>(null)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [deletingId,       setDeletingId]       = useState<string | null>(null)
  const [confirmDelete,    setConfirmDelete]    = useState<UserProfile | null>(null)
  const [deleteError,      setDeleteError]      = useState('')
  const [showCannotDelete, setShowCannotDelete] = useState(false)
  const [deletedMembers, setDeletedMembers] = useState<UserProfile[]>([])
  const [restoringId,    setRestoringId]    = useState<string | null>(null)
  const [showDeleted,         setShowDeleted]         = useState(false)
  const [confirmPermDelete,   setConfirmPermDelete]   = useState<UserProfile | null>(null)
  const [permDeletingId,      setPermDeletingId]      = useState<string | null>(null)
  const [permDeleteError,     setPermDeleteError]     = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [showResetForm, setShowResetForm]   = useState(false)
  const [resetPassword, setResetPassword]   = useState('')
  const [resetConfirm,  setResetConfirm]    = useState('')
  const [resetSaving,   setResetSaving]     = useState(false)
  const [resetError,    setResetError]      = useState('')
  const [resetSuccess,  setResetSuccess]    = useState(false)
  const [resetHistory,  setResetHistory]    = useState<PasswordResetLogEntry[]>([])
  const [showEditForm,  setShowEditForm]    = useState(false)
  const [editName,      setEditName]        = useState('')
  const [editTeam,      setEditTeam]        = useState('sales')
  const [editRole,      setEditRole]        = useState<'member' | 'manager' | 'admin'>('member')
  const [editPosition,  setEditPosition]    = useState('')
  const [editSaving,    setEditSaving]      = useState(false)
  const [editError,     setEditError]       = useState('')
  const [editSuccess,   setEditSuccess]     = useState(false)
  const [full_name, setFullName]  = useState('')
  const [email,     setEmail]     = useState('')
  const [phone,     setPhone]     = useState('')
  const [role,      setRole]      = useState<'member' | 'manager' | 'admin'>('member')
  const [team,      setTeam]      = useState('sales')
  const [position,  setPosition]  = useState('')
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

      const [{ data: p }, { data: posData }, membersRes, deletedRes] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at')
          .eq('id', session.user.id)
          .single()
          .then((r: { data: UserProfile | null; error: unknown }) => {
            console.log('[members] role fetch', Math.round(performance.now() - roleStart), 'ms')
            return r
          }),
        supabase
          .from('positions')
          .select('id, name, created_at')
          .order('name'),
        // Use service-role API — browser client blocked by RLS on inactive rows
        fetch('/api/admin-members', {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        }).then(r => r.json()).then(d => {
          console.log('[members] members fetch', Math.round(performance.now() - membersStart), 'ms')
          return d
        }),
        // Use service-role API — browser client blocked by RLS on deleted rows
        fetch('/api/deleted-members', {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        }).then(r => r.json()),
      ])

      console.log('[members] parallel data TOTAL', Math.round(performance.now() - dataStart), 'ms')

      if (p?.role !== 'admin') { router.push('/dashboard'); return }
      if (p) setProfile(p as UserProfile)
      if (Array.isArray(membersRes?.members)) setMembers(membersRes.members as UserProfile[])
      if (posData) setPositions(posData as Position[])
      if (Array.isArray(deletedRes?.members)) setDeletedMembers(deletedRes.members as UserProfile[])

      console.log('[members] TOTAL', Math.round(performance.now() - pageStart), 'ms')
      setLoading(false)
    }
    init()
  }, [])

  const loadMembers = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/admin-members', {
      headers: { 'Authorization': `Bearer ${session?.access_token ?? ''}` },
    })
    const data = await res.json()
    if (Array.isArray(data?.members)) setMembers(data.members as UserProfile[])
  }

  const handleCreate = async () => {
    if (!full_name.trim() || !email.trim() || !password.trim()) {
      setError('Name, email and password are required')
      return
    }
    setSaving(true)
    setError('')

    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      setError('Session expired. Please sign in again.')
      setSaving(false)
      return
    }

    const res = await fetch('/api/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({
        email:     email.trim(),
        password:  password.trim(),
        full_name: full_name.trim(),
        phone:     phone.trim() || null,
        role,
        team,
        position:  position || null,
      }),
    })
    const data = await res.json()

    if (!res.ok) {
      setError(data.error || 'Failed to create member')
      setSaving(false)
      return
    }

    setFullName(''); setEmail(''); setPhone('')
    setPassword(''); setRole('member'); setTeam('sales'); setPosition('')
    setShowForm(false)
    await loadMembers()
    setSaving(false)
    showSuccess('Member created successfully.')
  }

  const handleDelete = async (member: UserProfile) => {
    if (member.is_active) {
      setShowCannotDelete(true)
      setConfirmDelete(null)
      return
    }
    setDeletingId(member.id)
    setDeleteError('')

    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/delete-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token ?? ''}`,
      },
      body: JSON.stringify({ userId: member.id }),
    })
    const data = await res.json()
    setDeletingId(null)

    if (!res.ok) {
      setDeleteError(data.error || 'Failed to delete member')
      return
    }

    const now = new Date().toISOString()
    const scheduled = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    const softDeleted: UserProfile = { ...member, is_deleted: true, deleted_at: now, deletion_scheduled_at: scheduled }
    setMembers(prev => prev.filter(m => m.id !== member.id))
    setDeletedMembers(prev => [softDeleted, ...prev])
    if (selectedMember?.id === member.id) setSelectedMember(null)
    setConfirmDelete(null)
    showSuccess('Member deleted successfully. You can restore this member within 30 days.')
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

  const openEditForm = () => {
    if (!selectedMember) return
    setEditName(selectedMember.full_name)
    setEditTeam(selectedMember.team)
    setEditRole(selectedMember.role)
    setEditPosition(selectedMember.position ?? '')
    setEditError('')
    setEditSuccess(false)
    setShowEditForm(true)
  }

  const closeEditForm = () => {
    setShowEditForm(false)
    setEditError('')
    setEditSuccess(false)
  }

  const handleEditSave = async () => {
    if (!selectedMember) return
    if (!editName.trim()) { setEditError('Full name is required'); return }
    setEditSaving(true)
    setEditError('')
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/update-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ userId: selectedMember.id, full_name: editName.trim(), team: editTeam, role: editRole, position: editPosition || null }),
    })
    const data = await res.json()
    setEditSaving(false)
    if (!res.ok) { setEditError(data.error || 'Failed to update profile'); return }
    const updated = { ...selectedMember, full_name: editName.trim(), team: editTeam, role: editRole, position: editPosition || null }
    setSelectedMember(updated)
    setMembers(prev => prev.map(m => m.id === updated.id ? updated : m))
    setEditSuccess(true)
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

    // Use API route with service role to guarantee the DB update persists
    // regardless of RLS policies on the anon client.
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/toggle-active', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token ?? ''}`,
      },
      body: JSON.stringify({ userId: member.id, is_active: newValue }),
    })

    if (!res.ok) {
      const data = await res.json()
      setError(`Failed to update member: ${data.error || 'Unknown error'}`)
      setTogglingId(null)
      return
    }

    setMembers(prev => prev.map(m => m.id === member.id ? { ...m, is_active: newValue } : m))
    if (selectedMember?.id === member.id) {
      setSelectedMember(prev => prev ? { ...prev, is_active: newValue } : prev)
    }
    showSuccess(newValue ? 'Member activated successfully.' : 'Member deactivated successfully.')
    setTogglingId(null)
  }

  const handleRestore = async (member: UserProfile) => {
    setRestoringId(member.id)
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/restore-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token ?? ''}`,
      },
      body: JSON.stringify({ userId: member.id }),
    })
    const data = await res.json()
    setRestoringId(null)

    if (!res.ok) {
      setError(data.error || 'Failed to restore member')
      return
    }

    const restored: UserProfile = {
      ...member,
      is_deleted: false,
      deleted_at: null,
      deleted_by: null,
      deletion_scheduled_at: null,
    }
    setDeletedMembers(prev => prev.filter(m => m.id !== member.id))
    setMembers(prev => [...prev, restored].sort((a, b) => a.full_name.localeCompare(b.full_name)))
    showSuccess('Member restored successfully.')
  }

  const showSuccess = (msg: string) => {
    setSuccessMessage(msg)
    setTimeout(() => setSuccessMessage(''), 4000)
  }

  const handlePermanentDelete = async (member: UserProfile) => {
    setPermDeletingId(member.id)
    setPermDeleteError('')
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/permanently-delete-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token ?? ''}`,
      },
      body: JSON.stringify({ userId: member.id }),
    })
    const data = await res.json()
    setPermDeletingId(null)

    if (!res.ok) {
      setPermDeleteError(data.error || 'Failed to permanently delete member')
      return
    }

    setDeletedMembers(prev => prev.filter(m => m.id !== member.id))
    setConfirmPermDelete(null)
    showSuccess('Member permanently deleted.')
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
    closeEditForm()
    setResetHistory([])
    if (selectedMember) loadResetHistory(selectedMember.id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMember?.id])

  if (loading) return <LoadingScreen />

  const activeMembers   = members.filter(m => m.is_active === true)
  const inactiveMembers = members.filter(m => m.is_active === false)
  const totalMembers    = activeMembers.length + inactiveMembers.length + deletedMembers.length

  // ── Shared pill for section counts ──────────────────────────────────────────
  const CountPill = ({ n, color }: { n: number; color?: string }) => (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: '20px', height: '18px', padding: '0 6px',
      background: color ?? colors.float, borderRadius: '9px',
      fontSize: '10px', fontWeight: 600, color: color ? '#fff' : colors.secondary,
    }}>{n}</span>
  )

  // ── Active member card (left column, primary view) ───────────────────────────
  const renderActiveCard = (member: UserProfile) => (
    <div key={member.id} className="boe-card" style={{
      padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: '10px',
    }}>
      {/* Header row: avatar + name + status badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div className="boe-member-avatar" style={{ background: avatarColor(member.full_name), flexShrink: 0 }}>
          {initials(member.full_name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {member.full_name}
          </div>
          <div style={{ fontSize: '11px', color: colors.muted, textTransform: 'capitalize', marginTop: '1px' }}>
            {member.team} · {member.role}
          </div>
        </div>
        <span className="boe-badge boe-badge-completed" style={{ fontSize: '9px', flexShrink: 0 }}>Active</span>
      </div>

      {/* Email */}
      <div style={{ fontSize: '11px', color: colors.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {member.email}
      </div>

      {/* Action row */}
      <div style={{
        display: 'flex', gap: '6px',
        paddingTop: '10px', borderTop: `1px solid ${colors.border}`,
      }}>
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
          {togglingId === member.id ? '…' : 'Deactivate'}
        </button>
        <button
          onClick={() => setShowCannotDelete(true)}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '5px 10px', fontSize: '11px', color: colors.red, justifyContent: 'center' }}
        >
          Delete
        </button>
      </div>
    </div>
  )

  // ── Deactivated member row (right archive panel, compact) ────────────────────
  const renderArchiveRow = (member: UserProfile) => (
    <div key={member.id} style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '9px 0',
      borderBottom: `1px solid ${colors.border}`,
    }}>
      <div className="boe-member-avatar" style={{
        background: avatarColor(member.full_name),
        width: '28px', height: '28px', fontSize: '10px', flexShrink: 0,
      }}>
        {initials(member.full_name)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {member.full_name}
        </div>
        <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'capitalize' }}>
          {member.team} · {member.role}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
        <button onClick={() => setSelectedMember(member)} className="boe-btn boe-btn-ghost" style={{ padding: '3px 8px', fontSize: '10px' }}>
          View
        </button>
        <button
          onClick={() => toggleActive(member)}
          disabled={togglingId === member.id}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '3px 8px', fontSize: '10px' }}
        >
          {togglingId === member.id ? '…' : 'Activate'}
        </button>
        <button
          onClick={() => { setDeleteError(''); setConfirmDelete(member) }}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '3px 8px', fontSize: '10px', color: colors.red }}
        >
          Delete
        </button>
      </div>
    </div>
  )

  return (
    <DashboardLayout
      profile={profile}
      title="Team Members"
      subtitle="Manage active, deactivated, and deleted members."
      actions={
        <button onClick={() => setShowForm(!showForm)} className="boe-btn boe-btn-primary">
          {showForm ? 'Cancel' : '+ Add Member'}
        </button>
      }
      onSignOut={handleLogout}
    >

      {/* ── Add Member form ─────────────────────────────────────────────── */}
      {showForm && (
        <div className="boe-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '560px', marginBottom: '20px' }}>
          <p style={{ color: colors.primary, fontSize: '13px', fontWeight: 600, margin: 0 }}>New Team Member</p>
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
              <input key={placeholder} value={value} onChange={e => set(e.target.value)}
                placeholder={placeholder} type={type} className="boe-input" />
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label className="boe-input-label">Role</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {ROLES.map(r => (
                  <button key={r} onClick={() => setRole(r)}
                    className={`boe-chip${role === r ? ' boe-chip-selected' : ''}`}
                    style={{ flex: 1, textAlign: 'center', textTransform: 'capitalize' }}>{r}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="boe-input-label">Team</label>
              <select value={team} onChange={e => setTeam(e.target.value)} className="boe-input">
                {TEAMS.map(t => <option key={t} value={t} style={{ textTransform: 'capitalize' }}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="boe-input-label">Position</label>
            <select value={position} onChange={e => setPosition(e.target.value)} className="boe-input">
              <option value="">— None —</option>
              {positions.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <button onClick={handleCreate} disabled={saving} className="boe-btn boe-btn-primary"
            style={{ justifyContent: 'center', padding: '11px' }}>
            {saving ? 'Creating...' : 'Create Member'}
          </button>
        </div>
      )}

      {/* Error / success banners */}
      {error && !showForm && (
        <AlertBanner variant="red">
          <p style={{ color: colors.red, fontSize: '12px' }}>{error}</p>
        </AlertBanner>
      )}
      {successMessage && (
        <div style={{
          padding: '10px 14px', background: '#f0faf4', border: '1px solid #b7e4c7',
          borderRadius: '8px', fontSize: '12px', color: '#2d6a4f', marginBottom: '16px',
        }}>
          {successMessage}
        </div>
      )}

      {/* ── Modals (all unchanged) ──────────────────────────────────────── */}

      {showCannotDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="boe-card" style={{ maxWidth: '360px', width: '90%', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <p style={{ fontWeight: 600, fontSize: '14px', color: colors.primary, margin: 0 }}>Cannot Delete Member</p>
            <p style={{ fontSize: '13px', color: colors.secondary, margin: 0 }}>Please deactivate this member before deleting.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setShowCannotDelete(false)} className="boe-btn boe-btn-primary" style={{ padding: '7px 20px', fontSize: '12px' }}>OK</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="boe-card" style={{ maxWidth: '380px', width: '90%', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <p style={{ fontWeight: 600, fontSize: '14px', color: colors.primary, margin: 0 }}>Delete Member</p>
            <p style={{ fontSize: '13px', color: colors.secondary, margin: 0 }}>
              Delete <strong>{confirmDelete.full_name}</strong>? They will be moved to the Deleted Members section and can be restored within 30 days.
            </p>
            {deleteError && (
              <div style={{ padding: '10px 12px', background: '#fff5f5', border: `1px solid ${colors.red}`, borderRadius: '6px', fontSize: '12px', color: colors.red }}>
                {deleteError}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => { setConfirmDelete(null); setDeleteError('') }} className="boe-btn boe-btn-ghost" style={{ padding: '7px 14px', fontSize: '12px' }}>Cancel</button>
              <button type="button" onClick={() => handleDelete(confirmDelete)} disabled={deletingId === confirmDelete.id} className="boe-btn"
                style={{ padding: '7px 14px', fontSize: '12px', background: colors.red, color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                {deletingId === confirmDelete.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmPermDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="boe-card" style={{ maxWidth: '400px', width: '90%', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <p style={{ fontWeight: 600, fontSize: '14px', color: colors.primary, margin: 0 }}>Permanently Delete Member</p>
            <p style={{ fontSize: '13px', color: colors.secondary, margin: 0 }}>
              This will permanently delete <strong>{confirmPermDelete.full_name}</strong> and all linked task records, activity logs, notifications, and password reset logs. This cannot be undone.
            </p>
            {permDeleteError && (
              <div style={{ padding: '10px 12px', background: '#fff5f5', border: `1px solid ${colors.red}`, borderRadius: '6px', fontSize: '12px', color: colors.red }}>
                {permDeleteError}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => { setConfirmPermDelete(null); setPermDeleteError('') }} className="boe-btn boe-btn-ghost" style={{ padding: '7px 14px', fontSize: '12px' }}>Cancel</button>
              <button type="button" onClick={() => handlePermanentDelete(confirmPermDelete)} disabled={permDeletingId === confirmPermDelete.id} className="boe-btn"
                style={{ padding: '7px 14px', fontSize: '12px', background: colors.red, color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                {permDeletingId === confirmPermDelete.id ? 'Deleting…' : 'Permanently Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── KPI strip ──────────────────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: '12px',
        marginBottom: '28px',
      }}>
        {[
          { label: 'Total Members',   value: totalMembers,           accent: colors.blue   },
          { label: 'Active',          value: activeMembers.length,   accent: colors.green  },
          { label: 'Deactivated',     value: inactiveMembers.length, accent: colors.amber  },
          { label: 'Deleted',         value: deletedMembers.length,  accent: colors.red    },
        ].map(({ label, value, accent }) => (
          <div key={label} className="boe-card" style={{ padding: '14px 16px' }}>
            <div style={{
              fontSize: '10px', fontWeight: 600, color: colors.muted,
              textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px',
            }}>
              {label}
            </div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: accent, lineHeight: 1 }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* ── Main 70/30 layout ──────────────────────────────────────────── */}
      <div className="members-workspace">

        {/* ── LEFT: Active Members ────────────────────────────────────── */}
        <section className="active-members-panel">
          {/* Section header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
            <h2 style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, margin: 0, letterSpacing: '-0.1px' }}>
              Active Members
            </h2>
            <CountPill n={activeMembers.length} color={colors.green} />
          </div>

          {activeMembers.length === 0
            ? (
              <div className="boe-card" style={{ padding: '28px 20px', textAlign: 'center' }}>
                <p style={{ fontSize: '12px', color: colors.muted, margin: 0 }}>No active members.</p>
              </div>
            )
            : <div className="boe-members-grid">{activeMembers.map(renderActiveCard)}</div>
          }
        </section>

        {/* ── RIGHT: Member Archive panel ─────────────────────────────── */}
        <aside className="member-archive-panel" style={{
          background: colors.raised,
          border: `1px solid ${colors.border}`,
          borderRadius: '10px',
        }}>

          {/* Panel label — stays visible while body scrolls */}
          <div style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${colors.border}`,
            background: colors.float,
            flexShrink: 0,
          }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: colors.secondary, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
              Member Archive
            </span>
          </div>

          <div className="member-archive-body">

          {/* ── Deactivated section ───────────────────────────────────── */}
          <div style={{ padding: '14px 16px', borderBottom: `1px solid ${colors.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary }}>Deactivated</span>
              <CountPill n={inactiveMembers.length} />
            </div>
            {inactiveMembers.length === 0
              ? <p style={{ fontSize: '11px', color: colors.muted, margin: 0, padding: '6px 0' }}>No deactivated members.</p>
              : <div>{inactiveMembers.map(renderArchiveRow)}</div>
            }
          </div>

          {/* ── Deleted section ───────────────────────────────────────── */}
          <div style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary }}>Deleted</span>
              <CountPill n={deletedMembers.length} />
            </div>
            {deletedMembers.length === 0
              ? <p style={{ fontSize: '11px', color: colors.muted, margin: 0, padding: '6px 0' }}>No deleted members.</p>
              : (
                <div>
                  {deletedMembers.map(member => {
                    const daysLeft = member.deletion_scheduled_at
                      ? Math.max(0, Math.ceil((new Date(member.deletion_scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
                      : null
                    const deletedOn = member.deleted_at
                      ? new Date(member.deleted_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                      : '—'

                    return (
                      <div key={member.id} style={{
                        padding: '9px 0',
                        borderBottom: `1px solid ${colors.border}`,
                      }}>
                        {/* Name row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '5px' }}>
                          <div className="boe-member-avatar" style={{
                            background: avatarColor(member.full_name),
                            width: '26px', height: '26px', fontSize: '9px', flexShrink: 0, opacity: 0.7,
                          }}>
                            {initials(member.full_name)}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {member.full_name}
                            </div>
                            <div style={{ fontSize: '10px', color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {member.email}
                            </div>
                          </div>
                        </div>
                        {/* Meta row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '7px', paddingLeft: '34px' }}>
                          <span style={{ fontSize: '10px', color: colors.muted }}>Deleted {deletedOn}</span>
                          {daysLeft !== null && (
                            <span
                              className={`boe-badge ${daysLeft <= 7 ? 'boe-badge-urgent' : 'boe-badge-pending'}`}
                              style={{ fontSize: '9px' }}
                            >
                              {daysLeft}d left
                            </span>
                          )}
                        </div>
                        {/* Actions */}
                        <div style={{ display: 'flex', gap: '4px', paddingLeft: '34px' }}>
                          <button
                            type="button"
                            onClick={() => handleRestore(member)}
                            disabled={restoringId === member.id}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 8px', fontSize: '10px' }}
                          >
                            {restoringId === member.id ? 'Restoring…' : 'Restore'}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setPermDeleteError(''); setConfirmPermDelete(member) }}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 8px', fontSize: '10px', color: colors.red }}
                          >
                            Perm. Delete
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            }
          </div>

          </div>{/* end member-archive-body */}
        </aside>
      </div>

      {/* ── Member profile side panel (unchanged) ──────────────────────── */}
      {selectedMember && (
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${colors.border}` }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>Member Profile</span>
            <button onClick={() => setSelectedMember(null)} className="boe-btn boe-btn-ghost" style={{ padding: '4px 8px', fontSize: '13px', lineHeight: 1 }}>✕</button>
          </div>

          {/* Avatar + name */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '28px 20px 20px', borderBottom: `1px solid ${colors.border}`, gap: '10px' }}>
            <div className="boe-member-avatar" style={{ background: avatarColor(selectedMember.full_name), width: '56px', height: '56px', fontSize: '18px' }}>
              {initials(selectedMember.full_name)}
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '15px', fontWeight: 600, color: colors.primary }}>{selectedMember.full_name}</div>
              <div style={{ fontSize: '12px', color: colors.secondary, textTransform: 'capitalize', marginTop: '2px' }}>{selectedMember.team} · {selectedMember.role}</div>
            </div>
            <span className={`boe-badge ${selectedMember.is_active ? 'boe-badge-completed' : 'boe-badge-pending'}`} style={{ fontSize: '10px' }}>
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
              { label: 'Position',     value: selectedMember.position ?? '—' },
              { label: 'Member since', value: formatFullDate(selectedMember.created_at) },
            ].map(({ label, value, capitalize }) => (
              <div key={label}>
                <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '2px' }}>{label}</div>
                <div style={{ fontSize: '13px', color: colors.secondary, textTransform: capitalize ? 'capitalize' : undefined }}>{value}</div>
              </div>
            ))}
            <div style={{ marginTop: '4px', paddingTop: '12px', borderTop: `1px solid ${colors.border}` }}>
              <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '2px' }}>Member ID</div>
              <div style={{ fontSize: '10px', color: colors.muted, fontFamily: 'monospace', wordBreak: 'break-all' }}>{selectedMember.id}</div>
            </div>
          </div>

          {/* Edit Profile */}
          <div style={{ padding: '0 20px 4px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ paddingTop: '12px', borderTop: `1px solid ${colors.border}` }}>
              <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Profile</div>
              {!showEditForm && (
                <button onClick={openEditForm} className="boe-btn boe-btn-ghost" style={{ padding: '6px 12px', fontSize: '12px', width: '100%', justifyContent: 'center' }}>
                  Edit Profile
                </button>
              )}
              {showEditForm && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {editSuccess ? (
                    <>
                      <div style={{ padding: '10px 12px', background: '#f0faf4', border: '1px solid #b7e4c7', borderRadius: '6px', fontSize: '12px', color: '#2d6a4f' }}>
                        Profile updated successfully.
                      </div>
                      <button onClick={closeEditForm} className="boe-btn boe-btn-ghost" style={{ padding: '6px 12px', fontSize: '12px', width: '100%', justifyContent: 'center' }}>Done</button>
                    </>
                  ) : (
                    <>
                      <div>
                        <label className="boe-input-label">Full Name</label>
                        <input type="text" value={editName} onChange={e => setEditName(e.target.value)} placeholder="Full name" className="boe-input" style={{ fontSize: '12px' }} />
                      </div>
                      <div>
                        <label className="boe-input-label">Role</label>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          {ROLES.map(r => (
                            <button key={r} onClick={() => setEditRole(r)} className={`boe-chip${editRole === r ? ' boe-chip-selected' : ''}`}
                              style={{ flex: 1, textAlign: 'center', textTransform: 'capitalize' }}>{r}</button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="boe-input-label">Team</label>
                        <select value={editTeam} onChange={e => setEditTeam(e.target.value)} className="boe-input" style={{ fontSize: '12px' }}>
                          {TEAMS.map(t => <option key={t} value={t} style={{ textTransform: 'capitalize' }}>{t}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="boe-input-label">Position</label>
                        <select value={editPosition} onChange={e => setEditPosition(e.target.value)} className="boe-input" style={{ fontSize: '12px' }}>
                          <option value="">— None —</option>
                          {positions.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                        </select>
                      </div>
                      {editError && <p style={{ fontSize: '11px', color: colors.red, margin: 0 }}>{editError}</p>}
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={handleEditSave} disabled={editSaving} className="boe-btn boe-btn-primary" style={{ flex: 1, justifyContent: 'center', padding: '7px', fontSize: '12px' }}>
                          {editSaving ? 'Saving…' : 'Save Changes'}
                        </button>
                        <button onClick={closeEditForm} disabled={editSaving} className="boe-btn boe-btn-ghost" style={{ padding: '7px 12px', fontSize: '12px' }}>Cancel</button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Reset History */}
          {resetHistory.length > 0 && (
            <div style={{ padding: '0 20px 4px' }}>
              <div style={{ paddingTop: '12px', borderTop: `1px solid ${colors.border}` }}>
                <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Reset History</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {resetHistory.map(entry => (
                    <div key={entry.id} style={{ fontSize: '11px', color: colors.secondary }}>
                      <span style={{ color: colors.primary, fontWeight: 500 }}>{entry.actor_name ?? 'Unknown'}</span>
                      <span style={{ color: colors.muted }}> · </span>
                      {new Date(entry.reset_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Danger Zone */}
          <div style={{ padding: '0 20px 4px' }}>
            <div style={{ paddingTop: '12px', borderTop: `1px solid ${colors.border}` }}>
              <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Danger Zone</div>
              <button
                onClick={() => { if (selectedMember.is_active) { setShowCannotDelete(true) } else { setDeleteError(''); setConfirmDelete(selectedMember) } }}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '6px 12px', fontSize: '12px', width: '100%', justifyContent: 'center', color: colors.red }}
              >
                Delete Member
              </button>
            </div>
          </div>

          {/* Reset Password */}
          <div style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ paddingTop: '12px', borderTop: `1px solid ${colors.border}` }}>
              <div style={{ fontSize: '10px', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Password</div>
              {!showResetForm && (
                <button onClick={openResetForm} className="boe-btn boe-btn-ghost" style={{ padding: '6px 12px', fontSize: '12px', width: '100%', justifyContent: 'center' }}>
                  Reset Password
                </button>
              )}
              {showResetForm && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {resetSuccess ? (
                    <div style={{ padding: '10px 12px', background: '#f0faf4', border: '1px solid #b7e4c7', borderRadius: '6px', fontSize: '12px', color: '#2d6a4f' }}>
                      Password reset successfully.
                    </div>
                  ) : (
                    <>
                      <input type="password" value={resetPassword} onChange={e => setResetPassword(e.target.value)} placeholder="New temporary password" className="boe-input" style={{ fontSize: '12px' }} />
                      <input type="password" value={resetConfirm} onChange={e => setResetConfirm(e.target.value)} placeholder="Confirm password" className="boe-input" style={{ fontSize: '12px' }} />
                      {resetError && <p style={{ fontSize: '11px', color: colors.red, margin: 0 }}>{resetError}</p>}
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={handleResetPassword} disabled={resetSaving} className="boe-btn boe-btn-primary" style={{ flex: 1, justifyContent: 'center', padding: '7px', fontSize: '12px' }}>
                          {resetSaving ? 'Resetting…' : 'Confirm Reset'}
                        </button>
                        <button onClick={closeResetForm} disabled={resetSaving} className="boe-btn boe-btn-ghost" style={{ padding: '7px 12px', fontSize: '12px' }}>Cancel</button>
                      </div>
                    </>
                  )}
                  {resetSuccess && (
                    <button onClick={closeResetForm} className="boe-btn boe-btn-ghost" style={{ padding: '6px 12px', fontSize: '12px', width: '100%', justifyContent: 'center' }}>Done</button>
                  )}
                </div>
              )}
            </div>
          </div>

        </div>
      )}

    </DashboardLayout>
  )
}

