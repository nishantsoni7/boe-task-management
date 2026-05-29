'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { initials } from '@/lib/ui'
import { colors } from '@/lib/tokens'
import { BackBarShell } from '@/components/layout/PageShell'
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
  const [members,   setMembers]   = useState<UserProfile[]>([])
  const [loading,   setLoading]   = useState(true)
  const [showForm,  setShowForm]  = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
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
          .select('role')
          .eq('id', session.user.id)
          .single()
          .then((r: { data: { role: string } | null; error: unknown }) => {
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

  const toggleActive = async (member: UserProfile) => {
    await supabase
      .from('users')
      .update({ is_active: !member.is_active })
      .eq('id', member.id)
    await loadMembers()
  }

  if (loading) return <LoadingScreen />

  return (
    <BackBarShell
      title="Members"
      narrow={false}
      onBack={() => router.push('/dashboard')}
      actions={
        <button
          onClick={() => setShowForm(!showForm)}
          className="boe-btn boe-btn-primary"
        >
          {showForm ? 'Cancel' : '+ Add Member'}
        </button>
      }
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

      <p style={{ fontSize: '12px', color: colors.tertiary, marginBottom: '12px' }}>
        {members.length} members · {members.filter(m => m.is_active).length} active
      </p>

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

            <button
              onClick={() => toggleActive(member)}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '5px 10px', fontSize: '11px', width: '100%', justifyContent: 'center' }}
            >
              {member.is_active ? 'Deactivate' : 'Activate'}
            </button>

          </div>
        ))}
      </div>

    </BackBarShell>
  )
}

