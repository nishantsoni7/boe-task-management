'use client'

import { Suspense, useEffect, useState, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, User } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { initials } from '@/lib/ui'
import { colors } from '@/lib/tokens'
import { LoadingScreen } from '@/components/ui/atoms'
import { BoeBrandIcon } from '@/components/layout/BoeBrandIcon'
import { employeeSubtitle, designationLevelLabel } from '@/lib/users/designationLevels'

export default function AccountPage() {
  return (
    <Suspense>
      <AccountPageInner />
    </Suspense>
  )
}

function AccountPageInner() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  // Only allow internal paths to prevent open-redirect attacks
  const rawReturn = searchParams.get('returnTo') ?? ''
  const returnTo  = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/modules'
  const supabase     = useMemo(() => createClient(), [])

  const [profile,         setProfile]         = useState<UserProfile | null>(null)
  const [loading,         setLoading]         = useState(true)
  const [newPassword,     setNewPassword]     = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwError,         setPwError]         = useState('')
  const [pwSuccess,       setPwSuccess]       = useState('')
  const [pwLoading,       setPwLoading]       = useState(false)

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, designation_level, is_active, created_at')
        .eq('id', session.user.id)
        .single()
      setProfile(data as UserProfile)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwError('')
    setPwSuccess('')

    if (!newPassword) { setPwError('New password is required.'); return }
    if (newPassword.length < 8) { setPwError('Password must be at least 8 characters.'); return }
    if (newPassword !== confirmPassword) { setPwError('Passwords do not match.'); return }

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

  const level = designationLevelLabel(profile?.designation_level)

  return (
    <div style={{
      minHeight: '100vh',
      background: '#F7F8FA',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Top bar */}
      <div style={{
        height: 52,
        background: '#fff',
        borderBottom: '1px solid rgba(0,0,0,0.08)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 20px',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <BoeBrandIcon />
        <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: '#111318' }}>
          Account Settings
        </div>
        <button
          onClick={() => router.push(returnTo)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 13, fontWeight: 500, color: '#6B7384',
            background: 'rgba(0,0,0,0.05)',
            border: '1px solid rgba(0,0,0,0.10)',
            borderRadius: 7, padding: '6px 14px',
            cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.08)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)' }}
        >
          <ArrowLeft size={13} strokeWidth={2} />
          Back
        </button>
      </div>

      {/* Page body */}
      <div style={{ maxWidth: 560, width: '100%', margin: '32px auto', padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Profile card */}
        {profile && (
          <div style={{
            background: '#fff',
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: '24px',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              background: '#1A2035',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 700, color: '#DC1F2E',
              flexShrink: 0, letterSpacing: '0.02em',
            }}>
              {initials(profile.full_name)}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#111318' }}>{profile.full_name}</div>
              {/* Designation and department — the employee's own words for
                  their job. `role` used to lead this line, which meant most of
                  the company opened their account page and read the word
                  "member" as a description of themselves. It is the
                  authorization role and it does not belong here. */}
              <div style={{ fontSize: 12.5, color: '#8C94A6', marginTop: 2 }}>
                {employeeSubtitle(profile)}
              </div>
              {level && (
                <div style={{ fontSize: 11.5, color: '#A0A9BE', marginTop: 2 }}>
                  Level: {level}
                </div>
              )}
              <div style={{ fontSize: 12, color: '#A0A9BE', marginTop: 2 }}>{profile.email}</div>
            </div>
            <User size={18} strokeWidth={1.6} color="#C8CDD9" style={{ marginLeft: 'auto', flexShrink: 0 }} />
          </div>
        )}

        {/* Change Password card */}
        <div style={{
          background: '#fff',
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: '24px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#E8A030', flexShrink: 0 }} />
            <span style={{ fontSize: 15, fontWeight: 600, color: colors.primary }}>Change My Password</span>
          </div>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: colors.tertiary, lineHeight: 1.5 }}>
            Update the password for your account.
          </p>

          <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: 12.5, fontWeight: 500, color: colors.secondary }}>New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                style={{
                  fontSize: 13.5, padding: '8px 12px',
                  border: `1px solid ${colors.border}`,
                  borderRadius: 7, outline: 'none',
                  background: '#FAFAFA', color: colors.primary,
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: 12.5, fontWeight: 500, color: colors.secondary }}>Confirm New Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Re-enter new password"
                style={{
                  fontSize: 13.5, padding: '8px 12px',
                  border: `1px solid ${colors.border}`,
                  borderRadius: 7, outline: 'none',
                  background: '#FAFAFA', color: colors.primary,
                }}
              />
            </div>

            {pwError   && <p style={{ margin: 0, fontSize: 13, color: '#DC2626' }}>{pwError}</p>}
            {pwSuccess && <p style={{ margin: 0, fontSize: 13, color: '#16A34A' }}>{pwSuccess}</p>}

            <div>
              <button
                type="submit"
                disabled={pwLoading}
                style={{
                  padding: '9px 20px', fontSize: 13.5, fontWeight: 600,
                  background: colors.primary, color: '#fff',
                  border: 'none', borderRadius: 7,
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
    </div>
  )
}
