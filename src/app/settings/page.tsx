'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useViewAs } from '@/hooks/useViewAs'

const ADMIN_SETTING_CARDS = [
  {
    title: 'Roles',
    description: 'View and manage member roles.',
    href: '/settings/roles',
    dotColor: colors.blue,
  },
  {
    title: 'Positions',
    description: 'View and manage job positions.',
    href: '/settings/positions',
    dotColor: colors.green,
  },
]

export default function SettingsPage() {
  const { viewAsUserId, exitViewMode } = useViewAs()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // Change Password state
  const [newPassword,     setNewPassword]     = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwError,         setPwError]         = useState('')
  const [pwSuccess,       setPwSuccess]       = useState('')
  const [pwLoading,       setPwLoading]       = useState(false)

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      if (viewAsUserId) { exitViewMode(); router.push('/dashboard'); return }
      const { data } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, is_active, created_at')
        .eq('id', session.user.id)
        .single()
      setProfile(data as UserProfile)
      setLoading(false)
    }
    init()
  }, [viewAsUserId, exitViewMode, router, supabase])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwError('')
    setPwSuccess('')

    if (!newPassword) {
      setPwError('New password is required.')
      return
    }
    if (newPassword.length < 8) {
      setPwError('Password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPwError('Passwords do not match.')
      return
    }

    setPwLoading(true)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setPwLoading(false)

    if (error) {
      setPwError(error.message || 'Failed to update password. Please try again.')
    } else {
      setPwSuccess('Password updated successfully.')
      setNewPassword('')
      setConfirmPassword('')
    }
  }

  if (loading) return <LoadingScreen />

  const isAdmin = profile?.role === 'admin'

  return (
    <DashboardLayout
      profile={profile}
      title="Settings"
      subtitle="App configuration"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 600, padding: '24px 0', display: 'flex', flexDirection: 'column', gap: 24 }}>

        {/* Admin-only setting cards */}
        {isAdmin && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {ADMIN_SETTING_CARDS.map(card => (
              <button
                key={card.href}
                onClick={() => router.push(card.href)}
                style={{
                  background: colors.base,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 10,
                  padding: '20px 20px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'box-shadow 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 12px rgba(0,0,0,0.08)')}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: card.dotColor, flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 15, fontWeight: 600, color: colors.primary }}>
                    {card.title}
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 13, color: colors.tertiary, lineHeight: 1.5 }}>
                  {card.description}
                </p>
              </button>
            ))}
          </div>
        )}

        {/* Change Password card — available to all users */}
        <div style={{
          background: colors.base,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          padding: '24px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: '#E8A030', flexShrink: 0,
            }} />
            <span style={{ fontSize: 15, fontWeight: 600, color: colors.primary }}>
              Change My Password
            </span>
          </div>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: colors.tertiary, lineHeight: 1.5 }}>
            Update the password for your own account.
          </p>

          <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: 12.5, fontWeight: 500, color: colors.secondary }}>
                New Password
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                style={{
                  fontSize: 13.5,
                  padding: '8px 12px',
                  border: `1px solid ${colors.border}`,
                  borderRadius: 7,
                  outline: 'none',
                  background: '#FAFAFA',
                  color: colors.primary,
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: 12.5, fontWeight: 500, color: colors.secondary }}>
                Confirm New Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Re-enter new password"
                style={{
                  fontSize: 13.5,
                  padding: '8px 12px',
                  border: `1px solid ${colors.border}`,
                  borderRadius: 7,
                  outline: 'none',
                  background: '#FAFAFA',
                  color: colors.primary,
                }}
              />
            </div>

            {pwError && (
              <p style={{ margin: 0, fontSize: 13, color: '#DC2626' }}>{pwError}</p>
            )}
            {pwSuccess && (
              <p style={{ margin: 0, fontSize: 13, color: '#16A34A' }}>{pwSuccess}</p>
            )}

            <div>
              <button
                type="submit"
                disabled={pwLoading}
                style={{
                  padding: '9px 20px',
                  fontSize: 13.5,
                  fontWeight: 600,
                  background: colors.primary,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 7,
                  cursor: pwLoading ? 'not-allowed' : 'pointer',
                  opacity: pwLoading ? 0.7 : 1,
                  transition: 'opacity 0.15s',
                }}
              >
                {pwLoading ? 'Updating…' : 'Update Password'}
              </button>
            </div>
          </form>
        </div>

      </div>
    </DashboardLayout>
  )
}
